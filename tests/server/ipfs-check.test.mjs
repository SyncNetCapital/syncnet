// IPFS hotfix: /api/ipfs-check, the server-side (blocking) half of the builder's metadata preflight.
// Cases 1-7 of the hotfix brief, plus redirects, strict timeout, caching, rate limit and response hygiene.
// No real network: every gateway request goes to the fakes below; a real fetch or socket would throw.
// Run: node tests/server/ipfs-check.test.mjs  -> exit 1 on any failure; writes tests/server/ipfs-check.results.json
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 300) + '\n'); } else process.stdout.write('ok   ' + name + '\n'); }
const logs = [];
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) { try { logs.push(JSON.parse(a[0])); } catch { logs.push(a[0]); } return; } orig(...a); })(console.log);
globalThis.fetch = () => { throw new Error('real network access attempted: fetch'); };
for (const n of ['https', 'http', 'net', 'tls']) { const m = require(n); for (const f of ['request', 'get', 'connect', 'createConnection']) if (typeof m[f] === 'function') m[f] = () => { throw new Error('real network access attempted: ' + n + '.' + f); }; }

const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
const mod = require(path.join(ROOT, 'netlify/functions/ipfs-check.js'));
const I = mod._internals;
const J = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };

// ---- fixtures: real CIDs and real image bytes
function cidFor(bytes, codec = 0x55) {
  const b = Buffer.concat([Buffer.from([0x01, codec, 0x12, 0x20]), crypto.createHash('sha256').update(bytes).digest()]);
  const ABC = 'abcdefghijklmnopqrstuvwxyz234567'; let bits = 0, val = 0, out = 'b';
  for (const x of b) { val = (val << 8) | x; bits += 8; while (bits >= 5) { bits -= 5; out += ABC[(val >> bits) & 31]; } val &= (1 << bits) - 1; }
  return bits ? out + ABC[(val << (5 - bits)) & 31] : out;
}
function crc32(b) { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(data.length); c.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); }
function png(w, h, fill = 7) { const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2; const raw = Buffer.alloc(h * (1 + w * 3), fill); for (let y = 0; y < h; y++) raw[y * (1 + w * 3)] = 0; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
const PNG = png(64, 64);
const JPEG = fs.readFileSync(path.join(ROOT, 'tests/e2e/fixture-exif.jpg'));
const WEBP_LOSSLESS = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
const WEBP_LOSSY = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
const CID = cidFor(PNG);
const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const ALLOWED = /^(gateway\.pinata\.cloud|ipfs\.io|dweb\.link|[a-z0-9]+\.ipfs\.dweb\.link)$/;

// ---- fake gateways
const calls = [];
const image = (bytes, type = 'image/png') => () => new Response(bytes, { status: 200, headers: { 'content-type': type, 'content-length': String(bytes.length) } });
const status = (code, body = 'upstream failure: SECRET-UPSTREAM-TRACE at gateway.internal:4001') => () => new Response(body, { status: code, headers: { 'content-type': 'text/plain' } });
const html = () => () => new Response('<!doctype html><html><body><script>alert(1)</script>Not found</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
const hang = () => (url, init) => new Promise((_, reject) => { const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })); if (init.signal.aborted) fail(); else init.signal.addEventListener('abort', fail); });
const netError = () => () => Promise.reject(new TypeError('fetch failed: getaddrinfo ENOTFOUND gateway.internal'));
const redirect = (location, code = 302) => () => new Response(null, { status: code, headers: { location } });
const subdomainRedirect = () => (url) => { const u = new URL(url); const m = u.pathname.match(/^\/ipfs\/([A-Za-z0-9]+)(\/.*)?$/); return new Response(null, { status: 301, headers: { location: `https://${m[1].toLowerCase()}.ipfs.dweb.link${m[2] || '/'}` } }); };
function counted(total, chunkSize, headers = {}) {
  const meter = { pulled: 0 };
  const make = () => new Response(new ReadableStream({ pull(ctl) { if (meter.pulled >= total) { ctl.close(); return; } const n = Math.min(chunkSize, total - meter.pulled); meter.pulled += n; ctl.enqueue(new Uint8Array(n).fill(0x41)); } }), { status: 200, headers: { 'content-type': 'image/png', ...headers } });
  return { meter, route: () => make };
}
/** spec: {'ipfs.io': handlerFactoryResult, 'dweb.link': ..., sub: ... (for *.ipfs.dweb.link)} */
function gateways(spec) {
  return async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url, host: u.hostname, method: init.method, redirect: init.redirect, accept: init.headers && init.headers.accept, ua: init.headers && init.headers['user-agent'] });
    if (!ALLOWED.test(u.hostname)) throw new Error('TEST: request to a host outside the gateway allow-list: ' + u.hostname);
    const key = u.hostname === 'gateway.pinata.cloud' ? 'pinata' : u.hostname === 'ipfs.io' ? 'ipfs.io' : u.hostname === 'dweb.link' ? 'dweb.link' : 'sub';
    const h = spec[key];
    if (!h) return new Response('not configured', { status: 404 });
    return h(url, init);
  };
}
let ipSeq = 0;
async function run(uri, spec, { ip, method = 'GET', store, keepCache = false } = {}) {
  if (!keepCache) I.passed.clear();
  const event = { httpMethod: method, headers: { 'x-nf-client-connection-ip': ip || `198.51.100.${(ipSeq++ % 250) + 1}` }, queryStringParameters: uri === undefined ? {} : { uri }, body: null };
  const before = calls.length;
  const t0 = Date.now();
  const res = await mod._handler(event, { fetch: gateways(spec || {}), store: store || createStore({ map: new Map() }) });
  return { res, body: J(res), ms: Date.now() - t0, requests: calls.slice(before) };
}
const passes = (r) => r.res.statusCode === 200 && r.body.ok === true && Object.keys(r.body).join() === 'ok';
const blocks = (r, reason) => r.body.ok === false && (!reason || r.body.reason === reason);

