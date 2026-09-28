'use strict';
/*
 * Pump.fun truth model for SyncNet Solana discovery (server only: needs Node's crypto for PDA derivation).
 *
 * A Pump launch is accepted only on evidence the Pump program itself produced, in a SUCCESSFUL, FINALIZED transaction:
 *   1. a CreateEvent emitted through Anchor's event self-CPI: an instruction to the canonical Pump program whose data
 *      starts with the event tag e445a52e51cb9a1d + the CreateEvent discriminator and whose FIRST account is the
 *      canonical event authority (only Pump can sign for that PDA, so no other program can fake it in a successful
 *      transaction). "Program data:" log lines are never read — they can be printed by anyone.
 *   2. the self-CPI's parent instruction (the instruction one stack level up) is a Pump create / create_v2 whose
 *      mint and bonding-curve accounts are the ones the event names, and whose mint authority is the canonical PDA.
 *   3. the event's bonding curve is the PDA ["bonding-curve", mint] of the Pump program, and that account (read
 *      separately, finalized) is owned by Pump, carries the BondingCurve discriminator and records the same
 *      quote_mint as the event.
 * Native SOL is the default pubkey (111…1) and is never rewritten to wrapped SOL. Metadata URIs are never fetched;
 * name/symbol/uri are skipped while decoding and never returned.
 */
const crypto = require('crypto');
const Assets = require('./syncnet-assets.js');

const PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const EVENT_AUTHORITY = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';
const MINT_AUTHORITY = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
const GLOBAL = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
const QUOTE_CONTROL = '6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP';
const NATIVE_SOL = Assets.NATIVE_SOL;

const hexOf = (a) => Buffer.from(a).toString('hex');
const DISC = Object.freeze({
  create: hexOf([24, 30, 200, 40, 5, 28, 7, 119]),
  createV2: hexOf([214, 144, 76, 236, 95, 139, 49, 180]),
  createEvent: hexOf([27, 114, 169, 77, 222, 235, 99, 118]),
  bondingCurve: hexOf([23, 183, 248, 55, 96, 216, 172, 96]),
});
const EVENT_TAG = 'e445a52e51cb9a1d';

// First slot with a non-SOL Pump launch: the oldest transaction that references QuoteControl (a USDC-quoted create_v2,
// finalized, slot 445,675,307, 2026-09-09T18:07:54Z). Every non-SOL create_v2 passes QuoteControl; SOL creates do not.
// See docs/SOLANA_DISCOVERY.md for the evidence and its limits.
const NON_SOL_START_SLOT = 445675307;

