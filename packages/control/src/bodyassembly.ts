import { applyAffine, fitSimilarity } from '@control/align';
import { type Landmark, landmarkFormat, parseManualLandmarks } from '@control/alignstudy';
import {
  animationLength,
  type BodyAnimation,
  type BodyBoneSpec,
  type BodyRigSpec,
  type BodySlotSpec,
  buildBodySkeleton,
  checkBodySkeleton,
  poseAt,
  type RegionImage,
  renderPose
} from '@control/bodyrig';
import { type CommandResult, json, sheetOf } from '@control/commands';
import type { Joint } from '@control/contract';
import { buildVariant, regionsOf, variantSpecs } from '@control/jointgeometry';
import { checker, composite, half, splitTargets } from '@control/layersplit';
import { cross, cutArm, foreLabel, handLabel, type LimbStudyOptions, prepareLimb, residualLabel, titled, upperLabel } from '@control/limbstudy';
import type { PlannedFile } from '@control/output';
import { decodePng, encodePng, pixelHash, sha256 } from '@control/png';
import { ControlError, fail, isRecord } from '@control/problems';
import { type Color, Raster } from '@control/raster';
import { alphaBounds, cropBox, differentPixels, manifests, paddedUnion } from '@control/spinearm';
import { type Check, type ImageBox, skeletonBytes, type SpineFrame, toImage, type WorldBone, worldBones } from '@control/spineskeleton';
import { checkConservation, defaultSplitOptions, extractLabel, splitLayer } from '@control/split';

// `assemble-body` (MVP-A, prototype): assembles one full-body test character for Spine Essential 4.3 from the existing L0 results
// (See-through layers, L0-1b layer split, L0-1c/d manual landmarks, L0-1e near-arm cut, L0-1g tube underlay) on the bones and slots of
// the C0.5 candidate contract. Each See-through pixel goes to exactly one slot image. The result is a Spine skeleton JSON, region PNGs,
// a character.json sidecar, two demonstration animations (idle, wave), evidence, and previews. It does not run Spine: the package is
// JSON_GENERATED only. spine-validate with a real Spine executable gives CLI_VALIDATED.

export const assemblyFormat = 'aigg.mvp-a.full-body/0.1';
export const skeletonPath = 'spine/skeleton.json';
export const imageDirectory = 'spine/images';
/** Transparent margin around the alpha bounds of each slot image. */
export const cropPadding = 2;
/** The setup pose may differ from the source composite in at most this share of the character pixels before the check is a FAIL. */
export const sourceDifferenceLimit = 0.05;

type SlotInfo = { readonly id: string; readonly bone: string; readonly drawOrder: number; readonly required: boolean };

/** Reads the slots with `required` from the contract bytes (the control contract parser does not keep `required`). */
export function contractSlots(bytes: Buffer): SlotInfo[] {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isRecord(value) || !Array.isArray(value.slots)) fail('E_CONTRACT', 'The contract has no slots.');
  return value.slots
    .map((slot: unknown) => {
      if (!isRecord(slot) || typeof slot.id !== 'string' || typeof slot.bone !== 'string' || typeof slot.drawOrder !== 'number') fail('E_CONTRACT', 'A contract slot needs id, bone, and drawOrder.');
      return { id: slot.id, bone: slot.bone, drawOrder: slot.drawOrder, required: slot.required === true };
    })
    .sort((a, b) => a.drawOrder - b.drawOrder);
}

/** How a See-through layer goes to slots. `slot`: the whole layer. Other kinds have their own split rule below. */
export type LayerRule = { readonly kind: 'slot'; readonly slot: string } | { readonly kind: 'arms' | 'legs' | 'feet' | 'topwear' | 'bottomwear' | 'far_hand_object' };
export const layerRules: Readonly<Record<string, LayerRule>> = {
  'back hair': { kind: 'slot', slot: 'hair_back' },
  'front hair': { kind: 'slot', slot: 'hair_front' },
  face: { kind: 'slot', slot: 'head' },
  ears: { kind: 'slot', slot: 'head' },
  eyebrow: { kind: 'slot', slot: 'head' },
  eyelash: { kind: 'slot', slot: 'head' },
  eyewhite: { kind: 'slot', slot: 'head' },
  irides: { kind: 'slot', slot: 'head' },
  nose: { kind: 'slot', slot: 'head' },
  mouth: { kind: 'slot', slot: 'head' },
  eyewear: { kind: 'slot', slot: 'head' },
  earwear: { kind: 'slot', slot: 'head' },
  headwear: { kind: 'slot', slot: 'acc_head' },
  neck: { kind: 'slot', slot: 'neck' },
  neckwear: { kind: 'slot', slot: 'torso' },
  tail: { kind: 'slot', slot: 'tail' },
  handwear: { kind: 'arms' },
  legwear: { kind: 'legs' },
  footwear: { kind: 'feet' },
  topwear: { kind: 'topwear' },
  bottomwear: { kind: 'bottomwear' },
  objects: { kind: 'far_hand_object' }
};

/**
 * Pixel moves for the draw order: a pixel of slot A that an opaque pixel of a higher source layer in slot B covers goes into the image of
 * B (under that layer), when the contract draws A over B. The pixel is hidden in the source, so the setup pose keeps the source look.
 * Only these pairs: a child segment receives the hidden pixels of its parent segment (shin -> foot, forearm -> hand, upper arm -> forearm),
 * and the hips receive the hidden thigh tops under the skirt.
 */
export const transferPairs: readonly (readonly [string, string])[] = [
  ['shin_near', 'foot_near'],
  ['shin_far', 'foot_far'],
  ['thigh_near', 'hips'],
  ['thigh_far', 'hips'],
  ['upper_arm_far', 'forearm_far'],
  ['forearm_far', 'hand_far'],
  ['upper_arm_near', 'forearm_near'],
  ['forearm_near', 'hand_near']
];

/** Where a joint comes from. `landmark`: a manual mark. `derived`: a rule on manual marks. `contract_estimate`: the contract joint mapped by a similarity fit. */
export type JointSource = 'landmark' | 'derived' | 'contract_estimate' | 'frame';
export type JointRecord = {
  readonly bone: string;
  readonly joint: Joint;
  readonly end: Joint | null;
  readonly source: JointSource;
  readonly uncertainty: 'low' | 'medium' | 'high';
  readonly rule: string;
};

const mid = (a: Joint, b: Joint): Joint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const lerp = (a: Joint, b: Joint, t: number): Joint => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const r4 = (value: number): number => Math.round(value * 1e4) / 1e4;
const rp = (p: Joint): Joint => ({ x: r4(p.x), y: r4(p.y) });

/** Projection of `p` on the line a -> b, as a share of |b - a|. */
function along(a: Joint, b: Joint, p: Joint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
}

