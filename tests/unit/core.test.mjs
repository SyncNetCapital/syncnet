// Unit tests for lib/syncnet-core.js.
// Run:  node tests/unit/core.test.mjs          (SEED=<n> replays the randomized parts)
//
// Prints every check, writes tests/unit/core.results.json, and exits 1 on any failure.
// Independent oracles:
//   - /home/claude/audit/tools/keccak.py (pure-Python Keccak, override with KECCAK_PY_DIR)
//   - node:crypto: SHA-256, HMAC, ECDH scalar multiplication, ECDSA verification
//   - vendor/viem.js: ABI encoder/decoder, keccak256
//   - published vectors: Keccak, EIP-55, EIP-712 (spec example and eth-sig-util v4 arrays), web3.js personal_sign
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const LIB = path.join(ROOT, 'lib/syncnet-core.js');
const KECCAK_PY_DIR = process.env.KECCAK_PY_DIR || '/home/claude/audit/tools';
const require = createRequire(import.meta.url);
const C = require('../../lib/syncnet-core.js');
const S = C._internal.secp256k1;
const viem = await import(pathToFileURL(path.join(ROOT, 'vendor/viem.js')).href);
const FIXTURES = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/launch-fixture.json'), 'utf8'));

// ─── harness ──────────────────────────────────────────────────────────────────
const checks = [];
const timings = {};
let current = '';
const show = (v) => {
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x + 'n' : x));
  return s === undefined ? String(v) : s.length > 300 ? s.slice(0, 297) + '...' : s;
};
function check(name, ok, detail) {
  const entry = { section: current, name, ok: !!ok };
  if (!ok && detail !== undefined) entry.detail = String(detail).slice(0, 600);
  checks.push(entry);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? '  -- ' + entry.detail : ''}`);
}
function deepEqual(a, b) {
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}
const eq = (name, actual, expected) => check(name, deepEqual(actual, expected), `got ${show(actual)}, expected ${show(expected)}`);
function throws(name, fn, pattern) {
  let result;
  try {
    result = fn();
  } catch (e) {
    return check(name, !pattern || pattern.test(String(e && e.message)), 'threw a different error: ' + (e && e.message));
  }
  check(name, false, 'did not throw; returned ' + show(result));
}
function section(name, fn) {
  current = name;
  console.log(`\n== ${name} ==`);
  try {
    fn();
  } catch (e) {
    check(`${name}: section ran without an unexpected exception`, false, e && e.stack);
  }
}
const time = (fn) => { const t = performance.now(); const r = fn(); return [r, performance.now() - t]; };

// Seeded PRNG (mulberry32), so a failing randomized run can be replayed with SEED=…
const SEED = Number(process.env.SEED || Math.floor(Math.random() * 2 ** 31));
let prngState = SEED >>> 0;
const rnd = () => {
  prngState = (prngState + 0x6d2b79f5) | 0;
  let t = Math.imul(prngState ^ (prngState >>> 15), 1 | prngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const randInt = (n) => Math.floor(rnd() * n);
const randBytes = (n) => Uint8Array.from({ length: n }, () => randInt(256));
const hex = (b) => Buffer.from(b).toString('hex');
const randBig = (bits) => BigInt('0x0' + hex(randBytes(Math.ceil(bits / 8)))) & ((1n << BigInt(bits)) - 1n);
console.log(`syncnet-core unit tests (seed ${SEED})`);

// ─── published vectors and shared constants ───────────────────────────────────
const KECCAK_EMPTY = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
const KECCAK_ABC = '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45';
const KECCAK_FOX = '0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15';
const WEB3_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const WEB3_ADDR = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const WEB3_HASH = '0x1da44b586eb0729ff70a73c326926f6ed5a25f5b056e7f47fbc6e58d86871655';
const WEB3_SIG = '0xb91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c';
const SIG_LAUNCH = 'launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bytes32,bytes32),uint256,address[])';
const SIG_ROUTER = 'launchAndBuyWithEth((string,string,string,string,(string,string,string,string,string),address,uint16,bytes32,bytes32),uint256,address[],(uint8,((address,address,uint24,int24,address),bool)[],uint256)[],uint256)';
const TOKEN_PARAMS = '(string,string,string,string,(string,string,string,string,string),address,uint16,bytes32,bytes32)';
const LEGS = '(uint8,((address,address,uint24,int24,address),bool)[],uint256)[]';
const LAUNCH_FEE = 500000000000000n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const pad64 = (x) => x.toString(16).padStart(64, '0');
const sigHex = (r, s, v) => '0x' + pad64(r) + pad64(s) + v.toString(16).padStart(2, '0');
const splitSig = (sig) => ({ r: BigInt('0x' + sig.slice(2, 66)), s: BigInt('0x' + sig.slice(66, 130)), v: parseInt(sig.slice(130), 16) });

// ═════════════════════════════════════════════════════════════════════════════
section('module shape and environments', () => {
  const API = ['utf8Bytes', 'utf8Length', 'hexToBytes', 'bytesToHex', 'concatBytes', 'keccak256', 'keccak256Utf8', 'functionSelector',
    'isAddress', 'toChecksumAddress', 'sameAddress', 'abiEncode', 'abiDecode', 'decodeLaunchCalldata', 'LAUNCH_SELECTORS', 'hashTypedData',
    'hashStruct', 'hashDomain', 'hashPersonalMessage', 'recoverPublicKey', 'recoverAddress', 'publicKeyToAddress', 'recoverTypedDataAddress',
    'recoverPersonalSignAddress', 'PROVENANCE_DOMAIN', 'recordHashOf', 'intentSalt', 'launchIntentTypedData', 'launchIntentPlainMessage',
    'sameTypedIntent', 'PAR_BYTE_LIMITS', 'normalizeText', 'findUnsafeChars', 'validateMetadataField', 'sanitizeForDisplay',
    'confusableSkeleton', '_internal'];
  const missing = API.filter((k) => !(k in C));
  check('every documented export exists', missing.length === 0, 'missing: ' + missing.join(', '));
  check('exported object is frozen', Object.isFrozen(C));
  check('nested export objects are frozen', [C.LAUNCH_SELECTORS, C.LAUNCH_SIGNATURES, C.PAR_BYTE_LIMITS, C._internal, S].every(Object.isFrozen));
  throws('exports cannot be reassigned', () => { C.keccak256 = null; }, /read only|Cannot assign/);
  check('_internal.secp256k1 exposes n, p, Gx, Gy, mulG, sign, privateKeyToAddress',
    S.n === N && S.p === P && typeof S.Gx === 'bigint' && typeof S.Gy === 'bigint' && ['mulG', 'sign', 'privateKeyToAddress'].every((k) => typeof S[k] === 'function'));

  const out = execFileSync(process.execPath, ['-e', 'const c = require(process.argv[1]); process.stdout.write(c.keccak256Utf8("abc") + " " + typeof globalThis.SyncNetCore)', LIB], { encoding: 'utf8' });
  eq('CommonJS require() in a fresh Node process works and creates no global', out, KECCAK_ABC + ' undefined');

  // Browser: run the file as a classic script in a bare realm that only has TextEncoder/TextDecoder.
  const src = fs.readFileSync(LIB, 'utf8');
  const sandbox = { TextEncoder, TextDecoder };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'syncnet-core.js' });
  const W = sandbox.SyncNetCore;
  check('browser: classic script defines window.SyncNetCore', !!W && typeof W.keccak256 === 'function');
  check('browser: window.SyncNetCore is frozen', !!W && Object.isFrozen(W));
  eq('browser: keccak works in the bare realm', W && W.keccak256Utf8('abc'), KECCAK_ABC);
  eq('browser: signature recovery works across realms', W && W.recoverPersonalSignAddress('Some data', WEB3_SIG), WEB3_ADDR.toLowerCase());
  check('browser: nothing but SyncNetCore was added to the global', Object.keys(sandbox).sort().join() === 'SyncNetCore,TextDecoder,TextEncoder,window');
  const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/\s.*$/, '')).join('\n');
  const nodeApis = code.match(/\brequire\s*\(|\bprocess\b|\bBuffer\b|\bimport\s*\(|\bglobalThis\.crypto\b|node:/g);
  check('source code uses no Node APIs (require, process, Buffer, node: imports)', !nodeApis, nodeApis && nodeApis.join(', '));
});

// ═════════════════════════════════════════════════════════════════════════════
section('bytes and hex', () => {
  eq('hexToBytes accepts a 0x prefix', Array.from(C.hexToBytes('0x00ff10')), [0, 255, 16]);
  eq('hexToBytes accepts no prefix and mixed case', Array.from(C.hexToBytes('ABcd')), [0xab, 0xcd]);
  eq('hexToBytes("0x") is empty', C.hexToBytes('0x').length, 0);
  throws('hexToBytes rejects odd length', () => C.hexToBytes('0x123'), /odd/);
  throws('hexToBytes rejects invalid characters', () => C.hexToBytes('0xzz'), /invalid/);
  throws('hexToBytes rejects a doubled prefix', () => C.hexToBytes('0x0x12'), /invalid/);
  throws('hexToBytes rejects whitespace', () => C.hexToBytes('0x12 34'), /invalid|odd/);
  throws('hexToBytes rejects non-strings', () => C.hexToBytes(1234), /expected/);
  eq('bytesToHex is lowercase and prefixed', C.bytesToHex(Uint8Array.of(0xab, 0x01, 0xff)), '0xab01ff');
  eq('bytesToHex(empty) is 0x', C.bytesToHex(new Uint8Array(0)), '0x');
  throws('bytesToHex rejects plain arrays', () => C.bytesToHex([1, 2]), /Uint8Array/);
  eq('concatBytes joins in order', Array.from(C.concatBytes(Uint8Array.of(1), new Uint8Array(0), Uint8Array.of(2, 3))), [1, 2, 3]);
  throws('concatBytes rejects non-bytes', () => C.concatBytes(Uint8Array.of(1), '0x02'), /Uint8Array/);
  eq('utf8Bytes encodes multi-byte characters', hex(C.utf8Bytes('é界😀')), 'c3a9e7958cf09f9880');
  const pool = ['a', 'é', '界', '😀', '\ud800', '\udfff', '\u0000', '\uffff', '𝕊'];
  let bad = 0;
  for (let i = 0; i < 500; i++) {
    const s = Array.from({ length: randInt(12) }, () => pool[randInt(pool.length)]).join('');
    if (C.utf8Length(s) !== C.utf8Bytes(s).length || C.utf8Length(s) !== Buffer.byteLength(s, 'utf8')) bad++;
  }
  check('utf8Length equals utf8Bytes().length and Buffer.byteLength for 500 random strings (incl. lone surrogates)', bad === 0, bad + ' mismatches');
});

// ═════════════════════════════════════════════════════════════════════════════
section('keccak256', () => {
  eq('keccak256("") published vector', C.keccak256(new Uint8Array(0)), KECCAK_EMPTY);
  eq('keccak256("0x") equals keccak256 of empty bytes', C.keccak256('0x'), KECCAK_EMPTY);
  eq('keccak256("abc") published vector', C.keccak256Utf8('abc'), KECCAK_ABC);
  eq('keccak256(quick brown fox) published vector', C.keccak256Utf8('The quick brown fox jumps over the lazy dog'), KECCAK_FOX);
  eq('functionSelector(transfer(address,uint256)) = 0xa9059cbb', C.functionSelector('transfer(address,uint256)'), '0xa9059cbb');
  eq('hex input and byte input give the same hash', C.keccak256('0x616263'), KECCAK_ABC);
  throws('keccak256 refuses text that is not 0x-hex (no guessing)', () => C.keccak256('abcd'), /keccak256Utf8/);
  throws('keccak256 rejects invalid hex', () => C.keccak256('0xabc'), /odd/);
  throws('functionSelector rejects spaces', () => C.functionSelector('transfer(address, uint256)'));
  throws('functionSelector rejects the uint alias', () => C.functionSelector('transfer(address,uint)'), /canonical|unsupported/);
  eq('functionSelector accepts empty parameter lists', C.functionSelector('totalSupply()'), '0x18160ddd');

  // 300 random inputs of lengths 0..600, with every rate boundary (135/136/137, …) forced in.
  const forced = [0, 1, 31, 32, 33, 55, 56, 64, 135, 136, 137, 271, 272, 273, 407, 408, 409, 543, 544, 545, 600];
  const inputs = Array.from({ length: 300 }, (_, i) => randBytes(i < forced.length ? forced[i] : randInt(601)));
  const extra = [C.utf8Bytes(SIG_LAUNCH), C.utf8Bytes(SIG_ROUTER)];
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(KECCAK_PY_DIR)})`,
    'from keccak import keccak256',
    "sys.stdout.write('\\n'.join(keccak256(bytes.fromhex(t[1:])).hex() for t in sys.stdin.read().split()))",
  ].join('\n');
  const [pyOut, pyMs] = time(() => execFileSync('python3', ['-c', script], {
    input: inputs.concat(extra).map((b) => 'x' + hex(b)).join('\n'), encoding: 'utf8', maxBuffer: 1 << 26,
  }).trim().split('\n'));
  timings.pythonKeccakBatchMs = Math.round(pyMs);
  const mismatches = inputs.filter((b, i) => C.keccak256(b) !== '0x' + pyOut[i]).map((b) => b.length);
  check('300 random inputs (lengths 0..600) match the independent Python keccak.py', pyOut.length === 302 && mismatches.length === 0,
    `lengths that differ: ${mismatches.join(',')} (python returned ${pyOut.length} lines)`);
  eq('Python keccak.py agrees with LAUNCH_SELECTORS.launchToken', '0x' + pyOut[300].slice(0, 8), C.LAUNCH_SELECTORS.launchToken);
  eq('Python keccak.py agrees with LAUNCH_SELECTORS.launchAndBuyWithEth', '0x' + pyOut[301].slice(0, 8), C.LAUNCH_SELECTORS.launchAndBuyWithEth);
  const viemMismatch = inputs.filter((b) => C.keccak256(b) !== viem.keccak256(b)).length;
  check('the same 300 inputs match viem.keccak256', viemMismatch === 0, viemMismatch + ' mismatches');

  const big = randBytes(1 << 20);
  const [, ms] = time(() => C.keccak256(big));
  timings.keccakMiBPerSec = +(1000 / ms).toFixed(1);
  const [, ms32] = time(() => { for (let i = 0; i < 2000; i++) C.keccak256(inputs[4]); });
  timings.keccak32BytesUs = +((ms32 * 1000) / 2000).toFixed(1);
  check(`keccak256 hashes 1 MiB in ${ms.toFixed(0)} ms`, ms < 2000);
});

