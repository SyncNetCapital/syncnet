'use strict';
// Reads https://<site>/syncnet.json for the project page's "website linked" check.
// Browsers cannot read it directly (no CORS on most sites), so this function fetches it server-side:
//  - URL: https only, port 443, no credentials, a public DNS name (no IP literals, no local/internal names);
//  - DNS: resolved exactly once; EVERY returned address must be public (privateIp below);
//  - connect: https.request pinned to the validated address through a custom `lookup` (no second
//    resolution, so DNS rebinding cannot swap the target) while hostname/servername keep TLS certificate
//    validation bound to the hostname;
//  - redirects are reported, never followed (the https.request equivalent of fetch's redirect: 'manual');
//  - one 5 s deadline covers connect + headers + body; the body is streamed and cut off after 16 KiB;
//  - 30 requests per minute per client IP; public errors are generic, details go to the server log only.
// Only a whitelisted, sanitised subset of the declaration is returned.
const dns = require('dns');
const https = require('https');
const net = require('net');
const { json, publicError, tooManyRequests } = require('../lib/respond');
const { log, logError, hashId } = require('../lib/log');
const { getStore } = require('../lib/store');
const { clientIp, limit } = require('../lib/ratelimit');

const FN = 'site-check';
const MAX = 16 * 1024;
const DEADLINE_MS = 5000;
const DNS_TIMEOUT_MS = 3000;
const RATE_LIMIT = Object.freeze({ bucket: 'site-check', limit: 30, windowSeconds: 60 });
const USER_AGENT = 'SyncNet-SiteCheck/2';

// ---------------------------------------------------------------- address classification
function v4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip));
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function v4Range(cidr) {
  const [base, bits] = cidr.split('/');
  const mask = (0xffffffff << (32 - Number(bits))) >>> 0;
  return { cidr, base: (v4ToInt(base) & mask) >>> 0, mask };
}
const V4_BLOCKED = [
  '0.0.0.0/8', // "this network"
  '10.0.0.0/8', // private
  '100.64.0.0/10', // carrier-grade NAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local (cloud metadata endpoints)
  '172.16.0.0/12', // private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1
  '192.88.99.0/24', // 6to4 relay anycast
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved
  '255.255.255.255/32', // limited broadcast
].map(v4Range);

function v4BlockedBy(n) {
  const hit = V4_BLOCKED.find((r) => ((n & r.mask) >>> 0) === r.base);
  return hit ? hit.cidr : null;
}

