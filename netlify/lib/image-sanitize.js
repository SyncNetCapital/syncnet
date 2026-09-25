'use strict';
/**
 * image-sanitize.js: decode, validate and re-encode user-supplied PNG and GIF images.
 *
 * The IPFS upload function must never pin the bytes a user sent. sanitizeImage() parses the
 * whole file, enforces the byte / dimension / frame limits before any large allocation, and
 * builds a brand-new file from decoded pixel data only:
 *   - PNG -> 8-bit RGBA, non-interlaced, exactly IHDR + IDAT... + IEND (no ancillary chunks),
 *            adaptive row filters, zlib level 9 (time-bounded, see deflateBounded).
 *   - GIF -> GIF89a with the same screen, colour tables, frame geometry and timing. Comments,
 *            XMP and every application extension except the NETSCAPE2.0 loop count are dropped.
 *
 * Only Node.js built-ins are used (zlib, Buffer). Everything is synchronous and stateless.
 *
 *   const { sanitizeImage, ImageRejected } = require('../lib/image-sanitize');
 *   try {
 *     const out = sanitizeImage(buf, { declaredType: 'image/png' });   // pin out.buffer
 *   } catch (e) {
 *     if (e instanceof ImageRejected) return json(400, { error: e.message, code: e.code });
 *     throw e;
 *   }
 */
const zlib = require('zlib');

const PNG = 'image/png';
const GIF = 'image/gif';

const DEFAULT_LIMITS = deepFreeze({
  maxInputBytes: 3 * 1024 * 1024,
  png: { maxWidth: 1024, maxHeight: 1024, minWidth: 16, minHeight: 16 },
  gif: { maxWidth: 512, maxHeight: 512, minWidth: 16, minHeight: 16, maxFrames: 120, maxTotalPixels: 512 * 512 * 120 },
});

// User-facing messages: short, and free of parser internals. Some are refined at the throw site.
const MESSAGES = Object.freeze({
  UNSUPPORTED_FORMAT: 'Only PNG and GIF images are accepted.',
  TYPE_MISMATCH: 'The file contents do not match the declared image type.',
  MALFORMED: 'The image file is damaged or invalid.',
  TOO_LARGE_BYTES: 'The image file is too large.',
  TOO_LARGE_DIMENSIONS: 'The image dimensions are too large.',
  TOO_SMALL_DIMENSIONS: 'The image dimensions are too small.',
  TOO_MANY_FRAMES: 'The animation has too many frames.',
  DECOMPRESSION_LIMIT: 'The image data is larger than its dimensions allow.',
});