// =====================================================================================================================
// 1. valid pinned image reachable through a gateway -> PASS
{
  let r = await run('ipfs://' + CID, { 'ipfs.io': image(PNG), 'dweb.link': hang() });
  check('1a PASS: pinned PNG served by ipfs.io -> {ok:true}', passes(r), JSON.stringify(r.body));
  check('1a the gateway request is a GET, redirect: manual, with an image Accept header and a SyncNet user agent', r.requests.some((c) => c.host === 'ipfs.io' && c.method === 'GET' && c.redirect === 'manual' && /image\/png/.test(c.accept) && /SyncNet/.test(c.ua)), JSON.stringify(r.requests[0]));
  check('1a request goes to https://ipfs.io/ipfs/<cid> exactly', r.requests.some((c) => c.url === 'https://ipfs.io/ipfs/' + CID));
  r = await run('ipfs://' + CID, { 'ipfs.io': status(404), 'dweb.link': subdomainRedirect(), sub: image(PNG) });
  check('1b PASS: dweb.link path request -> 301 to its <cid>.ipfs.dweb.link subdomain gateway -> PNG', passes(r) && r.requests.some((c) => c.host === CID + '.ipfs.dweb.link'), JSON.stringify(r.requests.map((c) => c.url)));
  for (const [label, bytes, type] of [['JPEG', JPEG, 'image/jpeg'], ['WebP lossless', WEBP_LOSSLESS, 'image/webp'], ['WebP lossy', WEBP_LOSSY, 'image/webp'], ['GIF', GIF, 'image/gif']]) {
    r = await run('ipfs://' + cidFor(bytes), { 'ipfs.io': image(bytes, type), 'dweb.link': status(502) });
    check(`1c PASS: ${label} image`, passes(r), JSON.stringify(r.body));
  }
  r = await run('ipfs://' + CID + '/assets/logo.png', { 'ipfs.io': image(PNG), 'dweb.link': status(502) });
  check('1d PASS: a plain path inside the CID is kept (https://ipfs.io/ipfs/<cid>/assets/logo.png)', passes(r) && r.requests.some((c) => c.url === `https://ipfs.io/ipfs/${CID}/assets/logo.png`));
  r = await run(CID_V0, { 'ipfs.io': image(PNG), 'dweb.link': status(502) });
  check('1e PASS: bare CIDv0 (Qm…) accepted', passes(r));
  r = await run('ipfs://' + cidFor(PNG, 0x70), { 'ipfs.io': image(PNG), 'dweb.link': status(502) });
  check('1f PASS: CIDv1 dag-pb (bafybei…) accepted', passes(r));
}