// ═════════════════════════════════════════════════════════════════════════════
section('sha256 / hmac-sha256 (internal, used by RFC 6979)', () => {
  let bad = 0;
  for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, ...Array.from({ length: 60 }, () => randInt(300))]) {
    const b = randBytes(n), k = randBytes(randInt(3) === 0 ? 100 : randInt(65));
    if (C._internal.sha256(b) !== '0x' + crypto.createHash('sha256').update(b).digest('hex')) bad++;
    if (C._internal.hmacSha256(k, b) !== '0x' + crypto.createHmac('sha256', k).update(b).digest('hex')) bad++;
  }
  check('sha256 and hmacSha256 match node:crypto on 72 random lengths (incl. padding boundaries and keys > 64 bytes)', bad === 0, bad + ' mismatches');
});

// ═════════════════════════════════════════════════════════════════════════════
section('addresses (EIP-55)', () => {
  for (const v of ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb']) {
    eq(`EIP-55 vector ${v}`, C.toChecksumAddress(v.toLowerCase()), v);
    eq(`EIP-55 vector ${v} from upper case`, C.toChecksumAddress('0x' + v.slice(2).toUpperCase()), v);
  }
  // viem's encoder validates mixed-case checksums, so it can serve as an independent EIP-55 oracle.
  let rejected = 0;
  for (let i = 0; i < 200; i++) {
    const a = C.toChecksumAddress('0x' + hex(randBytes(20)));
    try { viem.encodeAbiParameters([{ type: 'address' }], [a]); } catch { rejected++; }
  }
  check('viem accepts 200 random addresses checksummed by toChecksumAddress', rejected === 0, rejected + ' rejected');
  const good = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', broken = '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  throws('(oracle sanity) viem rejects a broken checksum', () => viem.encodeAbiParameters([{ type: 'address' }], [broken]));
  check('isAddress accepts any case', C.isAddress(good) && C.isAddress(good.toLowerCase()) && C.isAddress(broken));
  check('isAddress rejects bad input', ![good.slice(0, 41), good + '0', good.slice(2), '0x' + 'g'.repeat(40), 123, null, ' ' + good].some(C.isAddress));
  check('sameAddress is case-insensitive', C.sameAddress(good, good.toLowerCase()) && C.sameAddress(good.toUpperCase().replace('0X', '0x'), good));
  check('sameAddress is false for invalid input', !C.sameAddress('0x1', '0x1') && !C.sameAddress(good, null) && !C.sameAddress(undefined, undefined));
  throws('toChecksumAddress rejects non-addresses', () => C.toChecksumAddress('0x1234'), /not an address/);
});

// ═════════════════════════════════════════════════════════════════════════════
// ABI helpers: a small type walker and the conversion of type strings into viem's parameter objects.
function splitTopLevel(s) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}
function viemParam(t) {
  const m = /^(\(.*\))((?:\[\d*\])*)$/.exec(t);
  return m ? { type: 'tuple' + m[2], components: splitTopLevel(m[1].slice(1, -1)).map(viemParam) } : { type: t };
}
const viemEncode = (types, values) => viem.encodeAbiParameters(types.map(viemParam), values);
function viemDecode(types, data) {
  const abi = [{ type: 'function', name: 'f', stateMutability: 'view', inputs: [], outputs: types.map(viemParam) }];
  const out = viem.decodeFunctionResult({ abi, functionName: 'f', data });
  return types.length === 1 ? [out] : out;
}
/**
 * What abiDecode must return for an encoded value: lowercase addresses and hex, BigInt integers.
 * viemBom=true models one viem quirk: its TextDecoder drops a leading U+FEFF from decoded strings.
 */
function expected(t, v, viemBom = false) {
  const arr = /^(.*)\[(\d*)\]$/.exec(t);
  if (arr) return v.map((x) => expected(arr[1], x, viemBom));
  if (t.startsWith('(')) return splitTopLevel(t.slice(1, -1)).map((c, i) => expected(c, v[i], viemBom));
  if (t === 'address' || t.startsWith('bytes')) return typeof v === 'string' ? v.toLowerCase() : '0x' + hex(v);
  if (/^u?int/.test(t)) return BigInt(v);
  if (t === 'string' && viemBom && v.startsWith('\ufeff')) return v.slice(1);
  return v;
}
const STRING_POOL = ['a', 'Z', ' ', 'é', '界', '😀', '\u0000', '\n', '"', '\\', 'ü', '\ufeff', '👩\u200d💻'];
function randValue(t) {
  const arr = /^(.*)\[(\d*)\]$/.exec(t);
  if (arr) return Array.from({ length: arr[2] === '' ? randInt(4) : Number(arr[2]) }, () => randValue(arr[1]));
  if (t.startsWith('(')) return splitTopLevel(t.slice(1, -1)).map(randValue);
  if (t === 'address') { const a = '0x' + hex(randBytes(20)); return randInt(2) ? C.toChecksumAddress(a) : a; }
  if (t === 'bool') return randInt(2) === 1;
  if (t === 'string') return Array.from({ length: randInt(40) }, () => STRING_POOL[randInt(STRING_POOL.length)]).join('');
  if (t === 'bytes') return '0x' + hex(randBytes([0, 1, 31, 32, 33, 64, randInt(100)][randInt(7)]));
  let m = /^bytes(\d+)$/.exec(t);
  if (m) return '0x' + hex(randBytes(Number(m[1])));
  m = /^(u?)int(\d+)$/.exec(t);
  const bits = Number(m[2]), edge = randInt(4);
  if (m[1] === 'u') return [0n, (1n << BigInt(bits)) - 1n, randBig(bits), randBig(bits)][edge];
  const half = 1n << BigInt(bits - 1);
  return [-half, half - 1n, randBig(bits) - half, 0n][edge];
}
function randType(depth = 0) {
  switch (randInt(depth >= 3 ? 7 : 10)) {
    case 0: return 'address';
    case 1: return 'bool';
    case 2: return 'uint' + 8 * (1 + randInt(32));
    case 3: return 'int' + 8 * (1 + randInt(32));
    case 4: return 'bytes' + (1 + randInt(32));
    case 5: return 'bytes';
    case 6: return 'string';
    case 7: return '(' + Array.from({ length: 1 + randInt(3) }, () => randType(depth + 1)).join(',') + ')';
    case 8: return randType(depth + 1) + '[]';
    default: return randType(depth + 1) + '[' + (1 + randInt(3)) + ']';
  }
}
const word = (x) => pad64(x < 0n ? x + (1n << 256n) : x);

