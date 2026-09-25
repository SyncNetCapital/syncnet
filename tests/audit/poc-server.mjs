// Audit PoCs for the Netlify functions — AFTER version for the V2.5 release candidate.
// Same attacks as tests/audit/before/poc-server.mjs (original V2.5 build: 11/11 reproduced). Node only; every
// outbound request is injected or mocked. Each line prints CONFIRMED when the ISSUE reproduces.
// Run: node tests/audit/poc-server.mjs
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const results = []; let reproduced = 0;
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail: String(detail).slice(0, 300) }); if (cond) reproduced++; console.log((cond ? 'CONFIRMED ' : 'not-reproduced ') + name + (detail ? ' :: ' + String(detail).slice(0, 220) : '')); };
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);
const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
const durableStore = () => ({ ...createStore({ map: new Map() }), durable: true, kind: 'test-durable' });
const ev = (ip, extra = {}) => ({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': ip }, ...extra });

// ---------------------------------------------------------------- site-check (L10)
{
  const sc = require(path.join(ROOT, 'netlify/functions/site-check.js'));
  // A fake https.request: asks the socket-level lookup it was given (as Node's net.connect would), then answers.
  const fakeRequest = (bodyChunks, onConnect) => (opts, cb) => {
    const req = new EventEmitter(); req.destroyed = false; req.destroy = () => { req.destroyed = true; }; req.end = () => {
      opts.lookup(opts.hostname, { all: false }, (err, address) => {
        if (onConnect) onConnect(err, address);
        const res = new EventEmitter(); res.statusCode = 200; res.headers = { 'content-type': 'application/json' }; res.destroy = () => { res.destroyed = true; };
        cb(res);
        let i = 0; const pump = () => { if (req.destroyed || res.destroyed) return; if (i >= bodyChunks.length) return res.emit('end'); res.emit('data', bodyChunks[i++]); setImmediate(pump); }; setImmediate(pump);
      });
    };
    return req;
  };
  // 1) DNS rebinding: first answer public, every later answer internal. The connection must use the validated address.
  let lookups = 0, connectedTo = '';
  const r1 = await sc._handler(ev('1.1.1.1', { queryStringParameters: { url: 'https://rebind-attacker.com/' } }), {
    store: durableStore(),
    lookup: async () => { lookups++; return lookups === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]; },
    request: fakeRequest([Buffer.from('{"token":"0x' + '1'.repeat(40) + '"}')], (e, a) => { connectedTo = a; }),
  });
  check('F-S4 site-check validates DNS once and then fetches by HOSTNAME (resolved address is not pinned → DNS-rebinding TOCTOU)', !(lookups === 1 && connectedTo === '93.184.216.34'), `lookups=${lookups} connected=${connectedTo} status=${r1.statusCode}`);
  // 2) 64 MB body: the stream must be cut at 16 KiB, not read to the end.
  let pulled = 0; const CHUNK = Buffer.alloc(1 << 20, 32);
  const chunks = new Proxy(new Array(64).fill(CHUNK), { get(t, k) { if (/^\d+$/.test(String(k))) pulled = Math.max(pulled, Number(k) + 1); return t[k]; } });
  const r2 = await sc._handler(ev('1.1.1.2', { queryStringParameters: { url: 'https://big-body.com/' } }), { store: durableStore(), lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: fakeRequest(chunks) });
  check('F-S4 a 64 MB body is fully downloaded before the 16 KB check', pulled === 64, 'MB read=' + pulled + ' reason=' + JSON.parse(r2.body).reason);
  // 3) IPv6 answers that map to internal IPv4 space.
  const passed = [];
  for (const a of ['64:ff9b::a00:1', '2002:a00:1::1', 'fec0::1', '::a00:1']) {
    const r = await sc._handler(ev('1.1.1.3', { queryStringParameters: { url: 'https://v6-answers.com/' } }), { store: durableStore(), lookup: async () => [{ address: a, family: 6 }], request: fakeRequest([Buffer.from('{}')]) });
    if (JSON.parse(r.body).found === true) passed.push(a);
  }
  check('F-S4 NAT64 / 6to4 / site-local / IPv4-compatible IPv6 answers pass the private-address filter', passed.length === 4, passed.join(', ') || 'all blocked');
}

// ---------------------------------------------------------------- ipfs-upload (H2, L12)
{
  const up = require(path.join(ROOT, 'netlify/functions/ipfs-upload.js'));
  const session = require(path.join(ROOT, 'netlify/lib/upload-session.js'));
  const env = { PINATA_JWT: 'test-jwt', SYNCNET_UPLOAD_KEY: 'k'.repeat(48), SYNCNET_PUBLIC_UPLOADS: 'true' };
  Object.assign(process.env, env);
  const pinned = [];
  const pinFetch = async (url, opt) => { const f = opt.body.get('file'); pinned.push(Buffer.from(await f.arrayBuffer())); return new Response(JSON.stringify({ IpfsHash: 'bafkreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', PinSize: 1 }), { status: 200 }); };
  const store = durableStore();
  const wallet = '0x' + 'ab'.repeat(20);
  const tok = session.issue({ scope: 'wallet', subject: wallet });
  const post = (buf, type, { withSession = true, fetchImpl = pinFetch, ip = '2.2.2.2' } = {}) => up._handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': ip, ...(withSession ? { 'x-syncnet-upload-session': tok } : {}) }, body: JSON.stringify({ name: 'x', type, data: buf.toString('base64') }) }, { env: process.env, store, fetch: fetchImpl });
  // PNG signature followed by arbitrary non-image content — anonymous, then with a valid wallet session.
  const poly = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('<html><script>alert(1)</script></html>' + 'Z'.repeat(2 * 1024 * 1024))]);
  const r0 = await post(poly, 'image/png', { withSession: false });
  const r1 = await post(poly, 'image/png');
  check('F-S2 public mode pins a 2 MB non-image payload that only starts with the PNG signature', r0.statusCode === 200 || r1.statusCode === 200 || pinned.some((b) => b.includes(Buffer.from('<script>'))), `anonymous=${r0.statusCode} wallet-session=${r1.statusCode} ${JSON.parse(r1.body).code || ''}`);
  // EXIF: a JPEG is not accepted server-side at all; a PNG carrying eXIf/tEXt chunks is re-encoded without them.
  const exif = fs.readFileSync(path.join(ROOT, 'tests/e2e/fixture-exif.jpg'));
  const r2 = await post(exif, 'image/jpeg');
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(32, 0); ihdr.writeUInt32BE(32, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(32 * (1 + 32 * 3), 0x55); for (let y = 0; y < 32; y++) raw[y * 97] = 0;
  const pngWithMeta = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('eXIf', Buffer.from('Exif\0\0MM GPS 48.85,2.35 camera serial 1234')), chunk('tEXt', Buffer.from('Comment\0secret author')), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  pinned.length = 0;
  const r3 = await post(pngWithMeta, 'image/png', { ip: '2.2.2.3' });
  check('F-S2 server pins a JPEG with its EXIF block unchanged (stripping is client-side only)', (r2.statusCode === 200) || pinned.some((b) => b.includes(Buffer.from('Exif')) || b.includes(Buffer.from('secret author'))), `jpeg=${r2.statusCode} png-with-meta=${r3.statusCode} pinned-clean=${pinned.length === 1 && !pinned[0].includes(Buffer.from('Exif'))}`);
  // Spam: 200 uploads in a row with one wallet session.
  let n = 0; for (let i = 0; i < 200; i++) { const r = await post(pngWithMeta, 'image/png', { ip: '2.2.3.' + (i % 250) }); if (r.statusCode === 200) n++; }
  check('F-S2 no rate limit or quota: 200 anonymous pins in a row accepted', n === 200, 'accepted=' + n + ' of 200 (plus 1 earlier)');
  // Error pass-through: provider details and exception text must never reach the browser.
  const store2 = durableStore(); const tok2 = session.issue({ scope: 'founder', subject: '-' });
  const post2 = (fetchImpl) => up._handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '3.3.3.3', 'x-syncnet-upload-session': tok2 }, body: JSON.stringify({ type: 'image/png', data: pngWithMeta.toString('base64') }) }, { env: process.env, store: store2, fetch: fetchImpl });
  const r4 = await post2(async () => new Response(JSON.stringify({ error: { reason: 'KEY_SCOPE', details: 'API key 3f9a… lacks pinFileToIPFS scope for account founder@example' } }), { status: 403 }));
  check('F-S3 upstream provider error text is returned verbatim to the browser', /API key 3f9a|founder@example|KEY_SCOPE/.test(r4.body), r4.statusCode + ' ' + r4.body);
  const r5 = await post2(async () => { throw new Error('getaddrinfo ENOTFOUND api.pinata.cloud'); });
  check('F-S3 internal exception text (provider hostname) is returned to the browser', /pinata|ENOTFOUND/i.test(r5.body), r5.statusCode + ' ' + r5.body);
  delete process.env.SYNCNET_PUBLIC_UPLOADS;
}