/** Distance from p to the segment a-b. */
export function segmentDistance(p: Joint, a: Joint, b: Joint): number {
  const t = Math.max(0, Math.min(1, along(a, b, p)));
  return Math.hypot(p.x - (a.x + (b.x - a.x) * t), p.y - (a.y + (b.y - a.y) * t));
}

/** The centroid of the pixels with alpha above 0, or null. */
export function centroid(raster: Raster): Joint | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let p = 0; p < raster.width * raster.height; p += 1) {
    if ((raster.data[p * 4 + 3] ?? 0) === 0) continue;
    sx += (p % raster.width) + 0.5;
    sy += Math.floor(p / raster.width) + 0.5;
    n += 1;
  }
  return n === 0 ? null : { x: sx / n, y: sy / n };
}

/**
 * Nearest-label fill: each pixel of `targets` gets the label of the nearest labeled seed pixel (8-neighbor steps over the whole canvas, a
 * breadth-first search in pixel order, so the result is deterministic). Seeds are the pixels with a label in `seedLabels`.
 * Pixels that no seed reaches keep label 0.
 */
export function nearestLabelFill(labels: Uint8Array, targets: Uint8Array, seedLabels: ReadonlySet<number>, width: number, height: number): { labels: Uint8Array; filled: number } {
  const out = Uint8Array.from(labels);
  const from = new Uint8Array(labels.length);
  const queue = new Int32Array(labels.length);
  let head = 0;
  let tail = 0;
  for (let p = 0; p < labels.length; p += 1) {
    if (targets[p] === 1 || !seedLabels.has(labels[p] as number)) continue;
    from[p] = labels[p] as number;
    queue[tail++] = p;
  }
  while (head < tail) {
    const p = queue[head++] as number;
    const x = p % width;
    const y = (p - x) / width;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (from[q] !== 0) continue;
        from[q] = from[p] as number;
        queue[tail++] = q;
      }
    }
  }
  let filled = 0;
  for (let p = 0; p < labels.length; p += 1) {
    if (targets[p] !== 1) continue;
    out[p] = from[p] as number;
    if (from[p] !== 0) filled += 1;
  }
  return { labels: out, filled };
}

const alphaOf = (raster: Raster, p: number): number => raster.data[p * 4 + 3] ?? 0;
const maskOf = (raster: Raster): Uint8Array => Uint8Array.from({ length: raster.width * raster.height }, (_, p) => (alphaOf(raster, p) > 0 ? 1 : 0));

/** A limb cut into three segments with the L0-1e rule (cutArm). Residual pixels go to the nearest segment. */
function cutLimb(limb: Raster, a: Joint, b: Joint, c: Joint): { labels: Uint8Array; residualFilled: number; fallback: string | null } {
  const { width, height } = limb;
  const mask = maskOf(limb);
  let assignment: Uint8Array;
  let fallback: string | null = null;
  try {
    assignment = cutArm(limb, a, b, c).assignment;
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    // No pixels past the last joint: two segments, cut on the bisector at the middle joint.
    fallback = 'two_segments';
    assignment = new Uint8Array(width * height);
    const u = { x: b.x - a.x, y: b.y - a.y };
    const v = { x: c.x - b.x, y: c.y - b.y };
    const lu = Math.hypot(u.x, u.y) || 1;
    const lv = Math.hypot(v.x, v.y) || 1;
    const normal = { x: u.x / lu + v.x / lv, y: u.y / lu + v.y / lv };
    for (let p = 0; p < mask.length; p += 1) {
      if (mask[p] === 0) continue;
      const x = (p % width) + 0.5;
      const y = Math.floor(p / width) + 0.5;
      assignment[p] = (x - b.x) * normal.x + (y - b.y) * normal.y < 0 ? upperLabel : foreLabel;
    }
  }
  const residual = Uint8Array.from(assignment, (value) => (value === residualLabel ? 1 : 0));
  const fill = nearestLabelFill(assignment, residual, new Set([upperLabel, foreLabel, handLabel]), width, height);
  return { labels: fill.labels, residualFilled: fill.filled, fallback };
}

export type AssemblyInput = LimbStudyOptions;

type LayerState = { readonly tag: string; readonly raster: Raster; readonly labels: Uint8Array; readonly rule: string };

