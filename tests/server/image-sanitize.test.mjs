#!/usr/bin/env node
/**
 * Tests for netlify/lib/image-sanitize.js
 *
 *   node tests/server/image-sanitize.test.mjs
 *
 * Prints one line per check, writes tests/server/image-sanitize.results.json and exits with 1 on
 * any failure. sharp (and Pillow, when python3 has it) are used only here, to build fixtures and
 * as independent decoders for cross-checks. The library itself uses Node built-ins only.
 * Every fixture is generated in memory; the results file is the only thing written.
 */
import fs from 'fs';
import zlib from 'zlib';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { performance } from 'perf_hooks';

const sharp = (await import('module')).createRequire(import.meta.url)('/home/claude/.npm-global/lib/node_modules/sharp');
const require = createRequire(import.meta.url);
const LIB_PATH = fileURLToPath(new URL('../../netlify/lib/image-sanitize.js', import.meta.url));
const RESULTS_PATH = fileURLToPath(new URL('./image-sanitize.results.json', import.meta.url));
const { sanitizeImage, ImageRejected, DEFAULT_LIMITS, _internal } = require(LIB_PATH);
const MAX_BYTES = DEFAULT_LIMITS.maxInputBytes;
const CODES = ['UNSUPPORTED_FORMAT', 'TYPE_MISMATCH', 'MALFORMED', 'TOO_LARGE_BYTES', 'TOO_LARGE_DIMENSIONS', 'TOO_SMALL_DIMENSIONS', 'TOO_MANY_FRAMES', 'DECOMPRESSION_LIMIT'];

// ------------------------------------------------------------------------------------------------
// Check runner
// ------------------------------------------------------------------------------------------------
const checks = [];
const outputSizes = [];
const timings = {};
const T0 = performance.now();
let resultsWritten = false;

function writeResults() {
  const count = (s) => checks.filter((c) => c.status === s).length;
  const summary = { passed: count('pass'), failed: count('fail'), skipped: count('skip'), node: process.version, timings, checks };
  fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(summary, null, 2)}\n`);
  resultsWritten = true;
  return summary;
}
// If fixture generation itself crashes (outside any check), still leave a failing summary behind.
process.on('exit', (code) => {
  if (resultsWritten) return;
  checks.push({ name: 'harness: test script stopped before finishing', status: 'fail', ms: 0, detail: `exit code ${code}` });
  console.log(`FAIL  harness: test script stopped before finishing (exit code ${code})`);
  writeResults();
  if (!code) process.exitCode = 1;
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function check(name, fn) {
  const t0 = performance.now();
  let ok = true;
  let detail = '';
  try {
    detail = (await fn()) || '';
  } catch (err) {
    ok = false;
    detail = err && err.message ? err.message : String(err);
  }
  const ms = Math.round((performance.now() - t0) * 10) / 10;
  checks.push({ name, status: ok ? 'pass' : 'fail', ms, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${ms} ms)${detail ? `  ${detail}` : ''}`);
}
function skip(name, reason) {
  checks.push({ name, status: 'skip', ms: 0, detail: reason });
  console.log(`SKIP  ${name}  ${reason}`);
}
const run = (buf, declaredType, limits) => sanitizeImage(buf, { declaredType, limits });
const timeIt = (fn) => {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
};
const eqBuf = (a, b) => (a === null || b === null ? a === b : Buffer.from(a).equals(Buffer.from(b)));
function firstDiff(a, b) {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `byte ${i}: ${a[i]} vs ${b[i]}`;
  return 'none';
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// No stack frames, file paths, zlib wording or JS-isms in anything a user may see.
const INTERNAL_DETAIL = /zlib|inflate|deflate|ERR_|Error|\.js\b|node_modules|undefined|NaN|[\\/{}]/;
function assertSafeMessage(msg) {
  assert(typeof msg === 'string' && msg.length > 0 && msg.length <= 120, `bad message length: ${JSON.stringify(msg)}`);
  assert(!/[\r\n]/.test(msg) && !INTERNAL_DETAIL.test(msg), `message leaks internals: ${msg}`);
}
async function expectReject(name, buf, declaredType, code, { limits, maxMs } = {}) {
  await check(name, () => {
    const copy = Buffer.from(buf);
    let err = null;
    const { ms } = timeIt(() => {
      try {
        run(buf, declaredType, limits);
      } catch (e) {
        err = e;
      }
    });
    assert(err, `accepted; expected ${code}`);
    assert(err instanceof ImageRejected && err instanceof Error, `threw ${err.name}: ${err.message}`);
    assert(err.code === code, `got ${err.code} ("${err.message}"), expected ${code}`);
    assert(CODES.includes(err.code) && err.name === 'ImageRejected', 'unknown code or name');
    assertSafeMessage(err.message);
    assert(buf.equals(copy), 'input buffer was modified');
    if (maxMs) assert(ms < maxMs, `took ${ms.toFixed(1)} ms (budget ${maxMs} ms)`);
    return `${code}${maxMs ? ` in ${ms.toFixed(1)} ms` : ''}: "${err.message}"`;
  });
}

// ------------------------------------------------------------------------------------------------
// PNG helpers (an independent writer; sharp is the independent decoder)
// ------------------------------------------------------------------------------------------------
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_T = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
  return c >>> 0;
});
function crc(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_T[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data = Buffer.alloc(0), { badCrc = false } = {}) {
  data = Buffer.from(data);
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, 'latin1');
  data.copy(b, 8);
  b.writeUInt32BE((crc(b.subarray(4, 8 + data.length)) ^ (badCrc ? 1 : 0)) >>> 0, 8 + data.length);
  return b;
}
function ihdrChunk(w, h, depth, ct, interlace = 0, compression = 0, filter = 0) {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d.set([depth, ct, compression, filter, interlace], 8);
  return chunk('IHDR', d);
}
function listChunks(png) {
  const out = [];
  let p = 8;
  while (p + 12 <= png.length) {
    const len = png.readUInt32BE(p);
    const type = png.toString('latin1', p + 4, p + 8);
    out.push({ type, data: png.subarray(p + 8, p + 8 + len), crcOk: crc(png.subarray(p + 4, p + 8 + len)) === png.readUInt32BE(p + 8 + len), raw: png.subarray(p, p + 12 + len) });
    p += 12 + len;
  }
  return { chunks: out, end: p };
}
function readIhdr(png) {
  const d = listChunks(png).chunks[0].data;
  return { width: d.readUInt32BE(0), height: d.readUInt32BE(4), bitDepth: d[8], colorType: d[9], interlace: d[12] };
}
// Rebuilds a PNG from chunk buffers, optionally inserting extra chunk buffers before the first
// chunk of a given type.
function withChunks(png, { before, insert = [], drop = [] }) {
  const out = [SIG];
  let done = false;
  for (const c of listChunks(png).chunks) {
    if (!done && c.type === before) {
      out.push(...insert);
      done = true;
    }
    if (!drop.includes(c.type)) out.push(c.raw);
  }
  return Buffer.concat(out);
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

function testFilter(ft, row, prior, bpp) {
  const out = Buffer.alloc(row.length);
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prior[i];
    const c = i >= bpp ? prior[i - bpp] : 0;
    let pred = 0;
    if (ft === 1) pred = a;
    else if (ft === 2) pred = b;
    else if (ft === 3) pred = Math.floor((a + b) / 2);
    else if (ft === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    out[i] = (row[i] - pred) & 0xff;
  }
  return out;
}

// Raw image data (filter byte + packed row, per pass). samples(x, y) returns channel values.
function pngImageData({ width, height, depth, ct, samples, interlace = 0, filter = 'cycle' }) {
  const ch = CHANNELS[ct];
  const bits = ch * depth;
  const bpp = Math.max(1, bits >> 3);
  const rows = [];
  let n = 0;
  for (const [x0, y0, dx, dy] of interlace ? ADAM7 : [[0, 0, 1, 1]]) {
    const pw = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const ph = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    if (!pw || !ph) continue;
    const rowBytes = Math.ceil((pw * bits) / 8);
    let prior = Buffer.alloc(rowBytes);
    for (let j = 0; j < ph; j++, n++) {
      const row = Buffer.alloc(rowBytes);
      for (let i = 0; i < pw; i++) {
        const s = samples(x0 + i * dx, y0 + j * dy);
        for (let c = 0; c < ch; c++) {
          if (depth === 16) row.writeUInt16BE(s[c], (i * ch + c) * 2);
          else if (depth === 8) row[i * ch + c] = s[c];
          else {
            const bit = (i * ch + c) * depth;
            row[bit >> 3] |= s[c] << (8 - depth - (bit & 7));
          }
        }
      }
      const ft = filter === 'cycle' ? n % 5 : filter;
      rows.push(Buffer.from([ft]), testFilter(ft, row, prior, bpp));
      prior = row;
    }
  }
  return Buffer.concat(rows);
}

function encodeTestPng(spec) {
  const { width, height, depth, ct, interlace = 0, palette, trns, before = [], after = [], idatSplit = 1 } = spec;
  const z = zlib.deflateSync(pngImageData(spec));
  const idat = [];
  const step = Math.ceil(z.length / idatSplit);
  for (let i = 0; i < z.length; i += step) idat.push(chunk('IDAT', z.subarray(i, i + step)));
  return Buffer.concat([
    SIG,
    ihdrChunk(width, height, depth, ct, interlace),
    ...before,
    ...(palette ? [chunk('PLTE', palette)] : []),
    ...(trns ? [chunk('tRNS', trns)] : []),
    ...idat,
    ...after,
    chunk('IEND'),
  ]);
}

// What every PNG decoder should produce, computed straight from the samples.
function referenceRGBA({ width, height, depth, ct, samples, palette, trns }) {
  const out = Buffer.alloc(width * height * 4);
  const max = (1 << depth) - 1;
  const to8 = (v) => (depth === 16 ? v >> 8 : depth === 8 ? v : (v * 255) / max);
  const key = trns && ct !== 3 ? Array.from({ length: trns.length / 2 }, (_, i) => trns.readUInt16BE(i * 2)) : null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = samples(x, y);
      const o = (y * width + x) * 4;
      if (ct === 3) {
        out.set(palette.subarray(s[0] * 3, s[0] * 3 + 3), o);
        out[o + 3] = trns && s[0] < trns.length ? trns[s[0]] : 255;
      } else if (ct === 0 || ct === 4) {
        out[o] = out[o + 1] = out[o + 2] = to8(s[0]);
        out[o + 3] = ct === 4 ? to8(s[1]) : key && s[0] === key[0] ? 0 : 255;
      } else {
        out.set([to8(s[0]), to8(s[1]), to8(s[2])], o);
        out[o + 3] = ct === 6 ? to8(s[3]) : key && s[0] === key[0] && s[1] === key[1] && s[2] === key[2] ? 0 : 255;
      }
    }
  }
  return out;
}

