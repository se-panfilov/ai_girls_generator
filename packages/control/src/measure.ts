import type { Joint, Size, Tolerances } from '@control/contract';
import { type KeypointName, keypointNames, round, toContract, type Transform } from '@control/pose';
import { ControlError, isRecord, type Problem, problem, show } from '@control/problems';

// Joint error of an image against the rig, from keypoints that a person marked on the image.
// This module does not detect keypoints. Without marks there is no measurement.

export const marksFormat = 'aigg.pose-marks/0.1';

/** How sure the person who marked a point is. `low` is for a joint that clothing or hair hides, so its position is estimated from the outline. */
export const confidenceLevels = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof confidenceLevels)[number] | 'unspecified';

export type MarkedPoint = Joint & { readonly confidence: Confidence; readonly note?: string };

/** The visible top of the head (hair included) and the ground line under the feet, in image pixels. Used only for the composition check. */
export type Extent = { readonly headTop?: Joint; readonly ground?: Joint };

export type PoseMarks = {
  readonly image: Size & { readonly sha256?: string };
  readonly markedBy: string;
  readonly origin?: string;
  readonly points: ReadonlyMap<KeypointName, MarkedPoint>;
  /** Keypoints that the person could not mark, with the reason. They are not measured and are not "missing". */
  readonly unmeasurable: ReadonlyMap<KeypointName, string>;
  readonly extent: Extent;
};

/** Body keypoints that come from contract bones. The face keypoints are assumptions and are not scored. */
export const scoredKeypoints: readonly KeypointName[] = ['neck', 'r_shoulder', 'r_elbow', 'r_wrist', 'l_shoulder', 'l_elbow', 'l_wrist', 'r_hip', 'r_knee', 'r_ankle', 'l_hip', 'l_knee', 'l_ankle'];
const faceKeypoints: readonly KeypointName[] = ['nose', 'r_eye', 'l_eye', 'r_ear', 'l_ear'];

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

const maxTextLength = 300;

function readJoint(value: unknown): Joint | null {
  if (!isRecord(value) || typeof value.x !== 'number' || typeof value.y !== 'number' || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  return { x: value.x, y: value.y };
}

function optionalText(value: unknown, field: string, problems: Problem[], at?: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxTextLength) {
    problems.push(problem('E_MARKS_FORMAT', `${field} must be text of 1 to ${maxTextLength} characters.`, at));
    return undefined;
  }
  return value;
}

function isKeypointName(name: string): name is KeypointName {
  return (keypointNames as readonly string[]).includes(name);
}

