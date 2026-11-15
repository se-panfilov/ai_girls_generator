import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PlannedFile } from '@control/output';
import { decodePng, sha256 } from '@control/png';
import { ControlError } from '@control/problems';
import { Raster } from '@control/raster';
import { alphaBounds, cropBox, keyPoses, paddedUnion, spineArmCommand, uncrop } from '@control/spinearm';
import { atlasRegions, compareSkeletons, spineValidateCommand } from '@control/spinecli';
import { type ArmRigInput, buildArmSkeleton, checkArmSkeleton, regionCorners, skeletonBytes, spineDegrees, toImage, toSpine, worldBones } from '@control/spineskeleton';
import * as spine from '@esotericsoftware/spine-core';
import { describe, expect, it } from 'vitest';

import { syntheticArm } from './helpers';

// M0-F0a tests: Spine skeleton JSON, package assembly, and the Spine CLI validation with a fake Spine program.
// Synthetic shapes and the synthetic arm only. No character image, no real Spine executable.

const frame = { origin: { x: 100, y: 200 } };
const rig: ArmRigInput = {
  frame,
  joints: { shoulder: { x: 120.5, y: 30.25 }, elbow: { x: 101.75, y: 90.5 }, wrist: { x: 80.2, y: 140.9 }, handEnd: { x: 70, y: 160 } },
  parts: [
    { left: 90, top: 20, width: 41, height: 80 },
    { left: 70, top: 80, width: 41, height: 70 },
    { left: 55, top: 130, width: 35, height: 40 }
  ],
  reference: { left: 50, top: 10, width: 90, height: 170 }
};

describe('coordinates', () => {
  it('image to Spine: y flips at the origin, the round trip is exact', () => {
    expect(toSpine(frame, { x: 100, y: 200 })).toEqual({ x: 0, y: 0 });
    expect(toSpine(frame, { x: 110, y: 150 })).toEqual({ x: 10, y: 50 });
    for (let i = 0; i < 200; i += 1) {
      const p = { x: (i * 37) % 251, y: (i * 53) % 241 };
      expect(toImage(frame, toSpine(frame, p))).toEqual(p);
    }
  });

  it('screen degrees (clockwise) become negative Spine values (counterclockwise)', () => {
    expect(spineDegrees(15)).toBe(-15);
    expect(spineDegrees(-30)).toBe(30);
    expect(Object.is(spineDegrees(0), 0)).toBe(true);
  });
});

