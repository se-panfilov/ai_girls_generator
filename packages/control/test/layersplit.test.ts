import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drawOrder, parseSeeThroughMetadata, splitLayersCommand } from '@control/layersplit';
import { decodePng, encodePng, sha256 } from '@control/png';
import { ControlError } from '@control/problems';
import { Raster } from '@control/raster';
import { describe, expect, it } from 'vitest';

import { temporaryDirectory } from './helpers';

// L0-1b split-layers tests with a synthetic See-through run (simple shapes on a 96 x 128 frame). No real character image is used.

const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const width = 96;
const height = 128;

type Rect = { x: number; y: number; w: number; h: number; alpha?: number };

function shapes(rects: readonly Rect[], seed: number): Raster {
  const raster = new Raster(width, height);
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) raster.data.set([(x * 3 + seed) & 255, (y * 2 + seed) & 255, seed & 255, rect.alpha ?? 255], (y * width + x) * 4);
    }
  }
  return raster;
}

// Draw order by depth: back hair (far) ... handwear (near).
const layers: Record<string, { depth: number; rects: Rect[] }> = {
  'back hair': { depth: 0.95, rects: [{ x: 30, y: 2, w: 36, h: 50 }] },
  legwear: {
    depth: 0.7,
    rects: [
      { x: 30, y: 62, w: 36, h: 20 },
      { x: 30, y: 82, w: 10, h: 30 },
      { x: 56, y: 82, w: 10, h: 30 }
    ]
  },
  footwear: {
    depth: 0.69,
    rects: [
      { x: 28, y: 110, w: 16, h: 8 },
      { x: 52, y: 110, w: 16, h: 8 }
    ]
  },
  topwear: { depth: 0.68, rects: [{ x: 34, y: 30, w: 28, h: 30 }] },
  bottomwear: { depth: 0.65, rects: [{ x: 28, y: 58, w: 40, h: 24 }] },
  handwear: {
    depth: 0.5,
    rects: [
      { x: 20, y: 30, w: 8, h: 40 },
      { x: 68, y: 30, w: 8, h: 40 },
      { x: 28, y: 40, w: 40, h: 2, alpha: 10 }
    ]
  }
};

function metadataBytes(skip: readonly string[] = []): Buffer {
  const parts: Record<string, unknown> = {};
  Object.entries(layers).forEach(([tag, layer], index) => {
    if (skip.includes(tag)) return;
    const xs = layer.rects.flatMap((rect) => [rect.x, rect.x + rect.w]);
    const ys = layer.rects.flatMap((rect) => [rect.y, rect.y + rect.h]);
    parts[tag] = { xyxy: [Math.min(...xs) + 1, Math.min(...ys), Math.max(...xs), Math.max(...ys)], tag, part_id: index, depth_median: layer.depth };
  });
  return Buffer.from(JSON.stringify({ parts, frame_size: [width, height] }));
}

function layerFiles(): Map<string, { name: string; bytes: Buffer }> {
  return new Map(Object.entries(layers).map(([tag, layer], index) => [tag, { name: `${tag}.png`, bytes: encodePng(shapes(layer.rects, 40 + index * 30)) }]));
}

