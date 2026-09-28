#!/usr/bin/env node
// SyncNet ops CLI: suspend / reinstate a Project Home (netlify/lib/project-home-suspension.js). Never deployed as a
// function and never served (/netlify/* is 404). Authority = the production Upstash credentials in the environment;
// there is no HTTP route and no wallet signature involved. Refuses to run without a durable store.
//
//   node netlify/ops/project-home-suspension.mjs status    <token>
//   node netlify/ops/project-home-suspension.mjs suspend   <token> --category <security|abuse|legal|third-party-rights|terms> --actor <ops-id> [--note "internal note"]
//   node netlify/ops/project-home-suspension.mjs reinstate <token> --actor <ops-id> [--note "internal note"]
//
// Requires UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or SYNCNET_UPSTASH_URL / _TOKEN).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStore } = require('../lib/store.js');
const Suspension = require('../lib/project-home-suspension.js');

const [command, token, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!/^--(category|actor|note)$/.test(rest[i]) || rest[i + 1] === undefined) { console.error('Unknown or incomplete option: ' + rest[i]); process.exit(2); }
  opt[rest[i].slice(2)] = rest[i + 1];
}
const store = createStore({ env: process.env });
if (!store.durable) { console.error('Refusing to run: no durable store configured (set the production Upstash credentials).'); process.exit(2); }
try {
  const t = String(token || '').toLowerCase();
  if (command === 'suspend') console.log(JSON.stringify(await Suspension.suspend(store, t, opt), null, 2));
  else if (command === 'reinstate') console.log(JSON.stringify(await Suspension.reinstate(store, t, opt), null, 2));
  else if (command === 'status') {
    const s = await Suspension.readSuspension(store, t);
    console.log(JSON.stringify({ suspended: s.suspended, record: s.record, unparseable: Boolean(s.raw && !s.record), history: await Suspension.history(store, t) }, null, 2));
  } else { console.error('Usage: status|suspend|reinstate <token> [--category …] [--actor …] [--note …]'); process.exit(2); }
} catch (err) {
  console.error('Failed: ' + (err && err.message));
  process.exit(1);
}
