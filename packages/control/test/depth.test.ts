import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { bundleCommand } from '@control/bundle';
import { depthCommand, parseContractBytes } from '@control/commands';
import { castFront, depthPrimitives, intersect, loftSection, renderDepthSamples, toCamera } from '@control/depth';
import { referenceBody } from '@control/mannequin';
import { decodePng, sha256 } from '@control/png';
import { fitTransform, toTarget } from '@control/pose';
import { ControlError } from '@control/problems';
import { describe, expect, it } from 'vitest';

import { bytesOf, syntheticContract } from './helpers';

const candidateBytes = (): Buffer => readFileSync(fileURLToPath(new URL('fixtures/c05-candidate/rig.contract.json', import.meta.url)));
const codeOf = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    if (error instanceof ControlError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

describe('depth volumes', () => {
  it('intersects an ellipsoid and a capsule at the expected distance', () => {
    const sphere = { kind: 'ellipsoid', id: 's', part: 'head', center: { l: 0, up: 0, f: 0 }, radii: { l: 1, up: 2, f: 0.5 } } as const;
    // A ray along -forward from forward = 10 hits the front of the ellipsoid at forward = 0.5.
    expect(intersect(sphere, { l: 0, up: 0, f: 10 }, { l: 0, up: 0, f: -1 })).toBeCloseTo(9.5, 9);
    expect(intersect(sphere, { l: 1.01, up: 0, f: 10 }, { l: 0, up: 0, f: -1 })).toBe(-1);
    const capsule = { kind: 'capsule', id: 'c', part: 'arm_near', a: { l: 0, up: 0, f: 0 }, b: { l: 0, up: 2, f: 0 }, r: 0.25 } as const;
    expect(intersect(capsule, { l: 0, up: 1, f: 10 }, { l: 0, up: 0, f: -1 })).toBeCloseTo(9.75, 9);
    // Above the segment end, the end sphere is hit.
    expect(intersect(capsule, { l: 0, up: 2.2, f: 10 }, { l: 0, up: 0, f: -1 })).toBeCloseTo(10 - Math.sqrt(0.25 ** 2 - 0.2 ** 2), 9);
    expect(intersect(capsule, { l: 0, up: 2.3, f: 10 }, { l: 0, up: 0, f: -1 })).toBe(-1);
  });

  it('gives a smooth torso section with closed ends', () => {
    const sections = [
      { up: 0, w: 1, d: 0.5 },
      { up: 1, w: 0.5, d: 0.5 }
    ];
    expect(loftSection(sections, 0.1, 0.1, 0)).toEqual({ w: 1, d: 0.5 });
    expect(loftSection(sections, 0.1, 0.1, 0.5)?.w).toBeCloseTo(0.75, 9);
    expect(loftSection(sections, 0.1, 0.1, 1.05)?.w).toBeLessThan(0.5);
    expect(loftSection(sections, 0.1, 0.1, 1.1)).toBeNull();
    expect(loftSection(sections, 0.1, 0.1, -0.2)).toBeNull();
  });

  it('turns the reference body to the image right and the near side to the camera', () => {
    const nose = toCamera({ l: 0, up: 6.3, f: 0.55 }, referenceBody.yawDegrees);
    expect(nose.x).toBeGreaterThan(0);
    expect(nose.z).toBeGreaterThan(0);
    // The near side is the subject's right side (left < 0): toward the camera and to the image left.
    const nearShoulder = toCamera({ l: -0.85, up: 5.55, f: 0 }, referenceBody.yawDegrees);
    expect(nearShoulder.x).toBeLessThan(0);
    expect(nearShoulder.z).toBeGreaterThan(0);
    expect(depthPrimitives().filter((item) => item.part === 'arm_far')).toHaveLength(3);
  });
});

describe('depth command', () => {
  const size = '416x608';

  it('is deterministic, passes D1 to D7 for the C0.5 candidate, and writes the preview files', () => {
    const first = depthCommand(candidateBytes(), size);
    expect(first.report.status).toBe('PASS');
    expect((first.report.checks as { id: string; status: string }[]).map((check) => `${check.id}:${check.status}`)).toEqual([
      'D1:PASS',
      'D2:PASS',
      'D3:PASS',
      'D4:PASS',
      'D5:PASS',
      'D6:PASS',
      'D7:PASS'
    ]);
    expect(first.files.map((file) => file.name)).toEqual(['depth-c05.png', 'depth-parts.png', 'depth-top-view.png', 'depth-preview.png', 'depth.json']);
    const again = depthCommand(candidateBytes(), size);
    expect(again.files.map((file) => sha256(file.bytes))).toEqual(first.files.map((file) => sha256(file.bytes)));
    const depth = decodePng(first.files[0]?.bytes ?? Buffer.alloc(0)).raster;
    expect([depth.width, depth.height]).toEqual([416, 608]);
    expect(depth.pixel(2, 2)).toEqual([0, 0, 0, 255]);
  });

  it('draws the near hand nearer (brighter) than the far hand, and the near leg over the far leg', () => {
    const contract = parseContractBytes(candidateBytes());
    const target = { width: 416, height: 608 };
    const transform = fitTransform(contract.canvas, target);
    const result = depthCommand(candidateBytes(), '416x608');
    const depth = decodePng(result.files[0]?.bytes ?? Buffer.alloc(0)).raster;
    const at = (bone: string, dy = 0): number => {
      const joint = contract.bones.get(bone)?.joint ?? { x: 0, y: 0 };
      const point = toTarget({ x: joint.x, y: joint.y + dy }, transform);
      return depth.pixel(Math.floor(point.x), Math.floor(point.y))[0];
    };
    expect(at('hand_near', 30)).toBeGreaterThan(at('hand_far', 30));
    expect(at('shin_near')).toBeGreaterThan(at('shin_far'));
    // On a ray through both legs, the near leg is the visible surface.
    const render = renderDepthSamples(contract, target, transform);
    expect(render.zNear).toBeGreaterThan(render.zFar);
    const primitives = depthPrimitives();
    const boxes = primitives.map(() => ({ x0: -100, x1: 100, y0: -100, y1: 100 }));
    const hit = castFront(primitives, boxes, toCamera({ l: -0.45, up: 2.5, f: 0 }, 40).x, 2.5, 40);
    expect(hit?.part).toBe('leg_near');
  });

  it('refuses a contract that is not the C0.5 candidate, and fails D1 when a candidate joint moved', () => {
    expect(codeOf(() => depthCommand(bytesOf(syntheticContract()), size))).toBe('E_CONTRACT_NOT_CANDIDATE');
    const moved = JSON.parse(candidateBytes().toString('utf8')) as { bones: { id: string; joint: { x: number; y: number } }[] };
    const bone = moved.bones.find((item) => item.id === 'forearm_far');
    if (bone) bone.joint = { x: bone.joint.x + 6, y: bone.joint.y };
    const result = depthCommand(bytesOf(moved), size);
    expect(result.report.status).toBe('FAIL');
    expect((result.report.checks as { id: string; status: string }[])[0]).toMatchObject({ id: 'D1', status: 'FAIL' });
    expect(codeOf(() => bundleCommand({ contractBytes: bytesOf(moved), runnerBytes: Buffer.from('x'), experiment: 'c2' }))).toBe('E_DEPTH_CHECK');
  });
});