describe('skeleton JSON', () => {
  const skeleton = buildArmSkeleton(rig);
  const parsed = JSON.parse(skeletonBytes(skeleton).toString('utf8')) as unknown;

  it('passes all structural checks and puts the bones on the joint marks', () => {
    const checks = checkArmSkeleton(parsed, rig);
    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ['essential_subset', 'PASS'],
      ['bone_hierarchy', 'PASS'],
      ['bone_numbers', 'PASS'],
      ['joint_positions', 'PASS'],
      ['slots_draw_order', 'PASS'],
      ['region_attachments', 'PASS'],
      ['keyframes', 'PASS']
    ]);
    expect(skeleton.bones.map((bone) => [bone.name, bone.parent])).toEqual([
      ['root', undefined],
      ['upper_arm_near', 'root'],
      ['forearm_near', 'upper_arm_near'],
      ['hand_near', 'forearm_near']
    ]);
    // Children sit at the end of the parent bone; pivots do not change between animations (only rotate keys).
    expect(skeleton.bones[2]?.x).toBe(skeleton.bones[1]?.length);
    expect(skeleton.bones[3]?.x).toBe(skeleton.bones[2]?.length);
    expect(skeleton.slots.map((slot) => slot.name)).toEqual(['reference_source_pose', 'upper_arm_near', 'forearm_near', 'hand_near']);
    expect(skeleton.slots[0]?.attachment).toBeUndefined();
  });

  it('places each region exactly on its image box (setup pose)', () => {
    const world = worldBones(skeleton.bones);
    rig.parts.forEach((box, index) => {
      const slot = ['upper_arm_near', 'forearm_near', 'hand_near'][index] as string;
      const region = skeleton.skins[0]?.attachments[slot]?.[slot];
      if (!region) throw new Error('missing region');
      const corners = regionCorners(world.get(slot) ?? { x: 0, y: 0, rotation: 0 }, region).map((p) => toImage(frame, p));
      expect(corners[0]?.x).toBeCloseTo(box.left, 3);
      expect(corners[0]?.y).toBeCloseTo(box.top, 3);
      expect(corners[2]?.x).toBeCloseTo(box.left + box.width, 3);
      expect(corners[2]?.y).toBeCloseTo(box.top + box.height, 3);
    });
  });

  it('refuses meshes, constraints, unknown timelines, cycles, and a moved joint', () => {
    const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
    const withIk = { ...clone(), ik: [{ name: 'arm', bones: ['upper_arm_near'] }] };
    expect(checkArmSkeleton(withIk, rig).find((check) => check.id === 'essential_subset')?.status).toBe('FAIL');
    const mesh = clone() as { skins: { attachments: Record<string, Record<string, Record<string, unknown>>> }[] };
    const hand = mesh.skins[0]?.attachments.hand_near?.hand_near;
    if (hand) hand.type = 'mesh';
    expect(checkArmSkeleton(mesh, rig).find((check) => check.id === 'essential_subset')?.status).toBe('FAIL');
    const deform = clone() as { animations: Record<string, { bones: Record<string, Record<string, unknown>> }> };
    const timeline = deform.animations.elbow_test?.bones.forearm_near;
    if (timeline) timeline.translate = [{ x: 1 }];
    expect(checkArmSkeleton(deform, rig).find((check) => check.id === 'essential_subset')?.status).toBe('FAIL');
    const cycle = clone() as { bones: { name: string; parent?: string }[] };
    if (cycle.bones[1]) cycle.bones[1].parent = 'hand_near';
    expect(checkArmSkeleton(cycle, rig).find((check) => check.id === 'bone_hierarchy')?.status).toBe('FAIL');
    const moved = clone() as { bones: { x?: number }[] };
    if (moved.bones[2]) moved.bones[2].x = (moved.bones[2].x ?? 0) + 0.5;
    expect(checkArmSkeleton(moved, rig).find((check) => check.id === 'joint_positions')?.status).toBe('FAIL');
    const keys = clone() as { animations: Record<string, { bones: Record<string, { rotate: { value?: number }[] }> }> };
    const key = keys.animations.wrist_test?.bones.hand_near?.rotate[1];
    if (key) key.value = -(key.value ?? 0);
    expect(checkArmSkeleton(keys, rig).find((check) => check.id === 'keyframes')?.status).toBe('FAIL');
  });

  it('reads with the official spine-core 4.3 runtime: same bones, regions, and animated pivots', () => {
    const text = skeletonBytes(skeleton).toString('utf8');
    let y = 0;
    const regions = ['reference_source_pose', 'upper_arm_near', 'forearm_near', 'hand_near'].map((name, index) => {
      const box = index === 0 ? rig.reference : rig.parts[index - 1];
      const lines = [name, `bounds: 0,${y},${box?.width ?? 1},${box?.height ?? 1}`];
      y += box?.height ?? 1;
      return lines.join('\n');
    });
    const atlas = new spine.TextureAtlas(['page.png', 'size: 1024,1024', 'filter: Linear,Linear', ...regions].join('\n'));
    const data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(text);
    expect(data.bones.map((bone) => bone.name)).toEqual(['root', 'upper_arm_near', 'forearm_near', 'hand_near']);
    expect(data.animations.map((animation) => animation.name)).toEqual(['neutral', 'elbow_test', 'wrist_test', 'combined_test']);
    const skeletonRuntime = new spine.Skeleton(data);
    skeletonRuntime.setupPose();
    skeletonRuntime.updateWorldTransform(spine.Physics.none);
    const at = (bone: string): { x: number; y: number } => {
      const pose = skeletonRuntime.findBone(bone)?.appliedPose;
      return toImage(frame, { x: pose?.worldX ?? NaN, y: pose?.worldY ?? NaN });
    };
    expect(at('forearm_near').x).toBeCloseTo(rig.joints.elbow.x, 3);
    expect(at('forearm_near').y).toBeCloseTo(rig.joints.elbow.y, 3);
    expect(at('hand_near').x).toBeCloseTo(rig.joints.wrist.x, 3);
    expect(at('hand_near').y).toBeCloseTo(rig.joints.wrist.y, 3);
    // elbow_test at 2 s: +30 screen degrees (clockwise) at the elbow. The wrist turns about the elbow mark.
    const state = new spine.AnimationState(new spine.AnimationStateData(data));
    state.setAnimation(0, 'elbow_test', false);
    state.update(2);
    state.apply(skeletonRuntime);
    skeletonRuntime.updateWorldTransform(spine.Physics.none);
    const angle = (30 * Math.PI) / 180;
    const e = rig.joints.elbow;
    const w = rig.joints.wrist;
    const expected = { x: e.x + Math.cos(angle) * (w.x - e.x) - Math.sin(angle) * (w.y - e.y), y: e.y + Math.sin(angle) * (w.x - e.x) + Math.cos(angle) * (w.y - e.y) };
    expect(at('hand_near').x).toBeCloseTo(expected.x, 3);
    expect(at('hand_near').y).toBeCloseTo(expected.y, 3);
    expect(at('forearm_near').x).toBeCloseTo(e.x, 3);
  });
});

