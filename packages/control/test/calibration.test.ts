import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { calibrateCommand, candidateCommand, parseContractBytes } from '@control/commands';
import { consistencyChecks } from '@control/consistency';
import { parseControlContract } from '@control/contract';
import { extremeTime, parseAnimations, posedContract } from '@control/kinematics';
import { bodyProjection, candidateContract } from '@control/mannequin';
import { rigPose } from '@control/pose';
import { ControlError } from '@control/problems';
import { describe, expect, it } from 'vitest';

import { bytesOf, l1ContractBytes, syntheticContract } from './helpers';

const fixture = (): Buffer => readFileSync(fileURLToPath(new URL('fixtures/c05-candidate/rig.contract.json', import.meta.url)));
const l1Skeleton = (): Buffer => readFileSync(fileURLToPath(new URL('../../rig-runtime/test/fixtures/l1-owner/editor-out/skeleton.json', import.meta.url)));
const statusOf = (checks: ReturnType<typeof consistencyChecks>): Record<string, string> => Object.fromEntries(checks.map((check) => [check.id, check.status]));

describe('candidate contract', () => {
  it('is the generator output for the L1 base (the fixture bytes match)', () => {
    const result = candidateCommand(l1ContractBytes());
    expect(result.files[0]?.bytes.equals(fixture())).toBe(true);
  });

  it('keeps ids, parents, roles, slots, draw order, overlaps and animations of the base', () => {
    const base = JSON.parse(l1ContractBytes().toString('utf8')) as Record<string, unknown[]>;
    const candidate = JSON.parse(fixture().toString('utf8')) as Record<string, unknown[]>;
    const strip = (items: unknown[], drop: string): unknown[] => items.map((item) => Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([key]) => key !== drop)));
    expect(strip(candidate.bones ?? [], 'joint')).toEqual(strip(base.bones ?? [], 'joint'));
    expect(strip(candidate.slots ?? [], 'attachmentRect')).toEqual(strip(base.slots ?? [], 'attachmentRect'));
    expect(candidate.animations).toEqual(base.animations);
  });

  it('passes every geometric and heuristic check', () => {
    const status = statusOf(consistencyChecks(parseContractBytes(fixture())));
    expect(Object.entries(status).filter(([, value]) => value === 'FAIL' || value === 'INCOMPLETE')).toEqual([]);
  });

  it('keeps the side order and the OpenPose labels for any front-visible yaw', () => {
    const base = JSON.parse(l1ContractBytes().toString('utf8')) as Record<string, unknown>;
    for (const yaw of [15, 25, 35, 45, 55, 65]) {
      const status = statusOf(consistencyChecks(parseControlContract(candidateContract(base, yaw))));
      expect([status.V1_SHOULDER_ORDER, status.V2_HIP_ORDER, status.V5_FACE_DIRECTION, status.V6_OPENPOSE_LABELS, status.V7_DRAW_ORDER], `yaw ${yaw}`).toEqual([
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS'
      ]);
    }
  });

  it('takes the face keypoints from the contract points and hides the far ear', () => {
    const pose = rigPose(parseContractBytes(fixture()), 'anatomical');
    const byName = Object.fromEntries(pose.keypoints.map((item) => [item.name, item]));
    expect(byName.nose?.source).toBe('point:face_nose');
    expect(byName.r_eye?.source).toBe('point:face_eye_near');
    expect(byName.l_ear?.point).toBeNull();
    expect(pose.bodyHeightSource).toBe('space.rigOrigin.y - points.head_top.y');
    expect(pose.warnings).toEqual([]);
  });

  it('rejects a yaw outside the front-visible range', () => {
    expect(() => bodyProjection({ x: 0, y: 0 }, 700, 90)).toThrow(ControlError);
  });
});

