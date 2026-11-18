import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

// Test data made at run time: small PNG files, See-through style layer folders, landmark files, and fake commands.
// No image is stored in the repository.

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

export const temporary = (name = 'aigg factory '): string => mkdtempSync(join(tmpdir(), name));

type Color = readonly [number, number, number, number];
type Point = { readonly x: number; readonly y: number };

/** A small RGBA raster with the same fill rules as the control package (pixel centers, straight alpha). */
export class Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }

  blend(x: number, y: number, color: Color): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const sa = color[3] / 255;
    if (sa >= 1) {
      this.data.set(color, i);
      return;
    }
    if (sa <= 0) return;
    const da = (this.data[i + 3] ?? 0) / 255;
    const oa = sa + da * (1 - sa);
    for (let c = 0; c < 3; c += 1) this.data[i + c] = Math.round(((color[c] ?? 0) * sa + (this.data[i + c] ?? 0) * da * (1 - sa)) / oa);
    this.data[i + 3] = Math.round(oa * 255);
  }

  fillPolygon(points: readonly Point[], color: Color): void {
    const ys = points.map((point) => point.y);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(this.height - 1, Math.ceil(Math.max(...ys))); y += 1) {
      const cy = y + 0.5;
      const crossings: number[] = [];
      for (let i = 0; i < points.length; i += 1) {
        const a = points[i] as Point;
        const b = points[(i + 1) % points.length] as Point;
        if (a.y <= cy !== b.y <= cy) crossings.push(a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
      crossings.sort((left, right) => left - right);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const from = Math.max(0, Math.ceil((crossings[k] as number) - 0.5));
        const to = Math.min(this.width - 1, Math.floor((crossings[k + 1] as number) - 0.5));
        for (let x = from; x <= to; x += 1) this.blend(x, y, color);
      }
    }
  }

  fillCircle(center: Point, radius: number, color: Color): void {
    for (let y = Math.max(0, Math.floor(center.y - radius)); y <= Math.min(this.height - 1, Math.ceil(center.y + radius)); y += 1) {
      for (let x = Math.max(0, Math.floor(center.x - radius)); x <= Math.min(this.width - 1, Math.ceil(center.x + radius)); x += 1) {
        const dx = x + 0.5 - center.x;
        const dy = y + 0.5 - center.y;
        if (dx * dx + dy * dy <= radius * radius) this.blend(x, y, color);
      }
    }
  }

  line(a: Point, b: Point, width: number, color: Color): void {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = (-(b.y - a.y) / length) * (width / 2);
    const ny = ((b.x - a.x) / length) * (width / 2);
    this.fillPolygon(
      [
        { x: a.x + nx, y: a.y + ny },
        { x: b.x + nx, y: b.y + ny },
        { x: b.x - nx, y: b.y - ny },
        { x: a.x - nx, y: a.y - ny }
      ],
      color
    );
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** Encodes an 8-bit RGBA PNG. */
export function encodePng(raster: Raster): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(raster.width, 0);
  header.writeUInt32BE(raster.height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = raster.width * 4;
  const rows = Buffer.alloc((stride + 1) * raster.height);
  for (let y = 0; y < raster.height; y += 1) rows.set(raster.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function composite(width: number, height: number, layers: readonly Raster[]): Raster {
  const out = new Raster(width, height);
  for (const layer of layers) {
    for (let p = 0; p < width * height; p += 1) {
      const a = layer.data[p * 4 + 3] ?? 0;
      if (a === 0) continue;
      const x = p % width;
      out.blend(x, (p - x) / width, [layer.data[p * 4] ?? 0, layer.data[p * 4 + 1] ?? 0, layer.data[p * 4 + 2] ?? 0, a]);
    }
  }
  return out;
}

export const landmarkFormat = 'aigg.l0-1c.landmarks/0.1';

export function manual(points: Record<string, Point>): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: landmarkFormat,
      markedBy: 'synthetic test',
      landmarks: Object.entries(points).map(([id, point]) => ({ id, visibility: 'visible', confidence: 'high', x: point.x, y: point.y, method: 'synthetic mark', note: 'synthetic' }))
    })
  );
}

