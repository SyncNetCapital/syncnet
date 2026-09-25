// Economies V0 server suite: /api/economies under normal use and abuse, plus the flags.js rollout gate.
// Curator authority is REUSED from the Marketplace Project Passport (created here through the real
// /api/marketplace claim + two-party transfer), relationships come from live mock-chain reads, and every
// write is an append-only SADD. The suite also proves that Economies never writes mp:*, reg:* or any
// non-eco key other than rate-limit counters. No real network. Run: node tests/server/economies.test.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { A, chain, resetChain, signDigest, Core, ROOT } from '../e2e/harness.mjs';

const require = createRequire(import.meta.url);
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 300) + '\n'); } }
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);
for (const n of ['https', 'http', 'net', 'tls']) { const m = require(n); for (const f of ['request', 'get', 'connect', 'createConnection']) if (typeof m[f] === 'function') m[f] = () => { throw new Error('real network access in tests'); }; }

const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
const { flags } = require(path.join(ROOT, 'netlify/lib/flags.js'));
const Economy = require(path.join(ROOT, 'lib/syncnet-economy.js'));
const Market = require(path.join(ROOT, 'lib/syncnet-market.js'));
const eco = require(path.join(ROOT, 'netlify/functions/economies.js'));
const mp = require(path.join(ROOT, 'netlify/functions/marketplace.js'));
const J = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };
let ipSeq = 0;
const ev = (method, { ip, query = {}, body = null } = {}) => ({ httpMethod: method, headers: { 'x-nf-client-connection-ip': ip || `198.51.100.${(ipSeq++ % 250) + 1}` }, queryStringParameters: query, body: body == null ? null : JSON.stringify(body) });
const MAP = new Map();
const store = { ...createStore({ map: MAP }), durable: true, kind: 'test-durable' };
const ON = { SYNCNET_ECONOMY_CURATION: 'true' };
const deps = { store, env: ON };
const GET = (query, d = deps) => eco._handler(ev('GET', { query }), d);
const POST = (body, d = deps, ip) => eco._handler(ev('POST', { body, ip }), d);
const MP = (body) => mp._handler(ev('POST', { body }), { store, env: {} });
const lc = (v) => String(v).toLowerCase();
const rnd = () => '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
const nowSec = () => Math.floor(Date.now() / 1000);
const noLeak = (r) => !/\n\s+at |Error:|ENOTFOUND|stack|\.js:\d|upstash|redis/i.test(r.body);

const SYNC = lc(A.SYNC); // PAR launch in the mock (deployer A.WALLET); children paired with it: SYNCAT, PONS_FAKE, EVIL, CATF0..5
const SYNCAT = lc(A.SYNCAT), PONS_FAKE = lc(A.PONS_FAKE), CATF0 = '0x8' + '0'.repeat(39), CATF1 = '0x8' + '1'.repeat(39);
const CREATORLIVE = lc(A.CREATORLIVE); // paired with CASHCAT only → NOT connected to $SYNC
const FAKESYNC = lc(A.FAKESYNC); // "SYNC" ticker, different contract, deployed by the attacker
const CASHCAT = lc(A.CASHCAT); // not a PAR launch
const OPERATOR = lc(A.WALLET), BUYER = lc(A.WALLET2), ATTACKER = lc(A.ATTACKER);

function curation(fields, as) {
  const m = { root: SYNC, child: SYNCAT, curator: OPERATOR, decision: 'recognize', issuedAt: nowSec(), nonce: rnd(), ...fields };
  return { action: 'curate', ...m, signature: signDigest(as || m.curator, Economy.digest('EconomyCuration', m)) };
}
const recognized = async (root = SYNC, d = deps) => J(await GET({ view: 'economy', root }, d)).recognized?.map((e) => e.child) || [];
resetChain();
const keysBefore = new Set(MAP.keys());

// ================================================================================ flags.js gate
{
  const durable = { durable: true }, memory = { durable: false };
  check('flags: economy curation is CLOSED by default', flags({ env: {}, store: durable }).economyCuration === false);
  check('flags: SYNCNET_ECONOMY_CURATION=true + durable store opens curation', flags({ env: ON, store: durable }).economyCuration === true);
  check('flags: without a durable store curation stays closed', flags({ env: ON, store: memory }).economyCuration === false);
  check('flags: kill switch SYNCNET_ECONOMIES_DISABLED closes curation', flags({ env: { ...ON, SYNCNET_ECONOMIES_DISABLED: 'true' }, store: durable }).economyCuration === false);
  check('flags: only the exact value "true" opens it', flags({ env: { SYNCNET_ECONOMY_CURATION: '1' }, store: durable }).economyCuration === false && flags({ env: { SYNCNET_ECONOMY_CURATION: 'yes' }, store: durable }).economyCuration === false);
  check('flags: existing gates are unchanged by the addition', flags({ env: {}, store: durable }).marketplace === true && flags({ env: {}, store: durable }).publicLaunch === false);
  const r = await GET({ view: 'config' }, { store, env: {} });
  check('config view: curation reported closed when the flag is off', J(r).curation === false && !/SYNCNET_|UPSTASH/.test(r.body));
  check('config view: open with the flag', J(await GET({ view: 'config' })).curation === true);
}