// Full IPv6 parser: '::' expansion and an embedded dotted IPv4 tail. Returns 8 16-bit groups or null.
function parseIPv6(input) {
  let s = String(input || '').toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s || s.length > 45 || !s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return null;
  let tail = [];
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    const v4 = v4ToInt(s.slice(cut + 1));
    if (v4 === null) return null;
    tail = [v4 >>> 16, v4 & 0xffff];
    s = s.slice(0, cut + 1);
    if (!s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (part) => (part === '' ? [] : part.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if (head.some(Number.isNaN) || rest.some(Number.isNaN)) return null;
  const used = head.length + rest.length + tail.length;
  if (halves.length === 2) {
    if (used > 7) return null; // '::' stands for at least one zero group
    return [...head, ...new Array(8 - used).fill(0), ...rest, ...tail];
  }
  return used === 8 ? [...head, ...tail] : null;
}

const zero = (g, from, to) => g.slice(from, to).every((x) => x === 0);
// Order matters only for the label that ends up in the log; any match blocks.
const V6_BLOCKED = [
  ['::/128', (g) => zero(g, 0, 8)],
  ['::1/128', (g) => zero(g, 0, 7) && g[7] === 1],
  ['::/96 (IPv4-compatible)', (g) => zero(g, 0, 6)],
  ['64:ff9b::/96 (NAT64)', (g) => g[0] === 0x64 && g[1] === 0xff9b && zero(g, 2, 6)],
  ['64:ff9b:1::/48 (local NAT64)', (g) => g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1],
  ['100::/64 (discard)', (g) => g[0] === 0x100 && zero(g, 1, 4)],
  ['2001::/32 (Teredo)', (g) => g[0] === 0x2001 && g[1] === 0],
  ['2001:2::/48 (benchmarking)', (g) => g[0] === 0x2001 && g[1] === 2 && g[2] === 0],
  ['2001:10::/28 (ORCHID)', (g) => g[0] === 0x2001 && (g[1] & 0xfff0) === 0x10],
  ['2001:20::/28 (ORCHIDv2)', (g) => g[0] === 0x2001 && (g[1] & 0xfff0) === 0x20],
  ['2001::/23 (IETF protocol assignments)', (g) => g[0] === 0x2001 && g[1] < 0x200],
  ['2001:db8::/32 (documentation)', (g) => g[0] === 0x2001 && g[1] === 0xdb8],
  ['3fff::/20 (documentation)', (g) => g[0] === 0x3fff && g[1] < 0x1000],
  ['2002::/16 (6to4)', (g) => g[0] === 0x2002],
  ['fc00::/7 (unique local)', (g) => (g[0] & 0xfe00) === 0xfc00],
  ['fe80::/10 (link-local)', (g) => (g[0] & 0xffc0) === 0xfe80],
  ['fec0::/10 (site-local)', (g) => (g[0] & 0xffc0) === 0xfec0],
  ['ff00::/8 (multicast)', (g) => (g[0] & 0xff00) === 0xff00],
  ['outside 2000::/3', (g) => (g[0] & 0xe000) !== 0x2000],
];

// ::ffff:a.b.c.d -> the embedded IPv4 as an integer, else null.
function mappedV4(g) {
  return zero(g, 0, 5) && g[5] === 0xffff ? ((g[6] << 16) >>> 0) + g[7] : null;
}
function intToV4(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

// Returns the name of the non-public range an address falls in, or null when it is public.
function blockedBy(address) {
  const s = String(address || '').trim();
  if (!s) return 'empty';
  if (s.includes('%')) return 'zone-scoped';
  if (net.isIPv4(s)) return v4BlockedBy(v4ToInt(s));
  const g = parseIPv6(s);
  if (!g) return 'unparseable'; // never treat something we cannot parse as public
  const mapped = mappedV4(g);
  if (mapped !== null) {
    const hit = v4BlockedBy(mapped);
    return hit ? `::ffff:0:0/96 -> ${hit}` : null;
  }
  const hit = V6_BLOCKED.find(([, test]) => test(g));
  return hit ? hit[0] : null;
}
function privateIp(address) {
  return blockedBy(address) !== null;
}

// ---------------------------------------------------------------- URL rules
const BLOCKED_NAMES = /(^|\.)(localhost|local|localdomain|internal|intranet|private|lan|home|corp|arpa|onion|test|invalid|example)$/;
const LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;
const BAD_URL = { status: 400, code: 'invalid_url', error: 'Invalid URL.' };
const HTTPS_ONLY = { status: 400, code: 'https_only', error: 'Only public https:// sites can be checked.' };
const DOMAIN_ONLY = { status: 400, code: 'public_domain_only', error: 'Only public domain names can be checked.' };

function targetFromUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return BAD_URL;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return BAD_URL;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port !== '' && u.port !== '443')) return HTTPS_ONLY;
  let host = u.hostname.toLowerCase();
  // WHATWG URL already turns 0x7f.1, 2130706433, 127.1 ... into dotted quads; IPv6 literals keep brackets.
  if (host.startsWith('[') || net.isIP(host)) return DOMAIN_ONLY;
  if (host.endsWith('.')) host = host.slice(0, -1);
  const labels = host.split('.');
  if (labels.length < 2 || host.length > 253 || !labels.every((l) => LABEL.test(l))) return DOMAIN_ONLY;
  if (BLOCKED_NAMES.test(host) || /^[0-9]+$/.test(labels[labels.length - 1])) return DOMAIN_ONLY;
  return { host };
}

