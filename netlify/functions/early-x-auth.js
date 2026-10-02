'use strict';
/*
 * EARLY creator identity for X: OAuth 2.0 Authorization Code with PKCE (S256), confidential web app, scope `users.read` only.
 * Two GET shapes, both answer with a 302 to the FIXED creator page (never a caller-supplied location):
 *
 *   /api/early-x-auth?start=<stateToken>        -> X consent (users.read only, no offline.access, PKCE S256)
 *   /api/early-x-auth?code=…&state=<stateToken> -> exchange the code server-side, read GET /2/users/me, DISCARD the access
 *                                                  token, store a 15-minute OAuth link record bound to the wallet that
 *                                                  requested the state, issue a 2 h creator session and redirect to
 *                                                  /labs/early/creator#s=<session> (fragment: never server-visible, never
 *                                                  logged). Errors: #e=<fixed code>.
 *
 * The state token is the same HMAC token creator-link issues from a wallet signature, bound to platform `x`, single use
 * (consumed atomically before any token is exchanged). The PKCE code_verifier is DERIVED on the server from the state
 * (HMAC under the session secret): the browser never sees or supplies it and nothing is stored. The immutable identity is
 * the numeric user id (a string) returned by the AUTHENTICATED /2/users/me call; the @username is display metadata only.
 * No refresh token, no extra scopes. Stored: user id, display name, avatar URL, @username, the follower count read at that
 * moment, the wallet and the time. Closed unless X is explicitly enabled (SYNCNET_EARLY_X_ENABLED=true + all prerequisites).
 */
const { json, publicError, tooManyRequests } = require('../lib/respond');
const { log, logError, hashId } = require('../lib/log');
const { getStore } = require('../lib/store');
const { clientIp, limit, limitAll } = require('../lib/ratelimit');
const { query, method: methodOf } = require('../lib/body');
const { earlyConfig, platformEnabled } = require('../lib/early-config');
const Session = require('../lib/early-session');
const { makeX, deriveVerifier, pkceChallenge, OAUTH_SCOPE } = require('../lib/early-x');
const E = require('../../lib/syncnet-early.js');

const FN = 'early-x-auth';
const RETURN = '/labs/early/creator';
const PLATFORM = 'x';
const K = { link: (sid) => `early:oauth:v1:${sid}`, state: (nonce) => `early:oauth-state:v1:${nonce}` };
const redirect = (location) => json(302, null, { location, 'cache-control': 'no-store' });
const fail = (code) => redirect(RETURN + '#e=' + encodeURIComponent(code));

async function handler(event = {}, deps = {}) {
  if (methodOf(event) !== 'GET') return publicError(405, 'method_not_allowed', 'GET only.', { allow: 'GET' });
  const store = deps.store || getStore();
  const env = deps.env || process.env;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const cfg = earlyConfig({ env, store, now, keysFile: deps.keysFile, assetsFile: deps.assetsFile });
  if (!cfg.enabled || !cfg.writesEnabled || !platformEnabled(cfg, PLATFORM)) return fail('closed'); // X is closed unless explicitly enabled
  const secret = Session.secret(env);
  if (!secret || !cfg.sessions.configured) return fail('unavailable');
  const ip = clientIp(event);
  const rl = await limitAll(store, [{ bucket: 'early-x-oauth', id: ip, limit: 5, windowSeconds: 60, now }, { bucket: 'early-x-oauth-d', id: ip, limit: 30, windowSeconds: 86400, now }]);
  if (!rl.allowed) return rl.reason === 'store-unavailable' ? fail('unavailable') : tooManyRequests(rl.retryAfter);
  const x = deps.x || makeX({ fetch: deps.fetch, clientId: env.SYNCNET_X_CLIENT_ID, clientSecret: env.SYNCNET_X_CLIENT_SECRET, redirect: cfg.x.redirect });

  const start = query(event, 'start');
  if (start) {
    const st = Session.verify(start, { scope: 'state', now, env });
    if (!st || st.platform !== PLATFORM) return fail('state'); // only a state issued for X is redeemable here
    try { return redirect(x.authUrl(start, pkceChallenge(deriveVerifier(secret, start)))); } catch (err) { logError(FN, 'auth-url', err, {}); return fail('unavailable'); }
  }

  const code = query(event, 'code'), state = query(event, 'state');
  if (query(event, 'error')) { log(FN, 'consent-denied', { ip: hashId(ip) }); return fail('denied'); }
  if (!code || !state) return fail('state');
  const st = Session.verify(state, { scope: 'state', now, env });
  if (!st || st.platform !== PLATFORM) return fail('state');
  // global spend guard (API requests per UTC day), checked BEFORE the single-use state is consumed so a refusal is retryable
  const budget = deps.xBudget || cfg.xBudget;
  const bg = await limit(store, { bucket: 'early-x-api-day', id: 'oauth', limit: budget.oauthPerDay, windowSeconds: 86400, now });
  if (!bg.allowed) { log(FN, 'budget-exhausted', { bucket: 'oauth' }); return fail('unavailable'); }
  // single use: the state nonce (sid) is consumed atomically before any token is exchanged
  let consumed = false;
  try { consumed = await store.cas({ expect: [[K.state(st.sid), null]], set: [[K.state(st.sid), '1', Session.TTL.state + 120]] }); } catch (err) { logError(FN, 'store-unavailable', err, {}); return fail('unavailable'); }
  if (!consumed) return fail('state');
  let user = null;
  try {
    const token = await x.exchangeCode(code, deriveVerifier(secret, state)); // held in this scope only; never stored, never logged
    user = await x.me(token);
  } catch (err) {
    log(FN, 'oauth-failed', { code: err && err.code ? err.code : 'error', ip: hashId(ip) });
    return fail(err && (err.code === 'denied' || err.code === 'scope') ? 'denied' : 'unavailable');
  }
  if (!user || !E.isExternalId(PLATFORM, user.externalId)) return fail('no_account');
  const session = Session.issue({ scope: 'creator', wallet: st.wallet, platform: PLATFORM, externalId: user.externalId, now, env });
  if (!session) return fail('unavailable');
  const sid = session.split('.')[4];
  // `channelId` keeps its v1 name for the external id (the signed manifest field is called the same)
  const link = { platform: PLATFORM, wallet: st.wallet, channelId: user.externalId, title: E.clean(user.title, 80), avatarUrl: user.avatarUrl || '', handle: E.clean(user.handle, 40), followerCount: user.followerCount, at: Math.floor(now() / 1000), scope: OAUTH_SCOPE };
  try { await store.set(K.link(sid), JSON.stringify(link), { ttlSeconds: E.CONST.OAUTH_LINK_TTL_S }); } catch (err) { logError(FN, 'store-unavailable', err, {}); return fail('unavailable'); }
  log(FN, 'linked', { account: hashId(E.refOf(PLATFORM, user.externalId)), wallet: hashId(st.wallet) });
  return redirect(RETURN + '#s=' + encodeURIComponent(session));
}

exports.handler = (event) => handler(event);
exports._handler = handler;
exports._internals = { K, RETURN };
