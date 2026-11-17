import type { Affine } from '@control/align';
import type { Joint } from '@control/contract';

// Spine skeleton JSON for experiment M0-F0a (prototype): a minimal three-bone arm (upper arm, forearm, hand) with region attachments and
// linear rotate keys. Only the Spine Essential feature set: bones, slots, region attachments, draw order, and rotate timelines. No meshes,
// no constraints, no clipping, no physics. The data shape follows the Spine 4.3 editor JSON export (rotate keys use "value", key 0 can be
// empty) and the official spine-core 4.3 SkeletonJson reader. The JSON is not a Spine editor result until the Spine CLI or editor reads it.

export const spineDataVersion = '4.3.26';
export const skeletonFormat = 'aigg.m0-f0a.spine-arm/0.1';
export const boneNames = ['upper_arm_near', 'forearm_near', 'hand_near'] as const;
export type BoneName = (typeof boneNames)[number];
/** The slot ids and the draw order (first = back) of the C0.5 candidate: upper_arm_near 22, forearm_near 23, hand_near 25. */
export const partSlots = ['upper_arm_near', 'forearm_near', 'hand_near'] as const;
export const referenceSlot = 'reference_source_pose';
/** The slot color of the hidden reference image: white tint, alpha 0x80. */
export const referenceColor = 'ffffff80';
/** Position tolerance (Spine units = image px) of the offline checks. The JSON values have 4 decimals. */
export const geometryTolerance = 1e-3;

/** A rectangle of the source canvas in image px (x right, y down). Integer values. */
export type ImageBox = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };

/**
 * The coordinate frame. Image: origin at the top-left corner of the source canvas, x right, y down, 1 unit = 1 px.
 * Spine: origin at `origin` (image px), x right, y up, 1 unit = 1 image px (scale 1). Rotation: Spine degrees are counterclockwise.
 */
export type SpineFrame = { readonly origin: Joint };
export const toSpine = (frame: SpineFrame, p: Joint): Joint => ({ x: p.x - frame.origin.x, y: frame.origin.y - p.y });
export const toImage = (frame: SpineFrame, p: Joint): Joint => ({ x: frame.origin.x + p.x, y: frame.origin.y - p.y });

/** A diagnostic key. Angles are screen degrees in the L0-1e convention (positive = clockwise on the screen, y down). */
export type DiagnosticKey = { readonly time: number; readonly elbow: number; readonly wrist: number };
export type DiagnosticAnimation = { readonly name: string; readonly bones: readonly ('elbow' | 'wrist' | 'all')[]; readonly keys: readonly DiagnosticKey[] };

/** The M0-F0a test animations. The angles are diagnostic values from L0-1e and L0-1g, not animation limits. */
export const diagnosticAnimations: readonly DiagnosticAnimation[] = [
  { name: 'neutral', bones: ['all'], keys: [{ time: 0, elbow: 0, wrist: 0 }] },
  {
    name: 'elbow_test',
    bones: ['elbow'],
    keys: [
      { time: 0, elbow: 0, wrist: 0 },
      { time: 0.5, elbow: -15, wrist: 0 },
      { time: 1, elbow: 0, wrist: 0 },
      { time: 1.5, elbow: 15, wrist: 0 },
      { time: 2, elbow: 30, wrist: 0 },
      { time: 2.5, elbow: 0, wrist: 0 }
    ]
  },
  {
    name: 'wrist_test',
    bones: ['wrist'],
    keys: [
      { time: 0, elbow: 0, wrist: 0 },
      { time: 0.5, elbow: 0, wrist: -15 },
      { time: 1, elbow: 0, wrist: 0 },
      { time: 1.5, elbow: 0, wrist: 15 },
      { time: 2, elbow: 0, wrist: 0 }
    ]
  },
  {
    name: 'combined_test',
    bones: ['elbow', 'wrist'],
    keys: [
      { time: 0, elbow: 0, wrist: 0 },
      { time: 0.5, elbow: 10, wrist: 10 },
      { time: 1, elbow: -10, wrist: -10 },
      { time: 1.5, elbow: 10, wrist: -10 },
      { time: 2, elbow: 0, wrist: 0 }
    ]
  }
];

