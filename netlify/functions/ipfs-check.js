'use strict';
// GET /api/ipfs-check?uri=ipfs://<CID>[/path]
//   -> 200 {ok:true} | 200 {ok:false, reason} | 400 {ok:false, reason:'invalid'} | 429 {ok:false, reason:'rate_limited'}
// The authoritative half of the builder's IPFS metadata preflight. It answers: can a public IPFS gateway serve
// this pinned logo right now, and are the bytes it serves a real image? Browsers cannot answer that reliably
// (gateways and in-wallet browsers may refuse cross-site <img> loads that a normal tab would show).
//  - input: an ipfs:// URI or a bare CID, nothing else. The CID is decoded and checked (CIDv0; CIDv1 in base32,
//    base58btc or base36; dag-pb or raw; sha2-256 / blake3 / blake2b-256), optionally followed by a plain path
//    inside it. Every URL, host, port, query, "..", "%" or whitespace is refused before any request is made;
//  - requests only go to fixed trusted gateways (gateway.pinata.cloud, ipfs.io, dweb.link); all are tried in parallel with GET and one
//    8 s deadline per gateway that covers connect + headers + body;
//  - redirects are followed by hand: at most 3, https only, and only to the gateways' own hosts
//    (dweb.link's <cid>.ipfs.dweb.link subdomain gateway included); anything else counts as a failure;
//  - only HTTP 200 counts; a Content-Length over 5 MiB is refused unread, and the streamed body is cut off at 5 MiB;
//  - the bytes must be PNG, GIF, JPEG or WebP. PNG and GIF are fully decoded with the upload sanitizer's own
//    decoders (netlify/lib/image-sanitize.js); JPEG (markers, frame header, scan, EOI) and WebP (RIFF chunks,
//    VP8 / VP8L / VP8X headers) are checked structurally;
//  - the answer is {ok} plus a fixed reason code: invalid | unreachable | not_image | too_large | rate_limited.
//    Gateway statuses, errors and timings go to the server log only;
//  - 20 checks per minute and 120 per hour per client IP; a passed check is remembered for 10 minutes.
const Sanitizer = require('../lib/image-sanitize');
const { json } = require('../lib/respond');
const { log, hashId } = require('../lib/log');
const { getStore } = require('../lib/store');
const { clientIp, limitAll } = require('../lib/ratelimit');
const { query, method: methodOf } = require('../lib/body');

const FN = 'ipfs-check';
// Pinata first: it is SyncNet's pinning provider and serves its own pins even when the public gateways rate-limit (429).
// Any ONE gateway returning valid image bytes is a pass.
const GATEWAYS = Object.freeze(['https://gateway.pinata.cloud', 'https://ipfs.io', 'https://dweb.link']);
const REDIRECT_HOST = /^(?:gateway\.pinata\.cloud|ipfs\.io|dweb\.link|[a-z0-9]{1,100}\.ipfs\.dweb\.link)$/;
const ATTEMPT_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_INPUT = 300;
const PASS_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 500;
const RATE_LIMITS = Object.freeze([
  Object.freeze({ bucket: 'ipfs-check', limit: 20, windowSeconds: 60 }),
  Object.freeze({ bucket: 'ipfs-check-h', limit: 120, windowSeconds: 3600 }),
]);
const USER_AGENT = 'SyncNet/2.5 ipfs-check (+https://syncnet.capital)';
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/*;q=0.8,*/*;q=0.1';
// Decoder limits for images pinned anywhere (not only through SyncNet's uploader, whose limits are tighter).
const IMAGE_LIMITS = Object.freeze({
  maxInputBytes: MAX_BYTES,
  png: { maxWidth: 4096, maxHeight: 4096, minWidth: 1, minHeight: 1 },
  gif: { maxWidth: 4096, maxHeight: 4096, minWidth: 1, minHeight: 1, maxFrames: 1000, maxTotalPixels: 48 * 1024 * 1024 },
});

// ---------------------------------------------------------------- CID parsing (no URL is ever accepted)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const CODECS = new Set([0x70, 0x55]); // dag-pb, raw
const HASHES = new Map([[0x12, 32], [0x1e, 32], [0xb220, 32]]); // sha2-256, blake3, blake2b-256

