// Server endpoint abuse tests for the V2.5 RC functions: config (rollout gate), upload-auth, ipfs-upload, launch-guard,
// registry. No real network: every outbound request goes to in-process fakes (PAR mock chain + indexer from the e2e
// harness, a fake Pinata/pinning service, an in-memory durable store). Real network entry points are trapped.
// Run: node tests/server/rc-server.test.mjs  -> exit 1 on any failure; writes tests/server/rc-server.results.json
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { A, chain, resetChain, sendTx, Core, Chain, ROOT, signDigest } from '../e2e/harness.mjs';

const require = createRequire(import.meta.url);
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 300) + '\n'); } else process.stdout.write('ok   ' + name + '\n'); }
const logs = [];
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) { try { logs.push(JSON.parse(a[0])); } catch { logs.push(a[0]); } return; } orig(...a); })(console.log);
for (const n of ['https', 'http', 'net', 'tls']) { const m = require(n); for (const f of ['request', 'get', 'connect', 'createConnection']) if (typeof m[f] === 'function') m[f] = () => { throw new Error('real network access attempted: ' + n + '.' + f); }; }

const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
const durable = () => ({ ...createStore({ map: new Map() }), durable: true, kind: 'test-durable' });
const memory = () => createStore({ map: new Map() });
const session = require(path.join(ROOT, 'netlify/lib/upload-session.js'));
const fn = (n) => require(path.join(ROOT, 'netlify/functions', n + '.js'));
const J = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };
const ev = (method, { ip = '1.2.3.4', headers = {}, query = {}, body = null } = {}) => ({ httpMethod: method, headers: { 'x-nf-client-connection-ip': ip, ...headers }, queryStringParameters: query, body: body == null ? null : typeof body === 'string' ? body : JSON.stringify(body), isBase64Encoded: false });
const BASE_ENV = { PINATA_JWT: 'scoped-jwt', SYNCNET_UPLOAD_KEY: 'u'.repeat(48), SYNCNET_CANARY_KEY: 'c'.repeat(48), SYNCNET_LOG_SALT: 'rc-test' };
Object.assign(process.env, BASE_ENV);
const env = (extra = {}) => ({ ...BASE_ENV, ...extra });
const noStack = (body) => !/\n\s+at |Error:|ENOTFOUND|stack|\.js:\d/.test(body);

// ---- PNG helpers
function crc32(b) { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(data.length); c.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); }
function png(w, h, { extra = [], seed = 7 } = {}) { const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2; const raw = Buffer.alloc(h * (1 + w * 3), seed & 255); for (let y = 0; y < h; y++) raw[y * (1 + w * 3)] = 0; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), ...extra, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
const pinned = [], secondary = [];
const okPin = async (url, opt) => { if (String(url).startsWith('https://psa.test')) { secondary.push(JSON.parse(opt.body)); return new Response(JSON.stringify({ status: 'queued' }), { status: 202 }); } const f = opt.body.get('file'); pinned.push({ buf: Buffer.from(await f.arrayBuffer()), type: f.type, meta: JSON.parse(opt.body.get('pinataMetadata')), auth: opt.headers.Authorization }); return new Response(JSON.stringify({ IpfsHash: 'bafkreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', PinSize: 10 }), { status: 200 }); };

