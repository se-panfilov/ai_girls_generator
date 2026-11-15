import { type Affine, applyAffine } from '@control/align';
import { completedMask, type Landmark, maxLandmarkBytes, overlapsOf, parseManualLandmarks } from '@control/alignstudy';
import { type CommandResult, type FileRecord, json, parseContractBytes, record, sheetOf } from '@control/commands';
import type { ControlContract, Joint } from '@control/contract';
import { drawText } from '@control/glyphs';
import { checker, composite, drawOrder, layerPngLimits, parseSeeThroughMetadata } from '@control/layersplit';
import type { PlannedFile } from '@control/output';
import { decodePng, encodePng, pixelHash, sha256 } from '@control/png';
import { fail, isRecord, show } from '@control/problems';
import { type Color, Raster } from '@control/raster';
import { checkConservation, type Conservation, extractLabel, labelComponents, splitLayer } from '@control/split';

// `limb-study` (experiment L0-1e, prototype): cuts the image-left (near) arm of the handwear layer into upper arm, forearm, and hand
// at the manual shoulder, elbow, and wrist marks, measures the joint overlap, and rotates the parts for diagnostics.
// It copies source pixels only. It does not paint, fill, extend, or generate pixels. A rotation resamples by nearest neighbor:
// each output pixel is a copy of one source pixel. The parts are not Spine attachments and the angles are not animation limits.

export const limbFormat = 'aigg.l0-1e.limb-study/0.1';
export const maxStudyBytes = 4 * 1024 * 1024;

/** Half width of the boundary band at a cut, in image px. Pixels in the band are in one part, but they are flagged. */
export const boundaryBand = 1.5;
/** A cut edge pixel is a visible seam when the largest RGB difference across the cut is above this value. */
export const seamThreshold = 48;
/** Local joint window for the gap test, as a multiple of the overlap radius. */
export const windowFactor = 2;

export type RotationTest = { readonly id: string; readonly elbow: number; readonly wrist: number };
/** Diagnostic angles in degrees. Positive is clockwise on the screen (image y down). */
export const rotationTests: readonly RotationTest[] = [
  { id: 'source', elbow: 0, wrist: 0 },
  { id: 'elbow-15', elbow: -15, wrist: 0 },
  { id: 'elbow+15', elbow: 15, wrist: 0 },
  { id: 'elbow-30', elbow: -30, wrist: 0 },
  { id: 'elbow+30', elbow: 30, wrist: 0 },
  { id: 'wrist-15', elbow: 0, wrist: -15 },
  { id: 'wrist+15', elbow: 0, wrist: 15 },
  { id: 'elbow+10_wrist+10', elbow: 10, wrist: 10 },
  { id: 'elbow-10_wrist-10', elbow: -10, wrist: -10 },
  { id: 'elbow+10_wrist-10', elbow: 10, wrist: -10 }
];

export type LimbStudyOptions = {
  readonly contractBytes: Buffer;
  readonly metadataBytes: Buffer;
  readonly metadataName: string;
  readonly layerFiles: ReadonlyMap<string, { readonly name: string; readonly bytes: Buffer }>;
  readonly imageBytes: Buffer;
  readonly landmarkBytes: Buffer;
  readonly studyBytes: Buffer;
  readonly toolVersion: string;
};

export type Vector = { x: number; y: number };
export const sub = (a: Joint, b: Joint): Vector => ({ x: a.x - b.x, y: a.y - b.y });
export const dot = (a: Vector, b: Vector): number => a.x * b.x + a.y * b.y;
export const unit = (v: Vector): Vector => {
  const length = Math.hypot(v.x, v.y);
  return length === 0 ? { x: 0, y: 0 } : { x: v.x / length, y: v.y / length };
};
export const round = (value: number, digits = 1): number => Math.round(value * 10 ** digits) / 10 ** digits;
const share = (part: number, whole: number): number => (whole === 0 ? 0 : round(part / whole, 4));
export const center = (p: number, width: number): Joint => {
  const x = p % width;
  return { x: x + 0.5, y: (p - x) / width + 0.5 };
};
const directionDegrees = (v: Vector): number => round((Math.atan2(v.y, v.x) * 180) / Math.PI, 1);

/** Rotation about a center. Positive degrees turn clockwise on the screen (image y down). */
export function rotationAbout(c: Joint, degrees: number): Affine {
  const angle = (degrees * Math.PI) / 180;
  const cos = degrees === 0 ? 1 : Math.cos(angle);
  const sin = degrees === 0 ? 0 : Math.sin(angle);
  return { a: cos, b: -sin, c: sin, d: cos, tx: c.x - cos * c.x + sin * c.y, ty: c.y - sin * c.x - cos * c.y };
}

/** m1 after m2. */
export const compose = (m1: Affine, m2: Affine): Affine => ({
  a: m1.a * m2.a + m1.b * m2.c,
  b: m1.a * m2.b + m1.b * m2.d,
  c: m1.c * m2.a + m1.d * m2.c,
  d: m1.c * m2.b + m1.d * m2.d,
  tx: m1.a * m2.tx + m1.b * m2.ty + m1.tx,
  ty: m1.c * m2.tx + m1.d * m2.ty + m1.ty
});

function invert(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, tx: -(a * m.tx + b * m.ty), ty: -(c * m.tx + d * m.ty) };
}

const isIdentity = (m: Affine): boolean => m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.tx === 0 && m.ty === 0;

/**
 * Moves a part by a forward transform with nearest-neighbor inverse mapping. Each output pixel is an exact copy of one source pixel.
 * The identity transform gives a byte-equal copy.
 */
export function transformPart(source: Raster, forward: Affine): Raster {
  const out = new Raster(source.width, source.height);
  if (isIdentity(forward)) {
    out.data.set(source.data);
    return out;
  }
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let p = 0; p < source.width * source.height; p += 1) {
    if ((source.data[p * 4 + 3] ?? 0) === 0) continue;
    const x = p % source.width;
    const y = (p - x) / source.width;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + 1);
    bottom = Math.max(bottom, y + 1);
  }
  if (left === Infinity) return out;
  const corners = [
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom }
  ].map((corner) => applyAffine(forward, corner));
  const inverse = invert(forward);
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.x))) - 1);
  const x1 = Math.min(source.width - 1, Math.ceil(Math.max(...corners.map((c) => c.x))) + 1);
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.y))) - 1);
  const y1 = Math.min(source.height - 1, Math.ceil(Math.max(...corners.map((c) => c.y))) + 1);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const p = applyAffine(inverse, { x: x + 0.5, y: y + 0.5 });
      const sx = Math.floor(p.x);
      const sy = Math.floor(p.y);
      if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
      const i = (sy * source.width + sx) * 4;
      if ((source.data[i + 3] ?? 0) === 0) continue;
      out.data.set(source.data.subarray(i, i + 4), (y * source.width + x) * 4);
    }
  }
  return out;
}

export const opaque = (raster: Raster, threshold = 128): Uint8Array => {
  const mask = new Uint8Array(raster.width * raster.height);
  for (let p = 0; p < mask.length; p += 1) if ((raster.data[p * 4 + 3] ?? 0) >= threshold) mask[p] = 1;
  return mask;
};
export const count = (mask: Uint8Array): number => mask.reduce((sum, value) => sum + value, 0);

// Labels of the near arm assignment.
export const upperLabel = 1;
export const foreLabel = 2;
export const handLabel = 3;
export const residualLabel = 4;
export const partNames = ['upper_arm', 'forearm', 'hand'] as const;

export type Cut = { readonly joint: Joint; readonly normal: Vector };
export type ArmCut = {
  readonly assignment: Uint8Array;
  readonly elbow: Cut;
  readonly wrist: Cut;
  readonly handDirection: Vector;
  readonly conflictPixels: number;
  readonly fragmentPixels: number;
  readonly cutIslandPixels: number;
  readonly boundary: Uint8Array;
};