/** The joints of all contract bones in image px. Missing marks fail, except the far shoulder (an estimate). */
export function bodyJoints(manual: readonly Landmark[], contractBytes: Buffer, frameOrigin: Joint, hands: { near: Joint; far: Joint }): JointRecord[] {
  const contract: unknown = JSON.parse(contractBytes.toString('utf8'));
  if (!isRecord(contract) || !Array.isArray(contract.bones)) fail('E_CONTRACT', 'The contract has no bones.');
  const cb = new Map<string, { parent: string | null; joint: Joint }>();
  for (const bone of contract.bones as unknown[]) {
    if (!isRecord(bone) || typeof bone.id !== 'string' || !isRecord(bone.joint) || typeof bone.joint.x !== 'number' || typeof bone.joint.y !== 'number')
      fail('E_CONTRACT', 'A contract bone is not valid.');
    cb.set(bone.id, { parent: typeof bone.parent === 'string' ? bone.parent : null, joint: { x: bone.joint.x, y: bone.joint.y } });
  }
  const points = new Map<string, Joint>();
  if (Array.isArray(contract.points))
    for (const point of contract.points as unknown[])
      if (isRecord(point) && typeof point.id === 'string' && isRecord(point.position) && typeof point.position.x === 'number' && typeof point.position.y === 'number')
        points.set(point.id, { x: point.position.x, y: point.position.y });
  const mark = (id: string): Joint | null => {
    const item = manual.find((entry) => entry.id === id);
    return item?.point ?? null;
  };
  const need = (id: string): Joint => {
    const point = mark(id);
    if (!point) fail('E_LANDMARK', `The manual landmark file has no point for ${id}. MVP-A needs the body marks of L0-1d.`);
    return point;
  };
  const cj = (id: string): Joint => {
    const bone = cb.get(id);
    if (!bone) fail('E_CONTRACT', `The contract has no bone ${id}.`);
    return bone.joint;
  };
  const records = new Map<string, JointRecord>();
  const set = (bone: string, joint: Joint, end: Joint | null, source: JointSource, uncertainty: JointRecord['uncertainty'], rule: string): void => {
    records.set(bone, { bone, joint: rp(joint), end: end ? rp(end) : null, source, uncertainty, rule });
  };
  const hipL = need('hip_image_left');
  const hipR = need('hip_image_right');
  const neckBase = need('neck_base');
  const headTop = need('head_top');
  const hips = mid(hipL, hipR);
  // Torso joints on the hips -> neck line at the shares of the contract joints (C0.5 proportions).
  const share = (id: string, from: string, to: string): number => along(cj(from), cj(to), cj(id));
  const spine = lerp(hips, neckBase, share('spine', 'hips', 'neck'));
  const chest = lerp(hips, neckBase, share('chest', 'hips', 'neck'));
  const headTopContract = points.get('head_top');
  const head = lerp(neckBase, headTop, headTopContract ? along(cj('neck'), headTopContract, cj('head')) : 0.25);
  const shoulderL = need('shoulder_image_left');
  const elbowL = need('elbow_image_left');
  const wristL = need('wrist_image_left');
  const elbowR = need('elbow_image_right');
  const wristR = need('wrist_image_right');
  const markedShoulderR = mark('shoulder_image_right');
  // Far shoulder (hidden in the L0 concept): from the far elbow toward the far sleeve end, with the length of the near upper arm.
  const sleeveR = mark('sleeve_end_image_right');
  let shoulderR: Joint;
  let shoulderRule: string;
  if (markedShoulderR) {
    shoulderR = markedShoulderR;
    shoulderRule = 'manual mark shoulder_image_right';
  } else if (sleeveR) {
    const length = Math.hypot(elbowL.x - shoulderL.x, elbowL.y - shoulderL.y);
    const dx = sleeveR.x - elbowR.x;
    const dy = sleeveR.y - elbowR.y;
    const n = Math.hypot(dx, dy) || 1;
    shoulderR = { x: elbowR.x + (dx / n) * length, y: elbowR.y + (dy / n) * length };
    shoulderRule = 'estimate: far elbow + (near upper arm length) x direction(far elbow -> sleeve_end_image_right); the far shoulder is hidden';
  } else {
    shoulderR = { x: 2 * neckBase.x - shoulderL.x, y: shoulderL.y };
    shoulderRule = 'estimate: near shoulder mirrored at the neck base x; the far shoulder is hidden';
  }
  set('root', frameOrigin, null, 'frame', 'low', 'Spine origin: bottom center of the source canvas (M0-F0a convention)');
  set('hips', hips, spine, 'derived', 'medium', 'middle of hip_image_left and hip_image_right (both marks are occluded, medium confidence)');
  set('spine', spine, chest, 'derived', 'medium', 'hips -> neck_base line at the C0.5 contract share of the spine joint');
  set('chest', chest, neckBase, 'derived', 'medium', 'hips -> neck_base line at the C0.5 contract share of the chest joint');
  set('neck', neckBase, head, 'landmark', 'low', 'neck_base');
  set('head', head, headTop, 'derived', 'medium', 'neck_base -> head_top line at the C0.5 contract share of the head joint');
  set('upper_arm_near', shoulderL, elbowL, 'landmark', 'low', 'shoulder_image_left -> elbow_image_left');
  set('forearm_near', elbowL, wristL, 'landmark', 'low', 'elbow_image_left -> wrist_image_left');
  set('hand_near', wristL, hands.near, 'landmark', 'low', 'wrist_image_left -> centroid of the near hand part (direction only)');
  set('upper_arm_far', shoulderR, elbowR, markedShoulderR ? 'landmark' : 'derived', markedShoulderR ? 'low' : 'high', shoulderRule);
  set('forearm_far', elbowR, wristR, 'landmark', 'low', 'elbow_image_right -> wrist_image_right');
  set('hand_far', wristR, hands.far, 'landmark', 'low', 'wrist_image_right -> centroid of the far hand part without the held object (direction only)');
  for (const [side, image] of [
    ['near', 'image_left'],
    ['far', 'image_right']
  ] as const) {
    const hip = side === 'near' ? hipL : hipR;
    const knee = need(`knee_${image}`);
    const ankle = need(`ankle_${image}`);
    const toe = need(`foot_anchor_${image}`);
    set(`thigh_${side}`, hip, knee, 'landmark', 'medium', `hip_${image} (occluded mark) -> knee_${image}`);
    set(`shin_${side}`, knee, ankle, 'landmark', 'low', `knee_${image} -> ankle_${image}`);
    set(`foot_${side}`, ankle, toe, 'landmark', 'low', `ankle_${image} -> foot_anchor_${image}`);
  }
  // Other contract bones (no marks): the contract joint mapped by the similarity fit of the marked joints.
  const fitted = [...records.values()].filter((item) => item.source === 'landmark' && cb.has(item.bone));
  const map = fitSimilarity(
    fitted.map((item) => cj(item.bone)),
    fitted.map((item) => item.joint)
  );
  if (!map) fail('E_GEOMETRY', 'The similarity fit of the contract joints failed.');
  for (const [id, bone] of cb) {
    if (records.has(id)) continue;
    const child = [...cb].find(([, other]) => other.parent === id && !records.has(other.parent ?? ''));
    const end = child && (id.startsWith('hair_tail') || id.startsWith('tail')) ? applyAffine(map, child[1].joint) : null;
    set(id, applyAffine(map, bone.joint), end, 'contract_estimate', 'high', 'C0.5 contract joint mapped by the similarity fit of the marked joints; no image part uses it in MVP-A');
  }
  return [...cb.keys()].map((id) => records.get(id) as JointRecord);
}

/** The demonstration animations in screen degrees (positive = clockwise on the screen). Not the version 1 animation set. */
export function demoAnimations(bones: ReadonlySet<string>): BodyAnimation[] {
  const track = (bone: string, keys: readonly (readonly [number, number])[]): { bone: string; keys: { time: number; degrees: number }[] } => ({
    bone,
    keys: keys.map(([time, degrees]) => ({ time, degrees }))
  });
  const idle: BodyAnimation = {
    name: 'idle',
    duration: 2,
    tracks: [
      track('spine', [
        [0, 0],
        [1, 1],
        [2, 0]
      ]),
      track('chest', [
        [0, 0],
        [1, 1.5],
        [2, 0]
      ]),
      track('head', [
        [0, 0],
        [1, -3],
        [2, 0]
      ]),
      track('upper_arm_near', [
        [0, 0],
        [1, -3],
        [2, 0]
      ]),
      track('forearm_near', [
        [0, 0],
        [1, -4],
        [2, 0]
      ]),
      track('upper_arm_far', [
        [0, 0],
        [1, 2],
        [2, 0]
      ]),
      track('forearm_far', [
        [0, 0],
        [1, 2],
        [2, 0]
      ])
    ].filter((item) => bones.has(item.bone))
  };
  // Wave with the near (image-left) arm: the far hand holds the object. Upper arm up and out, forearm up, then three waves.
  const wave: BodyAnimation = {
    name: 'wave',
    duration: 2.4,
    tracks: [
      track('upper_arm_near', [
        [0, 0],
        [0.4, 80],
        [2, 80],
        [2.4, 0]
      ]),
      track('forearm_near', [
        [0, 0],
        [0.4, 55],
        [0.7, 35],
        [1, 70],
        [1.3, 35],
        [1.6, 70],
        [2, 55],
        [2.4, 0]
      ]),
      track('hand_near', [
        [0, 0],
        [0.4, 10],
        [0.7, -10],
        [1, 15],
        [1.3, -10],
        [1.6, 15],
        [2, 10],
        [2.4, 0]
      ]),
      track('head', [
        [0, 0],
        [0.4, -4],
        [2, -4],
        [2.4, 0]
      ]),
      track('chest', [
        [0, 0],
        [0.4, 2],
        [2, 2],
        [2.4, 0]
      ])
    ].filter((item) => bones.has(item.bone))
  };
  return [idle, wave];
}