// =====================================================================================================================
// config: the server-side rollout gate
{
  const cfg = fn('config');
  const r0 = await cfg._handler(ev('GET'), { env: env(), store: durable() });
  const j0 = J(r0);
  check('config: everything public is CLOSED by default', r0.statusCode === 200 && j0.publicLaunch === false && j0.publicUploads === false && j0.registrySubmissions === false && j0.founderGate === true);
  const j1 = J(await cfg._handler(ev('GET'), { env: env({ SYNCNET_PUBLIC_LAUNCH: 'true', SYNCNET_PUBLIC_UPLOADS: 'true', SYNCNET_REGISTRY_SUBMISSIONS: 'true' }), store: durable() }));
  check('config: flags + durable store → public features open', j1.publicLaunch && j1.publicUploads && j1.registrySubmissions);
  const j2 = J(await cfg._handler(ev('GET'), { env: env({ SYNCNET_PUBLIC_LAUNCH: 'true', SYNCNET_PUBLIC_UPLOADS: 'true', SYNCNET_REGISTRY_SUBMISSIONS: 'true' }), store: memory() }));
  check('config: without a durable store every public feature stays closed', !j2.publicLaunch && !j2.publicUploads && !j2.registrySubmissions);
  const j3 = J(await cfg._handler(ev('GET'), { env: env({ SYNCNET_PUBLIC_LAUNCH: 'TRUE ', SYNCNET_PUBLIC_UPLOADS: '1', SYNCNET_REGISTRY_SUBMISSIONS: 'yes' }), store: durable() }));
  check('config: only the exact value "true" opens a flag ("1", "yes" do not)', j3.publicLaunch === true && !j3.publicUploads && !j3.registrySubmissions);
  const j4 = J(await cfg._handler(ev('GET'), { env: env({ SYNCNET_PUBLIC_UPLOADS: 'true', PINATA_JWT: '' }), store: durable() }));
  check('config: public uploads need PINATA_JWT', j4.publicUploads === false);
  const j5 = J(await cfg._handler(ev('GET'), { env: env({ SYNCNET_PUBLIC_UPLOADS: 'true', SYNCNET_UPLOAD_KEY: 'short' }), store: durable() }));
  check('config: public uploads need a ≥32-char session secret', j5.publicUploads === false);
  const j6 = J(await cfg._handler(ev('GET'), { env: env({ SYNCNET_PUBLIC_UPLOADS: 'true', SYNCNET_UPLOADS_DISABLED: 'true' }), store: durable() }));
  check('config: kill switch closes public uploads', j6.publicUploads === false);
  check('config: no configuration details leak', !/PINATA|UPSTASH|SYNCNET_|jwt|key/i.test(r0.body) && r0.headers['cache-control'] === 'no-store');
  check('config: GET only', (await cfg._handler(ev('POST'), {})).statusCode === 405);
  check('config: the query string cannot open anything', J(await cfg._handler(ev('GET', { query: { publicLaunch: 'true', live: 'canary' } }), { env: env(), store: durable() })).publicLaunch === false);
}