describe('crops', () => {
  it('keeps semi-transparent edge pixels and the exact offset', () => {
    const raster = new Raster(40, 30);
    raster.data.set([10, 20, 30, 1], (5 * 40 + 7) * 4);
    raster.data.set([200, 100, 50, 255], (20 * 40 + 30) * 4);
    const bounds = alphaBounds(raster);
    expect(bounds).toEqual({ left: 7, top: 5, width: 24, height: 16 });
    const box = paddedUnion([bounds ?? { left: 0, top: 0, width: 1, height: 1 }], 2, 40, 30);
    expect(box).toEqual({ left: 5, top: 3, width: 28, height: 20 });
    const back = uncrop(cropBox(raster, box), box, 40, 30);
    expect(Buffer.from(back.data).equals(Buffer.from(raster.data))).toBe(true);
    expect(paddedUnion([{ left: 0, top: 0, width: 3, height: 3 }], 5, 40, 30)).toEqual({ left: 0, top: 0, width: 8, height: 8 });
  });

  it('lists each distinct key pose once', () => {
    const poses = keyPoses();
    expect(poses[0]).toMatchObject({ elbow: 0, wrist: 0 });
    expect(new Set(poses.map((pose) => `${pose.elbow}/${pose.wrist}`)).size).toBe(poses.length);
    expect(poses.length).toBe(9);
  });
});

