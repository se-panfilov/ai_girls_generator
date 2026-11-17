import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

type Rgba = readonly [number, number, number, number];

/** An RGBA PNG with one colour for each pixel from `pixel` (synthetic test image). */
export function png(width: number, height: number, pixel: (x: number, y: number) => Rgba): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) rows.set(pixel(x, y), y * (1 + width * 4) + 1 + x * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** Colours of the synthetic parts. The browser test counts them in screenshots. */
export const colours: { readonly body: Rgba; readonly arm: Rgba } = { body: [40, 160, 220, 255], arm: [230, 60, 40, 255] };

/** A synthetic Spine 4.3 skeleton: a body and one arm, `idle` turns the arm a little, `wave` raises it. */
export function syntheticSkeleton(): Record<string, unknown> {
  return {
    skeleton: { spine: '4.3.26', x: -100, y: 0, width: 300, height: 400, images: './images/', audio: '' },
    bones: [
      { name: 'root', rotation: 0, x: 0, y: 0 },
      { name: 'arm', parent: 'root', length: 120, rotation: -80, x: 40, y: 300 }
    ],
    slots: [
      { name: 'body', bone: 'root', attachment: 'body' },
      { name: 'arm', bone: 'arm', attachment: 'arm' }
    ],
    skins: [
      {
        name: 'default',
        attachments: {
          body: { body: { x: 0, y: 160, width: 80, height: 320 } },
          arm: { arm: { x: 60, y: 0, rotation: 0, width: 120, height: 24 } }
        }
      }
    ],
    animations: {
      idle: {
        bones: {
          arm: {
            rotate: [
              { time: 0, value: 0 },
              { time: 1, value: 10 },
              { time: 2, value: 0 }
            ]
          }
        }
      },
      wave: {
        bones: {
          arm: {
            rotate: [
              { time: 0, value: 0 },
              { time: 0.5, value: 150 },
              { time: 1, value: 120 },
              { time: 1.5, value: 150 },
              { time: 2, value: 0 }
            ]
          }
        }
      }
    }
  };
}

/** The atlas text of the synthetic export: one page with two regions. */
export const syntheticAtlas = `parts.png\nsize:256,64\nfilter:Linear,Linear\nbody\nbounds:0,0,80,32\narm\nbounds:128,0,120,24\n`;

/** The page image: the left half has the body colour, the right half the arm colour. */
export const syntheticPage = (): Buffer => png(256, 64, (x) => (x < 128 ? colours.body : colours.arm));

/** Writes the synthetic export into a new temporary folder. `change` can edit the files before they are written. */
export function syntheticExport(change: (files: Map<string, Buffer | string>) => void = () => undefined): string {
  const folder = mkdtempSync(join(tmpdir(), 'aigg-viewer-'));
  const files = new Map<string, Buffer | string>([
    ['character.json', JSON.stringify(syntheticSkeleton())],
    ['character.atlas', syntheticAtlas],
    ['parts.png', syntheticPage()]
  ]);
  change(files);
  for (const [name, data] of files) writeFileSync(join(folder, name), data);
  return folder;
}

/** Decodes an 8-bit RGB or RGBA PNG without interlace (Chromium screenshots). Test use only. */
export function decodePng(data: Buffer): { width: number; height: number; rgba: Uint8Array } {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat: Buffer[] = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0 || (body[9] !== 6 && body[9] !== 2)) throw new Error('Unsupported PNG.');
      channels = body[9] === 6 ? 4 : 3;
    }
    if (type === 'IDAT') idat.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? (current[i - channels] ?? 0) : 0;
      const b = previous[i] ?? 0;
      const c = i >= channels ? (previous[i - channels] ?? 0) : 0;
      const x = line[i] ?? 0;
      let value = x;
      if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      current[i] = value & 255;
    }
    for (let x = 0; x < width; x += 1) {
      out.set([current[x * channels] ?? 0, current[x * channels + 1] ?? 0, current[x * channels + 2] ?? 0, channels === 4 ? (current[x * channels + 3] ?? 0) : 255], (y * width + x) * 4);
    }
    previous.set(current);
  }
  return { width, height, rgba: out };
}
