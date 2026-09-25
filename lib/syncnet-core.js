/*!
 * SyncNet core: lib/syncnet-core.js
 *
 * These dependency-free primitives are shared by the SyncNet pages and the Netlify Functions:
 *   bytes/hex, Keccak-256, EIP-55 addresses, Solidity ABI v2, PAR launch calldata, EIP-712 and personal_sign hashing,
 *   secp256k1 public-key recovery, SyncNet provenance, and the text policy for permanent on-chain token metadata.
 *
 * Loading:
 *   Browser: <script src="/lib/syncnet-core.js"> exposes window.SyncNetCore.
 *   Node:    require('../../lib/syncnet-core.js'), or createRequire(import.meta.url) from ESM.
 *
 * Plain modern JavaScript with BigInt. The only host APIs used are TextEncoder and TextDecoder.
 *
 * Conventions: hex output is 0x-prefixed and lowercase, and integers read from the chain are BigInt.
 * Malformed input throws instead of being guessed at. This code decides whether SyncNet shows
 * "BUILT WITH SYNCNET · VERIFIED", so it fails closed.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  const commonJS = typeof module === 'object' && module !== null && typeof module.exports === 'object';
  if (commonJS) module.exports = api; // Node: require(), or createRequire() from ESM
  if (!commonJS || typeof window !== 'undefined') root.SyncNetCore = api; // browser: window.SyncNetCore
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── 1. Bytes and hex ────────────────────────────────────────────────────────────────────────────────────
  const textEncoder = new TextEncoder();
  // fatal: invalid UTF-8 throws instead of becoming U+FFFD. ignoreBOM: a leading U+FEFF is data, not a marker to strip.
  const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const HEX_BYTE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isPlainObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
  // instanceof fails across realms (iframes, vm contexts), so fall back to the constructor name.
  const isBytes = (x) => x instanceof Uint8Array || (ArrayBuffer.isView(x) && !!x.constructor && x.constructor.name === 'Uint8Array');

  /** Short, safe description of a value for error messages (never dumps huge inputs). */
  function preview(x) {
    if (typeof x === 'string') return JSON.stringify(x.length > 42 ? x.slice(0, 40) + '…' : x);
    if (typeof x === 'bigint') return x + 'n';
    if (typeof x === 'number' || typeof x === 'boolean') return String(x);
    return x === null ? 'null' : Array.isArray(x) ? 'an array' : typeof x;
  }

  /**
   * Encodes UTF-8 with WHATWG TextEncoder semantics: a lone surrogate becomes U+FFFD. That matches viem, ethers and
   * wallets, so hashes agree with theirs. The text policy flags lone surrogates before metadata gets this far.
   */
  function utf8Bytes(str) {
    if (typeof str !== 'string') throw new TypeError('utf8Bytes: expected a string, got ' + preview(str));
    return textEncoder.encode(str);
  }

  /** utf8Bytes(str).length, computed without allocating. */
  function utf8Length(str) {
    if (typeof str !== 'string') throw new TypeError('utf8Length: expected a string, got ' + preview(str));
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; } // surrogate pair
      else n += 3; // other BMP character, or a lone surrogate (written as U+FFFD)
    }
    return n;
  }

  /** Accepts an optional 0x prefix. Rejects odd length and non-hex characters. */
  function hexToBytes(hex) {
    if (typeof hex !== 'string') throw new TypeError('hexToBytes: expected a hex string, got ' + preview(hex));
    const body = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (body.length % 2 !== 0) throw new Error('hexToBytes: odd number of hex digits in ' + preview(hex));
    if (!/^[0-9a-fA-F]*$/.test(body)) throw new Error('hexToBytes: invalid hex character in ' + preview(hex));
    const out = new Uint8Array(body.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(2 * i, 2 * i + 2), 16);
    return out;
  }

  function bytesToHex(bytes) {
    if (!isBytes(bytes)) throw new TypeError('bytesToHex: expected a Uint8Array, got ' + preview(bytes));
    let s = '0x';
    for (let i = 0; i < bytes.length; i++) s += HEX_BYTE[bytes[i]];
    return s;
  }

  function concatList(list) {
    if (!list.every((a) => isBytes(a))) throw new TypeError('concatBytes: every argument must be a Uint8Array');
    const out = new Uint8Array(list.reduce((n, a) => n + a.length, 0));
    let offset = 0;
    for (const a of list) { out.set(a, offset); offset += a.length; }
    return out;
  }
  const concatBytes = (...arrays) => concatList(arrays);

  /** A Uint8Array, or a string that starts with 0x. Plain text is never guessed to be hex. */
  function bytesArg(x, what) {
    if (isBytes(x)) return x;
    if (typeof x === 'string' && x.startsWith('0x')) return hexToBytes(x);
    throw new TypeError(what + ': expected a Uint8Array or 0x-prefixed hex string, got ' + preview(x));
  }
  function fixedBytesArg(x, size, what) {
    const b = bytesArg(x, what);
    if (b.length !== size) throw new Error(`${what}: expected ${size} bytes, got ${b.length}`);
    return b;
  }
  const bytesToBigInt = (b) => (b.length === 0 ? 0n : BigInt(bytesToHex(b)));
  const bigIntToBytes32 = (x) => hexToBytes(x.toString(16).padStart(64, '0')); // 0 ≤ x < 2^256, big-endian

  // ── 2. Keccak-256 ───────────────────────────────────────────────────────────────────────────────────────
  // Ethereum uses the original Keccak padding (0x01), not SHA3-256's 0x06. Each 64-bit lane is held as two uint32
  // halves (hi and lo) because JavaScript has no fast 64-bit integers.
  const KECCAK_RC = [
    '0000000000000001', '0000000000008082', '800000000000808a', '8000000080008000', '000000000000808b', '0000000080000001',
    '8000000080008081', '8000000000008009', '000000000000008a', '0000000000000088', '0000000080008009', '000000008000000a',
    '000000008000808b', '800000000000008b', '8000000000008089', '8000000000008003', '8000000000008002', '8000000000000080',
    '000000000000800a', '800000008000000a', '8000000080008081', '8000000000008080', '0000000080000001', '8000000080008008',
  ];
  const RC_HI = Uint32Array.from(KECCAK_RC, (h) => parseInt(h.slice(0, 8), 16));
  const RC_LO = Uint32Array.from(KECCAK_RC, (h) => parseInt(h.slice(8), 16));
  // ρ rotation offsets, indexed by lane i = x + 5y. Only lane 0's offset is a multiple of 32.
  const RHO = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
  const PI = new Uint8Array(25); // π: lane (x, y) moves to (y, 2x + 3y mod 5)
  for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) PI[x + 5 * y] = y + 5 * ((2 * x + 3 * y) % 5);

  function keccakF1600(hi, lo) {
    const cHi = new Uint32Array(5), cLo = new Uint32Array(5), bHi = new Uint32Array(25), bLo = new Uint32Array(25);
    for (let round = 0; round < 24; round++) {
      // θ: XOR each column's parity into its two neighbouring columns (one of them rotated by 1)
      for (let x = 0; x < 5; x++) {
        cHi[x] = hi[x] ^ hi[x + 5] ^ hi[x + 10] ^ hi[x + 15] ^ hi[x + 20];
        cLo[x] = lo[x] ^ lo[x + 5] ^ lo[x + 10] ^ lo[x + 15] ^ lo[x + 20];
      }
      for (let x = 0; x < 5; x++) {
        const nHi = cHi[(x + 1) % 5], nLo = cLo[(x + 1) % 5];
        const dHi = cHi[(x + 4) % 5] ^ ((nHi << 1) | (nLo >>> 31));
        const dLo = cLo[(x + 4) % 5] ^ ((nLo << 1) | (nHi >>> 31));
        for (let y = 0; y < 25; y += 5) { hi[x + y] ^= dHi; lo[x + y] ^= dLo; }
      }
      // ρ + π: rotate every lane left by its offset and move it to its new position
      for (let i = 0; i < 25; i++) {
        const r = RHO[i], h = hi[i], l = lo[i], j = PI[i];
        if (r === 0) { bHi[j] = h; bLo[j] = l; }
        else if (r < 32) { bHi[j] = (h << r) | (l >>> (32 - r)); bLo[j] = (l << r) | (h >>> (32 - r)); }
        else { const s = r - 32; bHi[j] = (l << s) | (h >>> (32 - s)); bLo[j] = (h << s) | (l >>> (32 - s)); } // swap halves, then rotate by s
      }
      // χ: the only non-linear step, a[x] ^= ~a[x+1] & a[x+2] along each row
      for (let y = 0; y < 25; y += 5) {
        for (let x = 0; x < 5; x++) {
          const a = x + y, b = ((x + 1) % 5) + y, c = ((x + 2) % 5) + y;
          hi[a] = bHi[a] ^ (~bHi[b] & bHi[c]);
          lo[a] = bLo[a] ^ (~bLo[b] & bLo[c]);
        }
      }
      hi[0] ^= RC_HI[round]; // ι: round constant, breaks the symmetry between rounds
      lo[0] ^= RC_LO[round];
    }
  }

  function keccak256Bytes(data) {
    const RATE = 136; // (1600 − 2·256) / 8 bytes per block
    const padded = new Uint8Array((Math.floor(data.length / RATE) + 1) * RATE);
    padded.set(data);
    padded[data.length] ^= 0x01; // pad10*1. When only one byte is free, both bits land in it (0x81).
    padded[padded.length - 1] ^= 0x80;
    const hi = new Uint32Array(25), lo = new Uint32Array(25);
    for (let off = 0; off < padded.length; off += RATE) {
      for (let i = 0; i < RATE / 8; i++) {
        const p = off + 8 * i; // lanes are little-endian
        lo[i] ^= padded[p] | (padded[p + 1] << 8) | (padded[p + 2] << 16) | (padded[p + 3] << 24);
        hi[i] ^= padded[p + 4] | (padded[p + 5] << 8) | (padded[p + 6] << 16) | (padded[p + 7] << 24);
      }
      keccakF1600(hi, lo);
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 4; i++) {
      for (let b = 0; b < 4; b++) { out[8 * i + b] = lo[i] >>> (8 * b); out[8 * i + 4 + b] = hi[i] >>> (8 * b); }
    }
    return out;
  }

  /** keccak256(Uint8Array | '0x…' hex) → '0x…'. Text goes through keccak256Utf8, so 'abcd' is never taken for hex. */
  function keccak256(data) {
    if (!isBytes(data) && !(typeof data === 'string' && data.startsWith('0x'))) {
      throw new TypeError('keccak256: expected a Uint8Array or 0x-prefixed hex string (use keccak256Utf8 for text), got ' + preview(data));
    }
    return bytesToHex(keccak256Bytes(bytesArg(data, 'keccak256')));
  }
  const keccak256Utf8 = (str) => bytesToHex(keccak256Bytes(utf8Bytes(str)));

  /** functionSelector('transfer(address,uint256)') → '0xa9059cbb'. The signature must be canonical: no spaces, no 'uint' alias. */
  function functionSelector(signature) {
    if (typeof signature !== 'string') throw new TypeError('functionSelector: expected a string, got ' + preview(signature));
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*\((.*)\)$/.exec(signature);
    if (!m) throw new Error('functionSelector: malformed signature ' + preview(signature));
    if (m[1] !== '') parseAbiType('(' + m[1] + ')'); // throws unless the parameter list is canonical
    return bytesToHex(keccak256Bytes(utf8Bytes(signature)).subarray(0, 4));
  }

  // ── 3. SHA-256 and HMAC-SHA256: used only for RFC 6979 deterministic nonces in the test signer ─────────────
  const SHA256_K = Uint32Array.from([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const SHA256_IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  function sha256Bytes(msg) {
    const len = msg.length;
    const padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64); // message ‖ 0x80 ‖ zeros ‖ 64-bit bit length
    padded.set(msg);
    padded[len] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
    view.setUint32(padded.length - 4, (len * 8) >>> 0);
    const H = SHA256_IV.slice(), W = new Uint32Array(64);
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + 4 * i);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + W[i]) | 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) | 0; });
    }
    const out = new Uint8Array(32), outView = new DataView(out.buffer);
    H.forEach((v, i) => outView.setUint32(4 * i, v >>> 0));
    return out;
  }

  function hmacSha256Bytes(key, msg) {
    const block = new Uint8Array(64);
    block.set(key.length > 64 ? sha256Bytes(key) : key);
    const inner = block.map((b) => b ^ 0x36), outer = block.map((b) => b ^ 0x5c);
    return sha256Bytes(concatList([outer, sha256Bytes(concatList([inner, msg]))]));
  }

  // ── 4. Addresses ────────────────────────────────────────────────────────────────────────────────────────
  const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
  const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
  /** Checks syntax only: 0x plus 40 hex digits in any case. The checksum is not enforced. */
  const isAddress = (s) => typeof s === 'string' && ADDRESS_RE.test(s);

  /** EIP-55 mixed-case checksum encoding. */
  function toChecksumAddress(address) {
    if (!isAddress(address)) throw new Error('toChecksumAddress: not an address: ' + preview(address));
    const lower = address.slice(2).toLowerCase();
    const hash = keccak256Bytes(textEncoder.encode(lower));
    let out = '0x';
    for (let i = 0; i < 40; i++) {
      const nibble = (hash[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
      out += nibble >= 8 ? lower[i].toUpperCase() : lower[i];
    }
    return out;
  }

  /** Case-insensitive comparison. Anything that is not a valid address is never "the same". */
  const sameAddress = (a, b) => isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();

  // ── 5. Solidity ABI v2: type parser, encoder and a strict, bounds-checked decoder ─────────────────────────
  const TWO_255 = 1n << 255n, TWO_256 = 1n << 256n;
  const MAX_STATIC_SIZE = 2 ** 32; // no sane type needs more than 4 GiB of head
  const TYPE_CACHE = new Map();

  /**
   * Parses a canonical type string into an immutable node:
   *   { kind, canonical, dynamic, headSize, inner, and bits | size | components | base + length }
   * headSize: bytes the value takes in its parent's head (32 when dynamic).
   * inner:    bytes that must exist where a dynamic value's offset points (its own head, or its length word).
   */
  function parseAbiType(type) {
    if (typeof type !== 'string') throw new TypeError('ABI: type must be a string, got ' + preview(type));
    let node = TYPE_CACHE.get(type);
    if (node) return node;
    const state = { s: type, i: 0 };
    node = parseTypeAt(state);
    if (state.i !== type.length) throw new Error(`ABI: unexpected ${preview(type[state.i])} in type ${preview(type)}`);
    if (TYPE_CACHE.size > 512) TYPE_CACHE.clear();
    TYPE_CACHE.set(type, node);
    return node;
  }

  function parseTypeAt(st) {
    const s = st.s;
    let node;
    if (s[st.i] === '(') {
      st.i++;
      const components = [];
      for (;;) {
        components.push(parseTypeAt(st)); // an empty tuple "()" fails here: canonical tuples have at least one member
        const c = s[st.i++];
        if (c === ')') break;
        if (c !== ',') throw new Error('ABI: malformed tuple in type ' + preview(s));
      }
      node = makeNode({
        kind: 'tuple', canonical: '(' + components.map((c) => c.canonical).join(',') + ')', components,
        dynamic: components.some((c) => c.dynamic), inner: components.reduce((sum, c) => sum + c.headSize, 0),
      });
    } else {
      const m = /^[a-z0-9]+/.exec(s.slice(st.i));
      if (!m) throw new Error('ABI: malformed type ' + preview(s));
      st.i += m[0].length;
      node = elementaryType(m[0], s);
    }
    while (s[st.i] === '[') { // array suffixes: T[] and T[k], k ≥ 1, possibly repeated
      const close = s.indexOf(']', st.i);
      const len = close < 0 ? null : s.slice(st.i + 1, close);
      if (len === null || !(len === '' || /^[1-9][0-9]*$/.test(len))) throw new Error('ABI: malformed array suffix in type ' + preview(s));
      st.i = close + 1;
      const base = node, length = len === '' ? null : Number(len);
      node = makeNode({
        kind: 'array', canonical: `${base.canonical}[${len}]`, base, length,
        dynamic: length === null || base.dynamic, inner: length === null ? 32 : length * base.headSize,
      });
    }
    return node;
  }

  function elementaryType(name, full) {
    if (name === 'address' || name === 'bool') return makeNode({ kind: name, canonical: name, dynamic: false, inner: 32 });
    if (name === 'string' || name === 'bytes') return makeNode({ kind: name, canonical: name, dynamic: true, inner: 32 });
    let m = /^(u?int)([1-9][0-9]*)$/.exec(name);
    if (m && +m[2] % 8 === 0 && +m[2] <= 256) return makeNode({ kind: m[1], canonical: name, bits: +m[2], dynamic: false, inner: 32 });
    m = /^bytes([1-9][0-9]*)$/.exec(name);
    if (m && +m[1] <= 32) return makeNode({ kind: 'fixedBytes', canonical: name, size: +m[1], dynamic: false, inner: 32 });
    throw new Error(`ABI: unsupported type ${preview(name)} in ${preview(full)} (use canonical names such as uint256 and bytes32)`);
  }

  function makeNode(n) {
    if (n.inner > MAX_STATIC_SIZE) throw new Error('ABI: type ' + preview(n.canonical) + ' is too large');
    n.headSize = n.dynamic ? 32 : n.inner;
    return Object.freeze(n);
  }

  // Encoder

  function toBigInt(v, what) {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') {
      if (Number.isSafeInteger(v)) return BigInt(v);
      throw new RangeError(`${what}: ${v} is not a safe integer; pass a BigInt`);
    }
    if (typeof v === 'string' && /^(-?[0-9]+|0x[0-9a-fA-F]+)$/.test(v)) return BigInt(v);
    throw new TypeError(`${what}: expected an integer (BigInt, safe integer or numeric string), got ${preview(v)}`);
  }

  const rightPad32 = (b) => { const out = new Uint8Array(Math.ceil(b.length / 32) * 32); out.set(b); return out; };

  function encodeValue(t, v, path) {
    const where = `abiEncode ${path} (${t.canonical})`;
    switch (t.kind) {
      case 'address':
        if (!isAddress(v)) throw new TypeError(`${where}: expected an address, got ${preview(v)}`);
        return concatList([new Uint8Array(12), hexToBytes(v)]);
      case 'bool':
        if (typeof v !== 'boolean') throw new TypeError(`${where}: expected true or false, got ${preview(v)}`);
        return bigIntToBytes32(v ? 1n : 0n);
      case 'uint':
      case 'int': {
        const x = toBigInt(v, where);
        const min = t.kind === 'uint' ? 0n : -(1n << BigInt(t.bits - 1));
        const max = t.kind === 'uint' ? (1n << BigInt(t.bits)) - 1n : (1n << BigInt(t.bits - 1)) - 1n;
        if (x < min || x > max) throw new RangeError(`${where}: ${x} is out of range`);
        return bigIntToBytes32(x < 0n ? x + TWO_256 : x); // two's complement for negative values
      }
      case 'fixedBytes':
        return rightPad32(fixedBytesArg(v, t.size, where));
      case 'bytes':
      case 'string': {
        if (t.kind === 'string' && typeof v !== 'string') throw new TypeError(`${where}: expected a string, got ${preview(v)}`);
        const b = t.kind === 'string' ? utf8Bytes(v) : bytesArg(v, where);
        return concatList([bigIntToBytes32(BigInt(b.length)), rightPad32(b)]);
      }
      case 'array': {
        if (!Array.isArray(v)) throw new TypeError(`${where}: expected an array, got ${preview(v)}`);
        if (t.length !== null && v.length !== t.length) throw new Error(`${where}: expected ${t.length} elements, got ${v.length}`);
        const body = encodeSequence(v.map(() => t.base), v, path);
        return t.length === null ? concatList([bigIntToBytes32(BigInt(v.length)), body]) : body;
      }
      case 'tuple':
        if (!Array.isArray(v) || v.length !== t.components.length) {
          throw new TypeError(`${where}: expected an array of ${t.components.length} values, got ${Array.isArray(v) ? v.length + ' values' : preview(v)}`);
        }
        return encodeSequence(t.components, v, path);
    }
    throw new Error('ABI: unreachable');
  }

  /** Head/tail layout: static values sit in the head, and each dynamic value is an offset in the head pointing into the tail. */
  function encodeSequence(types, values, path) {
    const headLen = types.reduce((sum, t) => sum + t.headSize, 0);
    const heads = [], tails = [];
    let tailLen = 0;
    types.forEach((t, i) => {
      const enc = encodeValue(t, values[i], `${path}[${i}]`);
      if (!t.dynamic) return heads.push(enc);
      heads.push(bigIntToBytes32(BigInt(headLen + tailLen)));
      tails.push(enc);
      tailLen += enc.length;
    });
    return concatList(heads.concat(tails));
  }

  /**
   * abiEncode(['uint256','(address,bytes)[]'], [1n, [['0x…','0x…']]]) → '0x…'.
   * Tuples are arrays. Integers can be BigInt, safe integers or numeric strings. Bytes can be 0x-hex or a Uint8Array.
   */
  function abiEncode(types, values) {
    if (!Array.isArray(types)) throw new TypeError('abiEncode: types must be an array of type strings');
    if (!Array.isArray(values) || values.length !== types.length) throw new TypeError(`abiEncode: expected ${types.length} values`);
    return bytesToHex(encodeSequence(types.map(parseAbiType), values, 'args'));
  }

  // Decoder. It is strict in the same places Solidity's ABI coder v2 is strict: dirty high bits in addresses and small
  // integers, bools other than 0/1, and dirty low bytes in bytesN revert there and throw here. It never reads past the
  // buffer and rejects lengths that cannot fit in the remaining data. Total work is capped at about twice the input
  // size, so aliased offsets cannot turn a small input into a huge output.

  function decodeBody(types, bytes) {
    const ctx = { bytes, hex: bytesToHex(bytes), budget: 2 * Math.ceil(bytes.length / 32) + 8 };
    return decodeSequence(ctx, types, 0);
  }

  function spend(ctx, units) {
    ctx.budget -= units;
    if (ctx.budget < 0) throw new Error('abiDecode: data reuses the same bytes too many times (aliased offsets are not accepted)');
  }

  function word(ctx, pos) {
    if (pos + 32 > ctx.bytes.length) throw new Error(`abiDecode: data too short (needs 32 bytes at offset ${pos}, length is ${ctx.bytes.length})`);
    spend(ctx, 1);
    return ctx.bytes.subarray(pos, pos + 32);
  }
  const wordBigInt = (ctx, pos) => (word(ctx, pos), BigInt('0x' + ctx.hex.slice(2 + 2 * pos, 66 + 2 * pos)));

  function decodeSequence(ctx, types, base) {
    const out = new Array(types.length);
    let head = base;
    for (let i = 0; i < types.length; i++) {
      const t = types[i];
      if (t.dynamic) { // the head holds an offset relative to this sequence's start
        const rel = wordBigInt(ctx, head);
        if (BigInt(base) + rel + BigInt(t.inner) > BigInt(ctx.bytes.length)) {
          throw new Error(`abiDecode: offset ${rel} for ${t.canonical} at byte ${head} points outside the data`);
        }
        out[i] = decodeAt(ctx, t, base + Number(rel));
      } else {
        out[i] = decodeAt(ctx, t, head);
      }
      head += t.headSize;
    }
    return out;
  }

  function decodeAt(ctx, t, pos) {
    switch (t.kind) {
      case 'address': {
        const w = word(ctx, pos);
        if (w.subarray(0, 12).some((b) => b !== 0)) throw new Error(`abiDecode: address at byte ${pos} has non-zero high bytes`);
        return bytesToHex(w.subarray(12));
      }
      case 'bool': {
        const v = wordBigInt(ctx, pos);
        if (v > 1n) throw new Error(`abiDecode: bool at byte ${pos} is ${v}, not 0 or 1`);
        return v === 1n;
      }
      case 'uint': {
        const v = wordBigInt(ctx, pos);
        if (v >> BigInt(t.bits) !== 0n) throw new Error(`abiDecode: ${t.canonical} at byte ${pos} is out of range`);
        return v;
      }
      case 'int': {
        const u = wordBigInt(ctx, pos), v = u >= TWO_255 ? u - TWO_256 : u, lim = 1n << BigInt(t.bits - 1);
        if (v < -lim || v >= lim) throw new Error(`abiDecode: ${t.canonical} at byte ${pos} is not properly sign-extended`);
        return v;
      }
      case 'fixedBytes': {
        const w = word(ctx, pos);
        if (w.subarray(t.size).some((b) => b !== 0)) throw new Error(`abiDecode: ${t.canonical} at byte ${pos} has non-zero padding`);
        return bytesToHex(w.subarray(0, t.size));
      }
      case 'bytes':
      case 'string': {
        const len = wordBigInt(ctx, pos), start = pos + 32;
        if (len > BigInt(ctx.bytes.length - start)) throw new Error(`abiDecode: ${t.kind} length ${len} at byte ${pos} exceeds the data`);
        const n = Number(len);
        spend(ctx, Math.ceil(n / 32));
        const slice = ctx.bytes.subarray(start, start + n); // trailing padding is not required; Solidity doesn't require it either
        if (t.kind === 'bytes') return bytesToHex(slice);
        try {
          return utf8Decoder.decode(slice);
        } catch (_) {
          throw new Error(`abiDecode: string at byte ${pos} is not valid UTF-8`);
        }
      }
      case 'array': {
        let length = t.length, start = pos;
        if (length === null) {
          const len = wordBigInt(ctx, pos);
          start = pos + 32;
          if (len * BigInt(t.base.headSize) > BigInt(ctx.bytes.length - start)) {
            throw new Error(`abiDecode: array length ${len} at byte ${pos} cannot fit in the remaining data`);
          }
          length = Number(len);
        }
        return decodeSequence(ctx, new Array(length).fill(t.base), start);
      }
      case 'tuple':
        return decodeSequence(ctx, t.components, pos);
    }
    throw new Error('ABI: unreachable');
  }

  /**
   * abiDecode(types, '0x…' | Uint8Array) → values.
   * Addresses come back lowercase. All int and uint values are BigInt. bytes and bytesN come back as lowercase hex.
   * Strings are decoded as strict UTF-8. Tuples and arrays come back as arrays.
   */
  function abiDecode(types, data) {
    if (!Array.isArray(types)) throw new TypeError('abiDecode: types must be an array of type strings');
    return decodeBody(types.map(parseAbiType), bytesArg(data, 'abiDecode'));
  }

  // ── 6. PAR launch calldata (PairPadMultiLaunchFactory.launchToken, PairPadMultiRouter.launchAndBuyWithEth) ──
  const TOKEN_PARAMS = '(string,string,string,string,(string,string,string,string,string),address,uint16,bytes32,bytes32)';
  const BUY_LEG = '(uint8,((address,address,uint24,int24,address),bool)[],uint256)';
  const LAUNCH_ARGS = {
    launchToken: [TOKEN_PARAMS, 'uint256', 'address[]'],
    launchAndBuyWithEth: [TOKEN_PARAMS, 'uint256', 'address[]', BUY_LEG + '[]', 'uint256'],
  };
  const LAUNCH_SIGNATURES = Object.freeze({
    launchToken: `launchToken(${LAUNCH_ARGS.launchToken.join(',')})`,
    launchAndBuyWithEth: `launchAndBuyWithEth(${LAUNCH_ARGS.launchAndBuyWithEth.join(',')})`,
  });
  // The first 4 bytes of keccak256(signature). The unit tests recompute both.
  const LAUNCH_SELECTORS = Object.freeze({ launchToken: '0x5a4b7ef0', launchAndBuyWithEth: '0x5fe889a4' });

  /**
   * Decodes PAR launch calldata into { fn, params, launchConfigId, pairTokens }, plus legs and minTokensOut for
   * launchAndBuyWithEth. These fields are JS numbers: uint16 creatorTaxBps, uint8 legs[].market, uint24 hops[].key.fee
   * and int24 hops[].key.tickSpacing. launchConfigId, amountIn and minTokensOut stay BigInt. Addresses are lowercase.
   * An unknown selector or malformed data throws.
   */
  function decodeLaunchCalldata(data) {
    const bytes = bytesArg(data, 'decodeLaunchCalldata');
    if (bytes.length < 4) throw new Error('decodeLaunchCalldata: calldata is shorter than a function selector');
    const selector = bytesToHex(bytes.subarray(0, 4));
    const fn = Object.keys(LAUNCH_SELECTORS).find((k) => LAUNCH_SELECTORS[k] === selector);
    if (!fn) throw new Error(`decodeLaunchCalldata: unknown selector ${selector}`);
    const args = decodeBody(LAUNCH_ARGS[fn].map(parseAbiType), bytes.subarray(4));
    const [name, symbol, logo, description, socials, creatorFeeRecipient, creatorTaxBps, expectedEconomics, salt] = args[0];
    const out = {
      fn,
      params: {
        name, symbol, logo, description,
        socials: { twitter: socials[0], telegram: socials[1], discord: socials[2], website: socials[3], farcaster: socials[4] },
        creatorFeeRecipient, creatorTaxBps: Number(creatorTaxBps), expectedEconomics, salt,
      },
      launchConfigId: args[1],
      pairTokens: args[2],
    };
    if (fn === 'launchAndBuyWithEth') {
      out.legs = args[3].map(([market, hops, amountIn]) => ({
        market: Number(market),
        hops: hops.map(([[currency0, currency1, fee, tickSpacing, hooks], v3]) => ({
          key: { currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks }, v3,
        })),
        amountIn,
      }));
      out.minTokensOut = args[4];
    }
    return out;
  }

  // ── 7. EIP-712 typed data and personal_sign ─────────────────────────────────────────────────────────────
  const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  const ARRAY_TYPE_RE = /^(.+)\[((?:[1-9][0-9]*)?)\]$/;
  const EIP_ATOMIC_RE = new RegExp('^(?:address|bool|string|bytes|bytes(?:[1-9]|[12][0-9]|3[0-2])|u?int(?:' +
    Array.from({ length: 32 }, (_, i) => 8 * (i + 1)).join('|') + '))$');
  const DOMAIN_FIELDS = [['name', 'string'], ['version', 'string'], ['chainId', 'uint256'], ['verifyingContract', 'address'], ['salt', 'bytes32']];

  function eipBaseType(type) {
    for (let m; (m = ARRAY_TYPE_RE.exec(type)); ) type = m[1];
    return type;
  }
  const isStruct = (types, name) => hasOwn(types, name) && IDENT_RE.test(name);

  function validateEipTypes(types) {
    if (!isPlainObject(types)) throw new TypeError('EIP-712: types must be an object');
    for (const name of Object.keys(types)) {
      const fields = types[name];
      if (!IDENT_RE.test(name) || EIP_ATOMIC_RE.test(name)) throw new Error('EIP-712: invalid struct name ' + preview(name));
      if (!Array.isArray(fields)) throw new TypeError(`EIP-712: types.${name} must be an array of {name, type}`);
      const seen = new Set();
      for (const f of fields) {
        if (!isPlainObject(f) || typeof f.name !== 'string' || typeof f.type !== 'string' || !IDENT_RE.test(f.name)) {
          throw new Error(`EIP-712: malformed field in ${name}`);
        }
        if (seen.has(f.name)) throw new Error(`EIP-712: duplicate field ${name}.${f.name}`);
        seen.add(f.name);
        const base = eipBaseType(f.type);
        if (!isStruct(types, base) && !EIP_ATOMIC_RE.test(base)) throw new Error(`EIP-712: ${name}.${f.name} has unknown type ${preview(f.type)}`);
      }
    }
  }

  /** "Primary(…)" followed by every struct it references, directly or not, in alphabetical order. */
  function encodeType(primaryType, types) {
    if (!isStruct(types, primaryType)) throw new Error('EIP-712: unknown struct type ' + preview(primaryType));
    const deps = new Set();
    (function collect(name) {
      if (deps.has(name)) return;
      deps.add(name);
      for (const f of types[name]) if (isStruct(types, eipBaseType(f.type))) collect(eipBaseType(f.type));
    })(primaryType);
    deps.delete(primaryType);
    return [primaryType, ...Array.from(deps).sort()].map((n) => `${n}(${types[n].map((f) => `${f.type} ${f.name}`).join(',')})`).join('');
  }

  function encodeField(types, type, value, path) {
    if (value === undefined || value === null) throw new Error(`EIP-712: missing value for ${path}`);
    const arr = ARRAY_TYPE_RE.exec(type);
    if (arr) { // arrays: keccak of the concatenated element encodings
      if (!Array.isArray(value)) throw new TypeError(`EIP-712: ${path} must be an array`);
      if (arr[2] !== '' && value.length !== Number(arr[2])) throw new Error(`EIP-712: ${path} must have ${arr[2]} elements`);
      return keccak256Bytes(concatList(value.map((v, i) => encodeField(types, arr[1], v, `${path}[${i}]`))));
    }
    if (isStruct(types, type)) return keccak256Bytes(encodeData(types, type, value, path));
    if (type === 'string') {
      if (typeof value !== 'string') throw new TypeError(`EIP-712: ${path} must be a string`);
      return keccak256Bytes(utf8Bytes(value));
    }
    if (type === 'bytes') return keccak256Bytes(bytesArg(value, 'EIP-712 ' + path));
    return encodeValue(parseAbiType(type), value, path); // atomic types: exactly one ABI word
  }

  function encodeData(types, name, data, path) {
    if (!isPlainObject(data)) throw new TypeError(`EIP-712: ${path} must be an object`);
    const fields = types[name];
    // Wallets ignore undeclared properties. Accepting them would let a record claim fields that nobody signed.
    for (const key of Object.keys(data)) {
      if (!fields.some((f) => f.name === key)) throw new Error(`EIP-712: ${path} has property ${preview(key)} that ${name} does not declare`);
    }
    const parts = [keccak256Bytes(utf8Bytes(encodeType(name, types)))];
    // Own properties only: an inherited 'constructor' or 'toString' is not a signed value.
    for (const f of fields) parts.push(encodeField(types, f.type, hasOwn(data, f.name) ? data[f.name] : undefined, `${path}.${f.name}`));
    return concatList(parts);
  }

  /** Uses the EIP712Domain type from types if present; otherwise derives it from the domain's keys, in the order the EIP lists them. */
  function withDomainType(domain, types) {
    if (!isPlainObject(domain)) throw new TypeError('EIP-712: domain must be an object');
    if (types !== undefined && !isPlainObject(types)) throw new TypeError('EIP-712: types must be an object');
    const all = Object.create(null); // a plain copy; a "__proto__" key stays an ordinary key
    for (const k of Object.keys(types || {})) all[k] = types[k];
    if (!hasOwn(all, 'EIP712Domain')) {
      for (const key of Object.keys(domain)) {
        if (!DOMAIN_FIELDS.some(([k]) => k === key)) throw new Error('EIP-712: unknown domain field ' + preview(key));
      }
      all.EIP712Domain = DOMAIN_FIELDS.filter(([k]) => domain[k] !== undefined).map(([name, type]) => ({ name, type }));
    }
    validateEipTypes(all);
    return all;
  }

  function hashStruct(primaryType, data, types) {
    validateEipTypes(types);
    if (!isStruct(types, primaryType)) throw new Error('EIP-712: unknown struct type ' + preview(primaryType));
    return bytesToHex(keccak256Bytes(encodeData(types, primaryType, data, primaryType)));
  }

  const hashDomain = (domain, types) => bytesToHex(keccak256Bytes(encodeData(withDomainType(domain, types), 'EIP712Domain', domain, 'domain')));

  /** keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct(message)), the digest eth_signTypedData_v4 signs. */
  function hashTypedData(typedData) {
    if (!isPlainObject(typedData) || !isPlainObject(typedData.types)) throw new TypeError('hashTypedData: expected {types, primaryType, domain, message}');
    const { primaryType, domain, message } = typedData;
    const types = withDomainType(domain, typedData.types);
    if (!isStruct(types, primaryType)) throw new Error('hashTypedData: unknown primaryType ' + preview(primaryType));
    const parts = [Uint8Array.of(0x19, 0x01), keccak256Bytes(encodeData(types, 'EIP712Domain', domain, 'domain'))];
    if (primaryType !== 'EIP712Domain') parts.push(keccak256Bytes(encodeData(types, primaryType, message, 'message')));
    return bytesToHex(keccak256Bytes(concatList(parts)));
  }

  /** personal_sign (EIP-191 version 0x45). A JS string is hashed as UTF-8 text, even when it looks like hex. */
  function hashPersonalMessage(message) {
    let bytes;
    if (typeof message === 'string') bytes = utf8Bytes(message);
    else if (isBytes(message)) bytes = message;
    else throw new TypeError('hashPersonalMessage: expected a string or Uint8Array, got ' + preview(message));
    return bytesToHex(keccak256Bytes(concatList([utf8Bytes('\x19Ethereum Signed Message:\n' + bytes.length), bytes])));
  }

  // ── 8. secp256k1: y² = x³ + 7 over F_p ──────────────────────────────────────────────────────────────────
  // Points use Jacobian coordinates (X/Z², Y/Z³), so the scalar-multiplication loop needs no inversions. Recovery only
  // handles public data. The signer at the end is not constant-time and exists only for tests and test harnesses.
  const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
  const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
  const HALF_N = N >> 1n;
  const JINF = Object.freeze({ X: 0n, Y: 1n, Z: 0n }); // point at infinity (Z = 0)
  const modP = (a) => { const r = a % P; return r < 0n ? r + P : r; };
  const modN = (a) => { const r = a % N; return r < 0n ? r + N : r; };

  /** Modular inverse by the extended Euclidean algorithm. */
  function invert(a, m) {
    let r0 = m, r1 = ((a % m) + m) % m, s0 = 0n, s1 = 1n; // invariant: sᵢ · a ≡ rᵢ (mod m)
    if (r1 === 0n) throw new Error('secp256k1: cannot invert zero');
    while (r1 !== 0n) {
      const q = r0 / r1;
      [r0, r1] = [r1, r0 - q * r1];
      [s0, s1] = [s1, s0 - q * s1];
    }
    if (r0 !== 1n) throw new Error('secp256k1: value is not invertible');
    return ((s0 % m) + m) % m;
  }

  function powMod(base, exp, m) {
    let result = 1n;
    for (base %= m; exp > 0n; exp >>= 1n) {
      if (exp & 1n) result = (result * base) % m;
      base = (base * base) % m;
    }
    return result;
  }

  /** √a mod p as a^((p+1)/4), valid because p ≡ 3 (mod 4). Returns null when a is not a square. */
  function sqrtModP(a) {
    const r = powMod(a, (P + 1n) >> 2n, P);
    return modP(r * r) === modP(a) ? r : null;
  }

  const isOnCurve = (x, y) => x >= 0n && x < P && y >= 0n && y < P && modP(y * y) === modP(x * x * x + 7n);

  function jDouble(p) { // dbl-2009-l (a = 0)
    if (p.Z === 0n || p.Y === 0n) return JINF;
    const A = modP(p.X * p.X), B = modP(p.Y * p.Y), C = modP(B * B);
    const D = modP(2n * (modP((p.X + B) * (p.X + B)) - A - C));
    const E = modP(3n * A), F = modP(E * E);
    const X3 = modP(F - 2n * D);
    return { X: X3, Y: modP(E * (D - X3) - 8n * C), Z: modP(2n * p.Y * p.Z) };
  }

  function jAdd(p, q) {
    if (p.Z === 0n) return q;
    if (q.Z === 0n) return p;
    const pz2 = modP(p.Z * p.Z), qz2 = modP(q.Z * q.Z);
    const u1 = modP(p.X * qz2), u2 = modP(q.X * pz2);
    const s1 = modP(p.Y * modP(q.Z * qz2)), s2 = modP(q.Y * modP(p.Z * pz2));
    if (u1 === u2) return s1 === s2 ? jDouble(p) : JINF; // the same point, or P + (−P)
    const h = modP(u2 - u1), r = modP(s2 - s1);
    const h2 = modP(h * h), h3 = modP(h * h2), u1h2 = modP(u1 * h2);
    const X3 = modP(r * r - h3 - 2n * u1h2);
    return { X: X3, Y: modP(r * (u1h2 - X3) - s1 * h3), Z: modP(h * modP(p.Z * q.Z)) };
  }

  function toAffine(p) {
    if (p.Z === 0n) return null;
    const zi = invert(p.Z, P), zi2 = modP(zi * zi);
    return { x: modP(p.X * zi2), y: modP(p.Y * modP(zi2 * zi)) };
  }

  /** [∞, 1·P, 2·P, …, 15·P] for 4-bit windows. */
  function windowTable(x, y) {
    const table = [JINF, { X: x, Y: y, Z: 1n }];
    for (let i = 2; i < 16; i++) table.push(jAdd(table[i - 1], table[1]));
    return table;
  }
  let gTableCache = null;
  const gTable = () => gTableCache || (gTableCache = windowTable(GX, GY));

  /** Σ kᵢ·Pᵢ with one shared doubling chain (Straus–Shamir) over 4-bit windows. Every kᵢ must be in [0, n). */
  function multiScalarMul(terms) {
    const digits = terms.map((t) => t.k.toString(16).padStart(64, '0'));
    let acc = JINF;
    for (let i = 0; i < 64; i++) {
      if (acc.Z !== 0n) acc = jDouble(jDouble(jDouble(jDouble(acc))));
      for (let j = 0; j < terms.length; j++) {
        const w = parseInt(digits[j][i], 16);
        if (w !== 0) acc = jAdd(acc, terms[j].table[w]);
      }
    }
    return acc;
  }

  function mulG(k) {
    if (typeof k !== 'bigint' || k <= 0n || k >= N) throw new RangeError('mulG: scalar must be a BigInt in [1, n-1]');
    return toAffine(multiScalarMul([{ table: gTable(), k }]));
  }

  const pointToBytes = (pt) => concatList([Uint8Array.of(4), bigIntToBytes32(pt.x), bigIntToBytes32(pt.y)]);

  /** 65 bytes r ‖ s ‖ v, with v ∈ {0, 1, 27, 28} and 0 < r, s < n. 64-byte EIP-2098 compact signatures are rejected. */
  function parseSignature(signature) {
    if (!isBytes(signature) && !(typeof signature === 'string' && signature.startsWith('0x'))) {
      throw new TypeError('signature must be a 0x-prefixed hex string or Uint8Array, got ' + preview(signature));
    }
    const b = bytesArg(signature, 'signature');
    if (b.length !== 65) {
      throw new Error(`signature must be 65 bytes (r‖s‖v), got ${b.length}` + (b.length === 64 ? ' (compact EIP-2098 signatures are not accepted)' : ''));
    }
    const r = bytesToBigInt(b.subarray(0, 32)), s = bytesToBigInt(b.subarray(32, 64)), v = b[64];
    if (r === 0n || r >= N) throw new Error('signature r must be in [1, n-1]');
    if (s === 0n || s >= N) throw new Error('signature s must be in [1, n-1]');
    if (v !== 0 && v !== 1 && v !== 27 && v !== 28) throw new Error(`signature v must be 0, 1, 27 or 28, got ${v}`);
    return { r, s, recid: v >= 27 ? v - 27 : v };
  }

  /**
   * Standard ECDSA public-key recovery, the same as Ethereum's ecrecover. Like ecrecover, it also accepts high-s.
   * Q = r⁻¹ · (s·R − e·G), where R is the curve point with x = r and y parity = recid.
   */
  function recoverPoint(digest, signature) {
    const e = bytesToBigInt(fixedBytesArg(digest, 32, 'digest'));
    const { r, s, recid } = parseSignature(signature);
    // r < n < p, so x = r is a valid field element. Recovery ids 2/3 (x = r + n) cannot be expressed in Ethereum's v.
    let y = sqrtModP(modP(r * r * r + 7n));
    if (y === null) throw new Error('signature r is not the x-coordinate of a curve point');
    if (Number(y & 1n) !== recid) y = modP(P - y);
    const rInv = invert(r, N);
    const q = toAffine(multiScalarMul([{ table: gTable(), k: modN(-e * rInv) }, { table: windowTable(r, y), k: modN(s * rInv) }]));
    if (!q) throw new Error('signature recovers the point at infinity');
    return q;
  }

  /** → Uint8Array(65): the uncompressed public key 0x04 ‖ x ‖ y */
  const recoverPublicKey = (digest, signature) => pointToBytes(recoverPoint(digest, signature));

  function publicKeyToAddress(publicKey) {
    const b = bytesArg(publicKey, 'publicKeyToAddress');
    if (b.length !== 65 || b[0] !== 4) throw new Error('publicKeyToAddress: expected a 65-byte uncompressed key (0x04 ‖ x ‖ y)');
    if (!isOnCurve(bytesToBigInt(b.subarray(1, 33)), bytesToBigInt(b.subarray(33)))) throw new Error('publicKeyToAddress: point is not on secp256k1');
    return bytesToHex(keccak256Bytes(b.subarray(1)).subarray(12));
  }

  const recoverAddress = (digest, signature) => publicKeyToAddress(recoverPublicKey(digest, signature));
  const recoverTypedDataAddress = (typedData, signature) => recoverAddress(hashTypedData(typedData), signature);
  const recoverPersonalSignAddress = (message, signature) => recoverAddress(hashPersonalMessage(message), signature);

  // Test-only signer

  function privateKeyScalar(key) {
    const d = bytesToBigInt(fixedBytesArg(key, 32, 'private key'));
    if (d === 0n || d >= N) throw new RangeError('private key must be in [1, n-1]');
    return d;
  }

  /** RFC 6979 §3.2 nonces with HMAC-SHA256. Here qlen = hlen = 256, so bits2int is the plain integer. */
  function* rfc6979Nonces(d, h) {
    const x = bigIntToBytes32(d), h1 = bigIntToBytes32(modN(bytesToBigInt(h)));
    let K = new Uint8Array(32), V = new Uint8Array(32).fill(1);
    K = hmacSha256Bytes(K, concatList([V, Uint8Array.of(0), x, h1]));
    V = hmacSha256Bytes(K, V);
    K = hmacSha256Bytes(K, concatList([V, Uint8Array.of(1), x, h1]));
    V = hmacSha256Bytes(K, V);
    for (;;) {
      V = hmacSha256Bytes(K, V);
      const k = bytesToBigInt(V);
      if (k > 0n && k < N) yield k;
      K = hmacSha256Bytes(K, concatList([V, Uint8Array.of(0)]));
      V = hmacSha256Bytes(K, V);
    }
  }

  /** sign(digest, privateKey, k?) → '0x' r ‖ s ‖ v, with v = 27/28 and low s. The nonce comes from RFC 6979 unless k is given. */
  function sign(digest, privateKey, k) {
    const h = fixedBytesArg(digest, 32, 'sign: digest');
    const d = privateKeyScalar(privateKey), e = bytesToBigInt(h);
    const attempt = (kk) => {
      const R = toAffine(multiScalarMul([{ table: gTable(), k: kk }]));
      if (R.x >= N) return null; // would need recovery id 2/3, which v cannot express (probability about 2⁻¹²⁸)
      const r = R.x;
      let s = modN(invert(kk, N) * (e + r * d));
      if (r === 0n || s === 0n) return null;
      let recid = Number(R.y & 1n);
      if (s > HALF_N) { s = N - s; recid ^= 1; } // canonical low-s form; negating s flips R's parity
      return bytesToHex(concatList([bigIntToBytes32(r), bigIntToBytes32(s), Uint8Array.of(27 + recid)]));
    };
    if (k !== undefined) {
      if (typeof k !== 'bigint' || k <= 0n || k >= N) throw new RangeError('sign: k must be a BigInt in [1, n-1]');
      const sig = attempt(k);
      if (!sig) throw new Error('sign: this k gives an unusable signature; choose another');
      return sig;
    }
    for (const kk of rfc6979Nonces(d, h)) {
      const sig = attempt(kk);
      if (sig) return sig;
    }
    throw new Error('unreachable');
  }

  const privateKeyToAddress = (key) => publicKeyToAddress(pointToBytes(mulG(privateKeyScalar(key))));

  // ── 9. SyncNet provenance ───────────────────────────────────────────────────────────────────────────────
  const PROVENANCE_DOMAIN = 'SYNCNET/1';

  /** keccak256 of the exact UTF-8 bytes of the intent record JSON, as launch-engine-v2.js computes it. */
  function recordHashOf(intentJson) {
    if (typeof intentJson !== 'string') throw new TypeError('recordHashOf: expected the intent JSON string');
    return keccak256(utf8Bytes(intentJson));
  }

  /** The PAR salt that commits to the record: keccak256(abi.encode('SYNCNET/1', recordHash)). */
  function intentSalt(recordHash) {
    if (typeof recordHash !== 'string' || !BYTES32_RE.test(recordHash)) throw new TypeError('intentSalt: recordHash must be a 0x-prefixed bytes32');
    return keccak256(abiEncode(['string', 'bytes32'], [PROVENANCE_DOMAIN, recordHash]));
  }

  /** A positive safe-integer chain id from a number, BigInt or decimal string. It becomes a number, so the typed data stays JSON-serialisable. */
  function chainIdNumber(v, what) {
    let n = NaN;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'bigint' && v > 0n && v <= BigInt(Number.MAX_SAFE_INTEGER)) n = Number(v);
    else if (typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v)) n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${what}: chainId must be a positive integer, got ${preview(v)}`);
    return n;
  }

  function intentFields(input, what) {
    if (!isPlainObject(input)) throw new TypeError(what + ': expected {chainId, operator, token, recordHash, salt}');
    const { operator, token, recordHash, salt } = input;
    if (!isAddress(operator)) throw new TypeError(`${what}: operator must be an address, got ${preview(operator)}`);
    if (!isAddress(token)) throw new TypeError(`${what}: token must be an address, got ${preview(token)}`);
    if (typeof recordHash !== 'string' || !BYTES32_RE.test(recordHash)) throw new TypeError(`${what}: recordHash must be a bytes32 hex string`);
    if (typeof salt !== 'string' || !BYTES32_RE.test(salt)) throw new TypeError(`${what}: salt must be a bytes32 hex string`);
    return { chainId: chainIdNumber(input.chainId, what), operator, token, recordHash, salt };
  }

  /** The exact EIP-712 payload the builder asks the wallet to sign. Values pass through unchanged, except chainId, which becomes a number. */
  function launchIntentTypedData(input) {
    const f = intentFields(input, 'launchIntentTypedData');
    return {
      types: {
        EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }],
        LaunchIntent: [{ name: 'operator', type: 'address' }, { name: 'token', type: 'address' }, { name: 'recordHash', type: 'bytes32' }, { name: 'salt', type: 'bytes32' }],
      },
      primaryType: 'LaunchIntent',
      domain: { name: 'SyncNet Launch Provenance', version: '1', chainId: f.chainId },
      message: { operator: f.operator, token: f.token, recordHash: f.recordHash, salt: f.salt },
    };
  }

  /** The personal_sign fallback text for wallets without eth_signTypedData_v4. */
  function launchIntentPlainMessage(input) {
    const f = intentFields(input, 'launchIntentPlainMessage');
    return `SyncNet Launch Intent v1\nchainId:${f.chainId}\noperator:${f.operator}\ntoken:${f.token}\nrecordHash:${f.recordHash}\nsalt:${f.salt}`;
  }

  function sameKeySet(x, y) {
    const a = Object.keys(x).sort(), b = Object.keys(y).sort();
    return a.length === b.length && a.every((k, i) => k === b[i]);
  }
  const keySet = (names) => { const o = Object.create(null); for (const n of names) o[n] = 1; return o; };
  const FIELD_KEYS = keySet(['name', 'type']), TYPED_DATA_KEYS = keySet(['types', 'primaryType', 'domain', 'message']);

  function sameTypeDefs(x, y) {
    if (!isPlainObject(x) || !isPlainObject(y) || !sameKeySet(x, y)) return false;
    return Object.keys(x).every((name) => Array.isArray(x[name]) && Array.isArray(y[name]) && x[name].length === y[name].length &&
      x[name].every((f, i) => {
        const g = y[name][i];
        return isPlainObject(f) && isPlainObject(g) && sameKeySet(f, FIELD_KEYS) && sameKeySet(g, FIELD_KEYS) && f.name === g.name && f.type === g.type;
      }));
  }

  /** Compares two values of one EIP-712 atomic type the way the signature sees them: case-insensitive hex, numeric integers. */
  function sameAtom(type, u, v) {
    if (type === 'address') return sameAddress(u, v);
    if (type === 'string') return typeof u === 'string' && u === v;
    if (type === 'bool') return typeof u === 'boolean' && u === v;
    const hexOk = (x, size) => typeof x === 'string' && (size ? new RegExp(`^0x[0-9a-fA-F]{${2 * size}}$`) : /^0x([0-9a-fA-F]{2})*$/).test(x);
    if (type === 'bytes') return hexOk(u) && hexOk(v) && u.toLowerCase() === v.toLowerCase();
    const t = parseAbiType(type);
    if (t.kind === 'fixedBytes') return hexOk(u, t.size) && hexOk(v, t.size) && u.toLowerCase() === v.toLowerCase();
    if (t.kind === 'uint' || t.kind === 'int') return toBigInt(u, 'sameTypedIntent') === toBigInt(v, 'sameTypedIntent');
    return false; // structs and arrays do not occur in a LaunchIntent
  }

  function sameStructValues(fields, x, y) {
    if (!isPlainObject(x) || !isPlainObject(y)) return false;
    const names = keySet(fields.map((f) => f.name));
    return sameKeySet(x, names) && sameKeySet(y, names) && fields.every((f) => sameAtom(f.type, x[f.name], y[f.name]));
  }

  /**
   * True iff a and b are structurally the same LaunchIntent typed data. They need the same keys and type definitions,
   * the same domain (chainId compared numerically, whether it is a number, string or BigInt) and the same message
   * (addresses compared case-insensitively, hex compared lowercase). Never throws; malformed input is simply "not the same".
   */
  function sameTypedIntent(a, b) {
    try {
      if (!isPlainObject(a) || !isPlainObject(b) || !sameKeySet(a, TYPED_DATA_KEYS) || !sameKeySet(b, TYPED_DATA_KEYS)) return false;
      if (a.primaryType !== 'LaunchIntent' || b.primaryType !== 'LaunchIntent' || !sameTypeDefs(a.types, b.types)) return false;
      const domainFields = a.types.EIP712Domain, messageFields = a.types.LaunchIntent;
      if (!Array.isArray(domainFields) || !Array.isArray(messageFields)) return false;
      return sameStructValues(domainFields, a.domain, b.domain) && sameStructValues(messageFields, a.message, b.message);
    } catch (_) {
      return false;
    }
  }

  // ── 10. Text policy for permanent on-chain metadata and for displaying untrusted metadata ──────────────────
  const PAR_BYTE_LIMITS = Object.freeze({ name: 64, symbol: 16, logo: 512, description: 2048, social: 256 });
  const FIELD_LABELS = { name: 'Name', symbol: 'Symbol', logo: 'Logo', description: 'Description', social: 'Social link' };
  const REQUIRED_FIELDS = { name: true, symbol: true };
  const BIDI = [[0x061c, 0x061c], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069]];
  const INVISIBLE = [
    [0x00ad, 0x00ad], [0x034f, 0x034f], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200d],
    [0x2028, 0x2029], [0x2060, 0x2064], [0x206a, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0d], [0xfeff, 0xfeff],
    [0xffa0, 0xffa0], [0xfff9, 0xfffb], [0x1d173, 0x1d17a], [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
  ]; // U+FE0E and U+FE0F (text and emoji presentation selectors) are deliberately allowed
  const inRanges = (cp, ranges) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

  function unsafeReason(cp, multiline) {
    if (cp < 0x20) return cp === 0x0a && multiline ? null : 'control'; // C0 controls; TAB is always flagged
    if (cp < 0x7f) return null;
    if (cp <= 0x9f) return 'control'; // DEL and C1 controls
    if (inRanges(cp, BIDI)) return 'bidi';
    if (inRanges(cp, INVISIBLE)) return 'invisible';
    if ((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe) return 'noncharacter'; // incl. U+xFFFE and U+xFFFF of every plane
    if ((cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000) return 'private-use'; // BMP private use area, planes 15–16
    return null;
  }

  /** Calls fn(codePoint, index, length, reason | null) for each code point. index is a UTF-16 index; lone surrogates are reported as such. */
  function scanCodePoints(str, multiline, fn) {
    for (let i = 0; i < str.length; ) {
      const c = str.charCodeAt(i);
      if (c < 0xd800 || c > 0xdfff) {
        fn(c, i, 1, unsafeReason(c, multiline));
        i += 1;
      } else if (c <= 0xdbff && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
        const cp = ((c - 0xd800) << 10) + (str.charCodeAt(i + 1) - 0xdc00) + 0x10000;
        fn(cp, i, 2, unsafeReason(cp, multiline));
        i += 2;
      } else {
        fn(c, i, 1, 'lone-surrogate');
        i += 1;
      }
    }
  }

  const formatCodePoint = (cp) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

  /** → [{ index (UTF-16 index), codePoint: 'U+XXXX', reason }] for every character that must not go on-chain. */
  function findUnsafeChars(str, opts) {
    if (typeof str !== 'string') throw new TypeError('findUnsafeChars: expected a string, got ' + preview(str));
    const found = [];
    scanCodePoints(str, !!(opts && opts.multiline), (cp, index, _len, reason) => {
      if (reason) found.push({ index, codePoint: formatCodePoint(cp), reason });
    });
    return found;
  }

  /** NFC; CRLF and CR become LF; trim. Unless multiline, every whitespace run (incl. LF) collapses into one space. */
  function normalizeText(str, opts) {
    if (typeof str !== 'string') throw new TypeError('normalizeText: expected a string, got ' + preview(str));
    const s = str.normalize('NFC').replace(/\r\n?/g, '\n').trim();
    return opts && opts.multiline ? s : s.replace(/\s+/g, ' ');
  }

  const UNSAFE_PHRASE = {
    control: 'a control character',
    bidi: 'an invisible or direction-changing character',
    invisible: 'an invisible or direction-changing character',
    'private-use': 'a private-use character',
    noncharacter: 'a Unicode noncharacter',
    'lone-surrogate': 'a broken character (unpaired surrogate)',
  };

  /**
   * Validates one metadata field (name, symbol, logo, description or social) against PAR's UTF-8 byte limits.
   * multiline defaults to true for description only. EMPTY applies to name and symbol, which PAR requires.
   * Returns { ok, value (normalized: what goes on-chain), bytes, limit, errors: [{ code, message }] }.
   * Positions in messages are 1-based and count characters (code points) in the normalized value.
   */
  function validateMetadataField(field, value, opts) {
    if (typeof field !== 'string' || !hasOwn(PAR_BYTE_LIMITS, field)) {
      throw new TypeError(`validateMetadataField: unknown field ${preview(field)} (expected name, symbol, logo, description or social)`);
    }
    if (value === undefined || value === null) value = '';
    if (typeof value !== 'string') throw new TypeError(`validateMetadataField: ${field} must be a string, got ${preview(value)}`);
    const multiline = opts && opts.multiline !== undefined ? !!opts.multiline : field === 'description';
    const label = FIELD_LABELS[field], limit = PAR_BYTE_LIMITS[field];
    const normalized = normalizeText(value, { multiline });
    const bytes = utf8Length(normalized);
    const errors = [];
    if (normalized === '' && REQUIRED_FIELDS[field]) errors.push({ code: 'EMPTY', message: `${label} is required.` });
    const unsafe = findUnsafeChars(normalized, { multiline });
    if (unsafe.length) {
      const first = unsafe[0], position = Array.from(normalized.slice(0, first.index)).length + 1;
      let message = `${label} contains ${UNSAFE_PHRASE[first.reason]} (${first.codePoint}) at position ${position}.`;
      if (unsafe.length > 1) message += ` ${unsafe.length - 1} more unsafe character${unsafe.length > 2 ? 's' : ''} found.`;
      errors.push({ code: 'UNSAFE_CHARS', message, chars: unsafe });
    }
    if (bytes > limit) errors.push({ code: 'TOO_MANY_BYTES', message: `${label} is ${bytes} bytes in UTF-8; PAR allows ${limit}.` });
    return { ok: errors.length === 0, value: normalized, bytes, limit, errors };
  }

  function stripUnsafe(s, multiline) {
    let out = '';
    scanCodePoints(s, multiline, (_cp, index, len, reason) => { if (!reason) out += s.slice(index, index + len); });
    return out;
  }

  /**
   * Safe plain text for showing untrusted metadata (token names, descriptions) in the UI.
   * 1. Line and field separators become spaces (or LF when multiline), so words stay apart.
   * 2. Every character findUnsafeChars would flag is removed.
   * 3. The text is normalized.
   * 4. It is truncated to maxLength code points, counting the '…', so a surrogate pair is never split.
   */
  function sanitizeForDisplay(input, opts) {
    const maxLength = opts && opts.maxLength !== undefined ? opts.maxLength : 160;
    const multiline = !!(opts && opts.multiline);
    if (!Number.isSafeInteger(maxLength) || maxLength < 1) throw new RangeError('sanitizeForDisplay: maxLength must be a positive integer');
    let s = typeof input === 'string' ? input : ['number', 'bigint', 'boolean'].includes(typeof input) ? String(input) : '';
    s = s.replace(/\r\n?/g, '\n').replace(/[\t\v\f]/g, ' ').replace(/[\u0085\u2028\u2029]/g, multiline ? '\n' : ' ');
    if (!multiline) s = s.replace(/\n/g, ' ');
    s = stripUnsafe(normalizeText(stripUnsafe(s, multiline), { multiline }), multiline);
    const chars = Array.from(s);
    return chars.length > maxLength ? chars.slice(0, maxLength - 1).join('').trimEnd() + '…' : s;
  }

  // Look-alikes → Latin, for impersonation warnings only. The list is not exhaustive and not a security boundary.
  // Capitals are mapped before lowercasing, because Greek Ν looks like N while lowercase ν looks like v.
  const HOMOGLYPHS = (() => {
    const map = Object.create(null);
    const add = (chars, latin) => { for (const ch of chars) map[ch] = latin; };
    // Cyrillic
    add('аА', 'a'); add('вВ', 'b'); add('ьЬ', 'b'); add('еЕ', 'e'); add('кК', 'k'); add('мМ', 'm'); add('нН', 'h');
    add('оО', 'o'); add('рР', 'p'); add('сС', 'c'); add('тТ', 't'); add('уУ', 'y'); add('хХ', 'x'); add('іІ', 'i');
    add('јЈ', 'j'); add('ѕЅ', 's'); add('ԁԀ', 'd'); add('ԛԚ', 'q'); add('ԝԜ', 'w'); add('үҮ', 'y'); add('һҺ', 'h'); add('ӏӀ', 'l');
    // Greek
    add('αΑ', 'a'); add('βΒ', 'b'); add('εΕ', 'e'); add('Η', 'h'); add('η', 'n'); add('ιΙ', 'i'); add('κΚ', 'k'); add('Μ', 'm');
    add('μ', 'u'); add('Ν', 'n'); add('ν', 'v'); add('οΟ', 'o'); add('ρΡ', 'p'); add('τΤ', 't'); add('Υ', 'y'); add('υ', 'u');
    add('χΧ', 'x'); add('Ζ', 'z');
    // Armenian, and Latin letters that survive NFKC
    add('օ', 'o'); add('ս', 'u'); add('հ', 'h'); add('ո', 'n');
    add('ı', 'i'); add('ȷ', 'j'); add('ɑ', 'a'); add('ɡ', 'g'); add('ɩ', 'i'); add('ǀ', 'l'); add('ſ', 's'); add('ß', 'ss'); add('ẞ', 'ss');
    // Digits that read as letters
    add('0', 'o'); add('1', 'l'); add('3', 'e'); add('5', 's'); add('8', 'b');
    return map;
  })();

  /**
   * Skeleton for impersonation checks. Applies NFKC, maps look-alikes to Latin, lowercases, then drops everything that
   * is not a–z (spaces, punctuation, '$', invisible characters, remaining digits).
   * Example: confusableSkeleton('$ЅYNC') === confusableSkeleton('sync') === 'sync'.
   */
  function confusableSkeleton(str) {
    if (typeof str !== 'string') return '';
    let out = '';
    for (const ch of str.normalize('NFKC')) {
      for (const c of HOMOGLYPHS[ch] !== undefined ? HOMOGLYPHS[ch] : ch.toLowerCase()) {
        for (const m of HOMOGLYPHS[c] !== undefined ? HOMOGLYPHS[c] : c) if (m >= 'a' && m <= 'z') out += m;
      }
    }
    return out;
  }

  // ── Exports (deep-frozen) ───────────────────────────────────────────────────────────────────────────────
  const _internal = Object.freeze({
    secp256k1: Object.freeze({ n: N, p: P, Gx: GX, Gy: GY, mulG, sign, privateKeyToAddress }),
    sha256: (data) => bytesToHex(sha256Bytes(bytesArg(data, 'sha256'))),
    hmacSha256: (key, data) => bytesToHex(hmacSha256Bytes(bytesArg(key, 'hmacSha256 key'), bytesArg(data, 'hmacSha256 data'))),
    encodeType: (primaryType, types) => { validateEipTypes(types); return encodeType(primaryType, types); },
  });

  return Object.freeze({
    utf8Bytes, utf8Length, hexToBytes, bytesToHex, concatBytes, // bytes and hex
    keccak256, keccak256Utf8, functionSelector, // hashing
    isAddress, toChecksumAddress, sameAddress, // addresses
    abiEncode, abiDecode, // ABI
    LAUNCH_SELECTORS, LAUNCH_SIGNATURES, decodeLaunchCalldata, // PAR launch calldata
    hashTypedData, hashStruct, hashDomain, hashPersonalMessage, // EIP-712 and personal_sign
    recoverPublicKey, recoverAddress, publicKeyToAddress, recoverTypedDataAddress, recoverPersonalSignAddress, // recovery
    PROVENANCE_DOMAIN, recordHashOf, intentSalt, launchIntentTypedData, launchIntentPlainMessage, sameTypedIntent, // provenance
    PAR_BYTE_LIMITS, normalizeText, findUnsafeChars, validateMetadataField, sanitizeForDisplay, confusableSkeleton, // text policy
    _internal,
  });
});
