'use strict';
// Project Home rollout gate and economic configuration. Everything is CLOSED by default and decided server-side.
//
//   SYNCNET_PROJECT_HOME_ENABLED=true            Project Home reads/site writes/public renderer (needs a durable store)
//   SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED=true   activation payment intents + verification (needs everything below)
//   PROJECT_HOME_PRICE_VERSION=1                 active product price version (must exist in the pricing file)
//   PROJECT_HOME_PRICE_USD_CENTS=3900            must EQUAL that version's reviewed price (a second, explicit key)
//   PROJECT_HOME_RATE_VERSION=<n>                active SYNCNET REFERENCE RATE version (must exist, be effective and
//                                                not expired in the pricing file)
//   PROJECT_HOME_SINK_ADDRESS=0x…                the deployed SyncNetProjectHomeSink (no default exists); it must ALSO be a
//                                                reviewed deployment in syncnet-project-home-deployment.json, and it is
//                                                verified ON-CHAIN before any quote (netlify/lib/project-home-deployment.js)
//
// Prices and rates themselves live ONLY in the git-reviewed syncnet-project-home-pricing.json: a deployment can select
// a reviewed version, never type a new value into an environment variable. Any missing, malformed or inconsistent
// value closes payments (and the reason is logged once), whatever the browser says.
const Pricing = require('../../lib/syncnet-project-home-pricing.js');
const PRICING_FILE = require('../../syncnet-project-home-pricing.json');
const { log } = require('./log');
const { loadDeployment } = require('./project-home-deployment');

const CHAIN_ID = 4663;
const CANONICAL_SYNC = '0x6368e007b9f0b941560ed1f3bceb20247f5eca37';
const ZERO = '0x0000000000000000000000000000000000000000';
const truthy = (v) => String(v == null ? '' : v).trim().toLowerCase() === 'true';
const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();
const posInt = (v) => (/^[1-9]\d{0,8}$/.test(String(v == null ? '' : v).trim()) ? Number(String(v).trim()) : null);

let warned = '';

/**
 * projectHomeConfig({env, store, file, now}) -> {
 *   durable, siteEnabled, paymentsEnabled, closedReasons: string[],
 *   chainId, sync, sink, deployment, price: {priceVersion, priceUsdCents} | null, rate: {rateVersion, …} | null }
 */
function projectHomeConfig(options = {}) {
  const env = options.env || process.env;
  const nowMs = typeof options.now === 'function' ? options.now() : Date.now();
  const durable = Boolean(options.store && options.store.durable);
  const reasons = [];
  const siteRequested = truthy(env.SYNCNET_PROJECT_HOME_ENABLED);
  const siteEnabled = siteRequested && durable;
  if (siteRequested && !durable) reasons.push('no durable store');
  if (!siteRequested) reasons.push('SYNCNET_PROJECT_HOME_ENABLED is not true');

  let table = null;
  try { table = Pricing.loadTable(options.file || PRICING_FILE); } catch (err) { reasons.push('pricing file invalid: ' + (err.code || 'error')); }

  let price = null;
  const pv = posInt(env.PROJECT_HOME_PRICE_VERSION);
  const pc = posInt(env.PROJECT_HOME_PRICE_USD_CENTS);
  if (!pv || !pc) reasons.push('PROJECT_HOME_PRICE_VERSION / PROJECT_HOME_PRICE_USD_CENTS missing');
  else if (table) {
    const p = table.prices.get(pv);
    if (!p) reasons.push('price version not in the pricing file');
    else if (p.priceUsdCents !== pc) reasons.push('PROJECT_HOME_PRICE_USD_CENTS does not match the reviewed price');
    else price = p;
  }

  let rate = null;
  const rv = posInt(env.PROJECT_HOME_RATE_VERSION);
  if (!rv) reasons.push('PROJECT_HOME_RATE_VERSION missing');
  else if (table) {
    const r = table.rates.get(rv);
    if (!r) reasons.push('rate version not in the pricing file');
    else if (nowMs < Date.parse(r.rateEffectiveAt)) reasons.push('rate version not yet effective');
    else if (nowMs >= Date.parse(r.rateExpiresAt)) reasons.push('rate version expired');
    else rate = r;
  }

  let deployment = null;
  try { deployment = loadDeployment(options.deploymentFile); } catch (err) { reasons.push('deployment file invalid: ' + err.message); }
  const sinkRaw = lc(env.PROJECT_HOME_SINK_ADDRESS);
  let sink = /^0x[0-9a-f]{40}$/.test(sinkRaw) && sinkRaw !== ZERO && sinkRaw !== CANONICAL_SYNC ? sinkRaw : null;
  if (!sink) reasons.push('PROJECT_HOME_SINK_ADDRESS missing or invalid');
  else if (!deployment || !deployment.deployments.has(sink)) { reasons.push('PROJECT_HOME_SINK_ADDRESS is not a reviewed deployment'); sink = null; }

  const paymentsRequested = truthy(env.SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED);
  if (!paymentsRequested) reasons.push('SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED is not true');
  const paymentsEnabled = siteEnabled && paymentsRequested && Boolean(price && rate && sink);

  if (paymentsRequested && !paymentsEnabled) {
    const key = reasons.join('|');
    if (key !== warned) { warned = key; log('project-home', 'payments-closed', { problems: reasons }); }
  }
  // paymentsEnabled is the STATIC gate. Quotes additionally require an on-chain deployment PASS (project-home.js).
  return { durable, siteEnabled, paymentsEnabled, closedReasons: reasons, chainId: CHAIN_ID, sync: CANONICAL_SYNC, sink, deployment, price, rate };
}

module.exports = { projectHomeConfig, CHAIN_ID, CANONICAL_SYNC };
