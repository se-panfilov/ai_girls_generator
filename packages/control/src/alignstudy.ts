import { type Affine, angleDifference, applyAffine, decompose, directionDegrees, fitAffine, fitBend, fitSimilarity, fitUniform, triangleAffine } from '@control/align';
import { type CommandResult, type FileRecord, json, parseContractBytes, record, sheetOf, toolName } from '@control/commands';
import type { ControlContract, Joint } from '@control/contract';
import { renderMannequin } from '@control/figure';
import { drawText } from '@control/glyphs';
import { composite, drawOrder, half, layerPngLimits, parseSeeThroughMetadata } from '@control/layersplit';
import type { PlannedFile } from '@control/output';
import { decodePng, encodePng, pixelHash, sha256 } from '@control/png';
import { rigPose } from '@control/pose';
import { fail, isRecord, show } from '@control/problems';
import { type Color, Raster } from '@control/raster';
import { alphaMask, defaultSplitOptions, extractLabel, labelComponents, maskBounds, splitLayer } from '@control/split';

// `align-study` (experiment L0-1c, prototype): anatomical landmarks of a See-through character and their alignment with the C0.5 template.
// The command reads the inputs only. It does not change or warp the art. All results are diagnostic.
// Rules: an unknown landmark has no coordinates (only a range, or nothing). Measured and inferred values stay separate.
// Side names are image sides. The near and far mapping is a hypothesis that the report tests in both directions.

export const landmarkFormat = 'aigg.l0-1c.landmarks/0.1';
export const alignFormat = 'aigg.l0-1c.align-study/0.1';
export const maxLandmarkBytes = 256 * 1024;

export type Visibility = 'visible' | 'occluded' | 'inferred' | 'unknown';
export type LandmarkConfidence = 'high' | 'medium' | 'low' | 'none';
export type Range = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
export type Landmark = {
  readonly id: string;
  readonly point: Joint | null;
  readonly range: Range | null;
  readonly visibility: Visibility;
  readonly confidence: LandmarkConfidence;
  readonly method: string;
  readonly sourceLayers: readonly string[];
  readonly note: string;
  readonly origin: 'automatic' | 'manual';
};

type Side = 'image_left' | 'image_right';
const sides: readonly Side[] = ['image_left', 'image_right'];

/** Landmark ids. Paired ids end with the image side. */
export const landmarkIds = [
  'head_top',
  'head_center',
  'chin',
  'nose',
  'mouth',
  'eye_image_left',
  'eye_image_right',
  'neck_base',
  'torso_front_mark',
  ...(['shoulder', 'sleeve_end', 'elbow', 'wrist', 'hip', 'knee', 'ankle', 'foot_anchor'] as const).flatMap((name) => sides.map((side) => `${name}_${side}`))
] as const;

const round1 = (value: number): number => Math.round(value * 10) / 10;
const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const pointOf = (x: number, y: number): Joint => ({ x: round1(x), y: round1(y) });

// ---------- landmark helpers ----------

function landmark(id: string, fields: Omit<Landmark, 'id' | 'origin'>): Landmark {
  if (fields.visibility === 'unknown' && fields.point !== null) throw new RangeError(`An unknown landmark (${id}) cannot have a point.`);
  if (fields.visibility !== 'unknown' && fields.point === null) throw new RangeError(`A ${fields.visibility} landmark (${id}) needs a point.`);
  return { id, origin: 'automatic', ...fields };
}

const unknown = (id: string, range: Range | null, method: string, sourceLayers: readonly string[], note: string): Landmark =>
  landmark(id, { point: null, range, visibility: 'unknown', confidence: 'none', method, sourceLayers, note });

function centroid(mask: Uint8Array, width: number, rows?: { from: number; to: number }): Joint | null {
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (let p = 0; p < mask.length; p += 1) {
    if (mask[p] === 0) continue;
    const x = p % width;
    const y = (p - x) / width;
    if (rows && (y < rows.from || y >= rows.to)) continue;
    sx += x + 0.5;
    sy += y + 0.5;
    count += 1;
  }
  return count === 0 ? null : { x: sx / count, y: sy / count };
}

function maskWhere(raster: Raster, test: (r: number, g: number, b: number, a: number) => boolean): Uint8Array {
  const mask = new Uint8Array(raster.width * raster.height);
  for (let p = 0; p < mask.length; p += 1) {
    const i = p * 4;
    if (test(raster.data[i] ?? 0, raster.data[i + 1] ?? 0, raster.data[i + 2] ?? 0, raster.data[i + 3] ?? 0)) mask[p] = 1;
  }
  return mask;
}

/** The largest 8-connected component of a mask (ties: the lowest label). Small stray pixels of the same color drop out. */
function largestComponent(mask: Uint8Array, width: number, height: number): Uint8Array {
  const labeling = labelComponents(mask, width, height);
  const best = [...labeling.components].sort((a, b) => b.area - a.area || a.id - b.id)[0];
  return best ? Uint8Array.from(labeling.labels, (label) => (label === best.id ? 1 : 0)) : new Uint8Array(mask.length);
}

const andMask = (a: Uint8Array, b: Uint8Array): Uint8Array => a.map((value, p) => (value === 1 && b[p] === 1 ? 1 : 0));

function rowExtent(mask: Uint8Array, width: number): { first: number; last: number } | null {
  const bounds = maskBounds(mask, width);
  return bounds ? { first: bounds.top, last: bounds.bottom - 1 } : null;
}

/** Center of the opaque pixels in each row, from `from` to `to` (inclusive). Rows with fewer than 3 pixels are skipped. */
function centerline(mask: Uint8Array, width: number, from: number, to: number): Joint[] {
  const points: Joint[] = [];
  for (let y = from; y <= to; y += 1) {
    let sx = 0;
    let count = 0;
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] === 0) continue;
      sx += x + 0.5;
      count += 1;
    }
    if (count >= 3) points.push({ x: sx / count, y: y + 0.5 });
  }
  return points;
}

// Color rules for the L0 test concept. They are data-specific assumptions and are recorded in the report.
const isBlue = (r: number, _g: number, b: number, a: number): boolean => a >= 128 && b > r + 20 && b > 60;
const isSleeveWhite = (r: number, g: number, b: number, a: number): boolean => a >= 128 && r > 200 && g > 200 && b > 200 && Math.max(r, g, b) - Math.min(r, g, b) < 40;
const isTieRed = (r: number, g: number, b: number, a: number): boolean => a >= 128 && r > 140 && g < 80 && b < 90;

export const studyAssumptions = [
  'Wrist: the wrist band and glove are the largest connected component of blue pixels (B > R + 20 and B > 60, alpha >= 128) of an arm part. The wrist is the centroid of the top quarter of its rows (the band).',
  'Sleeve end: the last row of the largest connected component of white pixels (R, G, B > 200, low saturation) above the wrist band of an arm part.',
  'Elbow and knee: the break point of a two-segment fit of the row centerline of the drawn pixels only (completed pixels excluded) (elbow: from the sleeve end to the wrist; knee: from the skirt hem to the ankle). The break must leave at least 20 % of the rows on each side, so that an occluded end does not make a false bend. A bend below 10 degrees gives `unknown` with a data range, not a point.',
  'Ankle: the centroid of the pixels that footwear and legwear share on one side (the shoe collar). The joint itself is under the shoe.',
  'Foot anchor: the centroid of the lowest 6 opaque rows of a shoe part (the sole contact). The template has no such point.',
  'Neck base: the centroid of the lowest 10 rows of the neck layer (under the collar).',
  'Chin: the centroid of the lowest 3 rows of the face layer. The template head bone joint is at the chin (figure.ts headShape).',
  'Eyes: the centroids of the two major irides components. Nose and mouth: layer centroids.',
  'Torso front mark: the centroid of the red tie pixels (R > 140, G < 80, B < 90) of topwear. The template has no such point.',
  'Completed pixels: a layer pixel (alpha >= 128) whose largest RGB difference from the input image is above 32 is a See-through completion under another part, not drawn evidence. A bend point on such a pixel is `occluded` with low confidence.',
  'Head center: the centroid of the face layer. It is on the front of the head, so it is only a proxy. The template has no head center.'
];

