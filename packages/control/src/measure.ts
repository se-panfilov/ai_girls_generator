import type { Joint, Size, Tolerances } from '@control/contract';
import { type KeypointName, keypointNames, round, toContract, type Transform } from '@control/pose';
import { ControlError, isRecord, type Problem, problem, show } from '@control/problems';

// Joint error of an image against the rig, from keypoints that a person marked on the image.
// This module does not detect keypoints. Without marks there is no measurement.

export const marksFormat = 'aigg.pose-marks/0.1';

export type PoseMarks = {
  readonly image: Size & { readonly sha256?: string };
  readonly markedBy: string;
  readonly points: ReadonlyMap<KeypointName, Joint>;
};

/** Body keypoints that come from contract bones. The face keypoints are assumptions and are not scored. */
export const scoredKeypoints: readonly KeypointName[] = ['neck', 'r_shoulder', 'r_elbow', 'r_wrist', 'l_shoulder', 'l_elbow', 'l_wrist', 'r_hip', 'r_knee', 'r_ankle', 'l_hip', 'l_knee', 'l_ankle'];

const segments: readonly (readonly [KeypointName, KeypointName])[] = [
  ['r_shoulder', 'r_elbow'],
  ['r_elbow', 'r_wrist'],
  ['l_shoulder', 'l_elbow'],
  ['l_elbow', 'l_wrist'],
  ['r_hip', 'r_knee'],
  ['r_knee', 'r_ankle'],
  ['l_hip', 'l_knee'],
  ['l_knee', 'l_ankle']
];

/** Validates a marks file. Throws ControlError with E_MARKS_* codes. */
export function parseMarks(value: unknown): PoseMarks {
  const problems: Problem[] = [];
  if (!isRecord(value) || value.format !== marksFormat) throw new ControlError([problem('E_MARKS_FORMAT', `The marks file must be an object with format "${marksFormat}".`)]);
  const { image, markedBy, points } = value;
  if (!isRecord(image) || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || (image.width as number) < 1 || (image.height as number) < 1) {
    problems.push(problem('E_MARKS_FORMAT', 'image needs positive integer width and height.'));
  }
  if (isRecord(image) && image.sha256 !== undefined && (typeof image.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(image.sha256)))
    problems.push(problem('E_MARKS_FORMAT', 'image.sha256 must be 64 lowercase hex digits.'));
  if (typeof markedBy !== 'string' || markedBy.length === 0 || markedBy.length > 200) problems.push(problem('E_MARKS_FORMAT', 'markedBy must name who marked the points (1 to 200 characters).'));
  const map = new Map<KeypointName, Joint>();
  if (!isRecord(points)) problems.push(problem('E_MARKS_FORMAT', 'points must be an object.'));
  else {
    for (const [name, point] of Object.entries(points)) {
      if (!(keypointNames as readonly string[]).includes(name)) {
        problems.push(problem('E_MARKS_UNKNOWN_POINT', `${show(name)} is not an OpenPose BODY_18 keypoint name.`, name));
        continue;
      }
      if (!isRecord(point) || typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        problems.push(problem('E_MARKS_FORMAT', 'A point needs finite x and y.', name));
        continue;
      }
      map.set(name as KeypointName, { x: point.x, y: point.y });
    }
  }
  if (problems.length > 0) throw new ControlError(problems);
  const img = image as Record<string, unknown>;
  const size = { width: img.width as number, height: img.height as number };
  return { image: typeof img.sha256 === 'string' ? { ...size, sha256: img.sha256 } : size, markedBy: markedBy as string, points: map };
}

export type JointResult = { readonly name: KeypointName; readonly expected: Joint; readonly marked: Joint; readonly errorPx: number; readonly errorPctHeight: number; readonly pass: boolean };
export type SegmentResult = { readonly from: KeypointName; readonly to: KeypointName; readonly ratio: number; readonly pass: boolean };
export type Measurement = {
  readonly status: 'PASS' | 'FAIL' | 'INCOMPLETE';
  readonly method: string;
  readonly bodyHeightPx: number;
  readonly joints: readonly JointResult[];
  readonly segments: readonly SegmentResult[];
  readonly missing: readonly KeypointName[];
  readonly meanErrorPctHeight: number | null;
  readonly maxErrorPctHeight: number | null;
};

/** Compares marked keypoints with the rig keypoints. All distances are in contract pixels. */
export function measure(expected: ReadonlyMap<KeypointName, Joint>, marks: PoseMarks, transform: Transform, bodyHeight: number, tolerances: Tolerances): Measurement {
  const joints: JointResult[] = [];
  const missing: KeypointName[] = [];
  const markedInContract = new Map<KeypointName, Joint>();
  for (const name of scoredKeypoints) {
    const target = expected.get(name);
    const mark = marks.points.get(name);
    if (!target || !mark) {
      missing.push(name);
      continue;
    }
    const marked = toContract(mark, transform);
    markedInContract.set(name, marked);
    const errorPx = Math.hypot(marked.x - target.x, marked.y - target.y);
    const pct = (errorPx / bodyHeight) * 100;
    joints.push({ name, expected: target, marked: { x: round(marked.x), y: round(marked.y) }, errorPx: round(errorPx), errorPctHeight: round(pct), pass: pct <= tolerances.jointErrorMaxPctHeight });
  }
  const results: SegmentResult[] = [];
  for (const [from, to] of segments) {
    const a = expected.get(from);
    const b = expected.get(to);
    const ma = markedInContract.get(from);
    const mb = markedInContract.get(to);
    if (!a || !b || !ma || !mb) continue;
    const reference = Math.hypot(a.x - b.x, a.y - b.y);
    if (reference === 0) continue;
    const ratio = Math.hypot(ma.x - mb.x, ma.y - mb.y) / reference;
    results.push({ from, to, ratio: round(ratio), pass: ratio >= tolerances.segmentLengthRatio[0] && ratio <= tolerances.segmentLengthRatio[1] });
  }
  const errors = joints.map((item) => item.errorPctHeight);
  const mean = errors.length > 0 ? errors.reduce((sum, value) => sum + value, 0) / errors.length : null;
  const max = errors.length > 0 ? Math.max(...errors) : null;
  const failed = joints.some((item) => !item.pass) || results.some((item) => !item.pass) || (mean !== null && mean > tolerances.jointErrorMeanPctHeight);
  const status = failed ? 'FAIL' : missing.length > 0 ? 'INCOMPLETE' : 'PASS';
  return {
    status,
    method: `manual marks by ${marks.markedBy}; error = distance / body height in contract pixels`,
    bodyHeightPx: bodyHeight,
    joints,
    segments: results,
    missing,
    meanErrorPctHeight: mean === null ? null : round(mean),
    maxErrorPctHeight: max === null ? null : round(max)
  };
}
