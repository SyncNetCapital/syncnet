'use strict';
// Server-side rollout gate for every SyncNet-operated service that the public could use.
// A public feature is ON only when its env flag is exactly "true" AND its prerequisites are configured;
// otherwise it is OFF, whatever the browser or the URL says. Nothing here is controlled by the client.
//
//   SYNCNET_PUBLIC_LAUNCH=true         live launch controls for everyone (needs a durable store)
//   SYNCNET_PUBLIC_UPLOADS=true        wallet-signed image uploads for everyone (needs PINATA_JWT,
//                                      SYNCNET_UPLOAD_KEY >= 32 chars and a durable store)
//   SYNCNET_REGISTRY_SUBMISSIONS=true  public, chain-verified registry submissions (needs a durable store)
//   SYNCNET_UPLOADS_DISABLED=true      kill switch: refuses every upload, founder uploads included
//   SYNCNET_MARKETPLACE_DISABLED=true  kill switch for Marketplace writes; Marketplace also needs the durable store
//   SYNCNET_ECONOMY_CURATION=true      signed Economy curation writes (needs a durable store)
//   SYNCNET_ECONOMIES_DISABLED=true    kill switch for Economy curation writes
//   SYNCNET_PONS_DISCOVERY_ENABLED=true  PONS V2 discovery: /api/pons-economy, the scheduled indexer, the PONS V2
//                                      sections of Economy + Network Map and PONS-aware curation (needs a durable store)
//   SYNCNET_PUMP_DISCOVERY_ENABLED=true  Solana Pump.fun discovery (non-SOL quotes): /api/pump-economy and the scheduled
//                                      pump-indexer (needs a durable store; the indexer also needs SYNCNET_SOLANA_RPC_URL)
//   SYNCNET_EARLY_ENABLED=true         Labs · EARLY (SYNC Proof) behind /labs/early (needs a durable store; further
//                                      prerequisites in netlify/lib/early-config.js). SYNCNET_EARLY_DISABLED=true kills it.
//
// "Durable store" = Upstash Redis REST (see store.js). Without it, rate limits and quotas would only be
// per function instance, which is not enough for anything public.
const { getStore } = require('./store');
const { log } = require('./log');

const truthy = (v) => String(v == null ? '' : v).trim().toLowerCase() === 'true';
const strongSecret = (v) => String(v == null ? '' : v).length >= 32;

let warned = '';

function flags(options = {}) {
  const env = options.env || process.env;
  let durable = false;
  try {
    const store = options.store || getStore();
    durable = Boolean(store && store.durable);
  } catch {
    durable = false;
  }
  const uploadsKilled = truthy(env.SYNCNET_UPLOADS_DISABLED);
  const pinata = Boolean(String(env.PINATA_JWT || '').trim());
  const sessions = strongSecret(env.SYNCNET_UPLOAD_KEY);
  const requested = {
    publicLaunch: truthy(env.SYNCNET_PUBLIC_LAUNCH),
    publicUploads: truthy(env.SYNCNET_PUBLIC_UPLOADS),
    registrySubmissions: truthy(env.SYNCNET_REGISTRY_SUBMISSIONS),
    economyCuration: truthy(env.SYNCNET_ECONOMY_CURATION),
    ponsDiscovery: truthy(env.SYNCNET_PONS_DISCOVERY_ENABLED),
    pumpDiscovery: truthy(env.SYNCNET_PUMP_DISCOVERY_ENABLED),
    early: truthy(env.SYNCNET_EARLY_ENABLED),
  };
  const marketplaceKilled = truthy(env.SYNCNET_MARKETPLACE_DISABLED);
  const earlyKilled = truthy(env.SYNCNET_EARLY_DISABLED);
  const economiesKilled = truthy(env.SYNCNET_ECONOMIES_DISABLED);
  const out = {
    durable,
    uploadsKilled,
    marketplace: durable && !marketplaceKilled,
    founderUploads: !uploadsKilled && pinata && sessions,
    publicUploads: requested.publicUploads && !uploadsKilled && pinata && sessions && durable,
    publicLaunch: requested.publicLaunch && durable,
    registrySubmissions: requested.registrySubmissions && durable,
    economyCuration: requested.economyCuration && durable && !economiesKilled,
    ponsDiscovery: requested.ponsDiscovery && durable,
    pumpDiscovery: requested.pumpDiscovery && durable,
    // Labs · EARLY (SYNC Proof): /api/early, the OAuth function, both scheduled jobs. Its own module
    // (netlify/lib/early-config.js) checks the further prerequisites (keys, OAuth, YouTube); this is the master switch.
    early: requested.early && durable && !earlyKilled,
    requested,
  };
  // Log (once per instance and configuration) when a requested public feature stays closed.
  const missing = [];
  if (requested.publicLaunch && !out.publicLaunch) missing.push('SYNCNET_PUBLIC_LAUNCH needs a durable store (UPSTASH_REDIS_REST_URL/TOKEN)');
  if (requested.publicUploads && !out.publicUploads) {
    const why = [];
    if (uploadsKilled) why.push('SYNCNET_UPLOADS_DISABLED is true');
    if (!pinata) why.push('PINATA_JWT missing');
    if (!sessions) why.push('SYNCNET_UPLOAD_KEY missing or < 32 chars');
    if (!durable) why.push('no durable store');
    missing.push('SYNCNET_PUBLIC_UPLOADS stays closed: ' + why.join(', '));
  }
  if (requested.registrySubmissions && !out.registrySubmissions) missing.push('SYNCNET_REGISTRY_SUBMISSIONS needs a durable store');
  if (requested.economyCuration && !out.economyCuration) missing.push('SYNCNET_ECONOMY_CURATION stays closed: ' + (economiesKilled ? 'SYNCNET_ECONOMIES_DISABLED is true' : 'no durable store'));
  if (requested.ponsDiscovery && !out.ponsDiscovery) missing.push('SYNCNET_PONS_DISCOVERY_ENABLED needs a durable store');
  if (requested.pumpDiscovery && !out.pumpDiscovery) missing.push('SYNCNET_PUMP_DISCOVERY_ENABLED needs a durable store');
  if (requested.early && !out.early) missing.push('SYNCNET_EARLY_ENABLED stays closed: ' + (earlyKilled ? 'SYNCNET_EARLY_DISABLED is true' : 'no durable store'));
  const key = missing.join('|');
  if (key && key !== warned) {
    warned = key;
    log('flags', 'public-feature-closed', { problems: missing });
  }
  return out;
}

module.exports = { flags, truthy };
