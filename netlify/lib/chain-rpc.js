'use strict';
// Read-only Robinhood Chain JSON-RPC for the functions (registry verification, EIP-1271 checks).
// SYNCNET_RPC_URL may point at a private https endpoint; anything that is not https falls back to the public RPC.
// Functions never sign or send transactions.
const Chain = require('../../lib/syncnet-chain.js');

function rpcUrl(env) {
  const custom = String((env || process.env).SYNCNET_RPC_URL || '').trim();
  return /^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(custom) ? custom : Chain.ROBINHOOD.rpcUrl;
}

function serverRpc(options = {}) {
  return Chain.makeRpc(rpcUrl(options.env), {
    fetch: options.fetch,
    timeoutMs: options.timeoutMs || 5000,
    retries: options.retries == null ? 1 : options.retries,
  });
}

module.exports = { serverRpc, rpcUrl };