/** Validates a marks file. Throws ControlError with E_MARKS_* codes. */
export function parseMarks(value: unknown): PoseMarks {
  const problems: Problem[] = [];
  if (!isRecord(value) || value.format !== marksFormat) throw new ControlError([problem('E_MARKS_FORMAT', `The marks file must be an object with format "${marksFormat}".`)]);
  const { image, markedBy, points, unmeasurable, extent } = value;
  if (!isRecord(image) || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || (image.width as number) < 1 || (image.height as number) < 1) {
    problems.push(problem('E_MARKS_FORMAT', 'image needs positive integer width and height.'));
  }
  if (isRecord(image) && image.sha256 !== undefined && (typeof image.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(image.sha256)))
    problems.push(problem('E_MARKS_FORMAT', 'image.sha256 must be 64 lowercase hex digits.'));
  if (typeof markedBy !== 'string' || markedBy.length === 0 || markedBy.length > 200) problems.push(problem('E_MARKS_FORMAT', 'markedBy must name who marked the points (1 to 200 characters).'));
  const origin = optionalText(value.origin, 'origin', problems);
  const map = new Map<KeypointName, MarkedPoint>();
  if (!isRecord(points)) problems.push(problem('E_MARKS_FORMAT', 'points must be an object.'));
  else {
    for (const [name, point] of Object.entries(points)) {
      if (!isKeypointName(name)) {
        problems.push(problem('E_MARKS_UNKNOWN_POINT', `${show(name)} is not an OpenPose BODY_18 keypoint name.`, name));
        continue;
      }
      const joint = readJoint(point);
      if (!joint || !isRecord(point)) {
        problems.push(problem('E_MARKS_FORMAT', 'A point needs finite x and y.', name));
        continue;
      }
      let confidence: Confidence = 'unspecified';
      if (point.confidence !== undefined) {
        if (typeof point.confidence === 'string' && (confidenceLevels as readonly string[]).includes(point.confidence)) confidence = point.confidence as Confidence;
        else problems.push(problem('E_MARKS_FORMAT', `confidence must be one of ${confidenceLevels.join(', ')}.`, name));
      }
      const note = optionalText(point.note, 'note', problems, name);
      map.set(name, note === undefined ? { ...joint, confidence } : { ...joint, confidence, note });
    }
  }
  const skipped = new Map<KeypointName, string>();
  if (unmeasurable !== undefined) {
    if (!isRecord(unmeasurable)) problems.push(problem('E_MARKS_FORMAT', 'unmeasurable must be an object of keypoint names and reasons.'));
    else {
      for (const [name, reason] of Object.entries(unmeasurable)) {
        if (!isKeypointName(name)) {
          problems.push(problem('E_MARKS_UNKNOWN_POINT', `${show(name)} is not an OpenPose BODY_18 keypoint name.`, name));
          continue;
        }
        if (map.has(name)) problems.push(problem('E_MARKS_CONFLICT', 'A keypoint cannot be both marked and unmeasurable.', name));
        const text = optionalText(reason, 'The unmeasurable reason', problems, name);
        if (text !== undefined) skipped.set(name, text);
      }
    }
  }
  let parsedExtent: Extent = {};
  if (extent !== undefined) {
    if (!isRecord(extent)) problems.push(problem('E_MARKS_FORMAT', 'extent must be an object with headTop and ground points.'));
    else {
      const headTop = extent.headTop === undefined ? undefined : readJoint(extent.headTop);
      const ground = extent.ground === undefined ? undefined : readJoint(extent.ground);
      if (headTop === null || ground === null) problems.push(problem('E_MARKS_FORMAT', 'extent.headTop and extent.ground need finite x and y.'));
      if (headTop && ground && !(ground.y > headTop.y)) problems.push(problem('E_MARKS_FORMAT', 'extent.ground must be below extent.headTop.'));
      parsedExtent = { ...(headTop ? { headTop } : {}), ...(ground ? { ground } : {}) };
    }
  }
  if (problems.length > 0) throw new ControlError(problems);
  const img = image as Record<string, unknown>;
  const size = { width: img.width as number, height: img.height as number };
  return {
    image: typeof img.sha256 === 'string' ? { ...size, sha256: img.sha256 } : size,
    markedBy: markedBy as string,
    ...(origin === undefined ? {} : { origin }),
    points: map,
    unmeasurable: skipped,
    extent: parsedExtent
  };
}

export type JointResult = {
  readonly name: KeypointName;
  readonly confidence: Confidence;
  readonly expected: Joint;
  readonly marked: Joint;
  readonly errorPx: number;
  readonly errorPctHeight: number;
  readonly pass: boolean;
};
export type SegmentResult = { readonly from: KeypointName; readonly to: KeypointName; readonly ratio: number; readonly ratioScaleFree: number | null; readonly pass: boolean };
export type ErrorSummary = { readonly count: number; readonly meanErrorPctHeight: number | null; readonly maxErrorPctHeight: number | null; readonly overMax: readonly KeypointName[] };

/**
 * Diagnostic only: the uniform scale and the translation that move the marked joints nearest to the rig joints (least squares, no rotation).
 * It shows how much of the error is scale and position of the whole figure, and how much is pose. It never changes the result status.
 */
export type Alignment = {
  readonly note: string;
  /** Size of the figure in the image divided by the size of the rig figure. */
  readonly figureScale: number;
  /** Shift of the figure center from the rig center, in image pixels and in % of body height. */
  readonly offsetPx: Joint;
  readonly offsetPctHeight: Joint;
  readonly residuals: readonly { readonly name: KeypointName; readonly confidence: Confidence; readonly errorPctHeight: number; readonly pass: boolean }[];
  readonly all: ErrorSummary;
  readonly confident: ErrorSummary;
};

export type Composition = {
  readonly note: string;
  readonly markedBodyHeightPx: number | null;
  readonly rigBodyHeightPx: number;
  readonly bodyHeightRatio: number | null;
  readonly headTopOffsetPctHeight: Joint | null;
  readonly groundOffsetPctHeight: Joint | null;
};

export type FaceResult = { readonly name: KeypointName; readonly confidence: Confidence; readonly errorPctHeight: number };