// ================================================================================ fail closed
{
  const mem = createStore({ map: new Map() });
  let r = await POST(curation({}), { store, env: {} });
  check('fail closed: writes refused (503) when the flag is off', r.statusCode === 503 && J(r).code === 'closed', r.body);
  r = await POST(curation({}), { store, env: { ...ON, SYNCNET_ECONOMIES_DISABLED: 'true' } });
  check('fail closed: kill switch refuses writes', r.statusCode === 503, r.body);
  r = await POST(curation({}), { store: mem, env: ON });
  check('fail closed: no durable store → writes refused', r.statusCode === 503, r.body);
  r = await GET({ view: 'economy', root: SYNC }, { store: mem, env: ON });
  check('fail closed: no durable store → reads answer durable:false with nothing recognized', r.statusCode === 200 && J(r).durable === false && J(r).recognized.length === 0);
  check('method: PUT refused', (await eco._handler(ev('PUT'), deps)).statusCode === 405);
  check('read: invalid root refused', (await GET({ view: 'economy', root: 'SYNC' })).statusCode === 400);
  check('read: zero address refused as a root', (await GET({ view: 'economy', root: '0x' + '0'.repeat(40) })).statusCode === 400);
  check('read: unknown view refused', (await GET({ view: 'leaderboard' })).statusCode === 400);
}

// ================================================================================ no curator yet
{
  const r = await POST(curation({ child: SYNCAT }));
  check('unclaimed root: nobody can curate (403 no_curator)', r.statusCode === 403 && J(r).code === 'no_curator', r.body);
  const g = J(await GET({ view: 'economy', root: SYNC }));
  check('unclaimed root: economy view has curator:null and nothing recognized', g.curator === null && g.recognized.length === 0);
}

// ================================================================================ Passport reuse: operator claims via the existing Marketplace
{
  const m = { token: SYNC, operator: OPERATOR, basis: 'deployer', nonce: rnd(), expiry: nowSec() + 600 };
  const r = await MP({ action: 'claim', ...m, signature: signDigest(OPERATOR, Market.digest('OperatorClaim', m)) });
  check('setup: the $SYNC deployer claims the Project Passport through /api/marketplace (unchanged flow)', r.statusCode === 200, r.body);
  const g = J(await GET({ view: 'economy', root: SYNC }));
  check('curator = the Passport operator (source passport)', g.curator && g.curator.address === OPERATOR && g.curator.source === 'passport');
}