// 2. one gateway fails, the second succeeds -> PASS
{
  let r = await run('ipfs://' + CID, { 'ipfs.io': status(504), 'dweb.link': subdomainRedirect(), sub: image(PNG) });
  check('2a PASS: ipfs.io 504, dweb.link serves the image', passes(r), JSON.stringify(r.body));
  r = await run('ipfs://' + CID, { 'ipfs.io': image(PNG), 'dweb.link': hang() });
  check('2b PASS: dweb.link hangs, ipfs.io answers; the check does not wait for the slow gateway', passes(r) && r.ms < 2000, r.ms + ' ms');
  r = await run('ipfs://' + CID, { 'ipfs.io': netError(), 'dweb.link': subdomainRedirect(), sub: image(PNG) });
  check('2c PASS: ipfs.io network error, dweb.link serves the image', passes(r));
  r = await run('ipfs://' + CID, { 'ipfs.io': html(), 'dweb.link': subdomainRedirect(), sub: image(PNG) });
  check('2d PASS: ipfs.io returns an HTML page, dweb.link returns the real image', passes(r));
  r = await run('ipfs://' + CID, { 'ipfs.io': hang(), 'dweb.link': subdomainRedirect(), sub: image(PNG) });
  check('2e PASS: ipfs.io hangs, dweb.link answers quickly', passes(r) && r.ms < 2000, r.ms + ' ms');
}

// 2P. follow-up hotfix: public gateways rate-limit (429), Pinata's gateway serves the pin -> PASS
{
  const r429 = () => () => new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '60' } });
  let r = await run('ipfs://' + CID, { pinata: image(PNG), 'ipfs.io': r429(), 'dweb.link': r429() });
  check('2P PASS: ipfs.io=429 + dweb.link=429 + gateway.pinata.cloud=200 (valid PNG) -> {ok:true}', passes(r), JSON.stringify(r.body));
  check('2P Pinata is tried, at https://gateway.pinata.cloud/ipfs/<cid>, with GET and redirect: manual', r.requests.some((c) => c.url === 'https://gateway.pinata.cloud/ipfs/' + CID && c.method === 'GET' && c.redirect === 'manual'), JSON.stringify(r.requests.map((c) => c.url)));
  r = await run('ipfs://' + CID, { pinata: r429(), 'ipfs.io': r429(), 'dweb.link': subdomainRedirect(), sub: image(PNG) });
  check('2P PASS: Pinata 429 + ipfs.io 429, dweb.link serves the image', passes(r));
  r = await run('ipfs://' + CID, { pinata: image(PNG), 'ipfs.io': hang(), 'dweb.link': hang() });
  check('2P PASS: Pinata answers while both public gateways hang (no wait for the timeout)', passes(r) && r.ms < 2000, r.ms + ' ms');
  r = await run('ipfs://' + CID, { pinata: redirect('https://gateway.pinata.cloud/ipfs/' + CID + '/'), 'ipfs.io': r429(), 'dweb.link': r429() });
  check('2P Pinata redirect to its own host is followed (and loops stop after 3)', blocks(r, 'unreachable') && r.requests.filter((c) => c.host === 'gateway.pinata.cloud').length === 4);
  r = await run('ipfs://' + CID, { pinata: r429(), 'ipfs.io': r429(), 'dweb.link': r429() });
  check('2P BLOCK: all three gateways 429 -> {ok:false, reason:"unreachable"}', blocks(r, 'unreachable') && !/429|Too Many/.test(r.res.body), r.res.body);
  r = await run('ipfs://' + CID, { pinata: html(), 'ipfs.io': r429(), 'dweb.link': r429() });
  check('2P BLOCK: Pinata 200 with HTML (not image bytes) + public 429 -> not_image', blocks(r, 'not_image'), JSON.stringify(r.body));
  const big = counted(8 * 1024 * 1024, 64 * 1024, { 'content-length': String(8 * 1024 * 1024) });
  r = await run('ipfs://' + CID, { pinata: big.route(), 'ipfs.io': r429(), 'dweb.link': r429() });
  check('2P BLOCK: Pinata oversized + public 429 -> too_large (size limit kept)', blocks(r, 'too_large'), JSON.stringify(r.body));
  for (const [label, location] of [['http:// downgrade', 'http://gateway.pinata.cloud/ipfs/' + CID], ['foreign host', 'https://evil.example/x.png'], ['look-alike host', 'https://gateway.pinata.cloud.evil.example/ipfs/' + CID], ['metadata IP', 'https://169.254.169.254/']]) {
    r = await run('ipfs://' + CID, { pinata: redirect(location), 'ipfs.io': r429(), 'dweb.link': r429() });
    check(`2P BLOCK: Pinata redirect to ${label} refused`, blocks(r, 'unreachable') && r.requests.every((c) => ALLOWED.test(c.host)), JSON.stringify(r.requests.map((c) => c.url)));
  }
  r = await run('ipfs://bafytestcid', { pinata: image(PNG), 'ipfs.io': image(PNG), 'dweb.link': image(PNG) });
  check('2P invalid CID still refused before any request (Pinata included)', r.res.statusCode === 400 && blocks(r, 'invalid') && r.requests.length === 0);
}

