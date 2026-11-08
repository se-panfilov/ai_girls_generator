import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { overlayCommand, parseContractBytes, poseCommand, workflowCommand } from '@control/commands';
import { parseControlContract } from '@control/contract';
import { fitScaleTranslation, marksFormat, parseMarks } from '@control/measure';
import { checkOutputDirectory, readInput, writeFiles } from '@control/output';
import { decodePng, encodePng, pixelHash } from '@control/png';
import { fitTransform, keypointColors, keypointNames, renderOpenPose, rigPose, toTarget } from '@control/pose';
import { ControlError } from '@control/problems';
import { Raster } from '@control/raster';
import { describe, expect, it } from 'vitest';

import { bytesOf, l1ContractBytes, syntheticContract, temporaryDirectory } from './helpers';

const codeOf = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    if (error instanceof ControlError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

describe('PNG', () => {
  it('round-trips RGBA pixels', () => {
    const raster = new Raster(7, 5, [10, 20, 30, 255]);
    raster.blend(3, 2, [200, 100, 50, 128]);
    const decoded = decodePng(encodePng(raster));
    expect(decoded.raster.data).toEqual(raster.data);
    expect(decoded.colorType).toBe('rgba');
    expect(pixelHash(decoded.raster)).toBe(pixelHash(raster));
  });

  it('rejects data that is not a PNG image', () => {
    expect(codeOf(() => decodePng(Buffer.from('not a png')))).toBe('E_PNG_FORMAT');
  });

  it('rejects an image above the size limit before it inflates the pixels', () => {
    const png = encodePng(new Raster(4, 4));
    expect(codeOf(() => decodePng(png, { maxBytes: 1 << 20, maxWidth: 3, maxHeight: 3, maxPixels: 9 }))).toBe('E_PNG_TOO_LARGE');
    expect(codeOf(() => decodePng(png, { maxBytes: 10, maxWidth: 100, maxHeight: 100, maxPixels: 10000 }))).toBe('E_PNG_TOO_LARGE');
  });

  it('rejects a corrupt chunk and pixel data larger than the header size', () => {
    const png = Buffer.from(encodePng(new Raster(2, 2)));
    const broken = Buffer.from(png);
    broken[20] = (broken[20] ?? 0) ^ 0xff;
    expect(codeOf(() => decodePng(broken))).toBe('E_PNG_FORMAT');
    // Replace the pixel data with more bytes than a 2x2 image has. The CRC is correct, so only the size check stops it.
    const header = png.subarray(0, 33);
    const data = deflateSync(Buffer.alloc(1000));
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write('IDAT', 4, 'ascii');
    data.copy(chunk, 8);
    const crcInput = chunk.subarray(4, 8 + data.length);
    chunk.writeUInt32BE(crc(crcInput), 8 + data.length);
    const end = png.subarray(png.length - 12);
    expect(codeOf(() => decodePng(Buffer.concat([header, chunk, end])))).toBe('E_PNG_FORMAT');
  });
});

function crc(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let k = 0; k < 8; k += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

describe('contract', () => {
  it('parses the L1 test rig contract', () => {
    const contract = parseContractBytes(l1ContractBytes());
    expect(contract.rigId).toBe('humanoid_girl_v1');
    expect(contract.bones.get('upper_arm_near')?.joint).toEqual({ x: 580, y: 600 });
  });

  it('reports malformed fields', () => {
    const value = syntheticContract();
    value.bones = [{ id: 'root', parent: 'missing', joint: { x: 0, y: 0 } }];
    expect(codeOf(() => parseControlContract(value))).toBe('E_CONTRACT_PARENT');
    expect(codeOf(() => parseControlContract({ ...syntheticContract(), space: { yAxis: 'up' } }))).toBe('E_CONTRACT_FORMAT');
  });

  it('rejects a view that the face keypoints do not support', () => {
    const contract = parseControlContract({ ...syntheticContract(), view: 'front' });
    expect(codeOf(() => rigPose(contract, 'detector'))).toBe('E_VIEW_UNSUPPORTED');
  });
});

describe('rig pose', () => {
  it('maps the L1 layout and reports the side layout mismatch', () => {
    const contract = parseContractBytes(l1ContractBytes());
    const detector = rigPose(contract, 'detector');
    expect(detector.keypoints.find((item) => item.name === 'r_shoulder')?.source).toBe('bone:upper_arm_far');
    expect(detector.warnings.map((item) => item.code)).toEqual(['W_RIG_SIDE_LAYOUT_VIEW_MISMATCH']);
    const anatomical = rigPose(contract, 'anatomical');
    expect(anatomical.keypoints.find((item) => item.name === 'r_shoulder')?.source).toBe('bone:upper_arm_near');
    expect(anatomical.warnings.map((item) => item.code)).toEqual(['W_RIG_SIDE_LAYOUT_VIEW_MISMATCH', 'W_POSE_BACK_VIEW_SIGNAL']);
    expect(detector.bodyHeight).toBe(1240);
  });

  it('gives no warning and the same keypoints in both mappings when the near side is on the left', () => {
    const contract = parseControlContract(syntheticContract(true));
    const detector = rigPose(contract, 'detector');
    const anatomical = rigPose(contract, 'anatomical');
    expect(detector.warnings).toEqual([]);
    expect(anatomical.keypoints).toEqual(detector.keypoints);
  });

  it('draws each visible keypoint in its OpenPose color at its target position', () => {
    const contract = parseControlContract(syntheticContract(true));
    const size = { width: 320, height: 480 };
    const transform = fitTransform(contract.canvas, size);
    const pose = rigPose(contract, 'detector');
    const raster = renderOpenPose(pose.keypoints, size, transform);
    for (const [index, item] of pose.keypoints.entries()) {
      if (!item.point) continue;
      const point = toTarget(item.point, transform);
      const [r, g, b] = raster.pixel(Math.trunc(point.x), Math.trunc(point.y));
      expect([r, g, b], keypointNames[index]).toEqual(keypointColors[index]);
    }
    expect(raster.pixel(0, 0)).toEqual([0, 0, 0, 255]);
  });
});

describe('pose command', () => {
  it('is deterministic and keeps the canvas proportions', () => {
    const first = poseCommand(l1ContractBytes(), '832x1216', ['detector', 'anatomical']);
    const second = poseCommand(l1ContractBytes(), '832x1216', ['detector', 'anatomical']);
    expect(first.files.map((file) => file.bytes)).toEqual(second.files.map((file) => file.bytes));
    const target = first.report.target as { transform: { scale: number; offsetX: number; offsetY: number } };
    expect(target.transform).toEqual({ scale: 0.792, offsetX: 10.667, offsetY: 0 });
    expect(first.files.map((file) => file.name).sort()).toEqual(
      ['control.json', 'openpose-anatomical.json', 'openpose-anatomical.png', 'openpose-detector.json', 'openpose-detector.png', 'reference.png', 'reference.svg'].sort()
    );
  });

  it('rejects an invalid size', () => {
    expect(codeOf(() => poseCommand(l1ContractBytes(), '832x', ['detector']))).toBe('E_USAGE');
    expect(codeOf(() => poseCommand(l1ContractBytes(), '9000x9000', ['detector']))).toBe('E_USAGE');
  });
});

describe('workflow command', () => {
  const pose = (): Buffer => poseCommand(bytesOf(syntheticContract()), '320x480', ['detector']).files.find((file) => file.name === 'openpose-detector.png')?.bytes ?? Buffer.alloc(0);
  const base = { checkpoint: 'animagine-xl-4.0.safetensors', controlNet: 'diffusion_pytorch_model_promax.safetensors', poseImageName: 'openpose-detector.png' };

  it('writes one baseline and up to three pose runs with the control node chain', () => {
    const result = workflowCommand({ ...base, seeds: [1001, 1002, 1003], poseImageBytes: pose() });
    expect(result.files.map((file) => file.name)).toEqual(['c0-baseline-1001.api.json', 'c0-pose-1001.api.json', 'c0-pose-1002.api.json', 'c0-pose-1003.api.json', 'run-plan.json']);
    const graph = JSON.parse(result.files[1]?.bytes.toString('utf8') ?? '{}') as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(graph['10']?.inputs.type).toBe('openpose');
    expect(graph['5']?.inputs.positive).toEqual(['11', 0]);
    expect(graph['4']?.inputs).toMatchObject({ width: 320, height: 480 });
    const plan = JSON.parse(result.files[4]?.bytes.toString('utf8') ?? '{}') as { runStatus: string; prompt: { positive: string; negative: string } };
    expect(plan.runStatus).toBe('NOT RUN');
    expect(plan.prompt.positive).toContain('adult woman');
    expect(plan.prompt.negative).toContain('nsfw');
  });

  it('limits the run count and rejects model paths', () => {
    expect(codeOf(() => workflowCommand({ ...base, seeds: [1, 2, 3, 4], poseImageBytes: pose() }))).toBe('E_USAGE');
    expect(codeOf(() => workflowCommand({ ...base, checkpoint: '../x.safetensors', seeds: [1], poseImageBytes: pose() }))).toBe('E_WORKFLOW_MODEL_NAME');
    expect(codeOf(() => workflowCommand({ ...base, checkpoint: 'x.ckpt', seeds: [1], poseImageBytes: pose() }))).toBe('E_WORKFLOW_MODEL_NAME');
  });
});

describe('overlay command', () => {
  const contractBytes = bytesOf(syntheticContract());
  const contract = parseControlContract(syntheticContract());
  const size = { width: 320, height: 480 };
  const transform = fitTransform(contract.canvas, size);
  const image = encodePng(new Raster(size.width, size.height, [250, 240, 230, 255]));
  const marks = (shift: number, omit: string[] = []): Buffer => {
    const points: Record<string, { x: number; y: number }> = {};
    for (const item of rigPose(contract, 'detector').keypoints) {
      if (!item.point || omit.includes(item.name)) continue;
      const point = toTarget(item.point, transform);
      points[item.name] = { x: point.x + shift, y: point.y };
    }
    return bytesOf({ format: marksFormat, image: size, markedBy: 'synthetic test', points });
  };

  it('writes the overlay and the sheet, and does not measure without marks', () => {
    const result = overlayCommand({ contractBytes, mapping: 'detector', imageBytes: image });
    expect(result.report.status).toBe('PASS');
    expect((result.report.measurement as { status: string }).status).toBe('NOT MEASURED');
    const sheet = decodePng(result.files.find((file) => file.name === 'side-by-side.png')?.bytes ?? Buffer.alloc(0)).raster;
    expect([sheet.width, sheet.height]).toEqual([320 * 4 + 48, 480]);
  });

  it('measures manual marks against the rig', () => {
    const exact = overlayCommand({ contractBytes, mapping: 'detector', imageBytes: image, marksBytes: marks(0) });
    expect(exact.report.status).toBe('PASS');
    const shifted = overlayCommand({ contractBytes, mapping: 'detector', imageBytes: image, marksBytes: marks(30) });
    expect(shifted.report.status).toBe('FAIL');
    const partial = overlayCommand({ contractBytes, mapping: 'detector', imageBytes: image, marksBytes: marks(0, ['l_ankle']) });
    expect(partial.report.status).toBe('INCOMPLETE');
  });

  it('reports confidence, unmeasurable joints, the diagnostic alignment, and the composition', () => {
    const points: Record<string, { x: number; y: number; confidence?: string }> = {};
    const center = { x: size.width / 2, y: size.height / 2 };
    for (const item of rigPose(contract, 'detector').keypoints) {
      if (!item.point || item.name === 'l_ankle') continue;
      const point = toTarget(item.point, transform);
      // The whole figure 10 % larger around the image center and moved 12 px down: a pure scale and translation.
      points[item.name] = { x: center.x + (point.x - center.x) * 1.1, y: center.y + (point.y - center.y) * 1.1 + 12, confidence: item.name.includes('elbow') ? 'low' : 'high' };
    }
    const bytes = bytesOf({
      format: marksFormat,
      image: size,
      markedBy: 'synthetic test',
      origin: 'synthetic',
      points,
      unmeasurable: { l_ankle: 'hidden by a boot' },
      extent: { headTop: { x: 160, y: 20 }, ground: { x: 160, y: 470 } }
    });
    const result = overlayCommand({ contractBytes, mapping: 'detector', imageBytes: image, marksBytes: bytes });
    const measurement = result.report.measurement as {
      status: string;
      missing: string[];
      unmeasurable: { name: string }[];
      joints: { name: string; confidence: string }[];
      confident: { count: number };
      alignment: { figureScale: number; all: { maxErrorPctHeight: number }; offsetPx: { x: number; y: number } };
      segments: { ratio: number; ratioScaleFree: number }[];
      composition: { bodyHeightRatio: number };
    };
    expect(measurement.status).toBe('FAIL');
    expect(measurement.missing).toEqual([]);
    expect(measurement.unmeasurable.map((item) => item.name)).toEqual(['l_ankle']);
    expect(measurement.joints.find((item) => item.name === 'r_elbow')?.confidence).toBe('low');
    expect(measurement.confident.count).toBe(measurement.joints.length - 2);
    expect(measurement.alignment.figureScale).toBeCloseTo(1.1, 3);
    expect(measurement.alignment.all.maxErrorPctHeight).toBeLessThan(0.01);
    for (const segment of measurement.segments) expect(segment.ratioScaleFree).toBeCloseTo(1, 2);
    expect(measurement.composition.bodyHeightRatio).toBeGreaterThan(0);
    expect(result.files.map((file) => file.name)).toContain('aligned-diagnostic.png');
  });

  it('validates the optional marks fields', () => {
    const base = { format: marksFormat, image: size, markedBy: 'x' };
    expect(codeOf(() => parseMarks({ ...base, points: { neck: { x: 1, y: 1, confidence: 'sure' } } }))).toBe('E_MARKS_FORMAT');
    expect(codeOf(() => parseMarks({ ...base, points: { neck: { x: 1, y: 1 } }, unmeasurable: { neck: 'hidden' } }))).toBe('E_MARKS_CONFLICT');
    expect(codeOf(() => parseMarks({ ...base, points: {}, unmeasurable: { tail: 'x' } }))).toBe('E_MARKS_UNKNOWN_POINT');
    expect(codeOf(() => parseMarks({ ...base, points: {}, extent: { headTop: { x: 1, y: 50 }, ground: { x: 1, y: 10 } } }))).toBe('E_MARKS_FORMAT');
    const parsed = parseMarks({ ...base, points: { neck: { x: 1, y: 2 } } });
    expect(parsed.points.get('neck')?.confidence).toBe('unspecified');
  });

  it('fits scale and translation only from distinct points', () => {
    expect(fitScaleTranslation([{ x: 1, y: 1 }], [{ x: 2, y: 2 }])).toBeNull();
    expect(
      fitScaleTranslation(
        [
          { x: 1, y: 1 },
          { x: 1, y: 1 }
        ],
        [
          { x: 2, y: 2 },
          { x: 3, y: 3 }
        ]
      )
    ).toBeNull();
    const fit = fitScaleTranslation(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 10 }
      ],
      [
        { x: 5, y: 5 },
        { x: 25, y: 5 },
        { x: 5, y: 25 }
      ]
    );
    expect(fit?.s).toBeCloseTo(2, 9);
    expect(fit?.t.x).toBeCloseTo(5, 9);
  });

  it('rejects marks for another image', () => {
    const wrong = bytesOf({ format: marksFormat, image: { width: 10, height: 10 }, markedBy: 'x', points: {} });
    expect(codeOf(() => overlayCommand({ contractBytes, mapping: 'detector', imageBytes: image, marksBytes: wrong }))).toBe('E_MARKS_IMAGE');
    const unknown = bytesOf({ format: marksFormat, image: size, markedBy: 'x', points: { tail: { x: 1, y: 1 } } });
    expect(codeOf(() => overlayCommand({ contractBytes, mapping: 'detector', imageBytes: image, marksBytes: unknown }))).toBe('E_MARKS_UNKNOWN_POINT');
  });
});

