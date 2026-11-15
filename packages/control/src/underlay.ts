import type { Affine } from '@control/align';
import { type CommandResult, type FileRecord, json, record, sheetOf } from '@control/commands';
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
  partNames,
  prepareLimb,
  ring,
  round,
  scaled,
  sub,
  titled,
  transformPart,
  unit,
  type Vector
} from '@control/limbstudy';
import type { PlannedFile } from '@control/output';
import { encodePng, pixelHash } from '@control/png';
import { type Color, Raster } from '@control/raster';

// `underlay-study` (experiment L0-1f, prototype): makes the missing parent underlay at the elbow and the wrist of the near arm with two
// deterministic raster methods, then runs the L0-1e rotation tests and metrics again. New pixels are made only inside the underlay region of
// each joint, and only where the parent has no pixel. Source pixels are not changed. Child pixels are not copied into the parent.
// No model, no random values, no network.

export const underlayFormat = 'aigg.l0-1f.underlay-study/0.1';
export const provenanceTag = 'generated_by_deterministic_extension';

/** Depth of the parent edge band (px before the cut line) that method A searches for the nearest pixel. */
export const edgeBandPx = 3;
/** Method B: the sample at the cut is this far inside the parent (px). */
export const innerOffsetPx = 1;
/** Method B: distance between the two samples along the axis that give the gradient (px). */
export const gradientSpanPx = 6;
/** Method B: a larger RGB step between the two samples is an edge (outline, band), not shading. Then the color is constant. */
export const edgeStepLimit = 64;

export type UnderlayMethod = 'nearest_edge' | 'directional';
export const underlayMethods: readonly UnderlayMethod[] = ['nearest_edge', 'directional'];

export type UnderlayRegion = {
  /** Pixels where new parent pixels are permitted: child side of the cut, inside the overlap circle, inside the parent cross-section. */
  readonly region: Uint8Array;
  readonly regionPixels: number;
};

/** The underlay region of a joint: d >= 0 (child side), distance to the pivot <= radius, and -extentNegative <= t <= extentPositive along the cut line. */
export function underlayRegion(parent: Raster, cut: Cut, extents: { extentNegativePx: number; extentPositivePx: number }, radius: number): UnderlayRegion {
  const { width, height } = parent;
  const region = new Uint8Array(width * height);
  const along = { x: -cut.normal.y, y: cut.normal.x };
  let regionPixels = 0;
  const reach = Math.ceil(radius) + 1;
  for (let y = Math.max(0, Math.floor(cut.joint.y - reach)); y <= Math.min(height - 1, Math.ceil(cut.joint.y + reach)); y += 1) {
    for (let x = Math.max(0, Math.floor(cut.joint.x - reach)); x <= Math.min(width - 1, Math.ceil(cut.joint.x + reach)); x += 1) {
      const p = y * width + x;
      if ((parent.data[p * 4 + 3] ?? 0) > 0) continue;
      const v = sub(center(p, width), cut.joint);
      const d = dot(v, cut.normal);
      const t = dot(v, along);
      if (d < 0 || Math.hypot(v.x, v.y) > radius || t < -extents.extentNegativePx || t > extents.extentPositivePx) continue;
      region[p] = 1;
      regionPixels += 1;
    }
  }
  return { region, regionPixels };
}

export type ProvenanceEntry = { readonly x: number; readonly y: number; readonly sourceX: number; readonly sourceY: number; readonly rule: string };

export type UnderlayFill = {
  /** New pixels only (RGBA, straight alpha). Transparent elsewhere. */
  readonly pixels: Raster;
  readonly newMask: Uint8Array;
  readonly unresolved: Uint8Array;
  readonly outsideContour: Uint8Array;
  readonly provenance: readonly ProvenanceEntry[];
  readonly counts: { readonly newPixels: number; readonly unresolvedPixels: number; readonly outsideContourPixels: number; readonly gradientPixels: number; readonly constantPixels: number };
};

const at = (raster: Raster, x: number, y: number): [number, number, number, number] => raster.pixel(x, y) as [number, number, number, number];