section('ABI encode/decode', () => {
  const A1 = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', A2 = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359';
  const cases = [
    ['address', [A1]],
    ['bool', [true, false]],
    ['uint8/16/24/256', [255n, 65535n, 16777215n, (1n << 256n) - 1n], ['uint8', 'uint16', 'uint24', 'uint256']],
    ['int8/24/256 extremes', [-128n, 127n, -8388608n, -(1n << 255n), (1n << 255n) - 1n, -1n], ['int8', 'int8', 'int24', 'int256', 'int256', 'int256']],
    ['bytes1/4/32', ['0xab', '0xDEADBEEF', '0x' + 'cd'.repeat(32)], ['bytes1', 'bytes4', 'bytes32']],
    ['bytes (0, 1, 32, 33 bytes)', ['0x', '0x01', '0x' + 'ee'.repeat(32), '0x' + 'ff'.repeat(33)], ['bytes', 'bytes', 'bytes', 'bytes']],
    ['string (empty, unicode, 64 bytes)', ['', 'Fixture ✓ ünï 😀', 'x'.repeat(64)], ['string', 'string', 'string']],
    ['nested tuple', [[1n, [A1, 'hi', [true, '0x1234']], '0x']], ['(uint256,(address,string,(bool,bytes)),bytes)']],
    ['dynamic arrays', [[], ['a', 'bb', ''], [[1n, '0x01'], [2n, '0x']]], ['uint256[]', 'string[]', '(uint8,bytes)[]']],
    ['fixed arrays', [[1n, 2n, 3n], ['x', 'yy'], [[true, 'a'], [false, 'b']], [[1n, 2n], [3n, 4n], [5n, 6n]], [['a'], []]],
      ['uint16[3]', 'string[2]', '(bool,string)[2]', 'uint8[2][3]', 'string[][2]']],
    ['nested dynamic arrays', [[[1n], [], [2n, 3n]], [[['a']], []]], ['uint256[][]', 'string[][][]']],
    ['PAR buy legs (arrays of tuples of arrays of tuples)', [[[0n, [[[A2, A1, 3000n, -60n, A2], true]], 5n], [1n, [], 0n]]], [LEGS]],
  ];
  for (const [label, values, typesOverride] of cases) {
    const types = typesOverride || values.map(() => label);
    const enc = C.abiEncode(types, values);
    const dec = C.abiDecode(types, enc);
    check(`round trip + viem byte-equality: ${label}`,
      enc === viemEncode(types, values).toLowerCase() && deepEqual(dec, types.map((t, i) => expected(t, values[i]))),
      `enc ${enc.slice(0, 80)}… dec ${show(dec)}`);
  }
  eq('abiDecode accepts Uint8Array input', C.abiDecode(['uint8'], C.hexToBytes(C.abiEncode(['uint8'], [7]))), [7n]);
  eq('empty type list', [C.abiEncode([], []), C.abiDecode([], '0x')], ['0x', []]);
  eq('integers may be safe numbers or numeric strings', C.abiEncode(['uint256', 'int8', 'uint256'], [5, '-3', '0x10']), '0x' + word(5n) + word(-3n) + word(16n));
  eq('a leading U+FEFF in a string survives decoding', C.abiDecode(['string'], C.abiEncode(['string'], ['\ufeffx'])), ['\ufeffx']);
  // Known oracle difference: viem decodes the same bytes (EF BB BF 78) to "x"; the BOM is data, so we keep it.
  eq('(oracle note) viem drops that leading U+FEFF; syncnet-core keeps the bytes as data', viemDecode(['string'], C.abiEncode(['string'], ['\ufeffx'])), ['x']);

  // Randomized differential test against viem, both directions.
  let failures = [];
  for (let i = 0; i < 300 && failures.length < 3; i++) {
    const types = Array.from({ length: 1 + randInt(4) }, () => randType());
    const values = types.map(randValue);
    try {
      const mine = C.abiEncode(types, values), theirs = viemEncode(types, values).toLowerCase();
      const want = types.map((t, j) => expected(t, values[j]));
      const viemWant = types.map((t, j) => expected(t, values[j], true));
      if (mine !== theirs) failures.push(`encode ${types.join(',')}`);
      else if (!deepEqual(C.abiDecode(types, mine), want)) failures.push(`decode ${types.join(',')}`);
      else if (!deepEqual(types.map((t, j) => expected(t, viemDecode(types, mine)[j])), viemWant)) failures.push(`viem-decode ${types.join(',')}`);
    } catch (e) {
      failures.push(`${types.join(',')}: ${e.message.split('\n')[0]}`);
    }
  }
  check('300 random type lists: abiEncode === viem.encodeAbiParameters and both decoders agree', failures.length === 0, failures.join(' | '));

  // Encoder input validation
  throws('encode: uint8 256 is out of range', () => C.abiEncode(['uint8'], [256n]), /range/);
  throws('encode: negative uint', () => C.abiEncode(['uint256'], [-1n]), /range/);
  throws('encode: int8 -129 is out of range', () => C.abiEncode(['int8'], [-129n]), /range/);
  throws('encode: unsafe JS number', () => C.abiEncode(['uint256'], [2 ** 60]), /safe integer/);
  throws('encode: fractional number', () => C.abiEncode(['uint256'], [1.5]), /safe integer/);
  throws('encode: invalid address', () => C.abiEncode(['address'], ['0x1234']), /address/);
  throws('encode: bytes32 with the wrong length', () => C.abiEncode(['bytes32'], ['0x1234']), /32 bytes/);
  throws('encode: bool given as a string', () => C.abiEncode(['bool'], ['true']), /true or false/);
  throws('encode: fixed array with the wrong length', () => C.abiEncode(['uint8[2]'], [[1n]]), /2 elements/);
  throws('encode: tuple with the wrong arity', () => C.abiEncode(['(uint8,bool)'], [[1n]]), /2 values/);
  throws('encode: string given a number', () => C.abiEncode(['string'], [5]), /string/);
  throws('encode: value count mismatch', () => C.abiEncode(['uint8', 'uint8'], [1n]), /expected 2 values/);
  const badTypes = ['uint', 'int', 'uint7', 'uint264', 'uint08', 'bytes0', 'bytes33', 'byte', 'function', 'fixed128x18', 'Uint256',
    'uint256 ', 'tuple', '()', '(uint256', '(uint256,)', 'uint256[0]', 'uint256[01]', 'string[', 'address[]]', '(a)'];
  const accepted = badTypes.filter((t) => { try { C.abiEncode([t], [0n]); return true; } catch { return false; } });
  check(`encode: ${badTypes.length} non-canonical or malformed type strings are rejected`, accepted.length === 0, 'accepted: ' + accepted.join(' '));

  // Decoder bounds checks and strictness
  const base = C.abiEncode(['uint256', 'string', 'uint8[]'], [42n, 'hello', [1n, 2n, 3n]]);
  const baseBytes = C.hexToBytes(base), want = [42n, 'hello', [1n, 2n, 3n]];
  let wrong = 0, threw = 0;
  for (let len = 0; len < baseBytes.length; len++) {
    try { if (!deepEqual(C.abiDecode(['uint256', 'string', 'uint8[]'], baseBytes.subarray(0, len)), want)) wrong++; } catch { threw++; }
  }
  check(`truncation at each of ${baseBytes.length} lengths either throws or decodes the original values (never garbage)`, wrong === 0, wrong + ' garbage results');
  check('truncation that removes needed bytes throws', threw >= baseBytes.length - 32, `${threw} of ${baseBytes.length} truncations threw`);
  const patch = (hexData, wordIndex, value) => hexData.slice(0, 2 + 64 * wordIndex) + pad64(value) + hexData.slice(2 + 64 * (wordIndex + 1));
  throws('decode: offset pointing past the end', () => C.abiDecode(['uint256', 'string', 'uint8[]'], patch(base, 1, BigInt(baseBytes.length))), /outside/);
  throws('decode: offset of 2^255', () => C.abiDecode(['uint256', 'string', 'uint8[]'], patch(base, 1, 1n << 255n)), /outside/);
  throws('decode: string length larger than the data', () => C.abiDecode(['uint256', 'string', 'uint8[]'], patch(base, 3, 1000n)), /exceeds/);
  throws('decode: string length 2^255', () => C.abiDecode(['uint256', 'string', 'uint8[]'], patch(base, 3, 1n << 255n)), /exceeds/);
  const [, hugeMs] = time(() => throws('decode: array length 2^64 is rejected without allocating', () => C.abiDecode(['uint256', 'string', 'uint8[]'], patch(base, 5, 1n << 64n)), /cannot fit/));
  check('decode: the huge-length rejection is immediate', hugeMs < 50, hugeMs.toFixed(1) + ' ms');
  throws('decode: empty data', () => C.abiDecode(['uint256'], '0x'), /too short/);
  throws('decode: odd-length hex', () => C.abiDecode(['uint256'], '0x' + '0'.repeat(63)), /odd/);
  throws('decode: address with dirty high bytes', () => C.abiDecode(['address'], '0x01' + '00'.repeat(11) + 'aa'.repeat(20)), /high bytes/);
  throws('decode: bool = 2', () => C.abiDecode(['bool'], '0x' + word(2n)), /bool/);
  throws('decode: uint8 = 256', () => C.abiDecode(['uint8'], '0x' + word(256n)), /range/);
  eq('decode: uint8 = 255', C.abiDecode(['uint8'], '0x' + word(255n)), [255n]);
  throws('decode: int8 = +128 (not sign-extended)', () => C.abiDecode(['int8'], '0x' + word(128n)), /sign-extended/);
  throws('decode: int8 = -129', () => C.abiDecode(['int8'], '0x' + word(-129n)), /sign-extended/);
  eq('decode: int8 = -128 and int256 = -1', C.abiDecode(['int8', 'int256'], '0x' + word(-128n) + word(-1n)), [-128n, -1n]);
  throws('decode: bytes4 with dirty padding', () => C.abiDecode(['bytes4'], '0xdeadbeef' + '00'.repeat(27) + '01'), /padding/);
  const strData = (h) => '0x' + word(32n) + word(BigInt(h.length / 2)) + h.padEnd(64, '0');
  throws('decode: string with invalid UTF-8 (0xff)', () => C.abiDecode(['string'], strData('61ff62')), /UTF-8/);
  throws('decode: string with an overlong encoding (C0 80)', () => C.abiDecode(['string'], strData('c080')), /UTF-8/);
  throws('decode: string with an encoded surrogate (ED A0 80)', () => C.abiDecode(['string'], strData('eda080')), /UTF-8/);
  throws('decode: string cut inside a multi-byte character', () => C.abiDecode(['string'], strData('e7958c'.slice(0, 4))), /UTF-8/);
  // Aliasing: M outer offsets all point at one inner array of M words, so a small input would decode to M² values.
  const M = 2000;
  const alias = '0x' + word(32n) + word(BigInt(M)) + word(BigInt(M * 32)).repeat(M) + word(BigInt(M)) + Array.from({ length: M }, (_, i) => word(BigInt(i))).join('');
  const [, aliasMs] = time(() => throws(`decode: ${M}×${M} aliased offsets are rejected (${(alias.length - 2) / 2} bytes input)`, () => C.abiDecode(['uint256[][]'], alias), /aliased/));
  check('decode: aliasing rejection is fast', aliasMs < 200, aliasMs.toFixed(1) + ' ms');
  const square = Array.from({ length: 60 }, (_, i) => Array.from({ length: 60 }, (_, j) => BigInt(i * j)));
  eq('decode: a canonical 60×60 uint256[][] is not mistaken for aliasing', C.abiDecode(['uint256[][]'], C.abiEncode(['uint256[][]'], [square])), [square]);
});

