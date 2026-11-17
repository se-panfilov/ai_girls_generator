import type { Affine } from '@control/align';
import type { Joint } from '@control/contract';
import { Raster } from '@control/raster';
import {
  type Check,
  clean,
  essentialSubsetProblems,
  geometryTolerance,
  type ImageBox,
  isObject,
  regionCorners,
  regionEntries,
  regionImageAffine,
  type SpineBone,
  spineDataVersion,
  spineDegrees,
  type SpineFrame,
  type SpineKey,
  type SpineRegion,
  type SpineSkeleton,
  type SpineSlot,
  toImage,
  toSpine,
  type WorldBone,
  worldBones
} from '@control/spineskeleton';

// A full-body Spine skeleton for the MVP-A vertical slice (prototype). It generalizes the M0-F0a arm skeleton to a bone tree, many slots,
// and demonstration animations. Only the Spine Essential subset: bones, slots, region attachments, draw order, and linear rotate keys.
// No mesh, no constraint, no clipping, no physics. The JSON is not a Spine editor result until the Spine CLI reads it (spine-validate).

export const bodySkeletonFormat = 'aigg.mvp-a.spine-body/0.1';

/**
 * A bone in image px (x right, y down). `end` sets the bone direction and length (null: no own direction, local rotation 0, length 0).
 * Parents come before their children.
 */
export type BodyBoneSpec = { readonly name: string; readonly parent: string | null; readonly joint: Joint; readonly end: Joint | null };
/** A slot in draw order (first = back). `box` is the image box of its region attachment, or null for an empty slot. */
export type BodySlotSpec = { readonly name: string; readonly bone: string; readonly box: ImageBox | null };
/** A rotate key in screen degrees (positive = clockwise on the screen, y down), relative to the setup pose. */
export type ScreenKey = { readonly time: number; readonly degrees: number };
export type BodyAnimation = { readonly name: string; readonly duration: number; readonly tracks: readonly { readonly bone: string; readonly keys: readonly ScreenKey[] }[] };
export type BodyRigSpec = {
  readonly frame: SpineFrame;
  readonly bones: readonly BodyBoneSpec[];
  readonly slots: readonly BodySlotSpec[];
  readonly animations: readonly BodyAnimation[];
};

const namePattern = /^[a-z][a-z0-9_]{0,63}$/;
const wrap = (degrees: number): number => clean((((degrees % 360) + 540) % 360) - 180);
const rotate = (v: Joint, deg: number): Joint => {
  const r = (deg * Math.PI) / 180;
  return { x: Math.cos(r) * v.x - Math.sin(r) * v.y, y: Math.sin(r) * v.x + Math.cos(r) * v.y };
};

/** Checks the spec before the build: names, parents before children, one root, boxes with integer values, keys in time order. */
export function specProblems(spec: BodyRigSpec): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  spec.bones.forEach((bone, index) => {
    if (!namePattern.test(bone.name)) problems.push(`bone name ${JSON.stringify(bone.name)} is not snake_case`);
    if (seen.has(bone.name)) problems.push(`duplicate bone ${bone.name}`);
    if (index === 0 && bone.parent !== null) problems.push('the first bone must be the root (no parent)');
    if (index > 0 && (bone.parent === null || !seen.has(bone.parent))) problems.push(`the parent of ${bone.name} is not an earlier bone`);
    if (![bone.joint.x, bone.joint.y, ...(bone.end ? [bone.end.x, bone.end.y] : [])].every(Number.isFinite)) problems.push(`bone ${bone.name} has a value that is not finite`);
    seen.add(bone.name);
  });
  const slotNames = new Set<string>();
  for (const slot of spec.slots) {
    if (!namePattern.test(slot.name) || slotNames.has(slot.name)) problems.push(`slot name ${JSON.stringify(slot.name)} is not valid or not unique`);
    slotNames.add(slot.name);
    if (!seen.has(slot.bone)) problems.push(`slot ${slot.name} uses the missing bone ${slot.bone}`);
    const box = slot.box;
    if (box && (![box.left, box.top, box.width, box.height].every(Number.isSafeInteger) || box.width < 1 || box.height < 1)) problems.push(`slot ${slot.name} has a box that is not valid`);
  }
  for (const animation of spec.animations) {
    if (!namePattern.test(animation.name)) problems.push(`animation name ${JSON.stringify(animation.name)} is not valid`);
    if (!(animation.duration > 0)) problems.push(`animation ${animation.name} has no duration`);
    for (const track of animation.tracks) {
      if (!seen.has(track.bone)) problems.push(`animation ${animation.name} moves the missing bone ${track.bone}`);
      let previous = -Infinity;
      for (const key of track.keys) {
        if (!(key.time > previous) || key.time < 0 || key.time > animation.duration || !Number.isFinite(key.degrees))
          problems.push(`animation ${animation.name}.${track.bone} has keys out of order or not finite`);
        previous = key.time;
      }
    }
  }
  return problems;
}

