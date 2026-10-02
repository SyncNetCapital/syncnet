'use strict';
// X (Twitter) API v2 + OAuth 2.0 (Authorization Code with PKCE) client for EARLY (server only).
// Identity = the immutable NUMERIC USER ID, always carried as a STRING (ids exceed 2^53: never parsed as a JS number).
// The @username, display name and avatar are mutable display metadata and are never identity.
//
//   makeX({fetch, bearer, clientId, clientSecret, redirect, timeoutMs}) ->
//     parseInput(input)      what a fan pastes -> {kind:'username'|'id', value} | null (reserved / non-user paths are null)
//     resolve(input)         username / URL / id -> user | null          (app-only bearer)
//     usersById(ids)         <= 100 ids -> Map(id -> user)               (app-only bearer; audience snapshots)
//     authUrl(state, challenge)   the consent URL: scopes "tweet.read users.read" and nothing else, no offline.access, PKCE S256
//     exchangeCode(code, verifier)  -> user access token (held in memory by the caller for ONE request, never stored)
//     me(accessToken)        -> the signed-in account (authoritative for the immutable id)
//   user = {externalId, username, title (display name), handle ('@username'), avatarUrl, followerCount|null, protected}
//
// PKCE: the code_verifier is DERIVED on the server (HMAC of the OAuth state under the session secret, own domain), so the
// browser never holds or supplies it and nothing has to be stored. Every request has a hard timeout, follows no
// redirects and never retries; errors carry a fixed `code`. Nothing here logs or returns tokens or the client secret.
const crypto = require('crypto');

// EXACTLY these two scopes, nothing else (no tweet.write, offline.access, follows.read, DM scopes). Live canary evidence: X's
// GET /2/users/me requires OAuth 2.0 user context with BOTH tweet.read and users.read; users.read alone is refused at consent.
const OAUTH_SCOPES = Object.freeze(['tweet.read', 'users.read']);
const OAUTH_SCOPE = OAUTH_SCOPES.join(' ');
const API = 'https://api.x.com/2';
const AUTH_URL = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const USER_FIELDS = 'id,name,username,profile_image_url,public_metrics,protected';
const USER_ID = /^[1-9][0-9]{0,19}$/;
const USERNAME = /^[A-Za-z0-9_]{1,15}$/;
const HOSTS = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
// First path segments of x.com / twitter.com URLs that are product pages, not accounts. Applies to URL paths ONLY: a name
// typed plainly (or with @) is always a username candidate, and the API decides whether the account exists.
const RESERVED = new Set(['home', 'i', 'explore', 'search', 'notifications', 'messages', 'settings', 'compose', 'intent', 'share', 'login', 'logout', 'signup', 'tos', 'privacy', 'about', 'hashtag', 'download', 'jobs', 'lists', 'topics', 'communities', 'premium', 'verified', 'account', 'help', 'support', 'bookmarks', 'who_to_follow', 'oauth', 'oauth2']);

