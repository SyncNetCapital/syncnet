'use strict';
// Short-lived, HMAC-signed sessions and stateless wallet challenges.
// The browser never sees SYNCNET_UPLOAD_KEY; it only holds tokens that expire.
//
// Session token: v2.<scope>.<subject>.<exp>.<sid>.<mac>
//   scope   founder | wallet
//   subject '-' or a lowercase 0x address (wallet scope requires an address)
//   exp     unix seconds
//   sid     16 random hex chars
//   mac     hex HMAC-SHA256(SYNCNET_UPLOAD_KEY, `syncnet-session|v2|${scope}|${subject}|${exp}|${sid}|${epoch}`)
//   epoch   SYNCNET_SESSION_EPOCH || '1'; changing it revokes every outstanding session and challenge.
// SYNCNET_UPLOAD_KEY must be at least 32 characters, otherwise issue() returns '' and verify() returns null.
const crypto = require('crypto');

const TTL = Object.freeze({ founder: 2 * 60 * 60, wallet: 30 * 60 });
const MIN_SECRET_LENGTH = 32;
const CLOCK_SKEW_SECONDS = 60; // tolerated difference between function instances' clocks
const CHALLENGE_TTL_DEFAULT = 600;
const CHALLENGE_TTL_MAX = 3600;
const CHALLENGE_PURPOSE = 'image upload for a token launch';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TOKEN = /^v2\.(founder|wallet)\.(-|0x[0-9a-f]{40})\.([1-9][0-9]{0,11})\.([0-9a-f]{16})\.([0-9a-f]{64})$/;
const ORIGIN = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,63}$/;
const CHALLENGE = /^([A-Za-z0-9][A-Za-z0-9 ._:/-]{0,63}) upload session\nWallet: (0x[0-9a-f]{40})\nPurpose: image upload for a token launch\nExpires: ([1-9][0-9]{0,11})\nNonce: ([0-9a-f]{16})\nCheck: ([0-9a-f]{64})$/;
const SIGNATURE = /^0x(?:[0-9a-fA-F]{2}){64,65}$/;

function secret() {
  const s = process.env.SYNCNET_UPLOAD_KEY || '';
  return s.length >= MIN_SECRET_LENGTH ? s : null;
}
function epoch() {
  return String(process.env.SYNCNET_SESSION_EPOCH || '1');
}
function nowSeconds(options) {
  const n = options && options.now !== undefined ? (typeof options.now === 'function' ? options.now() : options.now) : Date.now();
  return Math.floor(Number(n) / 1000);
}
function hmacHex(key, text) {
  return crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex');
}
function sameHex(a, b) {
  const A = Buffer.from(a, 'hex');
  const B = Buffer.from(b, 'hex');
  return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B);
}
function sessionMac(key, scope, subject, exp, sid) {
  return hmacHex(key, `syncnet-session|v2|${scope}|${subject}|${exp}|${sid}|${epoch()}`);
}

// issue({scope, subject='-', ttlSeconds=TTL[scope], now?}) -> token, or '' when it cannot be issued
// (weak/missing secret, unknown scope, invalid subject). ttlSeconds is capped at TTL[scope].
function issue({ scope, subject = '-', ttlSeconds, now } = {}) {
  const key = secret();
  if (!key || !Object.prototype.hasOwnProperty.call(TTL, scope)) return '';
  let subj;
  if (subject === '-') subj = '-';
  else if (typeof subject === 'string' && ADDRESS.test(subject)) subj = subject.toLowerCase();
  else return '';
  if (scope === 'wallet' && subj === '-') return '';
  let ttl = TTL[scope];
  if (ttlSeconds !== undefined) {
    const n = Number(ttlSeconds);
    if (!Number.isFinite(n) || n < 1) return '';
    ttl = Math.min(Math.floor(n), TTL[scope]);
  }
  const exp = nowSeconds({ now }) + ttl;
  const sid = crypto.randomBytes(8).toString('hex');
  return `v2.${scope}.${subj}.${exp}.${sid}.${sessionMac(key, scope, subj, exp, sid)}`;
}

