import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleBodyCommand, contractSlots, nearestLabelFill, segmentDistance, skeletonPath } from '@control/bodyassembly';
import { animationLength, type BodyRigSpec, buildBodySkeleton, checkBodySkeleton, poseAt, renderPose, specProblems } from '@control/bodyrig';
import { composite } from '@control/layersplit';
import type { PlannedFile } from '@control/output';
import { decodePng, encodePng, sha256 } from '@control/png';
import { ControlError } from '@control/problems';
import { Raster } from '@control/raster';
import { packageLayout, spineValidateCommand, verifyPackage } from '@control/spinecli';
import { skeletonBytes, type SpineSkeleton, toImage, type WorldBone, worldBones } from '@control/spineskeleton';
import * as spine from '@esotericsoftware/spine-core';
import { describe, expect, it } from 'vitest';

import { fakeSpine, syntheticBody } from './helpers';

// MVP-A tests: the full-body skeleton JSON, the assembly of a synthetic See-through run, and the Spine CLI validation of the full-body
// package with a fake Spine program. Synthetic shapes only. No character image, no real Spine executable.

const frame = { origin: { x: 50, y: 200 } };
const spec: BodyRigSpec = {
  frame,
  bones: [
    { name: 'root', parent: null, joint: { x: 50, y: 200 }, end: null },
    { name: 'hips', parent: 'root', joint: { x: 50.25, y: 120 }, end: { x: 51, y: 80 } },
    { name: 'chest', parent: 'hips', joint: { x: 51, y: 80 }, end: { x: 52, y: 40 } },
    { name: 'arm', parent: 'chest', joint: { x: 40.5, y: 50.75 }, end: { x: 20, y: 95 } },
    { name: 'hand', parent: 'arm', joint: { x: 20, y: 95 }, end: { x: 15, y: 110 } },
    { name: 'leg', parent: 'hips', joint: { x: 45, y: 125 }, end: { x: 44, y: 190 } }
  ],
  slots: [
    { name: 'leg', bone: 'leg', box: { left: 38, top: 118, width: 14, height: 76 } },
    { name: 'torso', bone: 'chest', box: { left: 35, top: 40, width: 32, height: 86 } },
    { name: 'empty', bone: 'chest', box: null },
    { name: 'arm', bone: 'arm', box: { left: 14, top: 44, width: 32, height: 56 } },
    { name: 'hand', bone: 'hand', box: { left: 10, top: 90, width: 14, height: 24 } }
  ],
  animations: [
    {
      name: 'wave',
      duration: 1,
      tracks: [
        {
          bone: 'arm',
          keys: [
            { time: 0, degrees: 0 },
            { time: 0.5, degrees: 90 },
            { time: 1, degrees: 0 }
          ]
        },
        {
          bone: 'hand',
          keys: [
            { time: 0, degrees: 0 },
            { time: 1, degrees: -20 }
          ]
        }
      ]
    }
  ]
};

const solid = (width: number, height: number, value: number): Raster => {
  const raster = new Raster(width, height);
  for (let p = 0; p < width * height; p += 1) raster.data.set([value, 255 - value, (p * 7) % 256, 255], p * 4);
  return raster;
};

