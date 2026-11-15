import { landmarkFormat } from '@control/alignstudy';
import { compareLandmarksCommand, parseRun, similarityOf } from '@control/landmarkcompare';
import { encodePng, sha256 } from '@control/png';
import { ControlError } from '@control/problems';
import { Raster } from '@control/raster';
import { describe, expect, it } from 'vitest';

// L0-1d compare-landmarks tests with synthetic align-study outputs.

const frame = { width: 200, height: 300 };
const image = encodePng(new Raster(frame.width, frame.height, [220, 220, 220, 255]));
const template = { nose: { x: 500, y: 300 }, neck_base: { x: 510, y: 480 }, wrist_image_left: { x: 322, y: 905 }, ankle_image_right: { x: 577, y: 1446 } } as const;

/** A run whose character points are the template points scaled by 0.2 and moved by `shift` for one id. */
function run(shiftId?: string, shift = 0): { landmarks: Buffer; correspondence: Buffer } {
  const entries = Object.entries(template).map(([id, t]) => ({ id, character: { x: t.x * 0.2 - 10 + (id === shiftId ? shift : 0), y: t.y * 0.2 }, templatePoint: t, confidence: 'high' }));
  const landmarks = {
    format: landmarkFormat,
    frame,
    landmarks: [
      ...entries.map((entry) => ({ id: entry.id, point: entry.character, range: null, visibility: 'visible', confidence: 'high', origin: shiftId ? 'manual' : 'automatic' })),
      { id: 'hip_image_left', point: null, range: { left: 50, top: 150, right: 90, bottom: 180 }, visibility: 'unknown', confidence: 'none', origin: 'automatic' }
    ]
  };
  const correspondence = { template: { bodyHeightPx: 1240 }, alignment: [{ hypothesis: 'near_is_image_left', pairs: entries }] };
  return { landmarks: Buffer.from(JSON.stringify(landmarks)), correspondence: Buffer.from(JSON.stringify(correspondence)) };
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

describe('compare-landmarks', () => {
  it('gives a zero residual for an exact similarity and reports shifts per landmark', () => {
    const before = run();
    const after = run('nose', 6);
    const exact = similarityOf(parseRun(before.landmarks, before.correspondence, 'before'));
    expect(exact?.mean).toBe(0);
    const result = compareLandmarksCommand({ imageBytes: image, before, after, toolVersion: '0' });
    const report = JSON.parse(result.files.find((file) => file.name === 'comparison.json')?.bytes.toString('utf8') ?? '{}') as {
      landmarks: { id: string; shiftPx: number | null; afterPointInsideBeforeRange: boolean | null }[];
      fits: { before: { mean: number }; after: { mean: number } };
      counts: { after: { manual: number; unknown: number } };
    };
    expect(report.fits.before.mean).toBe(0);
    expect(report.fits.after.mean).toBeGreaterThan(0);
    expect(report.landmarks.find((row) => row.id === 'nose')?.shiftPx).toBe(6);
    expect(report.landmarks.find((row) => row.id === 'neck_base')?.shiftPx).toBe(0);
    expect(report.landmarks.find((row) => row.id === 'hip_image_left')?.shiftPx).toBeNull();
    expect(report.counts.after).toMatchObject({ manual: 4, unknown: 1 });
    expect(result.files.map((file) => file.name).sort()).toEqual(['alignment-before-after.png', 'before-after-landmarks.png', 'comparison.json', 'contact-sheet.png', 'error-vectors.png']);
    const again = compareLandmarksCommand({ imageBytes: image, before, after, toolVersion: '0' });
    expect(again.files.map((file) => sha256(file.bytes))).toEqual(result.files.map((file) => sha256(file.bytes)));
  });

  it('refuses invalid runs and a wrong image size', () => {
    const good = run();
    expect(codeOf(() => parseRun(Buffer.from('{'), good.correspondence, 'x'))).toBe('E_INPUT');
    expect(codeOf(() => parseRun(good.landmarks, Buffer.from('{"template":{},"alignment":[]}'), 'x'))).toBe('E_INPUT');
    expect(codeOf(() => parseRun(Buffer.from(JSON.stringify({ format: landmarkFormat, frame, landmarks: [{ id: 'nose', point: { x: 999, y: 1 } }] })), good.correspondence, 'x'))).toBe('E_INPUT');
    expect(codeOf(() => compareLandmarksCommand({ imageBytes: encodePng(new Raster(10, 10)), before: good, after: good, toolVersion: '0' }))).toBe('E_IMAGE');
  });
});