// ================================================================================ recognize / revoke
{
  let r = await POST(curation({ child: SYNCAT }));
  check('curator recognizes a connected child (live PAR market verified)', r.statusCode === 200 && J(r).ok && J(r).recognized === true, r.body);
  check('the child is now PARENT-RECOGNIZED in the economy view', (await recognized()).includes(SYNCAT));
  const g = J(await GET({ view: 'economy', root: SYNC }));
  const e = g.recognized[0];
  check('each recognition is independently verifiable (id = EIP-712 digest, signature recovers to the curator)', e.id === Economy.digest('EconomyCuration', { root: SYNC, child: e.child, curator: e.curator, decision: e.decision, issuedAt: e.issuedAt, nonce: e.nonce }) && lc(Core.recoverAddress(e.id, e.signature)) === OPERATOR);

  r = await POST(curation({ child: CREATORLIVE }));
  check('a project with NO market paired with the root cannot be recognized (422)', r.statusCode === 422 && J(r).code === 'not_connected', r.body);
  r = await POST(curation({ child: '0x' + 'ab'.repeat(20) }));
  check('a non-PAR address cannot be recognized (422)', r.statusCode === 422, r.body);
  r = await POST(curation({ child: SYNC }));
  check('the root cannot recognize itself', r.statusCode === 400, r.body);

  r = await POST(curation({ child: PONS_FAKE, curator: ATTACKER }, ATTACKER));
  check('a non-curator wallet (valid signature) is refused (403 not_curator)', r.statusCode === 403 && J(r).code === 'not_curator', r.body);
  r = await POST(curation({ child: PONS_FAKE }, ATTACKER));
  check('a signature by a different wallet is refused (401)', r.statusCode === 401 && noLeak(r), r.body);
  const m = { root: SYNC, child: PONS_FAKE, curator: OPERATOR, decision: 'recognize', issuedAt: nowSec(), nonce: rnd() };
  const mkt = Core.hashTypedData({ ...Economy.typedData('EconomyCuration', m), domain: { ...Market.DOMAIN } });
  r = await POST({ action: 'curate', ...m, signature: signDigest(OPERATOR, mkt) });
  check('a signature over the Marketplace EIP-712 domain is refused here (401)', r.statusCode === 401, r.body);
  r = await POST({ ...curation({ child: PONS_FAKE }), deployer: ATTACKER, operator: ATTACKER, source: 'passport' });
  check('extra client fields cannot change anything (still verified against the real curator)', r.statusCode === 200 && (await recognized()).includes(PONS_FAKE), r.body);
  r = await POST(curation({ child: CATF0, issuedAt: nowSec() - 3600 }));
  check('issuedAt far in the past is refused', r.statusCode === 400, r.body);
  r = await POST(curation({ child: CATF0, issuedAt: nowSec() + 3600 }));
  check('issuedAt far in the future is refused', r.statusCode === 400, r.body);
  r = await POST(curation({ child: CATF0, decision: 'official' }));
  check('only recognize/revoke decisions exist', r.statusCode === 400, r.body);

  const same = curation({ child: CATF0 });
  r = await POST(same); const r2 = await POST(same);
  check('submitting the same signed event twice is idempotent (duplicate:true, one member)', r.statusCode === 200 && r2.statusCode === 200 && J(r2).duplicate === true && [...MAP.get('eco:cur:v1:' + SYNC).value].filter((x) => x.includes(J(r).id)).length === 1, r2.body);

  const t = nowSec();
  const oldRecognize = curation({ child: CATF1, issuedAt: t - 20 });
  r = await POST(oldRecognize);
  r = await POST(curation({ child: CATF1, decision: 'revoke', issuedAt: t - 10 }));
  check('curator revokes a recognition', r.statusCode === 200 && !(await recognized()).includes(CATF1), r.body);
  r = await POST(oldRecognize);
  check('replaying the old signed recognition does not bring it back', !(await recognized()).includes(CATF1), r.body);
  r = await POST(curation({ child: CATF1, decision: 'recognize', issuedAt: t - 15 }));
  check('an event older than the latest decision is refused as stale (409) and changes nothing', r.statusCode === 409 && J(r).code === 'stale' && !(await recognized()).includes(CATF1), r.body);
}

// ================================================================================ concurrency: order-independent result
{
  const t = nowSec();
  const rec = curation({ child: CATF1, decision: 'recognize', issuedAt: t + 2 });
  const rev = curation({ child: CATF1, decision: 'revoke', issuedAt: t + 1 });
  await Promise.all([POST(rev), POST(rec)]);
  const a = (await recognized()).includes(CATF1);
  const rec2 = curation({ child: CATF1, decision: 'revoke', issuedAt: t + 4 });
  const rev2 = curation({ child: CATF1, decision: 'recognize', issuedAt: t + 3 });
  await Promise.all([POST(rev2), POST(rec2)]);
  const b = (await recognized()).includes(CATF1);
  check('concurrent recognize(t+2) + revoke(t+1) → recognized (latest SIGNED intent wins)', a === true);
  check('concurrent recognize(t+3) + revoke(t+4) → not recognized (latest SIGNED intent wins)', b === false);
  const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => POST(curation({ child: [CATF0, SYNCAT, PONS_FAKE][i % 3], decision: i % 2 ? 'revoke' : 'recognize', issuedAt: t + 10 + i }))));
  check('concurrent burst: no request crashes and no event is lost (set membership is additive)', burst.every((r) => r.statusCode === 200 || r.statusCode === 409));
  const members = [...MAP.get('eco:cur:v1:' + SYNC).value];
  const folded = Economy.fold(members, SYNC, { address: OPERATOR, since: 0 }).recognized.map((e) => e.child).sort();
  check('server view equals an independent fold of the raw set', JSON.stringify(folded) === JSON.stringify((await recognized()).sort()));
}