// ---------------------------------------------------------------- ed25519 / PDA
const P = (1n << 255n) - 19n;
const modp = (x) => ((x % P) + P) % P;
function powmod(b, e) { let r = 1n; b = modp(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
const D = modp(-121665n * powmod(121666n, P - 2n));

/** Same answer as curve25519-dalek CompressedEdwardsY::decompress().is_some() (what Solana uses for PDAs). */
function isOnCurve(bytes) {
  if (!bytes || bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  y = modp(y);
  const y2 = (y * y) % P;
  const u = modp(y2 - 1n), v = modp(D * y2 + 1n);
  if (v === 0n) return u === 0n;
  const w = (u * powmod(v, P - 2n)) % P;
  return w === 0n || powmod(w, (P - 1n) / 2n) === 1n;
}

/** findProgramAddress(seeds: Buffer[], programId) -> {address, bump}. */
function findProgramAddress(seeds, programId) {
  const program = Assets.base58Decode(programId);
  if (!program || program.length !== 32) throw new TypeError('invalid program id');
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Buffer.from([bump])).update(Buffer.from(program)).update('ProgramDerivedAddress');
    const out = h.digest();
    if (!isOnCurve(out)) return { address: Assets.base58Encode(out), bump };
  }
  throw new Error('no viable bump');
}

/** The Pump BondingCurve PDA of `mint` (base58, case preserved). */
function bondingCurveOf(mint) {
  const m = Assets.base58Decode(mint);
  if (!Assets.isSolanaMint(mint) || !m) throw new TypeError('invalid mint');
  return findProgramAddress([Buffer.from('bonding-curve'), Buffer.from(m)], PROGRAM).address;
}

// ---------------------------------------------------------------- borsh reader
function reader(buf, start) {
  let o = start;
  const need = (n) => { if (o + n > buf.length) throw new RangeError('truncated'); };
  return {
    left: () => buf.length - o,
    skipString(max = 4096) { need(4); const n = buf.readUInt32LE(o); o += 4; if (n > max) throw new RangeError('string too long'); need(n); o += n; },
    pubkey() { need(32); const s = Assets.base58Encode(buf.subarray(o, o + 32)); o += 32; return s; },
    u64() { need(8); const v = buf.readBigUInt64LE(o); o += 8; return v; },
    i64() { need(8); const v = buf.readBigInt64LE(o); o += 8; return v; },
    bool() { need(1); const v = buf[o]; o += 1; if (v > 1) throw new RangeError('bad bool'); return v === 1; },
  };
}

/**
 * CreateEvent payload (after the 8-byte tag + 8-byte discriminator) -> event | null. Version tolerant: the base
 * layout (name, symbol, uri, mint, bonding_curve, user) is required; later fields are read only when present
 * (creator, timestamp, 4 × u64 reserves/supply, token_program, is_mayhem_mode, is_cashback_enabled, quote_mint).
 * An event without quote_mint predates non-SOL quotes: its quote is native SOL (quotePresent:false).
 */
function decodeCreateEvent(data) {
  const buf = Buffer.from(data || []);
  if (buf.length < 16 || buf.subarray(0, 8).toString('hex') !== EVENT_TAG || buf.subarray(8, 16).toString('hex') !== DISC.createEvent) return null;
  try {
    const r = reader(buf, 16);
    r.skipString(); r.skipString(); r.skipString(); // name, symbol, uri: never kept
    const ev = { mint: r.pubkey(), bondingCurve: r.pubkey(), user: r.pubkey(), creator: null, timestamp: null, quoteMint: NATIVE_SOL, quotePresent: false };
    if (r.left() >= 32) ev.creator = r.pubkey();
    if (r.left() >= 8) ev.timestamp = Number(r.i64());
    for (let i = 0; i < 4 && r.left() >= 8; i++) r.u64();
    if (r.left() >= 32) r.pubkey(); // token_program
    if (r.left() >= 1) r.bool(); // is_mayhem_mode
    if (r.left() >= 1) r.bool(); // is_cashback_enabled
    if (r.left() >= 32) { ev.quoteMint = r.pubkey(); ev.quotePresent = true; }
    if (!Assets.isSolanaMint(ev.mint) || !Assets.isSolanaPubkey(ev.bondingCurve)) return null;
    return ev;
  } catch {
    return null;
  }
}

/**
 * BondingCurve account data -> {complete, creator, quoteMint, quotePresent} | null (wrong discriminator / truncated).
 * Layout: disc(8) · 5 × u64 · complete(bool @48) · creator(@49) · is_mayhem_mode(@81) · is_cashback(@82) ·
 * quote_mint(@83..115). Curves that predate quote_mint (shorter, or zero-extended) are native SOL.
 */
function decodeBondingCurve(data) {
  const buf = Buffer.from(data || []);
  if (buf.length < 49 || buf.subarray(0, 8).toString('hex') !== DISC.bondingCurve) return null;
  const out = { complete: buf[48] === 1, creator: null, quoteMint: NATIVE_SOL, quotePresent: false };
  if (buf.length >= 81) out.creator = Assets.base58Encode(buf.subarray(49, 81));
  if (buf.length >= 115) { out.quoteMint = Assets.base58Encode(buf.subarray(83, 115)); out.quotePresent = true; }
  return out;
}

// ---------------------------------------------------------------- transactions
/** Every account key of a 'json'-encoded transaction, in index order (static keys, then ALT writable, readonly). */
function accountKeysOf(tx) {
  const msg = tx && tx.transaction && tx.transaction.message;
  const loaded = (tx && tx.meta && tx.meta.loadedAddresses) || {};
  const keys = Array.isArray(msg && msg.accountKeys) ? msg.accountKeys.map((k) => (typeof k === 'string' ? k : k && k.pubkey)) : [];
  return [...keys, ...(loaded.writable || []), ...(loaded.readonly || [])];
}

function ixDataBytes(ix) {
  const b = Assets.base58Decode(ix && ix.data);
  return b ? Buffer.from(b) : ix && ix.data === '' ? Buffer.alloc(0) : null;
}

/**
 * Canonical CreateEvents of one transaction -> {failed, events:[{…event, signature?, slot}], rejected}.
 * Failed transactions yield nothing. An event counts only when rules 1 and 2 of the header hold.
 */
function extractCreateEvents(tx) {
  const out = { failed: false, events: [], rejected: 0 };
  if (!tx || !tx.meta || !tx.transaction) { out.failed = true; return out; }
  if (tx.meta.err !== null && tx.meta.err !== undefined) { out.failed = true; return out; }
  const keys = accountKeysOf(tx);
  const outer = (tx.transaction.message && tx.transaction.message.instructions) || [];
  const key = (i) => (Number.isInteger(i) ? keys[i] : undefined);
  for (const group of Array.isArray(tx.meta.innerInstructions) ? tx.meta.innerInstructions : []) {
    const top = outer[group.index];
    if (!top) continue;
    const seq = [{ ...top, stackHeight: 1 }, ...(Array.isArray(group.instructions) ? group.instructions : [])];
    for (let i = 1; i < seq.length; i++) {
      const ix = seq[i];
      if (key(ix.programIdIndex) !== PROGRAM) continue;
      const data = ixDataBytes(ix);
      if (!data || data.length < 16 || data.subarray(0, 8).toString('hex') !== EVENT_TAG || data.subarray(8, 16).toString('hex') !== DISC.createEvent) continue;
      // Rule 1: the self-CPI's first account is the canonical event authority.
      const accts = Array.isArray(ix.accounts) ? ix.accounts : [];
      if (key(accts[0]) !== EVENT_AUTHORITY || !Number.isInteger(ix.stackHeight) || ix.stackHeight < 2) { out.rejected += 1; continue; }
      // Rule 2: its parent is a Pump create/create_v2 for the same mint and bonding curve.
      let parent = null;
      for (let j = i - 1; j >= 0; j--) {
        const h = seq[j].stackHeight;
        if (!Number.isInteger(h)) break;
        if (h === ix.stackHeight - 1) { parent = seq[j]; break; }
        if (h < ix.stackHeight - 1) break;
      }
      const pdata = parent && key(parent.programIdIndex) === PROGRAM ? ixDataBytes(parent) : null;
      const pdisc = pdata && pdata.length >= 8 ? pdata.subarray(0, 8).toString('hex') : '';
      const ev = decodeCreateEvent(data);
      const pa = parent && Array.isArray(parent.accounts) ? parent.accounts : [];
      if (!ev || (pdisc !== DISC.create && pdisc !== DISC.createV2) || key(pa[0]) !== ev.mint || key(pa[1]) !== MINT_AUTHORITY || key(pa[2]) !== ev.bondingCurve) { out.rejected += 1; continue; }
      out.events.push({ ...ev, instruction: pdisc === DISC.createV2 ? 'create_v2' : 'create', slot: Number(tx.slot) });
    }
  }
  return out;
}

/**
 * Rule 3: independent BondingCurve verification of a decoded event against the finalized account `acct`
 * ({owner, data} from getAccountInfo / getMultipleAccounts). -> {ok:true, curve} | {ok:false, reason}.
 */
function verifyLaunch(ev, acct) {
  if (!ev || !Assets.isSolanaMint(ev.mint)) return { ok: false, reason: 'bad-event' };
  let pda;
  try { pda = bondingCurveOf(ev.mint); } catch { return { ok: false, reason: 'bad-mint' }; }
  if (pda !== ev.bondingCurve) return { ok: false, reason: 'curve-not-pda' };
  if (!acct) return { ok: false, reason: 'curve-missing' };
  if (acct.owner !== PROGRAM) return { ok: false, reason: 'curve-owner' };
  const curve = decodeBondingCurve(acct.data);
  if (!curve) return { ok: false, reason: 'curve-discriminator' };
  if (curve.quoteMint !== ev.quoteMint) return { ok: false, reason: 'quote-mismatch' };
  return { ok: true, curve };
}

const isNonSolQuote = (ev) => Boolean(ev && ev.quotePresent && Assets.isSolanaMint(ev.quoteMint));

module.exports = {
  PROGRAM, EVENT_AUTHORITY, MINT_AUTHORITY, GLOBAL, QUOTE_CONTROL, NATIVE_SOL, DISC, EVENT_TAG, NON_SOL_START_SLOT,
  isOnCurve, findProgramAddress, bondingCurveOf, decodeCreateEvent, decodeBondingCurve, accountKeysOf,
  extractCreateEvents, verifyLaunch, isNonSolQuote,
};
