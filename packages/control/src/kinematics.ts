import type { ContractBone, ContractPoint, ContractSlot, ControlContract, Joint } from '@control/contract';
import { fail, isRecord, show } from '@control/problems';

// Forward kinematics of the shared animations on a contract setup pose, to compare how the same keys look on two geometries.
// Approximation: keys are interpolated linearly. Bezier and stepped curves, constraints, scale and shear are ignored.
// Rig space has Y up; a positive rotation turns counterclockwise, as in Spine.

export type RotateKey = { readonly time: number; readonly value: number };
export type TranslateKey = { readonly time: number; readonly x: number; readonly y: number };
export type BoneTimelines = { readonly rotate: readonly RotateKey[]; readonly translate: readonly TranslateKey[] };
export type Animation = { readonly name: string; readonly bones: ReadonlyMap<string, BoneTimelines> };

const finite = (value: unknown, fallback: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e6) fail('E_SKELETON_FORMAT', `A key value ${show(value)} is not a finite number.`);
  return value;
};

/** Reads the rotate and translate bone timelines of a Spine JSON export. Other timelines are ignored and listed. */
export function parseAnimations(value: unknown): { animations: Animation[]; ignored: string[] } {
  if (!isRecord(value) || !isRecord(value.animations)) fail('E_SKELETON_FORMAT', 'The skeleton has no animations object.');
  const animations: Animation[] = [];
  const ignored = new Set<string>();
  for (const [name, data] of Object.entries(value.animations)) {
    if (!isRecord(data)) fail('E_SKELETON_FORMAT', `Animation ${show(name)} is not an object.`);
    for (const key of Object.keys(data)) if (key !== 'bones') ignored.add(`${name}:${key}`);
    const bones = new Map<string, BoneTimelines>();
    if (isRecord(data.bones)) {
      for (const [bone, timelines] of Object.entries(data.bones)) {
        if (!isRecord(timelines)) continue;
        for (const key of Object.keys(timelines)) if (key !== 'rotate' && key !== 'translate') ignored.add(`${name}:${bone}:${key}`);
        const list = (raw: unknown): Record<string, unknown>[] => (Array.isArray(raw) ? raw.filter(isRecord) : []);
        bones.set(bone, {
          rotate: list(timelines.rotate).map((key) => ({ time: finite(key.time, 0), value: finite(key.value, 0) })),
          translate: list(timelines.translate).map((key) => ({ time: finite(key.time, 0), x: finite(key.x, 0), y: finite(key.y, 0) }))
        });
      }
    }
    animations.push({ name, bones });
  }
  return { animations, ignored: [...ignored].sort() };
}

function sample<K extends { time: number }>(keys: readonly K[], time: number, read: (key: K) => number[]): number[] | null {
  if (keys.length === 0) return null;
  const first = keys[0] as K;
  if (time <= first.time) return read(first);
  for (let index = 1; index < keys.length; index += 1) {
    const before = keys[index - 1] as K;
    const after = keys[index] as K;
    if (time <= after.time) {
      const span = after.time - before.time;
      const f = span > 0 ? (time - before.time) / span : 1;
      const a = read(before);
      const b = read(after);
      return a.map((value, i) => value + ((b[i] ?? value) - value) * f);
    }
  }
  return read(keys[keys.length - 1] as K);
}

/** The key time with the largest sum of absolute rotations: the most extreme key pose of the animation. */
export function extremeTime(animation: Animation): number {
  const times = new Set<number>([0]);
  for (const timelines of animation.bones.values()) for (const key of [...timelines.rotate, ...timelines.translate]) times.add(key.time);
  let best = 0;
  let bestScore = -1;
  for (const time of [...times].sort((a, b) => a - b)) {
    let score = 0;
    for (const timelines of animation.bones.values()) score += Math.abs(sample(timelines.rotate, time, (key) => [key.value])?.[0] ?? 0);
    if (score > bestScore + 1e-9) {
      best = time;
      bestScore = score;
    }
  }
  return best;
}

type World = { readonly x: number; readonly y: number; readonly rotation: number };

/**
 * Poses the contract at a time: returns a copy with posed joints and points. Slot rectangles move with their bone (translation only),
 * so pictures that use the head rectangle stay attached to the head.
 */
export function posedContract(contract: ControlContract, animation: Animation | null, time: number): ControlContract {
  const world = new Map<string, World>();
  const visit = (bone: ContractBone): World => {
    const known = world.get(bone.id);
    if (known) return known;
    const timelines = animation?.bones.get(bone.id);
    const rotation = timelines ? (sample(timelines.rotate, time, (key) => [key.value])?.[0] ?? 0) : 0;
    const [tx, ty] = timelines ? (sample(timelines.translate, time, (key) => [key.x, key.y]) ?? [0, 0]) : [0, 0];
    const parent = bone.parent ? contract.bones.get(bone.parent) : undefined;
    let result: World;
    if (!parent) result = { x: bone.joint.x + (tx ?? 0), y: bone.joint.y - (ty ?? 0), rotation };
    else {
      const base = visit(parent);
      // Local offset in rig space (Y up), rotated by the parent world rotation.
      const lx = bone.joint.x - parent.joint.x + (tx ?? 0);
      const ly = -(bone.joint.y - parent.joint.y) + (ty ?? 0);
      const angle = (base.rotation * Math.PI) / 180;
      const rx = lx * Math.cos(angle) - ly * Math.sin(angle);
      const ry = lx * Math.sin(angle) + ly * Math.cos(angle);
      result = { x: base.x + rx, y: base.y - ry, rotation: base.rotation + rotation };
    }
    world.set(bone.id, result);
    return result;
  };
  for (const bone of contract.bones.values()) visit(bone);
  const bones = new Map<string, ContractBone>();
  for (const bone of contract.bones.values()) {
    const posed = world.get(bone.id) as World;
    bones.set(bone.id, { ...bone, joint: { x: posed.x, y: posed.y } });
  }
  const points = new Map<string, ContractPoint>();
  for (const point of contract.points.values()) {
    const bone = contract.bones.get(point.bone);
    const posed = world.get(point.bone);
    if (!bone || !posed) continue;
    const lx = point.position.x - bone.joint.x;
    const ly = -(point.position.y - bone.joint.y);
    const angle = (posed.rotation * Math.PI) / 180;
    const position: Joint = { x: posed.x + lx * Math.cos(angle) - ly * Math.sin(angle), y: posed.y - (lx * Math.sin(angle) + ly * Math.cos(angle)) };
    points.set(point.id, { ...point, position });
  }
  const slots = new Map<string, ContractSlot>();
  for (const slot of contract.slots.values()) {
    const bone = contract.bones.get(slot.bone);
    const posed = world.get(slot.bone);
    const dx = bone && posed ? posed.x - bone.joint.x : 0;
    const dy = bone && posed ? posed.y - bone.joint.y : 0;
    slots.set(slot.id, { ...slot, attachmentRect: { ...slot.attachmentRect, x: slot.attachmentRect.x + dx, y: slot.attachmentRect.y + dy } });
  }
  return { ...contract, bones, points, slots };
}