async function sharpRGBA(buf, animated = false) {
  const { data, info } = await sharp(buf, { animated }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, info };
}
async function sharpPages(buf) {
  return (await sharp(buf, { animated: true }).metadata()).pages || 1;
}
// sharp writes 1- and 2-channel raw input as RGB(A) unless the pipeline is told it is greyscale.
const sharpPng = (raw, width, height, channels, opts = {}) => {
  const img = sharp(raw, { raw: { width, height, channels } });
  return (channels <= 2 ? img.toColourspace('b-w') : img).png(opts).toBuffer();
};

function assertCleanPng(buf, width, height) {
  assert(buf.subarray(0, 8).equals(SIG), 'bad signature');
  const { chunks, end } = listChunks(buf);
  const types = chunks.map((c) => c.type);
  assert(end === buf.length, 'bytes after IEND');
  assert(chunks.every((c) => c.crcOk), 'output chunk with a bad CRC');
  assert(types[0] === 'IHDR' && types[types.length - 1] === 'IEND', `chunk order ${types.join(',')}`);
  const middle = types.slice(1, -1);
  assert(middle.length >= 1 && middle.every((t) => t === 'IDAT'), `unexpected chunks: ${[...new Set(middle)].join(',')}`);
  const h = chunks[0].data;
  assert(h.length === 13 && h.readUInt32BE(0) === width && h.readUInt32BE(4) === height, 'IHDR size');
  assert(h[8] === 8 && h[9] === 6 && h[10] === 0 && h[11] === 0 && h[12] === 0, `IHDR is not 8-bit RGBA non-interlaced: ${[...h.subarray(8)]}`);
  // The IDAT payload is one complete zlib stream (checked by Node's own inflate, incl. Adler-32)
  // holding exactly height rows of [filter 0..4][width * 4 bytes].
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  assert(raw.length === height * (1 + width * 4), `IDAT inflates to ${raw.length} bytes`);
  for (let y = 0; y < height; y++) assert(raw[y * (1 + width * 4)] <= 4, `row ${y} has filter type ${raw[y * (1 + width * 4)]}`);
}

async function acceptPng(name, input, { limits, reference, expect = {}, extra } = {}) {
  await check(name, async () => {
    const hdr = readIhdr(input);
    for (const [k, v] of Object.entries(expect)) assert(hdr[k] === v, `fixture has ${k}=${hdr[k]}, expected ${v}`);
    const copy = Buffer.from(input);
    const out = run(input, 'image/png', limits);
    assert(input.equals(copy), 'input buffer was modified');
    assert(out.type === 'image/png' && out.frames === 1, `type/frames ${out.type}/${out.frames}`);
    assert(out.width === hdr.width && out.height === hdr.height, 'reported dimensions');
    assert(out.inputBytes === input.length && out.outputBytes === out.buffer.length, 'reported byte counts');
    const cap = (limits && limits.maxInputBytes) || MAX_BYTES;
    assert(out.outputBytes <= cap, `output ${out.outputBytes} B exceeds ${cap} B`);
    outputSizes.push({ name, bytes: out.outputBytes });
    assertCleanPng(out.buffer, hdr.width, hdr.height);
    const [a, b] = await Promise.all([sharpRGBA(input), sharpRGBA(out.buffer)]);
    assert(a.data.equals(b.data), `RGBA differs from sharp's decode of the input (${firstDiff(a.data, b.data)})`);
    if (reference) assert(b.data.equals(reference), `RGBA differs from the reference (${firstDiff(reference, b.data)})`);
    const again = run(out.buffer, 'image/png', limits);
    assert(again.buffer.equals(out.buffer), 're-sanitizing the output is not byte-identical');
    if (extra) await extra(out);
    return `${hdr.width}x${hdr.height} depth ${hdr.bitDepth} type ${hdr.colorType}${hdr.interlace ? ' Adam7' : ''}: ${input.length} -> ${out.outputBytes} B, pixel-exact`;
  });
}

// ------------------------------------------------------------------------------------------------
// GIF helpers (an independent writer and LZW encoder; sharp/libnsgif is the independent decoder)
// ------------------------------------------------------------------------------------------------
/**
 * Reference LZW encoder, written differently from the library's: a direct (code, pixel) trie with
 * generation stamps, and a code width derived from how many codes the decoder has read since the
 * last clear. Options produce the stream shapes decoders must cope with.
 */
function lzwRef(indices, m, { clearWhenFull = true, initialClear = true, clearEvery = 0, eoi = true } = {}) {
  const CLEAR = 1 << m;
  const EOI = CLEAR + 1;
  const stamp = new Uint32Array(4096 * 256);
  const val = new Uint16Array(4096 * 256);
  let gen = 1;
  let next = EOI + 1;
  let since = 0; // codes emitted since the last clear
  const bytes = [];
  let acc = 0;
  let nb = 0;
  // The decoder has added max(0, since - 1) entries, so its next slot decides the width.
  const width = () => Math.min(12, 32 - Math.clz32(Math.min(4096, EOI + 1 + Math.max(0, since - 1))));
  const write = (code) => {
    acc |= code << nb;
    nb += width();
    while (nb >= 8) {
      bytes.push(acc & 0xff);
      acc >>>= 8;
      nb -= 8;
    }
  };
  const emit = (code) => {
    write(code);
    since++;
  };
  const emitClear = () => {
    write(CLEAR);
    since = 0;
    gen++;
    next = EOI + 1;
  };
  if (initialClear) emitClear();
  let w = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = w * 256 + k;
    if (stamp[key] === gen) {
      w = val[key];
      continue;
    }
    emit(w);
    if (next < 4096) {
      stamp[key] = gen;
      val[key] = next++;
    } else if (clearWhenFull) emitClear();
    if (clearEvery && since >= clearEvery) emitClear();
    w = k;
  }
  emit(w);
  if (eoi) emit(EOI);
  if (nb > 0) bytes.push(acc & 0xff);
  return Buffer.from(bytes);
}
function subBlocks(data) {
  const parts = [];
  for (let i = 0; i < data.length; i += 255) {
    const s = data.subarray(i, i + 255);
    parts.push(Buffer.from([s.length]), Buffer.from(s));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}
function interlaceRows(indices, w, h) {
  const out = new Uint8Array(w * h);
  let r = 0;
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < h; y += step) out.set(indices.subarray(y * w, (y + 1) * w), r++ * w);
  }
  return out;
}
const tableField = (t) => Math.log2(t.length / 3) - 1;
function makePalette(n, seed) {
  const p = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) p.set([(i * 97 + seed * 31) & 255, (i * 57 + seed * 11) & 255, (i * 13 + 100) & 255], i * 3);
  return p;
}
function indexPattern(w, h, colors, seed, noise = 0.15) {
  const r = rng(seed);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = r() < noise ? Math.floor(r() * colors) : ((x >> 2) + (y >> 2) * 3 + seed) % colors;
  }
  return out;
}
function gceBlock({ disposal = 0, delay = 0, transparentIndex = null, userInput = false, size = 4 } = {}) {
  const b = Buffer.alloc(size + 4);
  b.set([0x21, 0xf9, size, (disposal << 2) | (userInput ? 2 : 0) | (transparentIndex === null ? 0 : 1)]);
  b.writeUInt16LE(delay, 4);
  b[6] = transparentIndex === null ? 0 : transparentIndex;
  return b;
}
const appExt = (id, blocks) => Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from(id, 'latin1'), ...blocks.map((d) => Buffer.concat([Buffer.from([d.length]), Buffer.from(d)])), Buffer.from([0])]);
const loopExt = (count, id = 'NETSCAPE2.0') => appExt(id, [Buffer.from([1, count & 255, count >> 8])]);
const commentExt = (text) => Buffer.concat([Buffer.from([0x21, 0xfe]), subBlocks(Buffer.from(text))]);
const plainTextExt = (text) => Buffer.concat([Buffer.from([0x21, 0x01, 12]), Buffer.alloc(12, 1), subBlocks(Buffer.from(text))]);
// XMP-in-GIF as Adobe writes it: raw packet followed by the 258-byte "magic trailer".
const XMP_TRAILER = Buffer.from([1, ...Array.from({ length: 256 }, (_, i) => 255 - i), 0]);
const xmpExt = (xml) => Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from('XMP DataXMP', 'latin1'), Buffer.from(xml), XMP_TRAILER]);