function decodeBigBase(text, alphabet, zeroChar) {
  let n = 0n;
  const base = BigInt(alphabet.length);
  for (const ch of text) {
    const v = alphabet.indexOf(ch);
    if (v < 0) return null;
    n = n * base + BigInt(v);
  }
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of text) {
    if (ch !== zeroChar) break;
    out.unshift(0);
  }
  return Buffer.from(out);
}
function decodeBase32(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of text) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}
function varint(buf, pos) {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 9; i++) {
    if (pos + i >= buf.length) return null;
    const b = buf[pos + i];
    value += (b & 0x7f) * scale;
    if (b < 0x80) return { value, next: pos + i + 1 };
    scale *= 128;
  }
  return null;
}
function validMultihash(bytes, pos) {
  const code = varint(bytes, pos);
  if (!code) return false;
  const len = varint(bytes, code.next);
  if (!len) return false;
  return HASHES.get(code.value) === len.value && bytes.length - len.next === len.value;
}
function isValidCid(cid) {
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
    const bytes = decodeBigBase(cid, B58, '1'); // CIDv0 = a bare sha2-256 multihash
    return Boolean(bytes && bytes.length === 34 && bytes[0] === 0x12 && bytes[1] === 0x20);
  }
  if (cid.length < 20 || cid.length > 120) return false;
  const body = cid.slice(1);
  let bytes = null;
  if (cid[0] === 'b' && /^[a-z2-7]+$/.test(body)) bytes = decodeBase32(body);
  else if (cid[0] === 'z' && /^[1-9A-HJ-NP-Za-km-z]+$/.test(body)) bytes = decodeBigBase(body, B58, '1');
  else if (cid[0] === 'k' && /^[0-9a-z]+$/.test(body)) bytes = decodeBigBase(body, B36, '0');
  if (!bytes) return false;
  const version = varint(bytes, 0);
  if (!version || version.value !== 1) return false;
  const codec = varint(bytes, version.next);
  if (!codec || !CODECS.has(codec.value)) return false;
  return validMultihash(bytes, codec.next);
}
/** ipfs://<cid>[/path] or <cid>[/path] -> {cid, path, key}, or null. */
function parseTarget(raw) {
  const s = typeof raw === 'string' ? raw : '';
  if (!s || s.length > MAX_INPUT) return null;
  const m = /^(?:ipfs:\/\/)?([A-Za-z0-9]{20,120})((?:\/[A-Za-z0-9._~-]{1,100}){0,10})$/.exec(s);
  if (!m) return null;
  const [, cid, path] = m;
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) return null;
  if (!isValidCid(cid)) return null;
  return { cid, path, key: cid + path };
}