// ═════════════════════════════════════════════════════════════════════════════
section('PAR launch calldata', () => {
  eq('LAUNCH_SELECTORS.launchToken === functionSelector(signature)', C.LAUNCH_SELECTORS.launchToken, C.functionSelector(SIG_LAUNCH));
  eq('LAUNCH_SELECTORS.launchAndBuyWithEth === functionSelector(signature)', C.LAUNCH_SELECTORS.launchAndBuyWithEth, C.functionSelector(SIG_ROUTER));
  eq('LAUNCH_SELECTORS values', { ...C.LAUNCH_SELECTORS }, { launchToken: '0x5a4b7ef0', launchAndBuyWithEth: '0x5fe889a4' });
  eq('LAUNCH_SIGNATURES match the audited ABI', { ...C.LAUNCH_SIGNATURES }, { launchToken: SIG_LAUNCH, launchAndBuyWithEth: SIG_ROUTER });

  const tupleOf = (p) => [p.name, p.symbol, p.logo, p.description,
    [p.socials.twitter, p.socials.telegram, p.socials.discord, p.socials.website, p.socials.farcaster],
    p.creatorFeeRecipient, p.creatorTaxBps, p.expectedEconomics, p.salt];
  for (const fx of FIXTURES) {
    const [d, ms] = time(() => C.decodeLaunchCalldata(fx.data));
    timings[`decodeLaunchCalldata_${fx.path}_ms`] = +ms.toFixed(2);
    const p = d.params, e = fx.params;
    eq(`${fx.path}: fn`, d.fn, fx.path === 'direct' ? 'launchToken' : 'launchAndBuyWithEth');
    const sameParams = p.name === e.name && p.symbol === e.symbol && p.logo === e.logo && p.description === e.description &&
      deepEqual(p.socials, e.socials) && C.sameAddress(p.creatorFeeRecipient, e.creatorFeeRecipient) && p.creatorTaxBps === e.creatorTaxBps &&
      p.expectedEconomics === e.expectedEconomics.toLowerCase() && p.salt === e.salt.toLowerCase() && Object.keys(p).length === 9;
    check(`${fx.path}: params equal the fixture (text exact, addresses case-insensitive, numbers equal)`, sameParams, show(p));
    check(`${fx.path}: pairTokens equal the fixture`, d.pairTokens.length === fx.pairTokens.length && d.pairTokens.every((a, i) => C.sameAddress(a, fx.pairTokens[i])), show(d.pairTokens));
    check(`${fx.path}: launchConfigId is 0n and creatorTaxBps is a JS number`, d.launchConfigId === 0n && typeof p.creatorTaxBps === 'number');
    let args = [tupleOf(p), d.launchConfigId, d.pairTokens];
    let types = [TOKEN_PARAMS, 'uint256', 'address[]'];
    if (fx.path === 'router') {
      const sum = d.legs.reduce((s, l) => s + l.amountIn, 0n);
      check('router: exactly 2 legs', d.legs.length === 2, d.legs.length);
      eq('router: legs sum to value − launch fee (0.0005 ETH)', sum, BigInt(fx.value) - LAUNCH_FEE);
      check('router: markets 0 and 1, every hop has a PoolKey and a v3 flag',
        d.legs.map((l) => l.market).join() === '0,1' && d.legs.every((l) => l.hops.length > 0 && l.hops.every((h) => C.isAddress(h.key.currency0) &&
          C.isAddress(h.key.currency1) && C.isAddress(h.key.hooks) && typeof h.v3 === 'boolean')));
      check('router: market/fee/tickSpacing are numbers; amountIn/minTokensOut are BigInt',
        d.legs.every((l) => typeof l.market === 'number' && typeof l.amountIn === 'bigint' && l.hops.every((h) => typeof h.key.fee === 'number' && typeof h.key.tickSpacing === 'number')) &&
        typeof d.minTokensOut === 'bigint' && d.minTokensOut > 0n);
      const legs = d.legs.map((l) => [l.market, l.hops.map((h) => [[h.key.currency0, h.key.currency1, h.key.fee, h.key.tickSpacing, h.key.hooks], h.v3]), l.amountIn]);
      args = args.concat([legs, d.minTokensOut]);
      types = types.concat([LEGS, 'uint256']);
    } else {
      check('direct: no legs/minTokensOut on the direct path', !('legs' in d) && !('minTokensOut' in d));
    }
    const selector = fx.path === 'direct' ? C.LAUNCH_SELECTORS.launchToken : C.LAUNCH_SELECTORS.launchAndBuyWithEth;
    eq(`${fx.path}: selector + abiEncode(decoded args) reproduces data byte-for-byte`, selector + C.abiEncode(types, args).slice(2), fx.data.toLowerCase());
    eq(`${fx.path}: viem re-encodes the decoded args to the same bytes`, selector + viemEncode(types, args).slice(2), fx.data.toLowerCase());
    eq(`${fx.path}: the on-chain salt is the SyncNet commitment to the intent record`, p.salt, C.intentSalt(C.recordHashOf(fx.provenanceJson)));
  }
  throws('unknown selector', () => C.decodeLaunchCalldata('0xa9059cbb' + '00'.repeat(64)), /unknown selector 0xa9059cbb/);
  throws('calldata shorter than a selector', () => C.decodeLaunchCalldata('0x5a4b7e'), /shorter/);
  throws('truncated launch calldata', () => C.decodeLaunchCalldata(FIXTURES[0].data.slice(0, 600)), /abiDecode/);
  throws('non-hex calldata', () => C.decodeLaunchCalldata('0x5a4b7ef0zz'), /invalid/);
  throws('calldata that is not a string or bytes', () => C.decodeLaunchCalldata(42), /expected/);
});

// ═════════════════════════════════════════════════════════════════════════════
const MAIL = {
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    Person: [{ name: 'name', type: 'string' }, { name: 'wallet', type: 'address' }],
    Mail: [{ name: 'from', type: 'Person' }, { name: 'to', type: 'Person' }, { name: 'contents', type: 'string' }],
  },
  primaryType: 'Mail',
  domain: { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' },
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  },
};
const COW = '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826';

