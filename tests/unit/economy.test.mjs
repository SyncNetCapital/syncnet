// Economies V0 — pure unit tests for lib/syncnet-economy.js: EIP-712 domain separation, message validation,
// canonical members, the order-independent fold, and derived membership (address match, never ticker).
// No network. Run: node tests/unit/economy.test.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const Core = require(path.join(ROOT, 'lib/syncnet-core.js'));
const Eco = require(path.join(ROOT, 'lib/syncnet-economy.js'));
const Market = require(path.join(ROOT, 'lib/syncnet-market.js'));

const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 300) }); if (!cond) { failures++; console.log('FAIL', name, '::', String(detail).slice(0, 300)); } }

const KEY = '0x' + '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const KEY2 = '0x' + '11'.repeat(32);
const secp = Core._internal.secp256k1;
const CURATOR = secp.privateKeyToAddress(KEY).toLowerCase();
const OTHER = secp.privateKeyToAddress(KEY2).toLowerCase();
const ROOT_T = '0x6368e007b9f0b941560ed1f3bceb20247f5eca37';
const C1 = '0x1111111111111111111111111111111111111111';
const C2 = '0x2222222222222222222222222222222222222222';
const FAKE = '0x9999999999999999999999999999999999999999';
const n = (i) => '0x' + String(i).padStart(64, '0');
const T = 1_790_000_000;
function ev(child, decision, issuedAt, i, key = KEY, curator = CURATOR, root = ROOT_T) {
  const message = { root, child, curator, decision, issuedAt, nonce: n(i) };
  return Eco.member('EconomyCuration', message, secp.sign(Eco.digest('EconomyCuration', message), key));
}
const cur = { address: CURATOR, since: T - 1000 };

// ---------------------------------------------------------------- domain + typed data
{
  check('domain is "SyncNet Economies" v1 on chain 4663', Eco.DOMAIN.name === 'SyncNet Economies' && Eco.DOMAIN.version === '1' && Eco.DOMAIN.chainId === 4663);
  check('domain differs from the Marketplace domain', Eco.DOMAIN.name !== Market.DOMAIN.name);
  const m = { root: ROOT_T, child: C1, curator: CURATOR, decision: 'recognize', issuedAt: T, nonce: n(1) };
  const d = Eco.digest('EconomyCuration', m);
  const asMarket = Core.hashTypedData({ ...Eco.typedData('EconomyCuration', m), domain: { ...Market.DOMAIN } });
  check('the same struct under the Marketplace domain has a different digest (no cross-domain replay)', d !== asMarket);
  const otherChain = Core.hashTypedData({ ...Eco.typedData('EconomyCuration', m), domain: { ...Eco.DOMAIN, chainId: 1 } });
  check('a different chainId gives a different digest', d !== otherChain);
  check('digest is deterministic', d === Eco.digest('EconomyCuration', { ...m }));
  check('decision is part of the digest', d !== Eco.digest('EconomyCuration', { ...m, decision: 'revoke' }));
  check('typedData lists exactly the six signed fields', Eco.TYPES.EconomyCuration.map((f) => f.name).join(',') === 'root,child,curator,decision,issuedAt,nonce');
  let threw = false; try { Eco.typedData('Listing', {}); } catch { threw = true; }
  check('unknown structures are refused', threw);
}

// ---------------------------------------------------------------- validation
{
  const ok = { root: ROOT_T.toUpperCase().replace('0X', '0x'), child: C1, curator: CURATOR, decision: 'recognize', issuedAt: T, nonce: n(1) };
  const v = Eco.curationMessage(ok);
  check('valid curation message normalizes addresses to lowercase', v.ok && v.message.root === ROOT_T);
  check('issuedAt accepts a decimal string', Eco.curationMessage({ ...ok, issuedAt: String(T) }).ok);
  for (const [f, val] of [['root', '0x0000000000000000000000000000000000000000'], ['root', 'SYNC'], ['child', ROOT_T], ['child', 'nope'], ['curator', ''], ['decision', 'official'], ['decision', 'RECOGNIZE'], ['issuedAt', -1], ['issuedAt', 1.5], ['issuedAt', '1e9'], ['nonce', '0x12']]) {
    const r = Eco.curationMessage({ ...ok, [f]: val });
    check(`curation: ${f}=${JSON.stringify(val)} is refused`, !r.ok && r.field === f, JSON.stringify(r));
  }
  check('bare "official" is not a decision (recognize/revoke only)', !Eco.DECISIONS.includes('official'));
  const good = 'https://example.org/proof';
  check('evidence URL: https accepted', Eco.checkEvidenceUrl(good) === good);
  for (const bad of ['http://example.org', 'javascript:alert(1)', 'https://user:pw@example.org/', 'https://localhost/x', 'https://ex ample.org', 'https://example.org/\u202e', 'https://example.org/' + 'a'.repeat(200), '']) check('evidence URL refused: ' + JSON.stringify(bad).slice(0, 40), Eco.checkEvidenceUrl(bad) === null);
  const cr = Eco.claimRequestMessage({ root: ROOT_T, claimant: CURATOR, evidenceUrl: good, issuedAt: T, nonce: n(2) });
  check('valid claim request', cr.ok && cr.message.evidenceUrl === good);
  check('claim request with a non-normalized URL is refused (signed string must equal the stored string)', !Eco.claimRequestMessage({ root: ROOT_T, claimant: CURATOR, evidenceUrl: 'https://EXAMPLE.org', issuedAt: T, nonce: n(2) }).ok);
}