export function study(landmarks: Buffer, imageSha: string, scale = 1.2): Buffer {
  return Buffer.from(
    JSON.stringify({
      inputs: { image: { sha256: imageSha }, manualLandmarks: sha256(landmarks) },
      alignment: [{ hypothesis: 'near_is_image_left', fits: [{ name: 'similarity', landmarkSet: 'confidence >= medium', scale: { s1: scale } }] }]
    })
  );
}

/** The C0.5 candidate contract of the control fixtures (synthetic test data, read by path). */
export const c05Contract = fileURLToPath(new URL('../../control/test/fixtures/c05-candidate/rig.contract.json', import.meta.url));

export type InputFiles = { contract: string; concept: string; layers: string; landmarks: string; correspondence: string; layersDir: string };

/** Writes a See-through style result (`<stem>.psd.json`, `<stem>/<tag>.png`, `<stem>/src_img.png`) and the mark files. */
function writeInputs(folder: string, layers: ReadonlyMap<string, Raster>, marks: Record<string, Point>, contract: string, width: number, height: number): InputFiles {
  mkdirSync(folder, { recursive: true });
  const layersDir = join(folder, 'concept test');
  mkdirSync(layersDir);
  const image = encodePng(composite(width, height, [...layers.values()]));
  writeFileSync(join(layersDir, 'src_img.png'), image);
  for (const [tag, raster] of layers) writeFileSync(join(layersDir, `${tag}.png`), encodePng(raster));
  const metadata = join(folder, 'concept test.psd.json');
  writeFileSync(
    metadata,
    JSON.stringify({
      parts: Object.fromEntries([...layers.keys()].map((tag, index) => [tag, { xyxy: [0, 0, width, height], tag, part_id: index, depth_median: 0.95 - index * 0.05 }])),
      frame_size: [width, height]
    })
  );
  const concept = join(folder, 'concept.png');
  writeFileSync(concept, image);
  const landmarkBytes = manual(marks);
  const landmarks = join(folder, 'landmarks-manual.json');
  writeFileSync(landmarks, landmarkBytes);
  const correspondence = join(folder, 'correspondence.json');
  writeFileSync(correspondence, study(landmarkBytes, sha256(image)));
  return { contract, concept, layers: metadata, landmarks, correspondence, layersDir };
}

/** Tiny inputs for the orchestration tests with fake commands: two 8 x 8 layers and one mark. */
export function tinyInputs(folder: string): InputFiles {
  const a = new Raster(8, 8);
  a.fillPolygon(
    [
      { x: 1, y: 1 },
      { x: 6, y: 1 },
      { x: 6, y: 6 },
      { x: 1, y: 6 }
    ],
    [200, 100, 50, 255]
  );
  const b = new Raster(8, 8);
  b.fillCircle({ x: 4, y: 4 }, 2, [20, 40, 200, 255]);
  const contract = join(folder, 'rig.contract.json');
  mkdirSync(folder, { recursive: true });
  writeFileSync(contract, JSON.stringify({ format: 'synthetic test contract' }));
  return writeInputs(
    folder,
    new Map([
      ['body', a],
      ['face', b]
    ]),
    { neck_base: { x: 4, y: 2 } },
    contract,
    8,
    8
  );
}

/**
 * A synthetic full-body See-through result for the real assemble-body command: simple shapes on a 320 x 480 frame, near limbs on
 * the image left. The same shapes and marks as the MVP-A test body of the control package.
 */