// 3. both gateways fail -> BLOCK
{
  let r = await run('ipfs://' + CID, { 'ipfs.io': status(502), 'dweb.link': status(503) });
  check('3a BLOCK: both gateways 5xx -> {ok:false, reason:"unreachable"}', r.res.statusCode === 200 && blocks(r, 'unreachable'), JSON.stringify(r.body));
  check('3a no upstream text in the answer (only ok + a fixed reason)', !/SECRET|trace|gateway\.internal|502|503/.test(r.res.body) && Object.keys(r.body).sort().join() === 'ok,reason', r.res.body);
  r = await run('ipfs://' + CID, { 'ipfs.io': status(404), 'dweb.link': status(410) });
  check('3b BLOCK: both gateways 4xx', blocks(r, 'unreachable'));
  r = await run('ipfs://' + CID, { 'ipfs.io': netError(), 'dweb.link': netError() });
  check('3c BLOCK: both gateways unreachable (network errors), no error text leaked', blocks(r, 'unreachable') && !/ENOTFOUND|fetch failed/.test(r.res.body));
  r = await run('ipfs://' + CID, { 'ipfs.io': hang(), 'dweb.link': hang() });
  check(`3d BLOCK: both gateways hang -> strict timeout (${I.ATTEMPT_TIMEOUT_MS} ms) -> unreachable`, blocks(r, 'unreachable') && r.ms >= I.ATTEMPT_TIMEOUT_MS - 100 && r.ms < I.ATTEMPT_TIMEOUT_MS + 1500, r.ms + ' ms');
  r = await run('ipfs://' + CID, { 'ipfs.io': image(PNG, 'image/png'), 'dweb.link': status(500) }).then(async () => run('ipfs://' + CID, { 'ipfs.io': status(500), 'dweb.link': status(500) }));
  check('3e BLOCK: a failure is never cached (a previous pass does not hide a later outage once the cache is cleared)', blocks(r, 'unreachable'));
}