// ---------------------------------------------------------------- canary-auth + upload session (L9)
{
  const ca = require(path.join(ROOT, 'netlify/functions/canary-auth.js'));
  const us = require(path.join(ROOT, 'netlify/lib/upload-session.js'));
  process.env.SYNCNET_CANARY_KEY = 'correct-horse-battery-staple-0123456789abcdef';
  const store = durableStore();
  let denied = 0, limited = 0; const t0 = Date.now();
  for (let i = 0; i < 5000; i++) { const r = await ca._handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '4.4.4.4' }, body: JSON.stringify({ key: 'guess-' + i }) }, { store }); if (r.statusCode === 401) denied++; else if (r.statusCode === 429) limited++; }
  const ok = await ca._handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '4.4.4.4' }, body: JSON.stringify({ key: process.env.SYNCNET_CANARY_KEY }) }, { store });
  check('F-S1 5000 wrong guesses → 5000 plain 401s, no delay/lockout; the right key still works immediately', denied === 5000 && ok.statusCode === 200, `401=${denied} 429=${limited} right-key-after=${ok.statusCode} ${Date.now() - t0} ms`);
  const fresh = await ca._handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '5.5.5.5' }, body: JSON.stringify({ key: process.env.SYNCNET_CANARY_KEY }) }, { store: durableStore() });
  const tok = JSON.parse(fresh.body).uploadSession;
  const at39h = us.verify(tok, { scope: 'founder', now: Date.now() + 3.9 * 3600e3 });
  const prevEpoch = process.env.SYNCNET_SESSION_EPOCH; process.env.SYNCNET_SESSION_EPOCH = 'rotated-2'; const afterEpoch = us.verify(tok, { scope: 'founder' }); if (prevEpoch === undefined) delete process.env.SYNCNET_SESSION_EPOCH; else process.env.SYNCNET_SESSION_EPOCH = prevEpoch;
  check('F-S1 issued upload session is a bearer token valid for anyone for 4 h (not bound to client, not revocable except by rotating the secret)', Boolean(at39h) || Boolean(afterEpoch), `valid at +3.9h=${Boolean(at39h)} valid after epoch change=${Boolean(afterEpoch)} (founder TTL ${us.TTL.founder / 3600} h, scope-bound, revocable via SYNCNET_SESSION_EPOCH)`);
}