/** The region of an image box in a bone frame. The image stays upright in the setup pose. */
function regionFor(bone: WorldBone, box: ImageBox, frame: SpineFrame): SpineRegion {
  const center = toSpine(frame, { x: box.left + box.width / 2, y: box.top + box.height / 2 });
  const local = rotate({ x: center.x - bone.x, y: center.y - bone.y }, -bone.rotation);
  return { x: clean(local.x), y: clean(local.y), rotation: clean(-bone.rotation), width: box.width, height: box.height };
}

/**
 * Builds the skeleton JSON. Deterministic. Each bone is computed from the rounded values of its parent, so the 4-decimal rounding does
 * not accumulate along a chain.
 */
export function buildBodySkeleton(spec: BodyRigSpec): SpineSkeleton {
  const problems = specProblems(spec);
  if (problems.length > 0) throw new RangeError(`The rig spec is not valid: ${problems.slice(0, 6).join('; ')}`);
  const bones: SpineBone[] = [];
  const specOf = new Map(spec.bones.map((bone) => [bone.name, bone]));
  for (const bone of spec.bones) {
    const at = toSpine(spec.frame, bone.joint);
    const end = bone.end ? toSpine(spec.frame, bone.end) : null;
    const lengthPx = end ? Math.hypot(end.x - at.x, end.y - at.y) : 0;
    if (bone.parent === null) {
      const rotation = end && lengthPx >= 1 ? (Math.atan2(end.y - at.y, end.x - at.x) * 180) / Math.PI : 0;
      bones.push({ name: bone.name, ...(lengthPx >= 1 ? { length: clean(lengthPx) } : {}), rotation: clean(rotation), x: clean(at.x), y: clean(at.y) });
      continue;
    }
    const parent = worldBones(bones).get(bone.parent) as WorldBone;
    const local = rotate({ x: at.x - parent.x, y: at.y - parent.y }, -parent.rotation);
    const world = end && lengthPx >= 1 ? (Math.atan2(end.y - at.y, end.x - at.x) * 180) / Math.PI : parent.rotation;
    bones.push({ name: bone.name, parent: bone.parent, ...(lengthPx >= 1 ? { length: clean(lengthPx) } : {}), rotation: wrap(world - parent.rotation), x: clean(local.x), y: clean(local.y) });
    if (!specOf.has(bone.parent)) throw new RangeError(`Missing parent ${bone.parent}.`);
  }
  const world = worldBones(bones);
  const attachments: Record<string, Record<string, SpineRegion>> = {};
  const slots: SpineSlot[] = spec.slots.map((slot) => {
    if (!slot.box) return { name: slot.name, bone: slot.bone };
    attachments[slot.name] = { [slot.name]: regionFor(world.get(slot.bone) as WorldBone, slot.box, spec.frame) };
    return { name: slot.name, bone: slot.bone, attachment: slot.name };
  });
  const corners = spec.slots.flatMap((slot) => (slot.box ? regionCorners(world.get(slot.bone) as WorldBone, attachments[slot.name]?.[slot.name] as SpineRegion) : []));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = xs.length > 0 ? Math.min(...xs) : 0;
  const minY = ys.length > 0 ? Math.min(...ys) : 0;
  const animations: SpineSkeleton['animations'] = {};
  for (const animation of spec.animations) {
    const timelines: Record<string, { rotate: SpineKey[] }> = {};
    for (const track of animation.tracks) timelines[track.bone] = { rotate: track.keys.map((key) => ({ time: clean(key.time), value: spineDegrees(key.degrees) })) };
    animations[animation.name] = { bones: timelines };
  }
  return {
    skeleton: {
      spine: spineDataVersion,
      x: clean(minX),
      y: clean(minY),
      width: clean((xs.length > 0 ? Math.max(...xs) : 0) - minX),
      height: clean((ys.length > 0 ? Math.max(...ys) : 0) - minY),
      images: './images/',
      audio: ''
    },
    bones,
    slots,
    skins: [{ name: 'default', attachments }],
    animations
  };
}