export type Measurement = {
  readonly status: 'PASS' | 'FAIL' | 'INCOMPLETE';
  readonly method: string;
  readonly origin: string | null;
  readonly bodyHeightPx: number;
  readonly joints: readonly JointResult[];
  readonly segments: readonly SegmentResult[];
  readonly missing: readonly KeypointName[];
  readonly unmeasurable: readonly { readonly name: KeypointName; readonly reason: string }[];
  readonly meanErrorPctHeight: number | null;
  readonly maxErrorPctHeight: number | null;
  /** The same numbers for the joints marked with high or medium confidence only. */
  readonly confident: ErrorSummary;
  readonly face: readonly FaceResult[];
  readonly alignment: Alignment | null;
  readonly composition: Composition | null;
};

const isConfident = (confidence: Confidence): boolean => confidence === 'high' || confidence === 'medium' || confidence === 'unspecified';

function summary(items: readonly { readonly name: KeypointName; readonly errorPctHeight: number; readonly pass: boolean }[]): ErrorSummary {
  const errors = items.map((item) => item.errorPctHeight);
  return {
    count: items.length,
    meanErrorPctHeight: errors.length > 0 ? round(errors.reduce((sum, value) => sum + value, 0) / errors.length) : null,
    maxErrorPctHeight: errors.length > 0 ? round(Math.max(...errors)) : null,
    overMax: items.filter((item) => !item.pass).map((item) => item.name)
  };
}

/** Least-squares uniform scale s and translation t so that s * marked + t is nearest to expected. Needs two or more distinct points. */
export function fitScaleTranslation(marked: readonly Joint[], expected: readonly Joint[]): { readonly s: number; readonly t: Joint } | null {
  if (marked.length < 2 || marked.length !== expected.length) return null;
  const mean = (list: readonly Joint[]): Joint => ({ x: list.reduce((sum, p) => sum + p.x, 0) / list.length, y: list.reduce((sum, p) => sum + p.y, 0) / list.length });
  const mm = mean(marked);
  const me = mean(expected);
  let numerator = 0;
  let denominator = 0;
  for (const [index, m] of marked.entries()) {
    const e = expected[index] as Joint;
    numerator += (m.x - mm.x) * (e.x - me.x) + (m.y - mm.y) * (e.y - me.y);
    denominator += (m.x - mm.x) ** 2 + (m.y - mm.y) ** 2;
  }
  if (!(denominator > 0) || !(numerator > 0)) return null;
  const s = numerator / denominator;
  return { s, t: { x: me.x - s * mm.x, y: me.y - s * mm.y } };
}

export type RigReference = { readonly headTop: Joint; readonly ground: Joint };