class ImageRejected extends Error {
  constructor(code, message, options) {
    super(message || MESSAGES[code] || 'The image was rejected.', options);
    this.name = 'ImageRejected';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ImageRejected(code, message);
}

function deepFreeze(obj) {
  for (const value of Object.values(obj)) if (value && typeof value === 'object') deepFreeze(value);
  return Object.freeze(obj);
}

// ---------------------------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------------------------

/**
 * @param {Buffer|Uint8Array} buffer  raw upload bytes (never modified)
 * @param {{declaredType?: string, limits?: object}} [options]
 * @returns {{type: string, buffer: Buffer, width: number, height: number, frames: number,
 *            inputBytes: number, outputBytes: number}}
 * @throws {ImageRejected} for every problem with the input; TypeError for caller mistakes.
 */
function sanitizeImage(buffer, options) {
  const input = asBuffer(buffer);
  const opts = options || {};
  const limits = resolveLimits(opts.limits);
  const inputBytes = input.length;

  if (inputBytes > limits.maxInputBytes) {
    fail('TOO_LARGE_BYTES', `Image files must be ${formatBytes(limits.maxInputBytes)} or smaller.`);
  }
  // The format comes from the bytes alone; the client's claim is only compared against it.
  const type = detectFormat(input);
  if (type === null) fail('UNSUPPORTED_FORMAT');
  const declared = typeof opts.declaredType === 'string' ? opts.declaredType.trim().toLowerCase() : '';
  if (declared !== type) fail('TYPE_MISMATCH');

  let image;
  try {
    image = type === PNG ? sanitizePng(input, limits) : sanitizeGif(input, limits);
  } catch (err) {
    if (err instanceof ImageRejected) throw err;
    // Any other failure (hostile length, allocation failure, ...) still means "do not pin".
    // The original error is kept as `cause` for server logs; it never reaches the message.
    throw new ImageRejected('MALFORMED', undefined, { cause: err });
  }

  const outputBytes = image.buffer.length;
  // The pinned file obeys the same byte cap as the upload (a re-encode can grow, e.g. palette -> RGBA).
  if (outputBytes > limits.maxInputBytes) fail('TOO_LARGE_BYTES', outputTooLargeMessage(limits));
  return { type, buffer: image.buffer, width: image.width, height: image.height, frames: image.frames, inputBytes, outputBytes };
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('sanitizeImage: expected a Buffer or Uint8Array');
}

function resolveLimits(overrides) {
  const o = overrides || {};
  const pick = (value, fallback, name) => {
    const v = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(v) || v < 0) throw new TypeError(`sanitizeImage: limit ${name} must be a non-negative integer`);
    return v;
  };
  const section = (format) => {
    const src = o[format] || {};
    const out = {};
    for (const key of Object.keys(DEFAULT_LIMITS[format])) out[key] = pick(src[key], DEFAULT_LIMITS[format][key], `${format}.${key}`);
    return out;
  };
  return { maxInputBytes: pick(o.maxInputBytes, DEFAULT_LIMITS.maxInputBytes, 'maxInputBytes'), png: section('png'), gif: section('gif') };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function detectFormat(buf) {
  if (buf.length >= 8 && buf.compare(PNG_SIGNATURE, 0, 8, 0, 8) === 0) return PNG;
  if (buf.length >= 6) {
    const header = buf.toString('latin1', 0, 6);
    if (header === 'GIF87a' || header === 'GIF89a') return GIF;
  }
  return null;
}

function checkDimensions(label, width, height, lim) {
  if (width > lim.maxWidth || height > lim.maxHeight) {
    fail('TOO_LARGE_DIMENSIONS', `${label} images must be at most ${lim.maxWidth}x${lim.maxHeight} pixels.`);
  }
  if (width < lim.minWidth || height < lim.minHeight) {
    fail('TOO_SMALL_DIMENSIONS', `${label} images must be at least ${lim.minWidth}x${lim.minHeight} pixels.`);
  }
}

function formatBytes(n) {
  if (n >= 1048576) return `${Math.floor((n / 1048576) * 10) / 10} MB`;
  if (n >= 1024) return `${Math.floor(n / 1024)} KB`;
  return `${n} bytes`;
}

function outputTooLargeMessage(limits) {
  return `The processed image would exceed ${formatBytes(limits.maxInputBytes)}. Use a smaller or simpler image.`;
}

// CRC-32 (ISO-HDLC, as used by PNG). Table-driven; zlib.crc32 only exists on newer Node versions.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------------------------

// Allowed bit depths, indexed by colour type (PNG spec, table 11.1). Types 1 and 5 do not exist.
const PNG_BIT_DEPTHS = [[1, 2, 4, 8, 16], null, [8, 16], [1, 2, 4, 8], [8, 16], null, [8, 16]];
const PNG_CHANNELS = [1, 0, 3, 1, 2, 0, 4];
// Adam7 passes as [x0, y0, dx, dy]; a plain image is the single pass [0, 0, 1, 1].
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
const IDAT_CHUNK_BYTES = 64 * 1024;

function sanitizePng(buf, limits) {
  const { width, height, rgba } = decodePng(buf, limits);
  return { buffer: encodePng(width, height, rgba, limits.maxInputBytes), width, height, frames: 1 };
}

/**
 * Walks every chunk (length bounds + CRC), validates ordering and the critical chunks, and
 * returns what decoding needs. Ancillary chunks (text, EXIF, ICC, gamma, APNG acTL/fcTL/fdAT,
 * ...) are CRC-checked and then dropped.
 */
function parsePng(buf, limits) {
  let pos = PNG_SIGNATURE.length;
  let ihdr = null;
  let palette = null; // PLTE payload (colour type 3 only; a "suggested palette" for 2/6 is dropped)
  let sawPalette = false;
  let trns = null;
  const idat = [];
  let idatBytes = 0;
  let idatClosed = false; // set once another chunk follows the IDAT run

  for (;;) {
    if (buf.length - pos < 12) fail('MALFORMED'); // truncated, or IEND missing
    const length = buf.readUInt32BE(pos);
    if (length > 0x7fffffff || length > buf.length - pos - 12) fail('MALFORMED');
    const typeAt = pos + 4;
    const dataAt = pos + 8;
    const end = dataAt + length;
    for (let i = typeAt; i < dataAt; i++) {
      const c = buf[i];
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) fail('MALFORMED'); // letters only
    }
    if (crc32(buf, typeAt, end) !== buf.readUInt32BE(end)) fail('MALFORMED');
    const type = buf.toString('latin1', typeAt, dataAt);
    const data = buf.subarray(dataAt, end);
    pos = end + 4;

    if (ihdr === null) {
      // IHDR must come first. This also rejects Apple's CgBI files, whose CgBI chunk precedes IHDR.
      if (type !== 'IHDR') fail('MALFORMED');
      ihdr = readIhdr(data);
      checkDimensions('PNG', ihdr.width, ihdr.height, limits.png); // before anything is inflated
      continue;
    }
    if (type === 'IDAT') {
      if (idatClosed) fail('MALFORMED'); // IDAT chunks must be consecutive
      if (ihdr.colorType === 3 && !palette) fail('MALFORMED'); // PLTE must precede the image data
      idatBytes += length;
      if (idatBytes > limits.maxInputBytes) fail('TOO_LARGE_BYTES');
      idat.push(data);
      continue;
    }
    if (idat.length) idatClosed = true;

    switch (type) {
      case 'IEND':
        if (length !== 0 || !idat.length) fail('MALFORMED');
        if (pos !== buf.length) fail('MALFORMED'); // nothing may follow IEND (blocks polyglots)
        return { ...ihdr, palette, trns, idat };
      case 'PLTE':
        if (sawPalette || idat.length || trns) fail('MALFORMED'); // once, before tRNS and IDAT
        if (ihdr.colorType === 0 || ihdr.colorType === 4) fail('MALFORMED');
        if (length === 0 || length % 3 !== 0 || length / 3 > 256) fail('MALFORMED');
        if (ihdr.colorType === 3 && length / 3 > 1 << ihdr.bitDepth) fail('MALFORMED');
        sawPalette = true;
        if (ihdr.colorType === 3) palette = data;
        break;
      case 'tRNS':
        if (trns || idat.length) fail('MALFORMED');
        trns = readTrns(data, ihdr, palette);
        break;
      default:
        // Bit 5 of the first byte clear = critical. IHDR/PLTE/IDAT/IEND are the only ones we
        // know how to honour, so any other critical chunk (CgBI included) makes the file unusable.
        if ((buf[typeAt] & 0x20) === 0) fail('MALFORMED');
    }
  }
}

