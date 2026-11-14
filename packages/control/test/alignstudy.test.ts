import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { alignStudyCommand, completedMask, correspondence, type Landmark, landmarkFormat, landmarkIds, manualTemplate, measureLandmarks, parseManualLandmarks } from '@control/alignstudy';
import { parseContractBytes } from '@control/commands';
import type { Joint } from '@control/contract';
import { composite } from '@control/layersplit';
import { encodePng, sha256 } from '@control/png';
import { ControlError } from '@control/problems';
import { type Color, Raster } from '@control/raster';
import { describe, expect, it } from 'vitest';

import { temporaryDirectory } from './helpers';

// L0-1c align-study tests with a synthetic See-through run: simple shapes on a 240 x 360 frame. No real character image is used.

const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const contractPath = fileURLToPath(new URL('fixtures/c05-candidate/rig.contract.json', import.meta.url));
const contractBytes = readFileSync(contractPath);
const width = 240;
const height = 360;

const white: Color = [245, 245, 245, 255];
const skin: Color = [230, 190, 160, 255];
const blue: Color = [40, 60, 150, 255];
const cloth: Color = [60, 60, 70, 255];
const red: Color = [200, 20, 30, 255];

function rects(list: readonly [number, number, number, number][], color: Color): Raster {
  const raster = new Raster(width, height);
  for (const [x, y, w, h] of list)
    raster.fillPolygon(
      [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h }
      ],
      color
    );
  return raster;
}

/** One arm: white sleeve cap, skin from the sleeve end to the wrist, and a blue band and glove below the wrist. */
function arm(raster: Raster, shoulder: Joint, elbow: Joint, wrist: Joint): void {
  raster.line(shoulder, elbow, 10, skin);
  raster.line(elbow, wrist, 10, skin);
  raster.line(shoulder, { x: shoulder.x + (elbow.x - shoulder.x) * 0.3, y: shoulder.y + (elbow.y - shoulder.y) * 0.3 }, 14, white);
  raster.line(wrist, { x: wrist.x, y: wrist.y + 16 }, 12, blue);
}

// Image-left arm bent at (80, 120). Image-right arm straight.
const bentElbow = { x: 80, y: 120 };

function synthetic(): Map<string, Raster> {
  const handwear = new Raster(width, height);
  arm(handwear, { x: 90, y: 80 }, bentElbow, { x: 95, y: 160 });
  arm(handwear, { x: 150, y: 80 }, { x: 154, y: 120 }, { x: 158, y: 160 });
  const topwear = rects([[96, 70, 48, 80]], cloth);
  topwear.fillPolygon(
    [
      { x: 122, y: 80 },
      { x: 128, y: 80 },
      { x: 128, y: 100 },
      { x: 122, y: 100 }
    ],
    red
  );
  // Back to front.
  return new Map<string, Raster>([
    [
      'legwear',
      rects(
        [
          [100, 150, 40, 50],
          [100, 200, 12, 100],
          [128, 200, 12, 100]
        ],
        [30, 30, 40, 255]
      )
    ],
    [
      'footwear',
      rects(
        [
          [96, 290, 18, 20],
          [126, 290, 18, 20]
        ],
        [120, 80, 40, 255]
      )
    ],
    ['topwear', topwear],
    ['bottomwear', rects([[92, 140, 56, 50]], [110, 50, 50, 255])],
    ['neck', rects([[112, 58, 16, 18]], skin)],
    ['handwear', handwear],
    ['face', rects([[104, 24, 32, 36]], [240, 200, 180, 255])],
    ['mouth', rects([[120, 50, 6, 2]], [180, 60, 60, 255])],
    ['nose', rects([[124, 40, 3, 3]], [200, 150, 140, 255])],
    [
      'irides',
      rects(
        [
          [110, 34, 4, 3],
          [126, 34, 4, 3]
        ],
        [60, 120, 60, 255]
      )
    ],
    ['front hair', rects([[100, 10, 40, 16]], [200, 200, 120, 255])]
  ]);
}

const layers = synthetic();
const image = composite(width, height, [...layers.values()]);

function metadataBytes(): Buffer {
  const parts: Record<string, unknown> = {};
  [...layers.keys()].forEach((tag, index) => {
    parts[tag] = { xyxy: [0, 0, width, height], tag, part_id: index, depth_median: 0.9 - index * 0.05 };
  });
  return Buffer.from(JSON.stringify({ parts, frame_size: [width, height] }));
}