/** Screen degrees (clockwise, y down) to Spine local rotate values (counterclockwise, y up). No bone has scale or flip, so only the sign changes. */
export const spineDegrees = (screenDegrees: number): number => clean(-screenDegrees);

export type SpineBone = { name: string; parent?: string; length?: number; rotation?: number; x?: number; y?: number };
export type SpineSlot = { name: string; bone: string; attachment?: string; color?: string };
export type SpineRegion = { x: number; y: number; rotation: number; width: number; height: number };
export type SpineKey = { time?: number; value?: number };
export type SpineSkeleton = {
  skeleton: { spine: string; x: number; y: number; width: number; height: number; images: string; audio: string };
  bones: SpineBone[];
  slots: SpineSlot[];
  skins: { name: string; attachments: Record<string, Record<string, SpineRegion>> }[];
  animations: Record<string, { bones: Record<string, { rotate: SpineKey[] }> }>;
};

export type ArmRigInput = {
  readonly frame: SpineFrame;
  /** Joint marks in image px. `handEnd` sets only the direction and length of the hand bone. */
  readonly joints: { readonly shoulder: Joint; readonly elbow: Joint; readonly wrist: Joint; readonly handEnd: Joint };
  /** The image box of each part PNG, in the order of `partSlots`. */
  readonly parts: readonly [ImageBox, ImageBox, ImageBox];
  /** An optional hidden reference image (no setup attachment), drawn behind the arm. */
  readonly reference?: ImageBox;
  readonly animations?: readonly DiagnosticAnimation[];
};

/** Rounds to 4 decimals and removes -0. */
export function clean(value: number): number {
  const rounded = Math.round(value * 1e4) / 1e4;
  return Object.is(rounded, -0) ? 0 : rounded;
}

const degrees = (v: Joint): number => (Math.atan2(v.y, v.x) * 180) / Math.PI;
const length = (v: Joint): number => Math.hypot(v.x, v.y);
const minus = (a: Joint, b: Joint): Joint => ({ x: a.x - b.x, y: a.y - b.y });
function rotate(v: Joint, deg: number): Joint {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: cos * v.x - sin * v.y, y: sin * v.x + cos * v.y };
}

export type WorldBone = { readonly x: number; readonly y: number; readonly rotation: number };

/**
 * Forward kinematics with Spine semantics for bones without scale, shear, or inherit changes: world rotation = parent world rotation +
 * local rotation; world position = parent world position + parent rotation applied to (x, y). `delta` adds rotate timeline values
 * (relative to the setup pose, as in Spine 4).
 */
export function worldBones(bones: readonly SpineBone[], delta: Readonly<Record<string, number>> = {}): Map<string, WorldBone> {
  const world = new Map<string, WorldBone>();
  for (const bone of bones) {
    const local = { x: bone.x ?? 0, y: bone.y ?? 0 };
    const rotation = (bone.rotation ?? 0) + (delta[bone.name] ?? 0);
    if (bone.parent === undefined) {
      world.set(bone.name, { x: local.x, y: local.y, rotation });
      continue;
    }
    const parent = world.get(bone.parent);
    if (!parent) throw new Error(`The parent ${bone.parent} of ${bone.name} comes later or does not exist.`);
    const offset = rotate(local, parent.rotation);
    world.set(bone.name, { x: parent.x + offset.x, y: parent.y + offset.y, rotation: parent.rotation + rotation });
  }
  return world;
}

/** The world center and rotation of a region attachment. */
export function regionWorld(bone: WorldBone, region: SpineRegion): WorldBone {
  const offset = rotate({ x: region.x, y: region.y }, bone.rotation);
  return { x: bone.x + offset.x, y: bone.y + offset.y, rotation: bone.rotation + region.rotation };
}