export type Measured = {
  readonly landmarks: readonly Landmark[];
  readonly regions: readonly { readonly id: string; readonly range: Range; readonly reason: string }[];
  /** Visible white sleeve pixels per image side. */
  readonly sleeveArea: Readonly<Record<Side, number>>;
  /** Share of the opaque pixels of each limb part that See-through completed (they do not match the input image). */
  readonly completedShare: Readonly<Record<string, number>>;
};

const rangeOf = (bounds: { left: number; top: number; right: number; bottom: number } | null): Range | null =>
  bounds ? { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom } : null;

/**
 * Pixels of a layer (alpha >= 128) that do not match the input image (largest RGB channel difference above `tolerance`).
 * See-through completes the parts that other parts hide. These completed pixels differ from the input, so they are not drawn evidence.
 * The draw order cannot show this: one handwear layer holds both arms, in front of the torso.
 */
export function completedMask(layer: Raster, image: Raster, tolerance = 32): Uint8Array {
  const hidden = new Uint8Array(layer.width * layer.height);
  for (let p = 0; p < hidden.length; p += 1) {
    const i = p * 4;
    if ((layer.data[i + 3] ?? 0) < 128) continue;
    const difference = Math.max(
      Math.abs((layer.data[i] ?? 0) - (image.data[i] ?? 0)),
      Math.abs((layer.data[i + 1] ?? 0) - (image.data[i + 1] ?? 0)),
      Math.abs((layer.data[i + 2] ?? 0) - (image.data[i + 2] ?? 0))
    );
    if (difference > tolerance) hidden[p] = 1;
  }
  return hidden;
}

const isHiddenAt = (hidden: Uint8Array, width: number, point: Joint): boolean => hidden[Math.floor(point.y) * width + Math.floor(point.x)] === 1;

/**
 * Automatic landmark measurement from the See-through layers. Each rule is in `studyAssumptions`.
 * `image` is the See-through input at the layer frame size. Without it, no point is marked as completed (hidden).
 */
