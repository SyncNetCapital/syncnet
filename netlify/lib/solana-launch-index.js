'use strict';
/*
 * Generic Solana launch-relationship index (server only). One relationship:
 *
 *   chain = Solana mainnet · source (PUMP_FUN, …) · relationship = LAUNCHED_AGAINST · rootMint · childMint ·
 *   launchSlot · launchSignature
 *
 * Only immutable provenance is stored. Names, symbols, URIs, reserves and phases are never stored; they can be read
 * separately later. A source adapter (netlify/lib/pump-launches.js for PUMP_FUN) verifies launches; this module only
 * stores, pages and checkpoints them, so a later adapter writes source=<NEW_SOURCE> through the same keys and API.
 *
 * Key schema (Upstash, via store.js; every key starts with `sollaunch:v1:mainnet:` — nothing is shared with pons2:*,
 * PAR, mp:* (Marketplace/Passport) or site:* (Project Home)). Base58 mints and signatures keep their exact case.
 *
 *   sollaunch:v1:mainnet:<SOURCE>:<RELATIONSHIP>:root:<rootMint>   ZSET   member "<childMint>:<launchSignature>"
 *                                                                          score  launchSlot
 *   sollaunch:v1:mainnet:<SOURCE>:checkpoint    STRING {"signature","slot","at"}   newest signature fully processed
 *                                                      by the incremental indexer (never moves to an older slot)
 *   sollaunch:v1:mainnet:<SOURCE>:backfill      STRING {"address","headSignature","headSlot","fromSlot",
 *                                                      "stopSlot","before","scanned","done","at"}
 *   sollaunch:v1:mainnet:<SOURCE>:lock          STRING (TTL 55 s) one indexer run at a time
 *
 * Pagination (newest first): several launches can share a slot, so the score alone is NOT a safe cursor. Within a
 * slot Redis orders equal scores by member, descending (the memory adapter does the same), which makes
 * (slot, member) a total order. The cursor is "<slot>:<childMint>:<signature>" = the last item returned; the next
 * page is the members of that same slot strictly below the cursor member, then the slots strictly below it. Same-slot
 * reads are bounded by ZRANGE_MAX (1,000): far more launches than one Solana block can hold.
 */
const Assets = require('../../lib/syncnet-assets.js');
const { ZRANGE_MAX } = require('./store');

const CHAIN = Assets.SOLANA_MAINNET;
const CHAIN_LABEL = 'SOLANA_MAINNET';
// Known sources. A new adapter adds its name here; storage and API need no other change.
const SOURCES = Object.freeze(['PUMP_FUN']);
const RELATIONSHIPS = Object.freeze(['LAUNCHED_AGAINST']);
const PAGE_MAX = 50;
const PAGE_DEFAULT = 24;
const PREFIX = 'sollaunch:v1:mainnet:';

const K = Object.freeze({
  root: (source, relationship, rootMint) => `${PREFIX}${source}:${relationship}:root:${rootMint}`,
  checkpoint: (source) => `${PREFIX}${source}:checkpoint`,
  backfill: (source) => `${PREFIX}${source}:backfill`,
  lock: (source) => `${PREFIX}${source}:lock`,
});

/** A canonical base58 transaction signature (64 bytes). */
function isSignature(s) {
  if (typeof s !== 'string' || s.length < 64 || s.length > 88) return false;
  const b = Assets.base58Decode(s);
  return Boolean(b && b.length === 64 && Assets.base58Encode(b) === s);
}
const knownSource = (s) => SOURCES.includes(s);
const knownRelationship = (r) => RELATIONSHIPS.includes(r);
const validSlot = (n) => Number.isSafeInteger(n) && n >= 0;

/** Throws TypeError unless `rel` is a complete, storable relationship. Returns it normalized (no extra fields). */
function checkRelationship(rel) {
  const r = rel || {};
  if (!knownSource(r.source)) throw new TypeError('unknown source');
  if (!knownRelationship(r.relationship)) throw new TypeError('unknown relationship');
  if (!Assets.isSolanaMint(r.rootMint)) throw new TypeError('invalid root mint'); // native SOL is never a root
  if (!Assets.isSolanaMint(r.childMint) || r.childMint === r.rootMint) throw new TypeError('invalid child mint');
  if (!validSlot(r.launchSlot)) throw new TypeError('invalid slot');
  if (!isSignature(r.launchSignature)) throw new TypeError('invalid signature');
  return { source: r.source, relationship: r.relationship, rootMint: r.rootMint, childMint: r.childMint, launchSlot: r.launchSlot, launchSignature: r.launchSignature };
}
const memberOf = (r) => `${r.childMint}:${r.launchSignature}`;
function parseMember(m) {
  const i = String(m || '').indexOf(':');
  if (i < 0) return null;
  const childMint = m.slice(0, i), launchSignature = m.slice(i + 1);
  return Assets.isSolanaMint(childMint) && isSignature(launchSignature) ? { childMint, launchSignature } : null;
}