describe('full-body skeleton JSON', () => {
  const skeleton = buildBodySkeleton(spec);
  const parsed = JSON.parse(skeletonBytes(skeleton).toString('utf8')) as SpineSkeleton;

  it('passes all checks: Essential subset, hierarchy, joints, slots, regions, animations', () => {
    expect(checkBodySkeleton(parsed, spec).map((check) => [check.id, check.status])).toEqual([
      ['essential_subset', 'PASS'],
      ['bone_hierarchy', 'PASS'],
      ['bone_numbers', 'PASS'],
      ['joint_positions', 'PASS'],
      ['slots_draw_order', 'PASS'],
      ['region_attachments', 'PASS'],
      ['animations', 'PASS']
    ]);
    expect(parsed.slots.find((slot) => slot.name === 'empty')).toEqual({ name: 'empty', bone: 'chest' });
    expect(skeletonBytes(buildBodySkeleton(spec)).equals(skeletonBytes(skeleton))).toBe(true);
  });

  it('refuses Spine Professional data, a broken parent, a missing animated bone, and an animation without motion', () => {
    const mesh = structuredClone(parsed) as unknown as { skins: { attachments: Record<string, Record<string, Record<string, unknown>>> }[] };
    (mesh.skins[0]?.attachments.arm?.arm as Record<string, unknown>).type = 'mesh';
    expect(checkBodySkeleton(mesh, spec).find((check) => check.id === 'essential_subset')?.status).toBe('FAIL');
    const ik = { ...structuredClone(parsed), ik: [{ name: 'leg_ik' }] };
    expect(checkBodySkeleton(ik, spec).find((check) => check.id === 'essential_subset')?.detail).toContain('top: ik');
    const orphan = structuredClone(parsed);
    (orphan.bones[3] as { parent?: string }).parent = 'nothing';
    expect(checkBodySkeleton(orphan, spec).find((check) => check.id === 'bone_hierarchy')?.status).toBe('FAIL');
    const still = structuredClone(parsed);
    for (const timeline of Object.values(still.animations.wave?.bones ?? {})) for (const key of timeline.rotate) key.value = 0;
    const stillSpec: BodyRigSpec = {
      ...spec,
      animations: spec.animations.map((animation) => ({ ...animation, tracks: animation.tracks.map((track) => ({ ...track, keys: track.keys.map((key) => ({ ...key, degrees: 0 })) })) }))
    };
    expect(checkBodySkeleton(still, stillSpec).find((check) => check.id === 'animations')?.detail).toContain('no motion');
    expect(specProblems({ ...spec, animations: [{ name: 'x', duration: 1, tracks: [{ bone: 'tail', keys: [{ time: 0, degrees: 1 }] }] }] }).join()).toContain('missing bone tail');
    expect(() => buildBodySkeleton({ ...spec, bones: [spec.bones[1] as BodyRigSpec['bones'][number]] })).toThrow(RangeError);
  });

  it('interpolates rotate keys linearly as Spine does', () => {
    expect(poseAt(parsed, 'wave', 0.25).arm).toBeCloseTo(-45, 10);
    expect(poseAt(parsed, 'wave', 0.5).arm).toBeCloseTo(-90, 10);
    expect(poseAt(parsed, 'wave', 2).arm).toBe(0);
    expect(poseAt(parsed, 'wave', 0.5).hand).toBeCloseTo(10, 10);
    expect(animationLength(parsed, 'wave')).toBe(1);
  });

  it('reads with the official spine-core 4.3 runtime: same bones, slots, and animated joints as the local model', () => {
    const regions = parsed.slots.filter((slot) => slot.attachment).map((slot) => slot.name);
    const atlas = new spine.TextureAtlas(`page.png\nsize:256,256\nfilter:Linear,Linear\n${regions.map((name, i) => `${name}\nbounds:${i * 40},0,32,32`).join('\n')}\n`);
    const data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(skeletonBytes(skeleton).toString('utf8'));
    expect(data.bones.map((bone) => bone.name)).toEqual(spec.bones.map((bone) => bone.name));
    expect(data.slots.map((slot) => slot.name)).toEqual(spec.slots.map((slot) => slot.name));
    for (const time of [0, 0.2, 0.5, 0.8]) {
      const runtime = new spine.Skeleton(data);
      runtime.setupPose();
      const state = new spine.AnimationState(new spine.AnimationStateData(data));
      state.setAnimation(0, 'wave', false);
      state.update(time);
      state.apply(runtime);
      runtime.updateWorldTransform(spine.Physics.none);
      const local = worldBones(parsed.bones, poseAt(parsed, 'wave', time));
      for (const bone of runtime.bones) {
        const mine = local.get(bone.data.name) as WorldBone;
        expect(Math.abs(bone.appliedPose.worldX - mine.x)).toBeLessThan(1e-3);
        expect(Math.abs(bone.appliedPose.worldY - mine.y)).toBeLessThan(1e-3);
      }
    }
  });

  it('renders the setup pose equal to the direct composite and moves the arm in a key pose', () => {
    const images = new Map(
      spec.slots
        .filter((slot) => slot.box)
        .map((slot, index) => {
          const box = slot.box as NonNullable<typeof slot.box>;
          return [slot.name, { raster: solid(box.width, box.height, 40 * (index + 1)), box }] as const;
        })
    );
    const canvas = (name: string): Raster => {
      const image = images.get(name);
      const out = new Raster(100, 220);
      if (image) out.draw(image.raster, image.box.left, image.box.top);
      return out;
    };
    const direct = composite(
      100,
      220,
      spec.slots.map((slot) => canvas(slot.name))
    );
    const setup = renderPose(parsed, frame, images, {}, 100, 220);
    expect(Buffer.from(setup.data).equals(Buffer.from(direct.data))).toBe(true);
    const raised = renderPose(parsed, frame, images, poseAt(parsed, 'wave', 0.5), 100, 220);
    expect(Buffer.from(raised.data).equals(Buffer.from(direct.data))).toBe(false);
    const hand = toImage(frame, worldBones(parsed.bones, poseAt(parsed, 'wave', 0.5)).get('hand') as WorldBone);
    expect(hand.y).toBeLessThan(95);
  });
});