type Built = {
  readonly frame: SpineFrame;
  readonly width: number;
  readonly height: number;
  readonly slots: readonly SlotInfo[];
  readonly images: ReadonlyMap<string, Raster>;
  readonly underlay: ReadonlyMap<string, number>;
  readonly layers: readonly LayerState[];
  readonly joints: readonly JointRecord[];
  readonly source: Raster;
  readonly reports: Record<string, unknown>;
  readonly conservation: Record<string, unknown>[];
  readonly inputs: Record<string, unknown>;
};

/** Labels each See-through layer with slot numbers (index in `slots` + 1), builds the slot images, and finds the joints. */
export function buildAssembly(options: AssemblyInput): Built {
  const context = prepareLimb(options);
  const { width, height } = context;
  const slots = contractSlots(options.contractBytes);
  const slotIndex = new Map(slots.map((slot, index) => [slot.id, index + 1]));
  const label = (slot: string): number => {
    const value = slotIndex.get(slot);
    if (value === undefined) fail('E_CONTRACT', `The contract has no slot ${slot}.`);
    return value;
  };
  const frame: SpineFrame = { origin: { x: width / 2, y: height } };
  const manual = parseManualLandmarks(options.landmarkBytes, { width, height });
  const reports: Record<string, unknown> = {};
  const layers: LayerState[] = [];
  const underlay = new Map<string, Raster>();

  // Near arm: the L0-1e cut at the manual marks and the L0-1g tube underlay (method B), as in M0-F0a.
  const tubeSpec = variantSpecs.find((item) => item.id === 'tube_B');
  if (!tubeSpec) throw new Error('The tube_B variant is missing.');
  const tube = buildVariant(context, regionsOf(context), tubeSpec);
  if (tube.changedSource !== 0 || tube.outsideRegion !== 0) fail('E_UNDERLAY', 'The tube underlay changed source pixels.');
  const nearSlots = ['upper_arm_near', 'forearm_near', 'hand_near'] as const;
  nearSlots.forEach((slot, index) => {
    const base = context.parts[index] as Raster;
    const withTube = tube.parts[index] as Raster;
    const extra = new Raster(width, height);
    let added = 0;
    for (let p = 0; p < width * height; p += 1) {
      if (alphaOf(base, p) === 0 && alphaOf(withTube, p) > 0) {
        extra.data.set(withTube.data.subarray(p * 4, p * 4 + 4), p * 4);
        added += 1;
      }
    }
    if (added > 0) underlay.set(slot, extra);
  });

  // Far hand direction: centroid of the far hand segment (handwear only).
  const handwear = context.handwear;
  const nearArmMask = maskOf(context.arm);
  const farArm = new Raster(width, height);
  for (let p = 0; p < width * height; p += 1) if (nearArmMask[p] === 0 && alphaOf(handwear, p) > 0) farArm.data.set(handwear.data.subarray(p * 4, p * 4 + 4), p * 4);
  const mark = (id: string): Joint => {
    const point = manual.find((entry) => entry.id === id)?.point;
    if (!point) fail('E_LANDMARK', `The manual landmark file has no point for ${id}.`);
    return point;
  };
  const preliminary = bodyJoints(manual, options.contractBytes, frame.origin, { near: { x: 0, y: 0 }, far: { x: 0, y: 0 } });
  const jointOf = (bone: string, list: readonly JointRecord[] = preliminary): Joint => (list.find((item) => item.bone === bone) as JointRecord).joint;
  const farCut = cutLimb(farArm, jointOf('upper_arm_far'), mark('elbow_image_right'), mark('wrist_image_right'));
  const farHand = extractLabel(farArm, farCut.labels, handLabel);
  const nearHandCentroid = centroid(context.parts[2] as Raster);
  const farHandCentroid = centroid(farHand);
  if (!nearHandCentroid || !farHandCentroid) fail('E_GEOMETRY', 'A hand segment is empty.');
  const joints = bodyJoints(manual, options.contractBytes, frame.origin, { near: nearHandCentroid, far: farHandCentroid });
  const at = (bone: string): Joint => jointOf(bone, joints);

  for (const tag of context.order) {
    const raster = context.layers.get(tag);
    if (!raster) continue;
    const mask = maskOf(raster);
    const labels = new Uint8Array(width * height);
    const rule = layerRules[tag];
    let ruleText: string;
    if (!rule) {
      // Unknown layer: each connected part goes to the slot of the nearest bone joint (fallback, reported).
      const c = centroid(raster);
      if (!c) continue;
      const nearest = slots
        .filter((slot) => joints.some((item) => item.bone === slot.bone && item.source !== 'contract_estimate'))
        .map((slot) => ({ slot, d: Math.hypot(at(slot.bone).x - c.x, at(slot.bone).y - c.y) }))
        .sort((a, b) => a.d - b.d || a.slot.drawOrder - b.slot.drawOrder)[0];
      if (!nearest) continue;
      for (let p = 0; p < mask.length; p += 1) if (mask[p] === 1) labels[p] = label(nearest.slot.id);
      ruleText = `fallback: unknown See-through tag, whole layer to ${nearest.slot.id} (nearest bone joint to the layer centroid)`;
    } else if (rule.kind === 'slot') {
      for (let p = 0; p < mask.length; p += 1) if (mask[p] === 1) labels[p] = label(rule.slot);
      ruleText = `whole layer to ${rule.slot}`;
    } else if (rule.kind === 'arms') {
      // Near arm: the L0-1e cut. Far arm: the same cut rule at the far marks and the estimated far shoulder. Then all residual pixels of
      // the layer (fragments, crossed cut lines, cut islands) go to the nearest arm segment.
      const near = context.cut.assignment;
      const arm = [label('upper_arm_near'), label('forearm_near'), label('hand_near')];
      const far = [label('upper_arm_far'), label('forearm_far'), label('hand_far')];
      const residual = new Uint8Array(width * height);
      for (let p = 0; p < mask.length; p += 1) {
        if (mask[p] === 0) continue;
        if (nearArmMask[p] === 1) {
          const value = near[p] as number;
          if (value >= upperLabel && value <= handLabel) labels[p] = arm[value - 1] as number;
          else residual[p] = 1;
        } else {
          const value = farCut.labels[p] as number;
          if (value >= upperLabel && value <= handLabel) labels[p] = far[value - 1] as number;
          else residual[p] = 1;
        }
      }
      const fill = nearestLabelFill(labels, residual, new Set([...arm, ...far]), width, height);
      labels.set(fill.labels);
      reports.arms = { nearArm: 'L0-1e cut (no change)', farArm: farCut.fallback ?? 'L0-1e cut rule at the far marks', residualPixelsToNearestSegment: fill.filled };
      ruleText = 'arms: near arm L0-1e cut + L0-1g tube underlay; far arm cut at the far marks; residual to the nearest segment';
    } else if (rule.kind === 'legs' || rule.kind === 'feet') {
      // The L0-1b options: scan rows for legwear (merged thighs), not for footwear.
      const split = splitLayer(raster, { ...defaultSplitOptions, scanRows: splitTargets.find((target) => target.layer === tag)?.scanRows ?? false });
      if (split.status !== 'split' || split.parts.length !== 2) fail('E_LAYER', `${tag} does not split into two sides.`);
      const sideLabels = new Uint8Array(width * height);
      for (let p = 0; p < mask.length; p += 1) {
        const value = split.assignment[p] as number;
        if (mask[p] === 1 && (value === 1 || value === 2)) sideLabels[p] = value;
      }
      const residual = Uint8Array.from(mask, (value, p) => (value === 1 && sideLabels[p] === 0 ? 1 : 0));
      const sides = nearestLabelFill(sideLabels, residual, new Set([1, 2]), width, height);
      // Parts are in image order: label 1 is image left = near (C0.5: near limbs on the image left).
      if (rule.kind === 'feet') {
        for (let p = 0; p < mask.length; p += 1) if (mask[p] === 1) labels[p] = sides.labels[p] === 1 ? label('foot_near') : label('foot_far');
        reports.feet = { method: split.method, residualPixelsToNearestSide: sides.filled };
        ruleText = 'feet: L0-1b split into image-left (near) and image-right (far) shoes';
      } else {
        const legReport: Record<string, unknown> = { method: split.method, mergedOrResidualPixelsToNearestSide: sides.filled };
        for (const [side, value] of [
          ['near', 1],
          ['far', 2]
        ] as const) {
          const leg = extractLabel(raster, sides.labels, value);
          const cut = cutLimb(leg, at(`thigh_${side}`), at(`shin_${side}`), at(`foot_${side}`));
          const targets = [label(`thigh_${side}`), label(`shin_${side}`), label(`foot_${side}`)];
          for (let p = 0; p < mask.length; p += 1) if (sides.labels[p] === value && mask[p] === 1) labels[p] = (targets[(cut.labels[p] as number) - 1] ?? targets[0]) as number;
          legReport[side] = { fallback: cut.fallback, residualPixelsToNearestSegment: cut.residualFilled };
        }
        reports.legs = legReport;
        ruleText = 'legs: L0-1b split (merged thigh pixels to the nearest side), then the L0-1e cut rule at hip, knee, and ankle';
      }
    } else if (rule.kind === 'topwear') {
      // Sleeves: topwear pixels nearer to an upper-arm segment than to the torso axis, on the outer side of the shoulder, go with the arm.
      const neck = at('neck');
      const hips = at('hips');
      const axis = { x: hips.x - neck.x, y: hips.y - neck.y };
      const axisLength = Math.hypot(axis.x, axis.y);
      const side = (p: Joint): number => ((p.x - neck.x) * axis.y - (p.y - neck.y) * axis.x) / axisLength;
      const arms = (['near', 'far'] as const).map((name) => {
        const shoulder = at(`upper_arm_${name}`);
        const elbow = at(`forearm_${name}`);
        return { name, shoulder, elbow, side: side(shoulder), slot: label(`upper_arm_${name}`) };
      });
      let sleeves = 0;
      for (let p = 0; p < mask.length; p += 1) {
        if (mask[p] === 0) continue;
        const point = { x: (p % width) + 0.5, y: Math.floor(p / width) + 0.5 };
        labels[p] = label('torso');
        const torsoDistance = segmentDistance(point, neck, hips);
        for (const arm of arms) {
          const s = side(point);
          const t = along(arm.shoulder, arm.elbow, point);
          if (Math.sign(s) !== Math.sign(arm.side) || Math.abs(s) < 0.5 * Math.abs(arm.side) || t < -0.25 || t > 1.05) continue;
          if (segmentDistance(point, arm.shoulder, arm.elbow) < torsoDistance) {
            labels[p] = arm.slot;
            sleeves += 1;
            break;
          }
        }
      }
      reports.topwear = {
        sleevePixels: sleeves,
        rule: 'nearer to the shoulder-elbow segment than to the neck-hips axis, on the arm side beyond half the shoulder offset, between the shoulder and the elbow'
      };
      ruleText = 'topwear: torso; sleeve pixels to the upper arm slots (nearest-segment rule)';
    } else if (rule.kind === 'bottomwear') {
      // The skirt: above the line through the hip marks to hips (waist), below it to skirt_front. Both move with the pelvis.
      const a = mark('hip_image_left');
      const b = mark('hip_image_right');
      const sideOf = (x: number, y: number): number => (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      const neckSide = Math.sign(sideOf(at('neck').x, at('neck').y));
      let upper = 0;
      for (let p = 0; p < mask.length; p += 1) {
        if (mask[p] === 0) continue;
        const above = Math.sign(sideOf((p % width) + 0.5, Math.floor(p / width) + 0.5)) === neckSide;
        labels[p] = above ? label('hips') : label('skirt_front');
        if (above) upper += 1;
      }
      reports.bottomwear = { hipsPixels: upper, skirtFrontPixels: [...mask].filter((value) => value === 1).length - upper };
      ruleText = 'bottomwear (skirt): above the hip line to hips, below it to skirt_front';
    } else {
      // The held object (the sword) goes into the far hand image: the contract weapon slot is on weapon_grip under hand_near.
      for (let p = 0; p < mask.length; p += 1) if (mask[p] === 1) labels[p] = label('hand_far');
      ruleText = 'held object: whole layer to hand_far (the contract weapon slot is on the near hand; the object is in the far hand)';
    }
    layers.push({ tag, raster, labels, rule: ruleText });
  }

  // Draw-order moves (see transferPairs). Walk each pixel from the top source layer down and remember the opaque slots above.
  const drawIndex = new Map(slots.map((slot) => [label(slot.id), slot.drawOrder]));
  const pairs = new Map<number, Set<number>>();
  for (const [from, to] of transferPairs) {
    if (!slotIndex.has(from) || !slotIndex.has(to)) continue;
    const set = pairs.get(label(from)) ?? new Set<number>();
    set.add(label(to));
    pairs.set(label(from), set);
  }
  const moved: Record<string, number> = {};
  for (let p = 0; p < width * height; p += 1) {
    const opaqueAbove: number[] = [];
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const layer = layers[index] as LayerState;
      const value = layer.labels[p] as number;
      if (value === 0) continue;
      const receivers = pairs.get(value);
      if (receivers) {
        const receiver = opaqueAbove.find((slot) => receivers.has(slot) && (drawIndex.get(value) as number) > (drawIndex.get(slot) as number));
        if (receiver !== undefined) {
          layer.labels[p] = receiver;
          const key = `${slots[value - 1]?.id ?? '?'}->${slots[receiver - 1]?.id ?? '?'}`;
          moved[key] = (moved[key] ?? 0) + 1;
        }
      }
      if (alphaOf(layer.raster, p) === 255) opaqueAbove.push(layer.labels[p] as number);
    }
  }
  reports.drawOrderMoves = { pairs: transferPairs.map(([a, b]) => `${a}->${b}`), movedPixels: moved };

  // Slot images: the underlay first (new pixels only where the part was transparent), then the labeled pixels of each layer in source order.
  const images = new Map<string, Raster>();
  slots.forEach((slot, index) => {
    const image = new Raster(width, height);
    const extra = underlay.get(slot.id);
    let any = false;
    if (extra) {
      image.data.set(extra.data);
      any = true;
    }
    for (const layer of layers) {
      for (let p = 0; p < width * height; p += 1) {
        if (layer.labels[p] !== index + 1) continue;
        const i = p * 4;
        const x = p % width;
        image.blend(x, (p - x) / width, [layer.raster.data[i] ?? 0, layer.raster.data[i + 1] ?? 0, layer.raster.data[i + 2] ?? 0, layer.raster.data[i + 3] ?? 0]);
        any = true;
      }
    }
    if (any) images.set(slot.id, image);
  });

  // Conservation: each layer pixel with alpha above 0 has exactly one slot, with the same RGBA value.
  const conservation = layers.map((layer) => {
    const outputs = slots.map((_, index) => extractLabel(layer.raster, layer.labels, index + 1));
    const result = checkConservation(layer.raster, outputs);
    const perSlot: Record<string, number> = {};
    for (let p = 0; p < width * height; p += 1) {
      const value = layer.labels[p] as number;
      if (value > 0 && alphaOf(layer.raster, p) > 0) perSlot[slots[value - 1]?.id ?? '?'] = (perSlot[slots[value - 1]?.id ?? '?'] ?? 0) + 1;
    }
    return { layer: layer.tag, rule: layer.rule, ...result, slots: perSlot };
  });
  const source = composite(
    width,
    height,
    context.order.map((tag) => context.layers.get(tag)).filter((item): item is Raster => item !== undefined)
  );
  return {
    frame,
    width,
    height,
    slots,
    images,
    underlay: new Map([...underlay].map(([slot, raster]) => [slot, [...maskOf(raster)].filter((value) => value === 1).length])),
    layers,
    joints,
    source,
    reports,
    conservation,
    inputs: { imageSha256: context.imageSha, manualLandmarksSha256: context.landmarkSha, similarityScaleImageToTemplate: context.scale, layers: context.inputs }
  };
}