export function syntheticBody(folder: string): InputFiles {
  const w = 320;
  const h = 480;
  const marks = {
    head_top: { x: 160, y: 30 },
    neck_base: { x: 160, y: 112 },
    shoulder_image_left: { x: 128, y: 124 },
    sleeve_end_image_right: { x: 197, y: 150 },
    elbow_image_left: { x: 104, y: 190 },
    elbow_image_right: { x: 216, y: 190 },
    wrist_image_left: { x: 92, y: 250 },
    wrist_image_right: { x: 228, y: 250 },
    hip_image_left: { x: 150, y: 262 },
    hip_image_right: { x: 172, y: 262 },
    knee_image_left: { x: 140, y: 350 },
    knee_image_right: { x: 182, y: 350 },
    ankle_image_left: { x: 138, y: 428 },
    ankle_image_right: { x: 184, y: 428 },
    foot_anchor_image_left: { x: 122, y: 458 },
    foot_anchor_image_right: { x: 200, y: 458 }
  };
  const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 }
  ];
  const layer = (): Raster => new Raster(w, h);
  const hairBack = layer();
  hairBack.fillPolygon(
    [
      { x: 120, y: 40 },
      { x: 200, y: 40 },
      { x: 210, y: 170 },
      { x: 110, y: 170 }
    ],
    [90, 120, 40, 255]
  );
  const face = layer();
  face.fillCircle({ x: 160, y: 75 }, 32, [240, 200, 180, 255]);
  const eyes = layer();
  eyes.fillCircle({ x: 150, y: 72 }, 4, [40, 40, 40, 255]);
  eyes.fillCircle({ x: 172, y: 72 }, 4, [40, 40, 40, 255]);
  const hairFront = layer();
  hairFront.fillPolygon(rect(128, 40, 192, 56), [110, 150, 50, 255]);
  const neck = layer();
  neck.fillPolygon(rect(152, 100, 168, 122), [230, 190, 170, 255]);
  const topwear = layer();
  topwear.fillPolygon(
    [
      { x: 130, y: 115 },
      { x: 190, y: 115 },
      { x: 195, y: 240 },
      { x: 125, y: 240 }
    ],
    [240, 240, 245, 255]
  );
  topwear.line({ x: 128, y: 124 }, { x: 120, y: 150 }, 22, [240, 240, 245, 255]);
  topwear.line({ x: 192, y: 124 }, { x: 197, y: 150 }, 22, [240, 240, 245, 255]);
  const handwear = layer();
  for (const [s, e, wr, end] of [
    [marks.shoulder_image_left, marks.elbow_image_left, marks.wrist_image_left, { x: 88, y: 278 }],
    [{ x: 196, y: 126 }, marks.elbow_image_right, marks.wrist_image_right, { x: 232, y: 278 }]
  ] as const) {
    handwear.line(s, e, 16, [235, 195, 170, 255]);
    handwear.line(e, wr, 14, [235, 195, 170, 255]);
    handwear.line(wr, end, 14, [40, 60, 150, 255]);
  }
  const bottomwear = layer();
  bottomwear.fillPolygon(
    [
      { x: 125, y: 228 },
      { x: 195, y: 228 },
      { x: 212, y: 300 },
      { x: 108, y: 300 }
    ],
    [40, 40, 50, 255]
  );
  const legwear = layer();
  legwear.line({ x: 150, y: 240 }, marks.knee_image_left, 26, [30, 30, 35, 255]);
  legwear.line({ x: 172, y: 240 }, marks.knee_image_right, 26, [30, 30, 35, 255]);
  legwear.line(marks.knee_image_left, marks.ankle_image_left, 20, [30, 30, 35, 255]);
  legwear.line(marks.knee_image_right, marks.ankle_image_right, 20, [30, 30, 35, 255]);
  legwear.line(marks.ankle_image_left, { x: 132, y: 446 }, 16, [30, 30, 35, 255]);
  legwear.line(marks.ankle_image_right, { x: 190, y: 446 }, 16, [30, 30, 35, 255]);
  const footwear = layer();
  footwear.line({ x: 140, y: 420 }, marks.foot_anchor_image_left, 22, [200, 170, 60, 255]);
  footwear.line({ x: 182, y: 420 }, marks.foot_anchor_image_right, 22, [200, 170, 60, 255]);
  const objects = layer();
  objects.line({ x: 225, y: 290 }, { x: 300, y: 150 }, 8, [180, 180, 200, 255]);
  // See-through order (back to front).
  const layers = new Map<string, Raster>([
    ['back hair', hairBack],
    ['objects', objects],
    ['legwear', legwear],
    ['footwear', footwear],
    ['topwear', topwear],
    ['bottomwear', bottomwear],
    ['neck', neck],
    ['handwear', handwear],
    ['face', face],
    ['eyewhite', eyes],
    ['front hair', hairFront]
  ]);
  return writeInputs(folder, layers, marks, c05Contract, w, h);
}