/** Rotate values (Spine degrees, relative to the setup pose) of all animated bones at a time, with the Spine linear interpolation. */
export function poseAt(skeleton: SpineSkeleton, animation: string, time: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [bone, timeline] of Object.entries(skeleton.animations[animation]?.bones ?? {})) {
    const keys = timeline.rotate;
    const first = keys[0];
    if (!first) continue;
    let value = first.value ?? 0;
    for (let i = 0; i < keys.length; i += 1) {
      const a = keys[i] as SpineKey;
      const b = keys[i + 1];
      if (time < (a.time ?? 0)) break;
      value = a.value ?? 0;
      if (b && time < (b.time ?? 0)) {
        const span = (b.time ?? 0) - (a.time ?? 0);
        value = (a.value ?? 0) + ((b.value ?? 0) - (a.value ?? 0)) * ((time - (a.time ?? 0)) / span);
        break;
      }
    }
    out[bone] = value;
  }
  return out;
}

/** The last key time of an animation (its length in Spine). */
export function animationLength(skeleton: SpineSkeleton, animation: string): number {
  return Math.max(0, ...Object.values(skeleton.animations[animation]?.bones ?? {}).flatMap((timeline) => timeline.rotate.map((key) => key.time ?? 0)));
}

/** A region image: the cropped part raster and its box on the source canvas. */
export type RegionImage = { readonly raster: Raster; readonly box: ImageBox };

const invert = (m: Affine): Affine => {
  const det = m.a * m.d - m.b * m.c;
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det, tx: (m.b * m.ty - m.d * m.tx) / det, ty: (m.c * m.tx - m.a * m.ty) / det };
};
const apply = (m: Affine, p: Joint): Joint => ({ x: m.a * p.x + m.b * p.y + m.tx, y: m.c * p.x + m.d * p.y + m.ty });

/**
 * A local preview renderer (not Spine): draws the region images in slot order with the posed bones. Nearest-neighbor inverse mapping
 * and the straight-alpha source-over blend of the L0 and M0-F0a studies.
 */
export function renderPose(
  skeleton: SpineSkeleton,
  frame: SpineFrame,
  images: ReadonlyMap<string, RegionImage>,
  delta: Readonly<Record<string, number>>,
  width: number,
  height: number,
  background?: Raster
): Raster {
  const out = new Raster(width, height);
  if (background) out.data.set(background.data);
  const world = worldBones(skeleton.bones, delta);
  const attachments = skeleton.skins[0]?.attachments ?? {};
  for (const slot of skeleton.slots) {
    if (slot.attachment === undefined) continue;
    const image = images.get(slot.attachment);
    const region = attachments[slot.name]?.[slot.attachment];
    if (!image || !region) continue;
    const forward = regionImageAffine(frame, world.get(slot.bone) as WorldBone, region, image.box);
    const inverse = invert(forward);
    const { box, raster } = image;
    const corners = [
      { x: box.left, y: box.top },
      { x: box.left + box.width, y: box.top },
      { x: box.left, y: box.top + box.height },
      { x: box.left + box.width, y: box.top + box.height }
    ].map((corner) => apply(forward, corner));
    const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.x))) - 1);
    const x1 = Math.min(width - 1, Math.ceil(Math.max(...corners.map((c) => c.x))) + 1);
    const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.y))) - 1);
    const y1 = Math.min(height - 1, Math.ceil(Math.max(...corners.map((c) => c.y))) + 1);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const p = apply(inverse, { x: x + 0.5, y: y + 0.5 });
        const sx = Math.floor(p.x) - box.left;
        const sy = Math.floor(p.y) - box.top;
        if (sx < 0 || sy < 0 || sx >= raster.width || sy >= raster.height) continue;
        const i = (sy * raster.width + sx) * 4;
        const a = raster.data[i + 3] ?? 0;
        if (a === 0) continue;
        out.blend(x, y, [raster.data[i] ?? 0, raster.data[i + 1] ?? 0, raster.data[i + 2] ?? 0, a]);
      }
    }
  }
  return out;
}

/**
 * Structural checks of a skeleton JSON value against the spec. The value is untrusted: every access is checked. The Essential subset
 * check refuses unknown keys, so Spine Professional data (meshes, constraints, deform, clipping, physics) fails.
 */