const red: Color = [230, 0, 0, 255];
const blue: Color = [0, 90, 230, 255];
const magenta: Color = [255, 0, 255, 255];

function onChecker(source: Raster): Raster {
  const out = checker(source.width, source.height);
  out.draw(source, 0, 0);
  return out;
}

/** Bones as lines from each joint to its child joints, with crosses at the joints (posed). */
function drawBones(target: Raster, skeleton: ReturnType<typeof buildBodySkeleton>, frame: SpineFrame, delta: Record<string, number>, used: ReadonlySet<string>): void {
  const world = worldBones(skeleton.bones, delta);
  for (const bone of skeleton.bones) {
    if (!used.has(bone.name)) continue;
    const at = toImage(frame, world.get(bone.name) as WorldBone);
    if (bone.parent && used.has(bone.parent)) {
      const parent = toImage(frame, world.get(bone.parent) as WorldBone);
      target.line(parent, at, 2, blue);
    }
    cross(target, at, red, 5);
  }
}

export type AssemblyResult = { readonly report: CommandResult['report']; readonly files: readonly PlannedFile[] };

/** `assemble-body`: the MVP-A full-body package. */
export function assembleBodyCommand(options: AssemblyInput): CommandResult {
  const built = buildAssembly(options);
  const { frame, width, height, slots, images } = built;
  const boxes = new Map<string, ImageBox>();
  const regionImages = new Map<string, RegionImage>();
  for (const slot of slots) {
    const image = images.get(slot.id);
    const bounds = image ? alphaBounds(image) : null;
    if (!image || !bounds) continue;
    const box = paddedUnion([bounds], cropPadding, width, height);
    boxes.set(slot.id, box);
    regionImages.set(slot.id, { raster: cropBox(image, box), box });
  }
  const boneSpecs: BodyBoneSpec[] = built.joints.map((item) => {
    const parent = JSON.parse(options.contractBytes.toString('utf8')) as { bones: { id: string; parent: string | null }[] };
    return { name: item.bone, parent: parent.bones.find((bone) => bone.id === item.bone)?.parent ?? null, joint: item.joint, end: item.end };
  });
  const slotSpecs: BodySlotSpec[] = slots.map((slot) => ({ name: slot.id, bone: slot.bone, box: boxes.get(slot.id) ?? null }));
  const animations = demoAnimations(new Set(boneSpecs.map((bone) => bone.name)));
  const spec: BodyRigSpec = { frame, bones: boneSpecs, slots: slotSpecs, animations };
  const skeleton = buildBodySkeleton(spec);
  const bytes = skeletonBytes(skeleton);
  const parsed = JSON.parse(bytes.toString('utf8')) as ReturnType<typeof buildBodySkeleton>;
  const checks: Check[] = [...checkBodySkeleton(parsed, spec)];
  const add = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, status: ok ? 'PASS' : 'FAIL', detail });
  };

  // Files: the region PNGs, read back to check the crop.
  const files: PlannedFile[] = [];
  const pngNames = new Map<string, string>();
  let cropOk = true;
  for (const [slot, image] of regionImages) {
    const name = `${imageDirectory}/${slot}.png`;
    const png = encodePng(image.raster);
    files.push({ name, bytes: png });
    pngNames.set(slot, name);
    const back = decodePng(png).raster;
    if (back.width !== image.box.width || back.height !== image.box.height || pixelHash(back) !== pixelHash(image.raster)) cropOk = false;
  }
  files.push({ name: skeletonPath, bytes });
  add(
    'image_files',
    cropOk && [...regionImages.keys()].every((slot) => parsed.skins[0]?.attachments[slot]?.[slot] !== undefined),
    'Each region attachment has a PNG with the region size; the decoded PNG is the cropped slot image.'
  );

  // Critical parts: every required slot has an image, and each body segment has an image.
  const missingRequired = slots.filter((slot) => slot.required && !boxes.has(slot.id)).map((slot) => slot.id);
  add(
    'required_parts',
    missingRequired.length === 0,
    missingRequired.length === 0 ? `All ${slots.filter((slot) => slot.required).length} required slots have an image.` : `E_REQUIRED_PART_ABSENT: ${missingRequired.join(', ')}`
  );

  // Conservation of the source pixels.
  const lost = built.conservation.filter((item) => item.exact !== true);
  add(
    'source_pixel_conservation',
    lost.length === 0,
    lost.length === 0
      ? `Each pixel (alpha above 0) of the ${built.conservation.length} See-through layers is in exactly one slot image with the same RGBA value.`
      : `Not exact: ${lost.map((item) => item.layer).join(', ')}`
  );

  // Setup pose through the skeleton JSON equals the direct composite of the slot images in draw order.
  const direct = composite(
    width,
    height,
    slots.map((slot) => images.get(slot.id)).filter((item): item is Raster => item !== undefined)
  );
  const setup = renderPose(parsed, frame, regionImages, {}, width, height);
  const setupDifference = differentPixels(direct, setup);
  add(
    'setup_pose_render',
    setupDifference.pixels === 0,
    `The skeleton JSON setup pose gives ${setupDifference.pixels} different pixels against the direct composite of the slot images in draw order.`
  );

  // Setup pose against the source composite (the See-through layers in their own order): the draw order of the contract differs.
  const sourceDifference = differentPixels(built.source, direct);
  const characterPixels = [...maskOf(built.source)].filter((value) => value === 1).length;
  const share = characterPixels === 0 ? 1 : sourceDifference.pixels / characterPixels;
  add(
    'source_likeness',
    share <= sourceDifferenceLimit,
    `${sourceDifference.pixels} of ${characterPixels} character pixels (${(share * 100).toFixed(2)} %) differ from the source composite (limit ${sourceDifferenceLimit * 100} %). Cause: the contract draw order and the underlay. See previews/neutral.png.`
  );

  // Sidecar: present parts with their file, absent optional parts.
  const sidecar = {
    schemaVersion: '0.2.0',
    characterId: 'akane_test',
    rigId: (JSON.parse(options.contractBytes.toString('utf8')) as { rigId: string }).rigId,
    parts: Object.fromEntries(slots.map((slot) => [slot.id, boxes.has(slot.id) ? { status: 'present', file: pngNames.get(slot.id) } : { status: 'absent_by_design' }]))
  };
  files.push({ name: 'character.json', bytes: json(sidecar) });

  // Previews (local renderer, not Spine).
  const used = new Set(built.joints.filter((item) => item.source !== 'contract_estimate').map((item) => item.bone));
  const background = checker(width, height);
  const frameAt = (animation: string, time: number, bones = true): Raster => {
    const delta = animation === '' ? {} : poseAt(parsed, animation, time);
    const image = renderPose(parsed, frame, regionImages, delta, width, height, background);
    if (bones) drawBones(image, parsed, frame, delta, used);
    return half(image);
  };
  const differenceMap = onChecker(new Raster(width, height));
  for (let p = 0; p < width * height; p += 1) {
    let d = 0;
    for (let c = 0; c < 4; c += 1) d = Math.max(d, Math.abs((built.source.data[p * 4 + c] ?? 0) - (direct.data[p * 4 + c] ?? 0)));
    if (d > 0) differenceMap.data.set(magenta, p * 4);
    else if (alphaOf(built.source, p) > 0) differenceMap.data.set([150, 150, 150, 255], p * 4);
  }
  const neutral = titled(
    sheetOf(
      [
        [
          titled(half(onChecker(built.source)), 'source composite (See-through layers)'),
          titled(frameAt('', 0, false), 'package setup pose'),
          titled(half(differenceMap), 'difference (magenta)'),
          titled(frameAt('', 0), 'bones (red: joints)')
        ]
      ],
      8
    ),
    'MVP-A neutral pose: local nearest-neighbor renderer, not Spine'
  );
  files.push({ name: 'previews/neutral.png', bytes: encodePng(neutral) });
  for (const animation of animations) {
    const length = animationLength(parsed, animation.name);
    const times = [...new Set(animation.tracks.flatMap((track) => track.keys.map((key) => key.time)))].sort((a, b) => a - b).filter((time) => time < length || length === 0);
    const cells = times.map((time) => titled(frameAt(animation.name, time), `${animation.name} t=${time}s`));
    const rows: Raster[][] = [];
    for (let i = 0; i < cells.length; i += 4) rows.push(cells.slice(i, i + 4));
    files.push({ name: `previews/${animation.name}.png`, bytes: encodePng(titled(sheetOf(rows, 8), `MVP-A ${animation.name}: key poses (local renderer, not Spine)`)) });
  }
  const partCells = slots
    .filter((slot) => regionImages.has(slot.id))
    .map((slot) => {
      const image = regionImages.get(slot.id) as RegionImage;
      const cell = onChecker(new Raster(Math.max(image.box.width, 120), image.box.height));
      cell.draw(image.raster, 0, 0);
      return titled(cell, slot.id);
    });
  const partRows: Raster[][] = [];
  for (let i = 0; i < partCells.length; i += 6) partRows.push(partCells.slice(i, i + 6));
  files.push({ name: 'previews/parts.png', bytes: encodePng(titled(sheetOf(partRows, 8), 'MVP-A slot images in draw order (back to front)')) });

  const status = checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL';
  const toolVersion = options.toolVersion;
  const assembly = {
    format: assemblyFormat,
    prototype: true,
    note: 'MVP-A research candidate. Not a production package, not an approved character, not a rig contract version. The L0 test concept is a licensed test asset: keep this package local.',
    contract: { rigId: sidecar.rigId, slotsAndBones: 'C0.5 candidate contract ids; candidate geometry from the manual marks of the test concept (not the C0.5 joint positions)' },
    coordinates: {
      image: 'Origin at the top-left corner of the source canvas, x right, y down, 1 unit = 1 px.',
      spine: 'Root at the bottom center of the source canvas, x right, y up, 1 Spine unit = 1 image px.',
      origin: frame.origin,
      canvas: { width, height },
      rotation: 'Spine degrees are counterclockwise. Animation angles are designed in screen degrees (clockwise positive); Spine value = -screen degrees.'
    },
    joints: built.joints,
    bones: parsed.bones,
    drawOrder: slots.map((slot) => ({
      slot: slot.id,
      bone: slot.bone,
      required: slot.required,
      status: boxes.has(slot.id) ? 'present' : 'absent_by_design',
      imageBox: boxes.get(slot.id) ?? null,
      underlayPixels: built.underlay.get(slot.id) ?? 0
    })),
    layers: built.conservation.map((item) => ({ layer: item.layer, rule: item.rule, pixels: item.sourcePixels, slots: item.slots })),
    splits: built.reports,
    animations: animations.map((animation) => ({ ...animation, curve: 'linear', note: 'Demonstration only. Not the version 1 animation set.' })),
    knownLimitations: knownLimitations()
  };
  const validation = {
    format: assemblyFormat,
    status,
    levels: { JSON_GENERATED: status, CLI_VALIDATED: 'NOT_RUN', VISUALLY_VALIDATED: 'NOT_RUN' },
    overall: status === 'PASS' ? 'WAITING_FOR_SPINE_CLI_VALIDATION' : 'FAIL',
    note: 'Offline checks with the local TypeScript model of the Spine JSON. They do not replace a Spine CLI import and export.',
    checks,
    metrics: {
      characterPixels,
      setupDifferentPixelsFromSource: sourceDifference.pixels,
      setupDifferentShare: Number(share.toFixed(6)),
      presentSlots: boxes.size,
      absentSlots: slots.filter((slot) => !boxes.has(slot.id)).map((slot) => slot.id),
      animatedBones: [...new Set(animations.flatMap((animation) => animation.tracks.map((track) => track.bone)))]
    },
    conservation: built.conservation
  };
  const provenance = {
    format: assemblyFormat,
    tool: { name: '@aigg/control', version: toolVersion, command: 'assemble-body' },
    inputs: {
      contractSha256: sha256(options.contractBytes),
      metadata: { name: options.metadataName, sha256: sha256(options.metadataBytes) },
      studySha256: sha256(options.studyBytes),
      ...built.inputs
    },
    methods: [
      'L0-1b split-layers (arms, legs, feet into image sides)',
      'L0-1e cutArm at the manual marks (near arm; the same rule for the far arm and the legs)',
      'L0-1g tube underlay, method B (near arm only), new pixels tagged generated_by_deterministic_extension',
      'nearest-label fill for residual and merged pixels (deterministic breadth-first search)',
      'draw-order moves of hidden pixels (transferPairs)'
    ],
    humanInputs: ['L0-1d manual landmarks marked by the owner (no new manual step in MVP-A)'],
    models: 'none (no AI model runs in MVP-A)',
    landmarkFormat
  };
  files.push({ name: 'evidence/assembly.json', bytes: json(assembly) });
  files.push({ name: 'evidence/validation.json', bytes: json(validation) });
  files.push({ name: 'evidence/provenance.json', bytes: json(provenance) });
  files.push({ name: 'README.md', bytes: Buffer.from(packageReadme(status), 'utf8') });
  const all = [...files, ...manifests(files)];
  return {
    report: {
      format: assemblyFormat,
      status,
      levels: validation.levels,
      overall: validation.overall,
      checks: checks.map((check) => ({ id: check.id, status: check.status })),
      metrics: validation.metrics,
      files: all.length
    },
    files: all
  };
}