section('EIP-712', () => {
  const cowKey = C.keccak256Utf8('cow');
  eq('Mail: encodeType (EIP-712 spec)', C._internal.encodeType('Mail', MAIL.types), 'Mail(Person from,Person to,string contents)Person(string name,address wallet)');
  eq('Mail: typeHash (EIP-712 Example.js)', C.keccak256Utf8(C._internal.encodeType('Mail', MAIL.types)), '0xa0cedeb2dc280ba39b857546d74f5549c3a1d7bdc2dd96bf881f76108e23dac2');
  eq('Mail: domain separator (EIP-712 Example.js)', C.hashDomain(MAIL.domain, MAIL.types), '0xf2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f');
  eq('Mail: hashStruct(message) (EIP-712 Example.js)', C.hashStruct('Mail', MAIL.message, MAIL.types), '0xc52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e');
  const digest = C.hashTypedData(MAIL);
  eq('Mail: digest = 0xbe609aee…7bd2 (published)', digest, '0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2');
  eq('Mail: key keccak256("cow") is the Cow address', S.privateKeyToAddress(cowKey), COW.toLowerCase());
  const sig = splitSig(S.sign(digest, cowKey));
  eq('Mail: signature r (published)', pad64(sig.r), '4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d');
  eq('Mail: signature s (published)', pad64(sig.s), '07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b91562');
  eq('Mail: signature v = 28 (published)', sig.v, 28);
  eq('Mail: recoverTypedDataAddress returns the Cow address', C.recoverTypedDataAddress(MAIL, S.sign(digest, cowKey)), COW.toLowerCase());

  // eth-sig-util signTypedData_v4 vector with arrays of structs and arrays of addresses
  const V4 = {
    types: {
      EIP712Domain: MAIL.types.EIP712Domain,
      Person: [{ name: 'name', type: 'string' }, { name: 'wallets', type: 'address[]' }],
      Mail: [{ name: 'from', type: 'Person' }, { name: 'to', type: 'Person[]' }, { name: 'contents', type: 'string' }],
      Group: [{ name: 'name', type: 'string' }, { name: 'members', type: 'Person[]' }],
    },
    domain: MAIL.domain,
    primaryType: 'Mail',
    message: {
      from: { name: 'Cow', wallets: ['0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826', '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF'] },
      to: [{ name: 'Bob', wallets: ['0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB', '0xB0BdaBea57B0BDABeA57b0bdABEA57b0BDabEa57', '0xB0B0b0b0b0b0B000000000000000000000000000'] }],
      contents: 'Hello, Bob!',
    },
  };
  eq('v4 arrays: encodeType ignores the unreferenced Group', C._internal.encodeType('Mail', V4.types), 'Mail(Person from,Person[] to,string contents)Person(string name,address[] wallets)');
  eq('v4 arrays: typeHash (eth-sig-util)', C.keccak256Utf8(C._internal.encodeType('Mail', V4.types)), '0x4bd8a9a2b93427bb184aca81e24beb30ffa3c747e2a33d4225ec08bf12e2e753');
  eq('v4 arrays: hashStruct(Person from) (eth-sig-util)', C.hashStruct('Person', V4.message.from, V4.types), '0x9b4846dd48b866f0ac54d61b9b21a9e746f921cefa4ee94c4c0a1c49c774f67f');
  eq('v4 arrays: hashStruct(Mail) (eth-sig-util)', C.hashStruct('Mail', V4.message, V4.types), '0xeb4221181ff3f1a83ea7313993ca9218496e424604ba9492bb4052c03d5c3df8');
  eq('v4 arrays: digest (eth-sig-util)', C.hashTypedData(V4), '0xa85c2e2b118698e88db68a8105b794a8cc7cec074e89ef991cb4f5f533819cc2');
  eq('v4 arrays: signature with keccak256("cow") (eth-sig-util)', S.sign(C.hashTypedData(V4), cowKey),
    '0x65cbd956f2fae28a601bebc9b906cea0191744bd4c4247bcd27cd08f8eb6b71c78efdf7a31dc9abee78f492292721f362d296cf86b4538e07b51303b67f749061b');

  // Generic rules, checked against a hand-built encoding
  const T = {
    EIP712Domain: [{ name: 'name', type: 'string' }],
    Zed: [{ name: 'b', type: 'Beta' }, { name: 'a', type: 'Alpha[]' }],
    Beta: [{ name: 'a', type: 'Alpha' }],
    Alpha: [{ name: 'x', type: 'uint8' }],
  };
  eq('encodeType: primary first, then referenced structs in alphabetical order (incl. indirect ones)', C._internal.encodeType('Zed', T), 'Zed(Beta b,Alpha[] a)Alpha(uint8 x)Beta(Alpha a)');
  const OT = {
    EIP712Domain: [{ name: 'name', type: 'string' }],
    Item: [{ name: 'id', type: 'uint256' }, { name: 'tags', type: 'string[]' }],
    Order: [{ name: 'items', type: 'Item[]' }, { name: 'grid', type: 'uint8[2][]' }, { name: 'blob', type: 'bytes' }, { name: 'pair', type: 'address[2]' },
      { name: 'flag', type: 'bool' }, { name: 'b4', type: 'bytes4' }, { name: 'delta', type: 'int16' }],
  };
  const order = { items: [{ id: 7n, tags: ['a', 'é'] }, { id: 8, tags: [] }], grid: [[1, 2], [3, 4]], blob: '0xc0ffee', pair: [COW, MAIL.domain.verifyingContract], flag: true, b4: '0xdeadbeef', delta: -5 };
  const k = (hexStr) => C.keccak256(hexStr), kcat = (parts) => k('0x' + parts.map((p) => p.slice(2)).join(''));
  const itemType = k(C.bytesToHex(C.utf8Bytes('Item(uint256 id,string[] tags)')));
  const orderType = k(C.bytesToHex(C.utf8Bytes('Order(Item[] items,uint8[2][] grid,bytes blob,address[2] pair,bool flag,bytes4 b4,int16 delta)Item(uint256 id,string[] tags)')));
  const item = (it) => kcat([itemType, '0x' + word(BigInt(it.id)), kcat(it.tags.map((t) => C.keccak256Utf8(t)))]);
  const manual = kcat([orderType, kcat(order.items.map(item)), kcat(order.grid.map((row) => kcat(row.map((x) => '0x' + word(BigInt(x)))))),
    k(order.blob), kcat(order.pair.map((a) => '0x' + pad64(BigInt(a)))), '0x' + word(1n), '0xdeadbeef' + '00'.repeat(28), '0x' + word(-5n)]);
  eq('hashStruct: struct arrays, nested fixed/dynamic arrays, bytes, bool, bytes4, negative int16 match a hand-built encoding', C.hashStruct('Order', order, OT), manual);
  const domainNoType = { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: MAIL.domain.verifyingContract };
  eq('hashDomain derives EIP712Domain from the fields present when types lack it', C.hashDomain(domainNoType), C.hashDomain(MAIL.domain, MAIL.types));
  eq('hashDomain with a subset of fields (name, chainId)', C.hashDomain({ chainId: 5, name: 'x' }),
    kcat([C.keccak256Utf8('EIP712Domain(string name,uint256 chainId)'), C.keccak256Utf8('x'), '0x' + word(5n)]));
  eq('chainId as number, decimal string, hex string and BigInt hash the same', new Set([1, '1', '0x1', 1n].map((c) => C.hashTypedData({ ...MAIL, domain: { ...MAIL.domain, chainId: c } }))).size, 1);
  eq('primaryType EIP712Domain hashes only the domain', C.hashTypedData({ ...MAIL, primaryType: 'EIP712Domain' }), kcat(['0x1901', C.hashDomain(MAIL.domain, MAIL.types)]));
  throws('missing message field', () => C.hashTypedData({ ...MAIL, message: { ...MAIL.message, contents: undefined } }), /missing value/);
  throws('undeclared message property (a wallet would silently ignore it)', () => C.hashTypedData({ ...MAIL, message: { ...MAIL.message, bcc: 'x' } }), /does not declare/);
  throws('undeclared domain property', () => C.hashTypedData({ ...MAIL, domain: { ...MAIL.domain, salt: '0x' + '00'.repeat(32) } }), /does not declare/);
  throws('unknown domain key without an EIP712Domain type', () => C.hashDomain({ name: 'x', foo: 1 }), /unknown domain field/);
  throws('unknown field type', () => C.hashStruct('A', { x: 1 }, { A: [{ name: 'x', type: 'Missing' }] }), /unknown type/);
  throws('non-canonical atomic type (uint)', () => C.hashStruct('A', { x: 1 }, { A: [{ name: 'x', type: 'uint' }] }), /unknown type/);
  throws('unknown primaryType', () => C.hashTypedData({ ...MAIL, primaryType: 'Nope' }), /unknown primaryType/);
  throws('fixed array with the wrong length', () => C.hashStruct('Order', { ...order, pair: [COW] }, OT), /2 elements/);
  throws('duplicate field names', () => C.hashStruct('A', { x: 1 }, { A: [{ name: 'x', type: 'uint8' }, { name: 'x', type: 'uint8' }] }), /duplicate/);
  throws('wrong value type (address)', () => C.hashTypedData({ ...MAIL, message: { ...MAIL.message, to: { name: 'Bob', wallet: 'bob' } } }), /address/);
  throws('inherited properties are not values', () => C.hashStruct('A', {}, { A: [{ name: 'constructor', type: 'string' }] }), /missing value/);
});

// ═════════════════════════════════════════════════════════════════════════════
section('personal_sign', () => {
  eq('private key 0x4c08…2318 maps to 0x2c7536E3…5c23 (web3.js docs)', C.toChecksumAddress(S.privateKeyToAddress(WEB3_KEY)), WEB3_ADDR);
  eq('hashPersonalMessage("Some data") (web3.js docs)', C.hashPersonalMessage('Some data'), WEB3_HASH);
  eq('signing it gives the published signature (web3.js docs)', S.sign(WEB3_HASH, WEB3_KEY), WEB3_SIG);
  eq('recoverPersonalSignAddress recovers the signer', C.recoverPersonalSignAddress('Some data', WEB3_SIG), WEB3_ADDR.toLowerCase());
  eq('a Uint8Array message hashes like the same UTF-8 string', C.hashPersonalMessage(C.utf8Bytes('Some data')), WEB3_HASH);
  eq('the length prefix counts UTF-8 bytes, not characters', C.hashPersonalMessage('é'), C.keccak256(C.bytesToHex(C.utf8Bytes('\x19Ethereum Signed Message:\n2é'))));
  check('a hex-looking string is hashed as text', C.hashPersonalMessage('0x1234') !== C.hashPersonalMessage(Uint8Array.of(0x12, 0x34)));
  throws('rejects non-string, non-bytes messages', () => C.hashPersonalMessage(42), /string or Uint8Array/);
});

