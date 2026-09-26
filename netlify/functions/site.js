'use strict';
/*
 * GET /site/<lowercase-token> — the public, server-rendered SyncNet Project Home.
 *
 *  - ZERO client-side JavaScript; one static stylesheet allowed by its SHA-256 hash; images only from this origin
 *    (/site-img/<cid>, sanitised + hash-verified); no frames, forms, objects, base, fonts or connections:
 *      default-src 'none'; style-src 'sha256-…'; img-src 'self'; base-uri 'none'; form-action 'none';
 *      frame-ancestors 'none'
 *  - every value comes from the stored SIGNED revision (operator content), its server-derived facts snapshot, and
 *    the LIVE Project Passport (current operator). Nothing comes from the request except the token in the path;
 *  - RENDER-TIME AUTHORITY: the revision signer is compared to the CURRENT Passport operator on every request. After
 *    a Passport transfer the page says PUBLISHED BY PREVIOUS OPERATOR · AWAITING CONFIRMATION and every
 *    operator-authored external link is rendered NON-CLICKABLE until the new operator adopts the site (a new
 *    signature, no payment). Responses are never cached, so a transfer takes effect on the next request;
 *  - shown only while the project's entitlement is ACTIVE/FINALIZED and the site is PUBLISHED; closed unless
 *    SYNCNET_PROJECT_HOME_ENABLED=true with a durable store. Store failure fails closed (503, nothing rendered).
 */
const crypto = require('crypto');
const Site = require('../../lib/syncnet-site.js');
const { getStore } = require('../lib/store');
const { clientIp, limit } = require('../lib/ratelimit');
const { logError } = require('../lib/log');
const { readPassport } = require('../lib/live-project');
const { projectHomeConfig } = require('../lib/project-home-config');

const STYLE_HASH = "'sha256-" + crypto.createHash('sha256').update(Site.STYLESHEET, 'utf8').digest('base64') + "'";
const CSP = `default-src 'none'; style-src ${STYLE_HASH}; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
const HEADERS = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
});
const PAID = new Set(['ACTIVE', 'FINALIZED']);

function page(statusCode, title, message) {
  const body = ['<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">', `<title>${Site.escapeHtml(title)} · SyncNet</title>`, `<style>${Site.STYLESHEET}</style>`, '</head>',
    '<body class="preset-clean accent-slate">', '<div class="wrap">', '<header class="identity">', `<h1>${Site.escapeHtml(title)}</h1>`, `<p>${Site.escapeHtml(message)}</p>`, '</header>', '</div>', '</body>', '</html>'].join('\n');
  return { statusCode, headers: { ...HEADERS }, body };
}
const notFound = () => page(404, 'Not found', 'No SyncNet Project Home is published at this address.');

function tokenFromEvent(event) {
  const q = event && event.queryStringParameters && typeof event.queryStringParameters.token === 'string' ? event.queryStringParameters.token : '';
  // The original request path when Netlify provides it; otherwise the :token the rewrite passed as a query parameter.
  for (const p of [String((event && event.path) || ''), String((event && event.rawUrl) || '')]) {
    const m = /\/site\/([^/?#]+)\/?(?:[?#].*)?$/.exec(p);
    if (m) return m[1];
  }
  return q;
}

async function getJson(store, key) {
  const raw = await store.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function handler(event = {}, deps = {}) {
  const method = String(event.httpMethod || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return { ...page(405, 'Method not allowed', 'Only GET is supported.'), headers: { ...HEADERS, allow: 'GET, HEAD' } };
  const store = deps.store || getStore();
  const env = deps.env || process.env;
  const cfg = projectHomeConfig({ env, store });
  if (!cfg.siteEnabled) return notFound(); // closed: indistinguishable from "nothing published"
  const raw = tokenFromEvent(event);
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return notFound();
  if (raw !== raw.toLowerCase()) return { statusCode: 301, headers: { ...HEADERS, location: '/site/' + raw.toLowerCase() }, body: '' };
  const token = raw;
  try {
    const rl = await limit(store, { bucket: 'ph-site', id: clientIp(event), limit: 240, windowSeconds: 60 });
    if (!rl.allowed) return rl.reason === 'store-unavailable' ? page(503, 'Temporarily unavailable', 'This Project Home cannot be shown right now.') : { ...page(429, 'Too many requests', 'Please wait and try again.'), headers: { ...HEADERS, 'retry-after': String(rl.retryAfter || 60) } };
    const cur = await getJson(store, `site:cur:v1:${token}`);
    if (!cur || cur.state !== 'PUBLISHED' || !/^0x[0-9a-f]{64}$/.test(String(cur.revisionId || ''))) return notFound();
    const [ent, rev, passport] = await Promise.all([getJson(store, `site:entitlement:v1:${token}`), getJson(store, `site:rev:v1:${cur.revisionId}`), readPassport(store, token)]);
    if (!ent || !PAID.has(ent.status)) return page(503, 'Project Home unavailable', 'This Project Home is not available right now (its activation is being reconciled).');
    if (!rev || rev.token !== token || rev.configHash !== cur.configHash) return page(503, 'Project Home unavailable', 'This Project Home cannot be shown right now.');
    const facts = { ...(rev.facts || {}), token, passport: passport ? { operator: String(passport.operator || '').toLowerCase(), operatorSince: passport.operatorSince || '' } : null };
    const html = Site.render({ config: rev.config, facts, authority: { signer: rev.signer }, revision: rev, mode: 'published' });
    return { statusCode: 200, headers: { ...HEADERS }, body: method === 'HEAD' ? '' : html };
  } catch (err) {
    logError('site', 'render-failed', err, { token });
    return page(503, 'Temporarily unavailable', 'This Project Home cannot be shown right now.');
  }
}

exports.handler = (event) => handler(event);
exports._handler = handler;
exports._internals = { CSP, HEADERS, STYLE_HASH };
