import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseContractBytes } from '@control/commands';
import { cameraOf, depthAssumptions } from '@control/depth';
import { pelvisBottomUp } from '@control/mannequin';
import { decodePng, sha256 } from '@control/png';
import { fitTransform, toContract, toTarget } from '@control/pose';
import { ControlError } from '@control/problems';
import { castOwnership, modeledSlots, notModeledSlots, templateCommand } from '@control/template';
import { describe, expect, it } from 'vitest';

import { bytesOf, temporaryDirectory } from './helpers';

// T1a acceptance tests (docs/proposals/T0_TEMPLATE_FIRST_ARCHITECTURE.md, section 16.4).
// They run on the C0.5 candidate fixture (prototype geometry) and on changed copies of it. Passing tests do not show production compatibility.

const fixturePath = fileURLToPath(new URL('fixtures/c05-candidate/rig.contract.json', import.meta.url));
const candidateBytes = (): Buffer => readFileSync(fixturePath);
const candidate = (): Record<string, unknown> => JSON.parse(candidateBytes().toString('utf8')) as Record<string, unknown>;
const toolVersion = (JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;
const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const parserBridge = fileURLToPath(new URL('rig-runtime/parse-character.mjs', import.meta.url));
const size = '416x624';

const codeOf = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    if (error instanceof ControlError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

type SlotReport = {
  slot: string;
  bone: string;
  drawOrder: number;
  required: boolean;
  geometry: 'modeled' | 'not_modeled';
  regionColor: [number, number, number];
  attachmentRect: { x: number; y: number; w: number; h: number };
  overlaps: { childBone: string; radiusPx: number; center: { x: number; y: number } }[];
  visibleMask: string | null;
  mockPart: { status: string; file?: string; content?: string; offset?: { x: number; y: number } };
};
type Manifest = {
  status: string;
  validation: Record<string, string>;
  checks: { id: string; status: string; detail: string }[];
  slots: SlotReport[];
  coordinates: { transform: { scale: number; offsetX: number; offsetY: number } };
  files: { name: string; sha256: string }[];
};

let cached: ReturnType<typeof templateCommand> | undefined;
const result = (): ReturnType<typeof templateCommand> => (cached ??= templateCommand({ contractBytes: candidateBytes(), size, toolVersion }));
const fileOf = (name: string): Buffer => result().files.find((file) => file.name === name)?.bytes ?? Buffer.alloc(0);
const manifest = (): Manifest => JSON.parse(fileOf('template.json').toString('utf8')) as Manifest;
const raster = (name: string): ReturnType<typeof decodePng>['raster'] => decodePng(fileOf(name)).raster;

function runCli(args: readonly string[]): { status: number | null; report: Record<string, unknown> } {
  const run = spawnSync(process.execPath, [cli, 'template', ...args], { encoding: 'utf8' });
  return { status: run.status, report: JSON.parse(run.stdout) as Record<string, unknown> };
}

describe('T1a-01 determinism', () => {
  it('gives byte-equal files and an equal manifest for two runs', () => {
    const again = templateCommand({ contractBytes: candidateBytes(), size, toolVersion });
    expect(again.files.map((file) => file.name)).toEqual(result().files.map((file) => file.name));
    for (const [index, file] of again.files.entries()) expect(sha256(file.bytes), file.name).toBe(sha256(result().files[index]?.bytes ?? Buffer.alloc(0)));
    expect(again.report).toEqual(result().report);
  });

  it('lists every written file in the manifest with its SHA-256', () => {
    const listed = new Map(manifest().files.map((file) => [file.name, file.sha256]));
    for (const file of result().files) {
      if (file.name === 'template.json') continue;
      expect(listed.get(file.name), file.name).toBe(sha256(file.bytes));
    }
    expect(listed.size).toBe(result().files.length - 1);
  });
});

describe('T1a-02 exact contract identifiers', () => {
  it('lists exactly the contract slots, bones and draw order', () => {
    const contract = candidate();
    const slots = (contract.slots as { id: string; bone: string; drawOrder: number; required: boolean }[]).slice().sort((a, b) => a.drawOrder - b.drawOrder);
    expect(manifest().slots.map((slot) => [slot.slot, slot.bone, slot.drawOrder, slot.required])).toEqual(slots.map((slot) => [slot.id, slot.bone, slot.drawOrder, slot.required]));
    expect(new Set([...modeledSlots(), ...notModeledSlots])).toEqual(new Set(slots.map((slot) => slot.id)));
    const masks = result()
      .files.map((file) => file.name)
      .filter((name) => name.startsWith('masks/'));
    expect(masks.sort()).toEqual(
      modeledSlots()
        .map((id) => `masks/${id}.visible.png`)
        .sort()
    );
  });

  it('refuses a contract with an unknown slot or without a slot of a reference volume', () => {
    const extra = candidate();
    (extra.slots as Record<string, unknown>[]).push({ id: 'cape', bone: 'chest', drawOrder: 27, required: false, attachmentRect: { x: 0, y: 0, w: 10, h: 10 } });
    expect(codeOf(() => templateCommand({ contractBytes: bytesOf(extra), size, toolVersion }))).toBe('E_TEMPLATE_SLOT_UNKNOWN');
    const missing = candidate();
    missing.slots = (missing.slots as { id: string }[]).filter((slot) => slot.id !== 'neck');
    expect(codeOf(() => templateCommand({ contractBytes: bytesOf(missing), size, toolVersion }))).toBe('E_TEMPLATE_SLOT_MISSING');
  });
});

describe('T1a-03 masks and region ownership', () => {
  it('gives each pixel at most one region, and the masks agree with the region map', () => {
    const regions = raster('region-map.png');
    const reports = manifest().slots.filter((slot) => slot.visibleMask);
    const masks = reports.map((slot) => ({ slot, mask: raster(slot.visibleMask as string) }));
    for (let p = 0; p < regions.width * regions.height; p += 1) {
      const owners = masks.filter(({ mask }) => mask.data[p * 4] === 255);
      expect(owners.length).toBeLessThanOrEqual(1);
      const color = [regions.data[p * 4], regions.data[p * 4 + 1], regions.data[p * 4 + 2]];
      if (owners.length === 1) expect(color).toEqual(owners[0]?.slot.regionColor);
      else expect(color).toEqual([0, 0, 0]);
    }
  });

  it('keeps every mask pixel inside the attachment rectangle of its slot (geometry check M1 passes on the fixture)', () => {
    const { transform } = manifest().coordinates;
    const outside: string[] = [];
    for (const slot of manifest().slots.filter((item) => item.visibleMask)) {
      const mask = raster(slot.visibleMask as string);
      const rect = slot.attachmentRect;
      let count = 0;
      for (let p = 0; p < mask.width * mask.height; p += 1) {
        if (mask.data[p * 4] !== 255) continue;
        const c = toContract({ x: (p % mask.width) + 0.5, y: Math.floor(p / mask.width) + 0.5 }, transform);
        if (c.x < rect.x || c.y < rect.y || c.x >= rect.x + rect.w || c.y >= rect.y + rect.h) count += 1;
      }
      if (count > 0) outside.push(slot.slot);
    }
    expect(outside).toEqual([]);
    expect(manifest().checks.find((check) => check.id === 'M1')?.status).toBe('PASS');
    expect(result().report.status).toBe('PASS');
  });

  it('detects mask pixels outside a rectangle (tool check): a hips rectangle without the lowest pelvis point fails M1', () => {
    const changed = candidate();
    const hips = (changed.slots as { id: string; attachmentRect: { h: number } }[]).find((slot) => slot.id === 'hips');
    if (!hips) throw new Error('The fixture has no hips slot.');
    hips.attachmentRect.h = 232;
    const run = templateCommand({ contractBytes: bytesOf(changed), size, toolVersion });
    const m1 = run.report.checks as { id: string; status: string; detail: string }[];
    expect(m1.find((check) => check.id === 'M1')).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('hips (1248 contract px)') as unknown });
    expect(m1.find((check) => check.id === 'M1')?.detail).not.toContain('neck');
    expect(run.report.status).toBe('FAIL');
  });

  it('starts the neck region at the neck joint: no neck pixel below it', () => {
    const { transform } = manifest().coordinates;
    const neckJoint = parseContractBytes(candidateBytes()).bones.get('neck')?.joint;
    if (!neckJoint) throw new Error('The fixture has no neck joint.');
    const mask = raster('masks/neck.visible.png');
    let below = 0;
    for (let p = 0; p < mask.width * mask.height; p += 1) {
      if (mask.data[p * 4] === 255 && toContract({ x: 0, y: Math.floor(p / mask.width) + 0.5 }, transform).y > neckJoint.y + 1) below += 1;
    }
    expect(below).toBe(0);
  });

  it('uses the same lowest pelvis point for the hips rectangle as the torso volume', () => {
    const torso = depthAssumptions.torso;
    expect((torso.sections[0]?.up ?? Number.NaN) - torso.bottomCap).toBeCloseTo(pelvisBottomUp, 9);
  });
});

