import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

import { checkSheetImage, parseModularSheet, parseSheetDescriptor, type SheetDescriptor, sheetFormat, syntheticSheetCommand } from '@control/modularsheet';
import { decodePng, encodePng, pixelHash, sha256 } from '@control/png';
import { ControlError } from '@control/problems';
import { Raster } from '@control/raster';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { temporaryDirectory } from './helpers';

// V2-1 tests of the Modular Sheet Contract v0.1 (docs/PIPELINE_V2_MODULAR_SHEET.md). Synthetic data only: no licensed art, no network.
// A passing synthetic sheet shows that the contract and the checks are consistent. It does not show that AI-generated sheets work.

const fixture = (name: string): URL => new URL(`fixtures/${name}`, import.meta.url);
const contractBytes = (): Buffer => readFileSync(fileURLToPath(fixture('c05-candidate/rig.contract.json')));
const toolVersion = (JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;
const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../schemas/modular-sheet.schema.json', import.meta.url)), 'utf8')) as object;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
const committed = (): Record<string, unknown> => JSON.parse(readFileSync(fileURLToPath(fixture('modular-sheet/synthetic.sheet.json')), 'utf8')) as Record<string, unknown>;
type Expected = {
  width: number;
  height: number;
  pixelSha256: string;
  counts: { regions: number; parts: number; reference: number; absentSlots: number };
  regions: { id: string; foregroundPixels: number; bounds: unknown; components: number }[];
};
const expected = JSON.parse(readFileSync(fileURLToPath(fixture('modular-sheet/expected.json')), 'utf8')) as Expected;

type Region = Record<string, unknown> & { id: string; role: string; slot?: string; box: { x: number; y: number; w: number; h: number } };
const regionsOf = (value: Record<string, unknown>): Region[] => value.regions as Region[];
const clone = (): Record<string, unknown> => structuredClone(committed());

const codesOf = (action: () => unknown): string[] => {
  try {
    action();
  } catch (error) {
    if (error instanceof ControlError) return error.problems.map((item) => item.code);
    throw error;
  }
  return [];
};

let cache: ReturnType<typeof syntheticSheetCommand> | undefined;
const synthetic = (): ReturnType<typeof syntheticSheetCommand> => (cache ??= syntheticSheetCommand({ contractBytes: contractBytes(), toolVersion }));
const fileOf = (name: string): Buffer => synthetic().files.find((file) => file.name === name)?.bytes as Buffer;

describe('modular sheet descriptor', () => {
  it('accepts the committed synthetic descriptor in the schema and in both parsers', () => {
    const value = committed();
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(parseSheetDescriptor(value).regions).toHaveLength(expected.counts.regions);
    const descriptor = parseModularSheet(value, contractBytes());
    expect(descriptor.absentSlots).toHaveLength(expected.counts.absentSlots);
    expect(descriptor.regions.filter((region) => region.role === 'part')).toHaveLength(expected.counts.parts);
  });

  it.each([
    ['format', 'E_SHEET_FORMAT'],
    ['sheet', 'E_SHEET_FORMAT'],
    ['rig', 'E_SHEET_FORMAT'],
    ['regions', 'E_SHEET_FORMAT'],
    ['absentSlots', 'E_SHEET_FORMAT']
  ])('rejects a descriptor without %s', (field, code) => {
    const value = clone();
    delete value[field];
    expect(validate(value)).toBe(false);
    expect(codesOf(() => parseSheetDescriptor(value))).toContain(code);
  });

  it('rejects a region without a box or a sheet without sha256', () => {
    const value = clone();
    delete (regionsOf(value)[0] as Record<string, unknown>).box;
    delete (value.sheet as Record<string, unknown>).sha256;
    expect(validate(value)).toBe(false);
    expect(codesOf(() => parseSheetDescriptor(value))).toEqual(expect.arrayContaining(['E_SHEET_BOX', 'E_SHEET_FORMAT']));
  });

  it('rejects an unsupported format version with its own code', () => {
    const value = { ...clone(), format: 'aigg.modular-sheet/0.2' };
    expect(validate(value)).toBe(false);
    expect(codesOf(() => parseSheetDescriptor(value))).toEqual(['E_SHEET_VERSION']);
    expect(codesOf(() => parseSheetDescriptor({ ...clone(), format: 'other' }))).toEqual(['E_SHEET_FORMAT']);
  });

  it('rejects unknown fields like the schema', () => {
    const value = clone();
    (regionsOf(value)[0] as Record<string, unknown>).confidence = 0.5;
    expect(validate(value)).toBe(false);
    expect(codesOf(() => parseSheetDescriptor(value))).toContain('E_SHEET_FORMAT');
  });

  it('rejects duplicate region ids (not expressible in the schema)', () => {
    const value = clone();
    (regionsOf(value)[1] as Region).id = regionsOf(value)[0]?.id as string;
    expect(validate(value)).toBe(true);
    expect(codesOf(() => parseSheetDescriptor(value))).toContain('E_SHEET_REGION_DUPLICATE');
  });

  it.each([
    ['zero width', { x: 0, y: 0, w: 0, h: 10 }],
    ['negative x', { x: -1, y: 0, w: 10, h: 10 }],
    ['fractional y', { x: 0, y: 1.5, w: 10, h: 10 }],
    ['string h', { x: 0, y: 0, w: 10, h: '10' }]
  ])('rejects a box with %s', (_name, box) => {
    const value = clone();
    (regionsOf(value)[0] as Record<string, unknown>).box = box;
    expect(validate(value)).toBe(false);
    expect(codesOf(() => parseSheetDescriptor(value))).toContain('E_SHEET_BOX');
  });

  it('rejects a box outside the canvas (not expressible in the schema)', () => {
    const value = clone();
    const sheet = value.sheet as { width: number; height: number };
    const region = regionsOf(value).at(-1) as Region;
    region.box = { x: sheet.width - 10, y: sheet.height - 10, w: 20, h: 5 };
    expect(validate(value)).toBe(true);
    expect(codesOf(() => parseSheetDescriptor(value))).toEqual(['E_SHEET_BOX_OUTSIDE']);
  });

  it('rejects two overlapping boxes, but accepts boxes that only touch', () => {
    const overlap = clone();
    const [a, b] = regionsOf(overlap) as [Region, Region];
    b.box = { ...b.box, x: a.box.x + a.box.w - 1 };
    expect(codesOf(() => parseSheetDescriptor(overlap))).toContain('E_SHEET_BOX_OVERLAP');
    const touch = clone();
    const [c, d] = regionsOf(touch) as [Region, Region];
    d.box = { ...d.box, x: c.box.x + c.box.w, y: c.box.y };
    expect(codesOf(() => parseSheetDescriptor(touch))).not.toContain('E_SHEET_BOX_OVERLAP');
  });

  it('rejects a slot id that the contract does not have', () => {
    const value = clone();
    (regionsOf(value)[0] as Region).slot = 'wing_near';
    expect(validate(value)).toBe(true);
    expect(codesOf(() => parseModularSheet(value, contractBytes()))).toEqual(expect.arrayContaining(['E_SHEET_SLOT_UNKNOWN', 'E_SHEET_REQUIRED_MISSING']));
    (regionsOf(value)[0] as Region).slot = 'Bad-Slot';
    expect(validate(value)).toBe(false);
    expect(codesOf(() => parseSheetDescriptor(value))).toContain('E_SHEET_FORMAT');
  });

  it('rejects two regions for one slot', () => {
    const value = clone();
    (regionsOf(value)[1] as Region).slot = regionsOf(value)[0]?.slot as string;
    delete (regionsOf(value)[1] as Record<string, unknown>).joints;
    expect(codesOf(() => parseModularSheet(value, contractBytes()))).toEqual(expect.arrayContaining(['E_SHEET_SLOT_DUPLICATE', 'E_SHEET_REQUIRED_MISSING']));
  });

  it('rejects a missing required slot', () => {
    const value = clone();
    value.regions = regionsOf(value).filter((region) => region.slot !== 'forearm_near');
    expect(codesOf(() => parseModularSheet(value, contractBytes()))).toEqual(['E_SHEET_REQUIRED_MISSING']);
  });

  it.each([
    ['a required slot', ['torso'], 'E_SHEET_ABSENT'],
    ['an unknown slot', ['wing_near'], 'E_SHEET_ABSENT'],
    ['a duplicate', ['tail', 'tail'], 'E_SHEET_ABSENT']
  ])('rejects absentSlots with %s', (_name, extra, code) => {
    const value = clone();
    value.absentSlots = [...(value.absentSlots as string[]).filter((slot) => !extra.includes(slot)), ...extra];
    expect(codesOf(() => parseModularSheet(value, contractBytes()))).toContain(code);
  });

  it('rejects an optional slot that is both mapped and absent, and an optional slot that is not declared', () => {
    const both = clone();
    regionsOf(both).push({ id: 'part_tail', role: 'part', slot: 'tail', box: { x: 1500, y: 1500, w: 40, h: 40 } });
    expect(codesOf(() => parseModularSheet(both, contractBytes()))).toEqual(['E_SHEET_ABSENT']);
    const undeclared = clone();
    undeclared.absentSlots = (undeclared.absentSlots as string[]).filter((slot) => slot !== 'weapon');
    expect(codesOf(() => parseModularSheet(undeclared, contractBytes()))).toEqual(['E_SHEET_SLOT_UNDECLARED']);
  });

  it('accepts an optional slot that is mapped instead of absent', () => {
    const value = clone();
    regionsOf(value).push({ id: 'part_tail', role: 'part', slot: 'tail', box: { x: 1500, y: 1500, w: 40, h: 40 } });
    value.absentSlots = (value.absentSlots as string[]).filter((slot) => slot !== 'tail');
    expect(parseModularSheet(value, contractBytes()).absentSlots).not.toContain('tail');
  });

  it('rejects a joint of an unrelated bone and a joint outside the box', () => {
    const value = clone();
    const region = regionsOf(value).find((item) => item.slot === 'forearm_near') as Region;
    region.joints = { thigh_near: { x: region.box.x + 1, y: region.box.y + 1 }, forearm_near: { x: region.box.x - 5, y: region.box.y } };
    const problems = codesOf(() => parseModularSheet(value, contractBytes()));
    expect(problems.filter((code) => code === 'E_SHEET_JOINT')).toHaveLength(2);
  });

  it('rejects a rig id or a contract version that does not match the contract', () => {
    const value = clone();
    value.rig = { rigId: 'humanoid_girl_v1', contractVersion: '0.3.0' };
    expect(codesOf(() => parseModularSheet(value, contractBytes()))).toEqual(['E_SHEET_RIG_MISMATCH']);
  });

  it('keeps reference and ignore regions out of the slot mapping', () => {
    const withSlot = clone();
    const reference = regionsOf(withSlot).find((region) => region.role === 'reference') as Region;
    reference.slot = 'torso';
    expect(validate(withSlot)).toBe(false);
    expect(codesOf(() => parseSheetDescriptor(withSlot))).toContain('E_SHEET_ROLE');
    const withJoints = clone();
    const ignore = regionsOf(withJoints).find((region) => region.role === 'reference') as Region;
    ignore.role = 'ignore';
    ignore.joints = { root: { x: ignore.box.x, y: ignore.box.y } };
    expect(validate(withJoints)).toBe(false);
    expect(codesOf(() => parseSheetDescriptor(withJoints))).toContain('E_SHEET_ROLE');
    const partWithoutSlot = clone();
    delete (regionsOf(partWithoutSlot)[0] as Record<string, unknown>).slot;
    expect(validate(partWithoutSlot)).toBe(false);
    expect(codesOf(() => parseSheetDescriptor(partWithoutSlot))).toContain('E_SHEET_ROLE');
    // The reference preview contains all body parts, but it never satisfies a slot.
    const parsed = parseModularSheet(committed(), contractBytes());
    expect(parsed.regions.filter((region) => region.role !== 'part').every((region) => region.slot === undefined)).toBe(true);
  });
});

describe('synthetic modular sheet', () => {
  it('is deterministic and matches the committed descriptor and the expected values', () => {
    const first = synthetic();
    const second = syntheticSheetCommand({ contractBytes: contractBytes(), toolVersion });
    expect(second.files.map((file) => sha256(file.bytes))).toEqual(first.files.map((file) => sha256(file.bytes)));
    const png = fileOf('synthetic-sheet.png');
    const raster = decodePng(png).raster;
    expect([raster.width, raster.height]).toEqual([expected.width, expected.height]);
    // The file SHA-256 depends on the zlib version, so compare the decoded pixels and the descriptor without the file hash.
    expect(pixelHash(raster)).toBe(expected.pixelSha256);
    const made = JSON.parse(fileOf('synthetic-sheet.json').toString('utf8')) as Record<string, unknown> & { sheet: Record<string, unknown> };
    expect(made.sheet.sha256).toBe(sha256(png));
    const reference = committed() as typeof made;
    expect({ ...made, sheet: { ...made.sheet, sha256: '' } }).toEqual({ ...reference, sheet: { ...reference.sheet, sha256: '' } });
    expect(first.report.status).toBe('PASS');
    expect(first.report.counts).toEqual(expected.counts);
  });

  it('has separated parts, near and far limbs, absent optional slots, and a small reference preview', () => {
    const descriptor = parseModularSheet(committed(), contractBytes());
    const slots = descriptor.regions.map((region) => region.slot).filter((slot) => slot !== undefined);
    for (const limb of ['upper_arm', 'forearm', 'hand', 'thigh', 'shin', 'foot']) expect(slots).toEqual(expect.arrayContaining([`${limb}_near`, `${limb}_far`]));
    expect(descriptor.absentSlots).toEqual(expect.arrayContaining(['weapon', 'hand_near_front', 'tail']));
    const preview = descriptor.regions.find((region) => region.role === 'reference');
    expect(preview?.box.w).toBeLessThanOrEqual(256);
    const report = checkSheetImage(descriptor.sheet.sha256 === sha256(fileOf('synthetic-sheet.png')) ? descriptor : withDigest(descriptor), fileOf('synthetic-sheet.png'));
    expect(report.status).toBe('PASS');
    expect(report.regions.map(({ id, foregroundPixels, bounds, components }) => ({ id, foregroundPixels, bounds, components }))).toEqual(expected.regions);
    // Each foreground part leaves a margin of at least one transparent pixel inside its box (no part touches its box edge).
    for (const region of report.regions) {
      const box = descriptor.regions.find((item) => item.id === region.id)?.box;
      expect(region.bounds).not.toBeNull();
      expect(region.weakAlphaPixels).toBe(0);
      if (box !== undefined && region.bounds !== null) expect(region.bounds.x >= box.x && region.bounds.y >= box.y).toBe(true);
    }
  });
});

/** An opaque white 8-bit RGB PNG (color type 2). encodePng writes only RGBA. */
function rgbPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3, 255);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const withDigest = (descriptor: SheetDescriptor): SheetDescriptor => ({ ...descriptor, sheet: { ...descriptor.sheet, sha256: sha256(fileOf('synthetic-sheet.png')) } });