const codeOf = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    if (error instanceof ControlError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

type Report = {
  status: string;
  spineReady: boolean;
  drawOrder: { order: string[] };
  analysis: { layer: string; alphaXyxy: number[]; xyxyDelta: number[]; pixelsOutsideMetadataXyxy: number; overlaps: { layer: string; sharedPixels: number }[] }[];
  splits: {
    layer: string;
    status: string;
    method: string;
    conservation: { exact: boolean; lostPixels: number };
    parts: { part: string; alphaXyxy: number[]; sourceLayer: string; sourceFile: { sha256: string }; file: { name: string } }[];
    residual: { kind: string; area: number }[];
  }[];
  checks: { id: string; pass: boolean }[];
  motion: { layer: string; status: string }[];
};

describe('parseSeeThroughMetadata', () => {
  it('reads the parts and derives the draw order from depth_median', () => {
    const metadata = parseSeeThroughMetadata(metadataBytes());
    expect(metadata.frame).toEqual({ width, height });
    expect(drawOrder(metadata)).toEqual(['back hair', 'legwear', 'footwear', 'topwear', 'bottomwear', 'handwear']);
  });

  it('refuses invalid metadata', () => {
    expect(codeOf(() => parseSeeThroughMetadata(Buffer.from('{')))).toBe('E_METADATA');
    expect(codeOf(() => parseSeeThroughMetadata(Buffer.from('{"parts":{},"frame_size":[10,10]}')))).toBe('E_METADATA');
    expect(codeOf(() => parseSeeThroughMetadata(Buffer.from('{"parts":{"../x":{"tag":"../x","xyxy":[0,0,1,1],"part_id":0,"depth_median":1}},"frame_size":[10,10]}')))).toBe('E_METADATA');
    expect(codeOf(() => parseSeeThroughMetadata(Buffer.from('{"parts":{"a":{"tag":"a","xyxy":[0,0,1],"part_id":0,"depth_median":1}},"frame_size":[10,10]}')))).toBe('E_METADATA');
  });
});

describe('splitLayersCommand', () => {
  const result = splitLayersCommand({ metadataBytes: metadataBytes(), metadataName: 'synthetic.psd.json', layerFiles: layerFiles(), toolVersion: '0.0.0-test' });
  const file = (name: string): Buffer => {
    const found = result.files.find((item) => item.name === name);
    if (!found) throw new Error(`missing ${name}`);
    return found.bytes;
  };
  const report = JSON.parse(file('l0-1b.json').toString('utf8')) as Report;

  it('passes the automatic checks and is marked as a prototype', () => {
    expect(report.status).toBe('PASS');
    expect(report.spineReady).toBe(false);
    expect(report.checks.every((check) => check.pass)).toBe(true);
  });

  it('splits arms by alpha threshold, legs by scan rows, and feet by components', () => {
    const byLayer = Object.fromEntries(report.splits.map((split) => [split.layer, split]));
    expect(byLayer.handwear?.method).toBe('alpha_threshold');
    expect(byLayer.legwear?.method).toBe('scan_rows');
    expect(byLayer.footwear?.method).toBe('components');
    expect(byLayer.legwear?.residual.find((item) => item.kind === 'merged')?.area).toBe(36 * 20);
    expect(report.splits.every((split) => split.conservation.exact)).toBe(true);
  });

  it('records exact bounds, provenance, and metadata deviations', () => {
    const feet = report.splits.find((split) => split.layer === 'footwear');
    expect(feet?.parts.map((part) => part.alphaXyxy)).toEqual([
      [28, 110, 44, 118],
      [52, 110, 68, 118]
    ]);
    expect(feet?.parts[0]?.sourceFile.sha256).toBe(sha256(layerFiles().get('footwear')?.bytes as Buffer));
    const legs = report.analysis.find((item) => item.layer === 'legwear');
    expect(legs?.xyxyDelta).toEqual([-1, 0, 0, 0]);
    expect(legs?.pixelsOutsideMetadataXyxy).toBe(50);
    expect(legs?.overlaps.find((item) => item.layer === 'bottomwear')?.sharedPixels).toBe(36 * 20);
  });

  it('writes part files with the source pixels on the full canvas', () => {
    const part = decodePng(file('parts/footwear.foot_image_left.png')).raster;
    const source = shapes(layers.footwear?.rects ?? [], 40 + 2 * 30);
    expect(part.width).toBe(width);
    expect(part.pixel(30, 112)).toEqual(source.pixel(30, 112));
    expect(part.pixel(60, 112)).toEqual([0, 0, 0, 0]);
    expect(result.files.map((item) => item.name)).toContain('contact-sheet.png');
    expect(report.motion.every((item) => item.status === 'run')).toBe(true);
  });

  it('refuses a missing analyzed layer and a wrong layer size', () => {
    const missing = layerFiles();
    missing.delete('topwear');
    expect(codeOf(() => splitLayersCommand({ metadataBytes: metadataBytes(), metadataName: 'm', layerFiles: missing, toolVersion: 't' }))).toBe('E_LAYER');
    const wrong = layerFiles();
    wrong.set('topwear', { name: 'topwear.png', bytes: encodePng(new Raster(10, 10)) });
    expect(codeOf(() => splitLayersCommand({ metadataBytes: metadataBytes(), metadataName: 'm', layerFiles: wrong, toolVersion: 't' }))).toBe('E_LAYER');
  });
});

describe('split-layers CLI', () => {
  it('reads the inputs without a change and refuses a non-empty output directory', () => {
    const root = temporaryDirectory();
    const input = join(root, 'run');
    mkdirSync(input);
    const metadataPath = join(input, 'concept.psd.json');
    writeFileSync(metadataPath, metadataBytes());
    for (const [, item] of layerFiles()) writeFileSync(join(input, item.name), item.bytes);
    const before = Object.fromEntries([...layerFiles().values()].map((item) => [item.name, sha256(readFileSync(join(input, item.name)))]));
    const out = join(root, 'out');
    const run = spawnSync(process.execPath, [cli, 'split-layers', '--layers', input, '--metadata', metadataPath, '--out', out], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect((JSON.parse(run.stdout) as { status: string }).status).toBe('PASS');
    const after = Object.fromEntries([...layerFiles().values()].map((item) => [item.name, sha256(readFileSync(join(input, item.name)))]));
    expect(after).toEqual(before);
    expect(JSON.parse(readFileSync(join(out, 'l0-1b.json'), 'utf8'))).toMatchObject({ status: 'PASS', prototype: true });
    const again = spawnSync(process.execPath, [cli, 'split-layers', '--layers', input, '--metadata', metadataPath, '--out', out], { encoding: 'utf8' });
    expect(again.status).toBe(2);
    expect((JSON.parse(again.stdout) as { code: string }).code).toBe('E_OUTPUT_EXISTS');
  });
});
