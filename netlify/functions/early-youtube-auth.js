'use strict';
/*
 * EARLY creator identity: Google / YouTube OAuth (docs §16.4). Two GET shapes, both answer with a 302:
 *
 *   /api/early-youtube-auth?start=<stateToken>       -> Google consent (scope youtube.readonly only, online access)
 *   /api/early-youtube-auth?code=…&state=<stateToken> -> exchange the code server-side, read channels.mine, discard the
 *                                                        access token, store a 15-minute OAuth link record bound to the
 *                                                        wallet that requested the state, issue a 2 h creator session and
 *                                                        redirect to /labs/early/creator#s=<session> (fragment: never a
 *                                                        server-visible URL, never logged). Errors: #e=<fixed code>.
 *
 * The state token is an HMAC token issued by /api/early {action:'creator-link'} from a wallet signature: it binds the
 * OAuth round trip to that wallet and is single use (consumed atomically here). No refresh token, no extra scopes, no
 * Google user id or e-mail is requested or stored. What is stored: channel id, title, avatar URL, handle, the public
 * subscriber count as read at that moment, the wallet, and the time.
 */
const { json, publicError, tooManyRequests } = require('../lib/respond');
const { log, logError, hashId } = require('../lib/log');
const { getStore } = require('../lib/store');
const { clientIp, limitAll } = require('../lib/ratelimit');
const { query, method: methodOf } = require('../lib/body');
const { earlyConfig } = require('../lib/early-config');
const Session = require('../lib/early-session');
const { makeYouTube } = require('../lib/early-youtube');
const E = require('../../lib/syncnet-early.js');

const FN = 'early-youtube-auth';
const RETURN = '/labs/early/creator';
const K = { link: (sid) => `early:oauth:v1:${sid}`, state: (nonce) => `early:oauth-state:v1:${nonce}` };
const redirect = (location) => json(302, null, { location, 'cache-control': 'no-store' });
const fail = (code) => redirect(RETURN + '#e=' + encodeURIComponent(code));

async function handler(event = {}, deps = {}) {
  if (methodOf(event) !== 'GET') return publicError(405, 'method_not_allowed', 'GET only.', { allow: 'GET' });
  const store = deps.store || getStore();
  const env = deps.env || process.env;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const cfg = earlyConfig({ env, store, now, keysFile: deps.keysFile, assetsFile: deps.assetsFile });
  if (!cfg.enabled || !cfg.writesEnabled) return fail('closed');
  if (!cfg.oauth.configured || !cfg.sessions.configured) return fail('unavailable');
  const ip = clientIp(event);
  const rl = await limitAll(store, [{ bucket: 'early-oauth', id: ip, limit: 5, windowSeconds: 60, now }, { bucket: 'early-oauth-d', id: ip, limit: 30, windowSeconds: 86400, now }]);
  if (!rl.allowed) return rl.reason === 'store-unavailable' ? fail('unavailable') : tooManyRequests(rl.retryAfter);
  const yt = deps.youtube || makeYouTube({ fetch: deps.fetch, apiKey: env.SYNCNET_YOUTUBE_API_KEY, clientId: env.SYNCNET_GOOGLE_CLIENT_ID, clientSecret: env.SYNCNET_GOOGLE_CLIENT_SECRET, redirect: cfg.oauth.redirect });

  const start = query(event, 'start');
  if (start) {
    const st = Session.verify(start, { scope: 'state', now, env });
    if (!st || st.platform !== E.PLATFORM) return fail('state'); // a state issued for another platform is not ours to redeem
    try { return redirect(yt.authUrl(start)); } catch (err) { logError(FN, 'auth-url', err, {}); return fail('unavailable'); }
  }

  const code = query(event, 'code'), state = query(event, 'state');
  if (query(event, 'error')) { log(FN, 'consent-denied', { ip: hashId(ip) }); return fail('denied'); }
  if (!code || !state) return fail('state');
  const st = Session.verify(state, { scope: 'state', now, env });
  if (!st || st.platform !== E.PLATFORM) return fail('state');
  // single use: the state nonce (sid) is consumed atomically before any token is exchanged
  let consumed = false;
  try { consumed = await store.cas({ expect: [[K.state(st.sid), null]], set: [[K.state(st.sid), '1', Session.TTL.state + 120]] }); } catch (err) { logError(FN, 'store-unavailable', err, {}); return fail('unavailable'); }
  if (!consumed) return fail('state');
  let channel = null;
  try {
    const token = await yt.exchangeCode(code); // held in this scope only
    channel = await yt.mine(token);
  } catch (err) {
    log(FN, 'oauth-failed', { code: err && err.code ? err.code : 'error', ip: hashId(ip) });
    return fail(err && (err.code === 'denied' || err.code === 'scope') ? 'denied' : 'unavailable');
  }
  if (!channel || !E.isChannelId(channel.channelId)) return fail('no_channel');
  const session = Session.issue({ scope: 'creator', wallet: st.wallet, platform: E.PLATFORM, externalId: channel.channelId, now, env });
  if (!session) return fail('unavailable');
  const sid = session.split('.')[4];
  // `channelId` keeps its v1 name for the external id (the signed manifest field is called the same); `platform` is new
  const link = { platform: E.PLATFORM, wallet: st.wallet, channelId: channel.channelId, title: E.clean(channel.title, 80), avatarUrl: channel.avatarUrl || '', handle: E.clean(channel.handle, 40), subscriberCount: channel.subscriberCount, hiddenSubscriberCount: Boolean(channel.hidden), at: Math.floor(now() / 1000), scope: yt.OAUTH_SCOPE };
  try { await store.set(K.link(sid), JSON.stringify(link), { ttlSeconds: E.CONST.OAUTH_LINK_TTL_S }); } catch (err) { logError(FN, 'store-unavailable', err, {}); return fail('unavailable'); }
  log(FN, 'linked', { channel: hashId(channel.channelId), wallet: hashId(st.wallet) });
  return redirect(RETURN + '#s=' + encodeURIComponent(session));
}

exports.handler = (event) => handler(event);
exports._handler = handler;
exports._internals = { K, RETURN };