// ================================================================================ impostor root
{
  const m = { token: FAKESYNC, operator: ATTACKER, basis: 'deployer', nonce: rnd(), expiry: nowSec() + 600 };
  await MP({ action: 'claim', ...m, signature: signDigest(ATTACKER, Market.digest('OperatorClaim', m)) });
  const r = await POST(curation({ root: FAKESYNC, child: SYNCAT, curator: ATTACKER }, ATTACKER));
  check('fake "SYNC" (same ticker, other contract): its operator cannot recognize children of the real $SYNC (422)', r.statusCode === 422 && J(r).code === 'not_connected', r.body);
  check('the impostor root ends with nothing recognized, and the real root is unaffected', (await recognized(FAKESYNC)).length === 0 && J(await GET({ view: 'economy', root: SYNC })).curator.address === OPERATOR);
}

// ================================================================================ soft cap never blocks a real revoke
{
  const key = 'eco:cur:v1:' + SYNC;
  const pad = Array.from({ length: Economy.MAX_EVENTS_PER_ROOT }, (_, i) => JSON.stringify({ v: 1, kind: 'curation', pad: i }));
  for (const p of pad) await store.sadd(key, p);
  const before = await recognized();
  check('cap setup: a child is currently recognized and the set is at the cap', before.length > 0 && MAP.get(key).value.size >= Economy.MAX_EVENTS_PER_ROOT, before.join(','));
  const target = before[0];
  let r = await POST(curation({ child: CATF1, decision: 'recognize', issuedAt: nowSec() + 60 }));
  check('at the cap a NEW recognition is refused (409 full)', r.statusCode === 409 && J(r).code === 'full', r.body);
  r = await POST(curation({ child: CATF1, decision: 'revoke', issuedAt: nowSec() + 60 }));
  check('at the cap a no-op revoke (not recognized) is refused, keeping the set bounded', r.statusCode === 409 && J(r).code === 'full', r.body);
  r = await POST(curation({ child: target, decision: 'revoke', issuedAt: nowSec() + 60 }));
  check('at the cap a revoke of a CURRENT recognition is still accepted (curator can always clean up)', r.statusCode === 200 && !(await recognized()).includes(target), r.body);
  for (const p of pad) MAP.get(key).value.delete(p);
}

// ================================================================================ operator change invalidates old recognitions
{
  await POST(curation({ child: SYNCAT, issuedAt: nowSec() + 90 }));
  const before = await recognized();
  check('before transfer: recognitions by the current operator are shown', before.length > 0);
  // Full, unchanged Marketplace flow: list → offer → accept → transfer-intent → transfer-accept.
  const listMsg = { token: SYNC, seller: OPERATOR, price: '1', currency: 'USD', termsHash: Market.hashJson(Market.normalizeTerms({ description: 'Operational control of $SYNC test' }).terms), nonce: rnd(), expiry: nowSec() + 86400 };
  let r = await MP({ action: 'list', ...listMsg, terms: { description: 'Operational control of $SYNC test' }, signature: signDigest(OPERATOR, Market.digest('Listing', listMsg)) });
  const listing = J(r).listing;
  check('setup: listing created', r.statusCode === 200, r.body);
  const offerMsg = { listingId: listing.id, termsHash: listing.termsHash, token: SYNC, buyer: BUYER, amount: '1', currency: 'USD', nonce: rnd(), expiry: nowSec() + 86400 };
  r = await MP({ action: 'offer', ...offerMsg, signature: signDigest(BUYER, Market.digest('Offer', offerMsg)) });
  const offer = J(r).offer;
  const decMsg = { offerId: offer.id, listingId: listing.id, seller: OPERATOR, decision: 'accept', nonce: rnd() };
  r = await MP({ action: 'offer-decision', ...decMsg, signature: signDigest(OPERATOR, Market.digest('OfferDecision', decMsg)) });
  const deal = J(r).deal;
  const intentMsg = { dealId: deal.id, token: SYNC, from: OPERATOR, to: BUYER, nonce: rnd(), expiry: nowSec() + 3600 };
  r = await MP({ action: 'transfer-intent', ...intentMsg, signature: signDigest(OPERATOR, Market.digest('TransferIntent', intentMsg)) });
  const intentHash = Market.digest('TransferIntent', intentMsg);
  const accMsg = { dealId: deal.id, token: SYNC, from: OPERATOR, to: BUYER, intentHash, nonce: rnd(), expiry: nowSec() + 3600 };
  r = await MP({ action: 'transfer-accept', ...accMsg, signature: signDigest(BUYER, Market.digest('TransferAccept', accMsg)) });
  check('setup: operator transferred to the buyer through the Marketplace', r.statusCode === 200 && J(r).passport.operator === BUYER, r.body);
  const g = J(await GET({ view: 'economy', root: SYNC }));
  check('after the operator change the curator is the new operator', g.curator.address === BUYER);
  check('after the operator change ALL earlier recognitions are inert (fail safe)', g.recognized.length === 0 && g.inert > 0, JSON.stringify(g).slice(0, 200));
  r = await POST(curation({ child: SYNCAT }));
  check('the former operator can no longer curate (403)', r.statusCode === 403, r.body);
  r = await POST(curation({ child: SYNCAT, curator: BUYER }, BUYER));
  check('the new operator can recognize again', r.statusCode === 200 && (await recognized()).includes(SYNCAT), r.body);
}

