'use strict';
// Live project resolution shared by the functions that act on a project's operational authority
// (Marketplace, Project Home). Everything is read LIVE from the canonical factory of a SUPPORTED ORIGIN on Robinhood
// Chain (lib/syncnet-origins.js: PAR, Pons V2) — never from client-supplied fields.
//
//   liveProject(rpc, token) -> {launch: null[, unsupported]} | {launch, feeRight, snapshot, origin}
//     Throws when a canonical factory cannot be read (callers answer 503 — fail closed).
//   readPassport(store, token) -> the stored Project Passport (mp:passport:v1:<token>, Marketplace-owned) or null.
//     READ ONLY: nothing outside the Marketplace ever writes a Passport. Store errors propagate (callers answer 503).
const Chain = require('../../lib/syncnet-chain.js');
const Market = require('../../lib/syncnet-market.js');
const Origins = require('../../lib/syncnet-origins.js');

const passportKey = (token) => `mp:passport:v1:${token}`;

// Fee-right classification is shared with the browser (lib/syncnet-origins.js); PAR results are unchanged.
const feeRightOf = (rpc, launch) => Origins.classifyFeeRight(rpc, launch.origin ? launch : { ...launch, origin: 'PAR' });

/**
 * Launchpad-agnostic live project: {launch} is the normalized project (origin, factory, deployer,
 * creatorFeeRecipient, …) of a SUPPORTED origin, or null. {unsupported} carries a positively identified but not yet
 * supported origin (Pons V1). Throws when any canonical factory cannot be read (callers answer 503).
 */
async function liveProject(rpc, token) {
  const project = await Origins.resolveProject(rpc, token); // PAR factories, then Pons V2, then Pons V1 — live
  if (!project) return { launch: null };
  if (!project.supported) return { launch: null, unsupported: project };
  const [feeRight, meta, pair] = await Promise.all([
    feeRightOf(rpc, project), Chain.readTokenMetadata(rpc, token).catch(() => null),
    project.origin === 'PONS_V2' ? Origins.pairInfo(rpc, project.pair.address).catch(() => null) : null,
  ]);
  const launch = project;
  const snapshot = meta ? {
    name: Market.clean(meta.name, 64), symbol: Market.clean(meta.symbol, 16).toUpperCase(),
    logo: /^ipfs:\/\/[A-Za-z0-9]+(?:\/[A-Za-z0-9._~/-]+)?$/.test(String(meta.logo || '')) ? String(meta.logo) : '', // stays ipfs://; display-only gateways live in the browser
  } : { name: '', symbol: '', logo: '' };
  return { launch, feeRight, snapshot, origin: Origins.publicOrigin(project, pair), meta };
}

async function readPassport(store, token) {
  const raw = await store.get(passportKey(token));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

module.exports = { liveProject, feeRightOf, readPassport, passportKey };
