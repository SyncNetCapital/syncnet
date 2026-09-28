'use strict';
/*
 * Read-only Solana mainnet JSON-RPC for SyncNet Solana discovery (server only). Standard JSON-RPC over fetch, no SDK.
 *
 *  - Endpoint: SYNCNET_SOLANA_RPC_URL only (https). There is no public fallback; without it the client is null and
 *    callers do nothing. The URL (it usually carries an API key) is never logged, returned or put in an error.
 *  - Every read uses commitment "finalized". getTransaction always sends maxSupportedTransactionVersion: 1, because
 *    Pump transactions include version-1 transactions (a lower value makes the node refuse them).
 *  - Bounded: per-request timeout (default 8 s) and a small number of retries (default 1) with backoff, retried only
 *    for transport failures, HTTP 429/5xx and JSON-RPC server errors. Errors carry a generic message and a code.
 *  - Nothing here signs or sends a transaction.
 */

const COMMITMENT = 'finalized';
const MAX_TX_VERSION = 1;

class SolanaRpcError extends Error {
  constructor(message, code, retryable) {
    super(message);
    this.name = 'SolanaRpcError';
    this.code = code;
    this.retryable = Boolean(retryable);
  }
}

/** The configured https endpoint, or '' (never a fallback). */
function solanaRpcUrl(env) {
  const u = String((env || process.env).SYNCNET_SOLANA_RPC_URL || '').trim();
  return /^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(u) ? u : '';
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * createSolanaRpc({env, url, fetch, timeoutMs, retries, sleep}) -> client | null (no endpoint configured).
 * client.call(method, params) is the raw transport; the named methods below are the only ones this feature uses.
 */
function createSolanaRpc(options = {}) {
  const url = options.url || solanaRpcUrl(options.env);
  if (!url) return null;
  const doFetch = options.fetch || globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000;
  const retries = Number.isInteger(options.retries) && options.retries >= 0 ? Math.min(options.retries, 4) : 1;
  const sleep = options.sleep || defaultSleep;
  const stats = { requests: 0 };
  let id = 0;

  async function once(method, params) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    stats.requests += 1;
    let res, body;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: ctl.signal,
        redirect: 'error',
      });
      if (!res || !res.ok) {
        const status = res ? res.status : 0;
        throw new SolanaRpcError('Solana RPC HTTP ' + status, 'http_' + status, status === 429 || status >= 500 || status === 0);
      }
      body = await res.json();
    } catch (err) {
      if (err instanceof SolanaRpcError) throw err;
      throw new SolanaRpcError(ctl.signal.aborted ? 'Solana RPC timed out' : 'Solana RPC request failed', ctl.signal.aborted ? 'timeout' : 'network', true);
    } finally {
      clearTimeout(timer);
    }
    if (!body || typeof body !== 'object') throw new SolanaRpcError('Solana RPC reply malformed', 'malformed', true);
    if (body.error) {
      const c = Number(body.error.code);
      // -32005 node behind, -32603 internal, -32004/-32014 block/status not yet available: transient.
      throw new SolanaRpcError('Solana RPC error ' + (Number.isFinite(c) ? c : ''), 'rpc_' + (Number.isFinite(c) ? c : 'error'), [-32005, -32603, -32004, -32014, 429].includes(c));
    }
    if (!('result' in body)) throw new SolanaRpcError('Solana RPC reply malformed', 'malformed', true);
    return body.result;
  }

  async function call(method, params) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(method, params);
      } catch (err) {
        if (!err.retryable || attempt >= retries) throw err;
        await sleep(Math.min(4000, 400 * 2 ** attempt));
      }
    }
  }

  return {
    stats,
    call,
    /** Newest first. opts: {limit (1..1000), before, until}. -> [{signature, slot, err, blockTime}] */
    async getSignaturesForAddress(address, opts = {}) {
      const cfg = { commitment: COMMITMENT, limit: Math.max(1, Math.min(1000, Number(opts.limit) || 1000)) };
      if (opts.before) cfg.before = opts.before;
      if (opts.until) cfg.until = opts.until;
      const out = await call('getSignaturesForAddress', [address, cfg]);
      if (!Array.isArray(out)) throw new SolanaRpcError('getSignaturesForAddress reply malformed', 'malformed', false);
      return out;
    },
    /** 'json' encoding (raw base58 instruction data + meta.innerInstructions). null when the node has no such tx. */
    getTransaction(signature) {
      return call('getTransaction', [signature, { encoding: 'json', commitment: COMMITMENT, maxSupportedTransactionVersion: MAX_TX_VERSION }]);
    },
    /** -> {owner, data: Buffer, lamports} | null */
    async getAccountInfo(address) {
      const r = await call('getAccountInfo', [address, { encoding: 'base64', commitment: COMMITMENT }]);
      return accountOf(r && r.value);
    },
    /** Up to 100 keys -> [{owner, data, lamports} | null] in the same order. */
    async getMultipleAccounts(addresses) {
      if (!addresses.length) return [];
      if (addresses.length > 100) throw new RangeError('getMultipleAccounts: at most 100 keys');
      const r = await call('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: COMMITMENT }]);
      if (!r || !Array.isArray(r.value) || r.value.length !== addresses.length) throw new SolanaRpcError('getMultipleAccounts reply malformed', 'malformed', false);
      return r.value.map(accountOf);
    },
  };
}

function accountOf(v) {
  if (!v || typeof v !== 'object') return null;
  const d = Array.isArray(v.data) && v.data[1] === 'base64' ? Buffer.from(String(v.data[0] || ''), 'base64') : null;
  if (!d || typeof v.owner !== 'string') return null;
  return { owner: v.owner, data: d, lamports: Number(v.lamports) || 0 };
}

module.exports = { createSolanaRpc, solanaRpcUrl, SolanaRpcError, COMMITMENT, MAX_TX_VERSION };