/** frames: [{ x, y, w, h, indices (natural order), lct, interlace, gce, m, lzw, data, pre }] */
function buildGif({ version = 'GIF89a', width, height, gct = null, bg = 0, loop, loopId, pre = [], frames, post = [], trailer = true, tail }) {
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = gct ? 0x80 | 0x70 | tableField(gct) : 0;
  lsd[5] = bg;
  const out = [Buffer.from(version, 'latin1'), lsd];
  if (gct) out.push(gct);
  if (loop !== undefined) out.push(loopExt(loop, loopId));
  out.push(...pre);
  for (const f of frames) {
    out.push(...(f.pre || []));
    if (f.gce) out.push(gceBlock(f.gce));
    const d = Buffer.alloc(10);
    d[0] = 0x2c;
    [f.x || 0, f.y || 0, f.w, f.h].forEach((v, i) => d.writeUInt16LE(v, 1 + i * 2));
    d[9] = (f.lct ? 0x80 | tableField(f.lct) : 0) | (f.interlace ? 0x40 : 0);
    out.push(d);
    if (f.lct) out.push(f.lct);
    const table = f.lct || gct;
    const m = f.m !== undefined ? f.m : Math.max(2, table ? tableField(table) + 1 : 2);
    out.push(Buffer.from([m]));
    out.push(f.data || subBlocks(lzwRef(f.interlace ? interlaceRows(f.indices, f.w, f.h) : f.indices, m, f.lzw)));
  }
  out.push(...post);
  if (trailer) out.push(Buffer.from([0x3b]));
  if (tail) out.push(Buffer.from(tail));
  return Buffer.concat(out);
}

// Independent block walker, used on outputs (and to sanity-check fixtures).
function walkGif(buf) {
  const g = { version: buf.toString('latin1', 0, 6), width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), flags: buf[10], bg: buf[11], aspect: buf[12], blocks: [] };
  let p = 13 + (g.flags & 0x80 ? 3 * (2 << (g.flags & 7)) : 0);
  const skip = () => {
    while (p < buf.length && buf[p] !== 0) p += buf[p] + 1;
    p++;
  };
  while (p < buf.length) {
    const t = buf[p++];
    if (t === 0x3b) {
      g.blocks.push({ kind: 'trailer' });
      break;
    }
    if (t === 0x21) {
      const label = buf[p++];
      if (label === 0xf9) g.blocks.push({ kind: 'gce', packed: buf[p + 1], delay: buf.readUInt16LE(p + 2), ti: buf[p + 4] });
      else if (label === 0xff) g.blocks.push({ kind: 'app', id: buf.toString('latin1', p + 1, p + 12) });
      else g.blocks.push({ kind: label === 0xfe ? 'comment' : label === 0x01 ? 'plaintext' : `ext-${label}` });
      skip();
    } else if (t === 0x2c) {
      const f = buf[p + 8];
      g.blocks.push({ kind: 'image', interlaced: !!(f & 0x40), lct: f & 0x80 ? 2 << (f & 7) : 0 });
      p += 9 + (f & 0x80 ? 3 * (2 << (f & 7)) : 0) + 1;
      skip();
    } else {
      g.blocks.push({ kind: 'invalid' });
      break;
    }
  }
  g.end = p;
  return g;
}

function compareDecoded(a, b) {
  assert(a.width === b.width && a.height === b.height, 'logical screen size differs');
  assert(eqBuf(a.globalTable, b.globalTable), 'global colour table differs');
  assert(a.loopCount === b.loopCount, `loop count ${a.loopCount} vs ${b.loopCount}`);
  assert(a.frames.length === b.frames.length, `frame count ${a.frames.length} vs ${b.frames.length}`);
  a.frames.forEach((fa, i) => {
    const fb = b.frames[i];
    for (const k of ['left', 'top', 'width', 'height']) assert(fa[k] === fb[k], `frame ${i} ${k} ${fa[k]} vs ${fb[k]}`);
    assert(eqBuf(fa.localTable, fb.localTable), `frame ${i} local colour table differs`);
    assert(JSON.stringify(fa.gce) === JSON.stringify(fb.gce), `frame ${i} graphic control ${JSON.stringify(fa.gce)} vs ${JSON.stringify(fb.gce)}`);
    assert(Buffer.from(fa.indices).equals(Buffer.from(fb.indices)), `frame ${i} index stream differs (${firstDiff(fa.indices, fb.indices)})`);
  });
}

function assertCleanGif(buf, src) {
  const g = walkGif(buf);
  assert(g.version === 'GIF89a', `version ${g.version}`);
  assert(g.bg === 0 && g.aspect === 0, 'background index / aspect ratio not 0');
  assert(g.end === buf.length && g.blocks[g.blocks.length - 1].kind === 'trailer', 'trailer missing or bytes after it');
  const unexpected = g.blocks.filter((b) => !['gce', 'app', 'image', 'trailer'].includes(b.kind));
  assert(!unexpected.length, `unexpected blocks: ${unexpected.map((b) => b.kind).join(',')}`);
  const apps = g.blocks.filter((b) => b.kind === 'app');
  assert(apps.every((b) => b.id === 'NETSCAPE2.0'), `application extension kept: ${apps.map((b) => b.id).join(',')}`);
  assert(apps.length === (src.loopCount === null ? 0 : 1), 'loop extension presence does not match the input');
  for (const b of g.blocks) {
    if (b.kind === 'gce') assert((b.packed & 0xe2) === 0, 'GCE user-input or reserved bits set');
    if (b.kind === 'image') assert(!b.interlaced, 'output frame is interlaced');
  }
}

async function acceptGif(name, input, { limits, allPages = true, expectFrames, truth, forbid = [], extra } = {}) {
  await check(name, async () => {
    const copy = Buffer.from(input);
    const out = run(input, 'image/gif', limits);
    assert(input.equals(copy), 'input buffer was modified');
    const src = _internal.decodeGif(input, limits);
    const dst = _internal.decodeGif(out.buffer, limits);
    assert(out.type === 'image/gif', 'type');
    assert(out.width === src.width && out.height === src.height && out.frames === src.frames.length, 'reported size/frames');
    if (expectFrames) assert(out.frames === expectFrames, `fixture has ${out.frames} frames, expected ${expectFrames}`);
    assert(out.inputBytes === input.length && out.outputBytes === out.buffer.length, 'reported byte counts');
    const cap = (limits && limits.maxInputBytes) || MAX_BYTES;
    assert(out.outputBytes <= cap, `output ${out.outputBytes} B exceeds ${cap} B`);
    outputSizes.push({ name, bytes: out.outputBytes });
    assertCleanGif(out.buffer, src);
    // Our decoder on the input matches the ground truth the fixture was built from ...
    if (truth) truth.forEach((t, i) => assert(Buffer.from(src.frames[i].indices).equals(Buffer.from(t)), `frame ${i} decodes differently from the indices written`));
    // ... and on the output reproduces exactly the same frames, palettes, timing and loop count.
    compareDecoded(src, dst);
    const [pagesIn, pagesOut] = await Promise.all([sharpPages(input), sharpPages(out.buffer)]);
    assert(pagesIn === pagesOut && pagesOut === out.frames, `sharp pages ${pagesIn} vs ${pagesOut} (frames ${out.frames})`);
    const [a, b] = await Promise.all([sharpRGBA(input), sharpRGBA(out.buffer)]);
    assert(a.data.equals(b.data), `frame 0 RGBA differs under sharp (${firstDiff(a.data, b.data)})`);
    let pagesNote = '';
    if (allPages && out.frames > 1) {
      const [aa, bb] = await Promise.all([sharpRGBA(input, true), sharpRGBA(out.buffer, true)]);
      assert(aa.data.equals(bb.data), `composited pages differ under sharp (${firstDiff(aa.data, bb.data)})`);
      pagesNote = ', all pages equal';
    }
    for (const s of forbid) assert(!out.buffer.includes(Buffer.from(s, 'latin1')), `output still contains "${s}"`);
    const again = run(out.buffer, 'image/gif', limits);
    assert(again.buffer.equals(out.buffer), 're-sanitizing the output is not byte-identical');
    if (extra) await extra(out, src, dst);
    return `${out.width}x${out.height}, ${out.frames} frame(s), loop ${src.loopCount}: ${input.length} -> ${out.outputBytes} B, indices identical, frame 0 equal${pagesNote}`;
  });
}

