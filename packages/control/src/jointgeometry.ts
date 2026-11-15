import type { Affine } from '@control/align';
import { type CommandResult, type FileRecord, json, record, sheetOf } from '@control/commands';
import type { Joint } from '@control/contract';
import { checker } from '@control/layersplit';
import {
  boxAround,
  center,
  count,
  crop,
  type Cut,
  dot,
  evaluateRotations,
  type Evaluation,
  type LimbContext,
  type LimbStudyOptions,
  maskPoints,
  prepareLimb,
  ring,
  type RotationTest,
  rotationTests,
  round,
  scaled,
  type Section,
  sub,
  titled,
  transformPart,
  unit,
  type Vector
} from '@control/limbstudy';
import type { PlannedFile } from '@control/output';
import { encodePng } from '@control/png';
import { type Color, Raster } from '@control/raster';
import {
  armOnly,
  directionalFill,
  frameChange,
  innerOffsetPx,
  maskRaster,
  nearestEdgeFill,
  onColor,
  provenanceTag,
  type UnderlayFill,
  type UnderlayMethod,
  underlayMethods,
  type UnderlayRegion,
  underlayRegion,
  withUnderlay
} from '@control/underlay';

// `geometry-study` (experiment L0-1g, prototype): compares three diagnostic underlay regions at the elbow and the wrist of the near arm,
// with and without the occlusion-safe rule, with the two L0-1f fill methods. It uses the L0-1e renderer and metrics without change, adds
// a wider set of diagnostic angles, and repeats a subset with shifted joint marks. The regions B and C are research alternatives, not a
// change of the C0.5 overlap rule. No model, no random values, no network.

export const geometryFormat = 'aigg.l0-1g.geometry-study/0.1';

/** A: the C0.5 circle. B: a circle with the largest cross-section extent as radius. C: the parent cross-section swept along the parent axis. */
export type RegionKind = 'circle' | 'wide_circle' | 'tube';
export const regionKinds: readonly RegionKind[] = ['circle', 'wide_circle', 'tube'];

/** Additional diagnostic angles. They are not animation limits. */
export const extendedTests: readonly RotationTest[] = [
  { id: 'elbow-2', elbow: -2, wrist: 0 },
  { id: 'elbow+2', elbow: 2, wrist: 0 },
  { id: 'elbow-45', elbow: -45, wrist: 0 },
  { id: 'elbow+45', elbow: 45, wrist: 0 },
  { id: 'elbow-60', elbow: -60, wrist: 0 },
  { id: 'elbow+60', elbow: 60, wrist: 0 },
  { id: 'wrist-2', elbow: 0, wrist: -2 },
  { id: 'wrist+2', elbow: 0, wrist: 2 },
  { id: 'wrist-30', elbow: 0, wrist: -30 },
  { id: 'wrist+30', elbow: 0, wrist: 30 },
  { id: 'wrist-45', elbow: 0, wrist: -45 },
  { id: 'wrist+45', elbow: 0, wrist: 45 }
];

/** Shifts of the elbow and the wrist marks (image px) for the sensitivity study. */
export const sensitivityShifts: readonly Vector[] = [
  { x: -4, y: 0 },
  { x: -2, y: 0 },
  { x: 2, y: 0 },
  { x: 4, y: 0 },
  { x: 0, y: -4 },
  { x: 0, y: -2 },
  { x: 0, y: 2 },
  { x: 0, y: 4 }
];

type Extents = { readonly extentNegativePx: number; readonly extentPositivePx: number };

/**
 * Region C (tube): pixels q on the child side of the cut with 0 <= d <= depth (d along the cut normal), where the parent has no pixel, and
 * where the point 1 px inside the parent back along the parent axis is a parent pixel inside the cross-section. Thus the region follows the
 * parent contour past the cut line, like a capsule end that has the width of the limb.
 */