/** The four corners of a region in Spine world coordinates, in the order top-left, top-right, bottom-right, bottom-left of the image. */
export function regionCorners(bone: WorldBone, region: SpineRegion): Joint[] {
  const center = regionWorld(bone, region);
  const w = region.width / 2;
  const h = region.height / 2;
  return [
    { x: -w, y: h },
    { x: w, y: h },
    { x: w, y: -h },
    { x: -w, y: -h }
  ].map((corner) => {
    const turned = rotate(corner, center.rotation);
    return { x: center.x + turned.x, y: center.y + turned.y };
  });
}

/**
 * The affine map from a full-canvas part raster (image px) to the posed image (image px) for a region attachment at `box`.
 * In the setup pose of a correct package it is the identity (within float rounding).
 */
export function regionImageAffine(frame: SpineFrame, bone: WorldBone, region: SpineRegion, box: ImageBox): Affine {
  const center = regionWorld(bone, region);
  const r = (center.rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    tx: frame.origin.x + center.x - cos * cx - sin * cy,
    ty: frame.origin.y - center.y + sin * cx - cos * cy
  };
}

function regionFor(bone: WorldBone, box: ImageBox, frame: SpineFrame): SpineRegion {
  const center = toSpine(frame, { x: box.left + box.width / 2, y: box.top + box.height / 2 });
  const local = rotate(minus(center, bone), -bone.rotation);
  return { x: clean(local.x), y: clean(local.y), rotation: clean(-bone.rotation), width: box.width, height: box.height };
}

/** Builds the skeleton JSON. Deterministic: the same input gives the same object and the same bytes through `skeletonBytes`. */
export function buildArmSkeleton(input: ArmRigInput): SpineSkeleton {
  for (const box of [...input.parts, ...(input.reference ? [input.reference] : [])]) {
    if (![box.left, box.top, box.width, box.height].every(Number.isSafeInteger) || box.width < 1 || box.height < 1) throw new RangeError('An image box must have integer values and a positive size.');
  }
  const s = toSpine(input.frame, input.joints.shoulder);
  const e = toSpine(input.frame, input.joints.elbow);
  const w = toSpine(input.frame, input.joints.wrist);
  const h = toSpine(input.frame, input.joints.handEnd);
  const directions = [degrees(minus(e, s)), degrees(minus(w, e)), degrees(minus(h, w))] as const;
  const lengths = [length(minus(e, s)), length(minus(w, e)), length(minus(h, w))] as const;
  if (lengths.some((value) => value < 1)) throw new RangeError('The joint marks must be at least 1 px apart.');
  const relative = (a: number, b: number): number => clean(((((b - a) % 360) + 540) % 360) - 180);
  const bones: SpineBone[] = [
    { name: 'root' },
    { name: 'upper_arm_near', parent: 'root', length: clean(lengths[0]), rotation: clean(directions[0]), x: clean(s.x), y: clean(s.y) },
    { name: 'forearm_near', parent: 'upper_arm_near', length: clean(lengths[1]), rotation: relative(directions[0], directions[1]), x: clean(lengths[0]) },
    { name: 'hand_near', parent: 'forearm_near', length: clean(lengths[2]), rotation: relative(directions[1], directions[2]), x: clean(lengths[1]) }
  ];
  const world = worldBones(bones);
  const attachments: Record<string, Record<string, SpineRegion>> = {};
  const slots: SpineSlot[] = [];
  if (input.reference) {
    slots.push({ name: referenceSlot, bone: 'root', color: referenceColor });
    attachments[referenceSlot] = { [referenceSlot]: regionFor(world.get('root') as WorldBone, input.reference, input.frame) };
  }
  partSlots.forEach((slot, index) => {
    slots.push({ name: slot, bone: slot, attachment: slot });
    attachments[slot] = { [slot]: regionFor(world.get(slot) as WorldBone, input.parts[index] as ImageBox, input.frame) };
  });
  // Bounds of the setup pose (nonessential data in Spine).
  const corners = partSlots.flatMap((slot) => regionCorners(world.get(slot) as WorldBone, attachments[slot]?.[slot] as SpineRegion));
  const minX = Math.min(...corners.map((p) => p.x));
  const minY = Math.min(...corners.map((p) => p.y));
  const maxX = Math.max(...corners.map((p) => p.x));
  const maxY = Math.max(...corners.map((p) => p.y));
  const animations: SpineSkeleton['animations'] = {};
  for (const animation of input.animations ?? diagnosticAnimations) {
    const timelines: Record<string, { rotate: SpineKey[] }> = {};
    const add = (bone: BoneName, angle: (key: DiagnosticKey) => number): void => {
      timelines[bone] = { rotate: animation.keys.map((key) => ({ time: clean(key.time), value: spineDegrees(angle(key)) })) };
    };
    if (animation.bones.includes('all')) add('upper_arm_near', () => 0);
    if (animation.bones.includes('all') || animation.bones.includes('elbow')) add('forearm_near', (key) => key.elbow);
    if (animation.bones.includes('all') || animation.bones.includes('wrist')) add('hand_near', (key) => key.wrist);
    animations[animation.name] = { bones: timelines };
  }
  return {
    skeleton: { spine: spineDataVersion, x: clean(minX), y: clean(minY), width: clean(maxX - minX), height: clean(maxY - minY), images: './images/', audio: '' },
    bones,
    slots,
    skins: [{ name: 'default', attachments }],
    animations
  };
}