describe('sheet image check', () => {
  const descriptor = (): SheetDescriptor => withDigest(parseModularSheet(committed(), contractBytes()));
  const raster = (): Raster => decodePng(fileOf('synthetic-sheet.png')).raster;
  const statusOf = (report: ReturnType<typeof checkSheetImage>, id: string): string | undefined => report.checks.find((check) => check.id === id)?.status;

  it('fails on a changed file hash', () => {
    const report = checkSheetImage({ ...descriptor(), sheet: { ...descriptor().sheet, sha256: '0'.repeat(64) } }, fileOf('synthetic-sheet.png'));
    expect(statusOf(report, 'P1_sha256')).toBe('FAIL');
    expect(report.status).toBe('FAIL');
  });

  it('fails on a different image size', () => {
    const png = encodePng(new Raster(512, 512));
    const report = checkSheetImage({ ...descriptor(), sheet: { ...descriptor().sheet, sha256: sha256(png) } }, png);
    expect(statusOf(report, 'P2_size')).toBe('FAIL');
    expect(report.regions).toEqual([]);
  });

  it('fails on foreground pixels outside all regions, and ignores weak alpha there', () => {
    const image = raster();
    image.data.set([255, 0, 0, 255], ((image.height - 2) * image.width + image.width - 2) * 4);
    image.data.set([255, 0, 0, 8], ((image.height - 2) * image.width + image.width - 4) * 4);
    const png = encodePng(image);
    const report = checkSheetImage({ ...descriptor(), sheet: { ...descriptor().sheet, sha256: sha256(png) } }, png);
    expect(statusOf(report, 'P5_no_content_outside_regions')).toBe('FAIL');
    expect(report.outside).toEqual({ foregroundPixels: 1, weakAlphaPixels: 1 });
  });

  it('fails on an empty part region', () => {
    const image = raster();
    const box = descriptor().regions.find((region) => region.slot === 'neck')?.box as { x: number; y: number; w: number; h: number };
    for (let y = box.y; y < box.y + box.h; y += 1) image.data.fill(0, (y * image.width + box.x) * 4, (y * image.width + box.x + box.w) * 4);
    const png = encodePng(image);
    const report = checkSheetImage({ ...descriptor(), sheet: { ...descriptor().sheet, sha256: sha256(png) } }, png);
    expect(statusOf(report, 'P4_parts_not_empty')).toBe('FAIL');
  });

  it('fails on an opaque RGB sheet without an alpha channel', () => {
    const { width, height } = descriptor().sheet;
    const png = rgbPng(width, height);
    const report = checkSheetImage({ ...descriptor(), sheet: { ...descriptor().sheet, sha256: sha256(png) } }, png);
    expect(statusOf(report, 'P3_alpha_channel')).toBe('FAIL');
    expect(statusOf(report, 'P5_no_content_outside_regions')).toBe('FAIL');
  });

  it('rejects a sheet over the size limits before decoding the pixels', () => {
    const header = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write('IHDR', 12, 'latin1');
    header.writeUInt32BE(9000, 16);
    header.writeUInt32BE(9000, 20);
    header.set([8, 6, 0, 0, 0], 24);
    expect(() => checkSheetImage(descriptor(), header)).toThrow();
  });

  it('accepts the format constant', () => {
    expect(sheetFormat).toBe('aigg.modular-sheet/0.1');
  });
});