// ------------------------------------------------------------------------------------------------
// Pillow fixtures (optional)
// ------------------------------------------------------------------------------------------------
const PIL_SCRIPT = String.raw`
import io, json, base64
from PIL import Image, ImageDraw
def frame(k):
    im = Image.new('RGBA', (80, 60), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([4 + k * 6, 4, 30 + k * 6, 30], fill=(255, 40 * k, 0, 255))
    d.ellipse([20, 10 + k * 4, 60, 40 + k * 4], fill=(0, 128, 255 - 50 * k, 255))
    d.line([0, 0, 79, 59], fill=(255, 255, 255, 255), width=3)
    return im
frames = [frame(k) for k in range(4)]
out = {}
b = io.BytesIO()
frames[0].save(b, 'GIF', save_all=True, append_images=frames[1:], loop=0, duration=[80, 120, 160, 200], disposal=[1, 2, 3, 1], optimize=False)
out['anim'] = b.getvalue()
b = io.BytesIO()
frames[1].convert('RGB').save(b, 'GIF', interlace=True)
out['interlaced'] = b.getvalue()
b = io.BytesIO()
frames[2].convert('RGB').save(b, 'GIF', comment=b'SECRET-PIL-COMMENT')
out['comment'] = b.getvalue()
print(json.dumps({k: base64.b64encode(v).decode() for k, v in out.items()}))
`;
function pillowFixtures() {
  try {
    const json = execFileSync('python3', ['-c', PIL_SCRIPT], { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return Object.fromEntries(Object.entries(JSON.parse(json)).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
  } catch (err) {
    return { error: String(err.message || err).split('\n')[0] };
  }
}

// ================================================================================================
// API surface
// ================================================================================================
await check('api: DEFAULT_LIMITS match the spec and are frozen', () => {
  const want = { maxInputBytes: 3 * 1024 * 1024, png: { maxWidth: 1024, maxHeight: 1024, minWidth: 16, minHeight: 16 }, gif: { maxWidth: 512, maxHeight: 512, minWidth: 16, minHeight: 16, maxFrames: 120, maxTotalPixels: 512 * 512 * 120 } };
  assert(JSON.stringify(DEFAULT_LIMITS) === JSON.stringify(want), `got ${JSON.stringify(DEFAULT_LIMITS)}`);
  assert(Object.isFrozen(DEFAULT_LIMITS) && Object.isFrozen(DEFAULT_LIMITS.png) && Object.isFrozen(DEFAULT_LIMITS.gif), 'not deeply frozen');
});
await check('api: ImageRejected extends Error with code and name', () => {
  const e = new ImageRejected('MALFORMED');
  assert(e instanceof Error && e.name === 'ImageRejected' && e.code === 'MALFORMED', 'shape');
  assertSafeMessage(e.message);
});
await check('api: library requires only Node built-ins (zlib)', () => {
  // Code only: drop block comments (the header has a usage example) and line comments.
  const src = fs.readFileSync(LIB_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert(reqs.length && reqs.every((r) => r === 'zlib'), `requires: ${reqs.join(', ')}`);
  assert(!/\bimport\s*\(|zlib\.crc32|sharp/.test(src), 'dynamic import, zlib.crc32 or sharp used in code');
  return `requires: ${[...new Set(reqs)].join(', ')}`;
});
await check('api: caller mistakes throw TypeError (not ImageRejected)', () => {
  for (const [label, fn] of [
    ['string input', () => sanitizeImage('iVBORw0KGgo=', { declaredType: 'image/png' })],
    ['null input', () => sanitizeImage(null, { declaredType: 'image/png' })],
    ['negative limit', () => sanitizeImage(Buffer.from('x'), { declaredType: 'image/png', limits: { png: { maxWidth: -1 } } })],
    ['NaN limit', () => sanitizeImage(Buffer.from('x'), { declaredType: 'image/png', limits: { maxInputBytes: NaN } })],
  ]) {
    let err = null;
    try {
      fn();
    } catch (e) {
      err = e;
    }
    assert(err instanceof TypeError, `${label}: ${err ? err.name : 'no error'}`);
  }
});

// ================================================================================================
// PNG: accepted inputs
// ================================================================================================
const r1 = rng(1);
const W5 = 512;
const rgba512 = Buffer.alloc(W5 * W5 * 4);
for (let y = 0; y < W5; y++) {
  for (let x = 0; x < W5; x++) {
    const o = (y * W5 + x) * 4;
    rgba512.set([(x ^ y) & 255, (x * 3 + (r1() * 24) | 0) & 255, (y * 2 + (r1() * 24) | 0) & 255, x < 16 ? 0 : (x + y) & 255 | 1], o);
  }
}
const pngRgba512 = await sharpPng(rgba512, W5, W5, 4);
await acceptPng('png: RGBA 512x512 (sharp)', pngRgba512, { expect: { colorType: 6, bitDepth: 8, width: 512, height: 512 } });

const rgbRaw = Buffer.alloc(300 * 200 * 3);
for (let i = 0; i < rgbRaw.length; i++) rgbRaw[i] = ((i * 7) ^ (i >> 5)) & 255;
const pngRgb = await sharpPng(rgbRaw, 300, 200, 3);
await acceptPng('png: RGB 8-bit (sharp)', pngRgb, { expect: { colorType: 2, bitDepth: 8 } });

const grayRaw = Buffer.alloc(257 * 131);
for (let i = 0; i < grayRaw.length; i++) grayRaw[i] = ((i % 257) + ((i / 257) | 0) * 2) & 255;
await acceptPng('png: grayscale 8-bit (sharp)', await sharpPng(grayRaw, 257, 131, 1), { expect: { colorType: 0, bitDepth: 8 } });

const gaRaw = Buffer.alloc(120 * 90 * 2);
for (let i = 0; i < gaRaw.length; i += 2) gaRaw.set([(i >> 3) & 255, (i * 13) & 255], i);
await acceptPng('png: grayscale + alpha 8-bit (sharp)', await sharpPng(gaRaw, 120, 90, 2), { expect: { colorType: 4, bitDepth: 8 } });

const palSrc = Buffer.alloc(160 * 120 * 4);
for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) palSrc.set([x < 80 ? 220 : 30, (y * 2) & 255, x & 0xf0, (x >> 5) % 3 === 0 ? 0 : (x >> 5) % 3 === 1 ? 128 : 255], (y * 160 + x) * 4);
const pngPalSharp = await sharpPng(palSrc, 160, 120, 4, { palette: true, colours: 64 });
await acceptPng('png: palette + tRNS (sharp, libimagequant)', pngPalSharp, {
  expect: { colorType: 3 },
  extra: () => assert(listChunks(pngPalSharp).chunks.some((c) => c.type === 'tRNS'), 'fixture has no tRNS'),
});
await acceptPng('png: Adam7 interlaced RGBA 301x203 (sharp progressive)', await sharpPng(rgba512.subarray(0, 301 * 203 * 4), 301, 203, 4, { progressive: true }), { expect: { colorType: 6, interlace: 1 } });
await acceptPng('png: Adam7 interlaced palette (sharp progressive)', await sharpPng(palSrc, 160, 120, 4, { palette: true, colours: 16, progressive: true }), { expect: { colorType: 3, interlace: 1 } });

// Synthetic PNGs from the independent writer: every bit depth / colour type, all five filters
// (rows cycle through filter types 0..4), tRNS variants and Adam7 at awkward sizes.
const pal = (n, seed) => makePalette(n, seed);
const u16 = (...vals) => {
  const b = Buffer.alloc(vals.length * 2);
  vals.forEach((v, i) => b.writeUInt16BE(v, i * 2));
  return b;
};
const TINY = { png: { minWidth: 1, minHeight: 1 } };
const synthetic = [
  { name: '16-bit RGB', width: 40, height: 30, depth: 16, ct: 2, samples: (x, y) => [(x * 1500 + y) & 0xffff, (65535 - x * 1000 - y * 7) & 0xffff, (x * y * 37) & 0xffff] },
  { name: '16-bit RGBA', width: 33, height: 20, depth: 16, ct: 6, samples: (x, y) => [x * 1985, y * 3001, (x * y * 91) & 0xffff, (x * 2000 + 300) & 0xffff] },
  { name: '16-bit RGB + tRNS', width: 32, height: 16, depth: 16, ct: 2, trns: u16(0x1234, 0x5678, 0x9abc), samples: (x) => (x % 3 === 0 ? [0x1234, 0x5678, 0x9abc] : x % 3 === 1 ? [0x1234, 0x5678, 0x9abd] : [x * 999, 1, 2]) },
  { name: '16-bit grey + tRNS (full-precision key)', width: 24, height: 17, depth: 16, ct: 0, trns: u16(0x1235), samples: (x, y) => [0x1200 + ((x + y) % 8)] },
  { name: '16-bit grey + alpha', width: 19, height: 23, depth: 16, ct: 4, samples: (x, y) => [x * 3000, 65535 - y * 2500] },
  { name: '1-bit grey', width: 37, height: 21, depth: 1, ct: 0, samples: (x, y) => [(x ^ y) & 1] },
  { name: '2-bit grey + tRNS', width: 29, height: 18, depth: 2, ct: 0, trns: u16(2), samples: (x, y) => [(x + y) & 3] },
  { name: '4-bit grey', width: 31, height: 17, depth: 4, ct: 0, samples: (x, y) => [(x * 3 + y) & 15] },
  { name: '8-bit grey + tRNS', width: 20, height: 20, depth: 8, ct: 0, trns: u16(77), samples: (x, y) => [(x * 11 + y) % 90] },
  { name: '1-bit palette', width: 45, height: 16, depth: 1, ct: 3, palette: pal(2, 1), samples: (x, y) => [((x >> 1) ^ y) & 1] },
  { name: '2-bit palette + partial tRNS', width: 26, height: 22, depth: 2, ct: 3, palette: pal(4, 2), trns: Buffer.from([0, 128]), samples: (x, y) => [(x + 2 * y) & 3] },
  { name: '4-bit palette (11 entries)', width: 35, height: 19, depth: 4, ct: 3, palette: pal(11, 3), samples: (x, y) => [(x * 5 + y) % 11] },
  { name: '8-bit palette + tRNS', width: 64, height: 48, depth: 8, ct: 3, palette: pal(200, 4), trns: Buffer.from(Array.from({ length: 150 }, (_, i) => (i * 7) & 255)), samples: (x, y) => [(x * 3 + y * 5) % 200] },
  { name: '8-bit RGB + tRNS', width: 30, height: 20, depth: 8, ct: 2, trns: u16(10, 20, 30), samples: (x, y) => ((x + y) % 4 === 0 ? [10, 20, 30] : [x * 8, y * 12, 30]) },
  { name: 'Adam7 1-bit grey 33x17', width: 33, height: 17, depth: 1, ct: 0, interlace: 1, samples: (x, y) => [((x * y) >> 2) & 1] },
  { name: 'Adam7 4-bit palette + tRNS 37x21', width: 37, height: 21, depth: 4, ct: 3, interlace: 1, palette: pal(16, 5), trns: Buffer.from([0, 50, 100, 150, 200]), samples: (x, y) => [(x + y * 3) & 15] },
  { name: 'Adam7 16-bit RGBA 23x19', width: 23, height: 19, depth: 16, ct: 6, interlace: 1, samples: (x, y) => [x * 2800, y * 3400, (x ^ y) * 2000, 65535 - x * 1000] },
  { name: 'Adam7 8-bit grey + alpha 17x16', width: 17, height: 16, depth: 8, ct: 4, interlace: 1, samples: (x, y) => [x * 15, 255 - y * 15] },
  { name: 'Adam7 2-bit grey 16x29', width: 16, height: 29, depth: 2, ct: 0, interlace: 1, samples: (x, y) => [(x + y) & 3] },
  { name: 'RGBA split over 9 IDAT chunks', width: 48, height: 40, depth: 8, ct: 6, idatSplit: 9, samples: (x, y) => [x * 5, y * 6, (x * y) & 255, 200] },
  { name: 'all rows filter 4 (Paeth), RGB', width: 50, height: 30, depth: 8, ct: 2, filter: 4, samples: (x, y) => [x * 5, (y * 7) & 255, (x + y) * 2] },
];
for (const s of synthetic) {
  await acceptPng(`png: ${s.name}`, encodeTestPng(s), { reference: referenceRGBA(s), expect: { bitDepth: s.depth, colorType: s.ct, interlace: s.interlace || 0 } });
}
await check('png: tiny images incl. empty Adam7 passes (1x1..5x5, limits override)', async () => {
  const sizes = [[1, 1], [2, 1], [1, 3], [3, 2], [4, 4], [5, 5], [8, 1], [1, 9]];
  for (const [w, h] of sizes) {
    for (const [depth, ct] of [[1, 0], [8, 6], [16, 2], [2, 3]]) {
      for (const interlace of [0, 1]) {
        const spec = { width: w, height: h, depth, ct, interlace, palette: ct === 3 ? pal(4, 9) : undefined, samples: (x, y) => Array.from({ length: CHANNELS[ct] }, (_, c) => (x * 7 + y * 3 + c) % (ct === 3 ? 4 : 1 << Math.min(depth, 8))) };
        const input = encodeTestPng(spec);
        const out = run(input, 'image/png', TINY);
        const got = (await sharpRGBA(out.buffer)).data;
        assert(got.equals(referenceRGBA(spec)), `${w}x${h} depth ${depth} type ${ct} interlace ${interlace}: ${firstDiff(referenceRGBA(spec), got)}`);
        assertCleanPng(out.buffer, w, h);
      }
    }
  }
  return `${sizes.length * 8} images pixel-exact`;
});

// Metadata chunks must not survive (text, EXIF, XMP in iTXt, private ancillary chunks).
const metaChunks = [
  chunk('tEXt', Buffer.from('Comment\0SECRET-TEXT <script>alert(1)</script>', 'latin1')),
  chunk('zTXt', Buffer.concat([Buffer.from('Software\0\0', 'latin1'), zlib.deflateSync(Buffer.from('SECRET-ZTXT'))])),
  chunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>SECRET-ITXT</x:xmpmeta>', 'latin1')),
  chunk('eXIf', Buffer.concat([Buffer.from('MM\0*\0\0\0\x08', 'latin1'), Buffer.from('SECRET-EXIF-GPS-51.5N')])),
  chunk('pHYs', Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1])),
  chunk('tIME', Buffer.from([0x07, 0xea, 9, 23, 12, 0, 0])),
  chunk('prVt', Buffer.from('SECRET-PRIVATE-ANCILLARY')),
];
const pngMeta = withChunks(withChunks(pngRgb, { before: 'IDAT', insert: metaChunks }), { before: 'IEND', insert: [chunk('tEXt', Buffer.from('Author\0SECRET-AFTER-IDAT', 'latin1'))] });
await acceptPng('png: tEXt/zTXt/iTXt/eXIf/pHYs/tIME/private chunks are dropped', pngMeta, {
  extra: (out) => {
    assert(listChunks(pngMeta).chunks.filter((c) => ['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(c.type)).length === 5, 'fixture chunks missing');
    for (const s of ['SECRET', 'tEXt', 'zTXt', 'iTXt', 'eXIf', 'pHYs', 'tIME', 'prVt', 'xmpmeta']) assert(!out.buffer.includes(Buffer.from(s)), `output contains "${s}"`);
  },
});

// APNG: the default image (IDAT) is kept, animation chunks are dropped.
{
  const frameA = { width: 64, height: 48, depth: 8, ct: 6, samples: (x, y) => [x * 4, y * 5, 128, 255] };
  const frameB = { width: 32, height: 24, depth: 8, ct: 6, samples: (x, y) => [255, x * 8, y * 10, 200] };
  const fctl = (seq, w, h, x, y) => {
    const d = Buffer.alloc(26);
    d.writeUInt32BE(seq, 0);
    d.writeUInt32BE(w, 4);
    d.writeUInt32BE(h, 8);
    d.writeUInt32BE(x, 12);
    d.writeUInt32BE(y, 16);
    d.writeUInt16BE(1, 20);
    d.writeUInt16BE(10, 22);
    return chunk('fcTL', d);
  };
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(2, 0);
  const fdatData = Buffer.concat([Buffer.from([0, 0, 0, 2]), zlib.deflateSync(pngImageData(frameB))]);
  const apng = Buffer.concat([SIG, ihdrChunk(64, 48, 8, 6), chunk('acTL', actl), fctl(0, 64, 48, 0, 0), chunk('IDAT', zlib.deflateSync(pngImageData(frameA))), fctl(1, 32, 24, 8, 8), chunk('fdAT', fdatData), chunk('IEND')]);
  await acceptPng('png: APNG input becomes a static PNG of the default image', apng, {
    reference: referenceRGBA(frameA),
    extra: async (out) => {
      for (const t of ['acTL', 'fcTL', 'fdAT']) assert(!out.buffer.includes(Buffer.from(t)), `output contains ${t}`);
      assert((await sharpPages(out.buffer)) === 1, 'output has more than one page');
    },
  });
}

// Exactly the expected amount of image data is fine (positive control for the bomb checks).
const BOMB_W = 1024;
const BOMB_EXPECTED = BOMB_W * (1 + BOMB_W * 4);
const bombPng = (len) => Buffer.concat([SIG, ihdrChunk(BOMB_W, BOMB_W, 8, 6), chunk('IDAT', zlib.deflateSync(Buffer.alloc(len), { level: 9 })), chunk('IEND')]);
await acceptPng('png: 1024x1024 RGBA whose IDAT inflates to exactly the expected size', bombPng(BOMB_EXPECTED));

// Performance: a noisy 1024x1024 RGBA PNG (the hardest accepted PNG) must take < 2 s.
{
  const W = 1024;
  const raw = Buffer.alloc(W * W * 4);
  const r = rng(42);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      raw.set([Math.min(255, (x >> 2) + ((r() * 8) | 0)), Math.min(255, (y >> 2) + ((r() * 8) | 0)), Math.min(255, ((x + y) >> 3) + ((r() * 8) | 0)), r() < 0.5 ? 255 : 191], o);
    }
  }
  const noisy = await sharpPng(raw, W, W, 4);
  await check('perf: 1024x1024 noisy RGBA PNG sanitizes in < 2 s', async () => {
    assert(noisy.length <= MAX_BYTES, `fixture is ${noisy.length} B, over the input cap`);
    const { value: out, ms } = timeIt(() => run(noisy, 'image/png'));
    timings.png1024NoisyMs = Math.round(ms);
    assert(ms < 2000, `took ${ms.toFixed(0)} ms`);
    assert(out.outputBytes <= MAX_BYTES, `output ${out.outputBytes} B over the cap`);
    outputSizes.push({ name: 'perf: 1024x1024 noisy RGBA PNG', bytes: out.outputBytes });
    const [a, b] = await Promise.all([sharpRGBA(noisy), sharpRGBA(out.buffer)]);
    assert(a.data.equals(b.data), `pixels differ (${firstDiff(a.data, b.data)})`);
    return `sanitized in ${ms.toFixed(0)} ms (${(noisy.length / 1048576).toFixed(2)} MiB -> ${(out.outputBytes / 1048576).toFixed(2)} MiB), pixel-exact`;
  });
  // Random 0/255 pixels are zlib level 9's worst case (every hash chain is 4096 long; a plain
  // deflateSync(level 9) of this image takes 5-15 s). The time-bounded deflate must keep it < 2 s.
  const rb = rng(4242);
  const binary = Buffer.alloc(W * W * 4);
  for (let i = 0; i < binary.length; i++) binary[i] = rb() < 0.5 ? 0 : 255;
  const hostile = await sharpPng(binary, W, W, 4);
  await check('perf: 1024x1024 random 0/255 noise PNG (zlib level-9 worst case) sanitizes in < 2 s', async () => {
    assert(hostile.length <= MAX_BYTES, `fixture is ${hostile.length} B`);
    const { value: out, ms } = timeIt(() => run(hostile, 'image/png'));
    timings.png1024BinaryNoiseMs = Math.round(ms);
    assert(ms < 2000, `took ${ms.toFixed(0)} ms`);
    assert(out.outputBytes <= MAX_BYTES, `output ${out.outputBytes} B over the cap`);
    outputSizes.push({ name: 'perf: 1024x1024 binary noise PNG', bytes: out.outputBytes });
    assertCleanPng(out.buffer, W, W);
    const [a, b] = await Promise.all([sharpRGBA(hostile), sharpRGBA(out.buffer)]);
    assert(a.data.equals(b.data), `pixels differ (${firstDiff(a.data, b.data)})`);
    return `sanitized in ${ms.toFixed(0)} ms (${(hostile.length / 1048576).toFixed(2)} MiB -> ${(out.outputBytes / 1048576).toFixed(2)} MiB), pixel-exact`;
  });
}

// ================================================================================================
// PNG: rejected inputs
// ================================================================================================
const basePng = await sharpPng(rgbRaw.subarray(0, 64 * 64 * 3), 64, 64, 3);
const baseChunks = listChunks(basePng).chunks;
const idatIdx = baseChunks.findIndex((c) => c.type === 'IDAT');
const rawChunks = (list) => Buffer.concat([SIG, ...list]);

await expectReject('png: polyglot (HTML after IEND)', Buffer.concat([basePng, Buffer.from('<html><script>alert(document.cookie)</script></html>')]), 'image/png', 'MALFORMED');
await expectReject('png: another chunk after IEND', Buffer.concat([basePng, chunk('tEXt', Buffer.from('a\0b'))]), 'image/png', 'MALFORMED');
{
  const r = rng(7);
  await expectReject('png: valid signature followed by garbage', Buffer.concat([SIG, Buffer.from(Array.from({ length: 4096 }, () => (r() * 256) | 0))]), 'image/png', 'MALFORMED');
}
{
  const bad = Buffer.from(basePng);
  bad[bad.indexOf(Buffer.from('IDAT')) + 20] ^= 0x40; // flip a bit inside the IDAT payload
  await expectReject('png: corrupted IDAT byte (CRC mismatch)', bad, 'image/png', 'MALFORMED');
  await expectReject('png: bad CRC on an ancillary tEXt chunk', withChunks(basePng, { before: 'IDAT', insert: [chunk('tEXt', Buffer.from('k\0v'), { badCrc: true })] }), 'image/png', 'MALFORMED');
  await expectReject('png: bad CRC on IHDR', rawChunks([chunk('IHDR', baseChunks[0].data, { badCrc: true }), ...baseChunks.slice(1).map((c) => c.raw)]), 'image/png', 'MALFORMED');
}
await expectReject('png: unknown critical chunk', withChunks(basePng, { before: 'IDAT', insert: [chunk('XYZW', Buffer.from('must understand'))] }), 'image/png', 'MALFORMED');
await expectReject('png: Apple CgBI chunk before IHDR', rawChunks([chunk('CgBI', Buffer.from([0x50, 0, 0x20, 0x06])), ...baseChunks.map((c) => c.raw)]), 'image/png', 'MALFORMED');
await expectReject('png: IHDR not first', rawChunks([chunk('tEXt', Buffer.from('a\0b')), ...baseChunks.map((c) => c.raw)]), 'image/png', 'MALFORMED');
await expectReject('png: non-letter chunk type', withChunks(basePng, { before: 'IDAT', insert: [chunk('te1t', Buffer.from('x'))] }), 'image/png', 'MALFORMED');
{
  const z = baseChunks[idatIdx].data;
  const half = Math.floor(z.length / 2);
  const split = [...baseChunks.slice(0, idatIdx).map((c) => c.raw), chunk('IDAT', z.subarray(0, half)), chunk('tEXt', Buffer.from('a\0b')), chunk('IDAT', z.subarray(half)), chunk('IEND')];
  await expectReject('png: IDAT chunks not consecutive', rawChunks(split), 'image/png', 'MALFORMED');
  await expectReject('png: truncated zlib stream', rawChunks([...baseChunks.slice(0, idatIdx).map((c) => c.raw), chunk('IDAT', z.subarray(0, half)), chunk('IEND')]), 'image/png', 'MALFORMED');
}
await expectReject('png: missing IEND', basePng.subarray(0, basePng.length - 12), 'image/png', 'MALFORMED');
await expectReject('png: chunk length runs past end of file', Buffer.concat([basePng.subarray(0, 33), Buffer.from([0x7f, 0, 0, 0]), Buffer.from('IDAT'), Buffer.alloc(40)]), 'image/png', 'MALFORMED');
{
  const idx = { width: 20, height: 20, depth: 8, ct: 3, samples: (x) => [x % 4] };
  await expectReject('png: palette image without PLTE', encodeTestPng(idx), 'image/png', 'MALFORMED');
  await expectReject('png: palette index outside PLTE', encodeTestPng({ ...idx, palette: pal(4, 1), samples: (x) => [x % 6] }), 'image/png', 'MALFORMED');
  await expectReject('png: tRNS longer than PLTE', encodeTestPng({ ...idx, palette: pal(4, 1), trns: Buffer.alloc(5, 9) }), 'image/png', 'MALFORMED');
  await expectReject('png: tRNS on an RGBA image', encodeTestPng({ width: 20, height: 20, depth: 8, ct: 6, trns: u16(1, 2, 3), samples: () => [1, 2, 3, 4] }), 'image/png', 'MALFORMED');
  await expectReject('png: PLTE in a greyscale image', encodeTestPng({ width: 20, height: 20, depth: 8, ct: 0, palette: pal(4, 1), samples: () => [9] }), 'image/png', 'MALFORMED');
  await expectReject('png: grey tRNS value beyond the bit depth', encodeTestPng({ width: 20, height: 20, depth: 2, ct: 0, trns: u16(4), samples: () => [1] }), 'image/png', 'MALFORMED');
}
{
  const body = zlib.deflateSync(Buffer.alloc(20 * (1 + 20 * 3)));
  const hdr = (depth, ct, interlace = 0, compression = 0, filter = 0, w = 20) => rawChunks([ihdrChunk(w, 20, depth, ct, interlace, compression, filter), chunk('IDAT', body), chunk('IEND')]);
  await expectReject('png: invalid IHDR (RGB at 4 bits)', hdr(4, 2), 'image/png', 'MALFORMED');
  await expectReject('png: invalid IHDR (colour type 5)', hdr(8, 5), 'image/png', 'MALFORMED');
  await expectReject('png: invalid IHDR (interlace method 2)', hdr(8, 2, 2), 'image/png', 'MALFORMED');
  await expectReject('png: invalid IHDR (compression method 1)', hdr(8, 2, 0, 1), 'image/png', 'MALFORMED');
  await expectReject('png: invalid IHDR (width 0)', hdr(8, 2, 0, 0, 0, 0), 'image/png', 'MALFORMED');
  const f5 = Buffer.alloc(20 * 61);
  f5[61 * 3] = 5; // row 3 uses filter type 5
  await expectReject('png: invalid filter type 5', rawChunks([ihdrChunk(20, 20, 8, 2), chunk('IDAT', zlib.deflateSync(f5)), chunk('IEND')]), 'image/png', 'MALFORMED');
}
{
  // 4096x4096 RGBA with 64 MiB of real (zero) image data behind it: rejected on IHDR alone.
  const huge = Buffer.concat([SIG, ihdrChunk(4096, 4096, 8, 6), chunk('IDAT', zlib.deflateSync(Buffer.alloc(4096 * (1 + 4096 * 4)), { level: 1 })), chunk('IEND')]);
  await expectReject('png: IHDR 4096x4096 rejected fast, before inflating', huge, 'image/png', 'TOO_LARGE_DIMENSIONS', { maxMs: 50 });
  await expectReject('png: IHDR 4096x4096 + garbage IDAT still reports dimensions (no inflate happened)', rawChunks([ihdrChunk(4096, 4096, 8, 6), chunk('IDAT', Buffer.from('not zlib at all')), chunk('IEND')]), 'image/png', 'TOO_LARGE_DIMENSIONS', { maxMs: 50 });
  await expectReject('png: 1025x16 is too wide', encodeTestPng({ width: 1025, height: 16, depth: 1, ct: 0, samples: () => [0] }), 'image/png', 'TOO_LARGE_DIMENSIONS');
  await expectReject('png: 8x8 is too small', encodeTestPng({ width: 8, height: 8, depth: 8, ct: 6, samples: () => [1, 2, 3, 255] }), 'image/png', 'TOO_SMALL_DIMENSIONS');
  await expectReject('png: 16x15 is too small', encodeTestPng({ width: 16, height: 15, depth: 8, ct: 0, samples: () => [1] }), 'image/png', 'TOO_SMALL_DIMENSIONS');
}
await expectReject('png: decompression bomb (IDAT inflates to expected + 4 MiB)', bombPng(BOMB_EXPECTED + 4 * 1048576), 'image/png', 'DECOMPRESSION_LIMIT', { maxMs: 500 });
await expectReject('png: IDAT inflates to expected + 1 byte', bombPng(BOMB_EXPECTED + 1), 'image/png', 'DECOMPRESSION_LIMIT');
await expectReject('png: IDAT inflates to 1 byte less than expected', bombPng(BOMB_EXPECTED - 1), 'image/png', 'MALFORMED');
{
  const noise = Buffer.alloc(1024 * 1024 * 4);
  const r = rng(99);
  for (let i = 0; i < noise.length; i++) noise[i] = (r() * 256) | 0;
  const tooBig = await sharpPng(noise, 1024, 1024, 4);
  await expectReject(`png: real ${(tooBig.length / 1048576).toFixed(2)} MiB PNG is over the 3 MiB input cap`, tooBig, 'image/png', 'TOO_LARGE_BYTES', { maxMs: 50 });
  const exact = Buffer.concat([basePng, Buffer.alloc(MAX_BYTES - basePng.length)]);
  await expectReject('png: exactly 3 MiB is not TOO_LARGE_BYTES (trailing junk -> MALFORMED)', exact, 'image/png', 'MALFORMED');
}
{
  // Re-encoding may grow a file (1-bit -> RGBA): the pinned output obeys the same byte cap.
  const bits = { width: 256, height: 256, depth: 1, ct: 0, samples: (x, y) => [(((x * 7919) ^ (y * 104729)) >> 3) & 1] };
  const small = encodeTestPng(bits);
  await check('png: output larger than the cap is rejected (TOO_LARGE_BYTES)', () => {
    const grown = run(small, 'image/png').outputBytes;
    assert(grown > small.length, `fixture does not grow (${small.length} -> ${grown})`);
    let err = null;
    try {
      run(small, 'image/png', { maxInputBytes: small.length });
    } catch (e) {
      err = e;
    }
    assert(err instanceof ImageRejected && err.code === 'TOO_LARGE_BYTES', `got ${err ? err.code : 'accepted'}`);
    assertSafeMessage(err.message);
    return `input ${small.length} B -> output ${grown} B; with cap ${small.length} B: "${err.message}"`;
  });
}

// ================================================================================================
// Type detection
// ================================================================================================
const jpeg = await sharp(rgbRaw, { raw: { width: 300, height: 200, channels: 3 } }).jpeg().toBuffer();
const webp = await sharp(rgbRaw, { raw: { width: 300, height: 200, channels: 3 } }).webp().toBuffer();
const gifSharp = await sharp(rgbRaw, { raw: { width: 300, height: 200, channels: 3 } }).gif().toBuffer();
await expectReject('type: PNG declared as image/gif', pngRgb, 'image/gif', 'TYPE_MISMATCH');
await expectReject('type: GIF declared as image/png', gifSharp, 'image/png', 'TYPE_MISMATCH');
await expectReject('type: PNG declared as image/jpeg', pngRgb, 'image/jpeg', 'TYPE_MISMATCH');
await expectReject('type: PNG with no declared type', pngRgb, undefined, 'TYPE_MISMATCH');
await expectReject('type: JPEG (sharp) declared as image/png', jpeg, 'image/png', 'UNSUPPORTED_FORMAT');
await expectReject('type: JPEG (sharp) declared as image/jpeg', jpeg, 'image/jpeg', 'UNSUPPORTED_FORMAT');
await expectReject('type: WebP (sharp)', webp, 'image/png', 'UNSUPPORTED_FORMAT');
await expectReject('type: HTML file', Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>'), 'image/png', 'UNSUPPORTED_FORMAT');
await expectReject('type: SVG file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/gif', 'UNSUPPORTED_FORMAT');
await expectReject('type: empty buffer', Buffer.alloc(0), 'image/png', 'UNSUPPORTED_FORMAT');
await expectReject('type: random bytes', Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 131 + 7) & 255)), 'image/png', 'UNSUPPORTED_FORMAT');
await expectReject('type: truncated PNG signature', SIG.subarray(0, 4), 'image/png', 'UNSUPPORTED_FORMAT');
await expectReject('type: GIF88a is not a GIF version', Buffer.concat([Buffer.from('GIF88a'), gifSharp.subarray(6)]), 'image/gif', 'UNSUPPORTED_FORMAT');
await check('type: declaredType is case/whitespace-insensitive; Uint8Array input works', () => {
  const out = sanitizeImage(new Uint8Array(pngRgb), { declaredType: ' Image/PNG ' });
  assert(out.type === 'image/png' && out.width === 300, 'not accepted');
});

// ================================================================================================
// GIF: accepted inputs
// ================================================================================================
await acceptGif('gif: static GIF (sharp/cgif)', gifSharp, { expectFrames: 1 });
{
  const rgbaSmall = Buffer.alloc(96 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) rgbaSmall.set([x * 2, y * 4, 90, (x >> 3) % 2 ? 255 : 0], (y * 96 + x) * 4);
  await acceptGif('gif: static GIF with transparency (sharp/cgif)', await sharp(rgbaSmall, { raw: { width: 96, height: 64, channels: 4 } }).gif().toBuffer(), { expectFrames: 1 });
}

const GW = 64;
const GH = 48;
const gct16 = makePalette(16, 1);
const lct8 = makePalette(8, 2);
const frames4 = [
  { x: 0, y: 0, w: 64, h: 48, indices: indexPattern(64, 48, 16, 0), gce: { disposal: 1, delay: 10 } },
  { x: 8, y: 6, w: 32, h: 20, lct: lct8, indices: indexPattern(32, 20, 8, 1, 0.3), gce: { disposal: 2, delay: 25, transparentIndex: 3 }, lzw: { clearEvery: 50 } },
  { x: 20, y: 10, w: 40, h: 30, indices: indexPattern(40, 30, 16, 2), gce: { disposal: 3, delay: 40, transparentIndex: 0, userInput: true }, lzw: { initialClear: false } },
  { x: 0, y: 0, w: 64, h: 48, interlace: true, indices: indexPattern(64, 48, 16, 3) },
];
const animOwn = buildGif({ width: GW, height: GH, gct: gct16, loop: 7, frames: frames4 });
await acceptGif('gif: animated, 4 frames, local table, transparency, disposal 1/2/3, loop 7', animOwn, {
  expectFrames: 4,
  truth: frames4.map((f) => f.indices),
  extra: (out, src) => {
    assert(src.loopCount === 7 && src.frames[1].localTable && !src.frames[0].localTable, 'fixture shape');
    const g = walkGif(out.buffer).blocks.filter((b) => b.kind === 'gce');
    assert(g.length === 3 && g.every((b) => (b.packed & 2) === 0), 'user-input flag not cleared');
    assert(JSON.stringify(src.frames.map((f) => f.gce && f.gce.disposal)) === '[1,2,3,null]', 'disposal methods');
  },
});
await acceptGif('gif: background index 5 is rewritten to 0 (frame 0 + streams compared)', buildGif({ width: GW, height: GH, gct: gct16, bg: 5, frames: frames4.slice(0, 3) }), { allPages: false, expectFrames: 3 });
{
  const idx = indexPattern(16, 37, 4, 5);
  await acceptGif('gif: interlaced frame, odd height (own writer)', buildGif({ width: 16, height: 37, gct: makePalette(4, 3), frames: [{ w: 16, h: 37, interlace: true, indices: idx }] }), { truth: [idx] });
}
{
  const r = rng(11);
  const noisy = Uint8Array.from({ length: 128 * 128 }, () => (r() * 256) | 0);
  await acceptGif('gif: LZW table fills without a clear code (deferred clear)', buildGif({ width: 128, height: 128, gct: makePalette(256, 4), frames: [{ w: 128, h: 128, indices: noisy, lzw: { clearWhenFull: false } }] }), { truth: [noisy] });
  const few = indexPattern(40, 30, 4, 6);
  await acceptGif('gif: min code size 8 with a 4-colour table (as Pillow writes)', buildGif({ width: 40, height: 30, gct: makePalette(4, 5), frames: [{ w: 40, h: 30, m: 8, indices: few }] }), { truth: [few] });
  await acceptGif('gif: GIF87a without extensions', buildGif({ version: 'GIF87a', width: 40, height: 30, gct: makePalette(4, 5), frames: [{ w: 40, h: 30, indices: few }] }), { truth: [few] });
  await acceptGif('gif: ANIMEXTS1.0 loop count kept (written as NETSCAPE2.0)', buildGif({ width: 40, height: 30, gct: makePalette(4, 5), loop: 3, loopId: 'ANIMEXTS1.0', frames: [{ w: 40, h: 30, indices: few }, { w: 20, h: 10, indices: few.subarray(0, 200), gce: { delay: 5 } }] }), {
    extra: (out) => assert(_internal.decodeGif(out.buffer).loopCount === 3 && out.buffer.includes(Buffer.from('NETSCAPE2.0')), 'loop count not kept'),
  });
}
{
  // Comment, XMP (with the Adobe magic trailer), a vendor application extension, an unknown
  // extension label and a plain-text block (whose GCE must not leak onto the next image).
  const xmp = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description>SECRET-XMP-PAYLOAD GPS 51.5N</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const f0 = indexPattern(48, 32, 16, 8);
  const f1 = indexPattern(48, 32, 16, 9);
  const meta = buildGif({
    width: 48,
    height: 32,
    gct: gct16,
    loop: 0,
    pre: [commentExt('SECRET-COMMENT-TEXT <script>alert(1)</script>'), xmpExt(xmp), appExt('EVILAPP11.0', [Buffer.from('SECRET-APP-PAYLOAD')]), Buffer.concat([Buffer.from([0x21, 0x99]), subBlocks(Buffer.from('SECRET-UNKNOWN-EXT'))])],
    frames: [
      { w: 48, h: 32, indices: f0, gce: { delay: 20 } },
      { w: 48, h: 32, indices: f1, pre: [gceBlock({ delay: 0 }), plainTextExt('SECRET-PLAIN-TEXT'), commentExt('SECRET-COMMENT-2')] },
    ],
    post: [commentExt('SECRET-TRAILING-COMMENT')],
  });
  await acceptGif('gif: comment, XMP, vendor app extension, plain text and unknown extension are dropped', meta, {
    truth: [f0, f1],
    forbid: ['SECRET', 'XMP', 'xmpmeta', 'EVILAPP', 'script'],
    extra: (out, src) => {
      assert(meta.includes(Buffer.from('XMP DataXMP')) && meta.includes(Buffer.from('SECRET-COMMENT-TEXT')), 'fixture shape');
      assert(src.frames[1].gce === null, 'GCE preceding the plain-text block leaked onto the next image');
    },
  });
}

const pil = pillowFixtures();
if (pil.error) {
  for (const n of ['animated', 'interlaced', 'comment']) skip(`gif: Pillow ${n} GIF`, `Pillow unavailable: ${pil.error}`);
} else {
  await acceptGif('gif: Pillow animated (4 frames, loop=0, per-frame palettes, transparency, disposal 1/2/3)', pil.anim, {
    expectFrames: 4,
    extra: (out, src) => {
      assert(src.loopCount === 0 && src.frames.some((f) => f.localTable) && src.frames.some((f) => f.gce && f.gce.transparentIndex !== null), 'fixture shape');
    },
  });
  await acceptGif('gif: Pillow interlaced', pil.interlaced, { extra: () => assert(walkGif(pil.interlaced).blocks.some((b) => b.kind === 'image' && b.interlaced), 'fixture is not interlaced') });
  await acceptGif('gif: Pillow comment is dropped', pil.comment, { forbid: ['SECRET-PIL-COMMENT'], extra: () => assert(pil.comment.includes(Buffer.from('SECRET-PIL-COMMENT')), 'fixture has no comment') });
}

// Performance at the limits: 120 frames of 512x512 (maxTotalPixels exactly).
{
  const frames = [];
  const gct = makePalette(64, 7);
  for (let k = 0; k < 120; k++) {
    const px = new Uint8Array(512 * 512);
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const inBox = x >= k * 3 && x < k * 3 + 96 && y >= 100 + k && y < 196 + k;
        px[y * 512 + x] = inBox ? 40 + ((x ^ y) & 7) : ((x >> 5) + (y >> 5) + k) % 32;
      }
    }
    frames.push({ w: 512, h: 512, indices: px, gce: { delay: 4, disposal: 1 } });
  }
  const maxGif = buildGif({ width: 512, height: 512, gct, loop: 0, frames });
  await check('perf: 512x512 x 120-frame GIF (limits at maximum)', async () => {
    assert(maxGif.length <= MAX_BYTES, `fixture is ${maxGif.length} B`);
    const { value: out, ms } = timeIt(() => run(maxGif, 'image/gif'));
    timings.gif512x120Ms = Math.round(ms);
    assert(out.frames === 120 && out.outputBytes <= MAX_BYTES, `frames ${out.frames}, output ${out.outputBytes} B`);
    outputSizes.push({ name: 'perf: 512x512x120 GIF', bytes: out.outputBytes });
    const d = _internal.decodeGif(out.buffer);
    frames.forEach((f, i) => assert(Buffer.from(d.frames[i].indices).equals(Buffer.from(f.indices)), `frame ${i} differs`));
    assert((await sharpPages(out.buffer)) === 120, 'sharp page count');
    assert(ms < 8000, `took ${ms.toFixed(0)} ms`);
    return `sanitized in ${ms.toFixed(0)} ms (${(maxGif.length / 1048576).toFixed(2)} MiB -> ${(out.outputBytes / 1048576).toFixed(2)} MiB), 120 frames identical`;
  });
}