/**
 * Cuts an arm mask (alpha > 0) into upper arm, forearm, and hand with two lines. Each line goes through a joint mark.
 * Its normal is the mean of the limb directions on the two sides (the joint bisector), so the cut follows the limb axes, not the image rows.
 * Residual (no pixel is dropped): fragments outside the main component of the whole arm, pixels on the hand side of the wrist line and
 * the upper arm side of the elbow line (crossed lines), and pixels that the cut separates from the main component of their part.
 */
export function cutArm(arm: Raster, shoulder: Joint, elbow: Joint, wrist: Joint): ArmCut {
  const { width, height } = arm;
  const size = width * height;
  const upperDirection = unit(sub(elbow, shoulder));
  const foreDirection = unit(sub(wrist, elbow));
  const elbowNormal = unit({ x: upperDirection.x + foreDirection.x, y: upperDirection.y + foreDirection.y });
  // Fragments: arm pixels outside the main connected component of the whole arm (before any cut). They are residual.
  const armMask = Uint8Array.from({ length: size }, (_, p) => ((arm.data[p * 4 + 3] ?? 0) > 0 ? 1 : 0));
  const whole = labelComponents(armMask, width, height);
  const mainArm = [...whole.components].sort((a, b) => b.area - a.area || a.id - b.id)[0];
  const inMain = (p: number): boolean => whole.labels[p] === mainArm?.id;
  // Hand direction: from the wrist mark to the centroid of the arm pixels past a provisional wrist line (normal = forearm direction).
  let hx = 0;
  let hy = 0;
  let hn = 0;
  for (let p = 0; p < size; p += 1) {
    if ((arm.data[p * 4 + 3] ?? 0) === 0 || !inMain(p)) continue;
    const c = center(p, width);
    if (dot(sub(c, wrist), foreDirection) > 0 && dot(sub(c, elbow), elbowNormal) > 0) {
      hx += c.x;
      hy += c.y;
      hn += 1;
    }
  }
  if (hn === 0) fail('E_GEOMETRY', 'No arm pixels are past the wrist mark.');
  const handDirection = unit(sub({ x: hx / hn, y: hy / hn }, wrist));
  const wristNormal = unit({ x: foreDirection.x + handDirection.x, y: foreDirection.y + handDirection.y });
  const assignment = new Uint8Array(size);
  const boundary = new Uint8Array(size);
  let conflictPixels = 0;
  let fragmentPixels = 0;
  for (let p = 0; p < size; p += 1) {
    if ((arm.data[p * 4 + 3] ?? 0) === 0) continue;
    if (!inMain(p)) {
      assignment[p] = residualLabel;
      fragmentPixels += 1;
      continue;
    }
    const c = center(p, width);
    const de = dot(sub(c, elbow), elbowNormal);
    const dw = dot(sub(c, wrist), wristNormal);
    if (de < 0 && dw >= 0) {
      assignment[p] = residualLabel;
      conflictPixels += 1;
    } else assignment[p] = de < 0 ? upperLabel : dw < 0 ? foreLabel : handLabel;
    if ((Math.abs(de) <= boundaryBand && assignment[p] !== handLabel) || (Math.abs(dw) <= boundaryBand && assignment[p] !== upperLabel)) boundary[p] = 1;
  }
  let cutIslandPixels = 0;
  for (const label of [upperLabel, foreLabel, handLabel]) {
    const mask = Uint8Array.from(assignment, (value) => (value === label ? 1 : 0));
    const { labels, components } = labelComponents(mask, width, height);
    const main = [...components].sort((a, b) => b.area - a.area || a.id - b.id)[0];
    for (let p = 0; p < size; p += 1) {
      if (mask[p] === 1 && labels[p] !== main?.id) {
        assignment[p] = residualLabel;
        boundary[p] = 0;
        cutIslandPixels += 1;
      }
    }
  }
  return { assignment, elbow: { joint: elbow, normal: elbowNormal }, wrist: { joint: wrist, normal: wristNormal }, handDirection, conflictPixels, fragmentPixels, cutIslandPixels, boundary };
}

/** The cut line inside the arm: walks from the joint mark along the line in both directions while the pixels are arm pixels. */
export type Section = { from: Joint; to: Joint; widthPx: number; markOffsetPx: number; markInside: boolean; extentNegativePx: number; extentPositivePx: number };

function crossSection(mask: Uint8Array, width: number, height: number, cut: Cut): Section {
  const along = { x: -cut.normal.y, y: cut.normal.x };
  const inside = (t: number): boolean => {
    const x = Math.floor(cut.joint.x + along.x * t);
    const y = Math.floor(cut.joint.y + along.y * t);
    return x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  };
  const markInside = inside(0);
  let start = 0;
  if (!markInside) {
    // The mark is outside the arm: use the nearest arm pixel on the line.
    for (let t = 0.5; t < 200; t += 0.5) {
      if (inside(t)) {
        start = t;
        break;
      }
      if (inside(-t)) {
        start = -t;
        break;
      }
    }
  }
  let low = start;
  while (inside(low - 0.5)) low -= 0.5;
  let high = start;
  while (inside(high + 0.5)) high += 0.5;
  const at = (t: number): Joint => ({ x: round(cut.joint.x + along.x * t, 2), y: round(cut.joint.y + along.y * t, 2) });
  return {
    from: at(low),
    to: at(high),
    widthPx: round(high - low + 0.5),
    markOffsetPx: round(Math.abs((low + high) / 2)),
    markInside,
    extentNegativePx: round(Math.max(0, -low) + 0.5),
    extentPositivePx: round(Math.max(0, high) + 0.5)
  };
}

export type JointSpec = { readonly id: 'elbow' | 'wrist'; readonly parent: number; readonly child: number; readonly cut: Cut; readonly radius: number; readonly radiusTemplate: number };

/** Overlap of the parent part around the child pivot in the source pose (task C). Pixels are counted at alpha >= 128. */
function overlapAt(spec: JointSpec, assignment: Uint8Array, arm: Raster, completed: Uint8Array): { report: Record<string, unknown>; missing: Uint8Array; disk: Uint8Array } {
  const { width } = arm;
  const silhouette = opaque(arm);
  const disk = new Uint8Array(silhouette.length);
  const missing = new Uint8Array(silhouette.length);
  let diskArea = 0;
  let diskInArm = 0;
  let parentInDisk = 0;
  let childInDisk = 0;
  let completedInDisk = 0;
  let parentDepth = 0;
  let childDepth = 0;
  for (let p = 0; p < disk.length; p += 1) {
    const c = center(p, width);
    if (Math.hypot(c.x - spec.cut.joint.x, c.y - spec.cut.joint.y) > spec.radius) continue;
    disk[p] = 1;
    diskArea += 1;
    if (silhouette[p] !== 1) continue;
    diskInArm += 1;
    if (completed[p] === 1) completedInDisk += 1;
    const d = dot(sub(c, spec.cut.joint), spec.cut.normal);
    if (assignment[p] === spec.parent) {
      parentInDisk += 1;
      parentDepth = Math.max(parentDepth, -d);
    } else {
      if (assignment[p] === spec.child) {
        childInDisk += 1;
        childDepth = Math.max(childDepth, d);
      }
      missing[p] = 1;
    }
  }
  return {
    report: {
      joint: spec.id,
      parent: partNames[spec.parent - 1],
      child: partNames[spec.child - 1],
      pivot: { x: round(spec.cut.joint.x, 2), y: round(spec.cut.joint.y, 2) },
      radiusTemplatePx: spec.radiusTemplate,
      radiusImagePx: round(spec.radius, 2),
      diskPixels: diskArea,
      diskPixelsInsideArm: diskInArm,
      parentPixelsInDisk: parentInDisk,
      childPixelsInDisk: childInDisk,
      seeThroughCompletedPixelsInDisk: completedInDisk,
      coverageOfDiskByParent: share(parentInDisk, diskArea),
      coverageOfArmPartOfDiskByParent: share(parentInDisk, diskInArm),
      missingParentPixelsInsideArm: diskInArm - parentInDisk,
      missingParentPixelsWholeDisk: diskArea - parentInDisk,
      parentSourceMarginPastCutPx: 0,
      parentDepthBeforeCutPx: round(parentDepth),
      childDepthAfterCutPx: round(childDepth),
      note: 'The cut is an exact partition: the parent has no source pixel past the cut line. Every pixel that the parent must have under the child (missing) is a pixel that does not exist in the source.'
    },
    missing,
    disk
  };
}

