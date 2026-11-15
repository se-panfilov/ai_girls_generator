import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { landmarkFormat } from '@control/alignstudy';
import { composite } from '@control/layersplit';
import { compose, cutArm, foreLabel, handLabel, limbStudyCommand, residualLabel, rotationAbout, rotationTests, transformPart, upperLabel } from '@control/limbstudy';
import { encodePng, sha256 } from '@control/png';
import { ControlError } from '@control/problems';
import { type Color, Raster } from '@control/raster';
import { describe, expect, it } from 'vitest';

// L0-1e limb-study tests with a synthetic See-through run: a straight arm of simple shapes on a 240 x 360 frame. No character image is used.

const contractBytes = readFileSync(fileURLToPath(new URL('fixtures/c05-candidate/rig.contract.json', import.meta.url)));
const width = 240;
const height = 360;
const skin: Color = [230, 190, 160, 255];
const glove: Color = [40, 60, 150, 255];
const cloth: Color = [60, 60, 70, 255];

const shoulder = { x: 70, y: 60 };
const elbow = { x: 70, y: 140 };
const wrist = { x: 70, y: 220 };

function layersOf(): Map<string, Raster> {
  const handwear = new Raster(width, height);
  handwear.line(shoulder, elbow, 30, skin);
  handwear.line(elbow, wrist, 26, skin);
  handwear.line(wrist, { x: 70, y: 260 }, 24, glove);
  handwear.line({ x: 170, y: 60 }, { x: 170, y: 250 }, 24, skin);
  const topwear = new Raster(width, height);
  topwear.fillPolygon(
    [
      { x: 90, y: 50 },
      { x: 150, y: 50 },
      { x: 150, y: 200 },
      { x: 90, y: 200 }
    ],
    cloth
  );
  return new Map([
    ['topwear', topwear],
    ['handwear', handwear]
  ]);
}

const layers = layersOf();
const image = composite(width, height, [...layers.values()]);
const imageBytes = encodePng(image);
const metadataBytes = Buffer.from(
  JSON.stringify({
    parts: Object.fromEntries([...layers.keys()].map((tag, index) => [tag, { xyxy: [0, 0, width, height], tag, part_id: index, depth_median: 0.9 - index * 0.1 }])),
    frame_size: [width, height]
  })
);
const layerFiles = new Map([...layers].map(([tag, raster]) => [tag, { name: `${tag}.png`, bytes: encodePng(raster) }]));

function manual(points: Record<string, { x: number; y: number }>): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: landmarkFormat,
      markedBy: 'synthetic test',
      landmarks: Object.entries(points).map(([id, point]) => ({ id, visibility: 'visible', confidence: 'high', x: point.x, y: point.y, method: 'synthetic mark', note: 'synthetic' }))
    })
  );
}

const landmarkBytes = manual({ shoulder_image_left: shoulder, elbow_image_left: elbow, wrist_image_left: wrist });

function study(landmarks: Buffer, scale = 1.2, imageSha = sha256(imageBytes)): Buffer {
  return Buffer.from(
    JSON.stringify({
      inputs: { image: { sha256: imageSha }, manualLandmarks: sha256(landmarks) },
      alignment: [{ hypothesis: 'near_is_image_left', fits: [{ name: 'similarity', landmarkSet: 'confidence >= medium', scale: { s1: scale } }] }]
    })
  );
}

const run = (overrides: Partial<Parameters<typeof limbStudyCommand>[0]> = {}): ReturnType<typeof limbStudyCommand> =>
  limbStudyCommand({ contractBytes, metadataBytes, metadataName: 'synthetic.psd.json', layerFiles, imageBytes, landmarkBytes, studyBytes: study(landmarkBytes), toolVersion: '0', ...overrides });