export function tubeRegion(parent: Raster, cut: Cut, axis: Vector, extents: Extents, depth: number): UnderlayRegion {
  const { width, height } = parent;
  const region = new Uint8Array(width * height);
  const along = { x: -cut.normal.y, y: cut.normal.x };
  const cosine = dot(axis, cut.normal);
  let regionPixels = 0;
  if (cosine <= 0.05) return { region, regionPixels };
  const reach = Math.ceil(depth / cosine + Math.max(extents.extentNegativePx, extents.extentPositivePx)) + 2;
  for (let y = Math.max(0, Math.floor(cut.joint.y - reach)); y <= Math.min(height - 1, Math.ceil(cut.joint.y + reach)); y += 1) {
    for (let x = Math.max(0, Math.floor(cut.joint.x - reach)); x <= Math.min(width - 1, Math.ceil(cut.joint.x + reach)); x += 1) {
      const p = y * width + x;
      if ((parent.data[p * 4 + 3] ?? 0) > 0) continue;
      const q = center(p, width);
      const d = dot(sub(q, cut.joint), cut.normal);
      if (d < 0 || d > depth) continue;
      const back = (d + innerOffsetPx) / cosine;
      const q0 = { x: q.x - back * axis.x, y: q.y - back * axis.y };
      const t0 = dot(sub(q0, cut.joint), along);
      if (t0 < -extents.extentNegativePx || t0 > extents.extentPositivePx) continue;
      if ((parent.pixel(Math.floor(q0.x), Math.floor(q0.y))[3] ?? 0) === 0) continue;
      region[p] = 1;
      regionPixels += 1;
    }
  }
  return { region, regionPixels };
}

/**
 * The occlusion-safe rule: keep only region pixels where the child is fully opaque (alpha 255) in the source pose. Under a partly
 * transparent or empty child pixel, an underlay pixel always changes the neutral frame (source-over with straight alpha), so this rule is
 * necessary and sufficient for a bit-exact neutral frame.
 */
export function occlusionSafe(region: UnderlayRegion, child: Raster): UnderlayRegion & { readonly removedPixels: number } {
  const safe = new Uint8Array(region.region.length);
  let regionPixels = 0;
  for (let p = 0; p < safe.length; p += 1) {
    if (region.region[p] !== 1 || (child.data[p * 4 + 3] ?? 0) !== 255) continue;
    safe[p] = 1;
    regionPixels += 1;
  }
  return { region: safe, regionPixels, removedPixels: region.regionPixels - regionPixels };
}

/** The largest distance from the joint mark to a region pixel center, plus 1 px. Method A searches its sources within this distance. */
export function regionReach(region: Uint8Array, joint: Joint, width: number): number {
  let reach = 0;
  for (let p = 0; p < region.length; p += 1) {
    if (region[p] !== 1) continue;
    const c = center(p, width);
    reach = Math.max(reach, Math.hypot(c.x - joint.x, c.y - joint.y));
  }
  return reach + 1;
}

export type VariantSpec = { readonly id: string; readonly region: RegionKind; readonly safe: boolean; readonly method: UnderlayMethod };
export const variantSpecs: readonly VariantSpec[] = regionKinds.flatMap((region) =>
  [false, true].flatMap((safe) => underlayMethods.map((method) => ({ id: `${region}${safe ? '_safe' : ''}_${method === 'nearest_edge' ? 'A' : 'B'}`, region, safe, method })))
);
/** The variants in the images: one fill method (B), all regions, with and without the occlusion-safe rule. */
const visualIds = ['baseline', 'circle_B', 'wide_circle_B', 'tube_B', 'circle_safe_B', 'tube_safe_B'];
const sensitivityIds = ['circle_B', 'wide_circle_B', 'tube_B', 'circle_safe_B', 'wide_circle_safe_B', 'tube_safe_B'];

type JointRegions = {
  readonly kind: Record<RegionKind, UnderlayRegion>;
  readonly safe: Record<RegionKind, UnderlayRegion & { removedPixels: number }>;
  readonly wideRadius: number;
  readonly depth: number;
};

