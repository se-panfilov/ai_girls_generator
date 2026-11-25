import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CommandResult } from '@control/commands';
import { syntheticSheetCommand } from '@control/modularsheet';
import { decodePng, encodePng, pixelHash, sha256 } from '@control/png';
import { ControlError } from '@control/problems';
import { type Raster } from '@control/raster';
import { type ExtractedPart, extractFormat, localJoint, sheetExtractCommand } from '@control/sheetextract';
import { templateCommand } from '@control/template';
import { describe, expect, it } from 'vitest';

import { temporaryDirectory } from './helpers';

// V2-2 tests of the deterministic modular sheet extraction. Synthetic data only (the V2-1 sheet from the T1a mock parts): no art, no network.
// Pixel fidelity is checked on decoded pixels. Determinism is checked on the bytes of the written files.

const contractPath = fileURLToPath(new URL('fixtures/c05-candidate/rig.contract.json', import.meta.url));
const contractBytes = readFileSync(contractPath);
const toolVersion = (JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;
const fixture = syntheticSheetCommand({ contractBytes, toolVersion });
const fixtureFile = (name: string): Buffer => fixture.files.find((file) => file.name === name)?.bytes as Buffer;
const sheetBytes = fixtureFile('synthetic-sheet.png');
const descriptorBytes = fixtureFile('synthetic-sheet.json');
const sheet = decodePng(sheetBytes).raster;

type Box = { x: number; y: number; w: number; h: number };
type Region = { id: string; role: string; slot?: string; box: Box; joints?: Record<string, { x: number; y: number }> };
type Descriptor = { sheet: { sha256: string }; regions: Region[]; absentSlots: string[] } & Record<string, unknown>;
type Manifest = { format: string; parts: ExtractedPart[]; absentSlots: { slot: string; status: string }[]; excludedRegions: { regionId: string; role: string }[]; counts: Record<string, number> };

const descriptor = (): Descriptor => JSON.parse(descriptorBytes.toString('utf8')) as Descriptor;
const bytesOf = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8');
const extract = (options: { descriptor?: Buffer; sheet?: Buffer } = {}): CommandResult =>
  sheetExtractCommand({ contractBytes, descriptorBytes: options.descriptor ?? descriptorBytes, sheetBytes: options.sheet ?? sheetBytes, toolVersion });
const fileIn = (result: CommandResult, name: string): Buffer => result.files.find((file) => file.name === name)?.bytes as Buffer;
const manifestOf = (result: CommandResult): Manifest => JSON.parse(fileIn(result, 'extraction.json').toString('utf8')) as Manifest;
const codesOf = (action: () => unknown): string[] => {
  try {
    action();
  } catch (error) {
    if (error instanceof ControlError) return error.problems.map((item) => item.code);
    throw error;
  }
  return [];
};

const result = extract();
const manifest = manifestOf(result);
const partRegions = descriptor().regions.filter((region) => region.role === 'part');

/** A changed sheet and a descriptor that binds to its new SHA-256. */
function rebind(raster: Raster, change?: (value: Descriptor) => void): { sheet: Buffer; descriptor: Buffer } {
  const png = encodePng(raster);
  const value = descriptor();
  value.sheet.sha256 = sha256(png);
  change?.(value);
  return { sheet: png, descriptor: bytesOf(value) };
}

describe('sheet-extract on the synthetic V2-1 sheet', () => {
  it('extracts the 18 required parts and records the 9 absent optional slots', () => {
    expect(result.report.status).toBe('PASS');
    expect(manifest.format).toBe(extractFormat);
    expect(manifest.parts).toHaveLength(18);
    expect(manifest.absentSlots).toHaveLength(9);
    expect(manifest.absentSlots.every((item) => item.status === 'absent_by_design')).toBe(true);
    expect(manifest.absentSlots.map((item) => item.slot).sort()).toEqual([...descriptor().absentSlots].sort());
    expect(manifest.counts).toEqual({ contractSlots: 27, required: 18, extracted: 18, absentByDesign: 9, excludedRegions: 1 });
    expect(result.files.filter((file) => file.name.startsWith('parts/'))).toHaveLength(18);
  });

  it('gives each part the slot of its descriptor region, and the content of that slot', () => {
    // The T1a mock part of a slot is the source of its sheet region, so equal pixels prove the identity of the slot.
    const template = templateCommand({ contractBytes, toolVersion });
    for (const part of manifest.parts) {
      const region = partRegions.find((item) => item.id === part.regionId) as Region;
      expect(region.slot).toBe(part.slot);
      expect(part.file).toBe(`parts/${part.slot}.png`);
      const mock = template.files.find((file) => file.name === `mock-package/parts/${part.slot}.png`)?.bytes as Buffer;
      expect(pixelHash(decodePng(fileIn(result, part.file)).raster)).toBe(pixelHash(decodePng(mock).raster));
    }
  });

  it('copies the exact RGBA values of each source box (decoded pixels), with the box size', () => {
    for (const part of manifest.parts) {
      const region = partRegions.find((item) => item.id === part.regionId) as Region;
      const raster = decodePng(fileIn(result, part.file)).raster;
      expect(part.sourceBox).toEqual(region.box);
      expect([raster.width, raster.height]).toEqual([region.box.w, region.box.h]);
      expect(part.size).toEqual({ width: region.box.w, height: region.box.h });
      for (let y = 0; y < raster.height; y += 1) {
        for (let x = 0; x < raster.width; x += 1) expect(raster.pixel(x, y)).toEqual(sheet.pixel(region.box.x + x, region.box.y + y));
      }
      expect(part.pixelSha256).toBe(pixelHash(raster));
      expect(part.fileSha256).toBe(sha256(fileIn(result, part.file)));
    }
  });

  it('partitions the sheet: no pixel duplicated, no foreground lost, reference art not a part', () => {
    const owner = new Int32Array(sheet.width * sheet.height);
    for (const part of manifest.parts) {
      const raster = decodePng(fileIn(result, part.file)).raster;
      for (let y = 0; y < raster.height; y += 1) {
        for (let x = 0; x < raster.width; x += 1) if ((raster.pixel(x, y)[3] ?? 0) > 0) owner[(part.sourceBox.y + y) * sheet.width + part.sourceBox.x + x] += 1;
      }
    }
    const reference = descriptor().regions.find((region) => region.role === 'reference') as Region;
    let inParts = 0;
    let inReference = 0;
    for (let y = 0; y < sheet.height; y += 1) {
      for (let x = 0; x < sheet.width; x += 1) {
        const alpha = sheet.pixel(x, y)[3] ?? 0;
        const count = owner[y * sheet.width + x] ?? 0;
        expect(count).toBeLessThanOrEqual(1);
        const inRef = x >= reference.box.x && y >= reference.box.y && x < reference.box.x + reference.box.w && y < reference.box.y + reference.box.h;
        if (alpha === 0) continue;
        if (inRef) {
          expect(count).toBe(0);
          inReference += 1;
        } else {
          expect(count).toBe(1);
          inParts += 1;
        }
      }
    }
    expect(inParts).toBeGreaterThan(0);
    expect(inReference).toBeGreaterThan(0);
    expect(manifest.parts.some((part) => part.regionId === reference.id)).toBe(false);
    expect(manifest.excludedRegions).toEqual([expect.objectContaining({ regionId: 'reference_preview', role: 'reference' })]);
    expect(result.files.some((file) => file.name.includes('reference'))).toBe(false);
  });

  it('transforms the joints to part coordinates exactly and records parts without joints', () => {
    for (const part of manifest.parts) {
      const region = partRegions.find((item) => item.id === part.regionId) as Region;
      if (region.joints === undefined) {
        expect(part.joints).toEqual({ status: 'absent' });
        continue;
      }
      expect(part.joints.status).toBe('supplied');
      const points = part.joints.status === 'supplied' ? part.joints.points : [];
      expect(points.map((point) => point.bone)).toEqual(Object.keys(region.joints).sort());
      for (const point of points) {
        expect(point.sheet).toEqual(region.joints[point.bone]);
        expect(point.local).toEqual({ x: point.sheet.x - region.box.x, y: point.sheet.y - region.box.y });
      }
    }
    // A part without joints in the descriptor.
    const value = descriptor();
    delete (value.regions.find((region) => region.slot === 'torso') as Region).joints;
    const torso = manifestOf(extract({ descriptor: bytesOf(value) })).parts.find((part) => part.slot === 'torso');
    expect(torso?.joints).toEqual({ status: 'absent' });
  });

  it('keeps fractional joints exact (seeded random points)', () => {
    let state = 0x2545f491;
    const random = (): number => {
      state = (state * 1103515245 + 12345) >>> 0;
      return state / 2 ** 32;
    };
    for (let i = 0; i < 2000; i += 1) {
      const box = { x: Math.floor(random() * 8000), y: Math.floor(random() * 8000), w: 1 + Math.floor(random() * 100), h: 1 + Math.floor(random() * 100) };
      const point = { x: box.x + random() * box.w, y: box.y + random() * box.h };
      const local = localJoint(point, box);
      expect(local.x + box.x).toBe(point.x);
      expect(local.y + box.y).toBe(point.y);
      expect(local.x).toBeGreaterThanOrEqual(0);
      expect(local.x).toBeLessThanOrEqual(box.w);
    }
    const value = descriptor();
    const region = value.regions.find((item) => item.slot === 'forearm_near') as Region;
    region.joints = { forearm_near: { x: region.box.x + 10.1, y: region.box.y + 0.3 }, hand_near: { x: region.box.x + region.box.w, y: region.box.y + region.box.h } };
    const part = manifestOf(extract({ descriptor: bytesOf(value) })).parts.find((item) => item.slot === 'forearm_near');
    const points = part?.joints.status === 'supplied' ? part.joints.points : [];
    expect(points.find((point) => point.bone === 'forearm_near')?.local).toEqual({ x: region.box.x + 10.1 - region.box.x, y: region.box.y + 0.3 - region.box.y });
    expect(points.find((point) => point.bone === 'hand_near')?.local).toEqual({ x: region.box.w, y: region.box.h });
  });

  it('is deterministic: the same inputs give the same files, without time stamps or input paths', () => {
    const second = extract();
    expect(second.files.map((file) => [file.name, sha256(file.bytes)])).toEqual(result.files.map((file) => [file.name, sha256(file.bytes)]));
    const text = result.files
      .filter((file) => !file.name.endsWith('.png'))
      .map((file) => file.bytes.toString('utf8'))
      .join('\n');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    expect(text).not.toContain(contractPath);
    const sums = fileIn(result, 'SHA256SUMS').toString('utf8').trim().split('\n');
    expect(sums).toHaveLength(result.files.length - 1);
    for (const line of sums) {
      const [digest, name] = line.split('  ');
      expect(sha256(fileIn(result, name as string))).toBe(digest);
    }
  });
});

describe('sheet-extract alpha behavior', () => {
  it('keeps weak alpha, alpha 254, and the color of transparent pixels, and reports weak alpha', () => {
    const raster = decodePng(sheetBytes).raster;
    const box = (descriptor().regions.find((region) => region.slot === 'torso') as Region).box;
    const at = (x: number, y: number): number => ((box.y + y) * raster.width + box.x + x) * 4;
    raster.data.set([10, 20, 30, 5], at(0, 0));
    raster.data.set([200, 100, 50, 254], at(1, 0));
    raster.data.set([7, 8, 9, 0], at(2, 0));
    const changed = rebind(raster);
    const run = extract(changed);
    expect(run.report.status).toBe('PASS');
    const part = manifestOf(run).parts.find((item) => item.slot === 'torso') as ExtractedPart;
    const out = decodePng(fileIn(run, part.file)).raster;
    expect(out.pixel(0, 0)).toEqual([10, 20, 30, 5]);
    expect(out.pixel(1, 0)).toEqual([200, 100, 50, 254]);
    expect(out.pixel(2, 0)).toEqual([7, 8, 9, 0]);
    expect(part.alpha.weak).toBe(1);
    expect((run.report.weakAlpha as { inParts: number }).inParts).toBe(1);
  });
});

describe('sheet-extract failures', () => {
  it('returns FAIL and no files for a wrong sheet SHA-256', () => {
    const value = descriptor();
    value.sheet.sha256 = '0'.repeat(64);
    const run = extract({ descriptor: bytesOf(value) });
    expect(run.report.status).toBe('FAIL');
    expect(run.report.stage).toBe('sheet-check');
    expect(run.files).toEqual([]);
  });

  it('returns FAIL and no files for foreground outside the regions', () => {
    const raster = decodePng(sheetBytes).raster;
    raster.data.set([255, 0, 0, 255], ((raster.height - 2) * raster.width + raster.width - 2) * 4);
    const run = extract(rebind(raster));
    expect(run.report.status).toBe('FAIL');
    expect(run.files).toEqual([]);
  });

  it('rejects a missing required slot, overlapping boxes, and malformed descriptors', () => {
    const missing = descriptor();
    missing.regions = missing.regions.filter((region) => region.slot !== 'head');
    expect(codesOf(() => extract({ descriptor: bytesOf(missing) }))).toContain('E_SHEET_REQUIRED_MISSING');
    const overlap = descriptor();
    const [a, b] = overlap.regions as [Region, Region];
    b.box = { ...b.box, x: a.box.x + a.box.w - 1, y: a.box.y };
    expect(codesOf(() => extract({ descriptor: bytesOf(overlap) }))).toContain('E_SHEET_BOX_OVERLAP');
    expect(codesOf(() => extract({ descriptor: Buffer.from('{not json') }))).toEqual(['E_SHEET_FORMAT']);
    const badFile = descriptor();
    (badFile.sheet as Record<string, unknown>).file = '../escape.png';
    expect(codesOf(() => extract({ descriptor: bytesOf(badFile) }))).toContain('E_SHEET_FORMAT');
    const badId = descriptor();
    (badId.regions[0] as Region).id = '../parts';
    expect(codesOf(() => extract({ descriptor: bytesOf(badId) }))).toContain('E_SHEET_FORMAT');
  });

  it('names part files by the contract slot, not by the region id', () => {
    const value = descriptor();
    (value.regions.find((region) => region.slot === 'neck') as Region).id = 'zz_other_name';
    const run = extract({ descriptor: bytesOf(value) });
    expect(run.files.map((file) => file.name)).toContain('parts/neck.png');
    expect(run.files.some((file) => file.name.includes('zz_other_name'))).toBe(false);
  });
});

describe('sheet-extract CLI', () => {
  const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
  const runCli = (args: string[]): { status: number | null; report: Record<string, unknown> } => {
    const out = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    return { status: out.status, report: JSON.parse(out.stdout || out.stderr) as Record<string, unknown> };
  };
  const setup = (): { dir: string; args: (out: string, descriptorPath?: string) => string[] } => {
    const dir = temporaryDirectory();
    writeFileSync(join(dir, 'sheet.png'), sheetBytes);
    writeFileSync(join(dir, 'sheet.json'), descriptorBytes);
    return {
      dir,
      args: (out, descriptorPath = join(dir, 'sheet.json')) => ['sheet-extract', '--contract', contractPath, '--descriptor', descriptorPath, '--sheet', join(dir, 'sheet.png'), '--out', out]
    };
  };
  const tree = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();

  it('publishes the same files in two runs and writes nothing in a dry run', () => {
    const { dir, args } = setup();
    const first = runCli(args(join(dir, 'a')));
    const second = runCli(args(join(dir, 'b')));
    expect(first.status).toBe(0);
    expect(first.report.written).toBe(true);
    expect(second.status).toBe(0);
    expect(tree(join(dir, 'a'))).toEqual(tree(join(dir, 'b')));
    for (const name of tree(join(dir, 'a')).filter((item) => item.includes('.'))) expect(readFileSync(join(dir, 'a', name))).toEqual(readFileSync(join(dir, 'b', name)));
    expect(tree(join(dir, 'a')).filter((name) => name.startsWith('parts/'))).toHaveLength(18);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const dry = runCli([...args(join(dir, 'c')), '--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.report.written).toBe(false);
    expect(existsSync(join(dir, 'c'))).toBe(false);
  });

  it('publishes into an empty directory, but refuses a non-empty directory and --force', () => {
    const { dir, args } = setup();
    mkdirSync(join(dir, 'empty'));
    expect(runCli(args(join(dir, 'empty'))).status).toBe(0);
    const again = runCli(args(join(dir, 'empty')));
    expect(again.status).toBe(2);
    expect(again.report.code).toBe('E_OUTPUT_EXISTS');
    const forced = runCli([...args(join(dir, 'empty')), '--force']);
    expect(forced.status).toBe(2);
    expect(forced.report.code).toBe('E_USAGE');
  });

  it('writes nothing when the descriptor or the sheet fails', () => {
    const { dir, args } = setup();
    const wrongHash = descriptor();
    wrongHash.sheet.sha256 = 'f'.repeat(64);
    writeFileSync(join(dir, 'wrong.json'), JSON.stringify(wrongHash));
    const failed = runCli(args(join(dir, 'out1'), join(dir, 'wrong.json')));
    expect(failed.status).toBe(1);
    expect(failed.report.written).toBe(false);
    expect(existsSync(join(dir, 'out1'))).toBe(false);
    const missing = descriptor();
    missing.regions = missing.regions.filter((region) => region.slot !== 'torso');
    writeFileSync(join(dir, 'missing.json'), JSON.stringify(missing));
    const error = runCli(args(join(dir, 'out2'), join(dir, 'missing.json')));
    expect(error.status).toBe(2);
    expect(error.report.code).toBe('E_SHEET_REQUIRED_MISSING');
    expect(existsSync(join(dir, 'out2'))).toBe(false);
  });
});