// ================================================================================ manual curator (git-reviewed file) + claim requests
{
  const grants = { version: 1, curators: [{ root: CASHCAT, curator: BUYER, since: '2026-01-01T00:00:00Z', basis: 'manual-review' }] };
  const d = { store, env: ON, grants };
  let g = J(await GET({ view: 'economy', root: CASHCAT }, d));
  check('manual grant: curator source is "manual"', g.curator && g.curator.source === 'manual' && g.curator.address === BUYER);
  let r = await POST(curation({ root: CASHCAT, child: CREATORLIVE, curator: BUYER }, BUYER), d);
  check('manual curator can recognize a child connected on-chain', r.statusCode === 200, r.body);
  check('without the grant, the same root has no curator (nothing is hard-coded)', J(await GET({ view: 'economy', root: CASHCAT })).curator === null);
  check('shipped syncnet-economies.json has no curators (no hard-coded $SYNC curator)', JSON.parse(fs.readFileSync(path.join(ROOT, 'syncnet-economies.json'), 'utf8')).curators.length === 0);

  const req = (fields, as) => { const m = { root: A.USDG.toLowerCase(), claimant: ATTACKER, evidenceUrl: 'https://example.org/proof', issuedAt: nowSec(), nonce: rnd(), ...fields }; return { action: 'claim-request', ...m, signature: signDigest(as || m.claimant, Economy.digest('EconomyClaimRequest', m)) }; };
  r = await POST(req({}));
  check('claim request on a non-PAR contract root is recorded as PENDING', r.statusCode === 200 && J(r).status === 'PENDING', r.body);
  g = J(await GET({ view: 'economy', root: A.USDG.toLowerCase() }));
  check('a pending request grants NOTHING (still no curator)', g.curator === null);
  r = await POST(curation({ root: A.USDG.toLowerCase(), child: SYNCAT, curator: ATTACKER }, ATTACKER));
  check('the requester cannot curate while pending', r.statusCode === 403, r.body);
  r = await POST(req({ root: SYNC }));
  check('claim request on a PAR root is refused (use the Passport claim)', r.statusCode === 409, r.body);
  r = await POST(req({ root: CASHCAT }), d);
  check('claim request on a root that already has a curator is refused', r.statusCode === 409 && J(r).code === 'has_curator', r.body);
  r = await POST(req({ evidenceUrl: 'javascript:alert(1)' }));
  check('claim request with a non-https evidence URL is refused', r.statusCode === 400, r.body);
  r = await POST(req({}, OPERATOR));
  check('claim request signed by another wallet is refused', r.statusCode === 401, r.body);
  // Privacy: pending requests (claimant, evidence URL, signature) are stored for maintainers but never served over HTTP.
  const USDG = A.USDG.toLowerCase(), SECRET = 'https://evidence.example.org/private-' + rnd().slice(2, 18);
  r = await POST(req({ evidenceUrl: SECRET, claimant: BUYER }, BUYER));
  check('privacy setup: a second pending request with a distinctive evidence URL is recorded', r.statusCode === 200 && J(r).status === 'PENDING' && !r.body.includes(SECRET), r.body);
  const stored = [...MAP.get('eco:req:v1:' + USDG).value];
  check('privacy: pending requests are kept in the durable store for maintainer inspection', stored.length === 2 && stored.some((m) => m.includes(SECRET)));
  const probes = [{ view: 'requests', root: USDG }, { view: 'REQUESTS', root: USDG }, { view: 'requests', root: USDG, admin: 'true', key: 'x' }, { view: 'economy', root: USDG }, { view: 'config' }, { root: USDG }];
  const replies = [];
  for (const q of probes) replies.push(await eco._handler({ ...ev('GET', { query: q }), headers: { 'x-nf-client-connection-ip': '198.18.0.9', 'x-syncnet-canary-key': 'guess', authorization: 'Bearer guess' } }, deps));
  check('privacy: an unauthenticated caller cannot read the requests view (400, no data)', replies[0].statusCode === 400 && replies[1].statusCode === 400 && replies[2].statusCode === 400 && !('requests' in J(replies[0])), replies[0].body);
  check('privacy: no public GET response contains a pending evidence URL, claimant signature or request list', replies.every((x) => !x.body.includes(SECRET) && !x.body.includes('evidence.example.org') && !x.body.includes('example.org/proof') && !/"requests"|evidenceUrl|claimant/.test(x.body)), replies.map((x) => x.body.slice(0, 80)).join(' | '));
}