// ═════════════════════════════════════════════════════════════════════════════
const SPKI_PREFIX = Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex');
function derSignature(r, s) {
  const int = (x) => { let h = x.toString(16); if (h.length % 2) h = '0' + h; if (parseInt(h.slice(0, 2), 16) >= 0x80) h = '00' + h; return '02' + (h.length / 2).toString(16).padStart(2, '0') + h; };
  const body = int(r) + int(s);
  return Buffer.from('30' + (body.length / 2).toString(16).padStart(2, '0') + body, 'hex');
}

section('secp256k1', () => {
  check('G is on the curve', (S.Gy * S.Gy - S.Gx ** 3n - 7n) % P === 0n);
  eq('mulG(1) = G', S.mulG(1n), { x: S.Gx, y: S.Gy });
  eq('mulG(2) = 2G (known value)', S.mulG(2n), { x: 0xc6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5n, y: 0x1ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52an });
  eq('mulG(n−1) = −G', S.mulG(N - 1n), { x: S.Gx, y: P - S.Gy });
  throws('mulG(0) is rejected', () => S.mulG(0n), /\[1, n-1\]/);
  throws('mulG(n) is rejected', () => S.mulG(N), /\[1, n-1\]/);

  const signMs = [], recoverMs = [];
  let ecdhBad = 0, verifyBad = 0, oracleSane = 0, recoverBad = 0, parityBad = 0, lowSBad = 0, pubBad = 0, determinismBad = 0, highSBad = 0;
  for (let i = 0; i < 40; i++) {
    const key = randBytes(32);
    const keyHex = '0x' + hex(key);
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.setPrivateKey(Buffer.from(key));
    const nodePub = ecdh.getPublicKey(null, 'uncompressed');
    const { x, y } = S.mulG(BigInt(keyHex));
    const myPub = Buffer.from('04' + pad64(x) + pad64(y), 'hex');
    if (!myPub.equals(nodePub)) ecdhBad++;

    const msg = randBytes(1 + randInt(200));
    const digest = '0x' + crypto.createHash('sha256').update(msg).digest('hex');
    const [sig, ms] = time(() => S.sign(digest, keyHex));
    signMs.push(ms);
    const { r, s, v } = splitSig(sig);
    if (s > N / 2n || (v !== 27 && v !== 28)) lowSBad++;
    if (S.sign(digest, keyHex) !== sig) determinismBad++;
    const spki = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, myPub]), format: 'der', type: 'spki' });
    if (!crypto.verify('sha256', msg, { key: spki, dsaEncoding: 'der' }, derSignature(r, s))) verifyBad++;
    if (!crypto.verify('sha256', Buffer.concat([msg, Buffer.from([1])]), { key: spki, dsaEncoding: 'der' }, derSignature(r, s))) oracleSane++;

    const [addr, rms] = time(() => C.recoverAddress(digest, sig));
    recoverMs.push(rms);
    if (addr !== S.privateKeyToAddress(keyHex)) recoverBad++;
    if (!Buffer.from(C.recoverPublicKey(digest, sig)).equals(nodePub)) pubBad++;
    if (C.recoverAddress(digest, sigHex(r, s, v === 27 ? 28 : 27)) === addr) parityBad++;
    if (C.recoverAddress(digest, sigHex(r, N - s, v === 27 ? 28 : 27)) !== addr) highSBad++; // ecrecover semantics
  }
  check('mulG(k) equals node:crypto ECDH public keys for 40 random keys', ecdhBad === 0, ecdhBad + ' mismatches');
  check('40 signatures over sha256 digests verify with node:crypto.verify (SPKI key, DER signature)', verifyBad === 0, verifyBad + ' failed');
  check('(oracle sanity) node:crypto.verify rejects all 40 signatures for a modified message', oracleSane === 40, oracleSane + '/40 rejected');
  check('signatures are low-s with v ∈ {27, 28}', lowSBad === 0, lowSBad + ' bad');
  check('RFC 6979 signing is deterministic', determinismBad === 0);
  check('recoverAddress(sign(d, k)) === privateKeyToAddress(k) for 40 keys', recoverBad === 0, recoverBad + ' mismatches');
  check('recoverPublicKey returns the 65-byte uncompressed key node:crypto derives', pubBad === 0, pubBad + ' mismatches');
  check('recovery with the other parity gives a different address (40/40)', parityBad === 0, parityBad + ' collisions');
  check('high-s form (n − s, flipped v) recovers the same signer, like ecrecover', highSBad === 0, highSBad + ' mismatches');

  const key = '0x' + '11'.repeat(32), msg = Buffer.from('explicit k');
  const digest = '0x' + crypto.createHash('sha256').update(msg).digest('hex');
  const withK = S.sign(digest, key, 0x1234567890abcdefn);
  const pub = Buffer.from('04' + pad64(S.mulG(BigInt(key)).x) + pad64(S.mulG(BigInt(key)).y), 'hex');
  const kSig = splitSig(withK);
  check('sign with an explicit k verifies with node:crypto and recovers', crypto.verify('sha256', msg, crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: 'der', type: 'spki' }), derSignature(kSig.r, kSig.s)) &&
    C.recoverAddress(digest, withK) === S.privateKeyToAddress(key));
  check('an explicit k gives a different signature than RFC 6979', withK !== S.sign(digest, key));
  throws('sign rejects k = 0', () => S.sign(digest, key, 0n), /k must be/);
  throws('sign rejects the zero private key', () => S.sign(digest, '0x' + '00'.repeat(32)), /private key/);
  throws('sign rejects a private key ≥ n', () => S.sign(digest, '0x' + pad64(N)), /private key/);
  eq('v = 0/1 is accepted like 27/28', C.recoverAddress(digest, sigHex(kSig.r, kSig.s, kSig.v - 27)), C.recoverAddress(digest, withK));

  const { r, s, v } = kSig;
  let noPointR = 1n;
  const powMod = (b, e, m) => { let res = 1n; b %= m; for (; e > 0n; e >>= 1n) { if (e & 1n) res = (res * b) % m; b = (b * b) % m; } return res; };
  while (powMod(noPointR ** 3n + 7n, (P - 1n) / 2n, P) === 1n) noPointR++;
  const malformed = [
    ['s = 0', sigHex(r, 0n, v), /s must be/], ['r = 0', sigHex(0n, s, v), /r must be/], ['r = n', sigHex(N, s, v), /r must be/],
    ['r ≥ n (n + 1)', sigHex(N + 1n, s, v), /r must be/], ['s = n', sigHex(r, N, v), /s must be/], ['s = 2^256 − 1', sigHex(r, (1n << 256n) - 1n, v), /s must be/],
    ['v = 29', sigHex(r, s, 29), /v must be/], ['v = 2', sigHex(r, s, 2), /v must be/], ['v = 26', sigHex(r, s, 26), /v must be/],
    ['64 bytes (EIP-2098 compact)', withK.slice(0, 130), /64.*EIP-2098/], ['66 bytes', withK + '00', /65 bytes/],
    ['non-hex characters', withK.slice(0, 128) + 'zz' + withK.slice(130), /invalid/], ['odd-length hex', withK.slice(0, 131), /odd/],
    ['no 0x prefix', withK.slice(2), /0x-prefixed/], ['not a string', 12345, /0x-prefixed/],
    [`r = ${noPointR} has no curve point`, sigHex(noPointR, s, v), /curve point/],
  ];
  for (const [label, bad, re] of malformed) throws(`malformed signature is rejected: ${label}`, () => C.recoverAddress(digest, bad), re);
  throws('digest of 31 bytes is rejected', () => C.recoverAddress('0x' + '11'.repeat(31), withK), /32 bytes/);
  throws('digest without 0x prefix is rejected', () => C.recoverAddress('11'.repeat(32), withK), /0x-prefixed/);
  throws('publicKeyToAddress rejects a compressed key', () => C.publicKeyToAddress(Uint8Array.from([2, ...new Uint8Array(32)])), /65-byte/);
  throws('publicKeyToAddress rejects a point off the curve', () => C.publicKeyToAddress(Uint8Array.from([4, ...new Uint8Array(63), 1])), /not on secp256k1/);

  signMs.sort((a, b) => a - b);
  recoverMs.sort((a, b) => a - b);
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  timings.signAvgMs = +avg(signMs).toFixed(2);
  timings.recoverAvgMs = +avg(recoverMs).toFixed(2);
  timings.recoverMaxMs = +recoverMs[recoverMs.length - 1].toFixed(2);
  check(`recovery takes < 50 ms per signature (avg ${timings.recoverAvgMs} ms, max ${timings.recoverMaxMs} ms)`, timings.recoverMaxMs < 50);
});

