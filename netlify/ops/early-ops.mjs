#!/usr/bin/env node
// SyncNet ops CLI for EARLY moderation. Never deployed as a function and never served (/netlify/* is 404). Authority =
// the production Upstash credentials in the environment. It can only HIDE a public card (or reinstate it) and inspect
// a bundle; it cannot create, alter or finalise a receipt, an intent, a manifest or an attestation.
//
//   node netlify/ops/early-ops.mjs card-suspend   <shareId> --actor <ops-id> [--note "internal"]
//   node netlify/ops/early-ops.mjs card-reinstate <shareId> --actor <ops-id>
//   node netlify/ops/early-ops.mjs bundle <YYYY-MM-DD>            (prints the frozen bundle: leaves, root, anchors)
//   node netlify/ops/early-ops.mjs ots-file <YYYY-MM-DD> <out.ots> (writes the detached OpenTimestamps proof file)
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { createStore } = require('../lib/store.js');
const E = require('../../lib/syncnet-early.js');
const Ots = require('../lib/early-ots.js');

const [command, arg1, arg2, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 2) { if (!/^--(actor|note)$/.test(rest[i]) || rest[i + 1] === undefined) { console.error('Unknown or incomplete option: ' + rest[i]); process.exit(2); } opt[rest[i].slice(2)] = rest[i + 1]; }
const store = createStore({ env: process.env });
if (!store.durable) { console.error('Refusing to run: no durable store configured.'); process.exit(2); }
const getJson = async (k) => { const raw = await store.get(k); return { raw, value: raw ? JSON.parse(raw) : null }; };
try {
  if (command === 'card-suspend' || command === 'card-reinstate') {
    const shareId = String(arg1 || '').toLowerCase();
    if (!E.isBytes32(shareId) || !opt.actor) { console.error('usage: card-suspend|card-reinstate <shareId> --actor <ops-id>'); process.exit(2); }
    const c = await getJson(`early:card:v1:${shareId}`);
    if (!c.value) { console.error('card not found'); process.exit(1); }
    const next = { ...c.value, suspended: command === 'card-suspend', moderation: [...(c.value.moderation || []), { action: command, actor: opt.actor, note: opt.note || '', at: new Date().toISOString() }] };
    const ok = await store.cas({ expect: [[`early:card:v1:${shareId}`, c.raw]], set: [[`early:card:v1:${shareId}`, JSON.stringify(next)]] });
    console.log(JSON.stringify({ ok, shareId, suspended: next.suspended }, null, 2));
  } else if (command === 'bundle') {
    if (!E.isDate(arg1)) { console.error('usage: bundle <YYYY-MM-DD>'); process.exit(2); }
    const b = await getJson(`early:bundle:v1:${arg1}`);
    if (!b.value) { console.log(JSON.stringify({ built: false, pendingLeaves: (await store.smembers(`early:bundle-queue:v1:${arg1}`)).length })); process.exit(0); }
    const recomputed = E.merkleRoot(E.sortLeaves(b.value.leaves), arg1);
    console.log(JSON.stringify({ ...b.value, rootRecomputed: recomputed, rootMatches: recomputed === b.value.root }, null, 2));
  } else if (command === 'ots-file') {
    if (!E.isDate(arg1) || !arg2) { console.error('usage: ots-file <YYYY-MM-DD> <out.ots>'); process.exit(2); }
    const b = await getJson(`early:bundle:v1:${arg1}`);
    const o = b.value && b.value.anchors && b.value.anchors.opentimestamps;
    if (!o || !o.proof) { console.error('no OpenTimestamps proof stored for that day'); process.exit(1); }
    fs.writeFileSync(arg2, Buffer.from(Ots.otsFile(b.value.root, o.proof)));
    console.log(JSON.stringify({ written: arg2, root: b.value.root, status: o.status, note: 'Verify with the OpenTimestamps client: `ots upgrade` then `ots verify`. "submitted" means not yet Bitcoin-verifiable.' }, null, 2));
  } else { console.error('Usage: card-suspend|card-reinstate <shareId> --actor … | bundle <date> | ots-file <date> <out>'); process.exit(2); }
} catch (err) { console.error('Failed: ' + (err && err.message)); process.exit(1); }