export function measureLandmarks(layers: ReadonlyMap<string, Raster>, image: Raster | null, bendThresholdDegrees = 10): Measured {
  const get = (tag: string): Raster => {
    const raster = layers.get(tag);
    if (!raster) fail('E_LAYER', `The layer ${show(tag)} is required.`);
    return raster;
  };
  const width = get('face').width;
  const result: Landmark[] = [];
  const regions: { id: string; range: Range; reason: string }[] = [];
  const sleeveArea: Record<Side, number> = { image_left: 0, image_right: 0 };
  const completedShare: Record<string, number> = {};
  const opaque = (raster: Raster): Uint8Array => alphaMask(raster, 128);

  // Head and face.
  const face = opaque(get('face'));
  const faceBounds = maskBounds(face, width);
  const faceCenter = centroid(face, width);
  const frontHair = maskBounds(alphaMask(get('front hair'), 1), width);
  if (faceBounds && frontHair) {
    result.push(
      unknown(
        'head_top',
        { left: faceBounds.left, top: frontHair.top, right: faceBounds.right, bottom: faceBounds.top },
        'range from the top of front hair to the top of the face layer',
        ['front hair', 'face'],
        'Hair hides the top of the skull. The range is where the skull top can be.'
      )
    );
  } else result.push(unknown('head_top', null, 'no face or hair layer', ['front hair', 'face'], 'No data.'));
  result.push(
    faceCenter
      ? landmark('head_center', {
          point: pointOf(faceCenter.x, faceCenter.y),
          range: rangeOf(faceBounds),
          visibility: 'inferred',
          confidence: 'low',
          method: 'face layer centroid (proxy)',
          sourceLayers: ['face'],
          note: 'The face is the front surface of the head. The skull center is behind it and is not visible.'
        })
      : unknown('head_center', null, 'face layer empty', ['face'], 'No data.')
  );
  if (faceBounds) {
    const chin = centroid(face, width, { from: faceBounds.bottom - 3, to: faceBounds.bottom });
    result.push(
      chin
        ? landmark('chin', {
            point: pointOf(chin.x, chin.y),
            range: null,
            visibility: 'visible',
            confidence: 'medium',
            method: 'centroid of the lowest 3 rows of the face layer',
            sourceLayers: ['face'],
            note: 'The lowest face point. The jaw line in a turned head is not exactly the chin.'
          })
        : unknown('chin', null, 'no rows', ['face'], 'No data.')
    );
  }
  // Face features are optional layers: See-through can omit a tag (for example the nose of a head in profile). A missing layer gives an unknown landmark.
  for (const [id, tag] of [
    ['nose', 'nose'],
    ['mouth', 'mouth']
  ] as const) {
    const raster = layers.get(tag);
    if (!raster) {
      result.push(unknown(id, null, 'layer missing', [tag], `See-through gave no ${tag} layer.`));
      continue;
    }
    const point = centroid(alphaMask(raster, 1), width);
    result.push(
      point
        ? landmark(id, {
            point: pointOf(point.x, point.y),
            range: null,
            visibility: 'visible',
            confidence: 'high',
            method: `${tag} layer centroid`,
            sourceLayers: [tag],
            note: 'Directly drawn feature.'
          })
        : unknown(id, null, 'layer empty', [tag], 'No data.')
    );
  }
  const iridesLayer = layers.get('irides');
  const irides = iridesLayer ? labelComponents(alphaMask(iridesLayer, 1), width, iridesLayer.height) : { components: [] };
  const eyes = [...irides.components]
    .sort((a, b) => b.area - a.area)
    .slice(0, 2)
    .sort((a, b) => a.centroid.x - b.centroid.x);
  sides.forEach((side, index) => {
    const eye = eyes.length === 2 ? eyes[index] : undefined;
    result.push(
      eye
        ? landmark(`eye_${side}`, {
            point: pointOf(eye.centroid.x, eye.centroid.y),
            range: null,
            visibility: 'visible',
            confidence: 'high',
            method: 'irides component centroid',
            sourceLayers: ['irides'],
            note: 'Directly drawn feature (glasses do not hide the iris).'
          })
        : unknown(`eye_${side}`, null, iridesLayer ? 'two irides components not found' : 'layer missing', ['irides'], iridesLayer ? 'No data.' : 'See-through gave no irides layer.')
    );
  });

  // Neck and torso.
  const neck = opaque(get('neck'));
  const neckBounds = maskBounds(neck, width);
  const neckBase = neckBounds ? centroid(neck, width, { from: neckBounds.bottom - 10, to: neckBounds.bottom }) : null;
  result.push(
    neckBase
      ? landmark('neck_base', {
          point: pointOf(neckBase.x, neckBase.y),
          range: null,
          visibility: 'occluded',
          confidence: 'medium',
          method: 'centroid of the lowest 10 rows of the neck layer',
          sourceLayers: ['neck'],
          note: 'The collar hides the neck base. See-through painted the neck under the collar.'
        })
      : unknown('neck_base', null, 'neck layer empty', ['neck'], 'No data.')
  );
  const tie = centroid(maskWhere(get('topwear'), isTieRed), width);
  result.push(
    tie
      ? landmark('torso_front_mark', {
          point: pointOf(tie.x, tie.y),
          range: null,
          visibility: 'visible',
          confidence: 'high',
          method: 'red tie pixels of topwear',
          sourceLayers: ['topwear'],
          note: 'A front midline cue of the torso. Clothing can hang off the midline.'
        })
      : unknown('torso_front_mark', null, 'no tie pixels', ['topwear'], 'No data.')
  );

  // Arms.
  const handwear = get('handwear');
  const armHidden = image ? completedMask(handwear, image) : new Uint8Array(handwear.width * handwear.height);
  const arms = splitLayer(handwear);
  if (arms.status !== 'split' || arms.parts.length !== 2) fail('E_LAYER', 'handwear does not split into two arms. The study needs the L0-1b arm split.');
  sides.forEach((side, index) => {
    const part = extractLabel(handwear, arms.assignment, index + 1);
    const mask = opaque(part);
    const extent = rowExtent(mask, width);
    if (!extent) return;
    const blue = largestComponent(maskWhere(part, isBlue), width, part.height);
    const blueRows = rowExtent(blue, width);
    const white = maskWhere(part, isSleeveWhite);
    const whiteUpper = largestComponent(blueRows ? white.map((value, p) => (value === 1 && Math.floor(p / width) < blueRows.first ? 1 : 0)) : white, width, part.height);
    const sleeve = rowExtent(whiteUpper, width);
    sleeveArea[side] = whiteUpper.reduce((sum, value) => sum + value, 0);
    const armBounds = maskBounds(mask, width) as Range;
    // Shoulder: inside the sleeve cap. Only a range and a low-confidence proxy.
    const capRows = { from: extent.first, to: sleeve ? Math.min(sleeve.last, extent.first + 40) : extent.first + 20 };
    const cap = centroid(mask, width, capRows);
    const capBounds = maskBounds(
      mask.map((value, p) => (value === 1 && Math.floor(p / width) >= capRows.from && Math.floor(p / width) < capRows.to ? 1 : 0)),
      width
    );
    result.push(
      cap
        ? landmark(`shoulder_${side}`, {
            point: pointOf(cap.x, cap.y),
            range: rangeOf(capBounds),
            visibility: 'inferred',
            confidence: 'low',
            method: 'centroid of the sleeve cap rows (top of the arm part)',
            sourceLayers: ['handwear'],
            note: 'The sleeve hides the shoulder joint. The point is the cap center, not the joint. Hair and the bust cover parts of the cap.'
          })
        : unknown(`shoulder_${side}`, null, 'no cap rows', ['handwear'], 'No data.')
    );
    if (sleeve) {
      const end = centroid(whiteUpper, width, { from: sleeve.last - 2, to: sleeve.last + 1 });
      if (end)
        result.push(
          landmark(`sleeve_end_${side}`, {
            point: pointOf(end.x, end.y),
            range: null,
            visibility: 'visible',
            confidence: 'high',
            method: 'last row of white sleeve pixels',
            sourceLayers: ['handwear'],
            note: 'A clothing edge, not a joint. The elbow is below it.'
          })
        );
    } else result.push(unknown(`sleeve_end_${side}`, null, 'no white sleeve pixels', ['handwear'], 'No data.'));
    let wrist: Joint | null = null;
    if (blueRows) {
      const bandRows = { from: blueRows.first, to: blueRows.first + Math.max(3, Math.round((blueRows.last - blueRows.first + 1) / 4)) };
      wrist = centroid(blue, width, bandRows);
    }
    result.push(
      wrist
        ? landmark(`wrist_${side}`, {
            point: pointOf(wrist.x, wrist.y),
            range: null,
            visibility: 'occluded',
            confidence: 'medium',
            method: 'centroid of the top quarter of the blue band and glove rows',
            sourceLayers: ['handwear'],
            note: 'The wrist band covers the wrist. The joint is under the band.'
          })
        : unknown(`wrist_${side}`, null, 'no blue pixels', ['handwear'], 'No data.')
    );
    // Elbow: between the sleeve end and the wrist.
    const from = sleeve ? sleeve.last : extent.first;
    const to = wrist ? Math.floor(wrist.y) : extent.last;
    const drawn = mask.map((value, p) => (value === 1 && armHidden[p] === 0 ? 1 : 0));
    completedShare[`arm_${side}`] = round3(
      1 -
        drawn.reduce((sum, value) => sum + value, 0) /
          Math.max(
            1,
            mask.reduce((sum, value) => sum + value, 0)
          )
    );
    const line = centerline(drawn, width, from, to);
    const bend = fitBend(line, Math.max(8, Math.round(line.length * 0.2)));
    const elbowRange: Range = { left: armBounds.left, top: from, right: armBounds.right, bottom: to };
    if (bend && bend.bendDegrees >= bendThresholdDegrees && bend.point.y >= from && bend.point.y <= to) {
      const hiddenPoint = isHiddenAt(armHidden, width, bend.point);
      result.push(
        landmark(`elbow_${side}`, {
          point: pointOf(bend.point.x, bend.point.y),
          range: elbowRange,
          visibility: hiddenPoint ? 'occluded' : 'inferred',
          confidence: hiddenPoint ? 'low' : bend.bendDegrees >= 20 ? 'medium' : 'low',
          method: `two-segment fit of the arm centerline, bend ${round1(bend.bendDegrees)} deg`,
          sourceLayers: ['handwear'],
          note: hiddenPoint
            ? 'The break point is in arm pixels that do not match the input image. See-through painted them (layer completion) under other parts, so they are not drawn evidence.'
            : 'The centerline of a silhouette is not the bone line. Shading and the sleeve change the outline.'
        })
      );
    } else {
      result.push(
        unknown(
          `elbow_${side}`,
          elbowRange,
          `two-segment fit of the arm centerline: bend ${bend ? round1(bend.bendDegrees) : 'n/a'} deg, below ${bendThresholdDegrees} deg or outside the range`,
          ['handwear'],
          'The arm is almost straight in the image, so the outline does not show the elbow. The range is from the sleeve end to the wrist.'
        )
      );
    }
  });

  // Legs and feet.
  const legwear = get('legwear');
  const footwear = get('footwear');
  const legs = splitLayer(legwear, { ...defaultSplitOptions, scanRows: true });
  const feet = splitLayer(footwear);
  if (legs.status !== 'split' || feet.status !== 'split') fail('E_LAYER', 'legwear or footwear does not split into two parts. The study needs the L0-1b split.');
  const merged = legs.assignment.map((value) => (value === 252 ? 1 : 0));
  const mergedBounds = maskBounds(merged, width);
  const skirt = maskBounds(alphaMask(get('bottomwear'), 128), width);
  const legMask = opaque(legwear);
  const legHidden = image ? completedMask(legwear, image) : new Uint8Array(legwear.width * legwear.height);
  sides.forEach((side, index) => {
    const leg = opaque(extractLabel(legwear, legs.assignment, index + 1));
    const shoe = opaque(extractLabel(footwear, feet.assignment, index + 1));
    const legExtent = rowExtent(leg, width);
    const shoeExtent = rowExtent(shoe, width);
    const shoeBounds = maskBounds(shoe, width);
    // Hip: hidden under the skirt and inside the merged thigh region.
    if (skirt && mergedBounds) {
      result.push(
        unknown(
          `hip_${side}`,
          { left: mergedBounds.left, top: skirt.top, right: mergedBounds.right, bottom: mergedBounds.bottom },
          'range from the skirt top to the bottom of the merged thigh region',
          ['bottomwear', 'legwear'],
          'The skirt hides the hips. The painted thighs are one merged shape, so the side of each hip joint is not known.'
        )
      );
    } else result.push(unknown(`hip_${side}`, null, 'no skirt or merged region', ['bottomwear', 'legwear'], 'No data.'));
    // Ankle: shared pixels of shoe and stocking.
    const collar = andMask(shoe, legMask);
    const ankle = centroid(collar, width);
    result.push(
      ankle
        ? landmark(`ankle_${side}`, {
            point: pointOf(ankle.x, ankle.y),
            range: rangeOf(maskBounds(collar, width)),
            visibility: 'occluded',
            confidence: 'medium',
            method: 'centroid of the shoe and stocking overlap (shoe collar)',
            sourceLayers: ['footwear', 'legwear'],
            note: 'The shoe hides the ankle joint. The joint is a little below the collar center.'
          })
        : unknown(`ankle_${side}`, rangeOf(shoeBounds), 'no overlap of shoe and stocking', ['footwear', 'legwear'], 'No data.')
    );
    if (shoeExtent) {
      const anchor = centroid(shoe, width, { from: shoeExtent.last - 5, to: shoeExtent.last + 1 });
      if (anchor)
        result.push(
          landmark(`foot_anchor_${side}`, {
            point: pointOf(anchor.x, anchor.y),
            range: rangeOf(shoeBounds),
            visibility: 'visible',
            confidence: 'high',
            method: 'centroid of the lowest 6 rows of the shoe',
            sourceLayers: ['footwear'],
            note: 'The sole contact. The template has no foot anchor point.'
          })
        );
    }
    // Knee: between the merged region and the ankle.
    if (legExtent) {
      const to = ankle ? Math.floor(ankle.y) : legExtent.last;
      const drawnLeg = leg.map((value, p) => (value === 1 && legHidden[p] === 0 ? 1 : 0));
      completedShare[`leg_${side}`] = round3(
        1 -
          drawnLeg.reduce((sum, value) => sum + value, 0) /
            Math.max(
              1,
              leg.reduce((sum, value) => sum + value, 0)
            )
      );
      const line = centerline(drawnLeg, width, legExtent.first, to);
      const bend = fitBend(line, Math.max(12, Math.round(line.length * 0.2)));
      const legBounds = maskBounds(leg, width) as Range;
      const kneeRange: Range = { left: legBounds.left, top: legExtent.first, right: legBounds.right, bottom: to };
      if (bend && bend.bendDegrees >= bendThresholdDegrees) {
        result.push(
          landmark(`knee_${side}`, {
            point: pointOf(bend.point.x, bend.point.y),
            range: kneeRange,
            visibility: isHiddenAt(legHidden, width, bend.point) ? 'occluded' : 'inferred',
            confidence: 'low',
            method: `two-segment fit of the leg centerline below the skirt, bend ${round1(bend.bendDegrees)} deg`,
            sourceLayers: ['legwear'],
            note: 'The thigh above the skirt hem is not in the fit (merged region). The stocking hides the knee shape.'
          })
        );
      } else {
        result.push(
          unknown(
            `knee_${side}`,
            kneeRange,
            `two-segment fit of the leg centerline: bend ${bend ? round1(bend.bendDegrees) : 'n/a'} deg, below ${bendThresholdDegrees} deg`,
            ['legwear'],
            'The leg is almost straight below the skirt. The range is from the skirt hem to the ankle.'
          )
        );
      }
    }
  });
  if (mergedBounds) regions.push({ id: 'merged_thighs', range: mergedBounds, reason: 'One painted shape for both upper thighs (L0-1b). Hip joints and thigh borders are unknown here.' });
  if (skirt) regions.push({ id: 'skirt', range: skirt, reason: 'The skirt hides the hips and the top of the thighs.' });
  return { landmarks: result, regions, sleeveArea, completedShare };
}