// ═════════════════════════════════════════════════════════════════════════════
section('SyncNet provenance', () => {
  eq('PROVENANCE_DOMAIN', C.PROVENANCE_DOMAIN, 'SYNCNET/1');
  for (const fx of FIXTURES) {
    eq(`${fx.path}: recordHashOf(provenanceJson) === recordHash`, C.recordHashOf(fx.provenanceJson), fx.recordHash);
    eq(`${fx.path}: intentSalt(recordHash) === salt`, C.intentSalt(fx.recordHash), fx.salt);
    eq(`${fx.path}: salt === params.salt`, fx.salt, fx.params.salt);
    eq(`${fx.path}: intentSalt matches keccak256(viem.encodeAbiParameters(string, bytes32))`, C.intentSalt(fx.recordHash),
      viem.keccak256(viem.encodeAbiParameters([{ type: 'string' }, { type: 'bytes32' }], ['SYNCNET/1', fx.recordHash])));
  }
  throws('intentSalt rejects a non-bytes32 recordHash', () => C.intentSalt('0x1234'), /bytes32/);
  throws('recordHashOf requires the JSON string', () => C.recordHashOf({}), /JSON string/);

  const fx = FIXTURES[1];
  const operator = JSON.parse(fx.provenanceJson).operator;
  const input = { chainId: 4663, operator, token: fx.predicted, recordHash: fx.recordHash, salt: fx.salt };
  const typed = C.launchIntentTypedData(input);
  const literal = {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }],
      LaunchIntent: [{ name: 'operator', type: 'address' }, { name: 'token', type: 'address' }, { name: 'recordHash', type: 'bytes32' }, { name: 'salt', type: 'bytes32' }],
    },
    primaryType: 'LaunchIntent',
    domain: { name: 'SyncNet Launch Provenance', version: '1', chainId: 4663 },
    message: { operator, token: fx.predicted, recordHash: fx.recordHash, salt: fx.salt },
  };
  eq('launchIntentTypedData returns exactly the specified object (same JSON, same key order)', JSON.stringify(typed), JSON.stringify(literal));
  eq('chainId given as BigInt or string becomes the number 4663', [C.launchIntentTypedData({ ...input, chainId: 4663n }).domain.chainId, C.launchIntentTypedData({ ...input, chainId: '4663' }).domain.chainId], [4663, 4663]);
  eq('launchIntentPlainMessage returns exactly the specified text', C.launchIntentPlainMessage(input),
    `SyncNet Launch Intent v1\nchainId:4663\noperator:${operator}\ntoken:${fx.predicted}\nrecordHash:${fx.recordHash}\nsalt:${fx.salt}`);
  for (const [label, bad] of [['operator', { ...input, operator: '0x12' }], ['token', { ...input, token: 'nope' }], ['recordHash', { ...input, recordHash: '0x12' }],
    ['salt', { ...input, salt: undefined }], ['chainId 0', { ...input, chainId: 0 }], ['chainId -1', { ...input, chainId: -1 }], ['chainId 1.5', { ...input, chainId: 1.5 }],
    ['chainId "0x1237"', { ...input, chainId: '0x1237' }], ['no input', undefined]]) {
    throws(`launchIntentTypedData rejects an invalid ${label}`, () => C.launchIntentTypedData(bad));
  }
  throws('launchIntentPlainMessage rejects invalid input', () => C.launchIntentPlainMessage({ ...input, operator: 'x' }));

  for (const f of FIXTURES) {
    const op = JSON.parse(f.provenanceJson).operator;
    const t = C.launchIntentTypedData({ chainId: 4663, operator: op, token: f.predicted, recordHash: f.recordHash, salt: f.salt });
    const sig = S.sign(C.hashTypedData(t), WEB3_KEY);
    eq(`${f.path}: EIP-712 intent signed by the operator key recovers the fixture operator`, C.recoverTypedDataAddress(t, sig), op);
    const plain = C.launchIntentPlainMessage({ chainId: 4663, operator: op, token: f.predicted, recordHash: f.recordHash, salt: f.salt });
    eq(`${f.path}: personal_sign fallback round-trips to the operator`, C.recoverPersonalSignAddress(plain, S.sign(C.hashPersonalMessage(plain), WEB3_KEY)), op);
    const other = C.launchIntentTypedData({ chainId: 4663, operator: op, token: f.predicted, recordHash: f.recordHash, salt: FIXTURES[0].salt === f.salt ? FIXTURES[1].salt : FIXTURES[0].salt });
    check(`${f.path}: the same signature does not recover the operator for an intent with another salt`, C.recoverTypedDataAddress(other, sig) !== op);
  }

  const clone = () => JSON.parse(JSON.stringify(typed));
  const mutate = (fn) => { const c = clone(); fn(c); return c; };
  check('sameTypedIntent: identical objects', C.sameTypedIntent(typed, typed));
  check('sameTypedIntent: a JSON round trip is the same', C.sameTypedIntent(typed, clone()));
  check('sameTypedIntent: chainId as "4663" or 4663n is the same', C.sameTypedIntent(typed, mutate((c) => { c.domain.chainId = '4663'; })) &&
    C.sameTypedIntent(typed, { ...typed, domain: { ...typed.domain, chainId: 4663n } }));
  check('sameTypedIntent: address case does not matter', C.sameTypedIntent(typed, mutate((c) => { c.message.operator = C.toChecksumAddress(c.message.operator); c.message.token = '0x' + c.message.token.slice(2).toUpperCase(); })));
  check('sameTypedIntent: hex case does not matter', C.sameTypedIntent(typed, mutate((c) => { c.message.recordHash = '0x' + c.message.recordHash.slice(2).toUpperCase(); })));
  const differing = [
    ['recordHash', (c) => { c.message.recordHash = FIXTURES[0].recordHash; }], ['salt', (c) => { c.message.salt = FIXTURES[0].salt; }],
    ['token', (c) => { c.message.token = '0x' + '77'.repeat(19) + '78'; }], ['operator', (c) => { c.message.operator = COW; }],
    ['chainId', (c) => { c.domain.chainId = 46630; }], ['domain name', (c) => { c.domain.name = 'SyncNet Launch Provenance '; }],
    ['domain version', (c) => { c.domain.version = '2'; }], ['extra message key', (c) => { c.message.memo = 'x'; }],
    ['missing message key', (c) => { delete c.message.salt; }], ['extra domain key', (c) => { c.domain.verifyingContract = COW; }],
    ['extra top-level key', (c) => { c.extra = 1; }], ['field type', (c) => { c.types.LaunchIntent[3].type = 'bytes'; }],
    ['field order', (c) => { c.types.LaunchIntent.reverse(); }], ['primaryType', (c) => { c.primaryType = 'Other'; }],
    ['invalid address', (c) => { c.message.token = '0x1234'; }], ['short bytes32', (c) => { c.message.salt = c.message.salt.slice(0, 64); }],
    ['chainId garbage', (c) => { c.domain.chainId = 'abc'; }],
  ];
  for (const [label, fn] of differing) check(`sameTypedIntent detects a changed ${label}`, !C.sameTypedIntent(typed, mutate(fn)) && !C.sameTypedIntent(mutate(fn), typed));
  check('sameTypedIntent never throws on garbage', [null, undefined, 5, 'x', [], { types: null }, { ...typed, types: { EIP712Domain: 5 } }].every((g) => C.sameTypedIntent(typed, g) === false));
});