describe('T1a-04 near and far orientation', () => {
  it('puts the near shoulder and hip on the image left and the face and feet to the image right', () => {
    const checks = new Map(manifest().checks.map((check) => [check.id, check.status]));
    expect([checks.get('N1'), checks.get('N2'), checks.get('N3')]).toEqual(['PASS', 'PASS', 'PASS']);
    const center = (name: string): { x: number; minX: number; maxX: number } => {
      const mask = raster(`masks/${name}.visible.png`);
      let sum = 0;
      let n = 0;
      let minX = Infinity;
      let maxX = -Infinity;
      for (let p = 0; p < mask.width * mask.height; p += 1) {
        if (mask.data[p * 4] !== 255) continue;
        const x = p % mask.width;
        sum += x;
        n += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
      return { x: sum / n, minX, maxX };
    };
    expect(center('upper_arm_near').x).toBeLessThan(center('upper_arm_far').x);
    expect(center('thigh_near').x).toBeLessThan(center('thigh_far').x);
    const contract = parseContractBytes(candidateBytes());
    const transform = fitTransform(contract.canvas, { width: 416, height: 624 });
    for (const side of ['near', 'far']) {
      const ankle = toTarget(contract.bones.get(`foot_${side}`)?.joint ?? { x: 0, y: 0 }, transform);
      const foot = center(`foot_${side}`);
      expect(foot.maxX - ankle.x, side).toBeGreaterThan(ankle.x - foot.minX);
    }
    const nose = toTarget(contract.points.get('face_nose')?.position ?? { x: 0, y: 0 }, transform);
    expect(nose.x).toBeGreaterThan(center('head').x);
  });
});

describe('T1a-05 image alpha semantics', () => {
  it('writes binary opaque masks and straight-alpha RGBA mock parts', () => {
    for (const slot of manifest().slots.filter((item) => item.visibleMask)) {
      const decoded = decodePng(fileOf(slot.visibleMask as string));
      expect(decoded.colorType).toBe('rgba');
      expect(decoded.ignoredChunks).toEqual([]);
      const { data } = decoded.raster;
      let bad = 0;
      for (let i = 0; i < data.length; i += 4) {
        const value = data[i];
        if ((value !== 0 && value !== 255) || data[i + 1] !== value || data[i + 2] !== value || data[i + 3] !== 255) bad += 1;
      }
      expect(bad, slot.slot).toBe(0);
    }
  });

  it('puts mock pixels only in the visible area plus the joint overlap circles, in the slot color', () => {
    const contract = parseContractBytes(candidateBytes());
    const reports = manifest().slots;
    const slots = reports.map((slot) => ({
      id: slot.slot,
      bone: slot.bone,
      drawOrder: slot.drawOrder,
      required: slot.required,
      rect: slot.attachmentRect,
      overlaps: slot.overlaps,
      modeled: slot.geometry === 'modeled',
      color: [...slot.regionColor, 255] as const
    }));
    const own = castOwnership(contract, slots, contract.canvas, { scale: 1, offsetX: 0, offsetY: 0 });
    expect(cameraOf(contract).yawDegrees).toBe(40);
    for (const [index, slot] of reports.entries()) {
      if (slot.mockPart.content !== 'visible_mask_plus_overlap_circles') continue;
      const decoded = decodePng(fileOf(`mock-package/${slot.mockPart.file as string}`));
      const part = decoded.raster;
      expect([part.width, part.height]).toEqual([slot.attachmentRect.w, slot.attachmentRect.h]);
      expect(slot.mockPart.offset).toEqual({ x: slot.attachmentRect.x, y: slot.attachmentRect.y });
      for (let y = 0; y < part.height; y += 1) {
        for (let x = 0; x < part.width; x += 1) {
          const pixel = [...part.data.subarray((y * part.width + x) * 4, (y * part.width + x) * 4 + 4)];
          if (pixel[3] === 0) {
            expect(pixel).toEqual([0, 0, 0, 0]);
            continue;
          }
          expect(pixel).toEqual([...slot.regionColor, 255]);
          const cx = slot.attachmentRect.x + x;
          const cy = slot.attachmentRect.y + y;
          const visible = own.owner[cy * contract.canvas.width + cx] === index;
          const circle = slot.overlaps.some((o) => (cx + 0.5 - o.center.x) ** 2 + (cy + 0.5 - o.center.y) ** 2 <= o.radiusPx ** 2);
          expect(visible || circle, `${slot.slot} ${x},${y}`).toBe(true);
        }
      }
    }
  });
});

describe('T1a-06 structural package validation (parseCharacter) and D22', () => {
  it('passes the real rig-runtime parseCharacter, a structural check only', () => {
    const root = temporaryDirectory();
    const characterPath = join(root, 'character.json');
    writeFileSync(characterPath, fileOf('mock-package/character.json'));
    const run = spawnSync(process.execPath, [parserBridge, fixturePath, characterPath], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout)).toEqual({ ok: true, slots: 27 });
    const character = JSON.parse(fileOf('mock-package/character.json').toString('utf8')) as { parts: Record<string, { status: string; file?: string }> };
    character.parts.torso = { status: 'absent_by_design' };
    writeFileSync(characterPath, JSON.stringify(character));
    const refused = spawnSync(process.execPath, [parserBridge, fixturePath, characterPath], { encoding: 'utf8' });
    expect((JSON.parse(refused.stdout) as { code: string }).code).toBe('E_REQUIRED_PART_ABSENT');
  });

  it('marks optional slots absent_by_design without a PNG, and writes one PNG for each required slot', () => {
    const character = JSON.parse(fileOf('mock-package/character.json').toString('utf8')) as { characterId: string; rigId: string; parts: Record<string, { status: string; file?: string }> };
    const names = new Set(result().files.map((file) => file.name));
    for (const slot of manifest().slots) {
      const part = character.parts[slot.slot];
      if (slot.required) {
        expect(part).toEqual({ status: 'present', file: `parts/${slot.slot}.png` });
        expect(names.has(`mock-package/parts/${slot.slot}.png`)).toBe(true);
      } else {
        expect(part).toEqual({ status: 'absent_by_design' });
        expect(names.has(`mock-package/parts/${slot.slot}.png`)).toBe(false);
      }
    }
    expect(
      manifest()
        .slots.filter((slot) => slot.mockPart.content === 'placeholder_frame')
        .map((slot) => slot.slot)
    ).toEqual(['hair_back', 'hair_front']);
  });
});