// ---------------------------------------------------------------- fetch pinned to the validated address
function pinFrom(addresses) {
  const normalized = addresses.map((a) => {
    const g = net.isIPv6(a.address) ? parseIPv6(a.address) : null;
    const mapped = g ? mappedV4(g) : null;
    if (mapped !== null) return { address: intToV4(mapped), family: 4 };
    return { address: a.address, family: net.isIPv4(a.address) ? 4 : 6 };
  });
  return normalized.find((a) => a.family === 4) || normalized[0];
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' })), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function fetchDeclaration({ host, pinned, request, deadlineMs }) {
  return new Promise((resolve) => {
    let req = null;
    let res = null;
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (res && typeof res.destroy === 'function' && !res.destroyed) res.destroy();
      if (req && typeof req.destroy === 'function' && !req.destroyed) req.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ reason: 'timeout' }), deadlineMs);

    // Handed to https.request: returns ONLY the address validated above, in both the single-address and
    // the {all:true} callback forms (Node's autoSelectFamily uses the latter). No DNS query happens here.
    const pinnedLookup = (hostname, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      const opts = options && typeof options === 'object' ? options : {};
      if (String(hostname).toLowerCase().replace(/\.$/, '') !== host) {
        process.nextTick(cb, Object.assign(new Error('unexpected lookup'), { code: 'ENOTFOUND' }));
        return;
      }
      if (opts.all) process.nextTick(cb, null, [{ address: pinned.address, family: pinned.family }]);
      else process.nextTick(cb, null, pinned.address, pinned.family);
    };

    const onResponse = (response) => {
      res = response;
      if (settled) {
        if (typeof response.destroy === 'function') response.destroy();
        return;
      }
      const status = Number(response.statusCode);
      if (status >= 300 && status < 400) return finish({ reason: 'redirect', status });
      if (!(status >= 200 && status < 300)) {
        return finish({ reason: Number.isInteger(status) && status >= 100 && status <= 599 ? `http-${status}` : 'http-error', status });
      }
      const headers = response.headers || {};
      const encoding = String(headers['content-encoding'] || 'identity').trim().toLowerCase();
      if (encoding !== 'identity') return finish({ reason: 'not-json', status }); // we asked for identity only
      const declared = Number(headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX) return finish({ reason: 'too-large', status });
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX) return finish({ reason: 'too-large', status }); // stop reading right here
        chunks.push(chunk);
      });
      response.on('end', () => finish({ status, body: Buffer.concat(chunks) }));
      response.on('error', (err) => finish({ reason: 'unreachable', err }));
      response.on('close', () => finish({ reason: 'unreachable' })); // closed before 'end'
    };

    try {
      req = request({
        protocol: 'https:',
        method: 'GET',
        hostname: host,
        servername: host, // SNI + certificate validation against the hostname, not the pinned IP
        port: 443,
        path: '/syncnet.json',
        headers: { accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': USER_AGENT },
        lookup: pinnedLookup,
        agent: false, // fresh socket, never a pooled connection
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        maxHeaderSize: MAX,
      }, onResponse);
      req.on('error', (err) => finish({ reason: 'unreachable', err }));
      req.end();
    } catch (err) {
      finish({ reason: 'unreachable', err });
    }
  });
}

// ---------------------------------------------------------------- declaration sanitising
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]|\udb40[\udc00-\udc7f]/g;
function cleanStr(v, max) {
  if (typeof v !== 'string') return null;
  return Array.from(v.replace(UNSAFE, '').trim()).slice(0, max).join('');
}

function declarationFrom(j) {
  const o = j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  const token = cleanStr(o.token, 64);
  return {
    schema: cleanStr(o.schema, 40),
    project: cleanStr(o.project, 60),
    symbol: cleanStr(o.symbol, 16),
    chainId: Number.isInteger(o.chainId) ? o.chainId : null,
    token: token && /^0x[a-fA-F0-9]{40}$/.test(token) ? token.toLowerCase() : null,
  };
}

