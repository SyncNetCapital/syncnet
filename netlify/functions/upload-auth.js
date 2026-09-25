'use strict';
// Wallet-bound sessions for PUBLIC image uploads. Only works while the server-side gate has public uploads
// open (SYNCNET_PUBLIC_UPLOADS=true + PINATA_JWT + SYNCNET_UPLOAD_KEY + durable store, see ../lib/flags.js).
//
//   GET  /api/upload-auth?address=0x…                 -> {message, exp}  stateless HMAC challenge, valid 10 min
//   POST /api/upload-auth {address, message, signature} -> {session, ttl} 30-minute session for that wallet
//
// The wallet signs the challenge with personal_sign (no transaction, no gas). EOAs are checked by ECDSA
// recovery, contract wallets through EIP-1271 isValidSignature. Each challenge is single use: its nonce is
// burned in the durable store. Limits: 20 challenges / 10 min / IP, 10 verifications / 10 min / IP,
// 10 sessions / day / wallet. Refusals are generic; details are logged with hashed identifiers only.
const Core = require('../../lib/syncnet-core.js');
const Chain = require('../../lib/syncnet-chain.js');
const uploadSession = require('../lib/upload-session');
const { json, publicError, tooManyRequests } = require('../lib/respond');
const { log, logError, hashId } = require('../lib/log');
const { getStore } = require('../lib/store');
const { clientIp, limit, limitAll } = require('../lib/ratelimit');
const { flags } = require('../lib/flags');
const { serverRpc } = require('../lib/chain-rpc');
const { readJsonBody, query, method: methodOf } = require('../lib/body');

const FN = 'upload-auth';
const CLOSED = 'Image uploads are not open on this deployment.';
const FAILED = 'Upload sign-in failed. Request a new sign-in and try again.';
const WALLET_TTL = 30 * 60;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ANY_SIGNATURE = /^0x(?:[0-9a-fA-F]{2}){64,4096}$/;

async function contractWalletApproves(rpc, address, message, signature) {
  const code = String(await Chain.getCode(rpc, address)).toLowerCase();
  if (!code || code === '0x' || code.startsWith('0xef0100')) return false; // EOAs and EIP-7702 accounts sign with ECDSA
  const digest = Core.hashPersonalMessage(message);
  const out = await Chain.ethCall(rpc, address, Chain.SEL.isValidSignature + Core.abiEncode(['bytes32', 'bytes'], [digest, signature]).slice(2));
  return String(out || '').toLowerCase().slice(0, 10) === '0x1626ba7e';
}

async function handler(event = {}, deps = {}) {
  const method = methodOf(event);
  if (method !== 'GET' && method !== 'POST') return publicError(405, 'method_not_allowed', 'GET or POST only.', { allow: 'GET, POST' });
  const store = deps.store || getStore();
  const gate = flags({ store, env: deps.env });
  if (!gate.publicUploads) return publicError(403, 'closed', CLOSED);
  const ip = clientIp(event);
  const ipHash = hashId(ip);

  if (method === 'GET') {
    const rl = await limit(store, { bucket: 'ua-challenge', id: ip, limit: 20, windowSeconds: 600 });
    if (!rl.allowed) return tooManyRequests(rl.retryAfter);
    const address = query(event, 'address');
    if (!ADDRESS.test(address)) return publicError(400, 'invalid_request', 'Connect a wallet first.');
    const c = uploadSession.issueChallenge(address, { origin: 'SyncNet' });
    if (!c) {
      log(FN, 'challenge-unavailable', { problem: 'SYNCNET_UPLOAD_KEY missing or shorter than 32 characters' });
      return publicError(503, 'unavailable', CLOSED);
    }
    log(FN, 'challenge', { ip: ipHash, wallet: hashId(address.toLowerCase()) });
    return json(200, { message: c.message, exp: c.exp });
  }

  const rl = await limit(store, { bucket: 'ua-verify', id: ip, limit: 10, windowSeconds: 600 });
  if (!rl.allowed) return tooManyRequests(rl.retryAfter);
  const body = readJsonBody(event, 16384);
  if (!body) return publicError(400, 'invalid_request', 'Invalid request.');
  const address = String(body.address || '');
  const message = String(body.message || '');
  const signature = String(body.signature || '');
  if (!ADDRESS.test(address) || !ANY_SIGNATURE.test(signature) || !message) return publicError(400, 'invalid_request', 'Invalid request.');
  const wallet = address.toLowerCase();
  const parsed = uploadSession.parseChallenge(message);
  if (!parsed || parsed.address !== wallet) {
    log(FN, 'bad-challenge', { ip: ipHash, wallet: hashId(wallet) });
    return publicError(401, 'denied', FAILED);
  }
  let signer = null;
  try {
    signer = await uploadSession.verifyChallengeSignature(message, signature, Core.recoverPersonalSignAddress);
  } catch {
    signer = null;
  }
  if (!signer) {
    try {
      if (await contractWalletApproves(deps.rpc || serverRpc(), wallet, message, signature)) signer = wallet;
    } catch (err) {
      logError(FN, 'eip1271-check-failed', err, { wallet: hashId(wallet) });
    }
  }
  if (signer !== wallet) {
    log(FN, 'bad-signature', { ip: ipHash, wallet: hashId(wallet) });
    return publicError(401, 'denied', FAILED);
  }
  // Single use: burn the nonce for the rest of the challenge's lifetime.
  let uses;
  try {
    const ttl = Math.max(1, parsed.exp - Math.floor(Date.now() / 1000) + 120);
    uses = await store.incrWindow(`ua:nonce:${parsed.nonce}`, ttl);
  } catch (err) {
    logError(FN, 'store-unavailable', err, { stage: 'nonce' });
    return tooManyRequests(60);
  }
  if (uses !== 1) {
    log(FN, 'replayed-challenge', { ip: ipHash, wallet: hashId(wallet) });
    return publicError(401, 'denied', FAILED);
  }
  const quota = await limitAll(store, [{ bucket: 'ua-wallet-day', id: wallet, limit: 10, windowSeconds: 86400 }]);
  if (!quota.allowed) {
    log(FN, 'wallet-quota', { wallet: hashId(wallet) });
    return tooManyRequests(quota.retryAfter);
  }
  const session = uploadSession.issue({ scope: 'wallet', subject: wallet, ttlSeconds: WALLET_TTL });
  if (!session) return publicError(503, 'unavailable', CLOSED);
  log(FN, 'session', { ip: ipHash, wallet: hashId(wallet) });
  return json(200, { session, ttl: WALLET_TTL });
}

exports.handler = (event) => handler(event);
exports._handler = handler;
