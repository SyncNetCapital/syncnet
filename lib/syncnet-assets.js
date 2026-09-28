/*
 * SyncNet chain-qualified asset identity (browser + Netlify functions). No dependencies.
 *
 *   EVM (Robinhood Chain):  eip155:4663:0x<40 hex, lowercase>
 *   Solana mainnet:         solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:<base58 mint, case preserved>
 *
 * Identity is the address only — never a symbol or name. A bare `0x…` address keeps meaning exactly what it means
 * today (a Robinhood Chain contract, lowercased), so every existing EVM key and URL stays valid; nothing persisted
 * is migrated. A Solana mint is a base58 string that decodes to exactly 32 bytes AND re-encodes to the same string
 * (so there is one spelling per key); its case is part of its identity and is never changed.
 * The native SOL placeholder (the all-zero default pubkey, "111…1") is a valid key but is not a mint.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SyncNetAssets = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EVM_CHAIN_ID = 4663;
  const EVM_CHAIN = 'eip155:' + EVM_CHAIN_ID;
  const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  const NATIVE_SOL = '11111111111111111111111111111111';

  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const INDEX = (() => { const m = {}; for (let i = 0; i < ALPHABET.length; i++) m[ALPHABET[i]] = i; return m; })();
  const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

  /** base58 string -> Uint8Array, or null when it is not base58. */
  function base58Decode(s) {
    const str = String(s == null ? '' : s);
    if (!str || str.length > 2048 || !B58.test(str)) return null;
    const bytes = []; // little-endian
    for (const c of str) {
      let carry = INDEX[c];
      for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
      while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    let zeros = 0;
    while (zeros < str.length && str[zeros] === '1') zeros++;
    const out = new Uint8Array(zeros + bytes.length);
    for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
    return out;
  }

  /** bytes (Uint8Array | number[]) -> base58 string. */
  function base58Encode(input) {
    const b = Array.from(input || []);
    let zeros = 0;
    while (zeros < b.length && b[zeros] === 0) zeros++;
    const digits = [0];
    for (let i = zeros; i < b.length; i++) {
      let carry = b[i];
      for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
      while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let out = '1'.repeat(zeros);
    if (b.length > zeros) for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
    return out;
  }

  const isEvmAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a == null ? '' : a));
  /** A canonical 32-byte Solana public key (native SOL placeholder included). Case-sensitive: never lowercased. */
  function isSolanaPubkey(s) {
    if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
    const b = base58Decode(s);
    return Boolean(b && b.length === 32 && base58Encode(b) === s);
  }
  const isNativeSol = (s) => s === NATIVE_SOL;
  /** A Solana token mint key: a canonical pubkey that is not the native SOL placeholder. */
  const isSolanaMint = (s) => isSolanaPubkey(s) && !isNativeSol(s);

  /** {chain, address} -> 'eip155:4663:0x…' | 'solana:5eyk…:<mint>' | null. */
  function formatAssetId(asset) {
    const a = asset || {};
    if (a.chain === EVM_CHAIN && isEvmAddress(a.address)) return EVM_CHAIN + ':' + a.address.toLowerCase();
    if (a.chain === SOLANA_MAINNET && isSolanaPubkey(a.address)) return SOLANA_MAINNET + ':' + a.address;
    return null;
  }

  /**
   * 'eip155:4663:0x…' | 'solana:<genesis>:<mint>' | bare '0x…' -> {kind:'evm'|'solana', chain, address, id} | null.
   * A bare 0x address is a Robinhood Chain address (today's behaviour). Unknown chains are rejected, never guessed.
   */
  function parseAssetId(input) {
    const s = String(input == null ? '' : input).trim();
    if (isEvmAddress(s)) return { kind: 'evm', chain: EVM_CHAIN, address: s.toLowerCase(), id: EVM_CHAIN + ':' + s.toLowerCase() };
    if (s.startsWith(EVM_CHAIN + ':')) {
      const addr = s.slice(EVM_CHAIN.length + 1);
      return isEvmAddress(addr) ? { kind: 'evm', chain: EVM_CHAIN, address: addr.toLowerCase(), id: EVM_CHAIN + ':' + addr.toLowerCase() } : null;
    }
    if (s.startsWith(SOLANA_MAINNET + ':')) {
      const mint = s.slice(SOLANA_MAINNET.length + 1);
      return isSolanaPubkey(mint) ? { kind: 'solana', chain: SOLANA_MAINNET, address: mint, id: SOLANA_MAINNET + ':' + mint } : null;
    }
    return null;
  }

  /** Canonical id string for any accepted spelling, or null. */
  function normalizeAsset(input) {
    const p = parseAssetId(input);
    return p ? p.id : null;
  }

  return Object.freeze({
    EVM_CHAIN_ID, EVM_CHAIN, SOLANA_MAINNET, NATIVE_SOL,
    base58Decode, base58Encode, isEvmAddress, isSolanaPubkey, isSolanaMint, isNativeSol,
    formatAssetId, parseAssetId, normalizeAsset,
  });
});