// ═════════════════════════════════════════════════════════════════════════════
section('text policy', () => {
  eq('PAR_BYTE_LIMITS', { ...C.PAR_BYTE_LIMITS }, { name: 64, symbol: 16, logo: 512, description: 2048, social: 256 });

  // Exhaustive: every code point, classified by a table restated from the spec, versus findUnsafeChars.
  const inr = (cp, a, b = a) => cp >= a && cp <= b;
  const INV = [[0xad], [0x34f], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200d], [0x2028, 0x2029], [0x2060, 0x2064], [0x206a, 0x206f],
    [0x3164], [0xfe00, 0xfe0d], [0xfeff], [0xffa0], [0xfff9, 0xfffb], [0x1d173, 0x1d17a], [0xe0000, 0xe007f], [0xe0100, 0xe01ef]];
  const ref = (cp, multiline) => {
    if (cp <= 0x1f) return cp === 0x0a && multiline ? null : 'control';
    if (cp === 0x7f || inr(cp, 0x80, 0x9f)) return 'control';
    if ([0x61c, 0x200e, 0x200f].includes(cp) || inr(cp, 0x202a, 0x202e) || inr(cp, 0x2066, 0x2069)) return 'bidi';
    if (INV.some(([a, b]) => inr(cp, a, b))) return 'invisible';
    if (inr(cp, 0xfdd0, 0xfdef) || cp % 0x10000 >= 0xfffe) return 'noncharacter';
    if (inr(cp, 0xe000, 0xf8ff) || inr(cp, 0xf0000, 0x10ffff)) return 'private-use';
    return null;
  };
  for (const multiline of [false, true]) {
    const parts = [], want = [];
    let index = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (inr(cp, 0xd800, 0xdfff)) continue;
      const reason = ref(cp, multiline);
      if (reason) want.push(`${index}:U+${cp.toString(16).toUpperCase().padStart(4, '0')}:${reason}`);
      const ch = String.fromCodePoint(cp);
      parts.push(ch);
      index += ch.length;
    }
    const [got, ms] = time(() => C.findUnsafeChars(parts.join(''), { multiline }).map((f) => `${f.index}:${f.codePoint}:${f.reason}`));
    const firstDiff = got.findIndex((g, i) => g !== want[i]);
    check(`all 1,112,064 scalar values classified as specified (multiline=${multiline}, ${want.length} flagged, ${ms.toFixed(0)} ms)`,
      got.length === want.length && firstDiff === -1, `first difference: got ${got[firstDiff]}, expected ${want[firstDiff]}`);
  }
  const one = (s, opts) => C.findUnsafeChars(s, opts).map((f) => [f.index, f.codePoint, f.reason]);
  eq('TAB is flagged even in multiline mode', one('a\tb', { multiline: true }), [[1, 'U+0009', 'control']]);
  eq('LF is flagged in single-line mode only', [one('a\nb'), one('a\nb', { multiline: true })], [[[1, 'U+000A', 'control']], []]);
  eq('bidi override U+202E', one('ab\u202e'), [[2, 'U+202E', 'bidi']]);
  eq('astral invisible U+1D173 and tag U+E0041', one('\u{1d173}x\u{e0041}'), [[0, 'U+1D173', 'invisible'], [3, 'U+E0041', 'invisible']]);
  eq('noncharacters U+FDD0, U+FFFF, U+1FFFE, U+10FFFF', one('\ufdd0\uffff\u{1fffe}\u{10ffff}'), [[0, 'U+FDD0', 'noncharacter'], [1, 'U+FFFF', 'noncharacter'], [2, 'U+1FFFE', 'noncharacter'], [4, 'U+10FFFF', 'noncharacter']]);
  eq('private use U+E000 and U+F0000', one('\ue000\u{f0000}'), [[0, 'U+E000', 'private-use'], [1, 'U+F0000', 'private-use']]);
  eq('lone surrogates (high at end, low alone, reversed pair)', one('a\ud83d|\ude00|\ude00\ud83d'),
    [[1, 'U+D83D', 'lone-surrogate'], [3, 'U+DE00', 'lone-surrogate'], [5, 'U+DE00', 'lone-surrogate'], [6, 'U+D83D', 'lone-surrogate']]);
  eq('index is a UTF-16 index (after an emoji)', one('😀\u200b'), [[2, 'U+200B', 'invisible']]);
  eq('U+FE0E/U+FE0F, emoji, CJK, accents and NBSP are allowed', one('❤\ufe0f ☺\ufe0e 界 ünï\u00a0x 👍🏽'), []);
  throws('findUnsafeChars rejects non-strings', () => C.findUnsafeChars(null), /string/);

  eq('normalizeText: NFC (e + U+0301 → é)', C.normalizeText('e\u0301'), 'é');
  eq('normalizeText: trims and collapses whitespace runs (incl. LF) in single-line mode', C.normalizeText('  a \t\n  b\u00a0\u3000c  '), 'a b c');
  eq('normalizeText: multiline converts CRLF/CR to LF, trims, keeps inner spacing', C.normalizeText('  a\r\nb\rc  d \n', { multiline: true }), 'a\nb\nc  d');
  throws('normalizeText rejects non-strings', () => C.normalizeText(5), /string/);

  const cjk = C.validateMetadataField('name', '界'.repeat(40));
  eq('40 × "界" as name: 120 bytes → TOO_MANY_BYTES with the exact message', [cjk.ok, cjk.bytes, cjk.limit, cjk.errors.map((e) => [e.code, e.message])],
    [false, 120, 64, [['TOO_MANY_BYTES', 'Name is 120 bytes in UTF-8; PAR allows 64.']]]);
  const rlo = C.validateMetadataField('description', 'Hello world\u202eevil', { multiline: true });
  eq('U+202E in description: exact message with a 1-based position', rlo.errors.map((e) => [e.code, e.message]),
    [['UNSAFE_CHARS', 'Description contains an invisible or direction-changing character (U+202E) at position 12.']]);
  eq('positions count characters, not UTF-16 units', C.validateMetadataField('name', '😀😀\u200bx').errors[0].message, 'Name contains an invisible or direction-changing character (U+200B) at position 3.');
  eq('several unsafe characters are summarized', C.validateMetadataField('name', 'a\u200bb\u200bc\u202e').errors[0].message,
    'Name contains an invisible or direction-changing character (U+200B) at position 2. 2 more unsafe characters found.');
  eq('symbol 17 bytes', C.validateMetadataField('symbol', 'ABCDEFGHIJKLMNOPQ').errors.map((e) => e.message), ['Symbol is 17 bytes in UTF-8; PAR allows 16.']);
  check('byte limit boundary: 64 bytes ok, 65 bytes rejected', C.validateMetadataField('name', 'é'.repeat(32)).ok && !C.validateMetadataField('name', 'é'.repeat(32) + 'x').ok);
  eq('social 257 bytes', C.validateMetadataField('social', 'https://x.com/' + 'a'.repeat(243)).errors.map((e) => e.code), ['TOO_MANY_BYTES']);
  eq('logo 513 bytes', C.validateMetadataField('logo', 'ipfs://' + 'b'.repeat(506)).errors.map((e) => e.message), ['Logo is 513 bytes in UTF-8; PAR allows 512.']);
  eq('description 2049 bytes', C.validateMetadataField('description', 'd'.repeat(2049)).errors.map((e) => e.code), ['TOO_MANY_BYTES']);
  eq('empty name → EMPTY', C.validateMetadataField('name', '  \n ').errors.map((e) => [e.code, e.message]), [['EMPTY', 'Name is required.']]);
  check('empty social link / description are allowed', C.validateMetadataField('social', '').ok && C.validateMetadataField('description', '').ok && C.validateMetadataField('logo', null).ok);
  const ml = C.validateMetadataField('description', 'Line1\r\nLine2');
  check('description is multiline by default and keeps LF', ml.ok && ml.value === 'Line1\nLine2');
  eq('multiline allows LF but not TAB', C.validateMetadataField('description', 'a\tb', { multiline: true }).errors.map((e) => e.message),
    ['Description contains a control character (U+0009) at position 2.']);
  const tabName = C.validateMetadataField('name', 'a\tb');
  check('a TAB in a single-line field is normalized to a space', tabName.ok && tabName.value === 'a b');
  const nfc = C.validateMetadataField('name', 'Cafe\u0301');
  check('the returned value is NFC-normalized and bytes are counted on it', nfc.value === 'Café' && nfc.bytes === 5);
  const p = FIXTURES[0].params;
  check('the fixture metadata passes (name, symbol, logo, description, socials)', ['name', 'symbol', 'logo', 'description'].every((f) => C.validateMetadataField(f, p[f]).ok) &&
    Object.values(p.socials).every((v) => C.validateMetadataField('social', v).ok) && C.validateMetadataField('description', p.description).value === p.description);
  throws('unknown field name', () => C.validateMetadataField('title', 'x'), /unknown field/);
  throws('non-string value', () => C.validateMetadataField('name', 5), /must be a string/);

  eq('sanitizeForDisplay strips bidi and zero-width characters', C.sanitizeForDisplay('Hello\u202e \u200bworld\u2066!\ufeff'), 'Hello world!');
  const emoji = C.sanitizeForDisplay('😀'.repeat(50), { maxLength: 10 });
  check('sanitizeForDisplay truncates by code points without splitting surrogate pairs', Array.from(emoji).length === 10 && emoji === '😀'.repeat(9) + '…' && emoji.isWellFormed(), JSON.stringify(emoji));
  eq('sanitizeForDisplay keeps short strings intact', C.sanitizeForDisplay('😀'.repeat(10), { maxLength: 10 }), '😀'.repeat(10));
  eq('sanitizeForDisplay: default maxLength is 160', Array.from(C.sanitizeForDisplay('x'.repeat(500))).length, 160);
  eq('sanitizeForDisplay: single-line turns line breaks and tabs into spaces', C.sanitizeForDisplay('a\nb\tc\r\nd\u2028e'), 'a b c d e');
  eq('sanitizeForDisplay: multiline keeps LF', C.sanitizeForDisplay('a\r\n\u202eb', { multiline: true }), 'a\nb');
  eq('sanitizeForDisplay: non-strings become safe strings', [null, undefined, {}, [], Symbol('x'), 42, 7n, true].map((v) => C.sanitizeForDisplay(v)), ['', '', '', '', '', '42', '7', 'true']);
  throws('sanitizeForDisplay: invalid maxLength', () => C.sanitizeForDisplay('x', { maxLength: 0 }), /maxLength/);
  let fuzzBad = 0;
  const cps = [0x0, 0x9, 0xa, 0xd, 0x41, 0xe9, 0x85, 0x200b, 0x200d, 0x202e, 0x2028, 0xfe0f, 0xfeff, 0xe000, 0xfffe, 0x1f600, 0x1d173, 0xe0041, 0x10ffff, 0xd800, 0xdc00];
  for (let i = 0; i < 400; i++) {
    const s = Array.from({ length: randInt(60) }, () => String.fromCodePoint(cps[randInt(cps.length)])).join(''); // 0xd800/0xdc00 give lone surrogates
    const multiline = randInt(2) === 1, maxLength = 1 + randInt(30);
    const out = C.sanitizeForDisplay(s, { maxLength, multiline });
    if (typeof out !== 'string' || C.findUnsafeChars(out, { multiline }).length || Array.from(out).length > maxLength || !out.isWellFormed()) fuzzBad++;
  }
  check('sanitizeForDisplay fuzz: output never contains a flagged character and never exceeds maxLength (400 strings)', fuzzBad === 0, fuzzBad + ' bad outputs');

  const same = (a, b) => C.confusableSkeleton(a) === C.confusableSkeleton(b);
  check("confusableSkeleton('$ЅYNC') === confusableSkeleton('sync') (spec example)", same('$ЅYNC', 'sync'));
  check("'$ЅYNC' vs 'SYNC' (Cyrillic Dze)", same('$ЅYNC', 'SYNC'));
  check("'ЅУΝС' vs 'sync' (Cyrillic Ѕ, У, С and Greek Ν)", same('ЅУΝС', 'sync'));
  check("'SYNC\u200b' (trailing zero-width space) vs 'sync'", same('SYNC\u200b', 'sync'));
  check("'PAR' vs 'рar' (Cyrillic р)", same('PAR', 'рar'));
  eq('skeletons of fullwidth, math-bold, digit, punctuated, Cyrillic and Armenian (capital Ո) variants', ['ＳＹＮＣ', '𝐒𝐘𝐍𝐂', '5YNC', 'S.Y.N.C', 'ѕуnс', 'SYՈC'].map(C.confusableSkeleton), Array(6).fill('sync'));
  eq('Greek capitals vs small letters (Ν→n, ν→v; Η→h, η→n)', [C.confusableSkeleton('ΝΗ'), C.confusableSkeleton('νη')], ['nh', 'vn']);
  eq('dotless ı, long s ſ, ß → ss, digits 0 1 3 8', [C.confusableSkeleton('ıſß'), C.confusableSkeleton('0138')], ['isss', 'oleb']);
  check('different names keep different skeletons', !same('SYNK', 'SYNC') && !same('PAIR', 'PAR') && C.confusableSkeleton('USDG') === 'usdg');
  eq('confusableSkeleton of a non-string is empty', C.confusableSkeleton(null), '');
});

// ═════════════════════════════════════════════════════════════════════════════
const passed = checks.filter((c) => c.ok).length, failed = checks.length - passed;
console.log(`\n${passed} passed, ${failed} failed (seed ${SEED})`);
console.log('timings:', JSON.stringify(timings));
// Invisible and bidi characters from the test payloads are written escaped, so the results file itself stays clean.
fs.writeFileSync(path.join(HERE, 'core.results.json'), JSON.stringify({ passed, failed, checks, timings, seed: SEED }, null, 2).replace(/[\u00ad\u034f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufeff\uffa0]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n');
process.exit(failed ? 1 : 0);