/**
 * Method A, nearest edge: each region pixel copies the RGBA of the nearest parent pixel (alpha > 0) in the edge band (the last
 * `edgeBandPx` px before the cut line). Ties go to the lower pixel index. No new color is made: each new pixel is a copy of one parent pixel.
 * A region pixel with no source within the overlap radius is unresolved.
 */
export function nearestEdgeFill(parent: Raster, cut: Cut, region: Uint8Array, radius: number): UnderlayFill {
  const { width } = parent;
  const sources: number[] = [];
  const reach = Math.ceil(radius) + edgeBandPx + 2;
  for (let y = Math.max(0, Math.floor(cut.joint.y - reach)); y <= Math.min(parent.height - 1, Math.ceil(cut.joint.y + reach)); y += 1) {
    for (let x = Math.max(0, Math.floor(cut.joint.x - reach)); x <= Math.min(width - 1, Math.ceil(cut.joint.x + reach)); x += 1) {
      const p = y * width + x;
      if ((parent.data[p * 4 + 3] ?? 0) === 0) continue;
      const d = dot(sub(center(p, width), cut.joint), cut.normal);
      if (d < 0 && d >= -edgeBandPx) sources.push(p);
    }
  }
  const pixels = new Raster(parent.width, parent.height);
  const newMask = new Uint8Array(region.length);
  const unresolved = new Uint8Array(region.length);
  const provenance: ProvenanceEntry[] = [];
  let newPixels = 0;
  let unresolvedPixels = 0;
  for (let p = 0; p < region.length; p += 1) {
    if (region[p] !== 1) continue;
    const c = center(p, width);
    let best = -1;
    let bestDistance = Infinity;
    for (const source of sources) {
      const s = center(source, width);
      const distance = Math.hypot(s.x - c.x, s.y - c.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = source;
      }
    }
    if (best < 0 || bestDistance > radius) {
      unresolved[p] = 1;
      unresolvedPixels += 1;
      continue;
    }
    pixels.data.set(parent.data.subarray(best * 4, best * 4 + 4), p * 4);
    newMask[p] = 1;
    newPixels += 1;
    provenance.push({ x: p % width, y: Math.floor(p / width), sourceX: best % width, sourceY: Math.floor(best / width), rule: 'nearest_edge_copy' });
  }
  return {
    pixels,
    newMask,
    unresolved,
    outsideContour: new Uint8Array(region.length),
    provenance,
    counts: { newPixels, unresolvedPixels, outsideContourPixels: 0, gradientPixels: 0, constantPixels: newPixels }
  };
}

/**
 * Method B, directional: each region pixel q goes back along the parent axis to the point q0 that is `innerOffsetPx` inside the parent.
 * - q0 has no parent pixel: when the child has a pixel at q (the limb continues there), q is unresolved; else q is outside the contour.
 * - q0 and q1 (`gradientSpanPx` farther back) are both opaque and their step is at most `edgeStepLimit`: the color continues the gradient
 *   (q0 + (q0 - q1) * distance / span), and the change is not larger than the step between the samples. Alpha is the q0 alpha (255).
 * - Else (an outline, a band edge, or a partly transparent edge pixel): q copies q0 (RGBA). So no color mixes with transparent pixels.
 */