/** Idempotent: re-writing a launch rewrites the same member with the same score. One ZADD per root key. */
async function writeRelationships(store, rels) {
  const groups = new Map();
  for (const rel of rels || []) {
    const r = checkRelationship(rel);
    const key = K.root(r.source, r.relationship, r.rootMint);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([r.launchSlot, memberOf(r)]);
  }
  if (!groups.size) return { added: 0, commands: 0, requests: 0 };
  return store.zaddMany([...groups]);
}

// ---------------------------------------------------------------- cursor
function encodeCursor(slot, member) { return `${slot}:${member}`; }
/** "<slot>:<childMint>:<signature>" -> {slot, member} | null. */
function parseCursor(raw) {
  const m = /^(\d{1,15}):([1-9A-HJ-NP-Za-km-z]{32,44}):([1-9A-HJ-NP-Za-km-z]{64,88})$/.exec(String(raw || ''));
  if (!m) return null;
  const slot = Number(m[1]);
  const member = `${m[2]}:${m[3]}`;
  return validSlot(slot) && parseMember(member) ? { slot, member } : null;
}

/**
 * One page of a root's relationships, newest slot first; ties in a slot by member, descending.
 * -> {total, items:[{childMint, launchSlot, launchSignature}], nextCursor|null}
 */
async function readRootPage(store, { source, relationship, rootMint, cursor = null, limit = PAGE_DEFAULT }) {
  if (!knownSource(source) || !knownRelationship(relationship) || !Assets.isSolanaMint(rootMint)) throw new TypeError('invalid page request');
  const n = Math.max(1, Math.min(PAGE_MAX, Number(limit) || PAGE_DEFAULT));
  const key = K.root(source, relationship, rootMint);
  let c = null;
  if (cursor !== null && cursor !== undefined) { c = typeof cursor === 'string' ? parseCursor(cursor) : cursor; if (!c) throw new TypeError('invalid cursor'); }
  let rows;
  const totalP = store.zcard(key);
  if (!c) {
    rows = await store.zrevrangeByScore(key, '+inf', '-inf', n + 1);
  } else {
    const same = await store.zrevrangeByScore(key, String(c.slot), String(c.slot), ZRANGE_MAX);
    if (same.length >= ZRANGE_MAX) throw new RangeError('slot group exceeds the read bound');
    rows = same.filter((r) => r.member < c.member).slice(0, n + 1);
    if (rows.length < n + 1) rows = rows.concat(await store.zrevrangeByScore(key, '(' + c.slot, '-inf', n + 1 - rows.length));
  }
  const total = await totalP;
  const page = rows.slice(0, n);
  const items = [];
  for (const r of page) {
    const m = parseMember(r.member);
    if (m) items.push({ childMint: m.childMint, launchSlot: r.score, launchSignature: m.launchSignature });
  }
  const last = page[page.length - 1];
  return { total, items, nextCursor: rows.length > n && last ? encodeCursor(last.score, last.member) : null };
}

// ---------------------------------------------------------------- checkpoint + backfill state
function parseCheckpoint(raw) {
  if (!raw) return null;
  let c;
  try { c = JSON.parse(raw); } catch { return null; }
  return c && isSignature(c.signature) && validSlot(c.slot) ? { signature: c.signature, slot: c.slot, at: Number(c.at) || 0 } : null;
}
async function readCheckpoint(store, source) {
  const raw = await store.get(K.checkpoint(source));
  return { raw, checkpoint: parseCheckpoint(raw) };
}
/**
 * Moves the checkpoint to `next` ({signature, slot, at}) only if it is not older than the stored one, and only if the
 * stored value is still `expectRaw` (compare-and-set: a concurrent writer is never overwritten). -> true | false
 */
async function advanceCheckpoint(store, source, next, expectRaw) {
  if (!isSignature(next.signature) || !validSlot(next.slot)) throw new TypeError('invalid checkpoint');
  const prev = parseCheckpoint(expectRaw);
  if (prev && next.slot < prev.slot) return false;
  const value = JSON.stringify({ signature: next.signature, slot: next.slot, at: Number(next.at) || 0 });
  return store.cas({ expect: [[K.checkpoint(source), expectRaw == null ? null : expectRaw]], set: [[K.checkpoint(source), value]] });
}

async function readBackfill(store, source) {
  const raw = await store.get(K.backfill(source));
  if (!raw) return null;
  try { const b = JSON.parse(raw); return b && typeof b === 'object' ? b : null; } catch { return null; }
}
const writeBackfill = (store, source, state) => store.set(K.backfill(source), JSON.stringify(state));