describe('assembly helpers', () => {
  it('nearest-label fill gives each target the label of the nearest seed, deterministically', () => {
    const labels = new Uint8Array(10 * 3);
    labels[0] = 1;
    labels[9] = 2;
    const targets = new Uint8Array(30);
    for (let x = 1; x < 9; x += 1) targets[10 + x] = 1;
    const fill = nearestLabelFill(labels, targets, new Set([1, 2]), 10, 3);
    expect([...fill.labels.slice(11, 19)]).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    expect(fill.filled).toBe(8);
    expect(nearestLabelFill(labels, targets, new Set([1, 2]), 10, 3).labels).toEqual(fill.labels);
  });

  it('measures the distance to a segment', () => {
    expect(segmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(segmentDistance({ x: -4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });

  it('reads the contract slots in draw order with the required flag', () => {
    const slots = contractSlots(syntheticBody.contractBytes);
    expect(slots[0]?.id).toBe('hair_back');
    expect(slots.find((slot) => slot.id === 'weapon')?.required).toBe(false);
    expect(slots.find((slot) => slot.id === 'hips')?.required).toBe(true);
  });
});

const input = {
  contractBytes: syntheticBody.contractBytes,
  metadataBytes: syntheticBody.metadataBytes,
  metadataName: syntheticBody.metadataName,
  layerFiles: syntheticBody.layerFiles,
  imageBytes: syntheticBody.imageBytes,
  landmarkBytes: syntheticBody.landmarkBytes,
  studyBytes: syntheticBody.studyBytes,
  toolVersion: '0'
};

describe('assemble-body on a synthetic See-through run', () => {
  const result = assembleBodyCommand(input);
  const file = (name: string): PlannedFile | undefined => result.files.find((item) => item.name === name);
  const jsonOf = <T>(name: string): T => JSON.parse(file(name)?.bytes.toString('utf8') ?? '{}') as T;

  it('passes all offline checks and waits for the Spine CLI validation', () => {
    const validation = jsonOf<{ checks: { id: string; status: string; detail: string }[]; overall: string }>('evidence/validation.json');
    expect(validation.checks.filter((check) => check.status !== 'PASS')).toEqual([]);
    expect(result.report.status).toBe('PASS');
    expect(validation.overall).toBe('WAITING_FOR_SPINE_CLI_VALIDATION');
    expect(result.report.levels).toEqual({ JSON_GENERATED: 'PASS', CLI_VALIDATED: 'NOT_RUN', VISUALLY_VALIDATED: 'NOT_RUN' });
  });

  it('fills every required slot, keeps the optional slots without parts empty, and puts the held object in the far hand', () => {
    const skeleton = jsonOf<SpineSkeleton>(skeletonPath);
    const filled = skeleton.slots.filter((slot) => slot.attachment).map((slot) => slot.name);
    for (const slot of contractSlots(input.contractBytes).filter((item) => item.required)) expect(filled).toContain(slot.id);
    expect(filled).toContain('skirt_front');
    expect(filled).not.toContain('weapon');
    for (const slot of filled) {
      const png = file(`spine/images/${slot}.png`);
      expect(png).toBeDefined();
      const region = skeleton.skins[0]?.attachments[slot]?.[slot];
      const raster = decodePng(png?.bytes ?? Buffer.alloc(0)).raster;
      expect([raster.width, raster.height]).toEqual([region?.width, region?.height]);
    }
    const assembly = jsonOf<{ layers: { layer: string; slots: Record<string, number> }[] }>('evidence/assembly.json');
    expect(Object.keys(assembly.layers.find((layer) => layer.layer === 'objects')?.slots ?? {})).toEqual(['hand_far']);
    expect(Object.keys(assembly.layers.find((layer) => layer.layer === 'topwear')?.slots ?? {}).sort()).toEqual(['torso', 'upper_arm_far', 'upper_arm_near']);
    expect(skeleton.bones.map((bone) => bone.name)).toEqual(contractBones());
    expect(Object.keys(skeleton.animations)).toEqual(['idle', 'wave']);
  });

  it('keeps every source pixel in exactly one slot image', () => {
    const validation = jsonOf<{ conservation: { layer: string; exact: boolean; lostPixels: number }[] }>('evidence/validation.json');
    expect(validation.conservation.length).toBe(syntheticBody.layerFiles.size);
    expect(validation.conservation.every((item) => item.exact && item.lostPixels === 0)).toBe(true);
  });

  it('writes a character.json that the rig-runtime parser accepts', () => {
    const root = mkdtempSync(join(tmpdir(), 'aigg-body-sidecar-'));
    writeFileSync(join(root, 'contract.json'), input.contractBytes);
    writeFileSync(join(root, 'character.json'), file('character.json')?.bytes ?? Buffer.alloc(0));
    const bridge = fileURLToPath(new URL('rig-runtime/parse-character.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [bridge, join(root, 'contract.json'), join(root, 'character.json')], { encoding: 'utf8' });
    expect(JSON.parse(run.stdout) as unknown).toEqual({ ok: true, slots: contractSlots(input.contractBytes).length });
  });

  it('is deterministic: the same input gives the same files', () => {
    const again = assembleBodyCommand(input);
    expect(again.files.map((item) => [item.name, sha256(item.bytes)])).toEqual(result.files.map((item) => [item.name, sha256(item.bytes)]));
  });

  it('stops with E_LANDMARK when a body mark is missing', () => {
    const marks: Record<string, { x: number; y: number }> = { ...syntheticBody.marks };
    delete marks.knee_image_right;
    const landmarkBytes = syntheticBody.manual(marks);
    const studyBytes = syntheticBody.study(landmarkBytes, 1.2, sha256(input.imageBytes));
    try {
      assembleBodyCommand({ ...input, landmarkBytes, studyBytes });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ControlError);
      expect((error as ControlError).code).toBe('E_LANDMARK');
    }
  });
});

function contractBones(): string[] {
  const value = JSON.parse(input.contractBytes.toString('utf8')) as { bones: { id: string }[] };
  return value.bones.map((bone) => bone.id);
}

describe('spine-validate on the full-body package (fake Spine program)', () => {
  const generated = assembleBodyCommand(input);
  const root = mkdtempSync(join(tmpdir(), 'aigg-body-validate-'));
  const packageDir = join(root, 'package');
  for (const item of generated.files) {
    mkdirSync(join(packageDir, item.name, '..'), { recursive: true });
    writeFileSync(join(packageDir, item.name), item.bytes);
  }
  const spinePath = join(root, 'Spine');
  writeFileSync(spinePath, fakeSpine);
  chmodSync(spinePath, 0o755);
  let runs = 0;
  const validate = (mode: string): ReturnType<typeof spineValidateCommand> => {
    runs += 1;
    const out = join(root, `out-${runs}`);
    mkdirSync(out);
    process.env.FAKE_SPINE_MODE = mode;
    try {
      return spineValidateCommand({ spine: spinePath, packageDir, out, dryRun: false, toolVersion: '0', timeoutMs: 30_000 });
    } finally {
      delete process.env.FAKE_SPINE_MODE;
    }
  };

  it('finds the full-body layout and checks the manifests', () => {
    const layout = packageLayout(packageDir);
    expect(layout.layout).toBe('mvp-a-body');
    expect(layout.targets[0]?.images).toContain('hand_far');
    expect(verifyPackage(packageDir, layout).problems).toEqual([]);
  });

  it('reports CLI_VALIDATED for an exact export, and FAIL for a changed bone or a missing image', () => {
    const ok = validate('ok');
    expect(ok.report.status).toBe('PASS');
    expect(ok.files.some((item) => item.name === 'body/logs/import.stdout.log')).toBe(true);
    expect(validate('rotate').report.status).toBe('FAIL');
    expect(JSON.stringify(validate('drop-image').report)).toContain('no region for hand_near');
  });

  it('accepts the stepped curve on constant intervals (the Spine 4.3.26 export behavior)', () => {
    expect(validate('step-constant').report.status).toBe('PASS');
  });

  it('refuses a package whose image does not match the manifest', () => {
    const name = join(packageDir, 'spine', 'images', 'head.png');
    const original = generated.files.find((item) => item.name === 'spine/images/head.png')?.bytes ?? Buffer.alloc(0);
    const changed = decodePng(original).raster;
    changed.data[3] = changed.data[3] === 255 ? 254 : 255;
    try {
      writeFileSync(name, encodePng(changed));
      expect(() => validate('ok')).toThrow(ControlError);
    } finally {
      writeFileSync(name, original);
    }
  });
});