export function directionalFill(parent: Raster, child: Raster, cut: Cut, axis: Vector, region: Uint8Array): UnderlayFill {
  const { width } = parent;
  const pixels = new Raster(parent.width, parent.height);
  const newMask = new Uint8Array(region.length);
  const unresolved = new Uint8Array(region.length);
  const outsideContour = new Uint8Array(region.length);
  const provenance: ProvenanceEntry[] = [];
  let newPixels = 0;
  let unresolvedPixels = 0;
  let outsideContourPixels = 0;
  let gradientPixels = 0;
  let constantPixels = 0;
  const cosine = dot(axis, cut.normal);
  for (let p = 0; p < region.length; p += 1) {
    if (region[p] !== 1) continue;
    const q = center(p, width);
    const back = cosine > 0.05 ? (dot(sub(q, cut.joint), cut.normal) + innerOffsetPx) / cosine : -1;
    const q0 = { x: q.x - back * axis.x, y: q.y - back * axis.y };
    const x0 = Math.floor(q0.x);
    const y0 = Math.floor(q0.y);
    const c0 = at(parent, x0, y0);
    if (back < 0 || c0[3] === 0) {
      if ((child.data[p * 4 + 3] ?? 0) > 0) {
        unresolved[p] = 1;
        unresolvedPixels += 1;
      } else {
        outsideContour[p] = 1;
        outsideContourPixels += 1;
      }
      continue;
    }
    const c1 = at(parent, Math.floor(q0.x - gradientSpanPx * axis.x), Math.floor(q0.y - gradientSpanPx * axis.y));
    const step = Math.max(Math.abs(c0[0] - c1[0]), Math.abs(c0[1] - c1[1]), Math.abs(c0[2] - c1[2]));
    let color: [number, number, number, number];
    let rule: string;
    if (c0[3] === 255 && c1[3] === 255 && step <= edgeStepLimit) {
      const k = back / gradientSpanPx;
      const channel = (index: 0 | 1 | 2): number => {
        const delta = c0[index] - c1[index];
        const change = Math.max(-Math.abs(delta), Math.min(Math.abs(delta), delta * k));
        return Math.max(0, Math.min(255, Math.round(c0[index] + change)));
      };
      color = [channel(0), channel(1), channel(2), 255];
      rule = 'directional_gradient';
      gradientPixels += 1;
    } else {
      color = [c0[0], c0[1], c0[2], c0[3]];
      rule = 'directional_copy';
      constantPixels += 1;
    }
    pixels.data.set(color, p * 4);
    newMask[p] = 1;
    newPixels += 1;
    provenance.push({ x: p % width, y: Math.floor(p / width), sourceX: x0, sourceY: y0, rule });
  }
  return { pixels, newMask, unresolved, outsideContour, provenance, counts: { newPixels, unresolvedPixels, outsideContourPixels, gradientPixels, constantPixels } };
}

/** Adds new pixels to a part where the part has no pixel. Returns the new part and the number of source pixels that changed (must be 0). */
export function withUnderlay(part: Raster, fills: readonly UnderlayFill[]): { part: Raster; changedSourcePixels: number } {
  const out = new Raster(part.width, part.height);
  out.data.set(part.data);
  for (const fill of fills) {
    for (let p = 0; p < fill.newMask.length; p += 1) {
      if (fill.newMask[p] !== 1 || (out.data[p * 4 + 3] ?? 0) > 0) continue;
      out.data.set(fill.pixels.data.subarray(p * 4, p * 4 + 4), p * 4);
    }
  }
  let changedSourcePixels = 0;
  for (let p = 0; p < part.width * part.height; p += 1) {
    if ((part.data[p * 4 + 3] ?? 0) === 0) continue;
    for (let c = 0; c < 4; c += 1) {
      if (out.data[p * 4 + c] !== part.data[p * 4 + c]) {
        changedSourcePixels += 1;
        break;
      }
    }
  }
  return { part: out, changedSourcePixels };
}

// Images.
const magenta: Color = [255, 0, 255, 255];
const white: Color = [255, 255, 255, 255];
const black: Color = [0, 0, 0, 255];
const newColor: Color = [0, 200, 60, 255];
const unresolvedColor: Color = [230, 0, 0, 255];
const outsideColor: Color = [160, 160, 160, 255];
const gapColor: Color = [230, 0, 0, 255];

function onColor(source: Raster, color: Color): Raster {
  const out = new Raster(source.width, source.height, color);
  out.draw(source, 0, 0);
  return out;
}

function armOnly(placed: readonly Raster[], residual: Raster): Raster {
  const out = new Raster(residual.width, residual.height);
  out.draw(residual, 0, 0);
  for (const part of placed) out.draw(part, 0, 0);
  return out;
}

type Variant = { readonly id: 'baseline' | UnderlayMethod; readonly parts: readonly Raster[]; readonly evaluation: Evaluation; readonly newMasks: readonly Uint8Array[] };