function readIhdr(d) {
  if (d.length !== 13) fail('MALFORMED');
  const width = d.readUInt32BE(0);
  const height = d.readUInt32BE(4);
  const bitDepth = d[8];
  const colorType = d[9];
  const depths = PNG_BIT_DEPTHS[colorType];
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) fail('MALFORMED');
  if (!depths || !depths.includes(bitDepth)) fail('MALFORMED');
  if (d[10] !== 0 || d[11] !== 0 || d[12] > 1) fail('MALFORMED'); // compression 0, filter 0, interlace 0|1
  return { width, height, bitDepth, colorType, interlaced: d[12] === 1 };
}

// tRNS: per-entry alpha for palettes, or one fully transparent colour for grey / truecolour.
// Sample values are compared at full precision, so they must fit the image bit depth.
function readTrns(d, ihdr, palette) {
  const max = (1 << ihdr.bitDepth) - 1;
  switch (ihdr.colorType) {
    case 3:
      if (!palette || d.length > palette.length / 3) fail('MALFORMED');
      return d;
    case 0: {
      if (d.length !== 2) fail('MALFORMED');
      const gray = d.readUInt16BE(0);
      if (gray > max) fail('MALFORMED');
      return { gray };
    }
    case 2: {
      if (d.length !== 6) fail('MALFORMED');
      const [r, g, b] = [d.readUInt16BE(0), d.readUInt16BE(2), d.readUInt16BE(4)];
      if (r > max || g > max || b > max) fail('MALFORMED');
      return { r, g, b };
    }
    default:
      fail('MALFORMED'); // colour types 4 and 6 already carry a full alpha channel
  }
}

// The non-empty passes of the image with their sizes. Empty Adam7 passes (possible when the
// image is narrower or shorter than 5 pixels) contribute no bytes at all, not even filter bytes.
function pngPasses(width, height, interlaced) {
  const passes = [];
  for (const [x0, y0, dx, dy] of interlaced ? ADAM7 : [[0, 0, 1, 1]]) {
    const w = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const h = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    if (w > 0 && h > 0) passes.push({ x0, y0, dx, dy, w, h });
  }
  return passes;
}

function decodePng(buf, limits) {
  const png = parsePng(buf, limits);
  const { width, height, bitDepth, colorType, interlaced } = png;
  const bitsPerPixel = PNG_CHANNELS[colorType] * bitDepth;
  const passes = pngPasses(width, height, interlaced);
  let expected = 0; // exact inflated size: every row is a filter byte + its packed pixels
  for (const p of passes) {
    p.rowBytes = Math.ceil((p.w * bitsPerPixel) / 8);
    expected += p.h * (1 + p.rowBytes);
  }

  const raw = inflateExact(png.idat, expected);
  const rgba = Buffer.alloc(width * height * 4); // zero-filled: nothing uninitialised can leak
  const bpp = Math.max(1, bitsPerPixel >> 3); // filter distance: bytes per complete pixel, min 1
  const zeroRow = new Uint8Array(Math.max(...passes.map((p) => p.rowBytes)));
  const writeRow = makeRowWriter(png);
  let at = 0;
  for (const p of passes) {
    let up = zeroRow; // the first row of every pass is filtered against an all-zero row
    let upAt = 0;
    for (let j = 0; j < p.h; j++) {
      unfilterRow(raw, at, p.rowBytes, up, upAt, bpp);
      writeRow(raw, at + 1, p.w, rgba, ((p.y0 + j * p.dy) * width + p.x0) * 4, p.dx * 4);
      up = raw;
      upAt = at + 1;
      at += 1 + p.rowBytes;
    }
  }
  return { width, height, rgba };
}