// A fake control command and a fake viewer command. They read their mode from mode.json next to the script (the factory passes
// only a fixed environment) and append each call to calls.log. The fake assemble-body output depends on the input file digests.
const fakeControl = `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mode = JSON.parse(fs.readFileSync(path.join(here, 'mode.json'), 'utf8'));
const args = process.argv.slice(2);
const get = (name) => args[args.indexOf(name) + 1];
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.appendFileSync(path.join(here, 'calls.log'), args[0] + '\\n');
const out = get('--out');
if (args[0] === 'assemble-body') {
  if (mode.assemble === 'sleep') {
    fs.writeFileSync(path.join(here, 'started.json'), JSON.stringify({ pid: process.pid }));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    process.exit(0);
  }
  if (mode.assemble === 'fail') {
    console.log(JSON.stringify({ status: 'FAIL', problems: [{ code: 'E_FAKE', message: 'The fake assembly failed.' }] }));
    process.exit(1);
  }
  fs.mkdirSync(path.join(out, 'spine'), { recursive: true });
  const inputs = ['--contract', '--metadata', '--image', '--landmarks', '--study'].map((name) => hash(get(name)));
  fs.writeFileSync(path.join(out, 'spine', 'skeleton.json'), JSON.stringify({ inputs }));
  fs.writeFileSync(path.join(out, 'character.json'), JSON.stringify({ layers: fs.readdirSync(get('--layers')).sort() }));
  console.log(JSON.stringify({ status: 'PASS', overall: 'WAITING_FOR_SPINE_CLI_VALIDATION' }));
  process.exit(0);
}
if (args[0] === 'spine-validate') {
  if (!fs.existsSync(get('--spine'))) {
    console.log(JSON.stringify({ status: 'ERROR', code: 'E_SPINE_NOT_FOUND', problems: [{ message: 'not found' }] }));
    process.exit(2);
  }
  if (mode.spine === 'fail') {
    console.log(JSON.stringify({ status: 'FAIL' }));
    process.exit(1);
  }
  fs.mkdirSync(path.join(out, 'body', 'export'), { recursive: true });
  fs.writeFileSync(path.join(out, 'body', 'export', 'skeleton.json'), fs.readFileSync(path.join(get('--package'), 'spine', 'skeleton.json')));
  fs.writeFileSync(path.join(out, 'cli-validation.json'), JSON.stringify({ status: 'PASS' }));
  console.log(JSON.stringify({ status: 'PASS', levels: { CLI_VALIDATED: 'PASS' } }));
  process.exit(0);
}
process.exit(2);
`;

const fakeViewer = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.appendFileSync(path.join(here, 'calls.log'), 'viewer-check\\n');
const folder = process.argv[2];
const ok = fs.existsSync(path.join(folder, 'skeleton.json'));
console.log(JSON.stringify({ format: 'aigg.mvp-c.viewer/0.1', status: ok ? 'PASS' : 'FAIL' }));
process.exit(ok ? 0 : 1);
`;

export type Fakes = { folder: string; control: string; viewer: string; spine: string; setMode: (mode: Record<string, string>) => void; calls: () => string[] };

export function fakeTools(folder: string): Fakes {
  mkdirSync(join(folder, 'bin'), { recursive: true });
  // The scripts are in bin/, the mode file and the call log next to it, so that the tool digest (all files of bin/) stays the same.
  const control = join(folder, 'bin', 'control.mjs');
  const viewer = join(folder, 'bin', 'viewer.mjs');
  const spine = join(folder, 'Spine');
  writeFileSync(control, fakeControl);
  writeFileSync(viewer, fakeViewer);
  writeFileSync(spine, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(folder, 'mode.json'), '{}');
  writeFileSync(join(folder, 'calls.log'), '');
  return {
    folder,
    control,
    viewer,
    spine,
    setMode: (mode) => {
      writeFileSync(join(folder, 'mode.json'), JSON.stringify(mode));
    },
    calls: () => readCalls(folder)
  };
}

function readCalls(folder: string): string[] {
  return readFileSync(join(folder, 'calls.log'), 'utf8').split('\n').filter(Boolean);
}