// ---------- manual landmarks ----------

/** Parses a manual landmark file. A manual entry replaces the automatic entry with the same id. */
export function parseManualLandmarks(bytes: Buffer, frame: { width: number; height: number }): Landmark[] {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('E_LANDMARKS', 'The landmark file is not valid JSON.');
  }
  if (!isRecord(value) || value.format !== landmarkFormat || !Array.isArray(value.landmarks)) fail('E_LANDMARKS', `The landmark file must have format "${landmarkFormat}" and a landmarks array.`);
  if (typeof value.markedBy !== 'string' || value.markedBy.length === 0 || value.markedBy.length > 200) fail('E_LANDMARKS', 'markedBy must name who marked the points.');
  const seen = new Set<string>();
  const inside = (x: unknown, y: unknown): boolean =>
    typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= frame.width && y <= frame.height;
  return value.landmarks.map((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !(landmarkIds as readonly string[]).includes(item.id)) fail('E_LANDMARKS', `Unknown landmark id ${show(isRecord(item) ? item.id : item)}.`);
    if (seen.has(item.id)) fail('E_LANDMARKS', `The landmark ${item.id} is given twice.`);
    seen.add(item.id);
    const visibility = item.visibility;
    if (visibility !== 'visible' && visibility !== 'occluded' && visibility !== 'inferred' && visibility !== 'unknown')
      fail('E_LANDMARKS', `${item.id}: visibility must be visible, occluded, inferred, or unknown.`);
    const confidence = item.confidence;
    if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low' && confidence !== 'none') fail('E_LANDMARKS', `${item.id}: confidence must be high, medium, low, or none.`);
    let point: Joint | null = null;
    if (item.x !== undefined || item.y !== undefined) {
      if (visibility === 'unknown') fail('E_LANDMARKS', `${item.id}: an unknown landmark must not have x and y. Give a range or nothing.`);
      if (!inside(item.x, item.y)) fail('E_LANDMARKS', `${item.id}: x and y must be inside the ${frame.width}x${frame.height} frame.`);
      point = { x: item.x as number, y: item.y as number };
    } else if (visibility !== 'unknown') fail('E_LANDMARKS', `${item.id}: a ${visibility} landmark needs x and y.`);
    if ((visibility === 'unknown') !== (confidence === 'none')) fail('E_LANDMARKS', `${item.id}: use confidence none only with visibility unknown.`);
    let range: Range | null = null;
    if (item.range !== undefined) {
      const r = item.range;
      if (!isRecord(r) || !inside(r.left, r.top) || !inside(r.right, r.bottom) || !((r.right as number) > (r.left as number)) || !((r.bottom as number) > (r.top as number)))
        fail('E_LANDMARKS', `${item.id}: range needs left < right and top < bottom inside the frame.`);
      range = { left: r.left as number, top: r.top as number, right: r.right as number, bottom: r.bottom as number };
    }
    const id = item.id;
    const text = (field: unknown, name: string): string => {
      if (typeof field !== 'string' || field.length === 0 || field.length > 300) fail('E_LANDMARKS', `${id}: ${name} must be text of 1 to 300 characters.`);
      return field;
    };
    return { id: item.id, point, range, visibility, confidence, method: text(item.method, 'method'), sourceLayers: ['image'], note: text(item.note, 'note'), origin: 'manual' as const };
  });
}

/** A manual landmark file with all ids unknown: the starting point for a person who marks the image. */
export function manualTemplate(): Record<string, unknown> {
  return {
    format: landmarkFormat,
    markedBy: 'REPLACE: name of the person',
    rules: 'Give x and y only for a point that you see or can derive from visible geometry. Keep unknown points without x and y. Coordinates are in the 1280 x 1280 See-through frame, y down.',
    landmarks: landmarkIds.map((id) => ({ id, visibility: 'unknown', confidence: 'none', method: 'not marked', note: 'not marked' }))
  };
}

// ---------- correspondence ----------

export type MappingHypothesis = 'near_is_image_left' | 'near_is_image_right';

type TemplateRef = { readonly kind: 'bone' | 'point'; readonly id: string };

/** Correspondence of character landmarks to C0.5 contract joints and points for one near and far hypothesis. Null: the template has no such point. */
export function correspondence(hypothesis: MappingHypothesis): ReadonlyMap<string, TemplateRef | null> {
  const near: Side = hypothesis === 'near_is_image_left' ? 'image_left' : 'image_right';
  const far: Side = near === 'image_left' ? 'image_right' : 'image_left';
  const map = new Map<string, TemplateRef | null>([
    ['head_top', { kind: 'point', id: 'head_top' }],
    ['head_center', null],
    ['chin', { kind: 'bone', id: 'head' }],
    ['nose', { kind: 'point', id: 'face_nose' }],
    ['mouth', null],
    [`eye_${near}`, { kind: 'point', id: 'face_eye_near' }],
    [`eye_${far}`, { kind: 'point', id: 'face_eye_far' }],
    ['neck_base', { kind: 'bone', id: 'neck' }],
    ['torso_front_mark', null]
  ]);
  for (const [side, rig] of [
    [near, 'near'],
    [far, 'far']
  ] as const) {
    map.set(`shoulder_${side}`, { kind: 'bone', id: `upper_arm_${rig}` });
    map.set(`sleeve_end_${side}`, null);
    map.set(`elbow_${side}`, { kind: 'bone', id: `forearm_${rig}` });
    map.set(`wrist_${side}`, { kind: 'bone', id: `hand_${rig}` });
    map.set(`hip_${side}`, { kind: 'bone', id: `thigh_${rig}` });
    map.set(`knee_${side}`, { kind: 'bone', id: `shin_${rig}` });
    map.set(`ankle_${side}`, { kind: 'bone', id: `foot_${rig}` });
    map.set(`foot_anchor_${side}`, null);
  }
  return map;
}

function templatePoint(contract: ControlContract, ref: TemplateRef): Joint | null {
  return ref.kind === 'bone' ? (contract.bones.get(ref.id)?.joint ?? null) : (contract.points.get(ref.id)?.position ?? null);
}

const confidenceRank: Record<LandmarkConfidence, number> = { high: 3, medium: 2, low: 1, none: 0 };

