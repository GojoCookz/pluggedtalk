import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import pngjs from '../../app/node_modules/pngjs/lib/png.js';
import CrcCalculator from '../../app/node_modules/pngjs/lib/crc.js';
import { MediaError } from './media-errors.mjs';

export const MAX_MEDIA_BYTES = 2 * 1024 * 1024;
export const MAX_MEDIA_BODY_BYTES = 2_800_000;
export const MIN_MEDIA_DIMENSION = 16;
export const MAX_MEDIA_DIMENSION = 2048;
export const MAX_MEDIA_PIXELS = 4_194_304;
const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

export function normalizeMedia(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== 3 || !['filename', 'contentType', 'base64'].every(key => Object.hasOwn(input, key))) {
    throw new MediaError('invalid_request');
  }
  const { filename, contentType, base64 } = input;
  // A local display name only. Never use user filenames as filesystem paths or multipart names.
  if (typeof filename !== 'string' || filename.length > 120 || !/\.png$/i.test(filename) ||
      !filename.slice(0, -4).trim() || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\:<>"|?*]/u.test(filename)) {
    throw new MediaError('invalid_filename');
  }
  if (contentType !== 'image/png') throw new MediaError('unsupported_image');
  if (typeof base64 !== 'string' || !base64.length) throw new MediaError('invalid_request');
  if (base64.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4) throw new MediaError('too_large');
  // Avoid a nested-quantifier regex over attacker-controlled megabyte input.
  if (base64.length % 4 || /[^A-Za-z0-9+/=]/.test(base64)) throw new MediaError('invalid_request');
  const source = Buffer.from(base64, 'base64');
  if (source.length > MAX_MEDIA_BYTES) throw new MediaError('too_large');
  if (source.toString('base64') !== base64) throw new MediaError('invalid_request');

  try {
    const { width, height } = checkContainer(source);
    // pngjs, not MIME sniffing, performs full CRC-checked pixel decoding and filtering.
    const decoded = pngjs.PNG.sync.read(source, { checkCRC: true });
    if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4) {
      throw new MediaError('invalid_image');
    }
    // Fixed RGBA encoding removes all metadata and any original compressed representation.
    const bytes = pngjs.PNG.sync.write({ width, height, data: decoded.data }, {
      colorType: 6, inputColorType: 6, bitDepth: 8, filterType: 4,
      deflateLevel: 9, deflateStrategy: 3,
    });
    if (bytes.length > MAX_MEDIA_BYTES) throw new MediaError('too_large');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { bytes, width, height, sha256, filename: `image-${sha256.slice(0, 24)}.png`, contentType: 'image/png' };
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError('invalid_image');
  }
}

// pngjs 5 ignores trailing data and unrecognized ancillary chunks, and its interlaced
// inflate path is unbounded. This restrictive envelope guard closes those paths BEFORE
// invoking the installed decoder. The decoder still owns pixel parsing and re-encoding.
function checkContainer(bytes) {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new MediaError('unsupported_image');
  let offset = 8, width = 0, height = 0, channels = 0, ended = false, seenData = false, chunks = 0;
  const compressed = [], seen = new Set();
  while (offset < bytes.length) {
    if (++chunks > 4096) throw new MediaError('invalid_image');
    if (offset + 12 > bytes.length) throw new MediaError('invalid_image');
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) throw new MediaError('invalid_image');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, end - 4);
    const crc = new CrcCalculator();
    crc.write(bytes.subarray(offset + 4, end - 4));
    if (crc.crc32() !== bytes.readInt32BE(end - 4)) throw new MediaError('invalid_image');
    if (offset === 8 && type !== 'IHDR') throw new MediaError('invalid_image');
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) throw new MediaError('invalid_image');
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (width < MIN_MEDIA_DIMENSION || height < MIN_MEDIA_DIMENSION ||
          width > MAX_MEDIA_DIMENSION || height > MAX_MEDIA_DIMENSION || width * height > MAX_MEDIA_PIXELS) {
        throw new MediaError('invalid_dimensions');
      }
      if (data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) throw new MediaError('unsupported_image');
      channels = data[9] === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      seenData = true;
      compressed.push(data);
    } else if (type === 'IEND') {
      if (length || !seenData || end !== bytes.length) throw new MediaError('invalid_image');
      ended = true;
    } else {
      // No text, EXIF, APNG, embedded archives, scripts or arbitrary unknown chunks.
      // These fixed-size color/resolution hints are permitted but stripped on output.
      const sizes = { sRGB: 1, gAMA: 4, pHYs: 9 };
      if (!Object.hasOwn(sizes, type) || length !== sizes[type] || seenData || seen.has(type)) throw new MediaError('invalid_image');
      if (type === 'sRGB' && data[0] > 3 || type === 'gAMA' && !data.readUInt32BE(0) || type === 'pHYs' && data[8] > 1) throw new MediaError('invalid_image');
    }
    seen.add(type);
    offset = end;
  }
  if (!ended) throw new MediaError('invalid_image');
  const packed = Buffer.concat(compressed), expected = (width * channels + 1) * height;
  // Bound decompression and reject a second stream or payload hidden after zlib EOF.
  const inflated = inflateSync(packed, { maxOutputLength: expected, info: true });
  if (inflated.buffer.length !== expected || inflated.engine.bytesWritten !== packed.length) throw new MediaError('invalid_image');
  return { width, height };
}