// ================================================================================================
// GIF: rejected inputs
// ================================================================================================
{
  const gct4 = makePalette(4, 1);
  const px = indexPattern(20, 20, 4, 1);
  const ok = (over = {}) => buildGif({ width: 20, height: 20, gct: gct4, frames: [{ w: 20, h: 20, indices: px }], ...over });
  const okGif = ok();
  await check('gif: baseline fixture for the rejection cases is accepted', () => void run(okGif, 'image/gif'));
  await expectReject('gif: frame outside the logical screen', buildGif({ width: 32, height: 32, gct: gct4, frames: [{ x: 20, y: 0, w: 16, h: 16, indices: indexPattern(16, 16, 4, 2) }] }), 'image/gif', 'MALFORMED');
  await expectReject('gif: zero-width frame', buildGif({ width: 20, height: 20, gct: gct4, frames: [{ w: 0, h: 20, data: subBlocks(Buffer.from([0x0c])) }] }), 'image/gif', 'MALFORMED');
  const tiny = indexPattern(16, 16, 4, 3);
  await expectReject('gif: 121 frames (maxFrames 120)', buildGif({ width: 16, height: 16, gct: gct4, frames: Array.from({ length: 121 }, () => ({ w: 16, h: 16, indices: tiny })) }), 'image/gif', 'TOO_MANY_FRAMES', { maxMs: 50 });
  await expectReject('gif: width*height*frames over maxTotalPixels (override)', buildGif({ width: 16, height: 16, gct: gct4, frames: Array.from({ length: 4 }, () => ({ w: 16, h: 16, indices: tiny })) }), 'image/gif', 'TOO_MANY_FRAMES', { limits: { gif: { maxTotalPixels: 16 * 16 * 3 } } });
  await expectReject('gif: 1024x1024 logical screen rejected fast', buildGif({ width: 1024, height: 1024, gct: gct4, frames: [{ w: 1024, h: 1024, indices: new Uint8Array(1024 * 1024) }] }), 'image/gif', 'TOO_LARGE_DIMENSIONS', { maxMs: 50 });
  await expectReject('gif: 1024x1024 screen + garbage LZW still reports dimensions (no LZW decoded)', buildGif({ width: 1024, height: 1024, gct: gct4, frames: [{ w: 1024, h: 1024, data: subBlocks(Buffer.from('garbage')) }] }), 'image/gif', 'TOO_LARGE_DIMENSIONS', { maxMs: 50 });
  await expectReject('gif: 513x16 is too wide', buildGif({ width: 513, height: 16, gct: gct4, frames: [{ w: 16, h: 16, indices: tiny }] }), 'image/gif', 'TOO_LARGE_DIMENSIONS');
  await expectReject('gif: 8x8 is too small', buildGif({ width: 8, height: 8, gct: gct4, frames: [{ w: 8, h: 8, indices: tiny.subarray(0, 64) }] }), 'image/gif', 'TOO_SMALL_DIMENSIONS');
  await expectReject('gif: LZW ends (EOI) after half the pixels', ok({ frames: [{ w: 20, h: 20, data: subBlocks(lzwRef(px.subarray(0, 200), 2)) }] }), 'image/gif', 'MALFORMED');
  const full = lzwRef(px, 2, { eoi: false });
  await expectReject('gif: LZW data runs out before the frame is complete', ok({ frames: [{ w: 20, h: 20, data: subBlocks(full.subarray(0, full.length >> 1)) }] }), 'image/gif', 'MALFORMED');
  await expectReject('gif: file truncated inside the image data', okGif.subarray(0, Math.floor(okGif.length * 0.7)), 'image/gif', 'MALFORMED');
  await expectReject('gif: missing trailer', okGif.subarray(0, okGif.length - 1), 'image/gif', 'MALFORMED');
  await expectReject('gif: bytes after the trailer (polyglot)', Buffer.concat([okGif, Buffer.from('<html><script>alert(1)</script>')]), 'image/gif', 'MALFORMED');
  await expectReject('gif: a single zero byte after the trailer', Buffer.concat([okGif, Buffer.from([0])]), 'image/gif', 'MALFORMED');
  await expectReject('gif: no colour table at all', buildGif({ width: 20, height: 20, frames: [{ w: 20, h: 20, m: 2, indices: px }] }), 'image/gif', 'MALFORMED');
  await expectReject('gif: LZW minimum code size 9', ok({ frames: [{ w: 20, h: 20, m: 9, data: subBlocks(Buffer.alloc(40, 0xff)) }] }), 'image/gif', 'MALFORMED');
  await expectReject('gif: LZW minimum code size 1', ok({ frames: [{ w: 20, h: 20, m: 1, data: subBlocks(Buffer.alloc(40)) }] }), 'image/gif', 'MALFORMED');
  await expectReject('gif: pixel index beyond the colour table', ok({ frames: [{ w: 20, h: 20, m: 8, indices: Uint8Array.from(px, (v, i) => (i === 137 ? 200 : v)) }] }), 'image/gif', 'MALFORMED');
  // m = 2: clear(4), literal 1, then code 7 while the next free code is 6.
  await expectReject('gif: LZW code beyond the next table entry', ok({ frames: [{ w: 20, h: 20, data: subBlocks(Buffer.from([0x0c | (1 << 3) | ((7 & 3) << 6), 7 >> 2, 0, 0])) }] }), 'image/gif', 'MALFORMED');
  await expectReject('gif: first code after clear is not a literal', ok({ frames: [{ w: 20, h: 20, data: subBlocks(Buffer.from([0x04 | (6 << 3), 0, 0])) }] }), 'image/gif', 'MALFORMED');
  await expectReject('gif: graphic control block of size 5', ok({ frames: [{ w: 20, h: 20, indices: px, pre: [gceBlock({ size: 5 })] }] }), 'image/gif', 'MALFORMED');
  await expectReject('gif: no image at all', buildGif({ width: 20, height: 20, gct: gct4, frames: [] }), 'image/gif', 'MALFORMED');
  await expectReject('gif: unknown block introducer', Buffer.concat([okGif.subarray(0, okGif.length - 1), Buffer.from([0x00, 0x3b])]), 'image/gif', 'MALFORMED');
  await expectReject('gif: truncated logical screen descriptor', okGif.subarray(0, 10), 'image/gif', 'MALFORMED');
}

// ================================================================================================
// Summary
// ================================================================================================
await check('size: every accepted fixture re-encodes to <= maxInputBytes', () => {
  assert(outputSizes.length > 0, 'no outputs recorded');
  const over = outputSizes.filter((o) => o.bytes > MAX_BYTES);
  assert(!over.length, `over the cap: ${over.map((o) => `${o.name} (${o.bytes} B)`).join('; ')}`);
  const largest = outputSizes.reduce((a, b) => (b.bytes > a.bytes ? b : a));
  return `${outputSizes.length} outputs, largest ${largest.bytes} B (${largest.name})`;
});

timings.totalMs = Math.round(performance.now() - T0);
const { passed, failed, skipped } = writeResults();
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''} in ${(timings.totalMs / 1000).toFixed(1)} s (png 1024 noisy: ${timings.png1024NoisyMs} ms, png 1024 binary noise: ${timings.png1024BinaryNoiseMs} ms, gif 512x512x120: ${timings.gif512x120Ms} ms)`);
process.exit(failed ? 1 : 0);