const codeOf = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    if (error instanceof ControlError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

type Metrics = {
  status: { cut: string; sourcePose: string };
  split: { parts: { part: string; pixels: number }[]; residualPixels: number; fragmentPixels: number; armConservation: { exact: boolean }; handwearConservation: { exact: boolean } };
  overlap: { joint: string; radiusImagePx: number; coverageOfArmPartOfDiskByParent: number; missingParentPixelsInsideArm: number; parentSourceMarginPastCutPx: number }[];
  tests: { id: string; joints: { joint: string; gapPixels: number; protrusionPixels: number }[] }[];
  sourcePose: { recomposedEqualsLayerComposite: boolean };
};

describe('limb-study', () => {
  const result = run();
  const metrics = JSON.parse(result.files.find((file) => file.name === 'metrics.json')?.bytes.toString('utf8') ?? '{}') as Metrics;

  it('cuts the arm into three parts with an exact partition', () => {
    expect(metrics.status).toEqual({ cut: 'PASS', sourcePose: 'PASS' });
    expect(metrics.split.armConservation.exact).toBe(true);
    expect(metrics.split.handwearConservation.exact).toBe(true);
    expect(metrics.split.residualPixels).toBe(0);
    expect(metrics.split.parts.map((part) => part.part)).toEqual(['upper_arm', 'forearm', 'hand']);
    for (const part of metrics.split.parts) expect(part.pixels).toBeGreaterThan(500);
  });

  it('measures half of the overlap circle as missing parent pixels for a straight limb', () => {
    for (const joint of metrics.overlap) {
      expect(joint.radiusImagePx).toBeCloseTo(24 / 1.2, 5);
      expect(joint.parentSourceMarginPastCutPx).toBe(0);
      expect(joint.coverageOfArmPartOfDiskByParent).toBeGreaterThan(0.4);
      expect(joint.coverageOfArmPartOfDiskByParent).toBeLessThan(0.6);
      expect(joint.missingParentPixelsInsideArm).toBeGreaterThan(0);
    }
  });

  it('has no gap in the source pose and opens a gap when a joint turns', () => {
    const byId = new Map(metrics.tests.map((test) => [test.id, test]));
    for (const joint of byId.get('source')?.joints ?? []) expect(joint.gapPixels + joint.protrusionPixels).toBe(0);
    expect(byId.get('elbow+30')?.joints[0]?.gapPixels).toBeGreaterThan(byId.get('elbow+15')?.joints[0]?.gapPixels ?? Infinity);
    expect(byId.get('wrist-15')?.joints[1]?.gapPixels).toBeGreaterThan(0);
    expect(byId.get('wrist-15')?.joints[0]?.gapPixels).toBe(0);
    expect(metrics.sourcePose.recomposedEqualsLayerComposite).toBe(true);
  });

  it('writes the same files twice and one result, hole map, and overlap map per test', () => {
    const again = run();
    expect(again.files.map((file) => sha256(file.bytes))).toEqual(result.files.map((file) => sha256(file.bytes)));
    const names = result.files.map((file) => file.name);
    for (const test of rotationTests) for (const kind of ['result', 'holes', 'overlaps']) expect(names).toContain(`rotations/${test.id}/${kind}.png`);
    for (const name of ['parts/upper_arm.png', 'parts/forearm.png', 'parts/hand.png', 'parts/residual.png', '3-rotation-contact-sheet.png', '6-missing-geometry.png']) expect(names).toContain(name);
  });

  it('refuses inputs that do not belong together', () => {
    expect(codeOf(() => run({ studyBytes: study(manual({ shoulder_image_left: shoulder })) }))).toBe('E_INPUT');
    expect(codeOf(() => run({ studyBytes: study(landmarkBytes, 1.2, 'f'.repeat(64)) }))).toBe('E_INPUT');
    expect(codeOf(() => run({ studyBytes: study(landmarkBytes, 50) }))).toBe('E_INPUT');
    const partial = manual({ shoulder_image_left: shoulder, elbow_image_left: elbow });
    expect(codeOf(() => run({ landmarkBytes: partial, studyBytes: study(partial) }))).toBe('E_LANDMARK');
    expect(codeOf(() => run({ contractBytes: Buffer.from('{}') }))).not.toBe('NO_ERROR');
  });
});

describe('limb-study geometry', () => {
  it('assigns each arm pixel to exactly one label with cut lines that follow a bent limb', () => {
    const arm = new Raster(width, height);
    const bent = { x: 110, y: 150 };
    arm.line(shoulder, bent, 24, skin);
    arm.line(bent, { x: 80, y: 230 }, 20, skin);
    arm.line({ x: 80, y: 230 }, { x: 70, y: 260 }, 18, glove);
    // A fragment that is not connected to the arm.
    arm.fillCircle({ x: 30, y: 300 }, 2, skin);
    const cut = cutArm(arm, shoulder, bent, { x: 80, y: 230 });
    expect(cut.fragmentPixels).toBeGreaterThan(0);
    expect(cut.assignment[300 * width + 30]).toBe(residualLabel);
    let armPixels = 0;
    for (let p = 0; p < width * height; p += 1) {
      const alpha = arm.data[p * 4 + 3] ?? 0;
      if (alpha > 0) armPixels += 1;
      const label = cut.assignment[p] ?? 0;
      expect(alpha > 0 ? [upperLabel, foreLabel, handLabel, residualLabel].includes(label) : label === 0).toBe(true);
    }
    expect(armPixels).toBeGreaterThan(0);
    expect(cut.conflictPixels).toBe(0);
    // The elbow cut normal is the bisector of the two limb directions, not the image vertical.
    const u = { x: 40 / Math.hypot(40, 90), y: 90 / Math.hypot(40, 90) };
    const v = { x: -30 / Math.hypot(30, 80), y: 80 / Math.hypot(30, 80) };
    const length = Math.hypot(u.x + v.x, u.y + v.y);
    expect(cut.elbow.normal.x).toBeCloseTo((u.x + v.x) / length, 6);
    expect(cut.elbow.normal.y).toBeCloseTo((u.y + v.y) / length, 6);
  });

  it('copies pixels exactly for a zero rotation and keeps every moved pixel a copy of a source pixel', () => {
    const source = new Raster(40, 40);
    for (let p = 0; p < 1600; p += 1) if (p % 7 !== 0) source.data.set([p % 251, (p * 3) % 251, (p * 7) % 251, 1 + (p % 255)], p * 4);
    const same = transformPart(source, rotationAbout({ x: 20, y: 20 }, 0));
    expect(Buffer.from(same.data).equals(Buffer.from(source.data))).toBe(true);
    const colors = new Set<string>();
    for (let p = 0; p < 1600; p += 1) colors.add(Array.from(source.data.subarray(p * 4, p * 4 + 4)).join(','));
    for (let a = -45; a <= 45; a += 9) {
      for (const b of [-30, -7, 0, 13, 30]) {
        const moved = transformPart(source, compose(rotationAbout({ x: 20, y: 20 }, a), rotationAbout({ x: 12, y: 30 }, b)));
        for (let p = 0; p < 1600; p += 1) {
          if ((moved.data[p * 4 + 3] ?? 0) === 0) continue;
          expect(colors.has(Array.from(moved.data.subarray(p * 4, p * 4 + 4)).join(','))).toBe(true);
        }
      }
    }
  });
});