function regionsOf(context: LimbContext): JointRegions[] {
  const { specs, parts, sections, shoulder, elbow, wrist } = context;
  const axes: Vector[] = [unit(sub(elbow, shoulder)), unit(sub(wrist, elbow))];
  return specs.map((spec, index) => {
    const parent = parts[spec.parent - 1] as Raster;
    const child = parts[spec.child - 1] as Raster;
    const section = sections[index] as Section;
    // Never smaller than the C0.5 radius: region B contains region A.
    const wideRadius = Math.max(spec.radius, section.extentNegativePx, section.extentPositivePx);
    const kind: Record<RegionKind, UnderlayRegion> = {
      circle: underlayRegion(parent, spec.cut, section, spec.radius),
      wide_circle: underlayRegion(parent, spec.cut, section, wideRadius),
      tube: tubeRegion(parent, spec.cut, axes[index] as Vector, section, spec.radius)
    };
    const safe = { circle: occlusionSafe(kind.circle, child), wide_circle: occlusionSafe(kind.wide_circle, child), tube: occlusionSafe(kind.tube, child) };
    return { kind, safe, wideRadius, depth: spec.radius };
  });
}

type Built = {
  readonly parts: Raster[];
  readonly fills: UnderlayFill[];
  readonly newMasks: Uint8Array[];
  readonly outsideRegion: number;
  readonly changedSource: number;
  readonly outsideCircle: number[];
};

function buildVariant(context: LimbContext, regions: readonly JointRegions[], variant: VariantSpec): Built {
  const { specs, parts, shoulder, elbow, wrist, width, height } = context;
  const axes: Vector[] = [unit(sub(elbow, shoulder)), unit(sub(wrist, elbow))];
  const fills = specs.map((spec, index) => {
    const parent = parts[spec.parent - 1] as Raster;
    const child = parts[spec.child - 1] as Raster;
    const jointRegions = regions[index] as JointRegions;
    const region = (variant.safe ? jointRegions.safe : jointRegions.kind)[variant.region].region;
    return variant.method === 'nearest_edge'
      ? nearestEdgeFill(parent, spec.cut, region, regionReach(region, spec.cut.joint, width))
      : directionalFill(parent, child, spec.cut, axes[index] as Vector, region);
  });
  const built = parts.map((part, index) =>
    withUnderlay(
      part,
      fills.filter((_, joint) => (specs[joint]?.parent ?? 0) - 1 === index)
    )
  );
  const newMasks = parts.map((_, index) => {
    const mask = new Uint8Array(width * height);
    fills.forEach((fill, joint) => {
      if ((specs[joint]?.parent ?? 0) - 1 !== index) return;
      for (let p = 0; p < mask.length; p += 1) if (fill.newMask[p] === 1) mask[p] = 1;
    });
    return mask;
  });
  let outsideRegion = 0;
  const outsideCircle = fills.map((fill, joint) => {
    const jointRegions = regions[joint] as JointRegions;
    const region = (variant.safe ? jointRegions.safe : jointRegions.kind)[variant.region].region;
    const spec = specs[joint];
    let outside = 0;
    for (let p = 0; p < region.length; p += 1) {
      if (fill.newMask[p] !== 1) continue;
      if (region[p] !== 1) outsideRegion += 1;
      const c = center(p, width);
      if (spec && Math.hypot(c.x - spec.cut.joint.x, c.y - spec.cut.joint.y) > spec.radius) outside += 1;
    }
    return outside;
  });
  return { parts: built.map((item) => item.part), fills, newMasks, outsideRegion, changedSource: built.reduce((sum, item) => sum + item.changedSourcePixels, 0), outsideCircle };
}

type JointGroupSummary = {
  joint: string;
  gapPixels: number;
  worstGapPixels: number;
  visibleSeamPixels: number;
  unwantedOverlapPixels: number;
  unwantedOverlapNearCirclePixels: number;
  protrusionPixels: number;
  gapUnionPixels: number;
};

