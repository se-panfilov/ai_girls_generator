import type { ControlContract, Joint, Size } from '@control/contract';
import { type Keypoint, rigPose, toTarget, type Transform } from '@control/pose';
import { type Color, type Point, Raster } from '@control/raster';

// A flat 2D mannequin drawn from contract joints only, with the same generic widths for every contract.
// It is a picture for people to judge the pose, the view and the draw order. It is not character art.
// Widths are fractions of the body height, so the L1 rig and the candidate get the same treatment.

const width = { upperArm: 0.024, forearm: 0.02, hand: 0.023, thigh: 0.043, shin: 0.029, foot: 0.021, neck: 0.023, shoulder: 0.026, chest: 0.07, waist: 0.055, pelvis: 0.072, hipJoint: 0.042 };

type Side = 'near' | 'far' | 'center';
const fills: Record<Side, Color> = { near: [126, 168, 236, 255], far: [236, 176, 126, 255], center: [205, 205, 210, 255] };
const outline: Color = [45, 45, 50, 255];

type Circle = { readonly x: number; readonly y: number; readonly r: number };
type Piece = { readonly slot: string; readonly side: Side; readonly circles: readonly Circle[] };

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Convex hull (monotone chain) of points. */
export function convexHull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;
  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as Point, lower[lower.length - 1] as Point, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2] as Point, upper[upper.length - 1] as Point, point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function hullOfCircles(circles: readonly Circle[], grow: number): Point[] {
  const points: Point[] = [];
  for (const circle of circles) {
    for (let step = 0; step < 32; step += 1) {
      const angle = (step / 32) * Math.PI * 2;
      points.push({ x: circle.x + Math.cos(angle) * (circle.r + grow), y: circle.y + Math.sin(angle) * (circle.r + grow) });
    }
  }
  return convexHull(points);
}

const sideOf = (id: string): Side => (id.endsWith('_near') ? 'near' : id.endsWith('_far') ? 'far' : 'center');

/** The body pieces of the mannequin in contract space, each linked to the slot that sets its draw order. */
export function mannequinPieces(contract: ControlContract, bodyHeight: number, facing: 1 | -1): Piece[] {
  const joint = (id: string): Joint | undefined => contract.bones.get(id)?.joint;
  const c = (id: string, r: number): Circle | undefined => {
    const point = joint(id);
    return point ? { x: point.x, y: point.y, r: r * bodyHeight } : undefined;
  };
  const pieces: Piece[] = [];
  const add = (slot: string, side: Side, circles: (Circle | undefined)[]): void => {
    const valid = circles.filter((item): item is Circle => item !== undefined);
    if (valid.length > 0 && contract.slots.has(slot)) pieces.push({ slot, side, circles: valid });
  };
  for (const side of ['near', 'far'] as const) {
    add(`upper_arm_${side}`, side, [c(`upper_arm_${side}`, width.upperArm), c(`forearm_${side}`, width.forearm)]);
    add(`forearm_${side}`, side, [c(`forearm_${side}`, width.forearm), c(`hand_${side}`, width.forearm * 0.8)]);
    const wrist = joint(`hand_${side}`);
    const elbow = joint(`forearm_${side}`);
    if (wrist && elbow) {
      const length = Math.hypot(wrist.x - elbow.x, wrist.y - elbow.y) || 1;
      const reach = 0.045 * bodyHeight;
      const tip = { x: wrist.x + ((wrist.x - elbow.x) / length) * reach, y: wrist.y + ((wrist.y - elbow.y) / length) * reach, r: width.hand * 0.7 * bodyHeight };
      add(`hand_${side}`, side, [{ x: wrist.x, y: wrist.y, r: width.hand * 0.8 * bodyHeight }, tip]);
    }
    add(`thigh_${side}`, side, [c(`thigh_${side}`, width.thigh), c(`shin_${side}`, width.shin * 1.1)]);
    add(`shin_${side}`, side, [c(`shin_${side}`, width.shin), c(`foot_${side}`, width.foot)]);
    const ankle = joint(`foot_${side}`);
    if (ankle) {
      const ground = contract.rigOrigin.y;
      add(`foot_${side}`, side, [
        { x: ankle.x, y: ankle.y, r: width.foot * bodyHeight },
        { x: ankle.x + facing * 0.075 * bodyHeight, y: ground - width.foot * 0.6 * bodyHeight, r: width.foot * 0.6 * bodyHeight },
        { x: ankle.x - facing * 0.012 * bodyHeight, y: ground - width.foot * 0.7 * bodyHeight, r: width.foot * 0.7 * bodyHeight }
      ]);
    }
  }
  add('torso', 'center', [c('neck', width.neck), c('upper_arm_near', width.shoulder), c('upper_arm_far', width.shoulder), c('chest', width.chest), c('spine', width.waist)]);
  add('hips', 'center', [c('spine', width.waist), c('hips', width.pelvis), c('thigh_near', width.hipJoint), c('thigh_far', width.hipJoint)]);
  add('neck', 'center', [c('neck', width.neck), c('head', width.neck)]);
  return pieces;
}

export type HeadShape = { readonly center: Joint; readonly rx: number; readonly ry: number };