class XError extends Error {
  constructor(code, message, extra) { super(message || code); this.name = 'XError'; this.code = code; Object.assign(this, extra || {}); }
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
/** RFC 7636 S256: BASE64URL(SHA256(ASCII(verifier))). */
const pkceChallenge = (verifier) => b64u(crypto.createHash('sha256').update(String(verifier), 'ascii').digest());
/** The server-held code_verifier for one OAuth state: 43 unreserved characters, unguessable without the session secret. */
function deriveVerifier(secret, state) {
  if (typeof secret !== 'string' || secret.length < 32 || typeof state !== 'string' || !state) throw new XError('not_configured', 'pkce');
  return b64u(crypto.createHmac('sha256', secret).update('syncnet-early-x-pkce|v1|' + state, 'utf8').digest());
}

/**
 * Parses what a fan pastes. `@name` is ALWAYS a username (an all-digit name is legal on X); a bare run of digits is an id;
 * x.com/i/user/<digits> and x.com/intent/user?user_id=<digits> are ids; any other first path segment is a username unless
 * it is a reserved product path. -> {kind, value} | null
 */
function parseInput(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > 200) return null;
  if (s.startsWith('@')) { const m = /^@([A-Za-z0-9_]{1,15})$/.exec(s); return m ? { kind: 'username', value: m[1] } : null; }
  if (USER_ID.test(s)) return { kind: 'id', value: s };
  if (USERNAME.test(s)) return { kind: 'username', value: s };
  let u = null;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port || !HOSTS.has(u.hostname.toLowerCase())) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (!parts.length) return null;
  if (parts[0].toLowerCase() === 'i' && parts[1] === 'user' && USER_ID.test(parts[2] || '') && parts.length === 3) return { kind: 'id', value: parts[2] };
  if (parts[0].toLowerCase() === 'intent' && parts[1] === 'user' && parts.length === 2) { const id = u.searchParams.get('user_id'); return id && USER_ID.test(id) ? { kind: 'id', value: id } : null; }
  if (RESERVED.has(parts[0].toLowerCase()) || !USERNAME.test(parts[0])) return null;
  return { kind: 'username', value: parts[0] };
}

