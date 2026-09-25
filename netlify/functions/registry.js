'use strict';
// Public SyncNet Registry of launches with verifiable provenance ("BUILT WITH SYNCNET · VERIFIED").
//   GET  /api/registry          -> {entries: [...], durable, submissions}
//   POST /api/registry {proof}  -> {status: 'VERIFIED', token} | 422 {status: 'UNVERIFIED', failed: [...]}
// A proof (schema syncnet.launch.proof.v2) is accepted only if the chain confirms ALL of it right now
// (lib/syncnet-chain.js verifyEvidence): intent JSON -> recordHash -> salt; the deployer's signature over
// (operator, token, recordHash, salt); the launch transaction from the deployer to PAR carrying that salt,
// metadata, fees and markets; the TokenLaunched log for that token; the PAR factory record and token metadata.
// Nothing browser-local is ever published. Pages re-verify every entry live before showing it as verified.
// Submissions only while SYNCNET_REGISTRY_SUBMISSIONS=true and a durable store is configured (flags.js).
// Limits: 10 submissions / hour / IP, 200 / hour overall; proof <= 64 KB.
const Chain = require('../../lib/syncnet-chain.js');
const { json, publicError, tooManyRequests } = require('../lib/respond');
const { log, logError, hashId } = require('../lib/log');
const { getStore } = require('../lib/store');
const { clientIp, limitAll, limit } = require('../lib/ratelimit');
const { flags } = require('../lib/flags');
const { serverRpc } = require('../lib/chain-rpc');
const { readJsonBody, method: methodOf } = require('../lib/body');

const FN = 'registry';
const INDEX_KEY = 'reg:index:v1';
const entryKey = (token) => `reg:token:v1:${token}`;
const MAX_ENTRIES = 1000;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const CLOSED = 'Registry submissions are not open on this deployment.';

function shapeOk(p) {
  return p && typeof p === 'object' && p.schema === 'syncnet.launch.proof.v2' && Number(p.chainId) === 4663 &&
    ADDRESS.test(String(p.token || '').toLowerCase()) && ADDRESS.test(String(p.deployer || '').toLowerCase()) &&
    HASH.test(String(p.txHash || '').toLowerCase()) && HASH.test(String(p.recordHash || '').toLowerCase()) && HASH.test(String(p.salt || '').toLowerCase()) &&
    typeof p.intentJson === 'string' && p.intentJson.length <= 16384 && p.signature && typeof p.signature === 'object' &&
    ['EIP-712', 'personal_sign'].includes(p.signature.scheme) && typeof p.signature.signature === 'string' && p.signature.signature.length <= 8200;
}

// Only the fields needed to re-verify (and to display) are stored; nothing else from the submission is kept.
function toEntry(proof, result) {
  let intent = {};
  try { intent = JSON.parse(proof.intentJson); } catch { intent = {}; }
  const a = result.actual || {};
  return {
    status: 'BUILT WITH SYNCNET · VERIFIED',
    token: proof.token.toLowerCase(),
    deployer: proof.deployer.toLowerCase(),
    txHash: proof.txHash.toLowerCase(),
    blockNumber: a.blockNumber || null,
    launchedAt: a.launchedAt || null,
    name: String(intent.name || '').slice(0, 64),
    symbol: String(intent.symbol || '').slice(0, 16),
    connections: Array.isArray(intent.connections) ? intent.connections.slice(0, 5).map((c) => ({ address: String(c.address || '').toLowerCase(), symbol: String(c.symbol || '').slice(0, 16) })) : [],
    proof: {
      schema: 'syncnet.launch.proof.v2', chainId: 4663, token: proof.token.toLowerCase(), deployer: proof.deployer.toLowerCase(), txHash: proof.txHash.toLowerCase(),
      recordHash: proof.recordHash.toLowerCase(), salt: proof.salt.toLowerCase(), intentJson: proof.intentJson,
      signature: { scheme: proof.signature.scheme, typedData: proof.signature.typedData || null, message: proof.signature.message || null, signature: proof.signature.signature },
    },
    verifiedAt: result.verifiedAt || new Date().toISOString(),
  };
}

async function list(store) {
  if (!store.durable) return [];
  const tokens = (await store.smembers(INDEX_KEY)).filter((t) => ADDRESS.test(t)).slice(0, MAX_ENTRIES);
  const rows = await Promise.all(tokens.map((t) => store.get(entryKey(t)).catch(() => null)));
  return rows.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean)
    .sort((a, b) => String(b.verifiedAt).localeCompare(String(a.verifiedAt)));
}

async function handler(event = {}, deps = {}) {
  const method = methodOf(event);
  const store = deps.store || getStore();
  const gate = flags({ store, env: deps.env });
  const ip = clientIp(event);
  if (method === 'GET') {
    const rl = await limit(store, { bucket: 'registry-read', id: ip, limit: 120, windowSeconds: 60 });
    if (!rl.allowed) return tooManyRequests(rl.retryAfter);
    try {
      const entries = await list(store);
      return json(200, { entries, durable: Boolean(store.durable), submissions: gate.registrySubmissions }, { 'cache-control': 'public, max-age=30' });
    } catch (err) {
      logError(FN, 'list-failed', err, {});
      return publicError(503, 'unavailable', 'The registry is temporarily unavailable.');
    }
  }
  if (method !== 'POST') return publicError(405, 'method_not_allowed', 'GET or POST only.', { allow: 'GET, POST' });
  if (!gate.registrySubmissions) return publicError(403, 'closed', CLOSED);
  const rl = await limitAll(store, [
    { bucket: 'registry-submit', id: ip, limit: 10, windowSeconds: 3600 },
    { bucket: 'registry-all', id: 'all', limit: 200, windowSeconds: 3600 },
  ]);
  if (!rl.allowed) return tooManyRequests(rl.retryAfter);
  const body = readJsonBody(event, 65536);
  const proof = body && body.proof;
  if (!shapeOk(proof)) return publicError(400, 'invalid_proof', 'That is not a SyncNet launch proof.');
  const token = proof.token.toLowerCase();
  let result;
  try {
    result = await Chain.verifyEvidence(deps.rpc || serverRpc(), proof);
  } catch (err) {
    logError(FN, 'verify-crashed', err, { token });
    return publicError(503, 'unavailable', 'The chain could not be read right now. Try again later.');
  }
  if (result.status === 'UNAVAILABLE') {
    log(FN, 'chain-unavailable', { token, ip: hashId(ip) });
    return publicError(503, 'unavailable', 'The chain could not be read right now. Try again later.');
  }
  if (result.status !== 'VERIFIED') {
    const failed = result.checks.filter((c) => !c.ok).map((c) => c.label).slice(0, 12);
    log(FN, 'rejected', { token, ip: hashId(ip), failed });
    return json(422, { status: 'UNVERIFIED', failed });
  }
  try {
    const entry = toEntry(proof, result);
    await store.set(entryKey(token), JSON.stringify(entry));
    await store.sadd(INDEX_KEY, token);
    log(FN, 'published', { token, deployer: hashId(entry.deployer) });
    return json(200, { status: 'VERIFIED', token });
  } catch (err) {
    logError(FN, 'store-failed', err, { token });
    return publicError(503, 'unavailable', 'The registry is temporarily unavailable.');
  }
}

exports.handler = (event) => handler(event);
exports._handler = handler;
exports._internals = { shapeOk, toEntry };