describe('spine-arm command (synthetic arm)', () => {
  const { contractBytes, metadataBytes, layerFiles, imageBytes, landmarkBytes, study } = syntheticArm;
  const options = { contractBytes, metadataBytes, metadataName: 'synthetic.psd.json', layerFiles, imageBytes, landmarkBytes, studyBytes: study(landmarkBytes), toolVersion: '0' };
  const result = spineArmCommand(options);
  const file = (name: string): PlannedFile => {
    const found = result.files.find((item) => item.name === name);
    if (!found) throw new Error(`missing ${name}`);
    return found;
  };

  it('passes all offline checks and stays JSON_GENERATED only', () => {
    const validation = JSON.parse(file('evidence/validation.json').bytes.toString('utf8')) as {
      levels: Record<string, string>;
      spineImport: string;
      checks: { id: string; status: string; detail: string }[];
    };
    expect(validation.checks.filter((check) => check.status !== 'PASS')).toEqual([]);
    expect(result.report.status).toBe('PASS');
    expect(validation.levels).toEqual({ JSON_GENERATED: 'PASS', CLI_VALIDATED: 'NOT_RUN', VISUALLY_VALIDATED: 'NOT_RUN' });
    expect(validation.spineImport).toBe('SPINE_IMPORT_UNVERIFIED');
    expect(validation.checks.find((check) => check.id === 'source_pose_baseline')?.detail).toContain('0 pixels differ');
  });

  it('references only images that exist, with the region sizes of the JSON', () => {
    for (const variant of ['tube', 'baseline']) {
      const skeleton = JSON.parse(file(`spine/${variant}/arm-spine.json`).bytes.toString('utf8')) as {
        skeleton: { images: string };
        skins: { attachments: Record<string, Record<string, { width: number; height: number }>> }[];
      };
      expect(skeleton.skeleton.images).toBe('./images/');
      for (const [slot, entries] of Object.entries(skeleton.skins[0]?.attachments ?? {})) {
        for (const [name, region] of Object.entries(entries)) {
          expect(name).toBe(slot);
          const png = decodePng(file(`spine/${variant}/images/${name}.png`).bytes).raster;
          expect([png.width, png.height]).toEqual([region.width, region.height]);
        }
      }
    }
    expect(sha256(file('spine/tube/arm-spine.json').bytes)).toBe(sha256(file('spine/baseline/arm-spine.json').bytes));
    expect(sha256(file('spine/tube/images/upper_arm_near.png').bytes)).not.toBe(sha256(file('spine/baseline/images/upper_arm_near.png').bytes));
  });

  it('writes byte-equal files twice and lists them in the manifests', () => {
    const again = spineArmCommand(options);
    expect(again.files.map((item) => [item.name, sha256(item.bytes)])).toEqual(result.files.map((item) => [item.name, sha256(item.bytes)]));
    const sums = file('SHA256SUMS').bytes.toString('utf8');
    for (const item of result.files) if (!['SHA256SUMS', 'PIXEL-SHA256SUMS'].includes(item.name)) expect(sums).toContain(`${sha256(item.bytes)}  ${item.name}`);
    expect(file('PIXEL-SHA256SUMS').bytes.toString('utf8')).toContain('spine/tube/images/hand_near.png');
    expect(file('README.md').bytes.toString('utf8')).toContain('spine-validate');
  });
});