describe('T1a-07 input immutability', () => {
  it('does not change the contract file or the given bytes', () => {
    const before = sha256(candidateBytes());
    const bytes = candidateBytes();
    templateCommand({ contractBytes: bytes, size: '208x312', toolVersion });
    expect(sha256(bytes)).toBe(before);
    const root = temporaryDirectory();
    expect(runCli(['--contract', fixturePath, '--out', join(root, 'out'), '--size', '208x312']).report.command).toBe('template');
    expect(sha256(candidateBytes())).toBe(before);
    expect(before).toBe('2e5868b5e416600bb9266ed92a90e939bfd0d0ac20146aa438504c91ec1e5d6f');
  });
});

describe('T1a-08 output safety and dry run', () => {
  const small = ['--contract', fixturePath, '--size', '208x312'];

  it('writes nothing with --dry-run and refuses a non-empty directory without --force', () => {
    const root = temporaryDirectory();
    const out = join(root, 'out');
    const dry = runCli([...small, '--out', out, '--dry-run']);
    expect(dry.report.written).toBe(false);
    expect(existsSync(out)).toBe(false);
    expect(runCli([...small, '--out', out]).status).toBe(0);
    expect(existsSync(join(out, 'mock-package', 'parts', 'torso.png'))).toBe(true);
    const again = runCli([...small, '--out', out]);
    expect([again.status, again.report.code]).toEqual([2, 'E_OUTPUT_EXISTS']);
    expect(runCli([...small, '--out', out, '--force']).status).toBe(0);
  });

  it('refuses symbolic links for the output directory and its subdirectories, and never writes through a file link', () => {
    const root = temporaryDirectory();
    const real = join(root, 'real');
    mkdirSync(real);
    symlinkSync(real, join(root, 'link'));
    expect(runCli([...small, '--out', join(root, 'link'), '--force']).report.code).toBe('E_OUTPUT');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(real, 'masks'));
    expect(runCli([...small, '--out', real, '--force']).report.code).toBe('E_OUTPUT');
    const out = join(root, 'out');
    mkdirSync(out);
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'keep');
    symlinkSync(victim, join(out, 'template.json'));
    runCli([...small, '--out', out, '--force']);
    expect(readFileSync(victim, 'utf8')).toBe('keep');
    expect(lstatSync(join(out, 'template.json')).isSymbolicLink()).toBe(false);
  });

  it('refuses a directory as the contract input and an unknown option', () => {
    const root = temporaryDirectory();
    expect(runCli(['--contract', root, '--out', join(root, 'out')]).report.code).toBe('E_INPUT');
    expect(runCli([...small, '--out', join(root, 'out'), '--yaw', '30']).report.code).toBe('E_USAGE');
  });
});