// verify(token, {scope?: string|string[], now?}) -> {scope, subject, exp, sid} | null
// Rejects: bad format/mac (timing-safe), other epoch, wrong scope, exp in the past, exp more than
// TTL[scope] in the future (plus CLOCK_SKEW_SECONDS).
function verify(token, options = {}) {
  const key = secret();
  if (!key || typeof token !== 'string' || token.length > 200) return null;
  const m = TOKEN.exec(token);
  if (!m) return null;
  const [, scope, subject, expText, sid, mac] = m;
  const opts = options && typeof options === 'object' ? options : {};
  if (opts.scope !== undefined) {
    const allowed = Array.isArray(opts.scope) ? opts.scope : [opts.scope];
    if (!allowed.includes(scope)) return null;
  }
  if (scope === 'wallet' && subject === '-') return null;
  const exp = Number(expText);
  const nowS = nowSeconds(opts);
  if (!(exp > nowS) || exp > nowS + TTL[scope] + CLOCK_SKEW_SECONDS) return null;
  if (!sameHex(mac, sessionMac(key, scope, subject, exp, sid))) return null;
  return { scope, subject, exp, sid };
}

// ---- stateless wallet challenges (the wallet signs the message with personal_sign)
function challengeMac(key, body) {
  return hmacHex(key, `syncnet-challenge|v1|${epoch()}|${body}`);
}

// issueChallenge(address, {ttlSeconds=600, origin='SyncNet', now?}) -> {message, exp} | null
function issueChallenge(address, { ttlSeconds = CHALLENGE_TTL_DEFAULT, origin = 'SyncNet', now } = {}) {
  const key = secret();
  if (!key || typeof address !== 'string' || !ADDRESS.test(address)) return null;
  if (typeof origin !== 'string' || !ORIGIN.test(origin)) return null;
  const ttl = Number(ttlSeconds);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > CHALLENGE_TTL_MAX) return null;
  const exp = nowSeconds({ now }) + ttl;
  const nonce = crypto.randomBytes(8).toString('hex');
  const body = [
    `${origin} upload session`,
    `Wallet: ${address.toLowerCase()}`,
    `Purpose: ${CHALLENGE_PURPOSE}`,
    `Expires: ${exp}`,
    `Nonce: ${nonce}`,
  ].join('\n');
  return { message: `${body}\nCheck: ${challengeMac(key, body)}`, exp };
}

// parseChallenge(message, {now?}) -> {address, exp, nonce} | null (checks the mac, expiry and max ttl).
// Stateless: a challenge stays valid until it expires; record used nonces if single use matters.
function parseChallenge(message, options = {}) {
  const key = secret();
  if (!key || typeof message !== 'string' || message.length > 1024) return null;
  const m = CHALLENGE.exec(message);
  if (!m) return null;
  const [, , address, expText, nonce, mac] = m;
  const body = message.slice(0, message.lastIndexOf('\nCheck: '));
  if (!sameHex(mac, challengeMac(key, body))) return null;
  const exp = Number(expText);
  const nowS = nowSeconds(options);
  if (!(exp > nowS) || exp > nowS + CHALLENGE_TTL_MAX + CLOCK_SKEW_SECONDS) return null;
  return { address, exp, nonce };
}

// verifyChallengeSignature(message, signature, recoverFn, {now?}) -> lowercase address | null.
// recoverFn(message, signature) returns the signing address (e.g. syncnet-core's recoverPersonalSignAddress).
// If recoverFn returns a Promise, a Promise of the same result is returned; `await` works either way.
function verifyChallengeSignature(message, signature, recoverFn, options = {}) {
  if (typeof recoverFn !== 'function' || typeof signature !== 'string' || !SIGNATURE.test(signature)) return null;
  const parsed = parseChallenge(message, options);
  if (!parsed) return null;
  const check = (recovered) => (typeof recovered === 'string' && recovered.toLowerCase() === parsed.address ? parsed.address : null);
  let recovered;
  try {
    recovered = recoverFn(message, signature);
  } catch {
    return null;
  }
  if (recovered && typeof recovered.then === 'function') return Promise.resolve(recovered).then(check, () => null);
  return check(recovered);
}

module.exports = {
  issue,
  verify,
  TTL,
  MIN_SECRET_LENGTH,
  CLOCK_SKEW_SECONDS,
  issueChallenge,
  parseChallenge,
  verifyChallengeSignature,
};
