'use strict';
// SYNC Proof / EARLY rollout gate and environment contract. Everything is CLOSED by default and decided server-side.
//
//   SYNCNET_EARLY_ENABLED=true              reads, verification, creator pages (needs a durable store)
//   SYNCNET_EARLY_WRITES_DISABLED=true      kill switch for every write (reads and verification stay up)
//   SYNCNET_EARLY_ANCHOR_DISABLED=true      kill switch for the ONE server-sent transaction (the daily anchor)
//   SYNCNET_EARLY_SESSION_KEY               >= 32 chars; sessions + OAuth state (never an attestation key)
//   SYNCNET_EARLY_ATTESTATION_KEY           32-byte hex secp256k1 private key; its address MUST be listed in
//   SYNCNET_EARLY_ATTESTATION_KEY_ID        syncnet-early-keys.json under this keyId (public registry, git-reviewed)
//   SYNCNET_EARLY_ANCHOR_KEY                32-byte hex; gas-only key; its address MUST be in the registry's `anchor` list
//   SYNCNET_GOOGLE_CLIENT_ID / SYNCNET_GOOGLE_CLIENT_SECRET / SYNCNET_EARLY_OAUTH_REDIRECT   YouTube OAuth
//   SYNCNET_YOUTUBE_API_KEY                 YouTube Data API v3 (resolver + daily snapshots)
//   EARLY_GETLOGS_CHUNK                     optional; blocks per eth_getLogs call (default 50000; measured, see below)
//
// Private keys never leave this module except as a closure that signs a digest (signer()). Nothing here is ever
// serialised into a response. Any missing prerequisite closes the related capability and is logged once.
const Core = require('../../lib/syncnet-core.js');
const E = require('../../lib/syncnet-early.js');
const ASSETS_FILE = require('../../syncnet-early-assets.json');
const KEYS_FILE = require('../../syncnet-early-keys.json');
const { log } = require('./log');
const Session = require('./early-session');