function inflateExact(parts, expected) {
  const compressed = parts.length === 1 ? parts[0] : Buffer.concat(parts);
  let out;
  try {
    // zlib stops as soon as the stream produces more than the image can hold. The +1 lets a
    // stream that is exactly one byte too long surface as a length mismatch below.
    out = zlib.inflateSync(compressed, { maxOutputLength: expected + 1 });
  } catch (err) {
    if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError)) fail('DECOMPRESSION_LIMIT');
    fail('MALFORMED'); // corrupt or truncated deflate stream, bad Adler-32
  }
  if (out.length > expected) fail('DECOMPRESSION_LIMIT');
  if (out.length < expected) fail('MALFORMED');
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Reverses one row's filter in place. d[at] is the filter type, the row's n bytes follow it, and
// up[upAt..] is the previous reconstructed row of the same pass (or a zero row). Buffer element
// assignment wraps modulo 256, which is exactly PNG's byte arithmetic.
function unfilterRow(d, at, n, up, upAt, bpp) {
  const s = at + 1;
  const e = s + n;
  const lead = Math.min(e, s + bpp); // bytes without a left neighbour (a = c = 0)
  switch (d[at]) {
    case 0:
      return;
    case 1:
      for (let i = lead; i < e; i++) d[i] += d[i - bpp];
      return;
    case 2:
      for (let i = s, p = upAt; i < e; i++, p++) d[i] += up[p];
      return;
    case 3:
      for (let i = s, p = upAt; i < lead; i++, p++) d[i] += up[p] >> 1;
      for (let i = lead, p = upAt + bpp; i < e; i++, p++) d[i] += (d[i - bpp] + up[p]) >> 1;
      return;
    case 4:
      for (let i = s, p = upAt; i < lead; i++, p++) d[i] += up[p]; // Paeth(0, b, 0) = b
      for (let i = lead, p = upAt + bpp; i < e; i++, p++) d[i] += paeth(d[i - bpp], up[p], up[p - bpp]);
      return;
    default:
      fail('MALFORMED'); // filter types are 0..4
  }
}

/**
 * Returns fn(src, at, count, out, o, step) that converts `count` packed pixels starting at
 * src[at] to 8-bit RGBA, writing pixel k at out[o + k * step]. 16-bit samples keep their high
 * byte, while tRNS colour keys are matched against the full-precision sample.
 */