// ================================================================================ chain / store outages, limits
{
  chain.rpcDown = true;
  let r = await POST(curation({ child: PONS_FAKE, curator: BUYER }, BUYER));
  check('chain down: recognition refused with 503 and no internal detail', r.statusCode === 503 && noLeak(r), r.body);
  chain.rpcDown = false;
  const broken = { ...store, smembers: async () => { throw new Error('upstash exploded at redis.js:12'); } };
  r = await GET({ view: 'economy', root: SYNC }, { store: broken, env: ON });
  check('store failure: 503 without leaking internals', r.statusCode === 503 && noLeak(r), r.body);
  const big = await eco._handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ action: 'curate', pad: 'x'.repeat(9000) }) }, deps);
  check('bodies above 8 KB are refused', big.statusCode === 400);
  let limited = null;
  for (let i = 0; i < 25; i++) { const x = await POST({ action: 'noop' }, deps, '192.0.2.77'); if (x.statusCode === 429) { limited = x; break; } }
  check('per-IP write rate limit applies', limited && limited.statusCode === 429);
}

// ================================================================================ wallet bucket is charged only after signature verification
{
  const { hashId } = require(path.join(ROOT, 'netlify/lib/log.js'));
  const CUR = J(await GET({ view: 'economy', root: SYNC })).curator.address; // the real, public curator address
  const bucketKey = () => `rl:eco-wallet:${hashId(CUR)}:${Math.floor(Date.now() / 3600000)}`;
  const used = () => Number((MAP.get(bucketKey()) || {}).value || 0);
  const c0 = used();
  const spoofed = [];
  for (let i = 0; i < 130; i++) {
    const body = i % 3 === 0
      ? curation({ child: SYNCAT, curator: CUR }, ATTACKER) // names the real curator, signed by the attacker
      : i % 3 === 1
        ? { ...curation({ child: SYNCAT, curator: CUR }, CUR), signature: '0x' + '11'.repeat(65) } // garbage signature
        : { action: 'claim-request', root: A.USDG.toLowerCase(), claimant: CUR, evidenceUrl: 'https://example.org/x', issuedAt: nowSec(), nonce: rnd(), signature: '0x' + '22'.repeat(65) };
    spoofed.push((await POST(body, deps, `100.64.${i >> 8}.${i & 255}`)).statusCode);
  }
  check('abuse: 130 unverified requests naming the real curator are all refused (401/409, never 429)', spoofed.every((c) => c === 401 || c === 409) && !spoofed.includes(429), [...new Set(spoofed)].join(','));
  check('abuse: they consumed NOTHING from the curator\u2019s wallet bucket', used() === c0, `before ${c0}, after ${used()}`);
  let r = await POST(curation({ child: SYNCAT, curator: CUR, decision: 'revoke', issuedAt: nowSec() + 120 }, CUR), deps, '100.65.0.1');
  check('abuse: the real curator can still curate afterwards', r.statusCode === 200, r.body);
  check('the wallet bucket is charged once for a verified request', used() === c0 + 1, `before ${c0}, after ${used()}`);
  while (used() < 120) await store.incrWindow(bucketKey(), 3600);
  r = await POST(curation({ child: SYNCAT, curator: CUR, decision: 'recognize', issuedAt: nowSec() + 130 }, CUR), deps, '100.65.0.2');
  check('the per-wallet limit still applies to VERIFIED requests (429 after 120/h)', r.statusCode === 429, r.body);
  const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/economies.js'), 'utf8');
  const cur = src.slice(src.indexOf('async function curate('), src.indexOf('async function claimRequest('));
  const req = src.slice(src.indexOf('async function claimRequest('));
  check('source order: walletLimited runs after verifySig in both write paths, never in the handler', cur.indexOf('walletLimited(') > cur.indexOf('verifySig(') && req.indexOf('walletLimited(') > req.indexOf('verifySig(') && !src.slice(src.indexOf('async function handler('), src.indexOf('async function curate(')).includes("'eco-wallet'"));
}

