'use strict';
// SyncNet attestations for EARLY (docs §9, §10): build, sign with the dedicated attestation key, store, and queue the
// leaf for the daily bundle. Attestations never contain fan data. Signing = secp256k1 over
// keccak256('SYNCNET-ATTESTATION/1' ‖ id) with RFC-6979 nonces (lib/syncnet-core.js sign).
//
//   bundleDate rule: utcDate(issuedAt), advanced past every date whose bundle is already BUILT (stragglers move to
//   the next unbuilt day), so a frozen bundle never changes. Recorded on the attestation itself.
const E = require('../../lib/syncnet-early.js');

const K = {
  att: (id) => `early:att:v1:${id}`,
  queue: (d) => `early:bundle-queue:v1:${d}`,
  bundle: (d) => `early:bundle:v1:${d}`,
  bundles: 'early:bundles:v1',
};
const nextDay = (d) => new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);

/** The first date >= utcDate(issuedAt) whose bundle is not built (bounded scan of 400 days). */
async function bundleDateFor(store, issuedAtSec) {
  let d = E.utcDate(issuedAtSec);
  for (let i = 0; i < 400; i++) {
    if (!(await store.get(K.bundle(d)))) return d;
    d = nextDay(d);
  }
  throw new Error('bundleDateFor: no open bundle date');
}

/** Builds and signs an attestation record (no store access). `spec` = {type, subject, claims, issuedAt, bundleDate}. */
function build(signer, spec) {
  if (!signer || typeof signer.sign !== 'function') throw new Error('attestation signer unavailable');
  if (!E.ATTESTATION_TYPES.includes(spec.type)) throw new Error('attestation type');
  if (!E.isUnix(spec.issuedAt) || !E.isDate(spec.bundleDate)) throw new Error('attestation time');
  const rec = { schema: E.SCHEMA.attestation, type: spec.type, subject: spec.subject, claims: spec.claims, issuedAt: Number(spec.issuedAt), bundleDate: spec.bundleDate };
  E.canonicalJson(rec); // throws on floats / unsupported values before anything is signed
  rec.id = E.attestationId(rec);
  rec.keyId = signer.keyId;
  rec.signature = signer.sign(E.attestationDigest(rec.id));
  return rec;
}
/** The writes that persist a built attestation, for inclusion in a caller's atomic cas: {set, sadd}. */
function writesFor(rec) {
  return { set: [[K.att(rec.id), JSON.stringify(rec)]], sadd: [[K.queue(rec.bundleDate), E.leafHash(E.LEAF_ATTESTATION, rec.id)]] };
}
/** Standalone issue: build + persist (non-atomic with anything else). */
async function issue(store, signer, spec) {
  const rec = build(signer, spec);
  const w = writesFor(rec);
  for (const [k, v] of w.set) await store.set(k, v);
  for (const [k, m] of w.sadd) await store.sadd(k, m);
  return rec;
}
async function read(store, id) {
  const raw = await store.get(K.att(id));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
/** Inclusion proof of an attestation in its (frozen) bundle, or null while the bundle is not built. */
async function inclusion(store, rec) {
  const raw = await store.get(K.bundle(rec.bundleDate));
  if (!raw) return null;
  let b; try { b = JSON.parse(raw); } catch { return null; }
  const leaf = E.leafHash(E.LEAF_ATTESTATION, rec.id);
  const idx = Array.isArray(b.leaves) ? b.leaves.indexOf(leaf) : -1;
  if (idx < 0) return null;
  const p = E.merkleProof(b.leaves, idx);
  return { bundleDate: rec.bundleDate, root: b.root, leaf, leafIndex: idx, siblings: p.siblings, anchors: b.anchors || null };
}

module.exports = { K, bundleDateFor, build, writesFor, issue, read, inclusion, nextDay };