// Which identity platforms this deployment ACCEPTS (cfg.platforms[p].enabled; every request path asks before using one).
// YouTube is always accepted. X is accepted ONLY when SYNCNET_EARLY_X_ENABLED is exactly "true" AND every X prerequisite is
// present: credentials alone never open it, and a missing prerequisite closes it again.
//   SYNCNET_EARLY_X_ENABLED=true            the explicit switch (absent / anything else = X is closed)
//   SYNCNET_X_CLIENT_ID / SYNCNET_X_CLIENT_SECRET    X OAuth 2.0 confidential web app (creator sign-in)
//   SYNCNET_X_BEARER_TOKEN                  X API app-only token (resolver + daily follower snapshots)
//   SYNCNET_EARLY_X_OAUTH_REDIRECT          exact https callback, ending in /api/early-x-auth
// Spend guard: X is a metered API. These caps count API REQUESTS (never currency) per UTC day, so a bug or an abuse
// cannot burn the account's allowance; a denied request fails closed and is retried later.
const X_BUDGET = Object.freeze({ resolvePerDay: 300, resolvePerHour: 60, oauthPerDay: 200, snapshotRequestsPerDay: 48 });
const X_REDIRECT = /^https:\/\/[^\s/?#]+\/api\/early-x-auth$/;
const truthy = (v) => String(v == null ? '' : v).trim().toLowerCase() === 'true';
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
let warned = '';

function keyAddress(hex) {
  const s = String(hex || '').trim();
  if (!HEX32.test(s)) return null;
  try { return E.lc(Core._internal.secp256k1.privateKeyToAddress(s)); } catch { return null; }
}
const validNow = (k, nowMs) => k && Date.parse(k.validFrom) <= nowMs && (k.validUntil == null || Date.parse(k.validUntil) > nowMs);

/**
 * earlyConfig({env, store, now, assetsFile, keysFile}) -> {
 *   enabled, writesEnabled, anchorEnabled, durable, reasons,
 *   assets: Map, assetsJson, registry, chainId,
 *   attestation: {configured, keyId, address}, anchor: {configured, address},
 *   oauth: {configured, clientId, redirect}, youtube: {configured}, x: {requested, configured, missing[names], redirect},
 *   platforms: {youtube:{enabled,oauth,resolver}, x:{enabled,oauth,resolver}}, xBudget, sessions: {configured}, getLogsChunk }
 */
function earlyConfig(options = {}) {
  const env = options.env || process.env;
  const nowMs = typeof options.now === 'function' ? options.now() : Date.now();
  const durable = Boolean(options.store && options.store.durable);
  const reasons = [];
  const requested = truthy(env.SYNCNET_EARLY_ENABLED);
  if (!requested) reasons.push('SYNCNET_EARLY_ENABLED is not true');
  if (requested && !durable) reasons.push('no durable store');
  if (requested && truthy(env.SYNCNET_EARLY_DISABLED)) reasons.push('SYNCNET_EARLY_DISABLED is true');
  const enabled = requested && durable && !truthy(env.SYNCNET_EARLY_DISABLED);
  const writesEnabled = enabled && !truthy(env.SYNCNET_EARLY_WRITES_DISABLED);
  if (enabled && !writesEnabled) reasons.push('SYNCNET_EARLY_WRITES_DISABLED is true');

  let assets = null, assetsJson = null;
  try { assetsJson = options.assetsFile || ASSETS_FILE; assets = E.parseAssetList(assetsJson); } catch (err) { reasons.push('assets file invalid: ' + err.message); }
  let registry = null;
  try { registry = E.parseKeyRegistry(options.keysFile || KEYS_FILE); } catch (err) { reasons.push('keys file invalid: ' + err.message); }

  const sessions = { configured: Boolean(Session.secret(env)) };
  if (!sessions.configured) reasons.push('SYNCNET_EARLY_SESSION_KEY missing or < 32 chars');

  const keyId = String(env.SYNCNET_EARLY_ATTESTATION_KEY_ID || '').trim();
  const attAddr = keyAddress(env.SYNCNET_EARLY_ATTESTATION_KEY);
  const attEntry = registry && keyId ? E.keyById(registry, keyId) : null;
  const attestation = { configured: Boolean(attAddr && attEntry && E.lc(attEntry.address) === attAddr && validNow(attEntry, nowMs)), keyId: keyId || null, address: attEntry ? E.lc(attEntry.address) : null };
  if (!attestation.configured) reasons.push(!attAddr ? 'SYNCNET_EARLY_ATTESTATION_KEY missing or malformed' : !attEntry ? 'SYNCNET_EARLY_ATTESTATION_KEY_ID not in syncnet-early-keys.json' : E.lc(attEntry.address) !== attAddr ? 'attestation key address does not match the registry entry' : 'attestation key is outside its validity window');

  const anchorAddr = keyAddress(env.SYNCNET_EARLY_ANCHOR_KEY);
  const anchorEntry = registry && anchorAddr ? (registry.anchor || []).find((k) => E.lc(k.address) === anchorAddr) : null;
  const anchor = { configured: Boolean(anchorAddr && anchorEntry && validNow(anchorEntry, nowMs)), address: anchorAddr && anchorEntry ? anchorAddr : null };
  if (!anchor.configured) reasons.push(!anchorAddr ? 'SYNCNET_EARLY_ANCHOR_KEY missing or malformed' : 'anchor key address is not a valid registry anchor entry');
  if (anchorAddr && attAddr && anchorAddr === attAddr) { anchor.configured = false; attestation.configured = false; reasons.push('anchor and attestation keys must differ'); }
  const anchorEnabled = enabled && anchor.configured && !truthy(env.SYNCNET_EARLY_ANCHOR_DISABLED);

  const redirect = String(env.SYNCNET_EARLY_OAUTH_REDIRECT || '').trim();
  const oauth = { configured: Boolean(String(env.SYNCNET_GOOGLE_CLIENT_ID || '').trim() && String(env.SYNCNET_GOOGLE_CLIENT_SECRET || '').trim() && /^https:\/\/[^\s/?#]+\/api\/early-youtube-auth$/.test(redirect)), clientId: String(env.SYNCNET_GOOGLE_CLIENT_ID || '').trim() || null, redirect: redirect || null };
  if (!oauth.configured) reasons.push('Google OAuth not configured (client id/secret, https redirect ending in /api/early-youtube-auth)');
  const youtube = { configured: Boolean(String(env.SYNCNET_YOUTUBE_API_KEY || '').trim()) };
  if (!youtube.configured) reasons.push('SYNCNET_YOUTUBE_API_KEY missing');
  // X: names only are ever reported (never values)
  const has = (k) => Boolean(String(env[k] == null ? '' : env[k]).trim());
  const xRedirect = String(env.SYNCNET_EARLY_X_OAUTH_REDIRECT || '').trim();
  const xMissing = ['SYNCNET_X_CLIENT_ID', 'SYNCNET_X_CLIENT_SECRET', 'SYNCNET_X_BEARER_TOKEN'].filter((k) => !has(k)).concat(X_REDIRECT.test(xRedirect) ? [] : ['SYNCNET_EARLY_X_OAUTH_REDIRECT (https, ending in /api/early-x-auth)']);
  const x = { requested: truthy(env.SYNCNET_EARLY_X_ENABLED), configured: xMissing.length === 0, missing: xMissing, redirect: X_REDIRECT.test(xRedirect) ? xRedirect : null };
  if (requested && x.requested && !x.configured) reasons.push('X requested but not configured: ' + xMissing.join(', '));
  const platforms = Object.freeze({
    youtube: Object.freeze({ enabled: true, oauth: oauth.configured, resolver: youtube.configured }),
    x: Object.freeze({ enabled: x.requested && x.configured, oauth: x.configured, resolver: x.configured }),
  });
  // Measured on the public Robinhood Chain RPC on 29 Sep 2026 (tests/live/early-rpc-capability.mjs): eth_getLogs is
  // capped by RESULT count (10,000 logs), not by block range; the exact three-topic EARLY filter succeeds across
  // 200,000 blocks in one call. At ≈0.1 s/block a 2 h window is ≈71,000 blocks: 50,000-block chunks = 2 calls.
  const chunk = Number(env.EARLY_GETLOGS_CHUNK);
  const getLogsChunk = Number.isInteger(chunk) && chunk >= 100 && chunk <= 200000 ? chunk : 50000;

  if (requested) {
    const key = reasons.join('|');
    if (key && key !== warned) { warned = key; log('early', 'public-feature-closed', { problems: reasons }); }
  }
  return { enabled, writesEnabled, anchorEnabled, durable, reasons, assets, assetsJson, registry, chainId: E.CHAIN_ID, attestation, anchor, oauth, youtube, x, platforms, xBudget: X_BUDGET, sessions, getLogsChunk };
}
/** True when this build accepts identities of `platform` (a registered platform AND enabled above). */
const platformEnabled = (cfg, platform) => E.isPlatform(platform) && Boolean(cfg && cfg.platforms && Object.prototype.hasOwnProperty.call(cfg.platforms, platform) && cfg.platforms[platform].enabled === true);

/** The attestation signer, or null. The private key stays inside the closure; only sign(digest) is exposed. */
function signer(env, cfg) {
  const e = env || process.env;
  const c = cfg || earlyConfig({ env: e });
  if (!c.attestation.configured) return null;
  const key = String(e.SYNCNET_EARLY_ATTESTATION_KEY).trim();
  return Object.freeze({ keyId: c.attestation.keyId, address: c.attestation.address, sign: (digest) => Core._internal.secp256k1.sign(digest, key) });
}
/** The anchor signer (gas-only key), or null. Only ever used by early-anchor.js through early-tx.js. */
function anchorSigner(env, cfg) {
  const e = env || process.env;
  const c = cfg || earlyConfig({ env: e });
  if (!c.anchor.configured) return null;
  const key = String(e.SYNCNET_EARLY_ANCHOR_KEY).trim();
  return Object.freeze({ address: c.anchor.address, sign: (digest) => Core._internal.secp256k1.sign(digest, key) });
}

module.exports = { earlyConfig, signer, anchorSigner, keyAddress, truthy, platformEnabled, X_BUDGET };