// ---------------------------------------------------------------- members
{
  const a = ev(C1, 'recognize', T, 1);
  const p = Eco.parseMember(a, 'EconomyCuration');
  check('member round-trips and its id is the EIP-712 digest', p && p.id === Eco.digest('EconomyCuration', { root: ROOT_T, child: C1, curator: CURATOR, decision: 'recognize', issuedAt: T, nonce: n(1) }));
  check('identical events produce byte-identical members (SADD dedupe)', a === ev(C1, 'recognize', T, 1));
  check('member keys are canonical (sorted)', a.indexOf('"child"') < a.indexOf('"curator"') && a.indexOf('"curator"') < a.indexOf('"decision"'));
  const o = JSON.parse(a);
  check('tampered decision is rejected (id no longer matches)', Eco.parseMember(JSON.stringify({ ...o, decision: 'revoke' }), 'EconomyCuration') === null);
  check('tampered id is rejected', Eco.parseMember(JSON.stringify({ ...o, id: n(9) }), 'EconomyCuration') === null);
  check('wrong kind is rejected', Eco.parseMember(a, 'EconomyClaimRequest') === null);
  check('garbage is rejected', Eco.parseMember('{', 'EconomyCuration') === null && Eco.parseMember(null, 'EconomyCuration') === null && Eco.parseMember('{"v":2}', 'EconomyCuration') === null);
}

// ---------------------------------------------------------------- fold
{
  const r1 = ev(C1, 'recognize', T, 1), v1 = ev(C1, 'revoke', T + 10, 2), r2 = ev(C2, 'recognize', T + 5, 3);
  let f = Eco.fold([r1, r2], ROOT_T, cur);
  check('fold: two recognized children', f.recognized.length === 2 && f.recognized[0].child === C2);
  f = Eco.fold([r1, v1, r2], ROOT_T, cur);
  check('fold: a later revoke removes the recognition', f.recognized.length === 1 && f.recognized[0].child === C2);
  const perms = [[r1, v1, r2], [v1, r1, r2], [r2, v1, r1], [v1, r2, r1]];
  check('fold is independent of storage order', perms.every((p) => JSON.stringify(Eco.fold(p, ROOT_T, cur).recognized.map((e) => e.id)) === JSON.stringify(f.recognized.map((e) => e.id))));
  const again = ev(C1, 'recognize', T + 20, 4);
  check('fold: re-recognition after a revoke counts', Eco.fold([r1, v1, again, r2], ROOT_T, cur).recognized.some((e) => e.child === C1));
  check('fold: replaying the OLD recognition cannot override the newer revoke', !Eco.fold([r1, v1, r1, r1], ROOT_T, cur).recognized.some((e) => e.child === C1));
  const tieA = ev(C1, 'recognize', T + 30, 5), tieB = ev(C1, 'revoke', T + 30, 6);
  const idA = JSON.parse(tieA).id, idB = JSON.parse(tieB).id;
  const tieWinner = idA > idB ? 'recognize' : 'revoke';
  const tie1 = Eco.latestByChild([tieA, tieB], ROOT_T, cur).latest.get(C1).decision, tie2 = Eco.latestByChild([tieB, tieA], ROOT_T, cur).latest.get(C1).decision;
  check('fold: same-second tie broken deterministically by id', tie1 === tieWinner && tie2 === tieWinner);
  const byOther = ev(C1, 'recognize', T, 7, KEY2, OTHER);
  f = Eco.fold([byOther], ROOT_T, cur);
  check('fold: events by a non-current curator are inert', f.recognized.length === 0 && f.ignored === 1);
  check('fold: after a curator change, the old curator’s recognitions no longer count', Eco.fold([r1, r2], ROOT_T, { address: OTHER, since: T - 1000 }).recognized.length === 0);
  check('fold: events signed before the curatorship began are inert', Eco.fold([r1], ROOT_T, { address: CURATOR, since: T + Eco.MAX_SKEW + 1 }).recognized.length === 0);
  check('fold: events within the clock-skew tolerance of "since" count', Eco.fold([r1], ROOT_T, { address: CURATOR, since: T + Eco.MAX_SKEW }).recognized.length === 1);
  check('fold: no curator → nothing recognized', Eco.fold([r1, r2], ROOT_T, null).recognized.length === 0);
  check('fold: events filed under another root are ignored', Eco.fold([ev(C1, 'recognize', T, 8, KEY, CURATOR, FAKE)], ROOT_T, cur).recognized.length === 0);
  const dupSig = JSON.stringify({ ...JSON.parse(r1), signature: '0x' + 'ab'.repeat(65) });
  check('fold: the same id stored twice (different signature bytes) counts once', Eco.fold([r1, dupSig], ROOT_T, cur).total === 1);
}