// ---------------------------------------------------------------- par-launches-all fan-out (L11)
{
  const pl = require(path.join(ROOT, 'netlify/functions/par-launches-all.js'));
  pl._resetCache && pl._resetCache();
  let upstream = 0;
  const fetchImpl = async (u) => { upstream++; return new Response(String(u).includes('/count') ? '{"count":5000}' : '[]', { status: 200 }); };
  const store = durableStore();
  const rq = await pl._handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '6.6.6.6' }, queryStringParameters: { cachebust: '1' }, rawQuery: 'cachebust=1' }, { fetch: fetchImpl, store });
  const afterBust = upstream;
  await pl._handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '6.6.6.6' }, queryStringParameters: {} }, { fetch: fetchImpl, store });
  const first = upstream;
  for (let i = 0; i < 5; i++) await pl._handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '6.6.6.' + i }, queryStringParameters: {} }, { fetch: fetchImpl, store });
  check('F-S5 one call to /api/par-launches-all fans out to 11 PAR API requests (query string ignored, cache-bustable URL)', afterBust > 0 || upstream > first, `query-string call → HTTP ${rq.statusCode}, upstream ${afterBust}; first plain call upstream ${first}; 5 more calls added ${upstream - first}`);
}

fs.writeFileSync(path.join(ROOT, 'tests/audit/poc-server.json'), JSON.stringify({ at: new Date().toISOString(), version: 'v2.5-rc', results }, null, 2));
process.stdout.write(`\n${reproduced}/${results.length} reproduced (expected after the fixes: 0)\n`);