export function checkBodySkeleton(value: unknown, spec: BodyRigSpec): Check[] {
  const checks: Check[] = [];
  const add = (id: string, problems: readonly string[], detail: string): void => {
    checks.push({ id, status: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? detail : problems.slice(0, 12).join('; ') });
  };
  if (!isObject(value)) {
    add('json_shape', ['The skeleton is not a JSON object.'], '');
    return checks;
  }
  const subset = essentialSubsetProblems(value);
  add('essential_subset', subset, 'Only bones, slots, region attachments, draw order, and rotate timelines (Spine Essential). No mesh, constraint, clipping, deform, or physics data.');
  const bones = Array.isArray(value.bones) ? value.bones : [];
  const slots = Array.isArray(value.slots) ? value.slots : [];
  const animations = isObject(value.animations) ? value.animations : {};
  const regions = regionEntries(value);

  // Hierarchy: unique names, one root first, parents before children (so every bone connects to the root), the spec tree.
  const hierarchy: string[] = [];
  const parentOf = new Map<string, string | undefined>();
  bones.forEach((bone, index) => {
    if (!isObject(bone) || typeof bone.name !== 'string') {
      hierarchy.push(`bones[${index}] has no name`);
      return;
    }
    if (parentOf.has(bone.name)) hierarchy.push(`duplicate bone ${bone.name}`);
    if (index === 0 && bone.parent !== undefined) hierarchy.push('the first bone has a parent');
    if (index > 0 && (typeof bone.parent !== 'string' || !parentOf.has(bone.parent))) hierarchy.push(`the parent of ${bone.name} is not an earlier bone`);
    parentOf.set(bone.name, typeof bone.parent === 'string' ? bone.parent : undefined);
  });
  if ([...parentOf.keys()].join(',') !== spec.bones.map((bone) => bone.name).join(',')) hierarchy.push('the bone list is not the spec bone list');
  for (const bone of spec.bones) if (parentOf.get(bone.name) !== (bone.parent ?? undefined)) hierarchy.push(`the parent of ${bone.name} is not ${bone.parent ?? 'none'}`);
  const root = spec.bones[0]?.name;
  for (const name of parentOf.keys()) {
    let current: string | undefined = name;
    let steps = 0;
    while (current !== undefined && current !== root && steps <= parentOf.size) {
      current = parentOf.get(current);
      steps += 1;
    }
    if (current !== root) hierarchy.push(`${name} does not connect to the root`);
  }
  add('bone_hierarchy', hierarchy, `${parentOf.size} bones; all connect to ${root ?? 'the root'}; parents before children; no cycle.`);
  if (hierarchy.length > 0 || subset.length > 0) return checks;
  const typed = bones as SpineBone[];
  const numbers = typed.every((bone) =>
    ['length', 'rotation', 'x', 'y'].every((key) => (bone as Record<string, unknown>)[key] === undefined || Number.isFinite((bone as Record<string, unknown>)[key]))
  );
  add('bone_numbers', numbers ? [] : ['a bone has a value that is not a finite number'], 'All bone values are finite numbers.');
  if (!numbers) return checks;

  // Joints: the world origin of each bone on its spec joint.
  const world = worldBones(typed);
  const joints: string[] = [];
  let worstJoint = 0;
  for (const bone of spec.bones) {
    const image = toImage(spec.frame, world.get(bone.name) as WorldBone);
    const error = Math.hypot(image.x - bone.joint.x, image.y - bone.joint.y);
    worstJoint = Math.max(worstJoint, error);
    if (error > geometryTolerance) joints.push(`${bone.name} is ${error.toFixed(5)} px from its joint`);
  }
  add('joint_positions', joints, `Bone origins on the joints; largest error ${worstJoint.toExponential(2)} px.`);

  // Slots and draw order.
  const slotProblems: string[] = [];
  const names = slots.map((slot) => (isObject(slot) ? slot.name : undefined));
  if (names.join(',') !== spec.slots.map((slot) => slot.name).join(',')) slotProblems.push(`slot order is ${names.join(', ')}`);
  spec.slots.forEach((slotSpec, index) => {
    const slot: unknown = slots[index];
    if (!isObject(slot)) return;
    if (slot.bone !== slotSpec.bone) slotProblems.push(`slot ${slotSpec.name} uses bone ${String(slot.bone)}, not ${slotSpec.bone}`);
    if (slotSpec.box && slot.attachment !== slotSpec.name) slotProblems.push(`slot ${slotSpec.name} has no setup attachment`);
    if (!slotSpec.box && slot.attachment !== undefined) slotProblems.push(`the empty slot ${slotSpec.name} has an attachment`);
    if (slot.attachment !== undefined && !regions.some((item) => item.slot === slot.name && item.name === slot.attachment)) slotProblems.push(`slot ${slotSpec.name} names a missing attachment`);
  });
  add('slots_draw_order', slotProblems, `${spec.slots.length} slots in the spec draw order; each slot on its bone; every setup attachment exists.`);

  // Region attachments: one per filled slot, size and position of each image in the setup pose.
  const regionProblems: string[] = [];
  let worstCorner = 0;
  const filled = spec.slots.filter((slot) => slot.box);
  if (regions.length !== filled.length) regionProblems.push(`${regions.length} attachments, expected ${filled.length}`);
  for (const item of regions) {
    const slotSpec = spec.slots.find((slot) => slot.name === item.slot);
    const box = slotSpec?.box;
    const region = item.region;
    if (!slotSpec || !box || item.name !== item.slot || !isObject(region) || !['x', 'y', 'rotation', 'width', 'height'].every((key) => Number.isFinite(region[key]))) {
      regionProblems.push(`unexpected or invalid attachment ${item.slot}/${item.name}`);
      continue;
    }
    const typedRegion = region as SpineRegion;
    if (typedRegion.width !== box.width || typedRegion.height !== box.height) regionProblems.push(`${item.slot}: size ${typedRegion.width}x${typedRegion.height}, image ${box.width}x${box.height}`);
    const corners = regionCorners(world.get(slotSpec.bone) as WorldBone, typedRegion).map((p) => toImage(spec.frame, p));
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
  add('region_attachments', regionProblems, `${filled.length} region attachments cover their image boxes in the setup pose; largest corner error ${worstCorner.toExponential(2)} px.`);

  // Animations: the spec animations, timelines on existing bones, increasing times, the spec values, and real motion.
  const keyProblems: string[] = [];
  if (Object.keys(animations).join(',') !== spec.animations.map((item) => item.name).join(',')) keyProblems.push(`animations are ${Object.keys(animations).join(', ')}`);
  for (const animation of spec.animations) {
    const entry = animations[animation.name];
    const timelines = isObject(entry) && isObject(entry.bones) ? entry.bones : {};
    if (Object.keys(timelines).join(',') !== animation.tracks.map((track) => track.bone).join(',')) keyProblems.push(`${animation.name}: timelines on ${Object.keys(timelines).join(', ')}`);
    let moving = 0;
    for (const track of animation.tracks) {
      if (!parentOf.has(track.bone)) keyProblems.push(`${animation.name}: the bone ${track.bone} does not exist`);
      const timeline = timelines[track.bone];
      const keys = isObject(timeline) && Array.isArray(timeline.rotate) ? timeline.rotate : [];
      if (keys.length !== track.keys.length) {
        keyProblems.push(`${animation.name}.${track.bone}: ${keys.length} keys, expected ${track.keys.length}`);
        continue;
      }
      let previous = -Infinity;
      const values = new Set<number>();
      keys.forEach((key: unknown, index) => {
        const want = track.keys[index] as ScreenKey;
        const time = isObject(key) && typeof key.time === 'number' ? key.time : 0;
        const keyValue = isObject(key) && typeof key.value === 'number' ? key.value : 0;
        if (!(time > previous)) keyProblems.push(`${animation.name}.${track.bone}: key times do not increase`);
        previous = time;
        values.add(keyValue);
        if (Math.abs(time - want.time) > 1e-6 || Math.abs(keyValue - spineDegrees(want.degrees)) > 1e-6) keyProblems.push(`${animation.name}.${track.bone}[${index}]: ${time}/${keyValue}`);
      });
      if (values.size > 1) moving += 1;
    }
    if (moving === 0) keyProblems.push(`${animation.name}: no timeline changes its value (no motion)`);
  }
  add(
    'animations',
    keyProblems,
    `${spec.animations.map((item) => `${item.name} (${item.tracks.length} bones)`).join(', ')}: linear rotate keys on existing bones, increasing times, real motion. Spine value = -(screen degrees).`
  );
  return checks;
}