export type FitName = 'uniform' | 'similarity' | 'affine';
export type FitResult = {
  readonly name: FitName;
  readonly landmarkSet: string;
  readonly ids: readonly string[];
  readonly transform: Affine | null;
  readonly scale: { s1: number; s2: number; anisotropy: number; rotationDegrees: number; reflection: boolean } | null;
  readonly residuals: readonly { id: string; errorPx: number; errorPctHeight: number }[];
  readonly meanErrorPctHeight: number | null;
  readonly maxErrorPctHeight: number | null;
};

function runFit(name: FitName, landmarkSet: string, pairs: readonly { id: string; source: Joint; target: Joint }[], bodyHeight: number): FitResult {
  const source = pairs.map((pair) => pair.source);
  const target = pairs.map((pair) => pair.target);
  const transform = name === 'uniform' ? fitUniform(source, target) : name === 'similarity' ? fitSimilarity(source, target) : fitAffine(source, target);
  if (!transform) return { name, landmarkSet, ids: pairs.map((pair) => pair.id), transform: null, scale: null, residuals: [], meanErrorPctHeight: null, maxErrorPctHeight: null };
  const parts = decompose(transform);
  const residuals = pairs.map((pair) => {
    const mapped = applyAffine(transform, pair.source);
    const errorPx = Math.hypot(mapped.x - pair.target.x, mapped.y - pair.target.y);
    return { id: pair.id, errorPx: round1(errorPx), errorPctHeight: round3((errorPx / bodyHeight) * 100) };
  });
  const errors = residuals.map((item) => item.errorPctHeight);
  return {
    name,
    landmarkSet,
    ids: pairs.map((pair) => pair.id),
    transform: { a: round3(transform.a), b: round3(transform.b), c: round3(transform.c), d: round3(transform.d), tx: round1(transform.tx), ty: round1(transform.ty) },
    scale: { s1: round3(parts.s1), s2: round3(parts.s2), anisotropy: round3(parts.s1 / parts.s2), rotationDegrees: round1(parts.rotationDegrees), reflection: parts.determinant < 0 },
    residuals,
    meanErrorPctHeight: round3(errors.reduce((sum, value) => sum + value, 0) / errors.length),
    maxErrorPctHeight: round3(Math.max(...errors))
  };
}

export type Pair = { readonly id: string; readonly source: Joint; readonly target: Joint; readonly ref: TemplateRef; readonly confidence: LandmarkConfidence };

export function pairsFor(contract: ControlContract, landmarks: readonly Landmark[], hypothesis: MappingHypothesis, minimum: LandmarkConfidence): Pair[] {
  const map = correspondence(hypothesis);
  const pairs: Pair[] = [];
  for (const item of landmarks) {
    const ref = map.get(item.id);
    if (!ref || !item.point || confidenceRank[item.confidence] < confidenceRank[minimum]) continue;
    const target = templatePoint(contract, ref);
    if (target) pairs.push({ id: item.id, source: item.point, target, ref, confidence: item.confidence });
  }
  return pairs;
}

/** Per-bone comparison after a global fit: length ratio (proportion) and angle difference (pose) of each template segment with two known ends. */
export function boneComparison(contract: ControlContract, landmarks: readonly Landmark[], hypothesis: MappingHypothesis, fit: Affine): Record<string, unknown>[] {
  const map = correspondence(hypothesis);
  const byRef = new Map<string, Landmark>();
  for (const item of landmarks) {
    const ref = map.get(item.id);
    if (ref && item.point) byRef.set(`${ref.kind}:${ref.id}`, item);
  }
  const segments: [string, string, string][] = [
    ['upper_arm_near', 'forearm_near', 'upper arm near'],
    ['forearm_near', 'hand_near', 'forearm near'],
    ['upper_arm_far', 'forearm_far', 'upper arm far'],
    ['forearm_far', 'hand_far', 'forearm far'],
    ['upper_arm_near', 'hand_near', 'whole arm near (shoulder to wrist)'],
    ['upper_arm_far', 'hand_far', 'whole arm far (shoulder to wrist)'],
    ['thigh_near', 'shin_near', 'thigh near'],
    ['shin_near', 'foot_near', 'shin near'],
    ['thigh_far', 'shin_far', 'thigh far'],
    ['shin_far', 'foot_far', 'shin far'],
    ['upper_arm_near', 'upper_arm_far', 'shoulder line'],
    ['foot_near', 'foot_far', 'ankle line'],
    ['neck', 'head', 'neck to chin']
  ];
  return segments.map(([from, to, label]) => {
    const a = byRef.get(`bone:${from}`);
    const b = byRef.get(`bone:${to}`);
    const ta = contract.bones.get(from)?.joint;
    const tb = contract.bones.get(to)?.joint;
    if (!a?.point || !b?.point || !ta || !tb) return { segment: label, from, to, status: 'not_computable', reason: `missing ${!a?.point ? from : to} on the character` };
    const ma = applyAffine(fit, a.point);
    const mb = applyAffine(fit, b.point);
    const templateLength = Math.hypot(tb.x - ta.x, tb.y - ta.y);
    const characterLength = Math.hypot(mb.x - ma.x, mb.y - ma.y);
    return {
      segment: label,
      from,
      to,
      status: 'computed',
      lengthRatio: round3(characterLength / templateLength),
      angleDifferenceDegrees: round1(angleDifference(directionDegrees(ma, mb), directionDegrees(ta, tb))),
      confidence: [a.confidence, b.confidence].sort((x, y) => confidenceRank[x] - confidenceRank[y])[0]
    };
  });
}

/** Piecewise affine check on fixed triangles: stretch, area ratio, and reflection of the exact triangle map. */
export function triangleChecks(contract: ControlContract, landmarks: readonly Landmark[], hypothesis: MappingHypothesis): Record<string, unknown>[] {
  const map = correspondence(hypothesis);
  const point = (id: string): { source: Joint; target: Joint } | null => {
    const item = landmarks.find((entry) => entry.id === id);
    const ref = map.get(id);
    const target = ref ? templatePoint(contract, ref) : null;
    return item?.point && target ? { source: item.point, target } : null;
  };
  const triangles: [string, [string, string, string]][] = [
    ['face (eyes and nose)', ['eye_image_left', 'eye_image_right', 'nose']],
    ['shoulders and neck', ['shoulder_image_left', 'shoulder_image_right', 'neck_base']],
    ['wrists and neck', ['wrist_image_left', 'wrist_image_right', 'neck_base']],
    ['ankles and neck', ['ankle_image_left', 'ankle_image_right', 'neck_base']]
  ];
  return triangles.map(([name, ids]) => {
    const found = ids.map(point);
    if (found.some((item) => item === null)) return { triangle: name, ids, status: 'not_computable' };
    const [p0, p1, p2] = found as [{ source: Joint; target: Joint }, { source: Joint; target: Joint }, { source: Joint; target: Joint }];
    const m = triangleAffine([p0.source, p1.source, p2.source], [p0.target, p1.target, p2.target]);
    if (!m) return { triangle: name, ids, status: 'degenerate' };
    const parts = decompose(m);
    return {
      triangle: name,
      ids,
      status: 'computed',
      s1: round3(parts.s1),
      s2: round3(parts.s2),
      anisotropy: round3(parts.s1 / parts.s2),
      areaRatio: round3(Math.abs(parts.determinant)),
      reflection: parts.determinant < 0,
      rotationDegrees: round1(parts.rotationDegrees)
    };
  });
}

// ---------- orientation cues ----------