/** The JSON bytes: two-space indentation, a final newline, keys in the insertion order above. */
export const skeletonBytes = (skeleton: SpineSkeleton): Buffer => Buffer.from(`${JSON.stringify(skeleton, null, 2)}\n`, 'utf8');

export type Check = { readonly id: string; readonly status: 'PASS' | 'FAIL'; readonly detail: string };

/** The JSON keys of the Spine Essential subset that the prototypes write and accept. */
export const allowed = {
  top: ['skeleton', 'bones', 'slots', 'skins', 'animations'],
  skeleton: ['hash', 'spine', 'x', 'y', 'width', 'height', 'fps', 'images', 'audio'],
  bone: ['name', 'parent', 'length', 'rotation', 'x', 'y', 'color'],
  slot: ['name', 'bone', 'attachment', 'color'],
  skin: ['name', 'attachments'],
  region: ['type', 'path', 'x', 'y', 'rotation', 'width', 'height', 'color'],
  animation: ['bones'],
  timeline: ['rotate'],
  key: ['time', 'value']
} as const;

export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const extraKeys = (value: unknown, keys: readonly string[]): string[] => (isObject(value) ? Object.keys(value).filter((key) => !keys.includes(key)) : ['<not an object>']);

/** The region attachments of all skins: slot, attachment name, and the untrusted value. */
export function regionEntries(value: Record<string, unknown>): { slot: string; name: string; region: unknown }[] {
  const regions: { slot: string; name: string; region: unknown }[] = [];
  for (const skin of Array.isArray(value.skins) ? value.skins : []) {
    const attachments = isObject(skin) && isObject(skin.attachments) ? skin.attachments : {};
    for (const [slot, entries] of Object.entries(attachments)) {
      for (const [name, region] of Object.entries(isObject(entries) ? entries : {})) regions.push({ slot, name, region });
    }
  }
  return regions;
}

/**
 * The Spine Essential subset check: every key must be a known key of the subset (bones, slots, region attachments, draw order, rotate
 * timelines). A mesh, a constraint, a deform timeline, a clipping attachment, or physics data gives a problem. The value is untrusted.
 */
