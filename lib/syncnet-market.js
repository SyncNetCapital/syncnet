/*
 * SyncNet Marketplace V1 — shared schema module (browser + Netlify functions).
 *
 * One source of truth for the EIP-712 domain, the typed structures, canonical JSON hashing and the
 * field validators, so the browser signs EXACTLY what the server verifies. Every Marketplace write is
 * authenticated by an EIP-712 signature over one of these structures — never by trusting the client.
 *
 *   domain: { name: 'SyncNet Marketplace', version: '1', chainId: 4663 }
 *
 * Records are identified by the EIP-712 digest of the signed structure (deterministic IDs: the same
 * signed content collapses to the same ID, which is also the duplicate/replay guard at the ID level;
 * per-wallet nonces are additionally consumed server-side).
 *
 * The Marketplace is NON-CUSTODIAL: nothing here holds funds, requests token approvals or deploys
 * escrow. Signing any of these structures is a free signature, never a transaction.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./syncnet-core.js'));
  else root.SyncNetMarket = factory(root.SyncNetCore);
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';
  if (!Core) throw new Error('SyncNetMarket requires SyncNetCore.');

  const CHAIN_ID = 4663;
  const DOMAIN = Object.freeze({ name: 'SyncNet Marketplace', version: '1', chainId: CHAIN_ID });
  const EIP712_DOMAIN = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }];

  const TYPES = Object.freeze({
    OperatorClaim: [
      { name: 'token', type: 'address' }, { name: 'operator', type: 'address' }, { name: 'basis', type: 'string' },
      { name: 'nonce', type: 'bytes32' }, { name: 'expiry', type: 'uint256' },
    ],
    Listing: [
      { name: 'token', type: 'address' }, { name: 'seller', type: 'address' }, { name: 'price', type: 'string' },
      { name: 'currency', type: 'string' }, { name: 'termsHash', type: 'bytes32' },
      { name: 'nonce', type: 'bytes32' }, { name: 'expiry', type: 'uint256' },
    ],
    ListingCancel: [
      { name: 'listingId', type: 'bytes32' }, { name: 'seller', type: 'address' }, { name: 'nonce', type: 'bytes32' },
    ],
    Offer: [
      { name: 'listingId', type: 'bytes32' }, { name: 'termsHash', type: 'bytes32' }, { name: 'token', type: 'address' },
      { name: 'buyer', type: 'address' }, { name: 'amount', type: 'string' }, { name: 'currency', type: 'string' },
      { name: 'nonce', type: 'bytes32' }, { name: 'expiry', type: 'uint256' },
    ],
    OfferDecision: [
      { name: 'offerId', type: 'bytes32' }, { name: 'listingId', type: 'bytes32' }, { name: 'seller', type: 'address' },
      { name: 'decision', type: 'string' }, { name: 'nonce', type: 'bytes32' },
    ],
    TransferIntent: [
      { name: 'dealId', type: 'bytes32' }, { name: 'token', type: 'address' }, { name: 'from', type: 'address' },
      { name: 'to', type: 'address' }, { name: 'nonce', type: 'bytes32' }, { name: 'expiry', type: 'uint256' },
    ],
    TransferAccept: [
      { name: 'dealId', type: 'bytes32' }, { name: 'token', type: 'address' }, { name: 'from', type: 'address' },
      { name: 'to', type: 'address' }, { name: 'intentHash', type: 'bytes32' },
      { name: 'nonce', type: 'bytes32' }, { name: 'expiry', type: 'uint256' },
    ],
    DealConfirm: [
      { name: 'dealId', type: 'bytes32' }, { name: 'wallet', type: 'address' }, { name: 'role', type: 'string' },
      { name: 'item', type: 'string' }, { name: 'stateHash', type: 'bytes32' }, { name: 'nonce', type: 'bytes32' },
    ],
    DealCancel: [
      { name: 'dealId', type: 'bytes32' }, { name: 'wallet', type: 'address' }, { name: 'reason', type: 'string' },
      { name: 'nonce', type: 'bytes32' },
    ],
  });

  const LISTING_STATUS = Object.freeze(['ACTIVE', 'OFFER_ACCEPTED', 'IN_TRANSFER', 'COMPLETED', 'CANCELLED', 'EXPIRED']);
  const OFFER_STATUS = Object.freeze(['PENDING', 'ACCEPTED', 'REJECTED', 'SUPERSEDED', 'DEAL_CANCELLED', 'EXPIRED']);
  const DEAL_STATUS = Object.freeze(['OPEN', 'COMPLETED', 'CANCELLED']);
  const CLAIM_BASES = Object.freeze(['deployer', 'operator', 'fee-recipient']);
  const CURRENCIES = Object.freeze(['ETH', 'USDG', 'USD', 'EUR']);
  const ASSET_KINDS = Object.freeze(['manual', 'syncnet', 'onchain']);
  const MAX_EXPIRY = Object.freeze({ claim: 3600, listing: 90 * 86400, offer: 30 * 86400, transfer: 7 * 86400 });

  const ADDR = /^0x[0-9a-fA-F]{40}$/;
  const B32 = /^0x[0-9a-f]{64}$/;
  const isAddr = (v) => ADDR.test(String(v || ''));
  const isBytes32 = (v) => B32.test(String(v || '').toLowerCase());
  const lc = (v) => String(v == null ? '' : v).toLowerCase();

  /** Price/amount: a plain positive decimal string, <= 1e9 units, <= 18 decimals. Returns the normalized string or null. */
  function checkAmount(v) {
    const s = String(v == null ? '' : v).trim();
    const m = /^(\d{1,10})(?:\.(\d{1,18}))?$/.exec(s);
    if (!m) return null;
    const whole = m[1].replace(/^0+(?=\d)/, '');
    const frac = (m[2] || '').replace(/0+$/, '');
    if (whole.length > 10 || Number(whole) > 1e9) return null;
    if (whole === '0' && !frac) return null; // must be > 0
    return frac ? `${whole}.${frac}` : whole;
  }
  /** ETH amount string -> wei BigInt (used for on-chain payment verification). */
  function toWei(amount) {
    const a = checkAmount(amount);
    if (!a) return null;
    const [w, f = ''] = a.split('.');
    return BigInt(w) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
  }

  /** Stable JSON: object keys sorted at every level, arrays in order. Same value -> same bytes everywhere. */
  function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  const hashJson = (value) => Core.keccak256Utf8(canonicalJson(value));

  function typedData(kind, message) {
    if (!TYPES[kind]) throw new Error('unknown Marketplace structure: ' + kind);
    return { types: { EIP712Domain: EIP712_DOMAIN, [kind]: TYPES[kind] }, primaryType: kind, domain: { ...DOMAIN }, message };
  }
  const digest = (kind, message) => Core.hashTypedData(typedData(kind, message));

  const clean = (v, max) => Core.sanitizeForDisplay(String(v == null ? '' : v), { maxLength: max });

  /**
   * Validates and canonicalizes listing terms. Returns {ok, terms, error}.
   * Terms are the exact "what is included / what is NOT included" record the seller signs (as termsHash)
   * and every buyer offers against. Asset kinds are evidence levels:
   *   onchain — verified against Robinhood Chain by SyncNet (only the creator-fee right qualifies in V1);
   *   syncnet — transferred inside SyncNet with verified signatures (the operator/Passport transfer);
   *   manual  — off-chain (domain, repo, community, art): both parties confirm by hand in the Deal.
   */
  function normalizeTerms(input) {
    const t = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
    if (!t) return { ok: false, error: 'terms missing' };
    const description = clean(t.description, 2000);
    if (!description || description.length < 10) return { ok: false, error: 'describe the listing (10–2000 characters)' };
    const included = Array.isArray(t.included) ? t.included : [];
    const notIncluded = Array.isArray(t.notIncluded) ? t.notIncluded : [];
    if (included.length > 20 || notIncluded.length > 20) return { ok: false, error: 'at most 20 included and 20 excluded items' };
    const outIncluded = [];
    for (let i = 0; i < included.length; i++) {
      const it = included[i] && typeof included[i] === 'object' ? included[i] : {};
      const label = clean(it.label, 140);
      const kind = String(it.kind || 'manual');
      const note = clean(it.note, 300);
      if (!label) return { ok: false, error: 'included item ' + (i + 1) + ' needs a label' };
      if (!ASSET_KINDS.includes(kind)) return { ok: false, error: 'included item kind must be onchain, syncnet or manual' };
      outIncluded.push({ id: 'a' + (i + 1), label, kind, note });
    }
    const outNot = [];
    for (let i = 0; i < notIncluded.length; i++) {
      const label = clean(notIncluded[i], 140);
      if (label) outNot.push(label);
    }
    const includeFeeRight = t.includeFeeRight === true;
    return { ok: true, terms: { description, included: outIncluded, notIncluded: outNot, includeFeeRight } };
  }

  /** The deal-completion state both parties sign over (stateHash of DealConfirm item 'complete'). */
  function checklistState(deal) {
    const c = deal.checklist || {};
    return {
      dealId: deal.id,
      operatorTransfer: { done: Boolean(c.operatorTransfer && c.operatorTransfer.done) },
      feeRight: { required: Boolean(c.feeRight && c.feeRight.required), done: Boolean(c.feeRight && c.feeRight.done), txHash: (c.feeRight && c.feeRight.txHash) || null },
      payment: { required: Boolean(c.payment && c.payment.required), kind: (c.payment && c.payment.kind) || 'none', done: Boolean(c.payment && c.payment.done), txHash: (c.payment && c.payment.evidence && c.payment.evidence.txHash) || null },
      assets: ((c.assets || []).map((a) => ({ id: a.id, done: Boolean(a.done) }))),
    };
  }
  const completeHash = (deal) => hashJson(checklistState(deal));

  return Object.freeze({
    CHAIN_ID, DOMAIN, TYPES, LISTING_STATUS, OFFER_STATUS, DEAL_STATUS, CLAIM_BASES, CURRENCIES, ASSET_KINDS, MAX_EXPIRY,
    isAddr, isBytes32, lc, checkAmount, toWei, canonicalJson, hashJson, typedData, digest, clean, normalizeTerms,
    checklistState, completeHash,
  });
});