// ---------------------------------------------------------------- handler
async function handler(event = {}, deps = {}) {
  const started = Date.now();
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const lookup = deps.lookup || ((h, o) => dns.promises.lookup(h, o));
  const request = deps.request || ((o, cb) => https.request(o, cb));
  const deadlineMs = Number(deps.deadlineMs) > 0 ? Number(deps.deadlineMs) : DEADLINE_MS;
  const dnsTimeoutMs = Number(deps.dnsTimeoutMs) > 0 ? Number(deps.dnsTimeoutMs) : DNS_TIMEOUT_MS;

  if (String(event.httpMethod || 'GET').toUpperCase() !== 'GET') return publicError(405, 'method_not_allowed', 'GET only.', { allow: 'GET' });

  const ip = clientIp(event);
  const ipHash = hashId(ip);
  const rl = await limit(deps.store || getStore(), { ...RATE_LIMIT, id: ip, now: now() });
  if (!rl.allowed) {
    log(FN, 'rate-limited', { ip: ipHash, reason: rl.reason || 'limit' });
    return tooManyRequests(rl.retryAfter);
  }

  const target = targetFromUrl((event.queryStringParameters || {}).url);
  if (!target.host) {
    log(FN, 'rejected-url', { ip: ipHash, code: target.code });
    return publicError(target.status, target.code, target.error);
  }
  const { host } = target;
  const origin = `https://${host}`;
  const notFound = (reason) => json(200, { found: false, origin, reason }, {
    'cache-control': reason === 'timeout' || reason === 'unreachable' ? 'no-store' : 'public, max-age=60',
  });

  let addresses;
  try {
    addresses = await withTimeout(lookup(host, { all: true }), dnsTimeoutMs);
  } catch (err) {
    logError(FN, 'dns-failed', err, { ip: ipHash, host });
    if (err && err.code === 'ETIMEOUT') return notFound('timeout');
    return publicError(404, 'not_found', 'Domain not found.');
  }
  // Reject when ANY answer is non-public (or malformed), not just the one we would connect to.
  let blocked = null;
  if (!Array.isArray(addresses) || !addresses.length) blocked = 'no-address';
  else {
    for (const a of addresses) {
      blocked = a && typeof a.address === 'string' ? blockedBy(a.address) : 'malformed-answer';
      if (blocked) break;
    }
  }
  if (blocked) {
    log(FN, 'blocked-address', { ip: ipHash, host, range: blocked, answers: Array.isArray(addresses) ? addresses.length : 0 });
    return publicError(400, 'non_public_address', 'This host does not resolve to a public address.');
  }

  const pinned = pinFrom(addresses);
  const outcome = await fetchDeclaration({ host, pinned, request, deadlineMs });
  if (outcome.err) logError(FN, 'fetch-failed', outcome.err, { ip: ipHash, host, reason: outcome.reason });
  if (!outcome.body) {
    log(FN, 'checked', { ip: ipHash, host, found: false, reason: outcome.reason, status: outcome.status, ms: Date.now() - started });
    return notFound(outcome.reason || 'unreachable');
  }
  let parsed;
  try {
    parsed = JSON.parse(outcome.body.toString('utf8').replace(/^\ufeff/, ''));
  } catch {
    log(FN, 'checked', { ip: ipHash, host, found: false, reason: 'not-json', ms: Date.now() - started });
    return notFound('not-json');
  }
  log(FN, 'checked', { ip: ipHash, host, found: true, ms: Date.now() - started });
  return json(200, { found: true, origin, declaration: declarationFrom(parsed) }, { 'cache-control': 'public, max-age=60' });
}

exports.handler = (event) => handler(event);
exports._handler = handler; // tests inject {lookup, request, store, now, deadlineMs, dnsTimeoutMs}
exports._internals = { privateIp, blockedBy, parseIPv6, targetFromUrl, MAX, DEADLINE_MS, RATE_LIMIT };