/** Coverage for the API: {indexedThroughSlot, indexedAt, historyComplete, historyFromSlot}. */
async function coverage(store, source) {
  const [{ checkpoint }, bf] = await Promise.all([readCheckpoint(store, source), readBackfill(store, source)]);
  return {
    indexedThroughSlot: checkpoint ? checkpoint.slot : null,
    indexedAt: checkpoint && checkpoint.at ? checkpoint.at : null,
    historyComplete: Boolean(bf && bf.done === true),
    historyFromSlot: bf && validSlot(bf.fromSlot) ? bf.fromSlot : null,
  };
}

// ---------------------------------------------------------------- incremental indexing (source-generic)
const MAX_PAGES = 10; // signatures looked back per run: 10 × 1,000
const MAX_SIGNATURES_PER_RUN = 300;
const CHUNK = 50;

/**
 * One incremental pass for `adapter` ({source, address, verify(rpc, sigInfos) -> {processed, relationships, stats}}).
 * Requires a checkpoint (seeded by the source's backfill). Collects every finalized signature newer than the
 * checkpoint (bounded look-back), processes at most maxSignatures of them OLDEST FIRST in chunks; after each chunk,
 * the chunk's verified relationships are written, THEN the checkpoint moves to the chunk's last processed signature.
 * A chunk that could not be fully processed (RPC failure) stops the run at its last contiguous success; the rest is
 * retried next run. Re-processing is harmless (idempotent writes).
 */
async function runIncremental({ store, rpc, adapter, now = Date.now, deadline, maxSignatures = MAX_SIGNATURES_PER_RUN, maxPages = MAX_PAGES, chunk = CHUNK }) {
  const r = { source: adapter.source, status: 'ok', pending: 0, processed: 0, written: 0, failedTx: 0, skipped: {}, rejected: {} };
  let { raw, checkpoint } = await readCheckpoint(store, adapter.source);
  if (!checkpoint) { r.status = 'not-backfilled'; return r; }
  const newer = [];
  let before, reached = false;
  for (let page = 0; page < maxPages; page++) {
    const sigs = await rpc.getSignaturesForAddress(adapter.address, { limit: 1000, until: checkpoint.signature, before });
    newer.push(...sigs);
    if (sigs.length < 1000) { reached = true; break; }
    before = sigs[sigs.length - 1].signature;
  }
  if (!reached) { r.status = 'backlog'; r.pending = newer.length; return r; } // too far behind: run the backfill catch-up
  const ordered = newer.reverse().filter((s) => s && isSignature(s.signature) && validSlot(s.slot));
  r.pending = ordered.length;
  if (!ordered.length) {
    const ok = await advanceCheckpoint(store, adapter.source, { ...checkpoint, at: now() }, raw);
    r.status = ok ? 'current' : 'checkpoint-conflict';
    r.through = checkpoint.slot;
    return r;
  }
  const work = ordered.slice(0, maxSignatures);
  for (let i = 0; i < work.length; i += chunk) {
    if (deadline && now() >= deadline) { r.status = 'budget'; break; }
    const part = work.slice(i, i + chunk);
    const v = await adapter.verify(rpc, part);
    for (const [k, n] of Object.entries(v.stats.skipped || {})) r.skipped[k] = (r.skipped[k] || 0) + n;
    for (const [k, n] of Object.entries(v.stats.rejected || {})) r.rejected[k] = (r.rejected[k] || 0) + n;
    r.failedTx += v.stats.failedTx || 0;
    if (v.processed > 0) {
      const w = await writeRelationships(store, v.relationships);
      r.written += w.added;
      const lastSig = part[v.processed - 1];
      const next = { signature: lastSig.signature, slot: lastSig.slot, at: now() };
      if (!(await advanceCheckpoint(store, adapter.source, next, raw))) { r.status = 'checkpoint-conflict'; break; }
      raw = JSON.stringify(next); checkpoint = next;
      r.processed += v.processed;
    }
    if (v.processed < part.length) { r.status = 'rpc-incomplete'; break; }
  }
  r.through = checkpoint.slot;
  if (r.status === 'ok' && r.processed < ordered.length) r.status = 'partial';
  return r;
}

module.exports = {
  CHAIN, CHAIN_LABEL, SOURCES, RELATIONSHIPS, PAGE_MAX, PAGE_DEFAULT, PREFIX, K, MAX_PAGES, MAX_SIGNATURES_PER_RUN, CHUNK,
  isSignature, checkRelationship, memberOf, parseMember, writeRelationships, encodeCursor, parseCursor, readRootPage,
  parseCheckpoint, readCheckpoint, advanceCheckpoint, readBackfill, writeBackfill, coverage, runIncremental,
};