/** Facing and near/far cues from the measured landmarks. Each cue votes for a near side or abstains. */
export function sideCues(landmarks: readonly Landmark[], contract: ControlContract, sleeveArea?: Readonly<Record<Side, number>>): Record<string, unknown>[] {
  const p = (id: string): Joint | null => landmarks.find((item) => item.id === id)?.point ?? null;
  const cues: Record<string, unknown>[] = [];
  const nose = p('nose');
  const eyeLeft = p('eye_image_left');
  const eyeRight = p('eye_image_right');
  const templateNose = contract.points.get('face_nose')?.position;
  const templateNear = contract.points.get('face_eye_near')?.position;
  const templateFar = contract.points.get('face_eye_far')?.position;
  if (nose && eyeLeft && eyeRight && templateNose && templateNear && templateFar) {
    const ratio = (n: Joint, a: Joint, b: Joint): number => (n.x - (a.x + b.x) / 2) / Math.abs(b.x - a.x);
    const value = ratio(nose, eyeLeft, eyeRight);
    const templateValue = ratio(templateNose, templateNear, templateFar);
    cues.push({
      cue: 'face direction',
      measurement: `nose offset from the eye midpoint, in eye distances: character ${round3(value)}, template ${round3(templateValue)}`,
      vote: value > 0.15 ? 'facing image right, near_is_image_left' : value < -0.15 ? 'facing image left, near_is_image_right' : 'abstain',
      confidence: Math.abs(value) > 0.4 ? 'high' : 'medium',
      basis: 'In a front-visible three-quarter view the nose is on the facing side of the eyes. The near side is opposite to the facing side.'
    });
  }
  const tie = p('torso_front_mark');
  const shoulderLeft = p('shoulder_image_left');
  const shoulderRight = p('shoulder_image_right');
  const neck = p('neck_base');
  if (tie && neck) {
    cues.push({
      cue: 'torso front mark',
      measurement: `tie centroid x ${round1(tie.x)} against neck base x ${round1(neck.x)} (difference ${round1(tie.x - neck.x)} px)`,
      vote: tie.x - neck.x > 5 ? 'front faces image right, near_is_image_left' : tie.x - neck.x < -5 ? 'front faces image left, near_is_image_right' : 'abstain',
      confidence: 'medium',
      basis: 'The front midline moves toward the facing side. A tie can hang off the midline, so the confidence is medium.'
    });
  }
  if (shoulderLeft && shoulderRight && neck) {
    const left = Math.abs(neck.x - shoulderLeft.x);
    const right = Math.abs(shoulderRight.x - neck.x);
    cues.push({
      cue: 'shoulder widths from the neck',
      measurement: `image-left ${round1(left)} px, image-right ${round1(right)} px (low-confidence shoulder proxies)`,
      vote: left > right * 1.15 ? 'near_is_image_left' : right > left * 1.15 ? 'near_is_image_right' : 'abstain',
      confidence: 'low',
      basis:
        'In a three-quarter view the near shoulder is farther from the neck in the image. The shoulder points are centroids of the visible sleeve cap, so a cap that the torso hides moves the proxy and this cue is not reliable.'
    });
  }
  if (sleeveArea && sleeveArea.image_left + sleeveArea.image_right > 0) {
    const { image_left: left, image_right: right } = sleeveArea;
    cues.push({
      cue: 'visible sleeve area',
      measurement: `white sleeve pixels: image-left ${left}, image-right ${right}`,
      vote: left > right * 1.5 ? 'near_is_image_left' : right > left * 1.5 ? 'near_is_image_right' : 'abstain',
      confidence: 'medium',
      basis: 'The torso hides more of the far shoulder and sleeve. Hair and the pose can also hide a sleeve.'
    });
  }
  const footLeft = p('foot_anchor_image_left');
  const footRight = p('foot_anchor_image_right');
  if (footLeft && footRight) {
    const difference = footLeft.y - footRight.y;
    cues.push({
      cue: 'foot contact height',
      measurement: `image-left sole y ${round1(footLeft.y)}, image-right sole y ${round1(footRight.y)} (difference ${round1(difference)} px)`,
      vote: difference > 6 ? 'near_is_image_left' : difference < -6 ? 'near_is_image_right' : 'abstain',
      confidence: 'low',
      basis: 'With a camera above the ground, the nearer foot is lower in the image. The C0.5 template is orthographic (both feet at the same height), so this cue depends on the art perspective.'
    });
  }
  return cues;
}

// ---------- drawing ----------

const sideColor = (id: string): Color => (id.endsWith('image_left') ? [30, 110, 230, 255] : id.endsWith('image_right') ? [230, 110, 20, 255] : [20, 150, 60, 255]);

function ring(raster: Raster, center: Joint, radius: number, width: number, color: Color): void {
  for (let step = 0; step < 48; step += 1) {
    const a0 = (step / 48) * Math.PI * 2;
    const a1 = ((step + 1) / 48) * Math.PI * 2;
    raster.line({ x: center.x + Math.cos(a0) * radius, y: center.y + Math.sin(a0) * radius }, { x: center.x + Math.cos(a1) * radius, y: center.y + Math.sin(a1) * radius }, width, color);
  }
}

function dashedRect(raster: Raster, range: Range, color: Color): void {
  const corners: [Joint, Joint][] = [
    [
      { x: range.left, y: range.top },
      { x: range.right, y: range.top }
    ],
    [
      { x: range.right, y: range.top },
      { x: range.right, y: range.bottom }
    ],
    [
      { x: range.right, y: range.bottom },
      { x: range.left, y: range.bottom }
    ],
    [
      { x: range.left, y: range.bottom },
      { x: range.left, y: range.top }
    ]
  ];
  for (const [a, b] of corners) {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    for (let t = 0; t < length; t += 12) {
      const u = t / length;
      const v = Math.min(1, (t + 6) / length);
      raster.line({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }, { x: a.x + (b.x - a.x) * v, y: a.y + (b.y - a.y) * v }, 2, color);
    }
  }
}

const shortLabel = (id: string): string => id.replace('_image_left', ' l').replace('_image_right', ' r').replace(/_/g, ' ');

/** Draws landmarks: filled dot = visible, ring = occluded, ring with a cross = inferred, dashed box = unknown range. */
function drawLandmarks(raster: Raster, landmarks: readonly Landmark[], labels: boolean): void {
  for (const item of landmarks) {
    const color = sideColor(item.id);
    if (item.visibility === 'unknown') {
      if (item.range) dashedRect(raster, item.range, [200, 0, 0, 255]);
      if (labels && item.range) drawText(raster, `${shortLabel(item.id)} ?`, item.range.left + 3, item.range.top + 3, 1, [200, 0, 0, 255], [255, 255, 255, 200]);
      continue;
    }
    const point = item.point as Joint;
    if (item.visibility === 'visible') raster.fillCircle(point, 6, color);
    else {
      ring(raster, point, 8, 3, color);
      if (item.visibility === 'inferred') {
        raster.line({ x: point.x - 5, y: point.y - 5 }, { x: point.x + 5, y: point.y + 5 }, 2, color);
        raster.line({ x: point.x - 5, y: point.y + 5 }, { x: point.x + 5, y: point.y - 5 }, 2, color);
      }
    }
    if (labels) drawText(raster, `${shortLabel(item.id)} ${item.confidence.charAt(0)}`, point.x + 10, point.y - 4, 1, [0, 0, 0, 255], [255, 255, 255, 200]);
  }
}

function faded(source: Raster, opacity: number): Raster {
  const out = new Raster(source.width, source.height, [255, 255, 255, 255]);
  out.draw(source, 0, 0, opacity);
  return out;
}

function legend(raster: Raster, lines: readonly string[]): void {
  lines.forEach((line, index) => {
    drawText(raster, line, 12, 12 + index * 20, 2, [0, 0, 0, 255], [255, 255, 255, 230]);
  });
}

// ---------- command ----------

export type AlignStudyOptions = {
  readonly contractBytes: Buffer;
  readonly metadataBytes: Buffer;
  readonly metadataName: string;
  readonly imageBytes: Buffer;
  readonly imageName: string;
  readonly layerFiles: ReadonlyMap<string, { readonly name: string; readonly bytes: Buffer }>;
  readonly manualBytes?: Buffer;
  readonly toolVersion: string;
};

/** Layers that the study needs. The face feature layers (nose, mouth, irides) are optional: a missing one gives unknown landmarks. */
const studyLayers = ['face', 'front hair', 'neck', 'topwear', 'handwear', 'legwear', 'footwear', 'bottomwear'] as const;