describe('output directory', () => {
  it('creates a new directory and refuses a non-empty one without force', () => {
    const root = temporaryDirectory();
    const out = join(root, 'out');
    expect(checkOutputDirectory(out, false)).toBe(true);
    writeFiles(out, [{ name: 'a.json', bytes: Buffer.from('{}') }], true);
    expect(readdirSync(out)).toEqual(['a.json']);
    expect(codeOf(() => checkOutputDirectory(out, false))).toBe('E_OUTPUT_EXISTS');
    expect(checkOutputDirectory(out, true)).toBe(false);
  });

  it('refuses a symbolic link and does not follow a link inside the directory', () => {
    const root = temporaryDirectory();
    const real = join(root, 'real');
    mkdirSync(real);
    symlinkSync(real, join(root, 'link'));
    expect(codeOf(() => checkOutputDirectory(join(root, 'link'), true))).toBe('E_OUTPUT');
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'keep');
    symlinkSync(victim, join(real, 'a.json'));
    writeFiles(real, [{ name: 'a.json', bytes: Buffer.from('new') }], false);
    expect(readFileSync(victim, 'utf8')).toBe('keep');
    expect(codeOf(() => writeFiles(real, [{ name: '../x.json', bytes: Buffer.from('') }], false))).toBe('E_OUTPUT');
  });
});

describe('input files', () => {
  it('reads a file and refuses a missing file, a directory, and a file above the limit', () => {
    const root = temporaryDirectory();
    const file = join(root, 'a.json');
    writeFileSync(file, '0123456789');
    expect(readInput(file, 10, 'A').toString('utf8')).toBe('0123456789');
    expect(codeOf(() => readInput(file, 9, 'A'))).toBe('E_INPUT_TOO_LARGE');
    expect(codeOf(() => readInput(join(root, 'missing.json'), 10, 'A'))).toBe('E_INPUT');
    expect(codeOf(() => readInput(root, 10, 'A'))).toBe('E_INPUT');
  });
});
