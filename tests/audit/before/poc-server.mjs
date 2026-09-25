// Audit PoCs for the Netlify functions (Node only; outbound fetch is mocked, nothing leaves the machine).
// Run: node tests/audit/poc-server.mjs
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const results = [];
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail: String(detail).slice(0, 300) }); console.log((cond ? 'CONFIRMED ' : 'not-reproduced ') + name + (detail ? ' :: ' + String(detail).slice(0, 200) : '')); };

// ---------------------------------------------------------------- site-check
{
  const sc = require(path.join(ROOT, 'netlify/functions/site-check.js'));
  // 1) DNS rebinding: the guard resolves once, then fetch() resolves the hostname again by itself.
  let fetchedUrl = '', lookups = 0;
  const r1 = await sc._handler({ httpMethod: 'GET', queryStringParameters: { url: 'https://rebind.attacker.example/' } }, {
    lookup: async () => { lookups++; return [{ address: '93.184.216.34', family: 4 }]; },
    fetch: async (u, opt) => { fetchedUrl = u; return new Response('{"token":"0x' + '1'.repeat(40) + '"}', { status: 200 }); },
  });
  check('F-S4 site-check validates DNS once and then fetches by HOSTNAME (resolved address is not pinned → DNS-rebinding TOCTOU)', lookups === 1 && fetchedUrl === 'https://rebind.attacker.example/syncnet.json', fetchedUrl);
  // 2) The 16 KB cap is applied after the whole body has been read.
  let pulled = 0; const CHUNK = new Uint8Array(1 << 20).fill(32);
  const big = new ReadableStream({ pull(ctl) { if (pulled >= 64) return ctl.close(); pulled++; ctl.enqueue(CHUNK); } });
  const r2 = await sc._handler({ httpMethod: 'GET', queryStringParameters: { url: 'https://big.example/' } }, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetch: async () => new Response(big, { status: 200 }),
  });
  check('F-S4 a 64 MB body is fully downloaded before the 16 KB check', pulled === 64 && JSON.parse(r2.body).reason === 'too-large', 'MB read=' + pulled);
  // 3) IPv6 ranges that can map to internal IPv4 are not blocked.
  const ipv6 = [];
  for (const a of ['64:ff9b::a00:1', '2002:a00:1::1', 'fec0::1', '::a00:1']) {
    const r = await sc._handler({ httpMethod: 'GET', queryStringParameters: { url: 'https://v6.example/' } }, { lookup: async () => [{ address: a, family: 6 }], fetch: async () => new Response('{}', { status: 200 }) });
    if (JSON.parse(r.body).found === true) ipv6.push(a);
  }
  check('F-S4 NAT64 / 6to4 / site-local / IPv4-compatible IPv6 answers pass the private-address filter', ipv6.length === 4, ipv6.join(', '));
}

// ---------------------------------------------------------------- ipfs-upload
{
  const up = require(path.join(ROOT, 'netlify/functions/ipfs-upload.js'));
  const pinned = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => { const f = opt.body.get('file'); pinned.push({ url, bytes: Buffer.from(await f.arrayBuffer()) }); return new Response(JSON.stringify({ IpfsHash: 'bafyPOC', PinSize: 1 }), { status: 200 }); };
  process.env.PINATA_JWT = 'test-jwt'; process.env.SYNCNET_UPLOAD_KEY = 'k'.repeat(48); process.env.SYNCNET_PUBLIC_UPLOADS = 'true';
  const post = (buf, type) => up.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ name: 'x', type, size: buf.length, data: buf.toString('base64') }) });
  // PNG signature followed by arbitrary non-image content
  const poly = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('<html><script>alert(1)</script></html>' + 'Z'.repeat(2 * 1024 * 1024))]);
  const r1 = await post(poly, 'image/png');
  check('F-S2 public mode pins a 2 MB non-image payload that only starts with the PNG signature', r1.statusCode === 200 && pinned.at(-1)?.bytes.includes(Buffer.from('<script>')), 'status=' + r1.statusCode);
  const exif = fs.readFileSync(path.join(ROOT, 'tests/e2e/fixture-exif.jpg'));
  const r2 = await post(exif, 'image/jpeg');
  check('F-S2 server pins a JPEG with its EXIF block unchanged (stripping is client-side only)', r2.statusCode === 200 && pinned.at(-1)?.bytes.includes(Buffer.from('Exif')));
  let n = 0; for (let i = 0; i < 200; i++) { const r = await post(Buffer.from([0xff, 0xd8, 0xff, i & 255, 1, 2]), 'image/jpeg'); if (r.statusCode === 200) n++; }
  check('F-S2 no rate limit or quota: 200 anonymous pins in a row accepted', n === 200, 'accepted=' + n);
  // error pass-through
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { reason: 'KEY_SCOPE', details: 'API key 3f9a… lacks pinFileToIPFS scope for account founder@example' } }), { status: 403 });
  const r3 = await post(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0]), 'image/png');
  check('F-S3 upstream provider error text is returned verbatim to the browser', /API key 3f9a/.test(r3.body), r3.body);
  globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND api.pinata.cloud'); };
  const r4 = await post(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0]), 'image/png');
  check('F-S3 internal exception text (provider hostname) is returned to the browser', /pinata/.test(r4.body), r4.body);
  globalThis.fetch = realFetch; delete process.env.SYNCNET_PUBLIC_UPLOADS;
}

// ---------------------------------------------------------------- canary-auth + upload session
{
  const ca = require(path.join(ROOT, 'netlify/functions/canary-auth.js'));
  const us = require(path.join(ROOT, 'netlify/lib/upload-session.js'));
  process.env.SYNCNET_CANARY_KEY = 'correct-horse-battery-staple';
  let denied = 0; const t0 = Date.now();
  for (let i = 0; i < 5000; i++) { const r = await ca.handler({ httpMethod: 'POST', body: JSON.stringify({ key: 'guess-' + i }) }); if (r.statusCode === 401) denied++; }
  const ok = await ca.handler({ httpMethod: 'POST', body: JSON.stringify({ key: 'correct-horse-battery-staple' }) });
  check('F-S1 5000 wrong guesses → 5000 plain 401s, no delay/lockout; the right key still works immediately', denied === 5000 && ok.statusCode === 200, `${Date.now() - t0} ms`);
  const tok = JSON.parse(ok.body).uploadSession;
  check('F-S1 issued upload session is a bearer token valid for anyone for 4 h (not bound to client, not revocable except by rotating the secret)', us.verify(process.env.SYNCNET_UPLOAD_KEY, tok) && us.verify(process.env.SYNCNET_UPLOAD_KEY, tok, Date.now() + 3.9 * 3600e3));
}

// ---------------------------------------------------------------- par-launches-all fan-out
{
  const pl = require(path.join(ROOT, 'netlify/functions/par-launches-all.js'));
  let upstream = 0; const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { upstream++; return new Response(String(u).includes('/count') ? '{"count":5000}' : '{"launches":[]}', { status: 200 }); };
  await pl.handler({ httpMethod: 'GET', queryStringParameters: { cachebust: '1' } });
  check('F-S5 one call to /api/par-launches-all fans out to ' + upstream + ' PAR API requests (query string ignored, cache-bustable URL)', upstream === 11, 'upstream=' + upstream);
  globalThis.fetch = realFetch;
}

fs.writeFileSync(path.join(ROOT, 'tests/audit/poc-server.json'), JSON.stringify({ results }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} reproduced`);