// =====================================================================================================================
// upload-auth: wallet-bound sessions for public uploads
{
  const ua = fn('upload-auth');
  process.env.SYNCNET_PUBLIC_UPLOADS = 'true';
  const E = env({ SYNCNET_PUBLIC_UPLOADS: 'true' });
  const closed = await ua._handler(ev('GET', { query: { address: A.WALLET } }), { env: env(), store: durable() });
  check('upload-auth: closed while public uploads are closed (403, generic)', closed.statusCode === 403 && /not open/.test(J(closed).error));
  const store = durable();
  const ch = await ua._handler(ev('GET', { query: { address: A.WALLET } }), { env: E, store });
  const msg = J(ch).message;
  check('upload-auth: challenge issued (wallet, purpose, expiry, nonce, MAC)', ch.statusCode === 200 && /^SyncNet upload session\nWallet: 0x[0-9a-f]{40}\nPurpose: image upload for a token launch\nExpires: \d+\nNonce: [0-9a-f]{16}\nCheck: [0-9a-f]{64}$/.test(msg), msg);
  const sig = signDigest(A.WALLET, Core.hashPersonalMessage(msg));
  const ok = await ua._handler(ev('POST', { body: { address: A.WALLET, message: msg, signature: sig } }), { env: E, store });
  const tok = J(ok).session;
  const v = session.verify(tok, { scope: 'wallet' });
  check('upload-auth: valid signature → 30-minute wallet session bound to that wallet', ok.statusCode === 200 && v && v.subject === A.WALLET && v.exp - Math.floor(Date.now() / 1000) <= 1800 && J(ok).ttl === 1800);
  check('upload-auth: the session cannot be used as a founder session', session.verify(tok, { scope: 'founder' }) === null);
  const replay = await ua._handler(ev('POST', { body: { address: A.WALLET, message: msg, signature: sig } }), { env: E, store });
  check('upload-auth: replaying the same challenge → 401', replay.statusCode === 401);
  const ch2 = J(await ua._handler(ev('GET', { query: { address: A.WALLET } }), { env: E, store })).message;
  const bad = await ua._handler(ev('POST', { body: { address: A.WALLET, message: ch2, signature: signDigest(A.WALLET2, Core.hashPersonalMessage(ch2)) } }), { env: E, store });
  check('upload-auth: signature by another wallet → 401 (generic)', bad.statusCode === 401 && noStack(bad.body));
  const tampered = ch2.replace(/Expires: \d+/, 'Expires: 9999999999');
  const t2 = await ua._handler(ev('POST', { body: { address: A.WALLET, message: tampered, signature: signDigest(A.WALLET, Core.hashPersonalMessage(tampered)) } }), { env: E, store });
  check('upload-auth: edited challenge (expiry changed, MAC broken) → 401', t2.statusCode === 401);
  const other = J(await ua._handler(ev('GET', { query: { address: A.WALLET2 } }), { env: E, store })).message;
  const t3 = await ua._handler(ev('POST', { body: { address: A.WALLET, message: other, signature: signDigest(A.WALLET, Core.hashPersonalMessage(other)) } }), { env: E, store });
  check('upload-auth: challenge for wallet B used by wallet A → 401', t3.statusCode === 401);
  const big = await ua._handler(ev('POST', { body: 'x'.repeat(20000) }), { env: E, store });
  check('upload-auth: oversized body → 400', big.statusCode === 400);
  // EIP-1271 contract wallet (mock SAFE approves signatures by SAFE_OWNER)
  const cs = durable();
  const chs = J(await ua._handler(ev('GET', { query: { address: A.SAFE } }), { env: E, store: cs })).message;
  const r1271 = await ua._handler(ev('POST', { body: { address: A.SAFE, message: chs, signature: signDigest(A.SAFE_OWNER, Core.hashPersonalMessage(chs)) } }), { env: E, store: cs });
  check('upload-auth: contract wallet accepted through EIP-1271', r1271.statusCode === 200 && session.verify(J(r1271).session, { scope: 'wallet' })?.subject === A.SAFE.toLowerCase());
  const chs2 = J(await ua._handler(ev('GET', { query: { address: A.SAFE } }), { env: E, store: cs })).message;
  const r1271b = await ua._handler(ev('POST', { body: { address: A.SAFE, message: chs2, signature: signDigest(A.ATTACKER, Core.hashPersonalMessage(chs2)) } }), { env: E, store: cs });
  check('upload-auth: contract wallet refuses a signature by a non-owner', r1271b.statusCode === 401);
  // rate limits
  const rs = durable(); let got429 = 0;
  for (let i = 0; i < 25; i++) { const r = await ua._handler(ev('GET', { ip: '5.5.5.5', query: { address: A.WALLET } }), { env: E, store: rs }); if (r.statusCode === 429) got429++; }
  check('upload-auth: 20 challenges / 10 min / IP, then 429 with retry-after', got429 === 5);
  const vs = durable(); let v429 = 0;
  for (let i = 0; i < 12; i++) { const r = await ua._handler(ev('POST', { ip: '6.6.6.6', body: { address: A.WALLET, message: 'x', signature: '0x' + '11'.repeat(65) } }), { env: E, store: vs }); if (r.statusCode === 429) v429++; }
  check('upload-auth: 10 verification attempts / 10 min / IP, then 429', v429 === 2);
  const qs = durable(); let q200 = 0, q429 = 0;
  for (let i = 0; i < 12; i++) { const m = J(await ua._handler(ev('GET', { ip: '7.7.' + i + '.1', query: { address: A.WALLET } }), { env: E, store: qs })).message; const r = await ua._handler(ev('POST', { ip: '7.7.' + i + '.1', body: { address: A.WALLET, message: m, signature: signDigest(A.WALLET, Core.hashPersonalMessage(m)) } }), { env: E, store: qs }); if (r.statusCode === 200) q200++; else if (r.statusCode === 429) q429++; }
  check('upload-auth: 10 sessions / day / wallet, then 429', q200 === 10 && q429 === 2, `200=${q200} 429=${q429}`);
  const failing = { ...durable(), async incrWindow() { throw new Error('store down'); } };
  check('upload-auth: store unavailable → fails closed (429)', (await ua._handler(ev('GET', { query: { address: A.WALLET } }), { env: E, store: failing })).statusCode === 429);
  check('upload-auth: logs never contain a raw wallet address or IP', !JSON.stringify(logs.filter((l) => l.fn === 'upload-auth')).includes(A.WALLET.slice(2)) && !JSON.stringify(logs.filter((l) => l.fn === 'upload-auth')).includes('1.2.3.4'));
  delete process.env.SYNCNET_PUBLIC_UPLOADS;
}

