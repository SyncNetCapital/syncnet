'use strict';
// SYNC Proof / EARLY sessions and OAuth state tokens: short-lived HMAC tokens, same construction as upload-session.js
// but with a SEPARATE secret (SYNCNET_EARLY_SESSION_KEY, >= 32 chars). Never an attestation key. The epoch
// (SYNCNET_SESSION_EPOCH) is shared so one rotation revokes every SyncNet session at once.
//
//   fan session      e1.fan.<wallet>.<exp>.<sid>.<mac>                 30 min   (only for private reads / cards)
//   creator session  e1.creator.<channelId>~<wallet>.<exp>.<sid>.<mac>  2 h     (issued by the OAuth callback)
//   oauth state      e1.state.<wallet>.<exp>.<nonce>.<mac>              10 min  (CSRF binding of the OAuth round trip)
//   mac = hex HMAC-SHA256(key, `syncnet-early-session|v1|${scope}|${subject}|${exp}|${sid}|${epoch}`)
const crypto = require('crypto');
const E = require('../../lib/syncnet-early.js');

const MIN_SECRET_LENGTH = 32;
const CLOCK_SKEW_SECONDS = 60;
const TTL = Object.freeze({ fan: E.CONST.SESSION_FAN_S, creator: E.CONST.SESSION_CREATOR_S, state: 600 });
const TOKEN = /^e1\.(fan|creator|state)\.([A-Za-z0-9_~-]{1,80})\.([1-9][0-9]{0,11})\.([0-9a-f]{16,64})\.([0-9a-f]{64})$/;

function secret(env) { const s = String((env || process.env).SYNCNET_EARLY_SESSION_KEY || ''); return s.length >= MIN_SECRET_LENGTH ? s : null; }
const epoch = (env) => String((env || process.env).SYNCNET_SESSION_EPOCH || '1');
const nowSeconds = (now) => Math.floor(Number(typeof now === 'function' ? now() : now === undefined ? Date.now() : now) / 1000);
const hmacHex = (key, text) => crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex');
function sameHex(a, b) { const A = Buffer.from(a, 'hex'), B = Buffer.from(b, 'hex'); return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B); }
const mac = (key, env, scope, subject, exp, sid) => hmacHex(key, `syncnet-early-session|v1|${scope}|${subject}|${exp}|${sid}|${epoch(env)}`);

function subjectOf(scope, o) {
  if (scope === 'creator') return E.isChannelId(o.channelId) && E.isAddr(o.wallet) ? o.channelId + '~' + E.lc(o.wallet) : null;
  return E.isAddr(o.wallet) ? E.lc(o.wallet) : null;
}
function parseSubject(scope, subject) {
  if (scope === 'creator') { const [ch, w] = subject.split('~'); return E.isChannelId(ch) && E.isAddr(w) ? { channelId: ch, wallet: E.lc(w) } : null; }
  return E.isAddr(subject) ? { wallet: E.lc(subject) } : null;
}

/** issue({scope:'fan'|'creator'|'state', wallet, channelId?, now?, env?}) -> token | '' (weak secret / bad input). */
function issue({ scope, wallet, channelId, now, env } = {}) {
  const key = secret(env);
  if (!key || !Object.prototype.hasOwnProperty.call(TTL, scope)) return '';
  const subject = subjectOf(scope, { wallet, channelId });
  if (!subject) return '';
  const exp = nowSeconds(now) + TTL[scope];
  const sid = crypto.randomBytes(scope === 'state' ? 16 : 8).toString('hex');
  return `e1.${scope}.${subject}.${exp}.${sid}.${mac(key, env, scope, subject, exp, sid)}`;
}

/** verify(token, {scope, now?, env?}) -> {scope, wallet, channelId?, exp, sid} | null */
function verify(token, options = {}) {
  const env = options.env;
  const key = secret(env);
  if (!key || typeof token !== 'string' || token.length > 260) return null;
  const m = TOKEN.exec(token);
  if (!m) return null;
  const [, scope, subject, expText, sid, given] = m;
  if (options.scope && scope !== options.scope) return null;
  const parsed = parseSubject(scope, subject);
  if (!parsed) return null;
  const exp = Number(expText), t = nowSeconds(options.now);
  if (!(exp > t) || exp > t + TTL[scope] + CLOCK_SKEW_SECONDS) return null;
  if (!sameHex(given, mac(key, env, scope, subject, exp, sid))) return null;
  return { scope, ...parsed, exp, sid };
}

module.exports = { issue, verify, TTL, MIN_SECRET_LENGTH, secret };