export function knownLimitations(): string[] {
  return [
    'Candidate geometry: the joints come from the manual marks of the test concept, not from the C0.5 joint positions. Bone and slot ids and the draw order are the C0.5 candidate contract.',
    'The far shoulder is hidden in the concept: its joint is an estimate (high uncertainty).',
    'The hip marks are occluded (medium confidence). The merged upper thighs are split by the nearest-label fill (approximate boundary).',
    'The held sword is in the far hand image (hand_far). The contract weapon slot (weapon_grip under hand_near) stays empty.',
    'The skirt is two attachments on the pelvis (hips above the hip line, skirt_front below). No skirt motion.',
    'Hair is static on the head bone (hair_back, hair_front). The long back hair turns with the head.',
    'The far arm is drawn behind the torso, the skirt, and the legs (contract draw order). Where it is in front in the source, it is hidden.',
    'Only the near arm has a joint underlay (L0-1g tube). Other joints show gaps or seams when they bend. The near shoulder shows a gap in the wave pose.',
    'Sleeves are split from the torso with a nearest-segment rule. The seam can show when the arm moves.',
    'idle and wave are demonstration animations with linear keys. They do not replace the version 1 animation set.',
    'The previews use a local nearest-neighbor renderer. They are not Spine output.'
  ];
}