// =====================================================================================================================
// ipfs-upload: decode, re-encode, strip, rate-limit, generic errors
{
  const up = fn('ipfs-upload');
  const E = env({ SYNCNET_PUBLIC_UPLOADS: 'true', SYNCNET_PIN_SECONDARY_URL: 'https://psa.test', SYNCNET_PIN_SECONDARY_TOKEN: 't' });
  const founderTok = session.issue({ scope: 'founder', subject: '-' });
  const walletTok = session.issue({ scope: 'wallet', subject: A.WALLET });
  const post = (tok, type, buf, { store, e = E, ip = '8.8.8.8', f = okPin } = {}) => up._handler(ev('POST', { ip, headers: tok ? { 'x-syncnet-upload-session': tok } : {}, body: { type, data: buf.toString('base64') } }), { env: e, store, fetch: f });
  check('ipfs-upload: GET reports public=false when closed', J(await up._handler(ev('GET'), { env: env(), store: durable() })).public === false);
  check('ipfs-upload: GET reports public=true only with the gate open', J(await up._handler(ev('GET'), { env: E, store: durable() })).public === true);
  let s = durable();
  const anon = await post('', 'image/png', png(32, 32), { store: s });
  check('ipfs-upload: no session → 401 (no anonymous pinning)', anon.statusCode === 401 && pinned.length === 0);
  const wClosed = await post(walletTok, 'image/png', png(32, 32), { store: s, e: env() });
  check('ipfs-upload: wallet session refused while public uploads are closed', wClosed.statusCode === 401);
  const forged = await post(walletTok.replace(/.$/, (c) => (c === '0' ? '1' : '0')), 'image/png', png(32, 32), { store: s });
  check('ipfs-upload: forged session MAC → 401', forged.statusCode === 401);
  const meta = [chunk('tEXt', Buffer.from('Author\0Private Person')), chunk('eXIf', Buffer.from('Exif\0\0GPS 51.5,-0.12'))];
  const good = await post(walletTok, 'image/png', png(64, 48, { extra: meta }), { store: s });
  const pin = pinned.at(-1);
  check('ipfs-upload: valid PNG pinned (200) with cid/uri/type/size', good.statusCode === 200 && /^ipfs:\/\/bafkrei/.test(J(good).uri) && J(good).width === 64 && J(good).height === 48);
  check('ipfs-upload: pinned bytes are a re-encoded PNG without text/EXIF chunks', pin && pin.type === 'image/png' && !pin.buf.includes(Buffer.from('Private Person')) && !pin.buf.includes(Buffer.from('Exif')) && !/tEXt|eXIf|iTXt|zTXt/.test(pin.buf.toString('latin1')));
  check('ipfs-upload: Pinata called with the scoped server JWT, metadata carries only hashed subject', pin.auth === 'Bearer scoped-jwt' && pin.meta.keyvalues.source === 'wallet' && !JSON.stringify(pin.meta).includes(A.WALLET.slice(2)));
  check('ipfs-upload: redundant pin requested (pinning service API)', J(good).pins.secondary === 'queued' && secondary.at(-1).cid === J(good).cid);
  const cases = [
    ['PNG signature + HTML', 'image/png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('<script>alert(1)</script>')])],
    ['declared PNG, actually GIF', 'image/png', Buffer.from('GIF89a\x10\x00\x10\x00\x00\x00\x00;', 'latin1')],
    ['JPEG', 'image/jpeg', fs.readFileSync(path.join(ROOT, 'tests/e2e/fixture-exif.jpg'))],
    ['SVG', 'image/svg+xml', Buffer.from('<svg onload="alert(1)"/>')],
    ['too small (8x8)', 'image/png', png(8, 8)],
    ['too large (1100x10)', 'image/png', png(1100, 10)],
    ['truncated PNG', 'image/png', png(32, 32).subarray(0, 60)],
  ];
  const before = pinned.length;
  s = durable();
  const tokF = session.issue({ scope: 'founder', subject: '-' });
  for (const [label, type, buf] of cases) { const r = await post(tokF, type, buf, { store: s }); check(`ipfs-upload: ${label} → 400, user-safe message`, r.statusCode === 400 && noStack(r.body) && J(r).error, r.body); }
  const bomb = Buffer.concat([png(1, 1).subarray(0, 8), chunk('IHDR', (() => { const b = Buffer.alloc(13); b.writeUInt32BE(1000, 0); b.writeUInt32BE(1000, 4); b[8] = 8; b[9] = 6; return b; })()), chunk('IDAT', zlib.deflateSync(Buffer.alloc(1000 * 4001 * 4, 0))), chunk('IEND', Buffer.alloc(0))]);
  const rb = await post(tokF, 'image/png', bomb, { store: s });
  check('ipfs-upload: decompression bomb (IDAT inflates past the declared size) refused', rb.statusCode === 400, rb.body);
  const huge = Buffer.alloc(3 * 1024 * 1024 + 10, 1);
  const rh = await post(tokF, 'image/png', huge, { store: s });
  check('ipfs-upload: > 3 MB → 400 before decoding', rh.statusCode === 400);
  check('ipfs-upload: nothing invalid was pinned', pinned.length === before);
  const e1 = await post(tokF, 'image/png', png(32, 32), { store: durable(), f: async () => new Response(JSON.stringify({ error: { details: 'account founder@example.com key 3f9a lacks scope' } }), { status: 403 }) });
  check('ipfs-upload: Pinata error → generic 502 (no provider text)', e1.statusCode === 502 && !/founder@example|3f9a|scope/.test(e1.body));
  const e2 = await post(tokF, 'image/png', png(32, 32), { store: durable(), f: async () => { throw new Error('getaddrinfo ENOTFOUND api.pinata.cloud'); } });
  check('ipfs-upload: network exception → generic 502 (no hostname/stack)', e2.statusCode === 502 && noStack(e2.body) && !/pinata/i.test(e2.body));
  check('ipfs-upload: provider details are logged server-side', logs.some((l) => l.fn === 'ipfs-upload' && l.event === 'pin-failed' && /403|ENOTFOUND/.test(JSON.stringify(l.error))));
  const e3 = await post(tokF, 'image/png', png(32, 32), { store: durable(), e: env({ SYNCNET_PIN_SECONDARY_URL: 'https://psa.test', SYNCNET_PIN_SECONDARY_TOKEN: 't' }), f: async (u, o) => (String(u).startsWith('https://psa.test') ? new Response('{}', { status: 500 }) : okPin(u, o)) });
  check('ipfs-upload: secondary pin failure is reported, primary upload still succeeds', e3.statusCode === 200 && J(e3).pins.secondary === 'failed');
  const e4 = await post(tokF, 'image/png', png(32, 32), { store: durable(), e: env() });
  check('ipfs-upload: secondary pin not configured → reported as not-configured', e4.statusCode === 200 && J(e4).pins.secondary === 'not-configured');
  const ks = await post(tokF, 'image/png', png(32, 32), { store: durable(), e: env({ SYNCNET_UPLOADS_DISABLED: 'true' }) });
  check('ipfs-upload: kill switch → 503 even for founder sessions', ks.statusCode === 503);
  const nj = await post(tokF, 'image/png', png(32, 32), { store: durable(), e: env({ PINATA_JWT: '' }) });
  check('ipfs-upload: no PINATA_JWT → 503 generic', nj.statusCode === 503 && !/PINATA/.test(nj.body));
  const failing = { ...durable(), async incrWindow() { throw new Error('upstash down'); } };
  check('ipfs-upload: rate-limit store unavailable → fails closed (429)', (await post(tokF, 'image/png', png(32, 32), { store: failing })).statusCode === 429);
  // spam
  const ss = durable(); let w200 = 0, w429 = 0;
  for (let i = 0; i < 25; i++) { const r = await post(walletTok, 'image/png', png(20, 20, { seed: i }), { store: ss, ip: '9.' + i + '.0.1' }); if (r.statusCode === 200) w200++; else if (r.statusCode === 429) w429++; }
  check('ipfs-upload: one wallet → 5 per hour, then 429', w200 === 5 && w429 === 20, `200=${w200} 429=${w429}`);
  const fs2 = durable(); let f200 = 0, f429 = 0;
  for (let i = 0; i < 62; i++) { const r = await post(tokF, 'image/png', png(20, 20, { seed: i }), { store: fs2, ip: '10.9.9.' + (i % 200) }); if (r.statusCode === 200) f200++; else if (r.statusCode === 429) f429++; }
  check('ipfs-upload: founder session → 60 per hour, then 429', f200 === 60 && f429 === 2, `200=${f200} 429=${f429}`);
  check('ipfs-upload: logs hash identifiers (no raw wallet/IP)', !JSON.stringify(logs.filter((l) => l.fn === 'ipfs-upload')).includes(A.WALLET.slice(2)) && !JSON.stringify(logs.filter((l) => l.fn === 'ipfs-upload')).includes('8.8.8.8'));
}

// =====================================================================================================================
// launch-guard: duplicates + canonical impersonation
{
  const lg = fn('launch-guard');
  resetChain();
  const g = async (query, o = {}) => lg._handler(ev('GET', { query, ip: o.ip || '11.0.0.' + Math.floor(Math.random() * 250) }), { store: o.store || durable(), fetch: o.fetch });
  const coll = async (symbol, name = '') => J(await g({ deployer: A.OTHER_EOA, symbol, name })).canonical?.collision;
  check('launch-guard: $SYNC ticker collides with the canonical asset', await coll('SYNC'));
  check('launch-guard: full-width ＳＹＮＣ collides (NFKC)', await coll('ＳＹＮＣ'));
  check('launch-guard: SYNCAT collides; name "SyncNet" collides', await coll('SYNCAT') && await coll('ZZZ', 'SyncNet'));
  check('launch-guard: unrelated ticker does not collide', !(await coll('MOONCAT', 'Moon Cat')));
  const mine = J(await g({ deployer: A.WALLET, symbol: 'SYNC' }));
  check('launch-guard: same deployer + ticker found through the indexer', mine.ok && mine.sameDeployer.some((t) => t.token === A.SYNC.toLowerCase()));
  const pons = J(await g({ deployer: A.WALLET, symbol: 'PONS' }));
  check('launch-guard: other wallets using the same ticker are listed (warning, not a block)', pons.sameSymbol.length >= 2 && pons.sameDeployer.length === 0);
  check('launch-guard: invalid deployer → 400', (await g({ deployer: '0x12', symbol: 'ABC' })).statusCode === 400);
  check('launch-guard: invalid ticker → 400', (await g({ deployer: A.WALLET, symbol: '<script>' })).statusCode === 400);
  chain.indexerDown = true; lg._internals.cache.clear();
  const down = await g({ deployer: A.WALLET2, symbol: 'DOWNX' });
  check('launch-guard: indexer outage → 200 with indexer:"unavailable" (the builder then warns + checks on-chain)', down.statusCode === 200 && J(down).indexer === 'unavailable');
  chain.indexerDown = false;
  let upstream = 0; const counting = async (u, o) => { upstream++; return globalThis.fetch(u, o); };
  lg._internals.cache.clear();
  await g({ deployer: A.WALLET, symbol: 'CACHE1' }, { fetch: counting }); const first = upstream;
  await g({ deployer: A.WALLET.toUpperCase().replace('0X', '0x'), symbol: 'cache1' }, { fetch: counting });
  check('launch-guard: normalised cache key → the repeat call makes no upstream request', first === 2 && upstream === 2, `first=${first} total=${upstream}`);
  const rs = durable(); let l429 = 0;
  for (let i = 0; i < 33; i++) { const r = await g({ deployer: A.WALLET, symbol: 'RATE' }, { store: rs, ip: '12.0.0.1' }); if (r.statusCode === 429) l429++; }
  check('launch-guard: 30 requests / minute / IP, then 429', l429 === 3);
}

// =====================================================================================================================
// registry: only chain-verified provenance is published
{
  const rg = fn('registry');
  resetChain();
  // Build a real launch on the mock chain exactly like the builder would, then its proof.
  const intent = { schema: 'syncnet.intent.v1', chainId: 4663, operator: A.WALLET, name: 'Server Proof', symbol: 'SRVP', description: 'd', logo: 'ipfs://bafytestcid', twitter: '', website: '', creatorTaxBps: 100, feeMode: 'holders', creatorFeeRecipient: A.HOLDER.toLowerCase(), openingBuy: null, connections: [{ address: A.SYNC.toLowerCase(), symbol: 'SYNC', intent: '' }], nonce: '0x' + '42'.repeat(16), createdAt: new Date().toISOString() };
  const intentJson = JSON.stringify(intent);
  const recordHash = Core.recordHashOf(intentJson), salt = Core.intentSalt(recordHash);
  const token = Chain.ROBINHOOD.multiFactory && '0x' + Core.keccak256(Core.abiEncode(['address', 'bytes32'], [A.WALLET, salt])).slice(-40);
  const P = '(string,string,string,string,(string,string,string,string,string),address,uint16,bytes32,bytes32)';
  const data = Core.LAUNCH_SELECTORS.launchToken + Core.abiEncode([P, 'uint256', 'address[]'], [[intent.name, intent.symbol, intent.logo, intent.description, ['', '', '', '', ''], A.HOLDER.toLowerCase(), 100, '0x' + '00'.repeat(32), salt], 0n, [A.SYNC.toLowerCase()]]).slice(2);
  const hash = await sendTx({ from: A.WALLET, to: Chain.ROBINHOOD.multiFactory, data, value: '0x' + chain.fees.launchFee.toString(16), chainId: '0x1237' });
  const typed = Core.launchIntentTypedData({ chainId: 4663, operator: A.WALLET, token, recordHash, salt });
  const proof = { schema: 'syncnet.launch.proof.v2', chainId: 4663, token, deployer: A.WALLET, txHash: hash, recordHash, salt, intentJson, signature: { scheme: 'EIP-712', typedData: typed, signature: signDigest(A.WALLET, Core.hashTypedData(typed)) } };
  const E = env({ SYNCNET_REGISTRY_SUBMISSIONS: 'true' });
  const store = durable();
  const closed = await rg._handler(ev('POST', { body: { proof } }), { env: env(), store });
  check('registry: submissions closed by default (403)', closed.statusCode === 403);
  const noDur = await rg._handler(ev('POST', { body: { proof } }), { env: E, store: memory() });
  check('registry: submissions stay closed without a durable store', noDur.statusCode === 403);
  const ok = await rg._handler(ev('POST', { body: { proof } }), { env: E, store });
  check('registry: a proof that verifies on-chain is published', ok.statusCode === 200 && J(ok).status === 'VERIFIED', ok.body);
  const list = J(await rg._handler(ev('GET'), { env: E, store }));
  check('registry: GET lists it with the proof material for live re-verification', list.entries.length === 1 && list.entries[0].token === token && list.entries[0].proof.signature.signature === proof.signature.signature && list.entries[0].status === 'BUILT WITH SYNCNET · VERIFIED');
  const tamper = async (label, mutate, want = 422) => { const p = JSON.parse(JSON.stringify(proof)); mutate(p); const r = await rg._handler(ev('POST', { ip: '13.0.0.' + Math.floor(Math.random() * 250), body: { proof: p } }), { env: E, store }); check(`registry: rejects ${label} (${r.statusCode})`, r.statusCode === want, r.body.slice(0, 200)); };
  await tamper('an edited intent record', (p) => { const i = JSON.parse(p.intentJson); i.name = 'Other'; p.intentJson = JSON.stringify(i); });
  await tamper('a claim on another token', (p) => { p.token = A.SYNC.toLowerCase(); });
  await tamper('a signature by another wallet', (p) => { p.signature.signature = signDigest(A.WALLET2, Core.hashTypedData(p.signature.typedData)); });
  await tamper('a swapped deployer', (p) => { p.deployer = A.WALLET2; });
  await tamper('a transaction that is not this launch', (p) => { p.txHash = '0x' + 'cd'.repeat(32); });
  await tamper('typed data for another token', (p) => { p.signature.typedData.message.token = A.SYNC.toLowerCase(); p.signature.signature = signDigest(A.WALLET, Core.hashTypedData(p.signature.typedData)); });
  await tamper('a proof for another chain', (p) => { p.chainId = 1; }, 400);
  await tamper('a malformed proof', (p) => { delete p.salt; }, 400);
  const huge = await rg._handler(ev('POST', { body: { proof: { ...proof, intentJson: 'x'.repeat(70000) } } }), { env: E, store });
  check('registry: oversized proof → 400', huge.statusCode === 400);
  chain.rpcDown = true;
  const down = await rg._handler(ev('POST', { ip: '14.0.0.1', body: { proof } }), { env: E, store });
  check('registry: chain unreadable → 503 generic, nothing published', down.statusCode === 503 && noStack(down.body));
  chain.rpcDown = false;
  const rs = durable(); let r429 = 0;
  for (let i = 0; i < 12; i++) { const r = await rg._handler(ev('POST', { ip: '15.0.0.1', body: { proof: { schema: 'x' } } }), { env: E, store: rs }); if (r.statusCode === 429) r429++; }
  check('registry: 10 submissions / hour / IP, then 429', r429 === 2);
}

fs.writeFileSync(path.join(ROOT, 'tests/server/rc-server.results.json'), JSON.stringify({ at: new Date().toISOString(), failures, passed: results.filter((r) => r.ok).length, total: results.length, results }, null, 2));
process.stdout.write(`\n${results.filter((r) => r.ok).length}/${results.length} server checks passed\n`);
process.exit(failures ? 1 : 0);