describe('T1a-09 unsupported view and prototype status', () => {
  it('stops with E_VIEW_UNSUPPORTED for another view or side naming', () => {
    const view = candidate();
    view.view = 'side_right';
    expect(codeOf(() => templateCommand({ contractBytes: bytesOf(view), size, toolVersion }))).toBe('E_VIEW_UNSUPPORTED');
    const naming = candidate();
    naming.sideNaming = 'left_right';
    expect(codeOf(() => templateCommand({ contractBytes: bytesOf(naming), size, toolVersion }))).toBe('E_VIEW_UNSUPPORTED');
  });

  it('refuses a contract that is not the C0.5 candidate or does not match the reference body', () => {
    const other = candidate();
    other.rigId = 'humanoid_girl_v1';
    expect(codeOf(() => templateCommand({ contractBytes: bytesOf(other), size, toolVersion }))).toBe('E_CONTRACT_NOT_CANDIDATE');
    const moved = candidate();
    const bone = (moved.bones as { id: string; joint: { x: number; y: number } }[]).find((item) => item.id === 'forearm_near');
    if (bone) bone.joint = { x: bone.joint.x + 5, y: bone.joint.y };
    expect(codeOf(() => templateCommand({ contractBytes: bytesOf(moved), size, toolVersion }))).toBe('E_GEOMETRY_MISMATCH');
  });

  it('always writes the prototype status and marks motion and Spine compatibility as not validated', () => {
    expect(manifest().status).toBe('prototype');
    expect(manifest().validation).toMatchObject({ motionCoverage: 'not_validated', spineCompatibility: 'not_validated' });
    expect(result().report.templateStatus).toBe('prototype');
    expect(fileOf('review.md').toString('utf8')).toContain('Motion coverage and Spine compatibility are not validated.');
  });
});