// ---------------------------------------------------------------- image validation
class Outcome extends Error {
  constructor(reason, detail) {
    super(reason);
    this.reason = reason; // public: unreachable | not_image | too_large
    this.detail = detail; // server log only
  }
}
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
function validJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return false;
  let pos = 2;
  let frame = false;
  for (;;) {
    if (pos >= buf.length || buf[pos] !== 0xff) return false;
    while (pos < buf.length && buf[pos] === 0xff) pos++; // fill bytes
    if (pos >= buf.length) return false;
    const marker = buf[pos++];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // parameterless markers
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x00) return false; // no scan before EOI
    if (pos + 2 > buf.length) return false;
    const len = buf.readUInt16BE(pos);
    if (len < 2 || pos + len > buf.length) return false;
    if (SOF.has(marker)) {
      if (frame || len < 8) return false;
      const precision = buf[pos + 2];
      const height = buf.readUInt16BE(pos + 3);
      const width = buf.readUInt16BE(pos + 5);
      const components = buf[pos + 7];
      if (![8, 12, 16].includes(precision) || !width || !height || components < 1 || components > 4 || len !== 8 + 3 * components) return false;
      frame = true;
    }
    pos += len;
    if (marker === 0xda) {
      if (!frame) return false;
      break;
    }
  }
  // Entropy-coded data follows the first scan; the image must still be closed by an EOI marker.
  for (let i = buf.length - 2; i >= pos; i--) if (buf[i] === 0xff && buf[i + 1] === 0xd9) return true;
  return false;
}
function validWebp(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return false;
  const end = 8 + buf.readUInt32LE(4);
  if (end < 20 || end > buf.length) return false;
  let pos = 12;
  let first = true;
  let image = false;
  while (pos + 8 <= end) {
    const type = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const at = pos + 8;
    if (size > end - at) return false;
    const d = buf.subarray(at, at + size);
    if (first) {
      if (type === 'VP8 ') {
        if (size < 10 || (d[0] & 1) !== 0 || d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a) return false;
        if (!(d.readUInt16LE(6) & 0x3fff) || !(d.readUInt16LE(8) & 0x3fff)) return false;
        image = true;
      } else if (type === 'VP8L') {
        if (size < 5 || d[0] !== 0x2f || (d[4] >> 5) !== 0) return false; // signature, version 0
        image = true;
      } else if (type === 'VP8X') {
        if (size < 10) return false;
      } else {
        return false;
      }
      first = false;
    } else if (type === 'VP8 ' || type === 'VP8L' || type === 'ANMF') {
      image = true;
    }
    pos = at + size + (size & 1);
  }
  return image && !first;
}
/** Throws Outcome('not_image' | 'too_large') unless bytes are a supported, valid image; returns the format. */
function imageFormat(bytes) {
  const head = bytes.subarray(0, 12);
  let format = null;
  if (head.length >= 8 && head.compare(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 0, 8, 0, 8) === 0) format = 'png';
  else if (head.length >= 6 && /^GIF8[79]a$/.test(head.toString('latin1', 0, 6))) format = 'gif';
  else if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) format = 'jpeg';
  else if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') format = 'webp';
  if (!format) throw new Outcome('not_image', 'unsupported-bytes');
  try {
    if (format === 'png') Sanitizer._internal.decodePng(bytes, IMAGE_LIMITS);
    else if (format === 'gif') Sanitizer._internal.decodeGif(bytes, IMAGE_LIMITS);
    else if (format === 'jpeg' ? !validJpeg(bytes) : !validWebp(bytes)) throw new Outcome('not_image', 'malformed-' + format);
  } catch (err) {
    if (err instanceof Outcome) throw err;
    const code = err && err.code;
    if (code === 'TOO_LARGE_BYTES' || code === 'TOO_LARGE_DIMENSIONS' || code === 'TOO_MANY_FRAMES' || code === 'DECOMPRESSION_LIMIT') {
      throw new Outcome('too_large', 'image-' + String(code).toLowerCase());
    }
    throw new Outcome('not_image', 'malformed-' + format);
  }
  return format;
}

