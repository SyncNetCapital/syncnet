/*
 * SyncNet SYNC Proof / EARLY — shared protocol primitives (browser + Netlify functions).
 *
 * One source of truth for: the EIP-712 domain and every typed structure, canonical JSON hashing, validators,
 * canonical token-address handling (chainId + contract address; never a symbol), the pilot constants, the Merkle
 * leaf/bundle format, attestation ids/digests, the PUBLIC transaction-matching rule (syncnet.sync-proof.matching.v1)
 * and receipt ids. The browser signs EXACTLY what the server verifies; an independent verifier can reuse this file.
 *
 *   domain: { name: 'SyncNet SYNC Proof', version: '1', chainId: 4663 }   (no verifyingContract: off-chain records)
 *
 * Nothing here holds funds, requests approvals, or builds anything but a standard ERC-20 transfer(address,uint256).
 * Depends only on lib/syncnet-core.js. See docs/sync-proof-early-spec.md.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./syncnet-core.js'));
  else root.SyncNetEarly = factory(root.SyncNetCore);
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';
  if (!Core) throw new Error('SyncNetEarly requires SyncNetCore.');

  const CHAIN_ID = 4663;
  const CHAIN_HEX = '0x1237';
  const DOMAIN = Object.freeze({ name: 'SyncNet SYNC Proof', version: '1', chainId: CHAIN_ID });
  const EIP712_DOMAIN = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }];

  const SCHEMA = Object.freeze({
    manifest: 'syncnet.early.creator-manifest.v1',
    countMeIn: 'syncnet.early.count-me-in.v1',
    countMeInWithdraw: 'syncnet.early.count-me-in-withdraw.v1',
    intent: 'syncnet.early.support-intent.v1',
    finalize: 'syncnet.early.support-finalize.v1',
    rotationCancel: 'syncnet.early.rotation-cancel.v1',
    session: 'syncnet.early.session.v1',
    creatorLink: 'syncnet.early.creator-link.v1',
    cardReveal: 'syncnet.early.card-reveal.v1',
    receipt: 'syncnet.sync-proof.receipt.v1',
    attestation: 'syncnet.attestation.v1',
    matching: 'syncnet.sync-proof.matching.v1',
    bundle: 'syncnet.early.bundle.v1',
    keys: 'syncnet.early.keys.v1',
    assets: 'syncnet.early.assets.v1',
  });
  const PRIVACY_PRIVATE = 'PRIVATE';
  const PLATFORM = 'youtube'; // the legacy / default platform; every pre-existing identity, key and signature is YouTube's
  const ZERO32 = '0x' + '00'.repeat(32);

  // Pilot constants (seconds). Windows are policy; they are part of the public rule only through the SIGNED fields.
  const C = Object.freeze({
    MAX_SKEW_S: 120, // signer clock vs server clock
    DRAFT_TTL_S: 20 * 60, // unsigned draft lifetime
    INTENT_WINDOW_S: 2 * 3600, // expiry − notBefore
    INTENT_NOT_BEFORE_SLACK_S: 60, // notBefore = now − slack (unless a same-tuple intent forbids it)
    RECOVERY_GRACE_S: 24 * 3600, // late transfer may still be bound by SupportFinalize within this
    ROTATION_COOLDOWN_S: 48 * 3600,
    ROTATION_LOCK_S: 7 * 86400,
    ROTATION_CANCEL_REPEAT_S: 30 * 86400, // a second RotationCancel from the same wallet within this is refused
    ROTATION_DRAFT_FREEZE_S: 3600, // no new drafts in the final hour before a rotation takes effect
    CMI_TTL_S: 180 * 86400,
    SESSION_FAN_S: 30 * 60,
    SESSION_CREATOR_S: 2 * 3600,
    OAUTH_LINK_TTL_S: 15 * 60,
    MAX_ACCEPTED_ASSETS: 4,
    MAX_AMOUNT: (1n << 128n),
  });

  const TYPES = Object.freeze({
    CreatorManifest: [
      { name: 'schema', type: 'string' }, { name: 'creatorId', type: 'bytes32' }, { name: 'platform', type: 'string' },
      { name: 'channelId', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'receivingWallet', type: 'address' },
      { name: 'acceptedAssetsHash', type: 'bytes32' }, { name: 'manifestVersion', type: 'uint32' },
      { name: 'previousManifestHash', type: 'bytes32' }, { name: 'issuedAt', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
    CountMeIn: [
      { name: 'schema', type: 'string' }, { name: 'platform', type: 'string' }, { name: 'channelId', type: 'string' },
      { name: 'fan', type: 'address' }, { name: 'issuedAt', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
    CountMeInWithdraw: [
      { name: 'schema', type: 'string' }, { name: 'channelId', type: 'string' }, { name: 'fan', type: 'address' },
      { name: 'issuedAt', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
    SupportIntent: [
      { name: 'schema', type: 'string' }, { name: 'intentId', type: 'bytes32' }, { name: 'manifestHash', type: 'bytes32' },
      { name: 'creatorId', type: 'bytes32' }, { name: 'chainId', type: 'uint256' }, { name: 'sender', type: 'address' },
      { name: 'receiver', type: 'address' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' },
      { name: 'notBefore', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'privacy', type: 'string' },
    ],
    SupportFinalize: [
      { name: 'schema', type: 'string' }, { name: 'intentId', type: 'bytes32' }, { name: 'txHash', type: 'bytes32' },
      { name: 'logIndex', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
    RotationCancel: [
      { name: 'schema', type: 'string' }, { name: 'creatorId', type: 'bytes32' }, { name: 'pendingManifestHash', type: 'bytes32' },
      { name: 'issuedAt', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
    EarlySession: [
      { name: 'schema', type: 'string' }, { name: 'wallet', type: 'address' }, { name: 'issuedAt', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
    CreatorLinkRequest: [
      { name: 'schema', type: 'string' }, { name: 'wallet', type: 'address' }, { name: 'issuedAt', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
    CardReveal: [
      { name: 'schema', type: 'string' }, { name: 'shareId', type: 'bytes32' }, { name: 'fields', type: 'string' },
      { name: 'issuedAt', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
  });
  const SCHEMA_OF = Object.freeze({
    CreatorManifest: SCHEMA.manifest, CountMeIn: SCHEMA.countMeIn, CountMeInWithdraw: SCHEMA.countMeInWithdraw,
    SupportIntent: SCHEMA.intent, SupportFinalize: SCHEMA.finalize, RotationCancel: SCHEMA.rotationCancel,
    EarlySession: SCHEMA.session, CreatorLinkRequest: SCHEMA.creatorLink, CardReveal: SCHEMA.cardReveal,
  });

  // ---------------------------------------------------------------- validators
  const lc = (v) => String(v == null ? '' : v).toLowerCase();
  const ADDR = /^0x[0-9a-fA-F]{40}$/;
  const B32 = /^0x[0-9a-f]{64}$/;
  const CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
  const RAW = /^(0|[1-9][0-9]{0,38})$/;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const isAddr = (v) => ADDR.test(String(v || ''));
  const isBytes32 = (v) => B32.test(lc(v));
  const isChannelId = (v) => typeof v === 'string' && CHANNEL.test(v);
  const isUnix = (v) => Number.isSafeInteger(Number(v)) && Number(v) > 0 && String(v) === String(Number(v));
  /** A raw token amount: a plain non-negative decimal integer string, > 0 and < 2^128. */
  function isRawAmount(v) {
    const s = String(v == null ? '' : v);
    if (!RAW.test(s)) return false;
    const n = BigInt(s);
    return n > 0n && n < C.MAX_AMOUNT;
  }
  const isDate = (v) => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));

  // ---------------------------------------------------------------- platform identity: (platform, immutable external id)
  // The identity primitive. A creator is (platform, externalId) where externalId is the platform's IMMUTABLE account id
  // (never a handle, name or avatar). The signed structs keep their v1 field name `channelId` for the external id (it is
  // part of the EIP-712 type hash and must not change); everything else calls it externalId. The registry is protocol
  // data: whether a platform is ACCEPTED by a deployment is a server decision (netlify/lib/early-config.js `platforms`).
  //   audienceKind = what the platform's dated audience context counts; ids are always strings (never JS numbers).
  const PLATFORMS = Object.freeze({
    youtube: Object.freeze({ platform: 'youtube', idPattern: CHANNEL, audienceKind: 'subscribers', audienceLabel: 'Audience then' }),
    x: Object.freeze({ platform: 'x', idPattern: /^[1-9][0-9]{0,19}$/, audienceKind: 'followers', audienceLabel: 'Followers on X then' }),
  });
  const isPlatform = (p) => typeof p === 'string' && Object.prototype.hasOwnProperty.call(PLATFORMS, p);
  /** True only for a registered platform and a string that is that platform's immutable id shape. */
  const isExternalId = (platform, id) => isPlatform(platform) && typeof id === 'string' && PLATFORMS[platform].idPattern.test(id);
  /** The unique platform an id shape belongs to, or null (none, or ambiguous: the registry must keep shapes disjoint). */
  function platformOfId(id) {
    if (typeof id !== 'string') return null;
    const hit = Object.keys(PLATFORMS).filter((p) => PLATFORMS[p].idPattern.test(id));
    return hit.length === 1 ? hit[0] : null;
  }
  /**
   * ref = the single storage/lookup string of an identity. YouTube's ref is the BARE channel id, so every key created
   * before platforms existed keeps its exact name; every other platform is `<platform>:<externalId>`.
   */
  function refOf(platform, externalId) {
    if (!isExternalId(platform, externalId)) throw new TypeError('refOf: invalid platform or external id');
    return platform === PLATFORM ? externalId : platform + ':' + externalId;
  }
  /** Inverse of refOf -> {platform, externalId} | null. Refuses non-canonical spellings (e.g. 'youtube:UC…'). */
  function parseRef(ref) {
    if (typeof ref !== 'string') return null;
    if (isExternalId(PLATFORM, ref)) return { platform: PLATFORM, externalId: ref };
    const m = /^([a-z]{1,16}):(.+)$/.exec(ref);
    if (!m || m[1] === PLATFORM || !isExternalId(m[1], m[2])) return null;
    return { platform: m[1], externalId: m[2] };
  }
  /**
   * creatorId is deterministic from the immutable external id: keccak256('syncnet.early.creator.v1|<platform>|<id>').
   * creatorIdOf(channelId) === creatorIdOf(channelId, 'youtube') is byte-identical to the pre-platform formula.
   * The id is validated against THE GIVEN platform only, so a value of one platform can never yield another's creatorId.
   */
  const creatorIdOf = (externalId, platform = PLATFORM) => {
    if (!isExternalId(platform, externalId)) throw new TypeError('creatorIdOf: invalid ' + (platform === PLATFORM ? 'channel' : 'external') + ' id');
    return Core.keccak256Utf8('syncnet.early.creator.v1|' + platform + '|' + externalId);
  };

  // ---------------------------------------------------------------- canonical JSON (sorted keys, no whitespace, no floats)
  function canonicalJson(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw new TypeError('canonicalJson: only safe integers'); return String(value); }
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    if (typeof value !== 'object') throw new TypeError('canonicalJson: unsupported value');
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  const hashJson = (value) => Core.keccak256Utf8(canonicalJson(value));

  // ---------------------------------------------------------------- EIP-712
  function typedData(kind, message) {
    if (!TYPES[kind]) throw new Error('unknown SYNC Proof structure: ' + kind);
    return { types: { EIP712Domain: EIP712_DOMAIN, [kind]: TYPES[kind] }, primaryType: kind, domain: { ...DOMAIN }, message };
  }
  const digest = (kind, message) => Core.hashTypedData(typedData(kind, message));
  /** True when `td` is exactly the typed data this module would build for (kind, message): domain, types, message. */
  function sameTypedData(kind, message, td) {
    try { return canonicalJson(typedData(kind, message)) === canonicalJson(td); } catch { return false; }
  }

  // ---------------------------------------------------------------- canonical assets (identity = chainId + address)
  /** parseAssetList(json) -> Map(lowercase token -> {token, symbol, decimals}); throws on any malformed entry. */
  function parseAssetList(json) {
    if (!json || json.schema !== SCHEMA.assets || json.chainId !== CHAIN_ID || !Array.isArray(json.assets)) throw new Error('assets: bad file');
    const out = new Map();
    for (const a of json.assets) {
      if (!a || !isAddr(a.token) || lc(a.token) !== a.token) throw new Error('assets: token must be a lowercase address');
      if (!Number.isInteger(a.decimals) || a.decimals < 0 || a.decimals > 36) throw new Error('assets: decimals');
      if (typeof a.symbol !== 'string' || !/^[A-Z0-9]{1,16}$/.test(a.symbol)) throw new Error('assets: symbol');
      if (out.has(a.token)) throw new Error('assets: duplicate token');
      out.set(a.token, Object.freeze({ token: a.token, symbol: a.symbol, decimals: a.decimals }));
    }
    if (!out.size) throw new Error('assets: empty');
    return out;
  }
  /** [{token, minAmount}] -> {ok, assets, hash} | {ok:false, error}. Sorted by token; every token in the allowlist. */
  function normalizeAcceptedAssets(input, allowlist) {
    if (!Array.isArray(input) || !input.length || input.length > C.MAX_ACCEPTED_ASSETS) return { ok: false, error: 'between 1 and ' + C.MAX_ACCEPTED_ASSETS + ' accepted assets' };
    const seen = new Set();
    const assets = [];
    for (const it of input) {
      const token = lc(it && it.token);
      if (!isAddr(token) || !allowlist.has(token)) return { ok: false, error: 'asset not in the pilot allowlist' };
      if (seen.has(token)) return { ok: false, error: 'duplicate asset' };
      const min = String(it.minAmount == null ? '' : it.minAmount);
      if (!isRawAmount(min)) return { ok: false, error: 'minAmount must be a positive raw integer' };
      seen.add(token);
      assets.push({ token, minAmount: min });
    }
    assets.sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
    return { ok: true, assets, hash: hashJson(assets) };
  }
  /** Raw integer string -> human decimal string (no rounding). */
  function formatUnits(raw, decimals) {
    if (!/^\d+$/.test(String(raw))) throw new TypeError('formatUnits: raw integer expected');
    const s = String(raw).padStart(decimals + 1, '0');
    const whole = s.slice(0, s.length - decimals) || '0';
    const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
    return frac ? whole + '.' + frac : whole;
  }
  /** Human decimal string -> raw integer string, or null when it does not fit the decimals exactly. */
  function parseUnits(text, decimals) {
    const m = /^(\d{1,30})(?:\.(\d{1,36}))?$/.exec(String(text == null ? '' : text).trim());
    if (!m) return null;
    const frac = m[2] || '';
    if (frac.length > decimals) return null;
    const raw = (BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString();
    return isRawAmount(raw) ? raw : null;
  }
  /** The standard ERC-20 transfer calldata: 0xa9059cbb ‖ to ‖ amount (68 bytes). Never anything appended. */
  function transferCalldata(to, amount) {
    if (!isAddr(to)) throw new TypeError('transferCalldata: to');
    if (!isRawAmount(amount)) throw new TypeError('transferCalldata: amount');
    return '0xa9059cbb' + lc(to).slice(2).padStart(64, '0') + BigInt(amount).toString(16).padStart(64, '0');
  }

  // ---------------------------------------------------------------- audience / dates
  const utcDate = (unixSeconds) => new Date(Number(unixSeconds) * 1000).toISOString().slice(0, 10);
  /** YouTube-style rounding for display: ~1.2K, ~15K, ~1.2M. Values < 1000 are shown as-is. */
  function formatAudience(n) {
    if (!Number.isFinite(Number(n)) || Number(n) < 0) return '';
    const v = Number(n);
    if (v < 1000) return '~' + Math.round(v);
    const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [d, u] of units) if (v >= d) { const x = v / d; return '~' + (x < 10 ? (Math.floor(x * 10) / 10).toString() : Math.floor(x).toString()) + u; }
    return '~' + v;
  }
  /**
   * The audience an `audience-snapshot` attestation recorded -> {kind, count|null, hidden} | null (unknown shape/kind:
   * never guessed). Legacy YouTube claims have no audienceKind: {subscriberCount, hiddenSubscriberCount} = 'subscribers'.
   * A dated, approximate CONTEXT value; it is never part of payment validity.
   */
  function audienceOf(claims) {
    if (!claims || typeof claims !== 'object') return null;
    const num = (n) => (n != null && Number.isFinite(Number(n)) && Number(n) >= 0 ? n : null);
    if (claims.audienceKind === 'followers') return { kind: 'followers', count: num(claims.followerCount), hidden: false };
    if (claims.audienceKind != null && claims.audienceKind !== 'subscribers') return null;
    const count = num(claims.subscriberCount);
    return { kind: 'subscribers', count, hidden: Boolean(claims.hiddenSubscriberCount) || count == null };
  }
  /** The one-line consumer label for a receipt's `context.audienceThen`; X followers are always named as X context. */
  function audienceLine(a) {
    const spec = a && Object.values(PLATFORMS).find((p) => p.audienceKind === a.kind);
    const label = spec ? spec.audienceLabel : 'Audience then';
    if (!a || a.state === 'unavailable') return label + ': unavailable';
    return label + ': ' + (a.state === 'hidden' ? 'hidden' : a.display);
  }

  // ---------------------------------------------------------------- Merkle bundle (docs §10)
  const LEAF_ATTESTATION = 'attestation';
  const hexToBytes = Core.hexToBytes, bytesToHex = Core.bytesToHex, utf8 = Core.utf8Bytes;
  const concat = (parts) => Core.concatBytes(...parts);
  /** leaf = keccak256(0x00 ‖ utf8(leafType) ‖ 0x00 ‖ payload32) */
  function leafHash(leafType, payload32) {
    if (typeof leafType !== 'string' || !/^[a-z:-]{1,32}$/.test(leafType)) throw new TypeError('leafHash: type');
    if (!isBytes32(payload32)) throw new TypeError('leafHash: payload must be bytes32');
    return Core.keccak256(concat([Uint8Array.of(0), utf8(leafType), Uint8Array.of(0), hexToBytes(payload32)]));
  }
  const nodeHash = (l, r) => Core.keccak256(concat([Uint8Array.of(1), hexToBytes(l), hexToBytes(r)]));
  const emptyRoot = (date) => { if (!isDate(date)) throw new TypeError('emptyRoot: date'); return Core.keccak256(concat([Uint8Array.of(2), utf8(date)])); };
  /** Sorted ascending (as 256-bit integers), de-duplicated. */
  function sortLeaves(leaves) {
    const set = new Set(leaves.map((l) => { if (!isBytes32(l)) throw new TypeError('sortLeaves: bytes32'); return lc(l); }));
    return [...set].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  }
  function merkleLevels(sorted) {
    const levels = [sorted.slice()];
    while (levels[levels.length - 1].length > 1) {
      const cur = levels[levels.length - 1];
      const next = [];
      for (let i = 0; i < cur.length; i += 2) next.push(nodeHash(cur[i], cur[i + 1] === undefined ? cur[i] : cur[i + 1]));
      levels.push(next);
    }
    return levels;
  }
  /** merkleRoot(sortedLeaves, date) -> root (emptyRoot(date) when there are no leaves). */
  function merkleRoot(sortedLeaves, date) {
    if (!sortedLeaves.length) return emptyRoot(date);
    return merkleLevels(sortedLeaves).pop()[0];
  }
  /** Inclusion proof for the leaf at `index` of the sorted list: {leaf, leafIndex, siblings:[{hash, side}], root}. */
  function merkleProof(sortedLeaves, index) {
    if (!Number.isInteger(index) || index < 0 || index >= sortedLeaves.length) throw new RangeError('merkleProof: index');
    const levels = merkleLevels(sortedLeaves);
    const siblings = [];
    let i = index;
    for (let d = 0; d < levels.length - 1; d++) {
      const cur = levels[d];
      const isRight = i % 2 === 1;
      const sib = isRight ? cur[i - 1] : (cur[i + 1] === undefined ? cur[i] : cur[i + 1]);
      siblings.push({ hash: sib, side: isRight ? 'L' : 'R' });
      i = Math.floor(i / 2);
    }
    return { leaf: sortedLeaves[index], leafIndex: index, siblings, root: levels[levels.length - 1][0] };
  }
  function verifyProof(leaf, siblings, root) {
    if (!isBytes32(leaf) || !isBytes32(root) || !Array.isArray(siblings)) return false;
    let h = lc(leaf);
    for (const s of siblings) {
      if (!s || !isBytes32(s.hash) || (s.side !== 'L' && s.side !== 'R')) return false;
      h = s.side === 'L' ? nodeHash(s.hash, h) : nodeHash(h, s.hash);
    }
    return h === lc(root);
  }
  /** Anchor calldata: 'SYNC' ‖ 0x01 ‖ root(32) ‖ utf8(date)(10). Decoded by verifiers. */
  function anchorCalldata(root, date) {
    if (!isBytes32(root) || !isDate(date)) throw new TypeError('anchorCalldata');
    return bytesToHex(concat([utf8('SYNC'), Uint8Array.of(1), hexToBytes(root), utf8(date)]));
  }
  function decodeAnchorCalldata(data) {
    const s = lc(data);
    if (!/^0x53594e4301[0-9a-f]{64}[0-9a-f]{20}$/.test(s)) return null;
    const root = '0x' + s.slice(12, 76);
    const dateHex = s.slice(76);
    let date = '';
    for (let i = 0; i < dateHex.length; i += 2) date += String.fromCharCode(parseInt(dateHex.slice(i, i + 2), 16));
    return isDate(date) ? { root, date } : null;
  }

  // ---------------------------------------------------------------- attestations (docs §9)
  const ATTESTATION_TYPES = Object.freeze(['creator-identity', 'creator-manifest', 'audience-snapshot', 'key-registry']);
  /** The unsigned body an attestation id commits to. */
  const attestationBody = (a) => ({ schema: SCHEMA.attestation, type: a.type, subject: a.subject, claims: a.claims, issuedAt: a.issuedAt, bundleDate: a.bundleDate });
  const attestationId = (a) => hashJson(attestationBody(a));
  /** digest signed by the SyncNet attestation key: keccak256(utf8('SYNCNET-ATTESTATION/1') ‖ id) */
  const attestationDigest = (id) => { if (!isBytes32(id)) throw new TypeError('attestationDigest'); return Core.keccak256(concat([utf8('SYNCNET-ATTESTATION/1'), hexToBytes(id)])); };
  /**
   * verifyAttestation(record, registry) -> {ok, reason?, address?}. `registry` is the parsed syncnet-early-keys.json.
   * Checks: shape, id recomputation, key known, signature recovers to the key's address, issuedAt inside the key's
   * validity. (Anchoring/inclusion is checked separately with verifyProof and the bundle record.)
   */
  function verifyAttestation(a, registry) {
    try {
      if (!a || a.schema !== SCHEMA.attestation || !ATTESTATION_TYPES.includes(a.type)) return { ok: false, reason: 'shape' };
      if (!isUnix(a.issuedAt) || !isDate(a.bundleDate)) return { ok: false, reason: 'time' };
      if (attestationId(a) !== lc(a.id)) return { ok: false, reason: 'id' };
      const key = keyById(registry, a.keyId);
      if (!key) return { ok: false, reason: 'unknown-key' };
      const from = Date.parse(key.validFrom) / 1000, until = key.validUntil ? Date.parse(key.validUntil) / 1000 : Infinity;
      if (!(Number(a.issuedAt) >= from && Number(a.issuedAt) <= until)) return { ok: false, reason: 'key-validity' };
      const who = lc(Core.recoverAddress(attestationDigest(a.id), a.signature));
      return who === lc(key.address) ? { ok: true, address: who } : { ok: false, reason: 'signature' };
    } catch (e) { return { ok: false, reason: 'error' }; }
  }
  function keyById(registry, keyId) {
    const list = registry && Array.isArray(registry.attestation) ? registry.attestation : [];
    return list.find((k) => k && k.keyId === keyId && isAddr(k.address)) || null;
  }
  /** Validates syncnet-early-keys.json: PUBLIC data only. Any 32-byte-hex-looking value anywhere is refused. */
  function parseKeyRegistry(json) {
    if (!json || json.schema !== SCHEMA.keys || !Array.isArray(json.attestation) || !Array.isArray(json.anchor)) throw new Error('keys: bad file');
    const text = JSON.stringify(json);
    if (/0x[0-9a-fA-F]{64}/.test(text) || /[0-9a-fA-F]{64}/.test(text.replace(/0x[0-9a-fA-F]{40}/g, ''))) throw new Error('keys: a 32-byte value is present; only addresses and ids are allowed');
    const ids = new Set();
    for (const k of json.attestation) {
      if (!k || typeof k.keyId !== 'string' || !/^[a-z0-9-]{4,48}$/.test(k.keyId) || !isAddr(k.address) || !k.validFrom || Number.isNaN(Date.parse(k.validFrom))) throw new Error('keys: attestation entry');
      if (k.validUntil != null && Number.isNaN(Date.parse(k.validUntil))) throw new Error('keys: validUntil');
      if (ids.has(k.keyId)) throw new Error('keys: duplicate keyId');
      ids.add(k.keyId);
    }
    for (const k of json.anchor) if (!k || !isAddr(k.address) || !k.validFrom || Number.isNaN(Date.parse(k.validFrom))) throw new Error('keys: anchor entry');
    return json;
  }

  // ---------------------------------------------------------------- public matching rule (docs §13.2), pure parts
  const TRANSFER_TOPIC = Core.keccak256Utf8('Transfer(address,address,uint256)');
  const PADDED = /^0x0{24}[0-9a-f]{40}$/;
  /**
   * Rules 3–5 (and the receipt-consistency part of 6) over ONE receipt:
   * every log emitted by `token` with the exact Transfer layout, from == sender, to == receiver, value == amount.
   * -> [{logIndex, from, to, value, txHash, blockHash}] sorted by logIndex. Never throws on malformed logs (skips them).
   */
  function matchingTransfers(rcpt, { token, sender, receiver, amount }) {
    const out = [];
    if (!rcpt || lc(rcpt.status) !== '0x1') return out; // rule 2
    const want = BigInt(amount);
    for (const log of Array.isArray(rcpt.logs) ? rcpt.logs : []) {
      if (!log || log.removed === true) continue;
      if (lc(log.address) !== lc(token)) continue;
      const t = Array.isArray(log.topics) ? log.topics.map(lc) : [];
      if (t.length !== 3 || t[0] !== TRANSFER_TOPIC || !PADDED.test(t[1]) || !PADDED.test(t[2])) continue;
      const from = '0x' + t[1].slice(26), to = '0x' + t[2].slice(26);
      if (from !== lc(sender) || to !== lc(receiver)) continue;
      const data = lc(log.data);
      if (!/^0x[0-9a-f]{64}$/.test(data) || BigInt(data) !== want) continue;
      if (!/^0x[0-9a-f]{1,8}$/.test(lc(log.logIndex))) continue;
      if (log.transactionHash && lc(log.transactionHash) !== lc(rcpt.transactionHash)) continue;
      if (log.blockHash && rcpt.blockHash && lc(log.blockHash) !== lc(rcpt.blockHash)) continue;
      out.push({ logIndex: Number(BigInt(log.logIndex)), from, to, value: want.toString(), txHash: lc(rcpt.transactionHash), blockHash: lc(rcpt.blockHash || '') });
    }
    return out.sort((a, b) => a.logIndex - b.logIndex);
  }
  /** Rule 7 and the recovery grace: 'in-window' | 'late' (recovery-eligible) | 'early' | 'out'. */
  function windowState(intentMessage, blockTimestamp) {
    const ts = BigInt(blockTimestamp), nb = BigInt(intentMessage.notBefore), ex = BigInt(intentMessage.expiry);
    if (ts < nb) return 'early';
    if (ts <= ex) return 'in-window';
    if (ts <= ex + BigInt(C.RECOVERY_GRACE_S)) return 'late';
    return 'out';
  }
  const receiptIdOf = (chainId, txHash, logIndex) => {
    if (!isBytes32(txHash) || !Number.isInteger(logIndex) || logIndex < 0) throw new TypeError('receiptIdOf');
    return Core.keccak256Utf8(SCHEMA.receipt + '|' + Number(chainId) + '|' + lc(txHash) + '|' + logIndex);
  };

  // ---------------------------------------------------------------- consumer copy helpers
  const clean = (v, max) => Core.sanitizeForDisplay(String(v == null ? '' : v), { maxLength: max });
  const shortAddr = (a) => (isAddr(a) ? lc(a).slice(0, 6) + '…' + lc(a).slice(-4) : '');

  return Object.freeze({
    CHAIN_ID, CHAIN_HEX, DOMAIN, EIP712_DOMAIN, TYPES, SCHEMA, SCHEMA_OF, PRIVACY_PRIVATE, PLATFORM, ZERO32, CONST: C,
    ATTESTATION_TYPES, LEAF_ATTESTATION, TRANSFER_TOPIC,
    lc, isAddr, isBytes32, isChannelId, isUnix, isRawAmount, isDate, creatorIdOf,
    PLATFORMS, isPlatform, isExternalId, platformOfId, refOf, parseRef,
    canonicalJson, hashJson, typedData, digest, sameTypedData,
    parseAssetList, normalizeAcceptedAssets, formatUnits, parseUnits, transferCalldata,
    utcDate, formatAudience, audienceOf, audienceLine,
    leafHash, sortLeaves, merkleRoot, merkleProof, verifyProof, emptyRoot, anchorCalldata, decodeAnchorCalldata,
    attestationBody, attestationId, attestationDigest, verifyAttestation, keyById, parseKeyRegistry,
    matchingTransfers, windowState, receiptIdOf,
    clean, shortAddr,
  });
});