/** Sums and worst values per joint over the tests where that joint turns (the source test excluded). */
function summarize(evaluation: Evaluation): JointGroupSummary[] {
  return [0, 1].map((index) => {
    const rows = evaluation.rendered.filter((item) => item.test.elbow !== 0 || item.test.wrist !== 0).map((item) => item.joints[index]);
    let nearCircle = 0;
    for (const joint of rows) {
      if (!joint) continue;
      for (let p = 0; p < joint.overlapMask.length; p += 1) {
        if (joint.overlapMask[p] !== 2) continue;
        const c = center(p, evaluation.sourceFrame.width);
        if (Math.hypot(c.x - joint.pivot.x, c.y - joint.pivot.y) <= joint.spec.radius + 1.5) nearCircle += 1;
      }
    }
    return {
      joint: index === 0 ? 'elbow' : 'wrist',
      gapPixels: rows.reduce((sum, joint) => sum + (joint?.gap.gapPixels ?? 0), 0),
      worstGapPixels: rows.reduce((worst, joint) => Math.max(worst, joint?.gap.gapPixels ?? 0), 0),
      visibleSeamPixels: rows.reduce((sum, joint) => sum + (joint?.seam.visibleSeamPixels ?? 0), 0),
      unwantedOverlapPixels: rows.reduce((sum, joint) => sum + (joint?.unwantedOverlap ?? 0), 0),
      unwantedOverlapNearCirclePixels: nearCircle,
      protrusionPixels: rows.reduce((sum, joint) => sum + (joint?.gap.protrusionPixels ?? 0), 0),
      gapUnionPixels: count(evaluation.gapUnion[index] as Uint8Array)
    };
  });
}

function frameDifference(frame: Raster, reference: Raster): { pixels: number; max: number; mask: Uint8Array } {
  const mask = new Uint8Array(frame.width * frame.height);
  let pixels = 0;
  let max = 0;
  for (let p = 0; p < mask.length; p += 1) {
    let d = 0;
    for (let c = 0; c < 4; c += 1) d = Math.max(d, Math.abs((frame.data[p * 4 + c] ?? 0) - (reference.data[p * 4 + c] ?? 0)));
    if (d === 0) continue;
    mask[p] = 1;
    pixels += 1;
    max = Math.max(max, d);
  }
  return { pixels, max, mask };
}

const movedMask = (masks: readonly Uint8Array[], transforms: readonly Affine[], width: number, height: number): Uint8Array => {
  const out = new Uint8Array(width * height);
  masks.forEach((mask, index) => {
    if (count(mask) === 0) return;
    const moved = transformPart(maskRaster(mask, width, height), transforms[index] as Affine);
    for (let p = 0; p < out.length; p += 1) if ((moved.data[p * 4 + 3] ?? 0) > 0) out[p] = 1;
  });
  return out;
};

const magenta: Color = [255, 0, 255, 255];
const white: Color = [255, 255, 255, 255];
const black: Color = [0, 0, 0, 255];

function onChecker(source: Raster): Raster {
  const out = checker(source.width, source.height);
  out.draw(source, 0, 0);
  return out;
}

type Views = { body: Raster; magenta: Raster; checker: Raster; transparent: Raster };
type Visual = { sheets: Map<string, Views>; zooms: Map<string, Views>; heatGap: Uint16Array; heatOverlap: Uint16Array; heatSeam: Uint16Array; sourceDifference: Uint8Array };

export type GeometryOptions = { readonly extended?: boolean; readonly shifts?: readonly Vector[] };

