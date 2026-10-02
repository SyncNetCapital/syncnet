'use strict';
// SYNC Proof / EARLY sessions and OAuth state tokens: short-lived HMAC tokens, same construction as upload-session.js
// but with a SEPARATE secret (SYNCNET_EARLY_SESSION_KEY, >= 32 chars). Never an attestation key. The epoch
// (SYNCNET_SESSION_EPOCH) is shared so one rotation revokes every SyncNet session at once.
//
//   fan session      e1.fan.<wallet>.<exp>.<sid>.<mac>                 30 min   (only for private reads / cards)
//   creator session  e1.creator.<channelId>~<wallet>.<exp>.<sid>.<mac>  2 h     (issued by the OAuth callback; YouTube)
//                    e1.creator.<platform>_<externalId>~<wallet>…        (any other platform; see subjectOf)
//   oauth state      e1.state.<wallet>.<exp>.<nonce>.<mac>              10 min  (CSRF binding of the OAuth round trip;
//                    e1.state.<wallet>~<platform>… for a non-YouTube platform, so a state cannot be replayed across platforms)
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

// Subjects carry the creator's platform. YouTube's spelling is UNCHANGED (`<channelId>~<wallet>` / bare `<wallet>`), so a
// YouTube token is byte-identical to one issued before platforms existed. Any other platform is spelled
// `<platform>_<externalId>~<wallet>` (creator) / `<wallet>~<platform>` (state). The lowercase `<platform>_` prefix can never
// be mistaken for a YouTube id (those start with an uppercase 'UC'), and the platform is inside the MAC.
function subjectOf(scope, o) {
  const platform = o.platform === undefined ? E.PLATFORM : o.platform;
  if (!E.isAddr(o.wallet) || !E.isPlatform(platform)) return null;
  const wallet = E.lc(o.wallet);
  if (scope === 'creator') {
    const id = o.externalId !== undefined ? o.externalId : o.channelId; // channelId = the legacy name of the external id
    if (!E.isExternalId(platform, id)) return null;
    return (platform === E.PLATFORM ? id : platform + '_' + id) + '~' + wallet;
  }
  if (scope === 'state' && platform !== E.PLATFORM) return wallet + '~' + platform;
  return wallet;
}
function parseSubject(scope, subject) {
  if (scope === 'creator') {
    const [head, w] = subject.split('~');
    const m = /^([a-z]{1,16})_(.+)$/.exec(head || '');
    const platform = m ? m[1] : E.PLATFORM, externalId = m ? m[2] : head;
    if (platform === E.PLATFORM && m) return null; // 'youtube_…' is not a canonical spelling
    return E.isExternalId(platform, externalId) && E.isAddr(w) ? { platform, externalId, channelId: externalId, wallet: E.lc(w) } : null;
  }
  const [w, p] = subject.split('~');
  if (!E.isAddr(w)) return null;
  if (scope === 'state') return p === undefined ? { wallet: E.lc(w), platform: E.PLATFORM } : p !== E.PLATFORM && E.isPlatform(p) ? { wallet: E.lc(w), platform: p } : null;
  return p === undefined ? { wallet: E.lc(w) } : null;
}

/**
 * issue({scope:'fan'|'creator'|'state', wallet, platform?='youtube', externalId? (alias: channelId), now?, env?})
 * -> token | '' (weak secret / bad input / id not of that platform).
 */
function issue({ scope, wallet, platform, externalId, channelId, now, env } = {}) {
  const key = secret(env);
  if (!key || !Object.prototype.hasOwnProperty.call(TTL, scope)) return '';
  const subject = subjectOf(scope, { wallet, platform, externalId, channelId });
  if (!subject) return '';
  const exp = nowSeconds(now) + TTL[scope];
  const sid = crypto.randomBytes(scope === 'state' ? 16 : 8).toString('hex');
  return `e1.${scope}.${subject}.${exp}.${sid}.${mac(key, env, scope, subject, exp, sid)}`;
}

/**
 * verify(token, {scope, now?, env?}) -> {scope, wallet, exp, sid} plus, for 'creator': {platform, externalId, channelId}
 * (channelId is the legacy alias of externalId) and, for 'state': {platform} | null
 */
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