// ---------------------------------------------------------------- derived membership
{
  const rows = [
    { token: C1, symbol: 'ONE', markets: [{ pairToken: ROOT_T, quoteSymbol: 'SYNC' }] },
    { token: C2.toUpperCase().replace('0X', '0x'), symbol: 'TWO', markets: [{ pairToken: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' }, { pairToken: ROOT_T.toUpperCase().replace('0X', '0x') }] },
    { token: '0x3333333333333333333333333333333333333333', symbol: 'SCAM', markets: [{ pairToken: FAKE, quoteSymbol: 'SYNC' }] },
    { tokenAddress: '0x4444444444444444444444444444444444444444', pairToken: ROOT_T },
    { token: ROOT_T, markets: [{ pairToken: ROOT_T }] },
    { token: C1, markets: [{ pairToken: ROOT_T }] },
    null, 'x', { token: 'bad', markets: [{ pairToken: ROOT_T }] },
  ];
  const kids = Eco.childrenOf(rows, ROOT_T).map((c) => c.address);
  check('children: address match across single/multi-market rows, case-insensitive', kids.join(',') === [C1, C2, '0x4444444444444444444444444444444444444444'].join(','), kids.join(','));
  check('children: a project paired with a FAKE token using the same ticker is NOT a child', !kids.includes('0x3333333333333333333333333333333333333333'));
  check('children: the root itself and duplicates are excluded', !kids.includes(ROOT_T) && kids.filter((k) => k === C1).length === 1);
  check('children: invalid root → none', Eco.childrenOf(rows, 'SYNC').length === 0 && Eco.childrenOf(rows, '0x0000000000000000000000000000000000000000').length === 0);
  const rec = [Eco.parseMember(ev(C1, 'recognize', T, 1), 'EconomyCuration'), Eco.parseMember(ev('0x7777777777777777777777777777777777777777', 'recognize', T, 2), 'EconomyCuration')];
  const j = Eco.join(Eco.childrenOf(rows, ROOT_T), rec);
  check('join: recognized + indexed child is attached to its connected row', j.connected.find((c) => c.address === C1).recognition.child === C1);
  check('join: recognized child missing from the index is reported as outsideIndex, not as connected', j.outsideIndex.length === 1 && j.outsideIndex[0].address === '0x7777777777777777777777777777777777777777' && !j.connected.some((c) => c.address === '0x7777777777777777777777777777777777777777'));
  check('labels: PARENT-RECOGNIZED / RECOGNIZED BY $X OPERATOR / outside-index wording', Eco.LABELS.recognized === 'PARENT-RECOGNIZED' && Eco.LABELS.recognizedBy('CASHCAT', 'passport') === 'RECOGNIZED BY $CASHCAT OPERATOR' && /OUTSIDE CURRENT INDEX WINDOW/.test(Eco.LABELS.outsideIndex) && !/OFFICIAL/.test(JSON.stringify(Object.values(Eco.LABELS).map(String))));
}

const passed = results.filter((r) => r.ok).length;
fs.writeFileSync(path.join(ROOT, 'tests/unit/economy.results.json'), JSON.stringify({ passed, failed: failures, results }, null, 2));
console.log(`${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
