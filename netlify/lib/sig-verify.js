'use strict';
// Server-side signature check shared by every signed SyncNet write (Marketplace, Economies, Project Home).
// verifyDigest(rpc, wallet, digest, signature) -> boolean. Never throws.
//   1. ECDSA: the signature recovers to `wallet` (EOAs, and EIP-7702-delegated EOAs signing with their own key).
//   2. EIP-1271: otherwise, if `wallet` has code, a live isValidSignature(digest, signature) call must return the
//      magic value 0x1626ba7e. Any RPC failure is a failed verification (fail closed).
// Callers keep their own signature-FORMAT checks (length bounds differ per endpoint) and compute the digest in their
// own EIP-712 domain; this module never chooses a domain, so no digest can cross from one product into another.
const Core = require('../../lib/syncnet-core.js');
const Chain = require('../../lib/syncnet-chain.js');

const lc = (v) => String(v == null ? '' : v).toLowerCase();

async function verifyDigest(rpc, wallet, digest, signature) {
  try { if (lc(Core.recoverAddress(digest, signature)) === lc(wallet)) return true; } catch { /* not ECDSA by this wallet */ }
  try {
    const code = await Chain.getCode(rpc, wallet);
    if (!code || code === '0x') return false;
    const data = Chain.SEL.isValidSignature + Core.abiEncode(['bytes32', 'bytes'], [digest, signature]).slice(2);
    const out = await rpc('eth_call', [{ to: wallet, data }, 'latest']);
    return String(out || '').toLowerCase().startsWith('0x1626ba7e');
  } catch { return false; }
}

module.exports = { verifyDigest };