/** One API user object -> the normalised user, or null when it is not a well-formed user (fail closed). */
function userOf(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (typeof item.id !== 'string' || !USER_ID.test(item.id)) return null; // a JSON number here would already have lost precision
  const username = typeof item.username === 'string' && USERNAME.test(item.username) ? item.username : '';
  const avatar = typeof item.profile_image_url === 'string' && /^https:\/\/[^\s"'<>]{1,300}$/.test(item.profile_image_url) ? item.profile_image_url : '';
  const pm = item.public_metrics && typeof item.public_metrics === 'object' ? item.public_metrics : null;
  const followers = pm && Number.isSafeInteger(pm.followers_count) && pm.followers_count >= 0 ? pm.followers_count : null;
  return { externalId: item.id, username, title: typeof item.name === 'string' ? item.name.slice(0, 200) : '', handle: username ? '@' + username : '', avatarUrl: avatar, followerCount: followers, protected: item.protected === true };
}

function makeX(options = {}) {
  const doFetch = options.fetch || globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000;
  const bearer = String(options.bearer || '');
  const clientId = String(options.clientId || ''), clientSecret = String(options.clientSecret || ''), redirect = String(options.redirect || '');

  async function request(url, init) {
    if (typeof doFetch !== 'function') throw new XError('unavailable', 'fetch missing');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res, data;
    try {
      res = await doFetch(url, { ...init, signal: ctl.signal, redirect: 'error' });
      const text = await res.text();
      try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
    } catch (err) {
      throw new XError('unavailable', ctl.signal.aborted ? 'timeout' : 'network', { cause: String(err && err.message).slice(0, 120) });
    } finally { clearTimeout(timer); }
    if (!res.ok) {
      const reset = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('retry-after') || 0) : 0;
      throw new XError(res.status === 429 ? 'rate_limited' : res.status === 404 ? 'not_found' : res.status >= 500 ? 'unavailable' : 'denied', 'HTTP ' + res.status, { status: res.status, retryAfter: Number.isFinite(reset) && reset > 0 ? reset : 0 });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new XError('malformed', 'bad json');
    return data;
  }
  const appGet = (path, params) => {
    if (!bearer) throw new XError('not_configured', 'no bearer');
    return request(API + path + '?' + new URLSearchParams(params).toString(), { method: 'GET', headers: { accept: 'application/json', authorization: 'Bearer ' + bearer } });
  };
  /** A single-user response: {data: user} -> user; {errors} without data (unknown / suspended / not visible) -> null; anything else is malformed. */
  function oneUser(body, want) {
    if (body.data === undefined) { if (Array.isArray(body.errors)) return null; throw new XError('malformed', 'no data'); }
    const u = userOf(body.data);
    if (!u || (want.id && u.externalId !== want.id) || (want.username && u.username.toLowerCase() !== want.username.toLowerCase())) throw new XError('malformed', 'unexpected user');
    return u;
  }

  return Object.freeze({
    OAUTH_SCOPE, OAUTH_SCOPES, parseInput, userOf,
    async resolve(input) {
      const p = parseInput(input);
      if (!p) return null;
      try {
        return p.kind === 'id'
          ? oneUser(await appGet('/users/' + p.value, { 'user.fields': USER_FIELDS }), { id: p.value })
          : oneUser(await appGet('/users/by/username/' + encodeURIComponent(p.value), { 'user.fields': USER_FIELDS }), { username: p.value });
      } catch (err) { if (err instanceof XError && err.code === 'not_found') return null; throw err; }
    },
    async usersById(ids) {
      const clean = [...new Set((ids || []).filter((x) => typeof x === 'string' && USER_ID.test(x)))].slice(0, 100);
      const out = new Map();
      if (!clean.length) return out;
      const body = await appGet('/users', { ids: clean.join(','), 'user.fields': USER_FIELDS });
      if (body.data === undefined) { if (Array.isArray(body.errors)) return out; throw new XError('malformed', 'no data'); }
      if (!Array.isArray(body.data)) throw new XError('malformed', 'data not a list');
      for (const item of body.data) { const u = userOf(item); if (u && clean.includes(u.externalId)) out.set(u.externalId, u); }
      return out;
    },
    authUrl(state, challenge) {
      if (!clientId || !redirect) throw new XError('not_configured', 'oauth');
      if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new XError('not_configured', 'pkce');
      const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: OAUTH_SCOPE, state: String(state), code_challenge: challenge, code_challenge_method: 'S256' });
      return AUTH_URL + '?' + q.toString();
    },
    async exchangeCode(code, verifier) {
      if (!clientId || !clientSecret || !redirect) throw new XError('not_configured', 'oauth');
      if (typeof code !== 'string' || !/^[A-Za-z0-9._~\/+=-]{10,512}$/.test(code)) throw new XError('denied', 'bad code');
      if (typeof verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) throw new XError('not_configured', 'pkce');
      // confidential client: the credentials travel only in the Basic header, never in the body
      const body = new URLSearchParams({ code, grant_type: 'authorization_code', redirect_uri: redirect, code_verifier: verifier });
      const basic = Buffer.from(clientId + ':' + clientSecret, 'utf8').toString('base64');
      const data = await request(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', authorization: 'Basic ' + basic }, body: body.toString() });
      const token = typeof data.access_token === 'string' ? data.access_token : '';
      if (!token || (typeof data.token_type === 'string' && data.token_type.toLowerCase() !== 'bearer')) throw new XError('denied', 'no token');
      if (typeof data.scope === 'string') { const granted = data.scope.split(/\s+/); if (!OAUTH_SCOPES.every((s) => granted.includes(s))) throw new XError('scope', 'scope not granted'); }
      return token; // a refresh_token, if X ever sent one, is ignored and never stored
    },
    async me(accessToken) {
      if (typeof accessToken !== 'string' || !accessToken) throw new XError('denied', 'no token');
      const body = await request(API + '/users/me?' + new URLSearchParams({ 'user.fields': USER_FIELDS }).toString(), { method: 'GET', headers: { accept: 'application/json', authorization: 'Bearer ' + accessToken } });
      if (body.data === undefined) throw new XError('malformed', 'no data');
      const u = userOf(body.data);
      if (!u) throw new XError('malformed', 'bad user');
      return u;
    },
  });
}

module.exports = { makeX, parseInput, userOf, pkceChallenge, deriveVerifier, XError, OAUTH_SCOPE, OAUTH_SCOPES, USER_ID, USERNAME, USER_FIELDS, AUTH_URL, TOKEN_URL, API };