function makeRowWriter({ bitDepth, colorType, palette, trns }) {
  if (colorType === 3) {
    const count = palette.length / 3;
    const lut = new Uint8Array(count * 4); // palette index -> RGBA
    for (let i = 0; i < count; i++) {
      lut.set(palette.subarray(i * 3, i * 3 + 3), i * 4);
      lut[i * 4 + 3] = trns && i < trns.length ? trns[i] : 255;
    }
    const mask = (1 << bitDepth) - 1;
    return (src, at, n, out, o, step) => {
      for (let x = 0; x < n; x++, o += step) {
        const bit = x * bitDepth;
        const idx = bitDepth === 8 ? src[at + x] : (src[at + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & mask;
        if (idx >= count) fail('MALFORMED'); // index outside PLTE
        const l = idx * 4;
        out[o] = lut[l];
        out[o + 1] = lut[l + 1];
        out[o + 2] = lut[l + 2];
        out[o + 3] = lut[l + 3];
      }
    };
  }
  if (bitDepth < 8) {
    // Greyscale at 1/2/4 bits: scale to 0..255 (x255, x85, x17).
    const mask = (1 << bitDepth) - 1;
    const scale = 255 / mask;
    const key = trns ? trns.gray : -1;
    return (src, at, n, out, o, step) => {
      for (let x = 0; x < n; x++, o += step) {
        const bit = x * bitDepth;
        const v = (src[at + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & mask;
        out[o] = out[o + 1] = out[o + 2] = v * scale;
        out[o + 3] = v === key ? 0 : 255;
      }
    };
  }
  // 8/16-bit grey (0), grey+alpha (4), RGB (2), RGBA (6). B = bytes per sample; the first
  // (big-endian) byte of a 16-bit sample is its high byte.
  const B = bitDepth >> 3;
  const P = PNG_CHANNELS[colorType] * B;
  const grey = colorType === 0 || colorType === 4;
  const full = B === 2 ? (s, i) => (s[i] << 8) | s[i + 1] : (s, i) => s[i];
  return (src, at, n, out, o, step) => {
    for (let x = 0, i = at; x < n; x++, i += P, o += step) {
      if (grey) {
        out[o] = out[o + 1] = out[o + 2] = src[i];
        out[o + 3] = colorType === 4 ? src[i + B] : trns && full(src, i) === trns.gray ? 0 : 255;
      } else {
        out[o] = src[i];
        out[o + 1] = src[i + B];
        out[o + 2] = src[i + 2 * B];
        if (colorType === 6) out[o + 3] = src[i + 3 * B];
        else out[o + 3] = trns && full(src, i) === trns.r && full(src, i + B) === trns.g && full(src, i + 2 * B) === trns.b ? 0 : 255;
      }
    }
  };
}

// |signed byte| for the minimum-sum-of-absolute-differences filter heuristic.
const ABS_SIGNED = Uint8Array.from({ length: 256 }, (_, v) => (v < 128 ? v : 256 - v));

function encodePng(width, height, rgba, maxBytes) {
  const stride = width * 4;
  const filtered = Buffer.alloc(height * (stride + 1));
  const zeroRow = new Uint8Array(stride);
  for (let y = 0, q = 0; y < height; y++, q += stride + 1) {
    const at = y * stride;
    const up = y > 0 ? rgba : zeroRow;
    const upAt = y > 0 ? at - stride : 0;
    const type = chooseFilter(rgba, at, up, upAt, stride);
    filtered[q] = type;
    filterRow(type, rgba, at, up, upAt, stride, filtered, q + 1);
  }
  const idat = deflateBounded(filtered, maxBytes);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6], 8); // 8-bit RGBA; compression, filter and interlace bytes stay 0
  const parts = [PNG_SIGNATURE, pngChunk('IHDR', ihdr)];
  for (let i = 0; i < idat.length; i += IDAT_CHUNK_BYTES) parts.push(pngChunk('IDAT', idat.subarray(i, i + IDAT_CHUNK_BYTES)));
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// Picks the filter with the minimum sum of absolute (signed) filtered bytes, as libpng does.
function chooseFilter(px, at, up, upAt, n) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  for (let i = 0; i < n; i++) {
    const x = px[at + i];
    const a = i >= 4 ? px[at + i - 4] : 0;
    const b = up[upAt + i];
    const c = i >= 4 ? up[upAt + i - 4] : 0;
    s0 += ABS_SIGNED[x];
    s1 += ABS_SIGNED[(x - a) & 0xff];
    s2 += ABS_SIGNED[(x - b) & 0xff];
    s3 += ABS_SIGNED[(x - ((a + b) >> 1)) & 0xff];
    s4 += ABS_SIGNED[(x - paeth(a, b, c)) & 0xff];
  }
  let best = 0;
  let min = s0;
  if (s1 < min) { best = 1; min = s1; }
  if (s2 < min) { best = 2; min = s2; }
  if (s3 < min) { best = 3; min = s3; }
  if (s4 < min) best = 4;
  return best;
}

function filterRow(type, px, at, up, upAt, n, out, o) {
  for (let i = 0; i < n; i++) {
    const a = i >= 4 ? px[at + i - 4] : 0;
    const b = up[upAt + i];
    let pred = 0;
    if (type === 1) pred = a;
    else if (type === 2) pred = b;
    else if (type === 3) pred = (a + b) >> 1;
    else if (type === 4) pred = paeth(a, b, i >= 4 ? up[upAt + i - 4] : 0);
    out[o + i] = px[at + i] - pred; // stored modulo 256
  }
}

const DEFLATE_SLICE_BYTES = 128 * 1024;
const LEVEL9_BUDGET_MS = 600;

/**
 * zlib level 9 walks hash chains of up to 4096 entries. On low-entropy noise (random 0/255
 * pixels, sparse speckles) nearly every walk is that long, and a 1024x1024 image takes 5-15 s
 * instead of ~0.1 s, so a hostile upload could pin the function. The filtered data is therefore
 * deflated in 128 KiB slices: level 9 while the level-9 time stays within budget, then level 4
 * (chains of 16). Real images finish far inside the budget, so their output stays deterministic.
 * Each slice is a raw deflate segment primed with the previous 32 KiB as dictionary and ended by
 * a sync flush; header + segments + a final empty block + Adler-32 form one ordinary zlib stream.
 */
function deflateBounded(data, maxBytes) {
  const parts = [Buffer.from([0x78, 0xda])]; // zlib header: deflate, 32 KiB window, FLEVEL 3
  let size = 2 + 6; // header + trailer
  let spent = 0;
  for (let at = 0; at < data.length; at += DEFLATE_SLICE_BYTES) {
    const level = spent < LEVEL9_BUDGET_MS ? 9 : 4;
    const opts = { level, finishFlush: zlib.constants.Z_SYNC_FLUSH };
    if (at > 0) opts.dictionary = data.subarray(Math.max(0, at - 32768), at);
    const t0 = nowMs();
    const segment = zlib.deflateRawSync(data.subarray(at, at + DEFLATE_SLICE_BYTES), opts);
    if (level === 9) spent += nowMs() - t0;
    size += segment.length;
    if (size > maxBytes) fail('TOO_LARGE_BYTES', outputTooLargeMessage({ maxInputBytes: maxBytes }));
    parts.push(segment);
  }
  const trailer = Buffer.alloc(6);
  trailer[0] = 0x03; // final, empty fixed-Huffman block (byte 1 stays 0)
  trailer.writeUInt32BE(adler32(data), 2);
  parts.push(trailer);
  return Buffer.concat(parts, size);
}

function nowMs() {
  const [s, ns] = process.hrtime();
  return s * 1e3 + ns / 1e6;
}

function adler32(d) {
  let a = 1, b = 0;
  for (let i = 0; i < d.length; ) {
    for (const end = Math.min(d.length, i + 5552); i < end; i++) { // NMAX: reduce before overflow
      a += d[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

// ---------------------------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------------------------

const LOOP_EXTENSIONS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);
const GIF_INTERLACE = [[0, 8], [4, 8], [2, 4], [1, 2]]; // [first row, row step] for the 4 passes
const LZW_MAX_CODES = 4096; // 12-bit codes

function sanitizeGif(buf, limits) {
  const gif = parseGif(buf, limits);
  const parts = gifHeader(gif);
  let size = 1; // trailer
  for (const p of parts) size += p.length;
  for (const frame of gif.frames) {
    const part = encodeGifFrame(frame, decodeGifFrame(buf, frame));
    size += part.length;
    if (size > limits.maxInputBytes) fail('TOO_LARGE_BYTES', outputTooLargeMessage(limits)); // stop early
    parts.push(part);
  }
  parts.push(Buffer.from([0x3b]));
  return { buffer: Buffer.concat(parts, size), width: gif.width, height: gif.height, frames: gif.frames.length };
}

/**
 * Structural pass over the whole file, without decoding any LZW data. It checks the logical
 * screen against the limits first, then every block boundary, frame geometry, frame count, the
 * trailer and the end of file, and records where each frame's image data lives.
 */
function parseGif(buf, limits) {
  const lim = limits.gif;
  if (buf.length < 13) fail('MALFORMED');
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  checkDimensions('GIF', width, height, lim);
  const flags = buf[10];
  let pos = 13;
  let globalTable = null;
  if (flags & 0x80) {
    globalTable = readColorTable(buf, pos, flags & 7);
    pos += globalTable.length;
  }

  const frames = [];
  let gce = null; // pending Graphic Control Extension, applies to the next image
  let loopCount = null;
  for (;;) {
    if (pos >= buf.length) fail('MALFORMED'); // trailer missing
    const introducer = buf[pos++];
    if (introducer === 0x3b) break; // trailer

    if (introducer === 0x21) {
      if (pos >= buf.length) fail('MALFORMED');
      const label = buf[pos++];
      if (label === 0xf9) {
        // Graphic Control: one 4-byte block. Only disposal, delay and the transparent index
        // are kept; the user-input flag and reserved bits are dropped.
        if (pos + 5 > buf.length || buf[pos] !== 4) fail('MALFORMED');
        const packed = buf[pos + 1];
        gce = { disposal: (packed >> 2) & 7, delay: buf.readUInt16LE(pos + 2), transparentIndex: packed & 1 ? buf[pos + 4] : null };
        pos = skipSubBlocks(buf, pos + 5);
      } else if (label === 0xff) {
        const app = readApplicationExtension(buf, pos);
        if (loopCount === null && app.loopCount !== null) loopCount = app.loopCount;
        pos = app.end;
      } else {
        // 0xFE comment, 0x01 plain text and unknown extensions: structure-checked, then dropped.
        pos = skipSubBlocks(buf, pos);
        if (label === 0x01) gce = null; // a GCE before plain text belonged to that text block
      }
      continue;
    }

    if (introducer !== 0x2c) fail('MALFORMED');
    if (pos + 9 > buf.length) fail('MALFORMED');
    const packed = buf[pos + 8];
    const frame = {
      left: buf.readUInt16LE(pos), top: buf.readUInt16LE(pos + 2), width: buf.readUInt16LE(pos + 4), height: buf.readUInt16LE(pos + 6),
      interlaced: (packed & 0x40) !== 0, localTable: null, palette: null, minCodeSize: 0, dataAt: 0, gce,
    };
    pos += 9;
    gce = null;
    if (!frame.width || !frame.height || frame.left + frame.width > width || frame.top + frame.height > height) {
      fail('MALFORMED'); // empty frame, or frame outside the logical screen
    }
    if (frames.length + 1 > lim.maxFrames) fail('TOO_MANY_FRAMES', `Animated GIFs may have at most ${lim.maxFrames} frames.`);
    if (width * height * (frames.length + 1) > lim.maxTotalPixels) {
      fail('TOO_MANY_FRAMES', 'This animation is too large. Use fewer frames or smaller dimensions.');
    }
    if (packed & 0x80) {
      frame.localTable = readColorTable(buf, pos, packed & 7);
      pos += frame.localTable.length;
    }
    frame.palette = frame.localTable || globalTable;
    if (!frame.palette) fail('MALFORMED'); // a frame needs a local or global colour table
    if (pos >= buf.length) fail('MALFORMED');
    frame.minCodeSize = buf[pos++];
    if (frame.minCodeSize < 2 || frame.minCodeSize > 8) fail('MALFORMED');
    frame.dataAt = pos;
    pos = skipSubBlocks(buf, pos);
    frames.push(frame);
  }
  if (pos !== buf.length) fail('MALFORMED'); // nothing may follow the trailer (blocks polyglots)
  if (!frames.length) fail('MALFORMED');
  return { width, height, globalTable, loopCount, frames };
}

function readColorTable(buf, pos, sizeField) {
  const bytes = 3 * (2 << sizeField); // 2^(n+1) RGB entries
  if (pos + bytes > buf.length) fail('MALFORMED');
  return buf.subarray(pos, pos + bytes);
}

function tableSizeField(table) {
  return 30 - Math.clz32(table.length / 3); // log2(entries) - 1
}

function skipSubBlocks(buf, pos) {
  for (;;) {
    if (pos >= buf.length) fail('MALFORMED');
    const n = buf[pos++];
    if (n === 0) return pos;
    pos += n; // overruns are caught by the check at the top of the next iteration
  }
}

// Only the loop count of NETSCAPE2.0 / ANIMEXTS1.0 is kept (sub-block id 1: [1, lo, hi]).
// Everything else (XMP, ICC profiles, the NETSCAPE buffering block, vendor data) is dropped.
function readApplicationExtension(buf, pos) {
  let id = null;
  let loopCount = null;
  for (;;) {
    if (pos >= buf.length) fail('MALFORMED');
    const n = buf[pos++];
    if (n === 0) return { end: pos, loopCount };
    if (pos + n > buf.length) fail('MALFORMED');
    if (id === null) id = n === 11 ? buf.toString('latin1', pos, pos + 11) : '';
    else if (LOOP_EXTENSIONS.has(id) && n >= 3 && buf[pos] === 1 && loopCount === null) loopCount = buf.readUInt16LE(pos + 1);
    pos += n;
  }
}

function decodeGifFrame(buf, frame) {
  const count = frame.width * frame.height;
  let pixels = lzwDecode(gatherSubBlocks(buf, frame.dataAt), frame.minCodeSize, count);
  const entries = frame.palette.length / 3;
  if (1 << frame.minCodeSize > entries) {
    // The code size allows indices the colour table does not have. Decoders disagree on how to
    // draw those pixels, so such files are rejected rather than normalised.
    for (let i = 0; i < count; i++) if (pixels[i] >= entries) fail('MALFORMED');
  }
  if (frame.interlaced) pixels = deinterlace(pixels, frame.width, frame.height);
  return pixels;
}

// Concatenates a sub-block chain whose structure parseGif has already validated.
function gatherSubBlocks(buf, pos) {
  let total = 0;
  for (let p = pos; buf[p] !== 0; p += buf[p] + 1) total += buf[p];
  const out = Buffer.alloc(total);
  let q = 0;
  for (let p = pos; buf[p] !== 0; p += buf[p] + 1) {
    buf.copy(out, q, p + 1, p + 1 + buf[p]);
    q += buf[p];
  }
  return out;
}

/**
 * GIF LZW decoder. Reads LSB-first variable-width codes (up to 12 bits), handles clear codes,
 * EOI, the KwKwK case (a code equal to the entry being defined) and a full table that is not
 * cleared ("deferred clear": codes stay 12 bits wide and no entries are added). Decoding stops
 * at exactly `count` pixels; running out of data first is an error, anything after is ignored.
 */
function lzwDecode(data, minCodeSize, count) {
  const out = new Uint8Array(count);
  const prefix = new Int16Array(LZW_MAX_CODES);
  const suffix = new Uint8Array(LZW_MAX_CODES);
  const first = new Uint8Array(LZW_MAX_CODES);
  const length = new Uint16Array(LZW_MAX_CODES);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1;
    suffix[i] = first[i] = i;
    length[i] = 1;
  }
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let prev = -1; // previous code, or -1 right after a clear (the next code must be a literal)
  let acc = 0, bits = 0, p = 0, n = 0; // bit accumulator, bits held, input position, pixels out
  while (n < count) {
    while (bits < codeSize) {
      if (p >= data.length) fail('MALFORMED'); // data ended before the frame was complete
      acc |= data[p++] << bits;
      bits += 8;
    }
    const code = acc & ((1 << codeSize) - 1);
    acc >>>= codeSize;
    bits -= codeSize;

    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;
    if (prev < 0) {
      if (code >= clear) fail('MALFORMED'); // only a literal can follow a clear code
    } else if (code < next || (code === next && next < LZW_MAX_CODES)) {
      if (next < LZW_MAX_CODES) {
        // New entry = string(prev) + first pixel of string(code). For KwKwK (code === next) that
        // first pixel is first[prev], and first[code] is not defined yet, hence the ternary.
        prefix[next] = prev;
        suffix[next] = code === next ? first[prev] : first[code];
        first[next] = first[prev];
        length[next] = length[prev] + 1;
        next++;
        if (next === 1 << codeSize && codeSize < 12) codeSize++;
      }
    } else {
      fail('MALFORMED'); // code not in the table yet
    }
    // Emit string(code) backwards from its last pixel, dropping whatever falls past the frame.
    let end = n + length[code];
    let c = code;
    if (end > count) {
      for (let k = end - count; k > 0; k--) c = prefix[c];
      end = count;
    }
    for (let i = end - 1; i >= n; i--) {
      out[i] = suffix[c];
      c = prefix[c];
    }
    n = end;
    prev = code;
  }
  if (n < count) fail('MALFORMED'); // EOI before the frame was complete
  return out;
}

function deinterlace(src, width, height) {
  const out = new Uint8Array(width * height);
  let row = 0;
  for (const [start, step] of GIF_INTERLACE) {
    for (let y = start; y < height; y += step, row++) out.set(src.subarray(row * width, (row + 1) * width), y * width);
  }
  return out;
}

function gifHeader(gif) {
  const lsd = Buffer.alloc(13);
  lsd.write('GIF89a', 0, 'latin1');
  lsd.writeUInt16LE(gif.width, 6);
  lsd.writeUInt16LE(gif.height, 8);
  // Global table flag + size, colour resolution 8 bits, not sorted. Background index and
  // pixel aspect ratio (bytes 11 and 12) stay 0.
  lsd[10] = gif.globalTable ? 0x80 | 0x70 | tableSizeField(gif.globalTable) : 0;
  const parts = [lsd];
  if (gif.globalTable) parts.push(Buffer.from(gif.globalTable));
  if (gif.loopCount !== null) {
    // NETSCAPE2.0 application extension: one sub-block [1, loop lo, loop hi], then terminator.
    const loop = gif.loopCount;
    const id = Buffer.from('NETSCAPE2.0', 'latin1');
    parts.push(Buffer.concat([Buffer.from([0x21, 0xff, 11]), id, Buffer.from([3, 1, loop & 0xff, loop >> 8, 0])]));
  }
  return parts;
}

function encodeGifFrame(frame, pixels) {
  const parts = [];
  if (frame.gce) {
    // Graphic Control: the user-input flag and reserved bits are always written as 0, and the
    // transparent-index byte is 0 unless transparency is on.
    const { disposal, delay, transparentIndex: t } = frame.gce;
    parts.push(Buffer.from([0x21, 0xf9, 4, (disposal << 2) | (t === null ? 0 : 1), delay & 0xff, delay >> 8, t === null ? 0 : t, 0]));
  }
  const d = Buffer.alloc(10);
  d[0] = 0x2c;
  [frame.left, frame.top, frame.width, frame.height].forEach((v, i) => d.writeUInt16LE(v, 1 + 2 * i));
  d[9] = frame.localTable ? 0x80 | tableSizeField(frame.localTable) : 0; // never interlaced
  parts.push(d);
  if (frame.localTable) parts.push(Buffer.from(frame.localTable));
  // Every index is < table size (checked while decoding), so the table's own width suffices.
  const minCodeSize = Math.max(2, tableSizeField(frame.palette) + 1);
  parts.push(Buffer.from([minCodeSize]), lzwEncode(pixels, minCodeSize));
  return Buffer.concat(parts);
}

/**
 * GIF LZW encoder (the classic compress/GIFENCOD scheme): starts with a clear code, uses an
 * open-addressing hash of (prefix code, pixel) -> code, widens codes as soon as the decoder's
 * next table slot needs another bit, and emits a clear code when the 4096-entry table is full.
 * Returns the data as sub-blocks of at most 255 bytes plus the 0 terminator.
 */
function lzwEncode(pixels, minCodeSize) {
  const HSIZE = 5003; // prime, ~80% load at 4096 entries
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const keys = new Int32Array(HSIZE).fill(-1); // (pixel << 12) | prefix, or -1 when empty
  const codes = new Uint16Array(HSIZE);
  const n = pixels.length;
  const bytes = Buffer.alloc(Math.ceil(((n + (n >> 8) + 4) * 12) / 8) + 1); // one 12-bit code per pixel + clears
  let q = 0, acc = 0, bits = 0; // bytes written, bit accumulator, bits held
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  const put = (code) => { // LSB-first bit packing
    acc |= code << bits;
    for (bits += codeSize; bits >= 8; bits -= 8, acc >>>= 8) bytes[q++] = acc & 0xff;
  };
  // After emitting a code, the decoder adds entry `next` when it reads the following code; if
  // that slot needs one more bit, the following code (EOI included) must already be wider.
  const widen = () => {
    if (next >= 1 << codeSize && codeSize < 12) codeSize++;
  };

  put(clear);
  let prefix = pixels[0];
  outer: for (let i = 1; i < n; i++) {
    const c = pixels[i];
    const key = (c << 12) | prefix;
    let h = (c << 4) ^ prefix;
    if (keys[h] === key) {
      prefix = codes[h];
      continue;
    }
    if (keys[h] !== -1) {
      const step = h === 0 ? 1 : HSIZE - h; // secondary probe
      for (;;) {
        h -= step;
        if (h < 0) h += HSIZE;
        if (keys[h] === key) {
          prefix = codes[h];
          continue outer;
        }
        if (keys[h] === -1) break;
      }
    }
    put(prefix);
    widen();
    if (next < LZW_MAX_CODES) {
      keys[h] = key;
      codes[h] = next++;
    } else {
      put(clear); // table full: start over (12 bits wide)
      keys.fill(-1);
      next = eoi + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = c;
  }
  put(prefix);
  widen();
  put(eoi);
  if (bits > 0) bytes[q++] = acc & 0xff;

  const out = Buffer.alloc(q + Math.ceil(q / 255) + 1);
  let o = 0;
  for (let s = 0; s < q; s += 255) {
    const len = Math.min(255, q - s);
    out[o++] = len;
    bytes.copy(out, o, s, s + len);
    o += len;
  }
  out[o] = 0; // block terminator
  return out;
}

/** Full GIF decode (structure + every frame's indices). Used by the tests to compare streams. */
function decodeGif(buf, limits) {
  const { width, height, globalTable, loopCount, frames } = parseGif(buf, limits);
  return {
    width, height, globalTable, loopCount,
    frames: frames.map((f) => ({
      left: f.left, top: f.top, width: f.width, height: f.height, localTable: f.localTable, gce: f.gce, indices: decodeGifFrame(buf, f),
    })),
  };
}

module.exports = {
  sanitizeImage,
  ImageRejected,
  DEFAULT_LIMITS,
  // Test hooks only: the decoders sanitizeImage uses, without the re-encode step.
  _internal: {
    decodePng: (buf, limits) => decodePng(buf, resolveLimits(limits)),
    decodeGif: (buf, limits) => decodeGif(buf, resolveLimits(limits)),
  },
};