const layerFiles = (): Map<string, { name: string; bytes: Buffer }> => new Map([...layers].map(([tag, raster]) => [tag, { name: `${tag}.png`, bytes: encodePng(raster) }]));

const codeOf = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    if (error instanceof ControlError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

const byId = (list: readonly Landmark[], id: string): Landmark => {
  const found = list.find((item) => item.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
};

describe('measureLandmarks', () => {
  const measured = measureLandmarks(layers, image);

  it('gives no point to an unknown landmark and a point to every other landmark', () => {
    for (const item of measured.landmarks) {
      if (item.visibility === 'unknown') {
        expect(item.point).toBeNull();
        expect(item.confidence).toBe('none');
      } else expect(item.point).not.toBeNull();
    }
  });

  it('finds the drawn face features', () => {
    expect(byId(measured.landmarks, 'eye_image_left').point).toEqual({ x: 112, y: 35.5 });
    expect(byId(measured.landmarks, 'eye_image_right').point).toEqual({ x: 128, y: 35.5 });
    expect(byId(measured.landmarks, 'nose').visibility).toBe('visible');
    expect(byId(measured.landmarks, 'chin').point?.y).toBeCloseTo(58.5, 0);
    expect(byId(measured.landmarks, 'head_top')).toMatchObject({ visibility: 'unknown', range: { top: 10, bottom: 24 } });
  });

  it('finds the wrist at the band and the elbow of the bent arm only', () => {
    const wrist = byId(measured.landmarks, 'wrist_image_left');
    expect(wrist.visibility).toBe('occluded');
    expect(Math.abs((wrist.point?.y ?? 0) - 160)).toBeLessThan(6);
    const elbow = byId(measured.landmarks, 'elbow_image_left');
    expect(elbow.visibility).toBe('inferred');
    expect(Math.hypot((elbow.point?.x ?? 0) - bentElbow.x, (elbow.point?.y ?? 0) - bentElbow.y)).toBeLessThan(5);
    const straight = byId(measured.landmarks, 'elbow_image_right');
    expect(straight.visibility).toBe('unknown');
    expect(straight.range).not.toBeNull();
  });

  it('keeps hips and straight knees unknown and finds ankles and soles', () => {
    for (const side of ['image_left', 'image_right']) {
      expect(byId(measured.landmarks, `hip_${side}`).visibility).toBe('unknown');
      expect(byId(measured.landmarks, `knee_${side}`).visibility).toBe('unknown');
    }
    expect(byId(measured.landmarks, 'ankle_image_left').point).toEqual({ x: 106, y: 295 });
    expect(byId(measured.landmarks, 'foot_anchor_image_right').point?.y).toBeCloseTo(307, 0);
    expect(measured.regions.map((region) => region.id)).toEqual(['merged_thighs', 'skirt']);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(measureLandmarks(layers, image))).toBe(JSON.stringify(measured));
  });
});

describe('completedMask', () => {
  it('marks layer pixels that differ from the input image', () => {
    const legwear = layers.get('legwear') as Raster;
    const hidden = completedMask(legwear, image);
    // The skirt covers the merged thighs. The lower legs are drawn.
    expect(hidden[160 * width + 120]).toBe(1);
    expect(hidden[250 * width + 105]).toBe(0);
    expect(hidden[5 * width + 5]).toBe(0);
  });
});

describe('manual landmarks', () => {
  const frame = { width, height };
  const file = (landmarks: unknown[], extra: Record<string, unknown> = {}): Buffer => Buffer.from(JSON.stringify({ format: landmarkFormat, markedBy: 'test', landmarks, ...extra }));
  const entry = { id: 'nose', visibility: 'visible', confidence: 'high', x: 10, y: 10, method: 'm', note: 'n' };

  it('accepts the template and the template has no points', () => {
    const parsed = parseManualLandmarks(Buffer.from(JSON.stringify({ ...manualTemplate(), markedBy: 'test' })), frame);
    expect(parsed).toHaveLength(landmarkIds.length);
    expect(parsed.every((item) => item.point === null && item.visibility === 'unknown')).toBe(true);
  });

  it('refuses invented coordinates and invalid entries', () => {
    expect(parseManualLandmarks(file([entry]), frame)[0]).toMatchObject({ origin: 'manual', point: { x: 10, y: 10 } });
    expect(codeOf(() => parseManualLandmarks(file([{ ...entry, visibility: 'unknown', confidence: 'none' }]), frame))).toBe('E_LANDMARKS');
    expect(codeOf(() => parseManualLandmarks(file([{ ...entry, x: undefined, y: undefined }]), frame))).toBe('E_LANDMARKS');
    expect(codeOf(() => parseManualLandmarks(file([entry, entry]), frame))).toBe('E_LANDMARKS');
    expect(codeOf(() => parseManualLandmarks(file([{ ...entry, x: 999 }]), frame))).toBe('E_LANDMARKS');
    expect(codeOf(() => parseManualLandmarks(file([{ ...entry, id: 'tail' }]), frame))).toBe('E_LANDMARKS');
    expect(codeOf(() => parseManualLandmarks(file([{ ...entry, confidence: 'none' }]), frame))).toBe('E_LANDMARKS');
    expect(codeOf(() => parseManualLandmarks(file([{ ...entry, range: { left: 5, top: 5, right: 4, bottom: 9 } }]), frame))).toBe('E_LANDMARKS');
    expect(codeOf(() => parseManualLandmarks(file([entry], { format: 'other' }), frame))).toBe('E_LANDMARKS');
    expect(codeOf(() => parseManualLandmarks(file([entry], { markedBy: '' }), frame))).toBe('E_LANDMARKS');
    expect(codeOf(() => parseManualLandmarks(Buffer.from('{'), frame))).toBe('E_LANDMARKS');
  });
});

// Manual landmarks at the template joints, scaled into the frame. Optionally mirrored, with image sides swapped.
function templateLandmarks(mirror: boolean): Buffer {
  const contract = parseContractBytes(contractBytes);
  const k = height / 1536;
  const offset = (width - 1024 * k) / 2;
  const landmarks: Record<string, unknown>[] = [];
  for (const [id, ref] of correspondence('near_is_image_left')) {
    if (!ref) continue;
    const at = ref.kind === 'bone' ? contract.bones.get(ref.id)?.joint : contract.points.get(ref.id)?.position;
    if (!at) continue;
    const x = at.x * k + offset;
    const swapped = id.endsWith('image_left') ? id.replace('image_left', 'image_right') : id.replace('image_right', 'image_left');
    landmarks.push({ id: mirror ? swapped : id, visibility: 'visible', confidence: 'high', x: mirror ? width - x : x, y: at.y * k, method: 'synthetic', note: 'synthetic' });
  }
  return Buffer.from(JSON.stringify({ format: landmarkFormat, markedBy: 'test', landmarks }));
}

type Fit = { name: string; landmarkSet: string; meanErrorPctHeight: number | null; scale: { s1: number; reflection: boolean } | null };
type Correspondence = {
  templateAudit: { bone: string; overlapAtThisJoint: { parentSlot: string; radiusPx: number }[] }[];
  alignment: { hypothesis: string; fits: Fit[] }[];
  cuts: { cut: string; status: string; at: Joint | null }[];
  characterUnknown: string[];
  inputs: { manualLandmarks: string | null };
};

describe('alignStudyCommand', () => {
  const run = (manualBytes?: Buffer, imageBytes = encodePng(image)): ReturnType<typeof alignStudyCommand> =>
    alignStudyCommand({
      contractBytes,
      metadataBytes: metadataBytes(),
      metadataName: 'synthetic.psd.json',
      imageBytes,
      imageName: 'src.png',
      layerFiles: layerFiles(),
      toolVersion: '0.0.0-test',
      ...(manualBytes ? { manualBytes } : {})
    });
  const read = (result: ReturnType<typeof alignStudyCommand>, name: string): Buffer => {
    const found = result.files.find((item) => item.name === name);
    if (!found) throw new Error(`missing ${name}`);
    return found.bytes;
  };
  const fit = (report: Correspondence, hypothesis: string, name: string): Fit => {
    const found = report.alignment.find((item) => item.hypothesis === hypothesis)?.fits.find((item) => item.name === name && item.landmarkSet === 'confidence >= medium');
    if (!found) throw new Error(`missing ${hypothesis} ${name}`);
    return found;
  };

  it('writes the planned files at the frame size, deterministically', () => {
    const first = run();
    expect(first.files.map((item) => item.name).sort()).toEqual(
      [
        'a-anatomy-overlay.png',
        'b-skeleton-comparison.png',
        'c-alignment-diagnostics.png',
        'contact-sheet.png',
        'correspondence.json',
        'd-segmentation-map.png',
        'e-uncertainty-map.png',
        'landmarks-manual.template.json',
        'landmarks.json'
      ].sort()
    );
    const second = run();
    expect(second.files.map((item) => sha256(item.bytes))).toEqual(first.files.map((item) => sha256(item.bytes)));
    const overlay = read(first, 'a-anatomy-overlay.png');
    expect(overlay.readUInt32BE(16)).toBe(width);
    expect(overlay.readUInt32BE(20)).toBe(height);
    const report = JSON.parse(read(first, 'correspondence.json').toString('utf8')) as Correspondence;
    expect(report.characterUnknown).toContain('hip_image_left');
    expect(report.templateAudit.find((item) => item.bone === 'forearm_near')?.overlapAtThisJoint).toEqual([{ parentSlot: 'upper_arm_near', radiusPx: 24 }]);
    expect(report.cuts.find((item) => item.cut === 'hip_image_left')).toMatchObject({ status: 'blocked', at: null });
  });

  it('recovers an exact template pose under the right hypothesis only', () => {
    const report = JSON.parse(read(run(templateLandmarks(false)), 'correspondence.json').toString('utf8')) as Correspondence;
    const right = fit(report, 'near_is_image_left', 'similarity');
    expect(right.meanErrorPctHeight).toBeLessThan(0.01);
    expect(right.scale?.s1).toBeCloseTo(1536 / height, 2);
    expect(fit(report, 'near_is_image_right', 'similarity').meanErrorPctHeight).toBeGreaterThan(1);
    expect(report.inputs.manualLandmarks).toMatch(/^[0-9a-f]{64}$/);
  });

  it('shows a mirrored input as a reflection, not as a good similarity fit', () => {
    const report = JSON.parse(read(run(templateLandmarks(true)), 'correspondence.json').toString('utf8')) as Correspondence;
    const affine = fit(report, 'near_is_image_right', 'affine');
    expect(affine.scale?.reflection).toBe(true);
    expect(affine.meanErrorPctHeight).toBeLessThan(0.01);
    for (const hypothesis of ['near_is_image_left', 'near_is_image_right']) expect(fit(report, hypothesis, 'similarity').meanErrorPctHeight).toBeGreaterThan(1);
  });

  it('refuses a wrong image size and a contract that is not the C0.5 candidate', () => {
    expect(codeOf(() => run(undefined, encodePng(new Raster(width + 1, height))))).toBe('E_IMAGE');
    const other = JSON.parse(contractBytes.toString('utf8')) as Record<string, unknown>;
    other.view = 'front';
    expect(
      codeOf(() =>
        alignStudyCommand({
          contractBytes: Buffer.from(JSON.stringify(other)),
          metadataBytes: metadataBytes(),
          metadataName: 'm',
          imageBytes: encodePng(image),
          imageName: 'i',
          layerFiles: layerFiles(),
          toolVersion: '0'
        })
      )
    ).not.toBe('NO_ERROR');
  });
});

describe('align-study CLI', () => {
  it('writes the outputs and does not change the inputs', () => {
    const root = temporaryDirectory();
    const layerDirectory = join(root, 'layers');
    mkdirSync(layerDirectory);
    for (const [tag, file] of layerFiles()) writeFileSync(join(layerDirectory, `${tag}.png`), file.bytes);
    writeFileSync(join(root, 'meta.psd.json'), metadataBytes());
    writeFileSync(join(root, 'src.png'), encodePng(image));
    const hashes = (): string[] => [
      ...readdirSync(layerDirectory).map((name) => sha256(readFileSync(join(layerDirectory, name)))),
      sha256(readFileSync(join(root, 'meta.psd.json'))),
      sha256(readFileSync(join(root, 'src.png'))),
      sha256(readFileSync(contractPath))
    ];
    const before = hashes();
    const args = ['align-study', '--contract', contractPath, '--layers', layerDirectory, '--metadata', join(root, 'meta.psd.json'), '--image', join(root, 'src.png'), '--out', join(root, 'out')];
    const dry = spawnSync(process.execPath, [cli, ...args, '--dry-run'], { encoding: 'utf8' });
    expect(dry.status).toBe(0);
    expect(() => readdirSync(join(root, 'out'))).toThrow();
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect((JSON.parse(result.stdout) as { status: string }).status).toBe('PASS');
    expect(readdirSync(join(root, 'out'))).toContain('correspondence.json');
    expect(hashes()).toEqual(before);
    const wrong = spawnSync(process.execPath, [cli, ...args, '--seeds', '1'], { encoding: 'utf8' });
    expect(wrong.status).toBe(2);
  });
});