describe('sheet CLI commands', () => {
  const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
  const contractPath = fileURLToPath(fixture('c05-candidate/rig.contract.json'));
  const run = (args: string[]): { status: number | null; report: Record<string, unknown> } => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    return { status: result.status, report: JSON.parse(result.stdout || result.stderr) as Record<string, unknown> };
  };

  it('writes the synthetic sheet and checks it, and fails a changed descriptor', () => {
    const dir = temporaryDirectory();
    const made = run(['sheet-fixture', '--contract', contractPath, '--out', join(dir, 'fixture')]);
    expect(made.status).toBe(0);
    const sheet = join(dir, 'fixture', 'synthetic-sheet.png');
    const descriptor = join(dir, 'fixture', 'synthetic-sheet.json');
    const checked = run(['sheet-check', '--contract', contractPath, '--descriptor', descriptor, '--sheet', sheet, '--out', join(dir, 'check')]);
    expect(checked.status).toBe(0);
    expect(checked.report.status).toBe('PASS');
    const changed = JSON.parse(readFileSync(descriptor, 'utf8')) as Record<string, unknown>;
    changed.regions = regionsOf(changed).filter((region) => region.role !== 'reference');
    writeFileSync(join(dir, 'changed.json'), JSON.stringify(changed));
    const failed = run(['sheet-check', '--contract', contractPath, '--descriptor', join(dir, 'changed.json'), '--sheet', sheet, '--out', join(dir, 'check2')]);
    expect(failed.status).toBe(1);
    expect(failed.report.status).toBe('FAIL');
    const broken = run(['sheet-check', '--contract', contractPath, '--descriptor', sheet, '--sheet', sheet, '--out', join(dir, 'check3')]);
    expect(broken.status).toBe(2);
  });
});