/** Pixels of the final frame that the new pixels change, and the changed pixels outside the moved new-pixel masks (must be 0). */
function frameChange(baseline: Raster, frame: Raster, movedNew: Uint8Array): { changed: number; outside: number } {
  let changed = 0;
  let outside = 0;
  for (let p = 0; p < movedNew.length; p += 1) {
    const i = p * 4;
    if (baseline.data[i] === frame.data[i] && baseline.data[i + 1] === frame.data[i + 1] && baseline.data[i + 2] === frame.data[i + 2] && baseline.data[i + 3] === frame.data[i + 3]) continue;
    changed += 1;
    if (movedNew[p] !== 1) outside += 1;
  }
  return { changed, outside };
}

function maskRaster(mask: Uint8Array, width: number, height: number): Raster {
  const out = new Raster(width, height);
  for (let p = 0; p < mask.length; p += 1) if (mask[p] === 1) out.data.set(white, p * 4);
  return out;
}

/** `underlay-study`: experiment L0-1f for the image-left (near) arm. */
export function underlayStudyCommand(options: LimbStudyOptions): CommandResult {
  const context: LimbContext = prepareLimb(options);
  const { width, height, parts, specs, sections, cut, elbow, wrist, shoulder, residual, reference, silhouette, image } = context;
  const axes: Vector[] = [unit(sub(elbow, shoulder)), unit(sub(wrist, elbow))];
  const regions = specs.map((spec, index) => underlayRegion(parts[spec.parent - 1] as Raster, spec.cut, sections[index] as { extentNegativePx: number; extentPositivePx: number }, spec.radius));
  const baseline = evaluateRotations(context, parts);
  const variants: Variant[] = [{ id: 'baseline', parts, evaluation: baseline, newMasks: parts.map(() => new Uint8Array(width * height)) }];
  const fillReports: Record<string, unknown>[] = [];
  const provenance: Record<string, unknown>[] = [];
  const fillsOf = new Map<UnderlayMethod, UnderlayFill[]>();
  for (const method of underlayMethods) {
    const fills = specs.map((spec, index) => {
      const parent = parts[spec.parent - 1] as Raster;
      const child = parts[spec.child - 1] as Raster;
      const region = (regions[index] as UnderlayRegion).region;
      return method === 'nearest_edge' ? nearestEdgeFill(parent, spec.cut, region, spec.radius) : directionalFill(parent, child, spec.cut, axes[index] as Vector, region);
    });
    fillsOf.set(method, fills);
    const newParts = parts.map((part, index) => {
      const own = fills.filter((_, joint) => (specs[joint]?.parent ?? 0) - 1 === index);
      return withUnderlay(part, own);
    });
    const newMasks = parts.map((_, index) => {
      const mask = new Uint8Array(width * height);
      fills.forEach((fill, joint) => {
        if ((specs[joint]?.parent ?? 0) - 1 !== index) return;
        for (let p = 0; p < mask.length; p += 1) if (fill.newMask[p] === 1) mask[p] = 1;
      });
      return mask;
    });
    let outsideRegion = 0;
    fills.forEach((fill, joint) => {
      const region = (regions[joint] as UnderlayRegion).region;
      for (let p = 0; p < region.length; p += 1) if (fill.newMask[p] === 1 && region[p] !== 1) outsideRegion += 1;
    });
    const evaluation = evaluateRotations(
      context,
      newParts.map((item) => item.part)
    );
    variants.push({ id: method, parts: newParts.map((item) => item.part), evaluation, newMasks });
    fillReports.push({
      method,
      joints: fills.map((fill, joint) => ({ joint: specs[joint]?.id, parent: partNames[(specs[joint]?.parent ?? 1) - 1], regionPixels: regions[joint]?.regionPixels, ...fill.counts })),
      newPixelsOutsideRegions: outsideRegion,
      changedSourcePixels: newParts.reduce((sum, item) => sum + item.changedSourcePixels, 0),
      partPixelSha256: newParts.map((item) => pixelHash(item.part))
    });
    fills.forEach((fill, joint) => {
      provenance.push({
        method,
        joint: specs[joint]?.id,
        provenance: provenanceTag,
        columns: ['x', 'y', 'sourceX', 'sourceY', 'rule'],
        pixels: fill.provenance.map((entry) => [entry.x, entry.y, entry.sourceX, entry.sourceY, entry.rule]),
        unresolved: [...fill.unresolved.entries()].filter(([, v]) => v === 1).map(([p]) => [p % width, Math.floor(p / width)])
      });
    });
  }

  // Comparison per test: the L0-1e metrics for each variant, the frame change, and the neutral pose.
  const comparison = baseline.tests.map((test, testIndex) => ({
    id: test.id,
    elbowDegrees: test.elbowDegrees,
    wristDegrees: test.wristDegrees,
    variants: variants.map((variant) => {
      const row = variant.evaluation.tests[testIndex];
      const rendered = variant.evaluation.rendered[testIndex];
      const transforms = rendered?.placed.transforms ?? [];
      const movedNew = new Uint8Array(width * height);
      variant.newMasks.forEach((mask, index) => {
        const moved = transformPart(maskRaster(mask, width, height), transforms[index] as Affine);
        for (let p = 0; p < movedNew.length; p += 1) if ((moved.data[p * 4 + 3] ?? 0) > 0) movedNew[p] = 1;
      });
      const change = variant.id === 'baseline' ? { changed: 0, outside: 0 } : frameChange(baseline.rendered[testIndex]?.frame as Raster, rendered?.frame as Raster, movedNew);
      return {
        variant: variant.id,
        joints: (row?.joints ?? []).map((joint) => ({
          joint: joint.joint,
          gapPixels: joint.gapPixels,
          protrusionPixels: joint.protrusionPixels,
          unwantedOverlapPixels: joint.unwantedOverlapPixels,
          visibleSeamPixels: joint.visibleSeamPixels,
          exposedCutEdgePixels: joint.exposedCutEdgePixels,
          meanDifferenceAcrossCut: joint.meanDifferenceAcrossCut
        })),
        problemPixels: row?.problemPixels ?? 0,
        framePixelsChangedByNewPixels: change.changed,
        changedFramePixelsOutsideMovedNewPixels: change.outside
      };
    })
  }));
  const neutral = variants.map((variant) => {
    const frame = variant.evaluation.rendered[0]?.frame as Raster;
    let pixels = 0;
    let maxDifference = 0;
    for (let p = 0; p < width * height; p += 1) {
      let d = 0;
      for (let c = 0; c < 4; c += 1) d = Math.max(d, Math.abs((frame.data[p * 4 + c] ?? 0) - (reference.data[p * 4 + c] ?? 0)));
      if (d > 0) pixels += 1;
      maxDifference = Math.max(maxDifference, d);
    }
    return { variant: variant.id, differentPixels: pixels, maxChannelDifference: maxDifference };
  });
  const totals = variants.map((variant) => ({
    variant: variant.id,
    jointSummary: variant.evaluation.jointSummary.map((item) => ({
      joint: item.joint,
      worstGapPixels: item.worstGapPixels,
      worstProtrusionPixels: item.worstProtrusionPixels,
      worstUnwantedOverlapPixels: item.worstUnwantedOverlapPixels,
      worstVisibleSeamPixels: item.worstVisibleSeamPixels,
      gapUnionPixels: item.gapUnionPixels
    })),
    gapPixelsAllTests: variant.evaluation.tests.reduce((sum, test) => sum + test.joints.reduce((s, joint) => s + joint.gapPixels, 0), 0),
    visibleSeamPixelsAllTests: variant.evaluation.tests.reduce((sum, test) => sum + test.joints.reduce((s, joint) => s + joint.visibleSeamPixels, 0), 0),
    problemPixelsAllTests: variant.evaluation.tests.reduce((sum, test) => sum + test.problemPixels, 0)
  }));

  // Images.
  const bounds = boxAround([...maskPoints(baseline.coverUnion, width), ...maskPoints(silhouette, width)], 24, width, height);
  const files: PlannedFile[] = [];
  const records: FileRecord[] = [];
  const add = (name: string, raster: Raster): void => {
    const file = { name, bytes: encodePng(raster) };
    files.push(file);
    records.push(record(file, raster));
  };
  const labelOf = (id: string): string => (id === 'baseline' ? 'baseline L0-1e' : id === 'nearest_edge' ? 'A nearest edge' : 'B directional');

  // Parts with underlay and new-pixel masks.
  for (const variant of variants.slice(1)) {
    variant.parts.forEach((part, index) => {
      if (count(variant.newMasks[index] as Uint8Array) > 0) add(`${variant.id}/parts/${partNames[index] ?? 'part'}.png`, part);
    });
  }
  const maskPanels = variants.slice(1).map((variant, methodIndex) => {
    const view = onColor(crop(armOnly(parts, residual), bounds), white);
    const fade = new Raster(view.width, view.height, [255, 255, 255, 140]);
    view.draw(fade, 0, 0);
    const paint = (mask: Uint8Array, color: Color): void => {
      for (let y = bounds.top; y < bounds.bottom; y += 1) for (let x = bounds.left; x < bounds.right; x += 1) if (mask[y * width + x] === 1) view.blend(x - bounds.left, y - bounds.top, color);
    };
    regions.forEach((item) => {
      paint(item.region, [120, 120, 255, 90]);
    });
    const fills = fillsOf.get(variant.id as UnderlayMethod) ?? [];
    specs.forEach((spec, joint) => {
      paint(variant.newMasks[spec.parent - 1] as Uint8Array, newColor);
      paint(fills[joint]?.unresolved ?? new Uint8Array(0), unresolvedColor);
      paint(fills[joint]?.outsideContour ?? new Uint8Array(0), outsideColor);
      ring(view, { x: spec.cut.joint.x - bounds.left, y: spec.cut.joint.y - bounds.top }, spec.radius, black, 1);
    });
    const report = fillReports[methodIndex] as { joints: { joint: string; newPixels: number; unresolvedPixels: number; outsideContourPixels: number }[] };
    return titled(
      scaled(view, 2),
      `${labelOf(variant.id)}: new pixels`,
      report.joints.map((joint) => `${joint.joint}: new ${joint.newPixels}, unresolved ${joint.unresolvedPixels}, outside contour ${joint.outsideContourPixels}`)
    );
  });
  add('1-new-pixel-masks.png', titled(sheetOf([maskPanels], 12), 'L0-1f new pixels (green), unresolved (red), outside contour (grey), allowed region (blue), overlap circle (black)', [provenanceTag]));

  // Side-by-side comparisons: on the body (white outside) and the arm alone on magenta.
  const rows = baseline.tests.map((test, testIndex) =>
    variants.map((variant) => {
      const frame = variant.evaluation.rendered[testIndex]?.frame as Raster;
      const row = comparison[testIndex]?.variants.find((item) => item.variant === variant.id);
      return titled(onColor(crop(frame, bounds), white), `${test.id} ${labelOf(variant.id)}`, [
        (row?.joints ?? []).map((joint) => `${joint.joint} gap ${joint.gapPixels} seam ${joint.visibleSeamPixels}`).join(', ')
      ]);
    })
  );
  add('2-comparison-on-body.png', titled(sheetOf(rows, 10), 'L0-1f same angles as L0-1e: baseline, A nearest edge, B directional', ['positive = clockwise on screen']));
  const contrastRows = baseline.tests.map((test, testIndex) =>
    variants.map((variant) => {
      const rendered = variant.evaluation.rendered[testIndex];
      return titled(onColor(crop(armOnly(rendered?.placed.parts ?? [], residual), bounds), magenta), `${test.id} ${labelOf(variant.id)}`);
    })
  );
  add('3-comparison-on-magenta.png', titled(sheetOf(contrastRows, 10), 'L0-1f arm only on an opaque magenta background', ['holes and halos show as magenta or as wrong colors at the edge']));
  for (const variant of variants.slice(1)) {
    variant.evaluation.rendered.forEach((rendered) => {
      add(`${variant.id}/rotations/${rendered.test.id}/result.png`, onColor(crop(rendered.frame, bounds), white));
      add(`${variant.id}/rotations/${rendered.test.id}/arm-on-magenta.png`, onColor(crop(armOnly(rendered.placed.parts, residual), bounds), magenta));
    });
  }

  // Heatmaps of the problems that remain.
  const heat = variants.map((variant) => {
    const view = onColor(crop(image, bounds), white);
    const fade = new Raster(view.width, view.height, [255, 255, 255, 180]);
    view.draw(fade, 0, 0);
    const { heatGap, heatOverlap } = variant.evaluation;
    const seams = new Uint16Array(width * height);
    for (const rendered of variant.evaluation.rendered) for (const joint of rendered.joints) for (let p = 0; p < seams.length; p += 1) if (joint.seam.seam[p] === 1) seams[p] = (seams[p] ?? 0) + 1;
    for (let y = bounds.top; y < bounds.bottom; y += 1) {
      for (let x = bounds.left; x < bounds.right; x += 1) {
        const p = y * width + x;
        if ((heatGap[p] ?? 0) > 0) view.blend(x - bounds.left, y - bounds.top, [gapColor[0], gapColor[1], gapColor[2], Math.min(255, 90 + 40 * (heatGap[p] ?? 0))]);
        if ((heatOverlap[p] ?? 0) > 0) view.blend(x - bounds.left, y - bounds.top, [0, 60, 230, Math.min(255, 90 + 40 * (heatOverlap[p] ?? 0))]);
        if ((seams[p] ?? 0) > 0) view.blend(x - bounds.left, y - bounds.top, [255, 160, 0, Math.min(255, 90 + 40 * (seams[p] ?? 0))]);
      }
    }
    const total = totals.find((item) => item.variant === variant.id);
    return titled(scaled(view, 2), labelOf(variant.id), [
      `gap ${total?.gapPixelsAllTests ?? 0}, seam ${total?.visibleSeamPixelsAllTests ?? 0}, problems ${total?.problemPixelsAllTests ?? 0} (all tests)`
    ]);
  });
  add('4-problem-heatmaps.png', titled(sheetOf([heat], 12), 'L0-1f problems over all tests: gap (red), protrusion or unwanted overlap (blue), visible seam (orange)'));

  // Zoomed joints.
  const zoomTests: Record<'elbow' | 'wrist', string[]> = { elbow: ['source', 'elbow-15', 'elbow+15', 'elbow-30', 'elbow+30'], wrist: ['source', 'wrist-15', 'wrist+15', 'elbow+10_wrist+10'] };
  specs.forEach((spec) => {
    const ids = zoomTests[spec.id];
    const zoomRows = ids.map((id) => {
      const testIndex = baseline.tests.findIndex((test) => test.id === id);
      return variants.flatMap((variant) => {
        const rendered = variant.evaluation.rendered[testIndex];
        const pivot = spec.id === 'elbow' ? elbow : (rendered?.joints[1]?.pivot ?? wrist);
        const box = boxAround([pivot], Math.ceil(spec.radius * 2.2), width, height);
        const body = scaled(onColor(crop(rendered?.frame as Raster, box), white), 4);
        const contrast = scaled(onColor(crop(armOnly(rendered?.placed.parts ?? [], residual), box), magenta), 4);
        return [titled(body, `${id} ${labelOf(variant.id)}`), titled(contrast, 'arm on magenta')];
      });
    });
    add(`5-zoom-${spec.id}.png`, titled(sheetOf(zoomRows, 8), `L0-1f ${spec.id}, 4x: baseline, A, B (each on the body and on magenta)`));
  });

  // Source pose: input, baseline, A, B on white and magenta.
  add(
    '6-source-pose.png',
    sheetOf(
      [
        [
          titled(onColor(crop(reference, bounds), white), 'layers (source)'),
          ...variants.map((variant) => titled(onColor(crop(variant.evaluation.rendered[0]?.frame as Raster, bounds), white), `source pose ${labelOf(variant.id)}`))
        ],
        [
          titled(onColor(crop(armOnly(parts, residual), bounds), magenta), 'arm (source)'),
          ...variants.map((variant) => titled(onColor(crop(armOnly(variant.parts, residual), bounds), magenta), labelOf(variant.id)))
        ]
      ],
      12
    )
  );

  // The status covers only the L0-1f invariants. It does not measure art quality and does not make the parts ready for Spine.
  const invariantsHold =
    fillReports.every((item) => item.newPixelsOutsideRegions === 0 && item.changedSourcePixels === 0) &&
    comparison.every((test) => test.variants.every((variant) => variant.changedFramePixelsOutsideMovedNewPixels === 0)) &&
    neutral[0]?.differentPixels === 0;
  const status = invariantsHold ? 'PASS' : 'FAIL';
  const report = {
    format: underlayFormat,
    tool: { name: '@aigg/control', version: options.toolVersion, command: 'underlay-study' },
    prototype: true,
    status: { invariants: status, scope: 'Source pixels unchanged, new pixels only in the regions, no frame change outside the moved new pixels, baseline equal to L0-1e. Not art quality.' },
    note: 'Diagnostic prototype of experiment L0-1f. New pixels are made only inside the underlay regions and are tagged generated_by_deterministic_extension. Not a Spine result.',
    inputs: {
      imageSha256: context.imageSha,
      manualLandmarksSha256: context.landmarkSha,
      similarityScaleImageToTemplate: context.scale,
      layers: context.inputs
    },
    rules: {
      region:
        'Child side of the cut line, distance to the joint mark <= overlap radius (24 template px / similarity scale, not rounded), inside the source cross-section of the arm along the cut line, and only where the parent has no pixel.',
      nearestEdge: `Copy of the nearest parent pixel (alpha > 0) within ${edgeBandPx} px before the cut line. Ties: lower pixel index. Unresolved when no source is within the overlap radius.`,
      directional: `Back along the parent axis to ${innerOffsetPx} px inside the parent. Gradient from two opaque samples ${gradientSpanPx} px apart when their RGB step <= ${edgeStepLimit}, limited to that step; else a copy of the first sample. No sample: unresolved inside the child silhouette, else outside the contour (no pixel).`,
      alpha: 'Colors are only computed between fully opaque samples. Partly transparent pixels are copied with their RGBA, so no color mixes with transparent black.',
      drawOrder: 'The underlay belongs to the parent part, so it is drawn under the child (C0.5 draw order 22, 23, 25).',
      metrics: 'The L0-1e renderer and metrics without change (gap, protrusion, unwanted overlap, seam). Fewer gap pixels do not prove better art: a wrong texture can close a gap and look worse.'
    },
    regions: specs.map((spec, index) => ({
      joint: spec.id,
      parent: partNames[spec.parent - 1],
      radiusImagePx: spec.radius,
      regionPixels: regions[index]?.regionPixels,
      axisDegrees: round((Math.atan2(axes[index]?.y ?? 0, axes[index]?.x ?? 0) * 180) / Math.PI, 1)
    })),
    cutNormals: [cut.elbow.normal, cut.wrist.normal].map((n) => ({ x: round(n.x, 4), y: round(n.y, 4) })),
    fills: fillReports,
    neutralPose: neutral,
    totals,
    comparison,
    files: records
  };
  files.push({ name: 'metrics.json', bytes: json(report) });
  files.push({ name: 'provenance.json', bytes: json({ format: `${underlayFormat}.provenance`, provenance: provenanceTag, entries: provenance }) });
  return {
    report: {
      format: underlayFormat,
      status,
      fills: fillReports.map((item) => ({ method: item.method, joints: item.joints, newPixelsOutsideRegions: item.newPixelsOutsideRegions, changedSourcePixels: item.changedSourcePixels })),
      neutralPose: neutral,
      totals: totals.map((item) => ({ variant: item.variant, gap: item.gapPixelsAllTests, seam: item.visibleSeamPixelsAllTests, problems: item.problemPixelsAllTests })),
      files: files.length
    },
    files
  };
}