export type Placed = { readonly parts: readonly Raster[]; readonly transforms: readonly Affine[] };

function placeParts(parts: readonly Raster[], elbow: Joint, wrist: Joint, test: RotationTest): Placed {
  const identity: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  const fore = rotationAbout(elbow, test.elbow);
  const hand = compose(fore, rotationAbout(wrist, test.wrist));
  const transforms = [identity, fore, hand];
  return { parts: parts.map((part, index) => transformPart(part, transforms[index] as Affine)), transforms };
}

function over(target: Raster, layer: Raster): void {
  for (let p = 0; p < target.width * target.height; p += 1) {
    const a = layer.data[p * 4 + 3] ?? 0;
    if (a === 0) continue;
    const x = p % target.width;
    target.blend(x, (p - x) / target.width, [layer.data[p * 4] ?? 0, layer.data[p * 4 + 1] ?? 0, layer.data[p * 4 + 2] ?? 0, a]);
  }
}

export type GapResult = { gap: Uint8Array; gapPixels: number; protrusion: Uint8Array; protrusionPixels: number };

/**
 * Opened gap and protrusion at one joint. The wedge is the set of points on the child side of the moved parent cut line and on the parent
 * side of the moved child cut line, not farther from the pivot than the source cross-section on that side. In the source pose the wedge
 * is empty. gap: wedge pixels that no arm pixel covers (alpha > 0). protrusion: moved child pixels on the parent side of the moved parent
 * cut line (more than 1 px, the nearest-neighbor tolerance), within the joint window, where the parent has no pixel: the cut corner of
 * the child shows outside the parent outline.
 */
function jointGap(
  cutLine: Cut,
  section: Section,
  parentTransform: Affine,
  childTransform: Affine,
  parentAny: Uint8Array,
  childAny: Uint8Array,
  coverAny: Uint8Array,
  width: number,
  window: number
): GapResult {
  const height = coverAny.length / width;
  const toParent = invert(parentTransform);
  const toChild = invert(childTransform);
  const pivot = applyAffine(parentTransform, cutLine.joint);
  const along = { x: -cutLine.normal.y, y: cutLine.normal.x };
  const gap = new Uint8Array(coverAny.length);
  const protrusion = new Uint8Array(coverAny.length);
  let gapPixels = 0;
  let protrusionPixels = 0;
  const reach = Math.max(window, section.extentNegativePx, section.extentPositivePx) + 2;
  for (let y = Math.max(0, Math.floor(pivot.y - reach)); y <= Math.min(height - 1, Math.ceil(pivot.y + reach)); y += 1) {
    for (let x = Math.max(0, Math.floor(pivot.x - reach)); x <= Math.min(width - 1, Math.ceil(pivot.x + reach)); x += 1) {
      const p = y * width + x;
      const q = { x: x + 0.5, y: y + 0.5 };
      const inParent = sub(applyAffine(toParent, q), cutLine.joint);
      const dParent = dot(inParent, cutLine.normal);
      const dChild = dot(sub(applyAffine(toChild, q), cutLine.joint), cutLine.normal);
      const radial = Math.hypot(inParent.x, inParent.y);
      const limit = dot(inParent, along) < 0 ? section.extentNegativePx : section.extentPositivePx;
      if (dParent >= 0 && dChild < 0 && radial <= limit && coverAny[p] !== 1) {
        gap[p] = 1;
        gapPixels += 1;
      }
      if (dParent < -1 && childAny[p] === 1 && parentAny[p] !== 1 && radial <= window) {
        protrusion[p] = 1;
        protrusionPixels += 1;
      }
    }
  }
  return { gap, gapPixels, protrusion, protrusionPixels };
}

export type SeamResult = { edgePixels: number; exposedEdgePixels: number; visibleSeamPixels: number; meanDifference: number; seam: Uint8Array };

/**
 * Seam test at a cut: for each child pixel next to its cut line (0 <= d < boundaryBand), the moved pixel is compared with the final image
 * 2 px across the moved cut line. exposed: no arm part covers that point. visible: the largest RGB difference is above seamThreshold.
 */
function seamAt(childSource: Raster, cut: Cut, transform: Affine, finalImage: Raster, cover: Uint8Array): SeamResult {
  const { width, height } = childSource;
  const seam = new Uint8Array(width * height);
  const normal = { x: transform.a * cut.normal.x + transform.b * cut.normal.y, y: transform.c * cut.normal.x + transform.d * cut.normal.y };
  let edgePixels = 0;
  let exposedEdgePixels = 0;
  let visibleSeamPixels = 0;
  let total = 0;
  for (let p = 0; p < width * height; p += 1) {
    if ((childSource.data[p * 4 + 3] ?? 0) < 128) continue;
    const c = center(p, width);
    const d = dot(sub(c, cut.joint), cut.normal);
    if (d < 0 || d >= boundaryBand) continue;
    const q = applyAffine(transform, c);
    const across = { x: q.x - 2 * normal.x, y: q.y - 2 * normal.y };
    const qx = Math.floor(q.x);
    const qy = Math.floor(q.y);
    const ax = Math.floor(across.x);
    const ay = Math.floor(across.y);
    if (ax < 0 || ay < 0 || ax >= width || ay >= height || qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
    edgePixels += 1;
    const [r, g, b] = childSource.pixel(p % width, Math.floor(p / width));
    const [r2, g2, b2] = finalImage.pixel(ax, ay);
    const difference = Math.max(Math.abs(r - r2), Math.abs(g - g2), Math.abs(b - b2));
    total += difference;
    const exposed = cover[ay * width + ax] !== 1;
    if (exposed) exposedEdgePixels += 1;
    if (difference > seamThreshold) visibleSeamPixels += 1;
    if (exposed || difference > seamThreshold) seam[qy * width + qx] = 1;
  }
  return { edgePixels, exposedEdgePixels, visibleSeamPixels, meanDifference: edgePixels === 0 ? 0 : round(total / edgePixels), seam };
}

// Colors of the diagnostic images.
const partColors: readonly Color[] = [
  [40, 110, 230, 255],
  [230, 120, 20, 255],
  [30, 160, 70, 255]
];
const residualColor: Color = [220, 0, 0, 255];
const boundaryColor: Color = [0, 0, 0, 255];
const completedColor: Color = [250, 220, 0, 255];
const gapColor: Color = [230, 0, 0, 255];
const baselineColor: Color = [150, 150, 150, 255];
const expectedOverlapColor: Color = [0, 120, 255, 255];
const unwantedOverlapColor: Color = [200, 0, 200, 255];
const seamColor: Color = [255, 170, 0, 255];
const missingColor: Color = [230, 0, 0, 255];
const white: Color = [255, 255, 255, 255];
const black: Color = [0, 0, 0, 255];

export type Box = { left: number; top: number; right: number; bottom: number };

export function crop(source: Raster, box: Box): Raster {
  const out = new Raster(box.right - box.left, box.bottom - box.top);
  for (let y = box.top; y < box.bottom; y += 1) {
    const from = (y * source.width + box.left) * 4;
    out.data.set(source.data.subarray(from, from + out.width * 4), (y - box.top) * out.width * 4);
  }
  return out;
}

export function scaled(source: Raster, factor: number): Raster {
  const out = new Raster(source.width * factor, source.height * factor);
  for (let y = 0; y < out.height; y += 1) {
    for (let x = 0; x < out.width; x += 1) {
      const i = (Math.floor(y / factor) * source.width + Math.floor(x / factor)) * 4;
      out.data.set(source.data.subarray(i, i + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}

export function onWhite(source: Raster, opacity = 1): Raster {
  const out = new Raster(source.width, source.height, white);
  out.draw(source, 0, 0, opacity);
  return out;
}

export function ring(target: Raster, at: Joint, radius: number, color: Color, lineWidth = 1.5): void {
  for (let y = Math.max(0, Math.floor(at.y - radius - 2)); y <= Math.min(target.height - 1, Math.ceil(at.y + radius + 2)); y += 1) {
    for (let x = Math.max(0, Math.floor(at.x - radius - 2)); x <= Math.min(target.width - 1, Math.ceil(at.x + radius + 2)); x += 1) {
      if (Math.abs(Math.hypot(x + 0.5 - at.x, y + 0.5 - at.y) - radius) <= lineWidth / 2) target.blend(x, y, color);
    }
  }
}

export function cross(target: Raster, at: Joint, color: Color, size = 6): void {
  target.line({ x: at.x - size, y: at.y }, { x: at.x + size, y: at.y }, 2, color);
  target.line({ x: at.x, y: at.y - size }, { x: at.x, y: at.y + size }, 2, color);
}

export function titled(content: Raster, title: string, lines: readonly string[] = []): Raster {
  const out = new Raster(content.width, content.height + 22 + lines.length * 12, white);
  out.draw(content, 0, 22 + lines.length * 12);
  drawText(out, title, 4, 4, 2, black);
  lines.forEach((line, index) => {
    drawText(out, line, 4, 22 + index * 12, 1, black);
  });
  return out;
}

/** Moves a box in the frame and keeps it inside. */
export function boxAround(points: readonly Joint[], pad: number, width: number, height: number): Box {
  const left = Math.max(0, Math.floor(Math.min(...points.map((p) => p.x)) - pad));
  const top = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y)) - pad));
  const right = Math.min(width, Math.ceil(Math.max(...points.map((p) => p.x)) + pad));
  const bottom = Math.min(height, Math.ceil(Math.max(...points.map((p) => p.y)) + pad));
  return { left, top, right, bottom };
}

export function maskPoints(mask: Uint8Array, width: number): Joint[] {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let p = 0; p < mask.length; p += 1) {
    if (mask[p] !== 1) continue;
    const x = p % width;
    const y = (p - x) / width;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + 1);
    bottom = Math.max(bottom, y + 1);
  }
  return left === Infinity
    ? []
    : [
        { x: left, y: top },
        { x: right, y: bottom }
      ];
}

