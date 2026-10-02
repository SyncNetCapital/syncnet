#!/usr/bin/env node
// SyncNet ops CLI: EARLY pilot metrics (docs/sync-proof-early-spec.md §20). Never deployed as a function and never
// served (/netlify/* is 404). Reads the production Upstash credentials from the environment. Aggregates only: nothing
// per creator is printed, no wallet is printed, and "signals" / "supporters" are counts of records, never people.
//
//   node netlify/ops/early-metrics.mjs [--days 30]
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStore } = require('../lib/store.js');
const E = require('../../lib/syncnet-early.js');

const args = process.argv.slice(2);
const days = Math.max(1, Math.min(120, Number(args[args.indexOf('--days') + 1]) || 30));
const store = createStore({ env: process.env });
if (!store.durable) { console.error('Refusing to run: no durable store configured (set the production Upstash credentials).'); process.exit(2); }

const NAMES = ['count_me_in_signals', 'count_me_in_renewed', 'count_me_in_withdrawn', 'creators_claimed', 'claims_with_signals_waiting', 'intents_drafted', 'intents_stored', 'intents_expired_unmatched', 'receipts_confirmed', 'receipts_finalized', 'receipts_mode_auto', 'receipts_mode_ambiguous_finalized', 'receipts_mode_recovery_finalized', 'rotations_started', 'cards_generated', 'share_links_copied', 'verification_page_visits'];
const today = Math.floor(Date.now() / 1000);
const out = { window: { days, from: E.utcDate(today - (days - 1) * 86400), to: E.utcDate(today) }, totals: {}, byDay: {} };
for (let i = days - 1; i >= 0; i--) {
  const d = E.utcDate(today - i * 86400);
  out.byDay[d] = {};
  for (const n of NAMES) { const v = Number(await store.get(`early:metrics:v1:${n}:${d}`)) || 0; out.byDay[d][n] = v; out.totals[n] = (out.totals[n] || 0) + v; }
}
// repeat supporters: wallets with >= 2 FINALIZED receipts to the same creator, and to any creator (records, not people)
const creators = await store.smembers('early:creators:v1');
const perWalletCreator = new Map(), perWallet = new Map();
let finalized = 0, distinctWallets = new Set();
for (const cid of creators.slice(0, 500)) {
  for (const rid of (await store.smembers(`early:receipts-of-creator:v1:${cid}`)).slice(0, 5000)) {
    const raw = await store.get(`early:receipt:v1:${rid}`); let r = null; try { r = raw ? JSON.parse(raw) : null; } catch { r = null; }
    if (!r || r.status !== 'FINALIZED') continue;
    finalized++;
    const w = String(r.fact.transfer.from).toLowerCase();
    distinctWallets.add(w);
    perWallet.set(w, (perWallet.get(w) || 0) + 1);
    const k = w + '|' + cid; perWalletCreator.set(k, (perWalletCreator.get(k) || 0) + 1);
  }
}
out.derived = {
  creators_active_or_pending: creators.length,
  receipts_finalized_total: finalized,
  distinct_supporting_wallets: distinctWallets.size,
  repeat_supporters_same_creator: [...perWalletCreator.values()].filter((n) => n >= 2).length,
  repeat_supporters_any_creator: [...perWallet.values()].filter((n) => n >= 2).length,
  note: 'Counts of wallet records, not people. Never publish per-creator figures.',
};
console.log(JSON.stringify(out, null, 2));