// ================================================================================ global claim bucket counts verified requests only
{
  const { hashId } = require(path.join(ROOT, 'netlify/lib/log.js'));
  const USDG = A.USDG.toLowerCase(), LEGIT = lc(A.SAFE_OWNER);
  const allKey = () => `rl:eco-claim-all:${hashId('all')}:${Math.floor(Date.now() / 3600000)}`;
  const used = () => Number((MAP.get(allKey()) || {}).value || 0);
  const claim = (claimant, as) => { const m = { root: USDG, claimant, evidenceUrl: 'https://example.org/proof', issuedAt: nowSec(), nonce: rnd() }; return { action: 'claim-request', ...m, signature: signDigest(as || claimant, Economy.digest('EconomyClaimRequest', m)) }; };
  const g0 = used();
  const codes = [];
  for (let i = 0; i < 60; i++) {
    const body = i % 2 ? claim(LEGIT, ATTACKER) : { ...claim(ATTACKER), signature: '0x' + '33'.repeat(65) }; // wrong signer / junk signature
    codes.push((await POST(body, deps, `100.66.${i >> 8}.${i & 255}`)).statusCode);
  }
  check('abuse: 60 invalid claim requests from 60 IPs are all refused with 401 (never 429)', codes.every((c) => c === 401), [...new Set(codes)].join(','));
  check('abuse: they consumed NOTHING from the global verified-claim bucket (50/h)', used() === g0, `before ${g0}, after ${used()}`);
  let r = await POST(claim(LEGIT), deps, '100.67.0.1');
  check('abuse: a subsequent legitimate signed claim request is still accepted (PENDING)', r.statusCode === 200 && J(r).status === 'PENDING', r.body);
  check('the global bucket is charged once for the verified request', used() === g0 + 1, `before ${g0}, after ${used()}`);
  while (used() < 50) await store.incrWindow(allKey(), 3600);
  r = await POST(claim(ATTACKER), deps, '100.67.0.2');
  check('the global limit still applies to VERIFIED claim requests (429 after 50/h)', r.statusCode === 429, r.body);
  const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/economies.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function claimRequest('));
  check('source order: eco-claim (per IP) before verifySig; eco-wallet and eco-claim-all only after it', fn.indexOf("'eco-claim'") < fn.indexOf('verifySig(') && fn.indexOf('walletLimited(') > fn.indexOf('verifySig(') && fn.indexOf("'eco-claim-all'") > fn.indexOf('verifySig('));
}

// ================================================================================ replaying PUBLIC signed events never consumes quota
{
  const { hashId } = require(path.join(ROOT, 'netlify/lib/log.js'));
  const CUR = lc(A.SAFE_OWNER); // a fresh curator (manual grant) so its wallet bucket starts clean
  const d = { store, env: ON, grants: { version: 1, curators: [{ root: CASHCAT, curator: CUR, since: '2026-01-01T00:00:00Z', basis: 'manual-review' }] } };
  const hour = () => Math.floor(Date.now() / 3600000);
  const walletUsed = (w) => Number((MAP.get(`rl:eco-wallet:${hashId(w)}:${hour()}`) || {}).value || 0);
  const t = nowSec(), u0 = walletUsed(CUR);
  let r = await POST(curation({ root: CASHCAT, child: CATF0, curator: CUR, issuedAt: t }, CUR), d, '100.70.0.1');
  check('replay setup: the curator recognizes a child (a new write)', r.statusCode === 200 && J(r).duplicate === false, r.body);
  const u1 = walletUsed(CUR);
  check('a genuinely new verified write consumes the wallet quota (+1)', u1 === u0 + 1, `before ${u0}, after ${u1}`);
  const pub = J(await GET({ view: 'economy', root: CASHCAT }, d)).recognized.find((e) => e.child === CATF0);
  const replay = { action: 'curate', root: CASHCAT, child: pub.child, curator: pub.curator, decision: pub.decision, issuedAt: pub.issuedAt, nonce: pub.nonce, signature: pub.signature };
  const codes = [];
  for (let i = 0; i < 150; i++) codes.push(J(await POST(replay, d, `100.71.${i >> 8}.${i & 255}`)));
  check('replay: the public signed event replayed 150x by a third party is a harmless duplicate every time (never 429)', codes.every((j) => j.ok === true && j.duplicate === true), JSON.stringify(codes.find((j) => !j.duplicate) || {}));
  check('replay: 150 duplicate replays consumed NOTHING from the curator wallet bucket', walletUsed(CUR) === u1, `before ${u1}, after ${walletUsed(CUR)}`);
  r = await POST(curation({ root: CASHCAT, child: CATF0, curator: CUR, decision: 'revoke', issuedAt: t + 1 }, CUR), d, '100.70.0.2');
  check('the curator\u2019s next new action (revoke) is accepted and charged once', r.statusCode === 200 && walletUsed(CUR) === u1 + 1, r.body);
  const stale = [];
  for (let i = 0; i < 40; i++) stale.push((await POST(replay, d, `100.72.0.${i}`)).statusCode);
  check('replay: the now-superseded public event is refused as stale (409) and consumes nothing', stale.every((c) => c === 409) && walletUsed(CUR) === u1 + 1, [...new Set(stale)].join(',') + ' used ' + walletUsed(CUR));
  r = await POST(curation({ root: CASHCAT, child: CATF0, curator: CUR, decision: 'recognize', issuedAt: t + 2 }, CUR), d, '100.70.0.3');
  const r2 = await POST(curation({ root: CASHCAT, child: CATF1, curator: CUR, decision: 'recognize', issuedAt: t + 2 }, CUR), d, '100.70.0.4');
  check('after all replays the real curator can still submit new valid actions', r.statusCode === 200 && r2.statusCode === 200 && (await recognized(CASHCAT, d)).includes(CATF0), r.body + r2.body);
  check('genuinely new verified writes keep consuming the wallet quota normally (+1 each)', walletUsed(CUR) === u1 + 3, 'used ' + walletUsed(CUR));

  // Claim requests: an exact stored duplicate writes nothing and consumes neither the wallet nor the global claim quota.
  const allKey = `rl:eco-claim-all:${hashId('all')}:${hour()}`;
  MAP.delete(allKey); // a new hour window for the global claim bucket (the previous section filled it on purpose)
  const allUsed = () => Number((MAP.get(allKey) || {}).value || 0);
  const m = { root: A.USDG.toLowerCase(), claimant: OPERATOR, evidenceUrl: 'https://example.org/claim', issuedAt: nowSec(), nonce: rnd() };
  const body = { action: 'claim-request', ...m, signature: signDigest(OPERATOR, Economy.digest('EconomyClaimRequest', m)) };
  r = await POST(body, deps, '100.73.0.1');
  const w1 = walletUsed(OPERATOR), g1 = allUsed();
  check('claim: a new signed claim request is stored and charges wallet + global quota once', r.statusCode === 200 && J(r).duplicate !== true && g1 === 1, r.body + ' global ' + g1);
  const dup = [];
  for (let i = 0; i < 20; i++) dup.push(J(await POST(body, deps, `100.74.0.${i}`)));
  check('claim: 20 replays of the stored request are duplicates that consume neither wallet nor global quota', dup.every((j) => j.duplicate === true) && walletUsed(OPERATOR) === w1 && allUsed() === g1, `wallet ${w1}->${walletUsed(OPERATOR)} global ${g1}->${allUsed()}`);
  const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/economies.js'), 'utf8');
  const cur = src.slice(src.indexOf('async function curate('), src.indexOf('async function claimRequest('));
  const req = src.slice(src.indexOf('async function claimRequest('));
  check('source order: quotas are charged only after the duplicate/stale/full checks', cur.indexOf('walletLimited(') > cur.indexOf("'full'") && cur.indexOf('walletLimited(') > cur.indexOf("'stale'") && cur.indexOf('walletLimited(') > cur.indexOf('duplicate: true') && req.indexOf('walletLimited(') > req.indexOf('duplicate: true') && req.indexOf("'eco-claim-all'") > req.indexOf("'full'"));
}

// ================================================================================ storage scope
{
  const added = [...MAP.keys()].filter((k) => !keysBefore.has(k));
  const ecoOwn = added.filter((k) => k.startsWith('eco:'));
  const otherNonMarketplace = added.filter((k) => !k.startsWith('eco:') && !k.startsWith('rl:') && !k.startsWith('mp:'));
  check('Economies wrote only eco:cur/eco:req sets', ecoOwn.every((k) => /^eco:(cur|req):v1:0x[0-9a-f]{40}$/.test(k) && MAP.get(k).type === 'set'), ecoOwn.join(','));
  check('no reg:* or other foreign keys were created', otherNonMarketplace.length === 0, otherNonMarketplace.join(','));
  const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/economies.js'), 'utf8');
  check('economies.js has no store.set/store.del and writes only with sadd', !/store\.(set|del)\(/.test(src) && /store\.sadd\(K\.curation/.test(src));
  check('economies.js references mp:* only for the read-only Passport key', (src.match(/`mp:/g) || []).length === 1 && /passport: \(token\) => `mp:passport:v1:\$\{token\}`/.test(src));
}

const passed = results.filter((r) => r.ok).length;
fs.writeFileSync(path.join(ROOT, 'tests/server/economies.results.json'), JSON.stringify({ passed, failed: failures, results }, null, 2));
console.log(`${passed}/${results.length} economies server checks passed`);
process.exit(failures ? 1 : 0);