function landmarkOf(list: readonly Landmark[], id: string): Landmark & { point: Joint } {
  const item = list.find((entry) => entry.id === id);
  if (!item?.point) fail('E_LANDMARK', `The manual landmark file has no point for ${id}. The study needs the shoulder, elbow, and wrist of the image-left arm.`);
  return item as Landmark & { point: Joint };
}

/** Reads the align-study correspondence.json of the run with the same manual file: the similarity scale (image px to template px). */
function studyScale(bytes: Buffer, landmarkSha: string, imageSha: string): number {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('E_INPUT', 'The study file is not valid JSON.');
  }
  if (!isRecord(value) || !isRecord(value.inputs) || !Array.isArray(value.alignment)) fail('E_INPUT', 'The study file is not an align-study correspondence.json.');
  if (value.inputs.manualLandmarks !== landmarkSha) fail('E_INPUT', 'The study was not made with this manual landmark file (SHA-256 differs).');
  if (!isRecord(value.inputs.image) || value.inputs.image.sha256 !== imageSha) fail('E_INPUT', 'The study was not made with this image (SHA-256 differs).');
  const run: unknown = value.alignment.find((item: unknown) => isRecord(item) && item.hypothesis === 'near_is_image_left');
  if (!isRecord(run) || !Array.isArray(run.fits)) fail('E_INPUT', 'The study has no near_is_image_left alignment.');
  const fit: unknown = run.fits.find((item: unknown) => isRecord(item) && item.name === 'similarity' && item.landmarkSet === 'confidence >= medium');
  if (!isRecord(fit) || !isRecord(fit.scale) || typeof fit.scale.s1 !== 'number' || !Number.isFinite(fit.scale.s1) || fit.scale.s1 < 0.2 || fit.scale.s1 > 5)
    fail('E_INPUT', 'The study has no valid similarity scale.');
  return fit.scale.s1;
}

export type PartReport = { part: string | undefined; pixels: number; opaquePixels: number; boundaryPixels: number; seeThroughCompletedPixels: number; pixelSha256: string };
export type OverlapResult = { report: Record<string, unknown>; missing: Uint8Array; disk: Uint8Array };

export type LimbContext = {
  readonly contract: ControlContract;
  readonly scale: number;
  readonly landmarkSha: string;
  readonly imageSha: string;
  readonly marks: readonly (Landmark & { point: Joint })[];
  readonly shoulder: Joint;
  readonly elbow: Joint;
  readonly wrist: Joint;
  readonly order: readonly string[];
  readonly layers: ReadonlyMap<string, Raster>;
  readonly inputs: readonly Record<string, unknown>[];
  readonly handwear: Raster;
  readonly width: number;
  readonly height: number;
  readonly image: Raster;
  readonly arm: Raster;
  readonly otherHandwear: Raster;
  readonly armMask: Uint8Array;
  readonly completed: Uint8Array;
  readonly cut: ArmCut;
  readonly parts: readonly Raster[];
  readonly residual: Raster;
  readonly armConservation: Conservation;
  readonly layerConservation: Conservation;
  readonly silhouette: Uint8Array;
  readonly partReports: readonly PartReport[];
  readonly sections: readonly Section[];
  readonly specs: readonly JointSpec[];
  readonly overlap: readonly OverlapResult[];
  readonly elbowRadiusTemplate: number;
  readonly below: Raster;
  readonly above: Raster;
  readonly reference: Raster;
};

export type JointResult = {
  spec: JointSpec;
  pivot: Joint;
  gap: GapResult;
  expectedOverlap: number;
  unwantedOverlap: number;
  overlapMask: Uint8Array;
  seam: SeamResult;
};
export type RenderedTest = { test: RotationTest; frame: Raster; cover: Uint8Array; joints: JointResult[]; revealed: number; revealedEmpty: number; placed: Placed };
export type JointMetrics = {
  joint: string;
  pivot: Joint;
  gapPixels: number;
  protrusionPixels: number;
  expectedOverlapPixels: number;
  unwantedOverlapPixels: number;
  cutEdgePixels: number;
  exposedCutEdgePixels: number;
  visibleSeamPixels: number;
  meanDifferenceAcrossCut: number;
};
export type TestMetrics = {
  id: string;
  elbowDegrees: number;
  wristDegrees: number;
  joints: JointMetrics[];
  revealedArmPixels: number;
  revealedTransparentPixels: number;
  problemPixels: number;
};
export type JointSummary = {
  joint: string;
  sourcePoseGapPixels: number;
  sourcePoseVisibleSeamPixels: number;
  sourcePoseMeanDifferenceAcrossCut: number;
  worstGapPixels: number;
  worstProtrusionPixels: number;
  worstUnwantedOverlapPixels: number;
  worstVisibleSeamPixels: number;
  gapUnionPixels: number;
  missingParentPixelsInsideArm: number;
};
export type Evaluation = {
  rendered: RenderedTest[];
  tests: TestMetrics[];
  jointSummary: JointSummary[];
  gapUnion: Uint8Array[];
  heatGap: Uint16Array;
  heatOverlap: Uint16Array;
  coverUnion: Uint8Array;
  sourceFrame: Raster;
  recomposedDifferent: number;
  maxToFullComposite: number;
};