export function essentialSubsetProblems(value: Record<string, unknown>): string[] {
  const subset: string[] = [];
  const note = (where: string, keys: string[]): void => {
    if (keys.length > 0) subset.push(`${where}: ${keys.join(', ')}`);
  };
  note('top', extraKeys(value, allowed.top));
  note('skeleton', extraKeys(value.skeleton, allowed.skeleton));
  const list = (item: unknown): unknown[] => (Array.isArray(item) ? item : []);
  list(value.bones).forEach((bone, index) => {
    note(`bones[${index}]`, extraKeys(bone, allowed.bone));
  });
  list(value.slots).forEach((slot, index) => {
    note(`slots[${index}]`, extraKeys(slot, allowed.slot));
  });
  list(value.skins).forEach((skin, index) => {
    note(`skins[${index}]`, extraKeys(skin, allowed.skin));
  });
  const animations = isObject(value.animations) ? value.animations : {};
  for (const [name, animation] of Object.entries(animations)) {
    note(`animations.${name}`, extraKeys(animation, allowed.animation));
    const timelines = isObject(animation) && isObject(animation.bones) ? animation.bones : {};
    for (const [bone, timeline] of Object.entries(timelines)) {
      note(`animations.${name}.bones.${bone}`, extraKeys(timeline, allowed.timeline));
      const keys = isObject(timeline) && Array.isArray(timeline.rotate) ? timeline.rotate : [];
      keys.forEach((key, index) => {
        note(`animations.${name}.bones.${bone}.rotate[${index}]`, extraKeys(key, allowed.key));
      });
    }
  }
  for (const { slot, name, region } of regionEntries(value)) {
    note(`skins.${slot}.${name}`, extraKeys(region, allowed.region));
    if (isObject(region) && region.type !== undefined && region.type !== 'region') subset.push(`skins.${slot}.${name}: type ${JSON.stringify(region.type)}`);
  }
  if (value.bones === undefined || value.slots === undefined || value.skins === undefined) subset.push('bones, slots, or skins is missing');
  return subset;
}

/**
 * Structural checks of a skeleton JSON value against the intended rig input. Unknown fields fail the Essential subset check, so a mesh,
 * a constraint, a deform timeline, or a clipping attachment is refused. The value is untrusted: every access is checked.
 */