// ---------------------------------------------------------------- gateway fetch
function safeRedirect(current, location) {
  if (typeof location !== 'string' || !location || location.length > 2048) return null;
  let u;
  try {
    u = new URL(location, current);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  if (!REDIRECT_HOST.test(u.hostname)) return null;
  u.hash = '';
  return u.href;
}
function discard(res) {
  try {
    if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
  } catch {
    // nothing to release
  }
}
async function readCapped(res) {
  const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    discard(res);
    throw new Outcome('too_large', 'content-length-' + declared);
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Outcome('too_large', 'body');
    return buf;
  }
  const reader = res.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      reader.cancel().catch(() => {});
      throw new Outcome('too_large', 'body');
    }
    parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(parts, total);
}
async function tryGateway(base, target, doFetch, stop) {
  const ctl = new AbortController();
  const onStop = () => ctl.abort();
  stop.addEventListener('abort', onStop);
  const timer = setTimeout(() => ctl.abort(), ATTEMPT_TIMEOUT_MS);
  const started = Date.now();
  const gateway = new URL(base).hostname;
  try {
    let url = `${base}/ipfs/${target.cid}${target.path}`;
    for (let hop = 0; ; hop++) {
      const res = await doFetch(url, { method: 'GET', redirect: 'manual', signal: ctl.signal, headers: { accept: ACCEPT, 'user-agent': USER_AGENT } });
      if (res.status >= 300 && res.status < 400) {
        discard(res);
        const next = safeRedirect(url, res.headers.get('location'));
        if (!next) throw new Outcome('unreachable', 'redirect-refused');
        if (hop >= MAX_REDIRECTS) throw new Outcome('unreachable', 'too-many-redirects');
        url = next;
        continue;
      }
      if (res.status !== 200) {
        discard(res);
        throw new Outcome('unreachable', 'http-' + res.status);
      }
      const bytes = await readCapped(res);
      const format = imageFormat(bytes);
      return { gateway, format, bytes: bytes.length, ms: Date.now() - started };
    }
  } catch (err) {
    const out = err instanceof Outcome ? err : new Outcome('unreachable', ctl.signal.aborted ? 'timeout' : 'network');
    out.gateway = gateway;
    out.ms = Date.now() - started;
    throw out;
  } finally {
    clearTimeout(timer);
    stop.removeEventListener('abort', onStop);
  }
}
async function checkGateways(target, doFetch) {
  const stop = new AbortController();
  try {
    const pass = await Promise.any(GATEWAYS.map((base) => tryGateway(base, target, doFetch, stop.signal)));
    return { ok: true, ...pass };
  } catch (err) {
    const failures = (err && Array.isArray(err.errors) ? err.errors : []).map((e) => (e instanceof Outcome ? e : new Outcome('unreachable', 'internal')));
    const pick = failures.find((f) => f.reason === 'not_image') || failures.find((f) => f.reason === 'too_large') || failures[0] || new Outcome('unreachable', 'none');
    return { ok: false, reason: pick.reason, failures: failures.map((f) => `${f.gateway || '?'}:${f.detail}`) };
  } finally {
    stop.abort(); // a slower gateway is not waited for once one has answered
  }
}

// ---------------------------------------------------------------- handler
const passed = new Map(); // key -> time of the last successful check
const inflight = new Map(); // key -> promise (single flight per CID)

async function handler(event = {}, deps = {}) {
  if (methodOf(event) !== 'GET') return json(405, { ok: false, reason: 'method' }, { allow: 'GET' });
  const store = deps.store || getStore();
  const ip = clientIp(event);
  const rl = await limitAll(store, RATE_LIMITS.map((r) => ({ ...r, id: ip })));
  if (!rl.allowed) {
    const seconds = Math.max(1, Math.min(3600, Number(rl.retryAfter) || 60));
    return json(429, { ok: false, reason: 'rate_limited' }, { 'retry-after': String(seconds) });
  }
  const target = parseTarget(query(event, 'uri'));
  if (!target) {
    log(FN, 'invalid', { ip: hashId(ip) });
    return json(400, { ok: false, reason: 'invalid' });
  }
  const at = passed.get(target.key);
  if (at && Date.now() - at < PASS_TTL_MS) return json(200, { ok: true });

  const doFetch = deps.fetch || globalThis.fetch;
  let run = inflight.get(target.key);
  if (!run) {
    run = checkGateways(target, doFetch);
    inflight.set(target.key, run);
    run.finally(() => inflight.delete(target.key)).catch(() => {});
  }
  const result = await run;
  if (result.ok) {
    if (passed.size >= MAX_CACHE) passed.delete(passed.keys().next().value);
    passed.set(target.key, Date.now());
    log(FN, 'pass', { ip: hashId(ip), cid: target.key.slice(0, 160), gateway: result.gateway, format: result.format, bytes: result.bytes, ms: result.ms });
    return json(200, { ok: true });
  }
  log(FN, 'fail', { ip: hashId(ip), cid: target.key.slice(0, 160), reason: result.reason, failures: result.failures });
  return json(200, { ok: false, reason: result.reason });
}

exports.handler = (event) => handler(event);
exports._handler = handler;
exports._internals = { parseTarget, isValidCid, imageFormat, safeRedirect, passed, inflight, GATEWAYS, MAX_BYTES, ATTEMPT_TIMEOUT_MS };
