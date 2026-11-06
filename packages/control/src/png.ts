import { createHash } from 'node:crypto';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

import { fail } from '@control/problems';
import { Raster } from '@control/raster';

// Minimal PNG writer and reader with Node.js built-ins only. No image library is necessary for 8-bit RGBA control images.
// The reader accepts only 8-bit RGB or RGBA, non-interlaced files. It checks the size limits before it inflates the pixel data.
// Color space: the pixel values are used as stored. ICC profiles and gamma chunks are ignored and are reported.
// Alpha: PNG alpha is straight (not premultiplied).

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type PngLimits = { readonly maxBytes: number; readonly maxWidth: number; readonly maxHeight: number; readonly maxPixels: number };
export const defaultPngLimits: PngLimits = { maxBytes: 64 * 1024 * 1024, maxWidth: 4096, maxHeight: 4096, maxPixels: 4096 * 4096 };

export type DecodedPng = { readonly raster: Raster; readonly colorType: 'rgb' | 'rgba'; readonly ignoredChunks: readonly string[] };

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** Encodes an 8-bit RGBA PNG with filter 0 on each row. The same pixels and zlib version give the same bytes. */
export function encodePng(raster: Raster): Buffer {
  const { width, height, data } = raster;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rows[y * (stride + 1)] = 0;
    rows.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decodes an 8-bit RGB or RGBA PNG to RGBA. Throws E_PNG_* for other formats, for corrupt data, and above the limits. */
export function decodePng(bytes: Uint8Array, limits: PngLimits = defaultPngLimits): DecodedPng {
  if (bytes.length > limits.maxBytes) fail('E_PNG_TOO_LARGE', `The file has ${bytes.length} bytes. The limit is ${limits.maxBytes}.`);
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) fail('E_PNG_FORMAT', 'The file is not a PNG image.');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let seenHeader = false;
  let ended = false;
  const idat: Buffer[] = [];
  const ignored = new Set<string>();
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) fail('E_PNG_FORMAT', 'A chunk type is not valid.');
    if (offset + 12 + length > buffer.length) fail('E_PNG_FORMAT', `The ${type} chunk is cut off.`);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const crc = buffer.readUInt32BE(offset + 8 + length);
    if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) >>> 0 !== crc) fail('E_PNG_FORMAT', `The ${type} chunk has a bad CRC.`);
    offset += 12 + length;
    if (!seenHeader && type !== 'IHDR') fail('E_PNG_FORMAT', 'The first chunk is not IHDR.');
    if (type === 'IHDR') {
      if (seenHeader || length !== 13) fail('E_PNG_FORMAT', 'The IHDR chunk is not valid.');
      seenHeader = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, color, compression, filter, interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (width < 1 || height < 1 || width > limits.maxWidth || height > limits.maxHeight || width * height > limits.maxPixels) {
        fail('E_PNG_TOO_LARGE', `The image is ${width}x${height}. The limit is ${limits.maxWidth}x${limits.maxHeight} and ${limits.maxPixels} pixels.`);
      }
      if (depth !== 8 || (color !== 2 && color !== 6)) fail('E_PNG_UNSUPPORTED', 'Only 8-bit RGB and RGBA PNG images are supported.');
      if (compression !== 0 || filter !== 0) fail('E_PNG_FORMAT', 'Unknown compression or filter method.');
      if (interlace !== 0) fail('E_PNG_UNSUPPORTED', 'Interlaced PNG images are not supported.');
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
      break;
    } else if (type === 'PLTE') {
      fail('E_PNG_UNSUPPORTED', 'Palette images are not supported.');
    } else {
      ignored.add(type);
    }
  }
  if (!seenHeader || !ended || idat.length === 0) fail('E_PNG_FORMAT', 'The PNG image has no IHDR, IDAT, or IEND chunk.');
  const stride = width * channels;
  const expected = (stride + 1) * height;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch {
    fail('E_PNG_FORMAT', 'The pixel data is corrupt or larger than the image size.');
  }
  if (raw.length !== expected) fail('E_PNG_FORMAT', 'The pixel data does not have the image size.');
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const kind = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? (pixels[out + i - channels] ?? 0) : 0;
      const b = y > 0 ? (pixels[out - stride + i] ?? 0) : 0;
      const c = i >= channels && y > 0 ? (pixels[out - stride + i - channels] ?? 0) : 0;
      const x = row[i] ?? 0;
      let value: number;
      if (kind === 0) value = x;
      else if (kind === 1) value = x + a;
      else if (kind === 2) value = x + b;
      else if (kind === 3) value = x + ((a + b) >> 1);
      else if (kind === 4) value = x + paeth(a, b, c);
      else fail('E_PNG_FORMAT', `Unknown row filter ${kind}.`);
      pixels[out + i] = value & 0xff;
    }
  }
  const raster = new Raster(width, height);
  for (let p = 0; p < width * height; p += 1) {
    raster.data[p * 4] = pixels[p * channels] ?? 0;
    raster.data[p * 4 + 1] = pixels[p * channels + 1] ?? 0;
    raster.data[p * 4 + 2] = pixels[p * channels + 2] ?? 0;
    raster.data[p * 4 + 3] = channels === 4 ? (pixels[p * channels + 3] ?? 0) : 255;
  }
  return { raster, colorType: channels === 4 ? 'rgba' : 'rgb', ignoredChunks: [...ignored].sort() };
}

export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** Hash of the decoded pixels and the size. It does not depend on the PNG compression, so it is the determinism key. */
export function pixelHash(raster: Raster): string {
  return createHash('sha256').update(`${raster.width}x${raster.height}:rgba8\n`).update(raster.data).digest('hex');
}