export function checkArmSkeleton(value: unknown, input: ArmRigInput): Check[] {
  const checks: Check[] = [];
  const add = (id: string, problems: readonly string[], detail: string): void => {
    checks.push({ id, status: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? detail : problems.slice(0, 12).join('; ') });
  };
  if (!isObject(value)) {
    add('json_shape', ['The skeleton is not a JSON object.'], '');
    return checks;
  }
  // 1. Essential subset: only the known fields.
  const subset = essentialSubsetProblems(value);
  const bones = Array.isArray(value.bones) ? value.bones : [];
  const slots = Array.isArray(value.slots) ? value.slots : [];
  const animations = isObject(value.animations) ? value.animations : {};
  const regions = regionEntries(value);
  add('essential_subset', subset, 'Only bones, slots, region attachments, draw order, and rotate timelines. No mesh, constraint, clipping, deform, or physics data.');

  // 2. Bone hierarchy: unique names, parents before children, no cycle, the expected chain.
  const hierarchy: string[] = [];
  const seen = new Set<string>();
  const parentOf = new Map<string, string | undefined>();
  bones.forEach((bone, index) => {
    if (!isObject(bone) || typeof bone.name !== 'string') {
      hierarchy.push(`bones[${index}] has no name`);
      return;
    }
    if (seen.has(bone.name)) hierarchy.push(`duplicate bone ${bone.name}`);
    if (index === 0 && bone.parent !== undefined) hierarchy.push('the first bone has a parent');
    if (index > 0 && (typeof bone.parent !== 'string' || !seen.has(bone.parent))) hierarchy.push(`the parent of ${bone.name} is not an earlier bone`);
    seen.add(bone.name);
    parentOf.set(bone.name, typeof bone.parent === 'string' ? bone.parent : undefined);
  });
  const expectedParents: Record<string, string | undefined> = { root: undefined, upper_arm_near: 'root', forearm_near: 'upper_arm_near', hand_near: 'forearm_near' };
  if ([...parentOf.keys()].join(',') !== Object.keys(expectedParents).join(',')) hierarchy.push(`bones are ${[...parentOf.keys()].join(', ')}`);
  for (const [name, parent] of Object.entries(expectedParents)) if (parentOf.get(name) !== parent) hierarchy.push(`the parent of ${name} is not ${parent ?? 'none'}`);
  for (const name of parentOf.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = name;
    while (current !== undefined) {
      if (visited.has(current)) {
        hierarchy.push(`cycle at ${name}`);
        break;
      }
      visited.add(current);
      current = parentOf.get(current);
    }
  }
  add('bone_hierarchy', hierarchy, 'root > upper_arm_near > forearm_near > hand_near, parents before children, no cycle.');
  if (hierarchy.length > 0 || subset.length > 0) return checks;

  const typedBones = bones as SpineBone[];
  const numbers = typedBones.every((bone) =>
    ['length', 'rotation', 'x', 'y'].every((key) => (bone as Record<string, unknown>)[key] === undefined || Number.isFinite((bone as Record<string, unknown>)[key]))
  );
  add('bone_numbers', numbers ? [] : ['a bone has a value that is not a finite number'], 'All bone values are finite numbers.');
  if (!numbers) return checks;

  // 3. Joint positions: bone world origins against the marks.
  const world = worldBones(typedBones);
  const joints: string[] = [];
  const jointOf: Record<BoneName, Joint> = { upper_arm_near: input.joints.shoulder, forearm_near: input.joints.elbow, hand_near: input.joints.wrist };
  let worstJoint = 0;
  for (const bone of boneNames) {
    const at = world.get(bone) as WorldBone;
    const image = toImage(input.frame, at);
    const error = Math.hypot(image.x - jointOf[bone].x, image.y - jointOf[bone].y);
    worstJoint = Math.max(worstJoint, error);
    if (error > geometryTolerance) joints.push(`${bone} is ${error.toFixed(5)} px from its mark`);
  }
  add('joint_positions', joints, `Bone origins at the shoulder, elbow, and wrist marks; largest error ${worstJoint.toExponential(2)} px.`);

  // 4. Slots and draw order.
  const slotProblems: string[] = [];
  const expectedSlots = [...(input.reference ? [referenceSlot] : []), ...partSlots];
  const slotNames = slots.map((slot) => (isObject(slot) ? slot.name : undefined));
  if (slotNames.join(',') !== expectedSlots.join(',')) slotProblems.push(`slot order is ${slotNames.join(', ')}`);
  for (const slot of slots) {
    if (!isObject(slot) || typeof slot.name !== 'string') continue;
    if (typeof slot.bone !== 'string' || !seen.has(slot.bone)) slotProblems.push(`slot ${slot.name} has no valid bone`);
    if (slot.name !== referenceSlot && (slot.bone !== slot.name || slot.attachment !== slot.name)) slotProblems.push(`slot ${slot.name} must use bone and attachment ${slot.name}`);
    if (slot.name === referenceSlot && slot.attachment !== undefined) slotProblems.push('the reference slot must have no setup attachment');
    if (slot.attachment !== undefined && !regions.some((item) => item.slot === slot.name && item.name === slot.attachment)) slotProblems.push(`slot ${slot.name} names a missing attachment`);
  }
  add('slots_draw_order', slotProblems, `Draw order back to front: ${expectedSlots.join(', ')}.`);

  // 5. Region attachments: size and position of each image in the setup pose.
  const regionProblems: string[] = [];
  let worstCorner = 0;
  const boxes = new Map<string, ImageBox>(partSlots.map((slot, index) => [slot, input.parts[index] as ImageBox]));
  if (input.reference) boxes.set(referenceSlot, input.reference);
  if (regions.length !== boxes.size) regionProblems.push(`${regions.length} attachments, expected ${boxes.size}`);
  for (const item of regions) {
    const box = boxes.get(item.slot);
    const region = item.region;
    const slot = slots.find((entry) => isObject(entry) && entry.name === item.slot) as SpineSlot | undefined;
    if (!box || !slot || item.name !== item.slot || !isObject(region)) {
      regionProblems.push(`unexpected attachment ${item.slot}/${item.name}`);
      continue;
    }
    if (!['x', 'y', 'rotation', 'width', 'height'].every((key) => Number.isFinite(region[key]))) {
      regionProblems.push(`${item.slot}: a value is missing or not finite`);
      continue;
    }
    const typed = region as SpineRegion;
    if (typed.width !== box.width || typed.height !== box.height) regionProblems.push(`${item.slot}: size ${typed.width}x${typed.height}, image ${box.width}x${box.height}`);
    const corners = regionCorners(world.get(slot.bone) as WorldBone, typed).map((p) => toImage(input.frame, p));
    const expected = [
      { x: box.left, y: box.top },
      { x: box.left + box.width, y: box.top },
      { x: box.left + box.width, y: box.top + box.height },
      { x: box.left, y: box.top + box.height }
    ];
    corners.forEach((corner, index) => {
      const target = expected[index] as Joint;
      worstCorner = Math.max(worstCorner, Math.hypot(corner.x - target.x, corner.y - target.y));
    });
  }
  if (worstCorner > geometryTolerance) regionProblems.push(`a region corner is ${worstCorner.toFixed(5)} px from its image box`);
  add('region_attachments', regionProblems, `Each region covers its image box in the setup pose; largest corner error ${worstCorner.toExponential(2)} px.`);

  // 6. Keyframes: the expected animations, timelines, times, and Spine values.
  const keyProblems: string[] = [];
  const expectedAnimations = input.animations ?? diagnosticAnimations;
  if (Object.keys(animations).join(',') !== expectedAnimations.map((item) => item.name).join(',')) keyProblems.push(`animations are ${Object.keys(animations).join(', ')}`);
  for (const animation of expectedAnimations) {
    const timelines = isObject(animations[animation.name]) ? ((animations[animation.name] as Record<string, unknown>).bones as Record<string, { rotate: SpineKey[] }>) : {};
    const expected: [BoneName, (key: DiagnosticKey) => number][] = [];
    if (animation.bones.includes('all')) expected.push(['upper_arm_near', () => 0]);
    if (animation.bones.includes('all') || animation.bones.includes('elbow')) expected.push(['forearm_near', (key) => key.elbow]);
    if (animation.bones.includes('all') || animation.bones.includes('wrist')) expected.push(['hand_near', (key) => key.wrist]);
    if (
      Object.keys(timelines).sort().join(',') !==
      expected
        .map(([bone]) => bone)
        .sort()
        .join(',')
    )
      keyProblems.push(`${animation.name}: timelines on ${Object.keys(timelines).join(', ')}`);
    for (const [bone, angle] of expected) {
      const keys = timelines[bone]?.rotate ?? [];
      if (keys.length !== animation.keys.length) {
        keyProblems.push(`${animation.name}.${bone}: ${keys.length} keys, expected ${animation.keys.length}`);
        continue;
      }
      let previous = -Infinity;
      keys.forEach((key, index) => {
        const time = key.time ?? 0;
        const want = animation.keys[index] as DiagnosticKey;
        if (!(time > previous)) keyProblems.push(`${animation.name}.${bone}: key times do not increase`);
        previous = time;
        if (Math.abs(time - want.time) > 1e-6 || Math.abs((key.value ?? 0) - spineDegrees(angle(want))) > 1e-6) keyProblems.push(`${animation.name}.${bone}[${index}]: ${time}/${key.value ?? 0}`);
      });
    }
  }
  add('keyframes', keyProblems, 'Linear rotate keys as specified; Spine value = -(screen degrees, clockwise positive).');
  return checks;
}
