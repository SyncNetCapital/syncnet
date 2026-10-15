// Test isolation for every automated suite. Import it FIRST (before anything that loads netlify/ code):
//
//   import '../lib/isolate.mjs';
//
// netlify/lib/store.js picks the Upstash adapter whenever UPSTASH_REDIS_REST_URL/TOKEN (or SYNCNET_UPSTASH_URL/TOKEN) are in
// process.env, so a shell that happens to carry real credentials would silently point createStore()/getStore() at that
// database. On import this module:
//   1. removes those variables from process.env (store.js then falls back to its in-memory adapter), and
//   2. wraps globalThis.fetch so a request to any *.upstash.io / *.upstash.com host fails before it leaves the process.
// Suites that replace globalThis.fetch with their own mock (e2e/harness.mjs blocks every unmocked host) stay isolated too.
//
// A suite that genuinely needs a hosted Redis must opt in EXPLICITLY, with variables that production never uses:
//   SYNCNET_TEST_UPSTASH_URL / SYNCNET_TEST_UPSTASH_TOKEN   a dedicated, non-production test database
//   SYNCNET_TEST_UPSTASH_CONFIRM=non-production             written confirmation that it is not production
// It is refused when the URL is the same database as any production variable found in the environment. Only
// testUpstash() hands it out; nothing here prints a value (names only).
const STORE_VARS = Object.freeze(['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'SYNCNET_UPSTASH_URL', 'SYNCNET_UPSTASH_TOKEN']);
const hostOf = (u) => { try { return new URL(String(u)).hostname.toLowerCase(); } catch { return ''; } };

const productionHosts = new Set();
const removed = [];
for (const k of STORE_VARS) {
  if (process.env[k] === undefined) continue;
  if (/_URL$/.test(k) && hostOf(process.env[k])) productionHosts.add(hostOf(process.env[k]));
  delete process.env[k];
  removed.push(k);
}

function optIn() {
  const url = String(process.env.SYNCNET_TEST_UPSTASH_URL || '').trim(), token = String(process.env.SYNCNET_TEST_UPSTASH_TOKEN || '').trim();
  if (!url || !token) return null;
  if (process.env.SYNCNET_TEST_UPSTASH_CONFIRM !== 'non-production') throw new Error('SYNCNET_TEST_UPSTASH_URL is set but SYNCNET_TEST_UPSTASH_CONFIRM=non-production is not: refusing to use it.');
  const host = hostOf(url);
  if (!host || !/^https:\/\//i.test(url)) throw new Error('SYNCNET_TEST_UPSTASH_URL must be an https URL.');
  if (productionHosts.has(host)) throw new Error('SYNCNET_TEST_UPSTASH_URL is the same database as a production store variable in this environment: refusing to use it.');
  return { url, token, host };
}
const TEST_DB = optIn();

const UPSTASH_HOST = /(^|\.)upstash\.(io|com)$/;
const realFetch = globalThis.fetch;
if (typeof realFetch === 'function' && !realFetch.__syncnetIsolated) {
  const isolated = function isolatedFetch(input, init) {
    const host = hostOf(typeof input === 'string' || input instanceof URL ? input : input && input.url);
    if (UPSTASH_HOST.test(host) && !(TEST_DB && host === TEST_DB.host)) {
      return Promise.reject(new Error('BLOCKED: automated tests may not reach a hosted Upstash database (' + host + '). Use the in-memory store, or opt in with SYNCNET_TEST_UPSTASH_* (non-production).'));
    }
    return realFetch(input, init);
  };
  isolated.__syncnetIsolated = true;
  globalThis.fetch = isolated;
}

/** The explicitly opted-in non-production test database ({url, token, host}) or null. */
export const testUpstash = () => TEST_DB;
/** Names (never values) of the production store variables that were present and removed. */
export const removedStoreVars = () => removed.slice();
export const STORE_ENV_VARS = STORE_VARS;
