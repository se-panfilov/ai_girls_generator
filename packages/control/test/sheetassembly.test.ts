import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type buildBodySkeleton, poseAt } from '@control/bodyrig';
import { parseControlContract } from '@control/contract';
import { syntheticSheetCommand } from '@control/modularsheet';
import { decodePng, sha256 } from '@control/png';
import { ControlError } from '@control/problems';
import { parseExtraction, placePart, sheetAssembleCommand } from '@control/sheetassembly';
import { sheetExtractCommand } from '@control/sheetextract';
import { skeletonBytes, type WorldBone, worldBones } from '@control/spineskeleton';
import * as spine from '@esotericsoftware/spine-core';
import { describe, expect, it } from 'vitest';

// V2-3 spike tests: the V2-2 output of the synthetic V2-1 sheet on the C0.5 candidate skeleton. Synthetic data only.
// The renders are the local renderer of MVP-A, not Spine. The spine-core test reads the JSON with a stand-in atlas.

const contractBytes = readFileSync(fileURLToPath(new URL('fixtures/c05-candidate/rig.contract.json', import.meta.url)));
const contract = parseControlContract(JSON.parse(contractBytes.toString('utf8')));
const toolVersion = (JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;
const fixture = syntheticSheetCommand({ contractBytes, toolVersion });
const fixtureFile = (name: string): Buffer => fixture.files.find((file) => file.name === name)?.bytes as Buffer;
const extraction = sheetExtractCommand({ contractBytes, descriptorBytes: fixtureFile('synthetic-sheet.json'), sheetBytes: fixtureFile('synthetic-sheet.png'), toolVersion });
const extractionFile = (name: string): Buffer => extraction.files.find((file) => file.name === name)?.bytes as Buffer;
const manifestBytes = extractionFile('extraction.json');
const partFiles = new Map(parseExtraction(manifestBytes).parts.map((part) => [part.slot, extractionFile(part.file)]));
const assemble = (options: { manifest?: Buffer; parts?: Map<string, Buffer> } = {}): ReturnType<typeof sheetAssembleCommand> =>
  sheetAssembleCommand({ contractBytes, manifestBytes: options.manifest ?? manifestBytes, partFiles: options.parts ?? partFiles, toolVersion });
const result = assemble();
const file = (name: string): Buffer => result.files.find((item) => item.name === name)?.bytes as Buffer;
const skeleton = JSON.parse(file('spine/skeleton.json').toString('utf8')) as ReturnType<typeof buildBodySkeleton>;
const statusOf = (id: string): string | undefined => (result.report.checks as { id: string; status: string }[]).find((check) => check.id === id)?.status;
const codeOf = (action: () => unknown): string | null => {
  try {
    action();
  } catch (error) {
    if (error instanceof ControlError) return error.code;
    throw error;
  }
  return null;
};

describe('sheet-assemble (V2-3 spike) on the synthetic sheet', () => {
  it('passes all checks and keeps the 28 contract bones, 27 contract slots, 18 parts, and 9 empty slots', () => {
    expect(result.report.status).toBe('PASS');
    expect(skeleton.bones.map((bone) => [bone.name, bone.parent ?? null])).toEqual([...contract.bones.values()].map((bone) => [bone.id, bone.parent]));
    const ordered = [...contract.slots.values()].sort((a, b) => a.drawOrder - b.drawOrder);
    expect(skeleton.slots.map((slot) => [slot.name, slot.bone])).toEqual(ordered.map((slot) => [slot.id, slot.bone]));
    expect(skeleton.slots.filter((slot) => slot.attachment !== undefined)).toHaveLength(18);
    expect(
      skeleton.slots
        .filter((slot) => slot.attachment === undefined)
        .map((slot) => slot.name)
        .sort()
    ).toEqual([...parseExtraction(manifestBytes).absent].sort());
    expect(Object.keys(skeleton.animations).sort()).toEqual(['idle', 'wave']);
  });

  it('puts the bones on the contract joints and copies the extracted PNG bytes without a change', () => {
    const world = worldBones(skeleton.bones);
    for (const bone of contract.bones.values()) {
      const at = world.get(bone.id) as WorldBone;
      expect(Math.abs(at.x - (bone.joint.x - contract.rigOrigin.x))).toBeLessThan(1e-3);
      expect(Math.abs(at.y - (contract.rigOrigin.y - bone.joint.y))).toBeLessThan(1e-3);
    }
    for (const [slot, bytes] of partFiles) expect(sha256(file(`spine/images/${slot}.png`))).toBe(sha256(bytes));
  });

  it('places each part with its descriptor joint on the contract joint, which agrees with the attachment rectangle', () => {
    for (const part of parseExtraction(manifestBytes).parts) {
      const placement = placePart(part, contract);
      expect(placement.method).toBe('descriptor_joint');
      expect(placement.rectDelta).toEqual({ x: 0, y: 0 });
      expect(placement.scale).toEqual({ x: 1, y: 1 });
      for (const residual of placement.jointResiduals) expect(residual.distance).toBe(0);
    }
    // Without joints, the part goes to the attachment rectangle.
    const torso = parseExtraction(manifestBytes).parts.find((part) => part.slot === 'torso');
    const placed = placePart({ ...(torso as NonNullable<typeof torso>), joints: null }, contract);
    expect(placed.method).toBe('attachment_rect');
    expect(placed.box).toMatchObject({ left: contract.slots.get('torso')?.attachmentRect.x, top: contract.slots.get('torso')?.attachmentRect.y });
  });

  it('reports a joint offset and a scale difference instead of hiding them', () => {
    const torso = parseExtraction(manifestBytes).parts.find((part) => part.slot === 'torso') as NonNullable<ReturnType<typeof parseExtraction>['parts'][number]>;
    const shifted = { ...torso, joints: (torso.joints ?? []).map((point) => ({ bone: point.bone, local: { x: point.local.x + 5.4, y: point.local.y - 2 } })) };
    const placement = placePart(shifted, contract);
    expect(placement.rectDelta).toEqual({ x: -5, y: 2 });
    expect(placement.rounding.x).toBeCloseTo(0.4, 10);
    const bigger = placePart({ ...torso, size: { width: torso.size.width * 2, height: torso.size.height } }, contract);
    expect(bigger.scale).toEqual({ x: 2, y: 1 });
  });

  it('renders a setup pose equal to the placed parts, and a wave frame that moves only the near arm chain and the upper body', () => {
    expect(statusOf('setup_pose_render')).toBe('PASS');
    expect(statusOf('wave_moves_near_arm')).toBe('PASS');
    expect(statusOf('near_arm_joints_covered')).toBe('PASS');
    expect((result.report.waveEvidence as { nearWristMovePx: number }).nearWristMovePx).toBeGreaterThan(100);
    expect(decodePng(file('previews/wave.png')).raster.width).toBeGreaterThan(1000);
  });

  it('reads with the official spine-core 4.3 runtime and plays wave with the same joints as the local model', () => {
    const regions = skeleton.slots.filter((slot) => slot.attachment).map((slot) => slot.name);
    const atlas = new spine.TextureAtlas(`page.png\nsize:4096,4096\nfilter:Linear,Linear\n${regions.map((name, i) => `${name}\nbounds:${i * 64},0,32,32`).join('\n')}\n`);
    const data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(skeletonBytes(skeleton).toString('utf8'));
    expect(data.bones).toHaveLength(28);
    expect(data.slots).toHaveLength(27);
    for (const time of [0, 0.4, 1]) {
      const runtime = new spine.Skeleton(data);
      runtime.setupPose();
      const state = new spine.AnimationState(new spine.AnimationStateData(data));
      state.setAnimation(0, 'wave', false);
      state.update(time);
      state.apply(runtime);
      runtime.updateWorldTransform(spine.Physics.none);
      const local = worldBones(skeleton.bones, poseAt(skeleton, 'wave', time));
      for (const bone of runtime.bones) {
        const mine = local.get(bone.data.name) as WorldBone;
        expect(Math.abs(bone.appliedPose.worldX - mine.x)).toBeLessThan(1e-3);
        expect(Math.abs(bone.appliedPose.worldY - mine.y)).toBeLessThan(1e-3);
      }
    }
  });

  it('is deterministic', () => {
    expect(assemble().files.map((item) => [item.name, sha256(item.bytes)])).toEqual(result.files.map((item) => [item.name, sha256(item.bytes)]));
  });

  it('refuses a changed part, a missing part, and a manifest for another contract', () => {
    const changed = new Map(partFiles);
    changed.set('torso', partFiles.get('neck') as Buffer);
    expect(codeOf(() => assemble({ parts: changed }))).toBe('E_ASSEMBLY_INPUT');
    const missing = new Map(partFiles);
    missing.delete('head');
    expect(codeOf(() => assemble({ parts: missing }))).toBe('E_ASSEMBLY_INPUT');
    const other = JSON.parse(manifestBytes.toString('utf8')) as { rig: { contractSha256: string } };
    other.rig.contractSha256 = '0'.repeat(64);
    expect(codeOf(() => assemble({ manifest: Buffer.from(JSON.stringify(other)) }))).toBe('E_ASSEMBLY_RIG');
    const badFile = JSON.parse(manifestBytes.toString('utf8')) as { parts: { file: string }[] };
    (badFile.parts[0] as { file: string }).file = '../escape.png';
    expect(codeOf(() => assemble({ manifest: Buffer.from(JSON.stringify(badFile)) }))).toBe('E_EXTRACTION_FORMAT');
  });
});