/** Compares marked keypoints with the rig keypoints. All distances are in contract pixels. */
export function measure(expected: ReadonlyMap<KeypointName, Joint>, marks: PoseMarks, transform: Transform, bodyHeight: number, tolerances: Tolerances, reference?: RigReference): Measurement {
  const joints: JointResult[] = [];
  const missing: KeypointName[] = [];
  const markedInContract = new Map<KeypointName, Joint>();
  const pct = (px: number): number => (px / bodyHeight) * 100;
  for (const name of scoredKeypoints) {
    const target = expected.get(name);
    const mark = marks.points.get(name);
    if (!target || !mark) {
      if (!marks.unmeasurable.has(name)) missing.push(name);
      continue;
    }
    const marked = toContract(mark, transform);
    markedInContract.set(name, marked);
    const errorPx = Math.hypot(marked.x - target.x, marked.y - target.y);
    joints.push({
      name,
      confidence: mark.confidence,
      expected: target,
      marked: { x: round(marked.x), y: round(marked.y) },
      errorPx: round(errorPx),
      errorPctHeight: round(pct(errorPx)),
      pass: pct(errorPx) <= tolerances.jointErrorMaxPctHeight
    });
  }

  let alignment: Alignment | null = null;
  const fitNames = joints.map((item) => item.name);
  const fit = fitScaleTranslation(
    fitNames.map((name) => markedInContract.get(name) as Joint),
    fitNames.map((name) => expected.get(name) as Joint)
  );
  if (fit && joints.length >= 3) {
    const residuals = joints.map((item) => {
      const m = markedInContract.get(item.name) as Joint;
      const error = pct(Math.hypot(fit.s * m.x + fit.t.x - item.expected.x, fit.s * m.y + fit.t.y - item.expected.y));
      return { name: item.name, confidence: item.confidence, errorPctHeight: round(error), pass: error <= tolerances.jointErrorMaxPctHeight };
    });
    // The rig centroid maps to (centroid - t) / s in marked space: the shift of the figure center, in contract pixels.
    const ce = {
      x: fitNames.reduce((sum, name) => sum + (expected.get(name) as Joint).x, 0) / fitNames.length,
      y: fitNames.reduce((sum, name) => sum + (expected.get(name) as Joint).y, 0) / fitNames.length
    };
    const shift = { x: (ce.x - fit.t.x) / fit.s - ce.x, y: (ce.y - fit.t.y) / fit.s - ce.y };
    alignment = {
      note: 'Diagnostic only. Uniform scale and translation fitted to the marked joints (least squares, no rotation). The result status does not use it.',
      figureScale: round(1 / fit.s),
      offsetPx: { x: round(shift.x * transform.scale), y: round(shift.y * transform.scale) },
      offsetPctHeight: { x: round(pct(shift.x)), y: round(pct(shift.y)) },
      residuals,
      all: summary(residuals),
      confident: summary(residuals.filter((item) => isConfident(item.confidence)))
    };
  }

  const results: SegmentResult[] = [];
  for (const [from, to] of segments) {
    const a = expected.get(from);
    const b = expected.get(to);
    const ma = markedInContract.get(from);
    const mb = markedInContract.get(to);
    if (!a || !b || !ma || !mb) continue;
    const length = Math.hypot(a.x - b.x, a.y - b.y);
    if (length === 0) continue;
    const ratio = Math.hypot(ma.x - mb.x, ma.y - mb.y) / length;
    results.push({
      from,
      to,
      ratio: round(ratio),
      ratioScaleFree: alignment ? round(ratio / alignment.figureScale) : null,
      pass: ratio >= tolerances.segmentLengthRatio[0] && ratio <= tolerances.segmentLengthRatio[1]
    });
  }

  const face: FaceResult[] = [];
  for (const name of faceKeypoints) {
    const target = expected.get(name);
    const mark = marks.points.get(name);
    if (!target || !mark) continue;
    const marked = toContract(mark, transform);
    face.push({ name, confidence: mark.confidence, errorPctHeight: round(pct(Math.hypot(marked.x - target.x, marked.y - target.y))) });
  }

  let composition: Composition | null = null;
  if (reference && (marks.extent.headTop || marks.extent.ground)) {
    const top = marks.extent.headTop ? toContract(marks.extent.headTop, transform) : null;
    const ground = marks.extent.ground ? toContract(marks.extent.ground, transform) : null;
    const offset = (point: Joint | null, rig: Joint): Joint | null => (point ? { x: round(pct(point.x - rig.x)), y: round(pct(point.y - rig.y)) } : null);
    const height = top && ground ? ground.y - top.y : null;
    composition = {
      note: 'From the marked head top (hair included) and ground line. Positive y offset is lower in the image.',
      markedBodyHeightPx: height === null ? null : round(height * transform.scale),
      rigBodyHeightPx: round(bodyHeight * transform.scale),
      bodyHeightRatio: height === null ? null : round(height / bodyHeight),
      headTopOffsetPctHeight: offset(top, reference.headTop),
      groundOffsetPctHeight: offset(ground, reference.ground)
    };
  }

  const all = summary(joints);
  const failed = joints.some((item) => !item.pass) || results.some((item) => !item.pass) || (all.meanErrorPctHeight !== null && all.meanErrorPctHeight > tolerances.jointErrorMeanPctHeight);
  const scoredUnmeasurable = [...marks.unmeasurable.keys()].some((name) => scoredKeypoints.includes(name));
  const status = failed ? 'FAIL' : missing.length > 0 || scoredUnmeasurable ? 'INCOMPLETE' : 'PASS';
  return {
    status,
    method: `manual marks by ${marks.markedBy}; error = distance / body height in contract pixels`,
    origin: marks.origin ?? null,
    bodyHeightPx: bodyHeight,
    joints,
    segments: results,
    missing,
    unmeasurable: [...marks.unmeasurable].filter(([name]) => scoredKeypoints.includes(name) || faceKeypoints.includes(name)).map(([name, reason]) => ({ name, reason })),
    meanErrorPctHeight: all.meanErrorPctHeight,
    maxErrorPctHeight: all.maxErrorPctHeight,
    confident: summary(joints.filter((item) => isConfident(item.confidence))),
    face,
    alignment,
    composition
  };
}