/** Tasks A to C of `limb-study`: inputs, the three-part cut, and the overlap of the source parts. Shared with `underlay-study`. */
export function prepareLimb(options: LimbStudyOptions): LimbContext {
  // A. Inputs and provenance.
  const contract = parseContractBytes(options.contractBytes);
  if (!contract.rigId.endsWith('_c05_candidate') || contract.view !== 'three_quarter_right' || contract.sideNaming !== 'near_far')
    fail('E_CONTRACT_UNSUPPORTED', 'The study needs the C0.5 candidate contract (three_quarter_right, near_far).');
  const overlaps = overlapsOf(options.contractBytes);
  const radiusOf = (slot: string, child: string): number => {
    const item = overlaps.find((entry) => entry.slot === slot && entry.childBone === child);
    if (!item) fail('E_CONTRACT', `The contract has no overlap for ${slot} -> ${child}.`);
    return item.radiusPx;
  };
  const elbowRadiusTemplate = radiusOf('upper_arm_near', 'forearm_near');
  const wristRadiusTemplate = radiusOf('forearm_near', 'hand_near');
  const metadata = parseSeeThroughMetadata(options.metadataBytes);
  const { width, height } = metadata.frame;
  const image = decodePng(options.imageBytes, layerPngLimits).raster;
  if (image.width !== width || image.height !== height) fail('E_IMAGE', `The image is ${image.width}x${image.height}. The See-through frame is ${width}x${height}.`);
  if (options.landmarkBytes.length > maxLandmarkBytes) fail('E_INPUT', 'The manual landmark file is too large.');
  const landmarkSha = sha256(options.landmarkBytes);
  const imageSha = sha256(options.imageBytes);
  const scale = studyScale(options.studyBytes, landmarkSha, imageSha);
  const manual = parseManualLandmarks(options.landmarkBytes, metadata.frame);
  const marks = (['shoulder_image_left', 'elbow_image_left', 'wrist_image_left'] as const).map((id) => landmarkOf(manual, id));
  const [shoulder, elbow, wrist] = marks.map((item) => item.point) as [Joint, Joint, Joint];
  const order = drawOrder(metadata);
  const layers = new Map<string, Raster>();
  const inputs: Record<string, unknown>[] = [];
  for (const tag of order) {
    const file = options.layerFiles.get(tag);
    if (!file) continue;
    const raster = decodePng(file.bytes, layerPngLimits).raster;
    if (raster.width !== width || raster.height !== height) fail('E_LAYER', `The layer ${show(tag)} does not have the frame size.`);
    layers.set(tag, raster);
    inputs.push({ tag, name: file.name, sha256: sha256(file.bytes), pixelSha256: pixelHash(raster) });
  }
  const handwear = layers.get('handwear');
  if (!handwear) fail('E_LAYER', 'The layer "handwear" is required.');

  // B. Arm split (L0-1b method) and the three-part cut.
  const arms = splitLayer(handwear);
  if (arms.status !== 'split' || arms.parts.length !== 2) fail('E_LAYER', 'handwear does not split into two arms.');
  const armRasters = [1, 2].map((label) => extractLabel(handwear, arms.assignment, label));
  const centroidX = armRasters.map((raster) => {
    let sum = 0;
    let n = 0;
    for (let p = 0; p < width * height; p += 1)
      if ((raster.data[p * 4 + 3] ?? 0) > 0) {
        sum += p % width;
        n += 1;
      }
    return n === 0 ? Infinity : sum / n;
  });
  const nearIndex = (centroidX[0] as number) <= (centroidX[1] as number) ? 0 : 1;
  const arm = armRasters[nearIndex] as Raster;
  const otherHandwear = new Raster(width, height);
  for (let p = 0; p < width * height; p += 1) if (arms.assignment[p] !== nearIndex + 1) otherHandwear.data.set(handwear.data.subarray(p * 4, p * 4 + 4), p * 4);
  const armMask = Uint8Array.from({ length: width * height }, (_, p) => ((arm.data[p * 4 + 3] ?? 0) > 0 ? 1 : 0));
  const completed = completedMask(arm, image).map((value, p) => (value === 1 && armMask[p] === 1 ? 1 : 0));
  const cut = cutArm(arm, shoulder, elbow, wrist);
  const parts = [upperLabel, foreLabel, handLabel].map((label) => extractLabel(arm, cut.assignment, label));
  const residual = extractLabel(arm, cut.assignment, residualLabel);
  const armConservation = checkConservation(arm, [...parts, residual]);
  const layerConservation = checkConservation(handwear, [...parts, residual, otherHandwear]);
  const silhouette = opaque(arm);
  const partReports = parts.map((part, index) => {
    const mask = Uint8Array.from({ length: width * height }, (_, p) => ((part.data[p * 4 + 3] ?? 0) > 0 ? 1 : 0));
    const area = count(mask);
    return {
      part: partNames[index],
      pixels: area,
      opaquePixels: count(opaque(part)),
      boundaryPixels: count(mask.map((value, p) => (value === 1 && cut.boundary[p] === 1 ? 1 : 0))),
      seeThroughCompletedPixels: count(mask.map((value, p) => (value === 1 && completed[p] === 1 ? 1 : 0))),
      pixelSha256: pixelHash(part)
    };
  });
  const sections = [cut.elbow, cut.wrist].map((item) => crossSection(armMask, width, height, item));

  // C. Joint overlap.
  const specs: JointSpec[] = [
    { id: 'elbow', parent: upperLabel, child: foreLabel, cut: cut.elbow, radius: elbowRadiusTemplate / scale, radiusTemplate: elbowRadiusTemplate },
    { id: 'wrist', parent: foreLabel, child: handLabel, cut: cut.wrist, radius: wristRadiusTemplate / scale, radiusTemplate: wristRadiusTemplate }
  ];
  const overlap = specs.map((spec) => overlapAt(spec, cut.assignment, arm, completed));

  // D. Rotation tests on the body. Layers below handwear, the handwear layer (other pixels, residual, parts), and layers above it.
  const handIndex = order.indexOf('handwear');
  const below = composite(
    width,
    height,
    order
      .slice(0, handIndex)
      .map((tag) => layers.get(tag))
      .filter((item): item is Raster => item !== undefined)
  );
  const above = composite(
    width,
    height,
    order
      .slice(handIndex + 1)
      .map((tag) => layers.get(tag))
      .filter((item): item is Raster => item !== undefined)
  );
  const reference = new Raster(width, height);
  reference.data.set(below.data);
  over(reference, handwear);
  over(reference, above);
  return {
    contract,
    scale,
    landmarkSha,
    imageSha,
    marks,
    shoulder,
    elbow,
    wrist,
    order,
    layers,
    inputs,
    handwear,
    width,
    height,
    image,
    arm,
    otherHandwear,
    armMask,
    completed,
    cut,
    parts,
    residual,
    armConservation,
    layerConservation,
    silhouette,
    partReports,
    sections,
    specs,
    overlap,
    elbowRadiusTemplate,
    below,
    above,
    reference
  };
}

/**
 * Task D and E of `limb-study`: the rotation tests and their metrics for a set of parts (upper arm, forearm, hand).
 * `underlay-study` calls it with parts that have new underlay pixels. The renderer and the metrics are the same.
 */