// A fake Spine program for the CLI validation tests. It imitates the import (-r) and the export (-e json+pack) with files only.
// FAKE_SPINE_MODE: ok, fail-import, rotate (the export changes a rotation), drop-image (one image is not packed).
const fakeSpine = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const get = (name) => args[args.indexOf(name) + 1];
const mode = process.env.FAKE_SPINE_MODE || 'ok';
if (args.includes('--import')) {
  if (mode === 'fail-import') { process.stderr.write('ERROR: Unable to import skeleton.'); process.exit(1); }
  fs.writeFileSync(get('--output'), JSON.stringify({ source: path.resolve(get('--input')), name: get('--import') }));
  process.stdout.write('Import complete.');
  process.exit(0);
}
if (args.includes('--export')) {
  const project = JSON.parse(fs.readFileSync(get('--input'), 'utf8'));
  const skeleton = JSON.parse(fs.readFileSync(project.source, 'utf8'));
  skeleton.skeleton.spine = '4.3.26';
  delete skeleton.skeleton.images;
  for (const bone of skeleton.bones) if (bone.y === 0) delete bone.y;
  for (const animation of Object.values(skeleton.animations)) for (const timeline of Object.values(animation.bones)) for (const key of timeline.rotate) { if (key.time === 0) delete key.time; if (key.value === 0) delete key.value; }
  if (mode === 'rotate') skeleton.bones[2].rotation += 1;
  const out = get('--output');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, project.name + '.json'), JSON.stringify(skeleton));
  let names = fs.readdirSync(path.join(path.dirname(project.source), 'images')).map((n) => n.replace(/\\.png$/, '')).sort();
  if (mode === 'drop-image') names = names.filter((n) => n !== 'hand_near');
  fs.writeFileSync(path.join(out, project.name + '.atlas'), project.name + '.png\\nsize:256,256\\nfilter:Linear,Linear\\n' + names.map((n) => n + '\\nbounds:0,0,8,8').join('\\n') + '\\n');
  fs.writeFileSync(path.join(out, project.name + '.png'), '');
  process.exit(0);
}
process.exit(2);
`;

describe('spine-validate command (fake Spine program)', () => {
  const { contractBytes, metadataBytes, layerFiles, imageBytes, landmarkBytes, study } = syntheticArm;
  const generated = spineArmCommand({ contractBytes, metadataBytes, metadataName: 'synthetic.psd.json', layerFiles, imageBytes, landmarkBytes, studyBytes: study(landmarkBytes), toolVersion: '0' });
  const root = mkdtempSync(join(tmpdir(), 'aigg-spine-validate-'));
  const packageDir = join(root, 'package');
  for (const item of generated.files) {
    mkdirSync(join(packageDir, item.name, '..'), { recursive: true });
    writeFileSync(join(packageDir, item.name), item.bytes);
  }
  const spinePath = join(root, 'Spine');
  writeFileSync(spinePath, fakeSpine);
  chmodSync(spinePath, 0o755);
  let runs = 0;
  const validate = (mode: string, extra: Partial<Parameters<typeof spineValidateCommand>[0]> = {}): ReturnType<typeof spineValidateCommand> => {
    runs += 1;
    const out = join(root, `out-${runs}`);
    mkdirSync(out);
    process.env.FAKE_SPINE_MODE = mode;
    try {
      return spineValidateCommand({ spine: spinePath, packageDir, out, dryRun: false, toolVersion: '0', timeoutMs: 30_000, ...extra });
    } finally {
      delete process.env.FAKE_SPINE_MODE;
    }
  };

  it('reports CLI_VALIDATED only when import, export, comparison, and atlas pass', () => {
    const result = validate('ok', { spineVersion: '4.3.26' });
    expect(result.report.status).toBe('PASS');
    expect(result.report.levels).toEqual({ CLI_VALIDATED: 'PASS', VISUALLY_VALIDATED: 'NOT_RUN' });
    const report = JSON.parse(result.files.find((item) => item.name === 'cli-validation.json')?.bytes.toString('utf8') ?? '{}') as {
      variants: { steps: { args: string[]; exitCode: number }[]; exportedEditorVersion: string }[];
    };
    expect(report.variants[0]?.steps[0]?.args.slice(0, 2)).toEqual(['--update', '4.3.26']);
    expect(report.variants[0]?.steps.map((step) => step.exitCode)).toEqual([0, 0]);
    expect(report.variants[0]?.exportedEditorVersion).toBe('4.3.26');
    expect(result.files.some((item) => item.name === 'tube/logs/import.stdout.log')).toBe(true);
  });

  it('fails with the Spine error text when the import fails, and skips the export', () => {
    const result = validate('fail-import');
    expect(result.report.status).toBe('FAIL');
    const report = JSON.parse(result.files.find((item) => item.name === 'cli-validation.json')?.bytes.toString('utf8') ?? '{}') as {
      variants: { steps: { exitCode?: number; skipped?: boolean; stderrTail?: string }[] }[];
    };
    expect(report.variants[0]?.steps[0]?.exitCode).toBe(1);
    expect(report.variants[0]?.steps[0]?.stderrTail).toContain('Unable to import');
    expect(report.variants[0]?.steps[1]?.skipped).toBe(true);
  });

  it('fails when the export differs or an image is not packed', () => {
    const rotated = validate('rotate');
    expect(rotated.report.status).toBe('FAIL');
    expect(JSON.stringify(rotated.report)).toContain('differs from the intended skeleton');
    const dropped = validate('drop-image');
    expect(JSON.stringify(dropped.report)).toContain('no region for hand_near');
  });

  it('dry run: checks the package, runs nothing; refuses a relative path, a bad version, and a changed package', () => {
    const before = runs;
    const dry = spineValidateCommand({ spine: spinePath, packageDir, out: join(root, 'dry'), dryRun: true, toolVersion: '0' });
    expect(dry.report.status).toBe('INCOMPLETE');
    expect(dry.files).toEqual([]);
    expect(runs).toBe(before);
    expect(() => spineValidateCommand({ spine: 'Spine', packageDir, out: join(root, 'x'), dryRun: true, toolVersion: '0' })).toThrow(ControlError);
    expect(() => spineValidateCommand({ spine: spinePath, packageDir, out: join(root, 'x'), dryRun: true, toolVersion: '0', spineVersion: '4.3; rm -rf /' })).toThrow('--spine-version');
    const json = join(packageDir, 'spine', 'tube', 'arm-spine.json');
    const original = readFileSync(json);
    writeFileSync(json, Buffer.concat([original, Buffer.from(' ')]));
    try {
      expect(() => spineValidateCommand({ spine: spinePath, packageDir, out: join(root, 'x'), dryRun: true, toolVersion: '0' })).toThrow('does not match');
    } finally {
      writeFileSync(json, original);
    }
  });
});

describe('export comparison', () => {
  const skeleton = JSON.parse(skeletonBytes(buildArmSkeleton(rig)).toString('utf8')) as Record<string, unknown>;

  it('treats omitted defaults and full turns as equal, and reports real changes', () => {
    const exported = JSON.parse(JSON.stringify(skeleton)) as { bones: { rotation?: number; y?: number }[]; slots: { color?: string }[] };
    if (exported.bones[1]) exported.bones[1].rotation = (exported.bones[1].rotation ?? 0) + 360;
    if (exported.bones[2]) delete exported.bones[2].y;
    if (exported.slots[0]) exported.slots[0].color = 'FFFFFF80';
    expect(compareSkeletons(skeleton, exported)).toEqual([]);
    if (exported.bones[3]) exported.bones[3].rotation = (exported.bones[3].rotation ?? 0) + 0.5;
    expect(compareSkeletons(skeleton, exported).map((item) => item.path)).toEqual(['bones.hand_near.rotation']);
  });

  it('reads region names from a Spine 4 atlas', () => {
    expect(atlasRegions('page.png\nsize:64,64\nfilter:Linear,Linear\nhand_near\nbounds:0,0,8,8\nforearm_near\nbounds:8,0,8,8\n')).toEqual(['hand_near', 'forearm_near']);
  });
});

describe('spine-validate CLI', () => {
  const cli = join(import.meta.dirname, '..', 'dist', 'src', 'cli.js');

  it('refuses --force and a relative Spine path with exit 2 and writes nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'aigg-spine-cli-'));
    const forced = spawnSync(process.execPath, [cli, 'spine-validate', '--spine', '/x/Spine', '--package', root, '--out', join(root, 'out'), '--force'], { encoding: 'utf8' });
    expect(forced.status).toBe(2);
    expect(forced.stdout).toContain('does not accept --force');
    const relative = spawnSync(process.execPath, [cli, 'spine-validate', '--spine', 'Spine', '--package', root, '--out', join(root, 'out'), '--dry-run'], { encoding: 'utf8' });
    expect(relative.status).toBe(2);
    expect(relative.stdout).toContain('absolute path');
    expect(existsSync(join(root, 'out'))).toBe(false);
  });
});