/** `align-study`: tasks A to F of experiment L0-1c. */
export function alignStudyCommand(options: AlignStudyOptions): CommandResult {
  const contract = parseContractBytes(options.contractBytes);
  if (!contract.rigId.endsWith('_c05_candidate') || contract.view !== 'three_quarter_right' || contract.sideNaming !== 'near_far')
    fail('E_CONTRACT_UNSUPPORTED', 'The study needs the C0.5 candidate contract (three_quarter_right, near_far).');
  const metadata = parseSeeThroughMetadata(options.metadataBytes);
  const { width, height } = metadata.frame;
  const image = decodePng(options.imageBytes, layerPngLimits).raster;
  if (image.width !== width || image.height !== height) fail('E_IMAGE', `The image is ${image.width}x${image.height}. The See-through frame is ${width}x${height}.`);
  const layers = new Map<string, Raster>();
  const inputs: Record<string, unknown>[] = [];
  for (const tag of drawOrder(metadata)) {
    const file = options.layerFiles.get(tag);
    if (!file) continue;
    const raster = decodePng(file.bytes, layerPngLimits).raster;
    if (raster.width !== width || raster.height !== height) fail('E_LAYER', `The layer ${show(tag)} does not have the frame size.`);
    layers.set(tag, raster);
    inputs.push({ tag, name: file.name, sha256: sha256(file.bytes), pixelSha256: pixelHash(raster) });
  }
  for (const tag of studyLayers) if (!layers.has(tag)) fail('E_LAYER', `The layer ${show(tag)} is required.`);

  // Task B: landmarks.
  const measured = measureLandmarks(layers, image);
  const manual = options.manualBytes ? parseManualLandmarks(options.manualBytes, metadata.frame) : [];
  const manualIds = new Set(manual.map((item) => item.id));
  const landmarks = [...measured.landmarks.filter((item) => !manualIds.has(item.id)), ...manual].sort((a, b) => landmarkIds.indexOf(a.id) - landmarkIds.indexOf(b.id));

  // Task C: alignment under both near/far hypotheses.
  const bodyHeight = rigPose(contract, 'anatomical').bodyHeight;
  const hypotheses: MappingHypothesis[] = ['near_is_image_left', 'near_is_image_right'];
  const alignment = hypotheses.map((hypothesis) => {
    const sets = (['medium', 'low'] as const).map((minimum) => ({ minimum, pairs: pairsFor(contract, landmarks, hypothesis, minimum) }));
    const fits = sets.flatMap(({ minimum, pairs }) => (['uniform', 'similarity', 'affine'] as const).map((name) => runFit(name, `confidence >= ${minimum}`, pairs, bodyHeight)));
    const similarity = fitSimilarity(
      (sets[0]?.pairs ?? []).map((pair) => pair.source),
      (sets[0]?.pairs ?? []).map((pair) => pair.target)
    );
    return {
      hypothesis,
      pairs: (sets[1]?.pairs ?? []).map((pair) => ({ id: pair.id, template: `${pair.ref.kind}:${pair.ref.id}`, character: pair.source, templatePoint: pair.target, confidence: pair.confidence })),
      fits,
      bones: similarity ? boneComparison(contract, landmarks, hypothesis, similarity) : [],
      triangles: triangleChecks(contract, landmarks, hypothesis)
    };
  });
  const cues = sideCues(landmarks, contract, measured.sleeveArea);
  const templateMissing = [...correspondence('near_is_image_left').entries()].filter(([, ref]) => ref === null).map(([id]) => id);
  const characterUnknown = landmarks.filter((item) => item.visibility === 'unknown').map((item) => item.id);

  // Task A: template audit (from the contract only). The parsed contract does not keep slot overlaps, so they come from the validated contract JSON.
  const rawOverlaps = overlapsOf(options.contractBytes);
  const templateAudit = [...contract.bones.values()]
    .filter((bone) => !['root', 'aim', 'tail_1', 'tail_2', 'hair_tail_1', 'hair_tail_2', 'ear_near', 'ear_far', 'skirt_front', 'skirt_back'].includes(bone.id))
    .map((bone) => {
      const slots = [...contract.slots.values()].filter((slot) => slot.bone === bone.id).map((slot) => slot.id);
      const childOverlaps = rawOverlaps.filter((item) => item.childBone === bone.id).map((item) => ({ parentSlot: item.slot, radiusPx: item.radiusPx }));
      return { bone: bone.id, parent: bone.parent, joint: bone.joint, slots, overlapAtThisJoint: childOverlaps };
    });

  // Task E: cut line candidates (no cut is made).
  const p = (id: string): Landmark | undefined => landmarks.find((item) => item.id === id);
  const cutDefinitions: [string, string, string, string, string][] = [
    ['shoulder', 'shoulder', 'elbow', 'upper_arm', 'torso / topwear'],
    ['elbow', 'elbow', 'wrist', 'forearm', 'upper_arm'],
    ['wrist', 'wrist', 'wrist', 'hand', 'forearm'],
    ['hip', 'hip', 'knee', 'thigh', 'hips / skirt'],
    ['knee', 'knee', 'ankle', 'shin', 'thigh'],
    ['ankle', 'ankle', 'foot_anchor', 'foot', 'shin']
  ];
  const cuts = sides.flatMap((side) =>
    cutDefinitions.map(([joint, at, toward, child, parent]) => {
      const here = p(`${at}_${side}`);
      const next = p(`${toward}_${side}`);
      const status = !here?.point ? 'blocked' : here.confidence === 'high' || here.confidence === 'medium' ? 'candidate' : 'hypothesis';
      return {
        cut: `${joint}_${side}`,
        between: [parent, child],
        status,
        at: here?.point ?? null,
        range: here?.range ?? null,
        axisTo: next?.point && here?.point && next.id !== here.id ? next.id : null,
        confidence: here?.confidence ?? 'none',
        reason: !here?.point ? `the ${joint} position is unknown: ${here?.note ?? 'no data'}` : here.note
      };
    })
  );

  // Task F: images.
  const files: PlannedFile[] = [];
  const records: FileRecord[] = [];
  const png = (name: string, raster: Raster): void => {
    const file = { name, bytes: encodePng(raster) };
    files.push(file);
    records.push(record(file, raster));
  };
  const visible = composite(width, height, [image]);
  // A: anatomy overlay.
  const anatomy = faded(visible, 0.55);
  drawLandmarks(anatomy, landmarks, true);
  legend(anatomy, [
    'a. landmarks (image sides: blue = image left, orange = image right)',
    'dot = visible, ring = occluded, ring + x = inferred',
    'red dashed box = unknown (range only). letter = confidence'
  ]);
  png('a-anatomy-overlay.png', anatomy);

  // B: skeleton comparison: the template mannequin and the character skeleton with the same joint names.
  const best = alignment[0];
  const similarityFit = best?.fits.find((fit) => fit.name === 'similarity' && fit.landmarkSet === 'confidence >= medium')?.transform ?? null;
  const templateView = renderMannequin(contract, { width: 1024, height: 1536 }, { scale: 1, offsetX: 0, offsetY: 0 }, { joints: true, slots: false, background: [255, 255, 255, 255] });
  const templateScaled = new Raster(width, height, [255, 255, 255, 255]);
  const k = height / 1536;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) templateScaled.blend(x, y, templateView.pixel(Math.floor(x / k - (width / k - 1024) / 2), Math.floor(y / k)));
  const toPanel = (j: Joint): Joint => ({ x: j.x * k + (width - 1024 * k) / 2, y: j.y * k });
  const skeletonPairs: [string, string][] = [
    ['shoulder', 'elbow'],
    ['elbow', 'wrist'],
    ['hip', 'knee'],
    ['knee', 'ankle'],
    ['ankle', 'foot_anchor']
  ];
  const characterSkeleton = faded(visible, 0.35);
  for (const side of sides) {
    for (const [a, b] of skeletonPairs) {
      const pa = p(`${a}_${side}`)?.point;
      const pb = p(`${b}_${side}`)?.point;
      if (pa && pb) characterSkeleton.line(pa, pb, 4, sideColor(side));
    }
    const shoulder = p(`shoulder_${side}`)?.point;
    const neckBase = p('neck_base')?.point;
    if (shoulder && neckBase) characterSkeleton.line(neckBase, shoulder, 4, [20, 150, 60, 255]);
  }
  const chin = p('chin')?.point;
  const neckBase = p('neck_base')?.point;
  if (chin && neckBase) characterSkeleton.line(neckBase, chin, 4, [20, 150, 60, 255]);
  drawLandmarks(characterSkeleton, landmarks, true);
  legend(characterSkeleton, ['b. character skeleton from known landmarks only', 'missing lines = unknown joints (no guessed bones)']);
  const near = correspondence('near_is_image_left');
  for (const [id, ref] of near) {
    if (!ref) continue;
    const target = templatePoint(contract, ref);
    if (!target) continue;
    const at = toPanel(target);
    templateScaled.fillCircle(at, 6, sideColor(id));
    drawText(templateScaled, shortLabel(id), at.x + 9, at.y - 4, 1, [0, 0, 0, 255], [255, 255, 255, 200]);
  }
  legend(templateScaled, ['b. c0.5 template (contract joints)', 'labels use the same names under the hypothesis', 'near = image left (blue)']);
  png('b-skeleton-comparison.png', sheetOf([[templateScaled, characterSkeleton]], 16));

  // C: alignment diagnostics: template joints mapped into the image by the inverse similarity fit, with error lines.
  const diagnostics = faded(visible, 0.35);
  if (similarityFit) {
    const inverse = invert(similarityFit);
    for (const pair of best?.pairs ?? []) {
      const mapped = applyAffine(inverse, pair.templatePoint);
      diagnostics.line(pair.character, mapped, 2, [200, 0, 0, 255]);
      diagnostics.fillCircle(mapped, 5, [120, 0, 160, 255]);
      diagnostics.fillCircle(pair.character, 5, sideColor(pair.id));
      const mappedCharacter = applyAffine(similarityFit, pair.character);
      const errorPct = (Math.hypot(mappedCharacter.x - pair.templatePoint.x, mappedCharacter.y - pair.templatePoint.y) / bodyHeight) * 100;
      const inFit = confidenceRank[pair.confidence] >= confidenceRank.medium;
      drawText(diagnostics, `${shortLabel(pair.id)} ${errorPct.toFixed(1)}%${inFit ? '' : ' (low, not in fit)'}`, pair.character.x + 8, pair.character.y + 6, 1, [0, 0, 0, 255], [255, 255, 255, 200]);
    }
    const bones: [string, string][] = [...contract.bones.values()]
      .filter((bone) => bone.parent && !['root', 'aim'].includes(bone.parent) && !['aim', 'weapon_grip'].includes(bone.id))
      .map((bone) => [bone.parent as string, bone.id]);
    for (const [from, to] of bones) {
      const a = contract.bones.get(from)?.joint;
      const b = contract.bones.get(to)?.joint;
      if (a && b) diagnostics.line(applyAffine(inverse, a), applyAffine(inverse, b), 2, [120, 0, 160, 160]);
    }
  }
  legend(diagnostics, [
    'c. alignment: purple = c0.5 joints after the similarity fit',
    'colored dot = character landmark, red line = error',
    'fit: medium+ landmarks, near = image left. % of body height'
  ]);
  png('c-alignment-diagnostics.png', diagnostics);

  // D: proposed segmentation map (lines only, no cut).
  const segmentation = faded(visible, 0.5);
  for (const cut of cuts) {
    const here = cut.at;
    const color: Color = cut.status === 'candidate' ? [0, 160, 60, 255] : cut.status === 'hypothesis' ? [230, 160, 0, 255] : [200, 0, 0, 255];
    if (!here) {
      if (cut.range) dashedRect(segmentation, cut.range, color);
      continue;
    }
    const next = cut.axisTo ? p(cut.axisTo)?.point : null;
    const angle = next ? Math.atan2(next.y - here.y, next.x - here.x) : Math.PI / 2;
    const nx = -Math.sin(angle);
    const ny = Math.cos(angle);
    segmentation.line({ x: here.x - nx * 40, y: here.y - ny * 40 }, { x: here.x + nx * 40, y: here.y + ny * 40 }, 4, color);
    ring(segmentation, here, 24 * (1 / (similarityFit ? decompose(similarityFit).s1 : 1)), 1, color);
  }
  legend(segmentation, [
    'd. proposed cut lines (not cut). green = candidate (medium+)',
    'yellow = hypothesis (low), red box = blocked (joint unknown)',
    'thin ring = c0.5 overlap radius 24 px, scaled to the image'
  ]);
  png('d-segmentation-map.png', segmentation);

  // E: uncertainty map.
  const uncertainty = faded(visible, 0.4);
  const shade = (range: Range, color: Color): void => {
    for (let y = Math.max(0, Math.floor(range.top)); y < Math.min(height, Math.ceil(range.bottom)); y += 1)
      for (let x = Math.max(0, Math.floor(range.left)); x < Math.min(width, Math.ceil(range.right)); x += 1) uncertainty.blend(x, y, color);
  };
  for (const region of measured.regions) shade(region.range, region.id === 'merged_thighs' ? [230, 0, 0, 90] : [230, 120, 0, 50]);
  for (const item of landmarks) {
    if (item.visibility === 'unknown' && item.range) shade(item.range, [200, 0, 200, 50]);
    if (item.point && item.confidence === 'low') ring(uncertainty, item.point, 30, 3, [230, 160, 0, 255]);
    if (item.point && item.visibility === 'occluded') ring(uncertainty, item.point, 18, 2, [0, 120, 220, 255]);
  }
  legend(uncertainty, [
    'e. uncertainty: red = merged thighs, orange = skirt',
    'purple = unknown joint range, yellow ring = low confidence',
    'blue ring = occluded joint (position from nearby geometry)'
  ]);
  png('e-uncertainty-map.png', uncertainty);
  png(
    'contact-sheet.png',
    sheetOf(
      [
        [half(anatomy), half(templateScaled), half(characterSkeleton)],
        [half(diagnostics), half(segmentation), half(uncertainty)]
      ],
      8
    )
  );

  const landmarkFile = {
    format: landmarkFormat,
    frame: metadata.frame,
    image: { name: options.imageName, sha256: sha256(options.imageBytes), pixelSha256: pixelHash(image) },
    note: 'Image sides, y down. Unknown landmarks have no point. Automatic entries use the rules in assumptions.',
    assumptions: studyAssumptions,
    landmarks,
    regions: measured.regions
  };
  const correspondenceFile = {
    format: alignFormat,
    tool: { name: toolName, version: options.toolVersion, command: 'align-study' },
    prototype: true,
    template: { rigId: contract.rigId, contractVersion: contract.contractVersion, sha256: sha256(options.contractBytes), bodyHeightPx: bodyHeight },
    inputs: {
      metadata: { name: options.metadataName, sha256: sha256(options.metadataBytes) },
      image: landmarkFile.image,
      layers: inputs,
      manualLandmarks: options.manualBytes ? sha256(options.manualBytes) : null
    },
    templateAudit,
    templateMissing,
    characterUnknown,
    alignment,
    sideCues: cues,
    completedShare: measured.completedShare,
    cuts,
    files: records
  };
  files.push({ name: 'landmarks.json', bytes: json(landmarkFile) });
  files.push({ name: 'correspondence.json', bytes: json(correspondenceFile) });
  files.push({ name: 'landmarks-manual.template.json', bytes: json(manualTemplate()) });
  const summary = {
    format: alignFormat,
    status: 'PASS' as const,
    landmarks: Object.fromEntries((['visible', 'occluded', 'inferred', 'unknown'] as const).map((v) => [v, landmarks.filter((item) => item.visibility === v).length])),
    fits: alignment.map((item) => ({
      hypothesis: item.hypothesis,
      fits: item.fits.map((fit) => ({ name: fit.name, set: fit.landmarkSet, n: fit.ids.length, mean: fit.meanErrorPctHeight, max: fit.maxErrorPctHeight }))
    })),
    files: files.length
  };
  return { report: summary, files };
}

/** Slot overlap entries of a contract that `parseContractBytes` already accepted. Entries of another shape are skipped. */
export function overlapsOf(bytes: Buffer): { slot: string; childBone: string; radiusPx: number }[] {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isRecord(value) || !Array.isArray(value.slots)) return [];
  return value.slots.flatMap((slot: unknown) => {
    if (!isRecord(slot) || typeof slot.id !== 'string' || !Array.isArray(slot.overlap)) return [];
    const id = slot.id;
    return slot.overlap.flatMap((item: unknown) =>
      isRecord(item) && typeof item.childBone === 'string' && typeof item.radiusPx === 'number' && Number.isFinite(item.radiusPx)
        ? [{ slot: id, childBone: item.childBone, radiusPx: item.radiusPx }]
        : []
    );
  });
}

function invert(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, tx: -(a * m.tx + b * m.ty), ty: -(c * m.tx + d * m.ty) };
}