export function packageReadme(status: string): string {
  return `# MVP-A full-body test package

Research candidate of the MVP vertical slice (MVP-A). Not a production character package, not an approved character, and not a rig contract version.
Offline status: ${status === 'PASS' ? 'JSON_GENERATED (offline checks PASS). Overall: WAITING_FOR_SPINE_CLI_VALIDATION.' : 'FAIL (see evidence/validation.json).'}
The package is not checked in Spine until \`spine-validate\` runs the real Spine executable.

The images are derivatives of a licensed test concept. Keep them local. Do not commit them to Git or publish them.

## Contents

- \`${skeletonPath}\`: Spine 4.3 skeleton JSON (Essential features only: bones, slots, region attachments, draw order, linear rotate keys).
- \`${imageDirectory}/<slot>.png\`: one region image for each present slot.
- \`character.json\`: the part sidecar (present or absent_by_design for each contract slot).
- \`evidence/assembly.json\`: joints with source and uncertainty, bones, draw order, layer-to-slot rules, splits, animations, known limitations.
- \`evidence/validation.json\`: offline checks and metrics.
- \`evidence/provenance.json\`: input hashes, methods, tool version.
- \`previews/neutral.png\`, \`previews/idle.png\`, \`previews/wave.png\`, \`previews/parts.png\`: local renderer previews (not Spine).
- \`SHA256SUMS\` (bytes) and \`PIXEL-SHA256SUMS\` (decoded pixels).

Animations: \`idle\` (2 s, loop) and \`wave\` (2.4 s, near arm). Demonstration only.

## Spine CLI validation (no GUI)

From the repository root, after \`npm ci --ignore-scripts\` and \`npm run build --workspace @aigg/control\`:

\`\`\`sh
node packages/control/dist/src/cli.js spine-validate --spine /Applications/Spine.app/Contents/MacOS/Spine --package <this folder> --out <new folder>
\`\`\`

The command imports \`${skeletonPath}\` into a new \`.spine\` project with the Spine CLI, exports the project to JSON with a texture atlas,
compares the export with the intended skeleton, and writes \`cli-validation.json\` and all logs.

## Optional look in the Spine editor

Open the \`.spine\` project that \`spine-validate\` made, or use Spine > Import Data with \`${skeletonPath}\` and New project checked.
The Images path is \`./images/\` next to the JSON.
`;
}
