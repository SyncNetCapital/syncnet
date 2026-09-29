'use strict';
// YouTube Data API v3 + Google OAuth 2.0 client for EARLY (server only). Identity = the immutable channel id.
//
//   makeYouTube({fetch, apiKey, clientId, clientSecret, redirect, timeoutMs}) ->
//     resolve(input)            channel URL / @handle / channel id / legacy username -> {channelId, title, avatarUrl, handle} | null
//     channelsById(ids)         ≤ 50 ids -> Map(channelId -> {channelId, title, avatarUrl, handle, subscriberCount|null, hidden})
//     authUrl(state)            the Google consent URL (youtube.readonly only, online access, no refresh token)
//     exchangeCode(code)        -> access token (kept in memory by the caller for ONE request, never stored)
//     mine(accessToken)         -> the signed-in account's channel (same shape as channelsById values) | null
//
// Every request has a hard timeout, follows no redirects, and never retries a 4xx. Quota: channels.list = 1 unit.
// Nothing here logs tokens; errors carry a fixed `code` for the caller's public message.
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const API = 'https://www.googleapis.com/youtube/v3/channels';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE = /^@?([A-Za-z0-9._-]{3,30})$/;

class YouTubeError extends Error {
  constructor(code, message, extra) { super(message || code); this.name = 'YouTubeError'; this.code = code; Object.assign(this, extra || {}); }
}

/** Parses what a fan pastes: a channel id, an @handle, a youtube.com URL (channel/@handle/c/user), a bare name. */
function parseInput(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s || s.length > 200) return null;
  if (CHANNEL.test(s)) return { kind: 'id', value: s };
  if (s.startsWith('@')) { const m = HANDLE.exec(s); return m ? { kind: 'handle', value: '@' + m[1] } : null; }
  let u = null;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { u = null; }
  if (u && /(^|\.)youtube\.com$/i.test(u.hostname)) {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'channel' && CHANNEL.test(parts[1] || '')) return { kind: 'id', value: parts[1] };
    if (parts[0] && parts[0].startsWith('@')) { const m = HANDLE.exec(decodeURIComponent(parts[0])); return m ? { kind: 'handle', value: '@' + m[1] } : null; }
    if ((parts[0] === 'c' || parts[0] === 'user') && parts[1]) { const m = HANDLE.exec(parts[1]); return m ? { kind: parts[0] === 'user' ? 'username' : 'handle', value: parts[0] === 'user' ? m[1] : '@' + m[1] } : null; }
    return null;
  }
  const m = HANDLE.exec(s);
  return m ? { kind: 'handle', value: '@' + m[1] } : null;
}

function channelOf(item) {
  if (!item || !CHANNEL.test(String(item.id || ''))) return null;
  const sn = item.snippet || {}, st = item.statistics || {};
  const thumb = sn.thumbnails && (sn.thumbnails.default || sn.thumbnails.medium || sn.thumbnails.high);
  const avatar = thumb && /^https:\/\/[^\s"'<>]{1,300}$/.test(String(thumb.url || '')) ? String(thumb.url) : '';
  const hidden = st.hiddenSubscriberCount === true;
  const count = !hidden && /^\d{1,12}$/.test(String(st.subscriberCount == null ? '' : st.subscriberCount)) ? Number(st.subscriberCount) : null;
  return { channelId: item.id, title: String(sn.title || '').slice(0, 200), avatarUrl: avatar, handle: /^@[A-Za-z0-9._-]{3,30}$/.test(String(sn.customUrl || '')) ? String(sn.customUrl) : '', subscriberCount: count, hidden };
}

function makeYouTube(options = {}) {
  const doFetch = options.fetch || globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000;
  const apiKey = String(options.apiKey || '');
  const clientId = String(options.clientId || ''), clientSecret = String(options.clientSecret || ''), redirect = String(options.redirect || '');

  async function request(url, init) {
    if (typeof doFetch !== 'function') throw new YouTubeError('unavailable', 'fetch missing');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res, data;
    try {
      res = await doFetch(url, { ...init, signal: ctl.signal, redirect: 'error' });
      const text = await res.text();
      try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
    } catch (err) {
      throw new YouTubeError('unavailable', ctl.signal.aborted ? 'timeout' : 'network', { cause: String(err && err.message).slice(0, 120) });
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new YouTubeError(res.status === 403 && data && /quota/i.test(JSON.stringify(data.error || '')) ? 'quota' : res.status >= 500 ? 'unavailable' : 'denied', 'HTTP ' + res.status, { status: res.status });
    if (!data || typeof data !== 'object') throw new YouTubeError('malformed', 'bad json');
    return data;
  }
  const list = async (params) => {
    if (!apiKey) throw new YouTubeError('not_configured', 'no api key');
    const q = new URLSearchParams({ ...params, key: apiKey });
    const data = await request(API + '?' + q.toString(), { method: 'GET', headers: { accept: 'application/json' } });
    return Array.isArray(data.items) ? data.items.map(channelOf).filter(Boolean) : [];
  };

  return Object.freeze({
    OAUTH_SCOPE, parseInput, channelOf,
    async resolve(input) {
      const p = parseInput(input);
      if (!p) return null;
      const items = p.kind === 'id' ? await list({ part: 'snippet', id: p.value }) : p.kind === 'username' ? await list({ part: 'snippet', forUsername: p.value }) : await list({ part: 'snippet', forHandle: p.value });
      return items[0] || null;
    },
    async channelsById(ids) {
      const clean = [...new Set((ids || []).filter((x) => CHANNEL.test(String(x))))].slice(0, 50);
      const out = new Map();
      if (!clean.length) return out;
      for (const c of await list({ part: 'snippet,statistics', id: clean.join(','), maxResults: '50' })) out.set(c.channelId, c);
      return out;
    },
    authUrl(state) {
      if (!clientId || !redirect) throw new YouTubeError('not_configured', 'oauth');
      const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: OAUTH_SCOPE, access_type: 'online', include_granted_scopes: 'false', prompt: 'select_account', state: String(state) });
      return AUTH_URL + '?' + q.toString();
    },
    async exchangeCode(code) {
      if (!clientId || !clientSecret || !redirect) throw new YouTubeError('not_configured', 'oauth');
      if (typeof code !== 'string' || !/^[A-Za-z0-9._\/-]{10,512}$/.test(code)) throw new YouTubeError('denied', 'bad code');
      const body = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' });
      const data = await request(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() });
      const token = typeof data.access_token === 'string' ? data.access_token : '';
      if (!token) throw new YouTubeError('denied', 'no token');
      if (typeof data.scope === 'string' && !data.scope.split(/\s+/).includes(OAUTH_SCOPE)) throw new YouTubeError('scope', 'scope not granted');
      return token;
    },
    async mine(accessToken) {
      const q = new URLSearchParams({ part: 'id,snippet,statistics', mine: 'true' });
      const data = await request(API + '?' + q.toString(), { method: 'GET', headers: { accept: 'application/json', authorization: 'Bearer ' + accessToken } });
      const items = Array.isArray(data.items) ? data.items.map(channelOf).filter(Boolean) : [];
      return items[0] || null;
    },
  });
}

module.exports = { makeYouTube, parseInput, channelOf, YouTubeError, OAUTH_SCOPE };