// 4. HTML / non-image content -> BLOCK
{
  const cases = [
    ['HTML page (200 text/html)', html()],
    ['HTML bytes labelled image/png', image(Buffer.from('<!doctype html><html><body>hi</body></html>'), 'image/png')],
    ['SVG', image(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml')],
    ['JSON', image(Buffer.from('{"error":"not found"}'), 'application/json')],
    ['PNG signature followed by HTML (polyglot)', image(Buffer.concat([PNG.subarray(0, 8), Buffer.from('<html><script>alert(1)</script></html>')]))],
    ['valid PNG with HTML appended after IEND', image(Buffer.concat([PNG, Buffer.from('<html></html>')]))],
    ['truncated PNG', image(PNG.subarray(0, 60))],
    ['JPEG without EOI', image(JPEG.subarray(0, JPEG.length - 2), 'image/jpeg')],
    ['RIFF/WEBP with a bogus chunk', image(Buffer.concat([Buffer.from('RIFF'), Buffer.from([12, 0, 0, 0]), Buffer.from('WEBPJUNK'), Buffer.alloc(4)]), 'image/webp')],
    ['empty body', image(Buffer.alloc(0))],
  ];
  for (const [label, route] of cases) {
    const r = await run('ipfs://' + CID, { 'ipfs.io': route, 'dweb.link': route === cases[0][1] ? html() : status(502) });
    check(`4 BLOCK: ${label} -> not an image`, blocks(r) && r.body.reason === 'not_image', JSON.stringify(r.body));
  }
}

// 5. invalid CID -> BLOCK before any request
{
  const bad = ['ipfs://bafytestcid', 'ipfs://', '', 'ipfs://Qm123', 'hello-world', 'ipfs://' + CID.toUpperCase(), 'ipfs://' + CID.slice(0, -1), 'ipfs://' + CID + 'aa',
    'ipfs://' + cidFor(PNG, 0x71) /* dag-cbor */, 'ipfs://b' + 'a'.repeat(130), 'ipfs://Qm' + '0'.repeat(44) /* 0 is not base58 */, 'ipfs://' + CID + '/', 'ipfs://' + CID + '//x', ' ipfs://' + CID];
  for (const uri of bad) {
    const r = await run(uri, { 'ipfs.io': image(PNG), 'dweb.link': image(PNG) });
    check(`5 BLOCK: invalid ${JSON.stringify(uri).slice(0, 60)} -> 400 {ok:false, reason:"invalid"}, no gateway request`, r.res.statusCode === 400 && blocks(r, 'invalid') && r.requests.length === 0, JSON.stringify(r.body) + ' requests=' + r.requests.length);
  }
  const r = await run(undefined, {});
  check('5 BLOCK: missing uri parameter -> 400 invalid', r.res.statusCode === 400 && blocks(r, 'invalid'));
}

// 6. oversized response -> BLOCK
{
  const declared = counted(8 * 1024 * 1024, 64 * 1024, { 'content-length': String(8 * 1024 * 1024) });
  let r = await run('ipfs://' + CID, { 'ipfs.io': declared.route(), 'dweb.link': status(502) });
  check('6a BLOCK: Content-Length 8 MiB (> 5 MiB) -> too_large, refused before reading the body', blocks(r, 'too_large') && declared.meter.pulled <= 64 * 1024, 'pulled ' + declared.meter.pulled);
  const streamed = counted(64 * 1024 * 1024, 64 * 1024);
  r = await run('ipfs://' + CID, { 'ipfs.io': streamed.route(), 'dweb.link': status(502) });
  check('6b BLOCK: no Content-Length, 64 MiB stream -> too_large, reading stops at the 5 MiB cap', blocks(r, 'too_large') && streamed.meter.pulled <= I.MAX_BYTES + 3 * 64 * 1024, 'pulled ' + streamed.meter.pulled);
  const bomb = png(5000, 5000, 0); // tiny file, huge dimensions (decompression bomb)
  r = await run('ipfs://' + cidFor(bomb), { 'ipfs.io': image(bomb), 'dweb.link': status(502) });
  check(`6c BLOCK: PNG of 5000x5000 px in ${bomb.length} bytes -> too_large (dimension cap before inflating)`, blocks(r, 'too_large') && r.ms < 3000, JSON.stringify(r.body) + ' ' + r.ms + ' ms');
  const one = counted(6 * 1024 * 1024, 256 * 1024), two = counted(6 * 1024 * 1024, 256 * 1024);
  r = await run('ipfs://' + CID, { 'ipfs.io': one.route(), 'dweb.link': subdomainRedirect(), sub: two.route() });
  check('6d BLOCK: both gateways stream 6 MiB -> too_large', blocks(r, 'too_large'), JSON.stringify(r.body));
}

// 7. SSRF / arbitrary URL input -> BLOCK
{
  const inputs = ['https://evil.example/logo.png', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/', 'http://localhost:8080/admin', 'http://127.0.0.1/', 'http://[::1]/', 'file:///etc/passwd',
    '//evil.example/a.png', 'javascript:alert(1)', 'ipns://evil.example', 'https://ipfs.io/ipfs/' + CID, 'ipfs://' + CID + '@evil.example', 'ipfs://evil.example/' + CID,
    'ipfs://' + CID + '/../../api/v0/shutdown', 'ipfs://' + CID + '/%2e%2e/x', 'ipfs://' + CID + '?url=http://169.254.169.254/', 'ipfs://' + CID + '#x',
    'ipfs://' + CID + '\r\nHost: evil.example', 'ipfs://' + CID + '/a b', 'ipfs://127.0.0.1', 'ipfs://' + CID + '/' + 'x/'.repeat(12) + 'x'];
  for (const uri of inputs) {
    const r = await run(uri, { 'ipfs.io': image(PNG), 'dweb.link': image(PNG) });
    check(`7a BLOCK: ${JSON.stringify(uri).slice(0, 70)} -> 400 invalid, no request made`, r.res.statusCode === 400 && blocks(r, 'invalid') && r.requests.length === 0, JSON.stringify(r.body) + ' requests=' + r.requests.length);
  }
  const evil = [
    ['http:// downgrade', 'http://ipfs.io/ipfs/' + CID],
    ['cloud metadata IP', 'https://169.254.169.254/latest/meta-data/'],
    ['internal host', 'https://localhost/'],
    ['foreign host', 'https://evil.example/logo.png'],
    ['look-alike host', 'https://dweb.link.evil.example/ipfs/' + CID],
    ['credentials', 'https://user:pass@dweb.link/ipfs/' + CID],
    ['non-443 port', 'https://dweb.link:8443/ipfs/' + CID],
    ['protocol-relative to another host', '//evil.example/x'],
  ];
  for (const [label, location] of evil) {
    const r = await run('ipfs://' + CID, { pinata: redirect(location), 'ipfs.io': redirect(location), 'dweb.link': redirect(location, 301) });
    check(`7b BLOCK: gateway redirect to ${label} is refused, never followed`, blocks(r, 'unreachable') && r.requests.every((c) => c.host === 'gateway.pinata.cloud' || c.host === 'ipfs.io' || c.host === 'dweb.link'), JSON.stringify(r.requests.map((c) => c.url)));
  }
  let r = await run('ipfs://' + CID, { 'ipfs.io': redirect('https://ipfs.io/ipfs/' + CID), 'dweb.link': redirect('https://dweb.link/ipfs/' + CID) });
  const perGateway = (h) => r.requests.filter((c) => c.host === h).length;
  check('7c BLOCK: redirect loop stops after 3 redirects per gateway', blocks(r, 'unreachable') && perGateway('ipfs.io') === 4 && perGateway('dweb.link') === 4, `ipfs.io=${perGateway('ipfs.io')} dweb.link=${perGateway('dweb.link')}`);
  check('7d no request ever left the gateway allow-list in this suite', calls.every((c) => ALLOWED.test(c.host)), calls.filter((c) => !ALLOWED.test(c.host)).map((c) => c.url).join(', '));
}

// =====================================================================================================================
// Hygiene: method, rate limit, caching, headers
{
  let r = await run('ipfs://' + CID, { 'ipfs.io': image(PNG) }, { method: 'POST' });
  check('POST -> 405 {ok:false}', r.res.statusCode === 405 && r.body.ok === false && r.requests.length === 0);
  r = await run('ipfs://' + CID, { 'ipfs.io': image(PNG), 'dweb.link': status(502) });
  check('headers: JSON, nosniff, deny-all CSP, no-store', /application\/json/.test(r.res.headers['content-type']) && r.res.headers['x-content-type-options'] === 'nosniff' && /default-src 'none'/.test(r.res.headers['content-security-policy']) && r.res.headers['cache-control'] === 'no-store');
  const store = createStore({ map: new Map() });
  let last = null;
  for (let i = 0; i < 21; i++) last = await run('ipfs://' + CID, { 'ipfs.io': image(PNG), 'dweb.link': status(502) }, { ip: '203.0.113.9', store, keepCache: i > 0 });
  check('rate limit: the 21st check within a minute from one IP -> 429 {ok:false, reason:"rate_limited"} + Retry-After', last.res.statusCode === 429 && blocks(last, 'rate_limited') && Number(last.res.headers['retry-after']) > 0, last.res.statusCode + ' ' + last.res.body);
  I.passed.clear();
  const first = await run('ipfs://' + CID, { 'ipfs.io': image(PNG), 'dweb.link': status(502) }, { keepCache: true });
  const again = await run('ipfs://' + CID, { 'ipfs.io': image(PNG), 'dweb.link': status(502) }, { keepCache: true });
  check('a passed CID is remembered: the second check makes no gateway request', passes(first) && passes(again) && again.requests.length === 0, 'requests=' + again.requests.length);
  I.passed.clear();
  const spec = { 'ipfs.io': (url, init) => new Promise((resolve) => setTimeout(() => resolve(image(PNG)()), 150)), 'dweb.link': status(502) };
  const before = calls.length;
  const [a, b] = await Promise.all([run('ipfs://' + CID, spec, { keepCache: true }), run('ipfs://' + CID, spec, { keepCache: true })]);
  check('single flight: two concurrent checks of one CID share one request per gateway', passes(a) && passes(b) && calls.slice(before).filter((c) => c.host === 'ipfs.io').length === 1, 'ipfs.io requests=' + calls.slice(before).filter((c) => c.host === 'ipfs.io').length);
  check('server log records gateway failures (for the operator) without them reaching the client', logs.some((l) => l && l.fn === 'ipfs-check' && l.event === 'fail' && Array.isArray(l.failures) && l.failures.length), JSON.stringify(logs.slice(-1)));
}

fs.writeFileSync(path.join(ROOT, 'tests/server/ipfs-check.results.json'), JSON.stringify({ at: new Date().toISOString(), failures, passed: results.filter((r) => r.ok).length, total: results.length, results }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} ipfs-check checks passed`);
process.exit(failures ? 1 : 0);