/** `geometry-study`: experiment L0-1g for the image-left (near) arm. */
export function geometryStudyCommand(options: LimbStudyOptions, settings: GeometryOptions = {}): CommandResult {
  const context = prepareLimb(options);
  const { width, height, specs, parts, residual, reference, silhouette, sections, elbow, wrist, image } = context;
  const groups: { id: 'l0_1e' | 'extended'; tests: readonly RotationTest[] }[] = [{ id: 'l0_1e', tests: rotationTests }];
  if (settings.extended !== false) groups.push({ id: 'extended', tests: extendedTests });
  const shifts = settings.shifts ?? sensitivityShifts;
  const regions = regionsOf(context);

  // Baseline (L0-1e parts, no underlay).
  const baselineFrames = new Map<string, Raster>();
  const baselineGroups = groups.map((group) => {
    const evaluation = evaluateRotations(context, parts, group.tests);
    for (const item of evaluation.rendered) baselineFrames.set(item.test.id, item.frame);
    return { group: group.id, joints: summarize(evaluation), coverUnion: evaluation.coverUnion };
  });
  const coverAll = new Uint8Array(width * height);
  for (const group of baselineGroups) for (let p = 0; p < coverAll.length; p += 1) if (group.coverUnion[p] === 1) coverAll[p] = 1;
  const bounds = boxAround([...maskPoints(coverAll, width), ...maskPoints(silhouette, width)], 24, width, height);
  const sheetTests = ['source', 'elbow-30', 'elbow+30', 'wrist-15', 'wrist+15', 'elbow+10_wrist+10', 'elbow+60', 'wrist+45'];
  const zoomTests: Record<'elbow' | 'wrist', string[]> = { elbow: ['source', 'elbow-30', 'elbow+30', 'elbow+60'], wrist: ['source', 'wrist-15', 'wrist+15', 'wrist+45'] };
  const zoomBox = (joint: 'elbow' | 'wrist', pivot: Joint): ReturnType<typeof boxAround> => boxAround([pivot], Math.ceil((regions[joint === 'elbow' ? 0 : 1]?.wideRadius ?? 30) * 1.6), width, height);

  const visualOf = (evaluation: Evaluation, visual: Visual): void => {
    for (const item of evaluation.rendered) {
      const arm = armOnly(item.placed.parts, residual);
      const views = (box: ReturnType<typeof boxAround>, factor: number): Views => {
        const armCrop = scaled(crop(arm, box), factor);
        return { body: onColor(scaled(crop(item.frame, box), factor), white), magenta: onColor(armCrop, magenta), checker: onChecker(armCrop), transparent: armCrop };
      };
      if (sheetTests.includes(item.test.id)) visual.sheets.set(item.test.id, views(bounds, 1));
      for (const joint of ['elbow', 'wrist'] as const) {
        if (!zoomTests[joint].includes(item.test.id)) continue;
        const pivot = joint === 'elbow' ? elbow : (item.joints[1]?.pivot ?? wrist);
        visual.zooms.set(`${joint}/${item.test.id}`, views(zoomBox(joint, pivot), 4));
      }
      for (const joint of item.joints) {
        for (let p = 0; p < visual.heatGap.length; p += 1) {
          if (joint.gap.gap[p] === 1) visual.heatGap[p] = (visual.heatGap[p] ?? 0) + 1;
          if (joint.overlapMask[p] === 2 || joint.gap.protrusion[p] === 1) visual.heatOverlap[p] = (visual.heatOverlap[p] ?? 0) + 1;
          if (joint.seam.seam[p] === 1) visual.heatSeam[p] = (visual.heatSeam[p] ?? 0) + 1;
        }
      }
    }
  };

  // Variants.
  const visuals = new Map<string, Visual>();
  const newVisual = (): Visual => ({
    sheets: new Map(),
    zooms: new Map(),
    heatGap: new Uint16Array(width * height),
    heatOverlap: new Uint16Array(width * height),
    heatSeam: new Uint16Array(width * height),
    sourceDifference: new Uint8Array(width * height)
  });
  const variantReports: Record<string, unknown>[] = [];
  const allVariants: { spec: VariantSpec | null; id: string }[] = [{ spec: null, id: 'baseline' }, ...variantSpecs.map((spec) => ({ spec, id: spec.id }))];
  let invariantsHold = true;
  for (const variant of allVariants) {
    const built: Built = variant.spec
      ? buildVariant(context, regions, variant.spec)
      : { parts: [...parts], fills: [], newMasks: parts.map(() => new Uint8Array(width * height)), outsideRegion: 0, changedSource: 0, outsideCircle: [0, 0] };
    const visual = visualIds.includes(variant.id) ? newVisual() : null;
    let sourcePose = { pixels: 0, max: 0 };
    let outsideMovedMax = 0;
    const smallAngle: Record<string, number> = {};
    const groupReports = groups.map((group) => {
      const evaluation = evaluateRotations(context, built.parts, group.tests);
      for (const item of evaluation.rendered) {
        const change = frameChange(baselineFrames.get(item.test.id) as Raster, item.frame, movedMask(built.newMasks, item.placed.transforms, width, height));
        outsideMovedMax = Math.max(outsideMovedMax, change.outside);
        if (Math.abs(item.test.elbow) <= 2 && Math.abs(item.test.wrist) <= 2) smallAngle[item.test.id] = change.changed;
        if (item.test.id === 'source') {
          const difference = frameDifference(item.frame, reference);
          sourcePose = { pixels: difference.pixels, max: difference.max };
          if (visual) visual.sourceDifference = difference.mask;
        }
      }
      if (visual) visualOf(evaluation, visual);
      return { group: group.id, joints: summarize(evaluation) };
    });
    if (built.changedSource !== 0 || built.outsideRegion !== 0 || outsideMovedMax !== 0 || (variant.spec === null && sourcePose.pixels !== 0)) invariantsHold = false;
    if (visual) visuals.set(variant.id, visual);
    variantReports.push({
      id: variant.id,
      region: variant.spec?.region ?? null,
      occlusionSafe: variant.spec?.safe ?? null,
      method: variant.spec?.method ?? null,
      joints: specs.map((spec, index) => {
        const jointRegions = regions[index] as JointRegions;
        const region = variant.spec ? (variant.spec.safe ? jointRegions.safe : jointRegions.kind)[variant.spec.region] : null;
        const fill = built.fills[index];
        return {
          joint: spec.id,
          regionPixels: region?.regionPixels ?? 0,
          newPixels: fill?.counts.newPixels ?? 0,
          unresolvedPixels: fill?.counts.unresolvedPixels ?? 0,
          outsideContourPixels: fill?.counts.outsideContourPixels ?? 0,
          newPixelsOutsideC05Circle: built.outsideCircle[index] ?? 0
        };
      }),
      invariants: { changedSourcePixels: built.changedSource, newPixelsOutsideRegion: built.outsideRegion, maxChangedFramePixelsOutsideMovedNewPixels: outsideMovedMax },
      sourcePose: { differentPixels: sourcePose.pixels, maxChannelDifference: sourcePose.max },
      smallAngleChangeAgainstBaseline: smallAngle,
      groups: groupReports
    });
  }

  // Sensitivity: shifted elbow and wrist marks, L0-1e angles, baseline and the method B variants.
  const sensitivity = shifts.map((shift) => {
    const shifted = prepareLimb(options, shift);
    let movedLabels = 0;
    for (let p = 0; p < width * height; p += 1) if (shifted.cut.assignment[p] !== context.cut.assignment[p]) movedLabels += 1;
    const shiftedRegions = regionsOf(shifted);
    const rows = [{ id: 'baseline', spec: null as VariantSpec | null }, ...sensitivityIds.map((id) => ({ id, spec: variantSpecs.find((item) => item.id === id) ?? null }))].map((variant) => {
      const built = variant.spec ? buildVariant(shifted, shiftedRegions, variant.spec) : null;
      const evaluation = evaluateRotations(shifted, built?.parts ?? shifted.parts, rotationTests);
      const difference = frameDifference(evaluation.sourceFrame, shifted.reference);
      return {
        id: variant.id,
        sourcePoseDifferentPixels: difference.pixels,
        invariantsHold: (built?.changedSource ?? 0) === 0 && (built?.outsideRegion ?? 0) === 0,
        joints: summarize(evaluation).map((joint, index) => ({ ...joint, regionPixels: built?.fills[index]?.counts.newPixels ?? 0 }))
      };
    });
    if (rows.some((row) => !row.invariantsHold) || rows[0]?.sourcePoseDifferentPixels !== 0) invariantsHold = false;
    return {
      shift,
      cutPixelsWithAnotherLabel: movedLabels,
      sections: shifted.sections.map((section) => ({ widthPx: section.widthPx, extentNegativePx: section.extentNegativePx, extentPositivePx: section.extentPositivePx })),
      variants: rows
    };
  });

  // Images.
  const files: PlannedFile[] = [];
  const records: FileRecord[] = [];
  const add = (name: string, raster: Raster): void => {
    const file = { name, bytes: encodePng(raster) };
    files.push(file);
    records.push(record(file, raster));
  };
  const label = (id: string): string => (id === 'baseline' ? 'baseline L0-1e' : id.replace(/_/g, ' '));

  // 1. Regions per joint: the three kinds, with the pixels that the occlusion-safe rule removes in red.
  const regionRows = specs.map((spec, index) => {
    const jointRegions = regions[index] as JointRegions;
    const box = boxAround([spec.cut.joint], Math.ceil(jointRegions.wideRadius * 1.6), width, height);
    return regionKinds.map((kind) => {
      const view = onColor(crop(armOnly(parts, residual), box), white);
      view.draw(new Raster(view.width, view.height, [255, 255, 255, 150]), 0, 0);
      const full = jointRegions.kind[kind].region;
      const safe = jointRegions.safe[kind].region;
      for (let y = box.top; y < box.bottom; y += 1) {
        for (let x = box.left; x < box.right; x += 1) {
          const p = y * width + x;
          if (full[p] !== 1) continue;
          view.blend(x - box.left, y - box.top, safe[p] === 1 ? [40, 90, 255, 200] : [230, 0, 0, 220]);
        }
      }
      const at = { x: spec.cut.joint.x - box.left, y: spec.cut.joint.y - box.top };
      ring(view, at, spec.radius, black, 1);
      ring(view, at, jointRegions.wideRadius, [0, 150, 60, 255], 1);
      return titled(scaled(view, 4), `${spec.id} ${kind.replace('_', ' ')}`, [
        `region ${jointRegions.kind[kind].regionPixels} px, occlusion-safe ${jointRegions.safe[kind].regionPixels} px (red = removed)`,
        `black ring C0.5 r ${round(spec.radius, 2)} px, green ring wide r ${round(jointRegions.wideRadius, 2)} px`
      ]);
    });
  });
  add(
    '1-regions.png',
    titled(sheetOf(regionRows, 12), 'L0-1g diagnostic underlay regions (blue = kept, red = removed by the occlusion-safe rule)', ['B and C are research alternatives, not a contract change'])
  );

  // 2. Contact sheets on the body, on transparency (checker), and on magenta. 3. Zooms.
  const backgrounds: (keyof Views)[] = ['body', 'checker', 'magenta'];
  for (const background of backgrounds) {
    const rows = sheetTests
      .filter((id) => visuals.get('baseline')?.sheets.has(id))
      .map((id) => visualIds.map((variantId) => titled(visuals.get(variantId)?.sheets.get(id)?.[background] ?? new Raster(1, 1), `${id} ${label(variantId)}`)));
    add(
      `2-sheet-${background === 'checker' ? 'transparent' : background}.png`,
      titled(sheetOf(rows, 10), `L0-1g regions with method B on ${background === 'checker' ? 'transparency (checker)' : background}`, [
        'positive = clockwise on screen; angles are diagnostic, not animation limits'
      ])
    );
    for (const joint of ['elbow', 'wrist'] as const) {
      const zoomRows = zoomTests[joint]
        .filter((id) => visuals.get('baseline')?.zooms.has(`${joint}/${id}`))
        .map((id) => visualIds.map((variantId) => titled(visuals.get(variantId)?.zooms.get(`${joint}/${id}`)?.[background] ?? new Raster(1, 1), `${id} ${label(variantId)}`)));
      add(
        `3-zoom-${joint}-${background === 'checker' ? 'transparent' : background}.png`,
        titled(sheetOf(zoomRows, 8), `L0-1g ${joint}, 4x, method B, on ${background === 'checker' ? 'transparency' : background}`)
      );
    }
  }
  for (const variantId of visualIds) {
    for (const [id, views] of visuals.get(variantId)?.sheets ?? []) add(`transparent/${variantId}/${id}.png`, views.transparent);
  }

  // 4. Heatmaps of the remaining problems over all tests. 5. Source pose differences.
  const heat = visualIds.map((variantId) => {
    const visual = visuals.get(variantId) as Visual;
    const view = onColor(crop(image, bounds), white);
    view.draw(new Raster(view.width, view.height, [255, 255, 255, 180]), 0, 0);
    for (let y = bounds.top; y < bounds.bottom; y += 1) {
      for (let x = bounds.left; x < bounds.right; x += 1) {
        const p = y * width + x;
        const level = (value: number): number => Math.min(255, 90 + 30 * value);
        if ((visual.heatGap[p] ?? 0) > 0) view.blend(x - bounds.left, y - bounds.top, [230, 0, 0, level(visual.heatGap[p] ?? 0)]);
        if ((visual.heatOverlap[p] ?? 0) > 0) view.blend(x - bounds.left, y - bounds.top, [0, 60, 230, level(visual.heatOverlap[p] ?? 0)]);
        if ((visual.heatSeam[p] ?? 0) > 0) view.blend(x - bounds.left, y - bounds.top, [255, 160, 0, level(visual.heatSeam[p] ?? 0)]);
      }
    }
    return titled(scaled(view, 2), label(variantId), ['all tests, method B']);
  });
  add('4-problem-heatmaps.png', titled(sheetOf([heat], 12), 'L0-1g problems over all tests: gap (red), protrusion or unwanted overlap (blue), visible seam (orange)'));
  const differenceRows = visualIds.map((variantId) => {
    const visual = visuals.get(variantId) as Visual;
    const report = variantReports.find((item) => item.id === variantId) as { sourcePose: { differentPixels: number; maxChannelDifference: number } };
    return specs.map((spec, index) => {
      const box = boxAround([spec.cut.joint], Math.ceil((regions[index]?.wideRadius ?? 30) * 1.6), width, height);
      const view = onColor(crop(reference, box), white);
      for (let y = box.top; y < box.bottom; y += 1)
        for (let x = box.left; x < box.right; x += 1) if (visual.sourceDifference[y * width + x] === 1) view.blend(x - box.left, y - box.top, [255, 0, 0, 255]);
      return titled(scaled(view, 4), `${label(variantId)} ${spec.id}`, [`source pose: ${report.sourcePose.differentPixels} px differ, max ${report.sourcePose.maxChannelDifference}`]);
    });
  });
  add('5-source-pose-difference.png', titled(sheetOf(differenceRows, 8), 'L0-1g source pose against the layer composite (red = different pixel)'));

  const status = invariantsHold ? 'PASS' : 'FAIL';
  const report = {
    format: geometryFormat,
    tool: { name: '@aigg/control', version: options.toolVersion, command: 'geometry-study' },
    prototype: true,
    status: {
      invariants: status,
      scope:
        'Source pixels unchanged, new pixels only in the diagnostic region, no frame change outside the moved new pixels, baseline source pose equal to the layer composite (also with shifted marks). Not art quality.'
    },
    note: 'Diagnostic prototype of experiment L0-1g. Regions B and C are research alternatives, not a change of the C0.5 overlap rule. Not a Spine result.',
    inputs: { imageSha256: context.imageSha, manualLandmarksSha256: context.landmarkSha, similarityScaleImageToTemplate: context.scale, layers: context.inputs },
    rules: {
      circle: 'A: the L0-1f region (C0.5 radius 24 template px / similarity scale, not rounded).',
      wideCircle: 'B: the same rule with the radius equal to the largest cross-section extent from the joint mark (not smaller than the C0.5 radius).',
      tube: 'C: child side of the cut, depth along the cut normal <= C0.5 radius, the point 1 px inside the parent back along the parent axis is a parent pixel inside the cross-section.',
      occlusionSafe: 'Variants "_safe": only region pixels where the child is fully opaque in the source pose.',
      methods: 'A = nearest_edge, B = directional (L0-1f, no change).',
      provenance: provenanceTag,
      metrics:
        'The L0-1e renderer and metrics without change. Sums and worst values per joint over the tests where that joint or both joints turn. unwantedOverlapNearCirclePixels: unwanted overlap within 1.5 px outside the C0.5 circle (a resampling effect). Fewer gap pixels do not prove better art.',
      angles: 'Group l0_1e: the L0-1e angles. Group extended: additional diagnostic angles, not animation limits.'
    },
    regions: specs.map((spec, index) => {
      const jointRegions = regions[index] as JointRegions;
      return {
        joint: spec.id,
        c05RadiusImagePx: spec.radius,
        wideRadiusImagePx: jointRegions.wideRadius,
        tubeDepthImagePx: jointRegions.depth,
        crossSection: sections[index],
        pixels: Object.fromEntries(regionKinds.map((kind) => [kind, { full: jointRegions.kind[kind].regionPixels, occlusionSafe: jointRegions.safe[kind].regionPixels }]))
      };
    }),
    baseline: baselineGroups.map((group) => ({ group: group.group, joints: group.joints })),
    variants: variantReports,
    sensitivity,
    files: records
  };
  files.push({ name: 'metrics.json', bytes: json(report) });
  return {
    report: {
      format: geometryFormat,
      status,
      variants: variantReports.map((item) => ({ id: item.id, sourcePose: item.sourcePose, groups: item.groups })),
      files: files.length
    },
    files
  };
}