export function evaluateRotations(context: LimbContext, parts: readonly Raster[]): Evaluation {
  const { width, height, elbow, wrist, below, above, otherHandwear, residual, specs, sections, silhouette, reference, layers, order, overlap } = context;
  const gapUnion = specs.map(() => new Uint8Array(width * height));
  const heatGap = new Uint16Array(width * height);
  const heatOverlap = new Uint16Array(width * height);
  const coverUnion = new Uint8Array(width * height);
  const rendered = rotationTests.map((test) => {
    const placed = placeParts(parts, elbow, wrist, test);
    const frame = new Raster(width, height);
    frame.data.set(below.data);
    over(frame, otherHandwear);
    over(frame, residual);
    for (const part of placed.parts) over(frame, part);
    over(frame, above);
    const masks = placed.parts.map((part) => opaque(part));
    const cover = new Uint8Array(width * height);
    for (let p = 0; p < cover.length; p += 1) if (masks.some((mask) => mask[p] === 1)) cover[p] = 1;
    for (let p = 0; p < cover.length; p += 1) if (cover[p] === 1) coverUnion[p] = 1;
    const anyMasks = placed.parts.map((part) => opaque(part, 1));
    const residualAny = opaque(residual, 1);
    const coverAny = new Uint8Array(width * height);
    for (let p = 0; p < coverAny.length; p += 1) if (residualAny[p] === 1 || anyMasks.some((mask) => mask[p] === 1)) coverAny[p] = 1;
    const pivots = [elbow, applyAffine(placed.transforms[1] as Affine, wrist)];
    const joints = specs.map((spec, index) => {
      const pivot = pivots[index] as Joint;
      const window = spec.radius * windowFactor;
      const parentMask = masks[spec.parent - 1] as Uint8Array;
      const childMask = masks[spec.child - 1] as Uint8Array;
      const gap = jointGap(
        spec.cut,
        sections[index] as Section,
        placed.transforms[spec.parent - 1] as Affine,
        placed.transforms[spec.child - 1] as Affine,
        anyMasks[spec.parent - 1] as Uint8Array,
        anyMasks[spec.child - 1] as Uint8Array,
        coverAny,
        width,
        window
      );
      let expectedOverlap = 0;
      let unwantedOverlap = 0;
      const overlapMask = new Uint8Array(width * height);
      for (let p = 0; p < cover.length; p += 1) {
        if (parentMask[p] !== 1 || childMask[p] !== 1) continue;
        const c = center(p, width);
        if (Math.hypot(c.x - pivot.x, c.y - pivot.y) <= spec.radius) {
          expectedOverlap += 1;
          overlapMask[p] = 1;
        } else {
          unwantedOverlap += 1;
          overlapMask[p] = 2;
        }
      }
      const seam = seamAt(parts[spec.child - 1] as Raster, spec.cut, placed.transforms[spec.child - 1] as Affine, frame, cover);
      return { spec, pivot, gap, expectedOverlap, unwantedOverlap, overlapMask, seam };
    });
    for (const joint of joints) {
      for (let p = 0; p < cover.length; p += 1) {
        if (joint.gap.gap[p] === 1) heatGap[p] = (heatGap[p] ?? 0) + 1;
        if (joint.overlapMask[p] === 2 || joint.gap.protrusion[p] === 1) heatOverlap[p] = (heatOverlap[p] ?? 0) + 1;
      }
    }
    // The gap union of a joint uses only the tests where that joint is the only moved joint (its pivot stays in place).
    joints.forEach((joint, index) => {
      const only = index === 0 ? test.wrist === 0 : test.elbow === 0;
      if (!only) return;
      const union = gapUnion[index] as Uint8Array;
      for (let p = 0; p < union.length; p += 1) if (joint.gap.gap[p] === 1) union[p] = 1;
    });
    let revealed = 0;
    let revealedEmpty = 0;
    for (let p = 0; p < cover.length; p += 1) {
      if (silhouette[p] !== 1 || cover[p] === 1) continue;
      revealed += 1;
      if ((frame.data[p * 4 + 3] ?? 0) < 255) revealedEmpty += 1;
    }
    return { test, frame, cover, joints, revealed, revealedEmpty, placed };
  });
  const sourceFrame = rendered[0]?.frame as Raster;
  let recomposedDifferent = 0;
  for (let i = 0; i < sourceFrame.data.length; i += 1) if (sourceFrame.data[i] !== reference.data[i]) recomposedDifferent += 1;
  const allLayers = composite(
    width,
    height,
    order.map((tag) => layers.get(tag)).filter((item): item is Raster => item !== undefined)
  );
  let maxToFullComposite = 0;
  for (let i = 0; i < sourceFrame.data.length; i += 1) maxToFullComposite = Math.max(maxToFullComposite, Math.abs((sourceFrame.data[i] ?? 0) - (allLayers.data[i] ?? 0)));

  // E. Metrics.
  const tests = rendered.map(({ test, joints, revealed, revealedEmpty }) => ({
    id: test.id,
    elbowDegrees: test.elbow,
    wristDegrees: test.wrist,
    joints: joints.map((joint) => ({
      joint: joint.spec.id,
      pivot: { x: round(joint.pivot.x, 2), y: round(joint.pivot.y, 2) },
      gapPixels: joint.gap.gapPixels,
      protrusionPixels: joint.gap.protrusionPixels,
      expectedOverlapPixels: joint.expectedOverlap,
      unwantedOverlapPixels: joint.unwantedOverlap,
      cutEdgePixels: joint.seam.edgePixels,
      exposedCutEdgePixels: joint.seam.exposedEdgePixels,
      visibleSeamPixels: joint.seam.visibleSeamPixels,
      meanDifferenceAcrossCut: joint.seam.meanDifference
    })),
    revealedArmPixels: revealed,
    revealedTransparentPixels: revealedEmpty,
    problemPixels: joints.reduce((sum, joint) => sum + joint.gap.gapPixels + joint.gap.protrusionPixels + joint.unwantedOverlap + joint.seam.visibleSeamPixels, 0)
  }));
  const jointSummary = specs.map((spec, index) => {
    const own = tests.filter((test) => (index === 0 ? test.wristDegrees === 0 && test.elbowDegrees !== 0 : test.elbowDegrees === 0 && test.wristDegrees !== 0));
    const rows = own.map((test) => ({ id: test.id, ...test.joints[index] }));
    const source = tests[0]?.joints[index];
    return {
      joint: spec.id,
      sourcePoseGapPixels: source?.gapPixels ?? 0,
      sourcePoseVisibleSeamPixels: source?.visibleSeamPixels ?? 0,
      sourcePoseMeanDifferenceAcrossCut: source?.meanDifferenceAcrossCut ?? 0,
      worstGapPixels: Math.max(...rows.map((row) => row.gapPixels ?? 0)),
      worstProtrusionPixels: Math.max(...rows.map((row) => row.protrusionPixels ?? 0)),
      worstUnwantedOverlapPixels: Math.max(...rows.map((row) => row.unwantedOverlapPixels ?? 0)),
      worstVisibleSeamPixels: Math.max(...rows.map((row) => row.visibleSeamPixels ?? 0)),
      gapUnionPixels: count(gapUnion[index] as Uint8Array),
      missingParentPixelsInsideArm: (overlap[index]?.report.missingParentPixelsInsideArm as number) ?? 0
    };
  });

  return { rendered, tests, jointSummary, gapUnion, heatGap, heatOverlap, coverUnion, sourceFrame, recomposedDifferent, maxToFullComposite };
}