/** The head ellipse: from the head joint (chin) to the head top point, or to the top of the head rectangle without that point. */
export function headShape(contract: ControlContract, facing: 1 | -1): HeadShape | null {
  const chin = contract.bones.get('head')?.joint;
  const top = contract.points.get('head_top')?.position ?? (contract.slots.get('head') ? { x: chin?.x ?? 0, y: contract.slots.get('head')?.attachmentRect.y ?? 0 } : undefined);
  if (!chin || !top) return null;
  const ry = (chin.y - top.y) / 2;
  return { center: { x: (chin.x + top.x) / 2 + facing * ry * 0.12, y: (chin.y + top.y) / 2 }, rx: ry * 0.82, ry };
}

function ellipsePoints(shape: HeadShape, grow: number): Point[] {
  return Array.from({ length: 48 }, (_, step) => {
    const angle = (step / 48) * Math.PI * 2;
    return { x: shape.center.x + Math.cos(angle) * (shape.rx + grow), y: shape.center.y + Math.sin(angle) * (shape.ry + grow) };
  });
}

export type MannequinOptions = { readonly joints: boolean; readonly slots: boolean; readonly background: Color };

/** Draws the mannequin in slot draw order, the face marks, and optionally the joints and the slot rectangles. */
export function renderMannequin(contract: ControlContract, size: Size, transform: Transform, options: MannequinOptions): Raster {
  const raster = new Raster(size.width, size.height, options.background);
  const pose = rigPose(contract, 'anatomical');
  const facing: 1 | -1 = 1;
  const t = (point: Point): Point => toTarget(point, transform);
  const pieces = mannequinPieces(contract, pose.bodyHeight, facing).sort((a, b) => (contract.slots.get(a.slot)?.drawOrder ?? 0) - (contract.slots.get(b.slot)?.drawOrder ?? 0));
  const head = headShape(contract, facing);
  const headOrder = contract.slots.get('head')?.drawOrder ?? 0;
  let headDrawn = false;
  const drawHead = (): void => {
    if (!head) return;
    raster.fillPolygon(ellipsePoints(head, 3 / transform.scale).map(t), outline);
    raster.fillPolygon(ellipsePoints(head, 0).map(t), fills.center);
    drawFace(raster, pose.keypoints, head, transform);
  };
  for (const piece of pieces) {
    if (!headDrawn && (contract.slots.get(piece.slot)?.drawOrder ?? 0) > headOrder) {
      drawHead();
      headDrawn = true;
    }
    raster.fillPolygon(hullOfCircles(piece.circles, 3 / transform.scale).map(t), outline);
    raster.fillPolygon(hullOfCircles(piece.circles, 0).map(t), fills[piece.side]);
  }
  if (!headDrawn) drawHead();
  if (options.slots) {
    for (const slot of contract.slots.values()) {
      const side = sideOf(slot.bone);
      const color: Color = side === 'near' ? [30, 90, 210, 150] : side === 'far' ? [210, 110, 20, 150] : [90, 90, 90, 110];
      const a = t({ x: slot.attachmentRect.x, y: slot.attachmentRect.y });
      raster.strokeRect(a.x, a.y, slot.attachmentRect.w * transform.scale, slot.attachmentRect.h * transform.scale, 1, color);
    }
  }
  if (options.joints) {
    for (const bone of contract.bones.values()) {
      const parent = bone.parent ? contract.bones.get(bone.parent) : undefined;
      if (parent && bone.id !== 'aim') raster.line(t(parent.joint), t(bone.joint), 2, [20, 20, 20, 200]);
    }
    for (const bone of contract.bones.values()) {
      if (bone.id === 'aim') continue;
      const side = sideOf(bone.id);
      const color: Color = side === 'near' ? [20, 70, 200, 255] : side === 'far' ? [200, 90, 10, 255] : [200, 20, 20, 255];
      raster.fillCircle(t(bone.joint), 6, [255, 255, 255, 255]);
      raster.fillCircle(t(bone.joint), 4, color);
    }
  }
  return raster;
}

function drawFace(raster: Raster, keypoints: readonly Keypoint[], head: HeadShape, transform: Transform): void {
  const find = (name: string): Joint | null => keypoints.find((item) => item.name === name)?.point ?? null;
  const t = (point: Point): Point => toTarget(point, transform);
  const nose = find('nose');
  const scale = transform.scale;
  if (nose) {
    // The facing mark: a wedge from the head center to the nose.
    const center = head.center;
    const dx = nose.x - center.x;
    const dy = nose.y - center.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = (-dy / length) * head.rx * 0.18;
    const ny = (dx / length) * head.rx * 0.18;
    raster.fillPolygon([t({ x: center.x + nx, y: center.y + ny }), t(nose), t({ x: center.x - nx, y: center.y - ny })], [150, 150, 160, 255]);
    raster.fillCircle(t(nose), Math.max(3, 7 * scale), [200, 40, 40, 255]);
  }
  for (const name of ['r_eye', 'l_eye']) {
    const eye = find(name);
    if (eye) raster.fillCircle(t(eye), Math.max(3, 8 * scale), [30, 30, 40, 255]);
  }
  for (const name of ['r_ear', 'l_ear']) {
    const ear = find(name);
    if (ear) raster.fillCircle(t(ear), Math.max(4, 12 * scale), [120, 120, 130, 255]);
  }
}