describe('consistency checks', () => {
  it('report the F1 mismatch on the L1 test rig', () => {
    const status = statusOf(consistencyChecks(parseContractBytes(l1ContractBytes())));
    expect(status).toMatchObject({
      V1_SHOULDER_ORDER: 'FAIL',
      V2_HIP_ORDER: 'FAIL',
      V3_EAR_BONE_ORDER: 'FAIL',
      V4_FRONT_BACK_CUES: 'PASS',
      V5_FACE_DIRECTION: 'INCOMPLETE',
      V6_OPENPOSE_LABELS: 'FAIL',
      V7_DRAW_ORDER: 'PASS',
      V9_ADULT_PROPORTION: 'INCOMPLETE',
      V10_NEAR_ARM_SEPARATION: 'FAIL'
    });
  });

  it('separate the side layout of a synthetic contract', () => {
    expect(statusOf(consistencyChecks(parseControlContract(syntheticContract(true)))).V1_SHOULDER_ORDER).toBe('PASS');
    expect(statusOf(consistencyChecks(parseControlContract(syntheticContract(false)))).V1_SHOULDER_ORDER).toBe('FAIL');
  });
});

describe('kinematics', () => {
  it('rotates a child around its parent counterclockwise in rig space', () => {
    const contract = parseControlContract(syntheticContract());
    const animation = { name: 'test', bones: new Map([['upper_arm_near', { rotate: [{ time: 0, value: 90 }], translate: [] }]]) };
    const posed = posedContract(contract, animation, 0);
    const shoulder = contract.bones.get('upper_arm_near')?.joint ?? { x: 0, y: 0 };
    const elbow = contract.bones.get('forearm_near')?.joint ?? { x: 0, y: 0 };
    // The elbow hangs below the shoulder. A counterclockwise quarter turn (Y up) moves it to the right of the shoulder in the image.
    const moved = posed.bones.get('forearm_near')?.joint ?? { x: 0, y: 0 };
    expect(moved.x).toBeCloseTo(shoulder.x + (elbow.y - shoulder.y), 6);
    expect(moved.y).toBeCloseTo(shoulder.y - (elbow.x - shoulder.x), 6);
  });

  it('reads the L1 animations and finds the extreme key time', () => {
    const { animations } = parseAnimations(JSON.parse(l1Skeleton().toString('utf8')));
    expect(animations.map((item) => item.name)).toContain('shoot_stand');
    const shoot = animations.find((item) => item.name === 'shoot_stand');
    expect(shoot && extremeTime(shoot)).toBeGreaterThan(0);
  });

  it('rejects a non-numeric key', () => {
    expect(() => parseAnimations({ animations: { a: { bones: { hips: { rotate: [{ time: 0, value: 'x' }] } } } } })).toThrow(ControlError);
  });
});

describe('calibrate command', () => {
  it('writes the comparison, the overlays, the key poses and a migration table without id or draw order changes', () => {
    const result = calibrateCommand({ beforeBytes: l1ContractBytes(), afterBytes: fixture(), skeletonBytes: l1Skeleton(), size: '416x608' });
    expect(result.files.map((file) => file.name).sort()).toEqual(
      [
        'after-mannequin.png',
        'after-openpose-anatomical.png',
        'after-overlay.png',
        'animation-key-poses.png',
        'before-mannequin.png',
        'before-openpose-anatomical.png',
        'before-overlay.png',
        'calibration.json',
        'comparison.png'
      ].sort()
    );
    const migration = result.report.migration as { sameBoneAndSlotIds: boolean; drawOrderChanged: string[]; addedPoints: string[] };
    expect(migration.sameBoneAndSlotIds).toBe(true);
    expect(migration.drawOrderChanged).toEqual([]);
    expect(migration.addedPoints).toEqual(['head_top', 'face_nose', 'face_eye_near', 'face_eye_far', 'face_ear_near']);
    expect(result.report.status).toBe('PASS');
  });

  it('is deterministic', () => {
    const run = (): Buffer[] => calibrateCommand({ beforeBytes: l1ContractBytes(), afterBytes: fixture(), size: '208x304' }).files.map((file) => file.bytes);
    expect(run()).toEqual(run());
  });

  it('works on a synthetic pair without a skeleton', () => {
    const result = calibrateCommand({ beforeBytes: bytesOf(syntheticContract(false)), afterBytes: bytesOf(syntheticContract(true)), size: '200x300' });
    expect(result.files.some((file) => file.name === 'animation-key-poses.png')).toBe(false);
  });
});