/** `limb-study`: tasks A to F of experiment L0-1e for the image-left (near) arm. */
export function limbStudyCommand(options: LimbStudyOptions): CommandResult {
  const context = prepareLimb(options);
  const {
    contract,
    scale,
    landmarkSha,
    imageSha,
    marks,
    shoulder,
    elbow,
    wrist,
    inputs,
    width,
    height,
    image,
    arm,
    armMask,
    completed,
    cut,
    parts,
    residual,
    armConservation,
    layerConservation,
    silhouette,
    partReports,
    sections,
    specs,
    overlap,
    elbowRadiusTemplate,
    reference
  } = context;
  const { rendered, tests, jointSummary, gapUnion, heatGap, heatOverlap, coverUnion, sourceFrame, recomposedDifferent, maxToFullComposite } = evaluateRotations(context, parts);
  // F. Images. One crop for all images: the arm in all tests, with a margin.
  const bounds = boxAround([...maskPoints(coverUnion, width), ...maskPoints(silhouette, width)], 24, width, height);
  const files: PlannedFile[] = [];
  const records: FileRecord[] = [];
  const add = (name: string, raster: Raster): void => {
    const file = { name, bytes: encodePng(raster) };
    files.push(file);
    records.push(record(file, raster));
  };
  const local = (point: Joint): Joint => ({ x: point.x - bounds.left, y: point.y - bounds.top });
  const fadedSource = (opacity: number): Raster => onWhite(crop(image, bounds), opacity);

  // 1. Joints, axes, cut lines, overlap circles (before the cut).
  const plan = fadedSource(0.55);
  const armView = crop(arm, bounds);
  plan.draw(armView, 0, 0, 0.6);
  plan.line(local(shoulder), local(elbow), 2, partColors[0] as Color);
  plan.line(local(elbow), local(wrist), 2, partColors[1] as Color);
  plan.line(local(wrist), local({ x: wrist.x + cut.handDirection.x * 60, y: wrist.y + cut.handDirection.y * 60 }), 2, partColors[2] as Color);
  sections.forEach((section) => {
    plan.line(local(section.from), local(section.to), 2, black);
  });
  specs.forEach((spec) => {
    ring(plan, local(spec.cut.joint), spec.radius, residualColor);
    ring(plan, local(spec.cut.joint), spec.radius * windowFactor, baselineColor, 1);
  });
  for (const point of [shoulder, elbow, wrist]) cross(plan, local(point), black);
  const plan2 = titled(scaled(plan, 2), 'L0-1e near arm: manual joints and cut lines (no cut yet)', [
    'blue S-E upper arm axis, orange E-W forearm axis, green hand direction; black = cut line (joint bisector)',
    `red circle = C0.5 overlap ${elbowRadiusTemplate} template px = ${round(specs[0]?.radius ?? 0)} image px; grey = gap test window`,
    'joint marks are human estimates (L0-1d), not confirmed anatomical joints'
  ]);
  add('1-joints-and-cut-lines.png', plan2);

  // 2. Parts: class map and exploded view.
  const classes = new Raster(bounds.right - bounds.left, bounds.bottom - bounds.top, white);
  const exploded = new Raster(classes.width + 160, classes.height + 160);
  exploded.draw(checker(exploded.width, exploded.height), 0, 0);
  for (let y = bounds.top; y < bounds.bottom; y += 1) {
    for (let x = bounds.left; x < bounds.right; x += 1) {
      const p = y * width + x;
      const label = cut.assignment[p] ?? 0;
      if (label === 0) continue;
      const color = label === residualLabel ? residualColor : cut.boundary[p] === 1 ? boundaryColor : (partColors[label - 1] as Color);
      classes.data.set(color, ((y - bounds.top) * classes.width + (x - bounds.left)) * 4);
      if (completed[p] === 1 && label !== residualLabel && cut.boundary[p] !== 1 && (x + y) % 3 === 0) classes.data.set(completedColor, ((y - bounds.top) * classes.width + (x - bounds.left)) * 4);
    }
  }
  const offsets = [
    { x: 80, y: 20 },
    { x: 80 + Math.round(cut.elbow.normal.x * 50), y: 20 + Math.round(cut.elbow.normal.y * 50) },
    { x: 80 + Math.round(cut.elbow.normal.x * 50 + cut.wrist.normal.x * 50), y: 20 + Math.round(cut.elbow.normal.y * 50 + cut.wrist.normal.y * 50) }
  ];
  parts.forEach((part, index) => {
    const offset = offsets[index] as { x: number; y: number };
    exploded.draw(crop(part, bounds), offset.x, offset.y);
  });
  const partsSheet = sheetOf(
    [
      [
        titled(scaled(classes, 2), 'pixel classes', [
          'blue/orange/green = part core; black = boundary band +-1.5 px',
          `red = residual (${count(Uint8Array.from(cut.assignment, (v) => (v === residualLabel ? 1 : 0)))} px); yellow dots = See-through completed`
        ]),
        titled(scaled(exploded, 2), 'three parts (source RGBA, moved apart along the cut normals)', [
          partReports.map((item) => `${item.part} ${item.pixels} px`).join(', '),
          `conservation exact: ${armConservation.exact}`
        ])
      ]
    ],
    12
  );
  add('2-parts.png', partsSheet);
  parts.forEach((part, index) => {
    add(`parts/${partNames[index] ?? 'part'}.png`, part);
  });
  add('parts/residual.png', residual);

  // 3 and 4. Rotation results, gap and overlap maps, contact sheet, heatmap.
  const tiles: Raster[] = [];
  for (const item of rendered) {
    const result = onWhite(crop(item.frame, bounds));
    add(`rotations/${item.test.id}/result.png`, result);
    const holes = onWhite(crop(item.frame, bounds), 0.35);
    const overlapView = onWhite(crop(item.frame, bounds), 0.35);
    const localPaint = (target: Raster, mask: Uint8Array, color: Color): void => {
      for (let y = bounds.top; y < bounds.bottom; y += 1) for (let x = bounds.left; x < bounds.right; x += 1) if (mask[y * width + x] === 1) target.blend(x - bounds.left, y - bounds.top, color);
    };
    item.joints.forEach((joint) => {
      localPaint(holes, joint.gap.gap, gapColor);
      localPaint(
        overlapView,
        joint.overlapMask.map((value) => (value === 1 ? 1 : 0)),
        expectedOverlapColor
      );
      localPaint(
        overlapView,
        joint.overlapMask.map((value) => (value === 2 ? 1 : 0)),
        unwantedOverlapColor
      );
      localPaint(overlapView, joint.gap.protrusion, unwantedOverlapColor);
      localPaint(overlapView, joint.seam.seam, seamColor);
      ring(holes, local(joint.pivot), joint.spec.radius, black, 1);
      ring(overlapView, local(joint.pivot), joint.spec.radius, black, 1);
    });
    add(`rotations/${item.test.id}/holes.png`, holes);
    add(`rotations/${item.test.id}/overlaps.png`, overlapView);
    const row = tests.find((test) => test.id === item.test.id);
    const lines = (row?.joints ?? []).map(
      (joint) => `${joint.joint}: gap ${joint.gapPixels}, protrusion ${joint.protrusionPixels}, unwanted overlap ${joint.unwantedOverlapPixels}, seam ${joint.visibleSeamPixels}`
    );
    const tile = new Raster(result.width * 2 + 4, result.height, white);
    tile.draw(result, 0, 0);
    const marked = onWhite(crop(item.frame, bounds), 0.35);
    item.joints.forEach((joint) => {
      localPaint(marked, joint.gap.gap, gapColor);
      localPaint(
        marked,
        joint.overlapMask.map((value) => (value === 2 ? 1 : 0)),
        unwantedOverlapColor
      );
      localPaint(marked, joint.gap.protrusion, unwantedOverlapColor);
      localPaint(marked, joint.seam.seam, seamColor);
    });
    tile.draw(marked, result.width + 4, 0);
    tiles.push(titled(tile, `${item.test.id} (elbow ${item.test.elbow}, wrist ${item.test.wrist} deg)`, lines));
  }
  const tileRows: Raster[][] = [];
  for (let i = 0; i < tiles.length; i += 2) tileRows.push(tiles.slice(i, i + 2));
  const contact = sheetOf(tileRows, 12);
  add(
    '3-rotation-contact-sheet.png',
    titled(contact, 'L0-1e rotation tests (diagnostic angles, positive = clockwise on screen)', [
      'left: result; right: red = opened joint gap, magenta = protrusion or unwanted overlap, orange = visible or exposed cut edge'
    ])
  );
  const heat = fadedSource(0.3);
  const maxGap = heatGap.reduce((max, value) => Math.max(max, value), 1);
  const maxOverlap = heatOverlap.reduce((max, value) => Math.max(max, value), 1);
  for (let y = bounds.top; y < bounds.bottom; y += 1) {
    for (let x = bounds.left; x < bounds.right; x += 1) {
      const p = y * width + x;
      const g = heatGap[p] ?? 0;
      const o = heatOverlap[p] ?? 0;
      if (g > 0) heat.blend(x - bounds.left, y - bounds.top, [230, 0, 0, Math.round(80 + (175 * g) / maxGap)]);
      if (o > 0) heat.blend(x - bounds.left, y - bounds.top, [0, 60, 230, Math.round(80 + (175 * o) / maxOverlap)]);
    }
  }
  add(
    '4-gap-overlap-heatmap.png',
    titled(scaled(heat, 2), 'opened gap (red) and protrusion or unwanted overlap (blue) over all tests', [`darker = more tests (max ${maxGap} gap, ${maxOverlap} overlap)`])
  );

  // 5. Source composition against the recomposed source pose.
  const difference = new Raster(bounds.right - bounds.left, bounds.bottom - bounds.top, white);
  for (let y = bounds.top; y < bounds.bottom; y += 1) {
    for (let x = bounds.left; x < bounds.right; x += 1) {
      const i = (y * width + x) * 4;
      let d = 0;
      for (let c = 0; c < 4; c += 1) d = Math.max(d, Math.abs((sourceFrame.data[i + c] ?? 0) - (reference.data[i + c] ?? 0)));
      if (d > 0) difference.data.set([255, 0, 0, 255], ((y - bounds.top) * difference.width + (x - bounds.left)) * 4);
    }
  }
  add(
    '5-source-vs-recomposed.png',
    sheetOf(
      [
        [
          titled(onWhite(crop(image, bounds)), 'input image'),
          titled(onWhite(crop(reference, bounds)), 'layers (source)'),
          titled(onWhite(crop(sourceFrame, bounds)), 'three parts (source pose)'),
          titled(difference, `difference: ${recomposedDifferent} bytes`)
        ]
      ],
      12
    )
  );

  // 6. Missing geometry: zoomed views of each joint.
  const zooms = specs.map((spec, index) => {
    const r = Math.ceil(spec.radius * windowFactor + 6);
    const box = boxAround([spec.cut.joint], r, width, height);
    const view = onWhite(crop(arm, box), 0.5);
    const at = (p: number): { x: number; y: number } | null => {
      const x = p % width;
      const y = (p - x) / width;
      return x >= box.left && x < box.right && y >= box.top && y < box.bottom ? { x: x - box.left, y: y - box.top } : null;
    };
    const item = overlap[index];
    const union = gapUnion[index] as Uint8Array;
    for (let p = 0; p < width * height; p += 1) {
      const point = at(p);
      if (!point) continue;
      if (item?.disk[p] === 1 && silhouette[p] !== 1) view.blend(point.x, point.y, [150, 150, 150, 120]);
      if (cut.assignment[p] === spec.parent && item?.disk[p] === 1) view.blend(point.x, point.y, [40, 110, 230, 110]);
      if (item?.missing[p] === 1) view.blend(point.x, point.y, [missingColor[0], missingColor[1], missingColor[2], 150]);
      if (union[p] === 1 && (point.x + point.y) % 2 === 0) view.blend(point.x, point.y, unwantedOverlapColor);
    }
    ring(view, { x: spec.cut.joint.x - box.left, y: spec.cut.joint.y - box.top }, spec.radius, black, 1);
    cross(view, { x: spec.cut.joint.x - box.left, y: spec.cut.joint.y - box.top }, black, 4);
    const report = item?.report ?? {};
    return titled(scaled(view, 4), `${spec.id}: missing parent geometry`, [
      `blue = ${String(report.parent)} pixels in the overlap circle (${String(report.parentPixelsInDisk)})`,
      `red = missing ${String(report.parent)} pixels inside the arm (${String(report.missingParentPixelsInsideArm)})`,
      'grey = circle outside the arm',
      `magenta dots = opened gap, all ${spec.id} tests (${count(union)})`
    ]);
  });
  add('6-missing-geometry.png', sheetOf([zooms], 12));

  const status = {
    cut: cut.conflictPixels === 0 && cut.cutIslandPixels === 0 && armConservation.exact ? 'PASS' : 'PARTIAL',
    sourcePose: recomposedDifferent === 0 ? 'PASS' : 'FAIL'
  };
  const report = {
    format: limbFormat,
    tool: { name: '@aigg/control', version: options.toolVersion, command: 'limb-study' },
    prototype: true,
    note: 'Diagnostic prototype of experiment L0-1e. The parts are not Spine attachments. The angles are not animation limits. No pixel is painted or generated.',
    inputs: {
      contract: { rigId: contract.rigId, sha256: sha256(options.contractBytes) },
      metadata: { name: options.metadataName, sha256: sha256(options.metadataBytes) },
      image: { sha256: imageSha, pixelSha256: pixelHash(image) },
      manualLandmarks: { sha256: landmarkSha },
      study: { sha256: sha256(options.studyBytes), similarityScaleImageToTemplate: scale },
      layers: inputs
    },
    joints: marks.map((item) => ({
      id: item.id,
      point: item.point,
      visibility: item.visibility,
      confidence: item.confidence,
      origin: item.origin,
      method: item.method,
      note: item.note,
      status: 'human estimate, not a confirmed anatomical joint'
    })),
    rules: {
      cutLine: 'A line through the joint mark. Its normal is the mean of the unit limb directions on the two sides (joint bisector).',
      boundaryBandPx: boundaryBand,
      residual: 'Pixels between crossed cut lines and pixels outside the main component of their part.',
      overlap: 'C0.5: the parent attachment covers a circle of the overlap radius around the child pivot. Pixels count at alpha >= 128.',
      rotation: 'Nearest-neighbor inverse mapping about the joint marks. Positive = clockwise on the screen. Residual pixels stay in place.',
      gap: 'Pixels between the moved parent cut line and the moved child cut line (the opened wedge), not farther from the pivot than the source cross-section, that no arm pixel covers (alpha > 0). Zero in the source pose by definition.',
      protrusion: `Moved child pixels more than 1 px on the parent side of the moved parent cut line, within ${windowFactor} x the overlap radius of the pivot, where the parent has no pixel.`,
      unwantedOverlap: 'Pixels where the parent and the child both cover (alpha >= 128) outside the overlap circle.',
      seam: `Child pixels within ${boundaryBand} px of the cut, compared with the final image 2 px across the moved cut. Visible: largest RGB difference above ${seamThreshold}. Exposed: no arm part there.`
    },
    geometry: {
      upperArmDirectionDegrees: directionDegrees(sub(elbow, shoulder)),
      forearmDirectionDegrees: directionDegrees(sub(wrist, elbow)),
      handDirectionDegrees: directionDegrees(cut.handDirection),
      elbowBendDegrees: round(directionDegrees(sub(wrist, elbow)) - directionDegrees(sub(elbow, shoulder))),
      wristBendDegrees: round(directionDegrees(cut.handDirection) - directionDegrees(sub(wrist, elbow))),
      cuts: [
        { joint: 'elbow', normal: { x: round(cut.elbow.normal.x, 4), y: round(cut.elbow.normal.y, 4) }, ...sections[0] },
        { joint: 'wrist', normal: { x: round(cut.wrist.normal.x, 4), y: round(cut.wrist.normal.y, 4) }, ...sections[1] }
      ]
    },
    split: {
      armPixels: count(armMask),
      seeThroughCompletedPixels: count(completed),
      parts: partReports,
      residualPixels: count(Uint8Array.from(cut.assignment, (v) => (v === residualLabel ? 1 : 0))),
      conflictPixels: cut.conflictPixels,
      fragmentPixels: cut.fragmentPixels,
      cutIslandPixels: cut.cutIslandPixels,
      armConservation,
      handwearConservation: layerConservation
    },
    overlap: overlap.map((item) => item.report),
    tests,
    jointSummary,
    sourcePose: {
      recomposedEqualsLayerComposite: recomposedDifferent === 0,
      differentBytes: recomposedDifferent,
      maxChannelDifferenceToSequentialComposite: maxToFullComposite
    },
    status,
    files: records
  };
  files.push({ name: 'metrics.json', bytes: json(report) });
  return {
    report: {
      format: limbFormat,
      status,
      split: { parts: partReports.map((item) => `${item.part}:${item.pixels}`), residualPixels: report.split.residualPixels, conservationExact: armConservation.exact },
      jointSummary,
      files: files.length
    },
    files
  };
}
