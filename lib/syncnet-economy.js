/*
 * SyncNet Economies V0 — shared schema module (browser + Netlify functions).
 *
 * An Economy is a VIEW, never stored state: the Economy of root R is every PAR launch with a market whose
 * pairToken is R (matched by ADDRESS, never by ticker). The only stored Economy data is an append-only set
 * of signed curation events per root ("the root's current curator recognizes child C"), folded at read time:
 *
 *   domain: { name: 'SyncNet Economies', version: '1', chainId: 4663 }   (distinct from the Marketplace)
 *
 *   EconomyCuration(address root, address child, address curator, string decision, uint256 issuedAt, bytes32 nonce)
 *   EconomyClaimRequest(address root, address claimant, string evidenceUrl, uint256 issuedAt, bytes32 nonce)
 *
 * Event IDs are the EIP-712 digests. Ordering comes only from the SIGNED issuedAt (ties: the larger id), so
 * the folded state is independent of storage/arrival order: concurrent writers can never lose each other's
 * events, and replaying an old signed event can never override a newer one.
 *
 * Recognition is ONE-SIDED: a statement by the root's current curator. It is not a SyncNet endorsement and
 * it does not mean the recognized project agreed to anything. Signing is a free signature, never a transaction.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./syncnet-core.js'));
  else root.SyncNetEconomy = factory(root.SyncNetCore);
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';
  if (!Core) throw new Error('SyncNetEconomy requires SyncNetCore.');

  const CHAIN_ID = 4663;
  const DOMAIN = Object.freeze({ name: 'SyncNet Economies', version: '1', chainId: CHAIN_ID });
  const EIP712_DOMAIN = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }];
  const TYPES = Object.freeze({
    EconomyCuration: [
      { name: 'root', type: 'address' }, { name: 'child', type: 'address' }, { name: 'curator', type: 'address' },
      { name: 'decision', type: 'string' }, { name: 'issuedAt', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
    EconomyClaimRequest: [
      { name: 'root', type: 'address' }, { name: 'claimant', type: 'address' }, { name: 'evidenceUrl', type: 'string' },
      { name: 'issuedAt', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
  });
  const KIND_OF = Object.freeze({ EconomyCuration: 'curation', EconomyClaimRequest: 'claim-request' });
  const DECISIONS = Object.freeze(['recognize', 'revoke']);
  /** |issuedAt - server clock| must be within this many seconds when an event is submitted. */
  const MAX_SKEW = 300;
  /** Soft cap on stored curation events per root. It never refuses a revoke that removes a current recognition. */
  const MAX_EVENTS_PER_ROOT = 500;
  const MAX_REQUESTS_PER_ROOT = 20;
  const ZERO = '0x0000000000000000000000000000000000000000';

  const ADDR = /^0x[0-9a-fA-F]{40}$/;
  const B32 = /^0x[0-9a-f]{64}$/;
  const lc = (v) => String(v == null ? '' : v).toLowerCase();
  const isAddr = (v) => ADDR.test(String(v || ''));
  const isBytes32 = (v) => B32.test(lc(v));
  const isRootAddr = (v) => isAddr(v) && lc(v) !== ZERO;

  /** Stable JSON (keys sorted at every level). Same value -> same bytes everywhere, so equal events are equal set members. */
  function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }

  function typedData(kind, message) {
    if (!TYPES[kind]) throw new Error('unknown Economy structure: ' + kind);
    return { types: { EIP712Domain: EIP712_DOMAIN, [kind]: TYPES[kind] }, primaryType: kind, domain: { ...DOMAIN }, message };
  }
  const digest = (kind, message) => Core.hashTypedData(typedData(kind, message));

  function uintSeconds(v) {
    const n = typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : v;
    return Number.isInteger(n) && n > 0 && n < 1e11 ? n : null;
  }

  /** https URL, <= 200 chars, no credentials, no whitespace/control characters. Returns the normalized string or null. */
  function checkEvidenceUrl(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s || s.length > 200 || /[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(s)) return null;
    let u;
    try { u = new URL(s); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
    return u.href.length <= 200 ? u.href : null;
  }

  /** Validates + normalizes an EconomyCuration message. {ok, message} or {ok:false, field}. */
  function curationMessage(input) {
    const b = input && typeof input === 'object' ? input : {};
    if (!isRootAddr(b.root)) return { ok: false, field: 'root' };
    if (!isAddr(b.child) || lc(b.child) === ZERO) return { ok: false, field: 'child' };
    if (lc(b.child) === lc(b.root)) return { ok: false, field: 'child' };
    if (!isAddr(b.curator)) return { ok: false, field: 'curator' };
    if (!DECISIONS.includes(b.decision)) return { ok: false, field: 'decision' };
    const issuedAt = uintSeconds(b.issuedAt);
    if (!issuedAt) return { ok: false, field: 'issuedAt' };
    if (!isBytes32(b.nonce)) return { ok: false, field: 'nonce' };
    return { ok: true, message: { root: lc(b.root), child: lc(b.child), curator: lc(b.curator), decision: b.decision, issuedAt, nonce: lc(b.nonce) } };
  }

  /** Validates + normalizes an EconomyClaimRequest message. */
  function claimRequestMessage(input) {
    const b = input && typeof input === 'object' ? input : {};
    if (!isRootAddr(b.root)) return { ok: false, field: 'root' };
    if (!isAddr(b.claimant)) return { ok: false, field: 'claimant' };
    const evidenceUrl = checkEvidenceUrl(b.evidenceUrl);
    if (!evidenceUrl || evidenceUrl !== b.evidenceUrl) return { ok: false, field: 'evidenceUrl' };
    const issuedAt = uintSeconds(b.issuedAt);
    if (!issuedAt) return { ok: false, field: 'issuedAt' };
    if (!isBytes32(b.nonce)) return { ok: false, field: 'nonce' };
    return { ok: true, message: { root: lc(b.root), claimant: lc(b.claimant), evidenceUrl, issuedAt, nonce: lc(b.nonce) } };
  }

  const SIG = /^0x[0-9a-f]{130,8190}$/;
  /** The exact string stored in the root's set: everything needed to re-verify, nothing server-generated. */
  function member(kind, message, signature) {
    if (!KIND_OF[kind]) throw new Error('unknown Economy structure: ' + kind);
    return canonicalJson({ v: 1, kind: KIND_OF[kind], id: digest(kind, message), ...message, signature: lc(signature) });
  }

  /** Parses one stored member. Anything malformed, or whose id is not the digest of its own fields, is null. */
  function parseMember(raw, kind) {
    let o;
    try { o = typeof raw === 'string' ? JSON.parse(raw) : null; } catch { return null; }
    if (!o || typeof o !== 'object' || o.v !== 1 || o.kind !== KIND_OF[kind] || !SIG.test(String(o.signature || ''))) return null;
    const checked = kind === 'EconomyCuration' ? curationMessage(o) : claimRequestMessage(o);
    if (!checked.ok) return null;
    let id;
    try { id = digest(kind, checked.message); } catch { return null; }
    if (lc(o.id) !== id) return null;
    return { id, ...checked.message, signature: o.signature };
  }

  const newer = (a, b) => a.issuedAt > b.issuedAt || (a.issuedAt === b.issuedAt && a.id > b.id);

  /**
   * Current curator info: {address, since} (since = unix seconds when this curatorship began). An event counts
   * only if it was signed by the CURRENT curator after its curatorship began (MAX_SKEW tolerance for client
   * clocks). Events by earlier curators stay stored but are inert.
   */
  function counts(ev, curator) {
    return Boolean(curator && isAddr(curator.address) && ev.curator === lc(curator.address) && ev.issuedAt + MAX_SKEW >= Number(curator.since || 0));
  }

  /** Map child -> the latest counted event for that child (by signed issuedAt, then id). */
  function latestByChild(members, root, curator) {
    const latest = new Map();
    let ignored = 0;
    const seen = new Set();
    for (const raw of members || []) {
      const ev = parseMember(raw, 'EconomyCuration');
      if (!ev || ev.root !== lc(root)) { ignored++; continue; }
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      if (!counts(ev, curator)) { ignored++; continue; }
      const cur = latest.get(ev.child);
      if (!cur || newer(ev, cur)) latest.set(ev.child, ev);
    }
    return { latest, ignored, total: seen.size };
  }

  /** Folds a root's stored events into the children the current curator recognizes now (newest first). */
  function fold(members, root, curator) {
    const { latest, ignored, total } = latestByChild(members, root, curator);
    const recognized = [...latest.values()].filter((e) => e.decision === 'recognize').sort((a, b) => (newer(a, b) ? -1 : 1));
    return { recognized, ignored, total };
  }

  // ---------------------------------------------------------------- derived membership (indexer rows)
  const marketsOf = (row) => (Array.isArray(row && row.markets) && row.markets.length ? row.markets : [row]);
  const pairOf = (m) => lc((m && (m.pairToken || m.quoteToken || m.pairTokenAddress || m.quoteTokenAddress)) || '');
  const tokenOf = (row) => lc((row && (row.token || row.tokenAddress || row.address)) || '');

  /** Every indexed PAR launch that has a market paired with `root` (by address). Deduplicated, root excluded. */
  function childrenOf(rows, root) {
    const r = lc(root);
    const out = [];
    const seen = new Set();
    if (!isRootAddr(r)) return out;
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row !== 'object') continue;
      const t = tokenOf(row);
      if (!isAddr(t) || t === r || seen.has(t)) continue;
      if (marketsOf(row).some((m) => pairOf(m) === r)) { seen.add(t); out.push({ address: t, row }); }
    }
    return out;
  }

  /**
   * Joins derived children with the recognized events:
   *  connected:  [{address, row, recognition|null}]   — in the current indexer data
   *  outsideIndex: [{address, recognition}]           — recognized (on-chain verified when recorded) but not in
   *                                                      the current indexer data: shown, never as indexer-confirmed
   */
  function join(children, recognized) {
    const byChild = new Map((recognized || []).map((e) => [e.child, e]));
    const connected = (children || []).map((c) => ({ address: c.address, row: c.row, recognition: byChild.get(c.address) || null }));
    const present = new Set(connected.map((c) => c.address));
    const outsideIndex = (recognized || []).filter((e) => !present.has(e.child)).map((e) => ({ address: e.child, recognition: e }));
    return { connected, outsideIndex };
  }

  const LABELS = Object.freeze({
    connected: 'CONNECTED · ON-CHAIN PAR MARKET',
    recognized: 'PARENT-RECOGNIZED',
    recognizedBy: (sym, source) => 'RECOGNIZED BY $' + sym + (source === 'manual' ? ' CURATOR' : ' OPERATOR'),
    outsideIndex: 'CONNECTION PREVIOUSLY VERIFIED · OUTSIDE CURRENT INDEX WINDOW',
    indexerDown: 'CONNECTION PREVIOUSLY VERIFIED · INDEXER UNAVAILABLE',
  });

  return Object.freeze({
    CHAIN_ID, DOMAIN, TYPES, DECISIONS, MAX_SKEW, MAX_EVENTS_PER_ROOT, MAX_REQUESTS_PER_ROOT, LABELS,
    lc, isAddr, isRootAddr, isBytes32, canonicalJson, typedData, digest, checkEvidenceUrl, curationMessage,
    claimRequestMessage, member, parseMember, counts, latestByChild, fold, childrenOf, join, newer,
  });
});
