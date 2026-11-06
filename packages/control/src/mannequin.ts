import type { Joint, Rect } from '@control/contract';
import { fail, isRecord } from '@control/problems';

// A simple 3D reference body, projected to the contract canvas. It makes the candidate geometry of experiment C0.5.
// **Proposal.** The proportions, the yaw angle and the pose are recommendations for the owner, not accepted decisions.
//
// Body frame: `up` is the height above the ground, `left` is toward the subject's left side, `forward` is the facing direction.
// All lengths are in head units (the head height). The body is 7 head units tall (a common adult anime proportion).
// Camera: orthographic, looking along -z. The subject turns `yaw` degrees from the camera toward the right of the image.
//   facing f = (sin yaw, 0, cos yaw), subject left l = (cos yaw, 0, -sin yaw), subject right r = -l.
//   So the subject's right side moves toward the camera (near) and to the left of the image.

export type Landmark = { readonly up: number; readonly left: number; readonly forward: number };

export const referenceBody = {
  version: 'reference-body-0',
  heads: 7,
  yawDegrees: 40,
  /** Landmarks of one side are given for the subject's right side (`left` < 0). The other side mirrors `left`. */
  landmarks: {
    head_top: { up: 7, left: 0, forward: 0 },
    head: { up: 6, left: 0, forward: 0.05 },
    neck: { up: 5.7, left: 0, forward: -0.02 },
    chest: { up: 4.9, left: 0, forward: 0 },
    spine: { up: 4.25, left: 0, forward: 0 },
    hips: { up: 3.7, left: 0, forward: 0 },
    upper_arm: { up: 5.55, left: -0.85, forward: -0.02 },
    forearm: { up: 4.35, left: -1.25, forward: -0.05 },
    hand: { up: 3.3, left: -1.5, forward: 0.12 },
    thigh: { up: 3.55, left: -0.45, forward: 0 },
    shin: { up: 1.9, left: -0.45, forward: 0.05 },
    foot: { up: 0.25, left: -0.48, forward: 0 },
    toe: { up: 0.05, left: -0.5, forward: 0.75 },
    face_nose: { up: 6.3, left: 0, forward: 0.55 },
    face_eye: { up: 6.45, left: -0.18, forward: 0.28 },
    face_ear: { up: 6.45, left: -0.45, forward: -0.02 },
    ear: { up: 6.95, left: -0.3, forward: -0.05 },
    hair_tail_1: { up: 6.4, left: 0, forward: -0.48 },
    hair_tail_2: { up: 5.5, left: 0, forward: -0.65 },
    tail_1: { up: 3.6, left: 0, forward: -0.42 },
    tail_2: { up: 3.15, left: 0, forward: -0.95 },
    skirt_front: { up: 3.75, left: 0, forward: 0.3 },
    skirt_back: { up: 3.75, left: 0, forward: -0.3 },
    weapon_grip: { up: 3.2, left: -1.5, forward: 0.18 }
  },
  /** Half-widths (lateral) and half-depths (forward) of body parts in head units, for the silhouette and the slot rectangles. */
  radii: {
    head: { w: 0.42, d: 0.48, h: 0.5 },
    neck: { w: 0.16, d: 0.16 },
    chest: { w: 0.78, d: 0.5 },
    waist: { w: 0.55, d: 0.4 },
    pelvis: { w: 0.8, d: 0.52 },
    upper_arm: 0.17,
    forearm: 0.14,
    hand: 0.16,
    thigh: 0.3,
    shin: 0.2,
    foot: 0.15
  }
} as const;

export type ProjectedPoint = Joint & { readonly depth: number };

export type BodyProjection = {
  readonly headUnitPx: number;
  readonly yawDegrees: number;
  readonly project: (landmark: Landmark) => ProjectedPoint;
};

/** Projects the body into contract space: ground at `origin.y`, body center at `origin.x`, `bodyHeightPx` from ground to head top. */
export function bodyProjection(origin: Joint, bodyHeightPx: number, yawDegrees: number): BodyProjection {
  if (!(yawDegrees > 0 && yawDegrees < 90)) fail('E_USAGE', 'The yaw must be between 0 and 90 degrees for a front-visible three-quarter view.');
  const unit = bodyHeightPx / referenceBody.heads;
  const yaw = (yawDegrees * Math.PI) / 180;
  return {
    headUnitPx: unit,
    yawDegrees,
    project: ({ up, left, forward }) => ({
      x: origin.x + (left * Math.cos(yaw) + forward * Math.sin(yaw)) * unit,
      y: origin.y - up * unit,
      depth: (-left * Math.sin(yaw) + forward * Math.cos(yaw)) * unit
    })
  };
}

const mirror = (landmark: Landmark): Landmark => ({ ...landmark, left: -landmark.left });
const sided = (landmark: Landmark, side: 'near' | 'far'): Landmark => (side === 'near' ? landmark : mirror(landmark));
const r1 = (value: number): number => Math.round(value);

/** Projected half-width of an ellipse with half-width w and half-depth d at the yaw. */
export function projectedHalfWidth(w: number, d: number, yawDegrees: number): number {
  const yaw = (yawDegrees * Math.PI) / 180;
  return Math.hypot(w * Math.cos(yaw), d * Math.sin(yaw));
}

/** Joints of all contract bones in the candidate geometry, rounded to whole pixels. `aim` keeps its base position. */
export function candidateJoints(projection: BodyProjection, aim: Joint): Map<string, Joint> {
  const l = referenceBody.landmarks;
  const joints = new Map<string, Joint>();
  const put = (id: string, landmark: Landmark): void => {
    const point = projection.project(landmark);
    joints.set(id, { x: r1(point.x), y: r1(point.y) });
  };
  put('hips', l.hips);
  put('spine', l.spine);
  put('chest', l.chest);
  put('neck', l.neck);
  put('head', l.head);
  for (const side of ['near', 'far'] as const) {
    put(`upper_arm_${side}`, sided(l.upper_arm, side));
    put(`forearm_${side}`, sided(l.forearm, side));
    put(`hand_${side}`, sided(l.hand, side));
    put(`thigh_${side}`, sided(l.thigh, side));
    put(`shin_${side}`, sided(l.shin, side));
    put(`foot_${side}`, sided(l.foot, side));
    put(`ear_${side}`, sided(l.ear, side));
  }
  put('hair_tail_1', l.hair_tail_1);
  put('hair_tail_2', l.hair_tail_2);
  put('tail_1', l.tail_1);
  put('tail_2', l.tail_2);
  put('skirt_front', l.skirt_front);
  put('skirt_back', l.skirt_back);
  put('weapon_grip', l.weapon_grip);
  joints.set('aim', aim);
  return joints;
}

/** Face points in the candidate: nose, both eyes, the near ear. The far ear is hidden behind the head at this yaw. */
export function candidateFacePoints(projection: BodyProjection): { id: string; bone: string; position: Joint }[] {
  const l = referenceBody.landmarks;
  const at = (landmark: Landmark): Joint => {
    const point = projection.project(landmark);
    return { x: r1(point.x), y: r1(point.y) };
  };
  return [
    { id: 'head_top', bone: 'head', position: at(l.head_top) },
    { id: 'face_nose', bone: 'head', position: at(l.face_nose) },
    { id: 'face_eye_near', bone: 'head', position: at(l.face_eye) },
    { id: 'face_eye_far', bone: 'head', position: at(mirror(l.face_eye)) },
    { id: 'face_ear_near', bone: 'head', position: at(l.face_ear) }
  ];
}

function boundsOf(points: readonly Joint[], margin: number): Rect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.floor(Math.min(...xs) - margin);
  const y = Math.floor(Math.min(...ys) - margin);
  return { x, y, w: Math.ceil(Math.max(...xs) + margin) - x, h: Math.ceil(Math.max(...ys) + margin) - y };
}

const unionRect = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/**
 * Attachment rectangles for the candidate. A body segment covers its pivot, the child pivot, its projected radius, and the joint overlap.
 * Hair, ears, tail, skirt, accessory and weapon rectangles are generous placeholders around the matching landmarks.
 */
export function candidateRects(joints: ReadonlyMap<string, Joint>, projection: BodyProjection, overlapPx: number): Map<string, Rect> {
  const u = projection.headUnitPx;
  const radii = referenceBody.radii;
  const yaw = projection.yawDegrees;
  const j = (id: string): Joint => joints.get(id) ?? fail('E_CONTRACT_BONE_MISSING', `The candidate has no joint ${id}.`);
  const segment = (from: string, to: string, radius: number): Rect => boundsOf([j(from), j(to)], Math.max(radius * u, overlapPx) + 8);
  const rects = new Map<string, Rect>();
  const toe = (side: 'near' | 'far'): Joint => {
    const point = projection.project(sided(referenceBody.landmarks.toe, side));
    return { x: point.x, y: point.y };
  };
  for (const side of ['near', 'far'] as const) {
    rects.set(`upper_arm_${side}`, segment(`upper_arm_${side}`, `forearm_${side}`, radii.upper_arm));
    rects.set(`forearm_${side}`, segment(`forearm_${side}`, `hand_${side}`, radii.forearm));
    const hand = j(`hand_${side}`);
    rects.set(`hand_${side}`, boundsOf([hand, { x: hand.x, y: hand.y + 0.55 * u }], radii.hand * u + 10));
    rects.set(`thigh_${side}`, segment(`thigh_${side}`, `shin_${side}`, radii.thigh));
    rects.set(`shin_${side}`, segment(`shin_${side}`, `foot_${side}`, radii.shin));
    rects.set(`foot_${side}`, boundsOf([j(`foot_${side}`), toe(side), { x: j(`foot_${side}`).x, y: j('root').y }], radii.foot * u + 10));
    const ear = j(`ear_${side}`);
    rects.set(`ear_${side}`, boundsOf([ear, { x: ear.x, y: ear.y - 0.6 * u }], 0.35 * u));
  }
  const handNear = j('hand_near');
  rects.set('hand_near_front', boundsOf([handNear, { x: handNear.x, y: handNear.y + 0.4 * u }], 0.12 * u + 6));
  const chestHalf = projectedHalfWidth(radii.chest.w, radii.chest.d, yaw) * u;
  const pelvisHalf = projectedHalfWidth(radii.pelvis.w, radii.pelvis.d, yaw) * u;
  rects.set('torso', boundsOf([j('neck'), j('spine'), { x: j('chest').x - chestHalf, y: j('chest').y }, { x: j('chest').x + chestHalf, y: j('chest').y }], 0.25 * u));
  rects.set('hips', boundsOf([j('spine'), j('thigh_near'), j('thigh_far'), { x: j('hips').x - pelvisHalf, y: j('hips').y }, { x: j('hips').x + pelvisHalf, y: j('hips').y }], 0.3 * u));
  rects.set('neck', boundsOf([j('neck'), j('head')], radii.neck.w * u + overlapPx));
  const headTop = projection.project(referenceBody.landmarks.head_top);
  const headHalf = projectedHalfWidth(radii.head.w, radii.head.d, yaw) * u;
  const headCenter = { x: (j('head').x + headTop.x) / 2 + 0.15 * u, y: (j('head').y + headTop.y) / 2 };
  const head = boundsOf(
    [
      { x: headCenter.x - headHalf, y: headTop.y },
      { x: headCenter.x + headHalf, y: j('head').y }
    ],
    0.25 * u
  );
  rects.set('head', head);
  rects.set(
    'hair_front',
    boundsOf(
      [
        { x: head.x, y: head.y },
        { x: head.x + head.w, y: head.y + head.h }
      ],
      0.15 * u
    )
  );
  rects.set(
    'hair_back',
    unionRect(
      boundsOf(
        [
          { x: head.x, y: head.y },
          { x: head.x + head.w, y: head.y + head.h }
        ],
        0.3 * u
      ),
      boundsOf([j('hair_tail_1'), j('neck')], 0.6 * u)
    )
  );
  rects.set('hair_tail', boundsOf([j('hair_tail_1'), j('hair_tail_2')], 0.6 * u));
  rects.set(
    'acc_head',
    boundsOf(
      [
        { x: head.x, y: headTop.y },
        { x: head.x + head.w, y: headTop.y + 0.4 * u }
      ],
      0.3 * u
    )
  );
  rects.set('tail', boundsOf([j('tail_1'), j('tail_2')], 0.7 * u));
  rects.set('skirt_front', boundsOf([j('skirt_front'), { x: j('hips').x - pelvisHalf, y: j('hips').y }, { x: j('hips').x + pelvisHalf, y: j('hips').y + 1.2 * u }], 0.25 * u));
  rects.set('skirt_back', boundsOf([j('skirt_back'), { x: j('hips').x - pelvisHalf, y: j('hips').y }, { x: j('hips').x + pelvisHalf, y: j('hips').y + 1.2 * u }], 0.25 * u));
  const grip = j('weapon_grip');
  rects.set('weapon', { x: Math.floor(grip.x - 0.4 * u), y: Math.floor(grip.y - 0.7 * u), w: Math.ceil(2.4 * u), h: Math.ceil(1.15 * u) });
  return rects;
}

/**
 * Builds the candidate rig contract from a base contract. It keeps the ids, parents, roles, slots, draw order, overlaps, animations,
 * tolerances, space and mirroring of the base. It replaces joints, attachment rectangles and points, and adds face points.
 */
export function candidateContract(base: Record<string, unknown>, yawDegrees: number = referenceBody.yawDegrees): Record<string, unknown> {
  const space = base.space;
  if (!isRecord(space) || !isRecord(space.rigOrigin) || !Array.isArray(base.bones) || !Array.isArray(base.slots)) fail('E_CONTRACT_FORMAT', 'The base contract has no space, bones or slots.');
  const origin = { x: space.rigOrigin.x as number, y: space.rigOrigin.y as number };
  const head = (base.slots as Record<string, unknown>[]).find((slot) => slot.id === 'head');
  const headRect = isRecord(head?.attachmentRect) ? head.attachmentRect : undefined;
  if (!headRect) fail('E_CONTRACT_SLOT_MISSING', 'The base contract has no head slot.');
  // Keep the body height of the base (top of the head rectangle to the ground), so the canvas use does not change.
  const bodyHeight = origin.y - (headRect.y as number);
  const projection = bodyProjection(origin, bodyHeight, yawDegrees);
  const aimBone = (base.bones as Record<string, unknown>[]).find((bone) => bone.id === 'aim');
  const aim = isRecord(aimBone?.joint) ? { x: aimBone.joint.x as number, y: aimBone.joint.y as number } : { x: origin.x + 400, y: origin.y - 800 };
  const joints = candidateJoints(projection, aim);
  joints.set('root', origin);
  const overlap = Math.max(
    0,
    ...(base.slots as Record<string, unknown>[]).flatMap((slot) =>
      Array.isArray(slot.overlap) ? slot.overlap.map((item) => (isRecord(item) && typeof item.radiusPx === 'number' ? item.radiusPx : 0)) : []
    )
  );
  const rects = candidateRects(joints, projection, overlap);
  const bones = (base.bones as Record<string, unknown>[]).map((bone) => {
    const joint = joints.get(bone.id as string);
    if (!joint) fail('E_CONTRACT_BONE_MISSING', `The candidate has no joint for bone ${String(bone.id)}.`);
    return { ...bone, joint };
  });
  const slots = (base.slots as Record<string, unknown>[]).map((slot) => {
    const rect = rects.get(slot.id as string);
    if (!rect) fail('E_CONTRACT_SLOT_MISSING', `The candidate has no rectangle for slot ${String(slot.id)}.`);
    return { ...slot, attachmentRect: rect };
  });
  const handNear = joints.get('weapon_grip') ?? origin;
  const u = projection.headUnitPx;
  const chest = joints.get('chest') ?? origin;
  const points = [
    { id: 'grip', bone: 'weapon_grip', position: handNear },
    { id: 'muzzle', bone: 'weapon_grip', position: { x: r1(handNear.x + 1.9 * u), y: r1(handNear.y - 0.15 * u) } },
    { id: 'fx_hit', bone: 'chest', position: { x: r1(chest.x + 0.15 * u), y: r1(chest.y - 0.3 * u) } },
    ...candidateFacePoints(projection)
  ];
  return {
    rigId: `${String(base.rigId)}_c05_candidate`,
    contractVersion: '0.3.0',
    spine: { editorVersion: isRecord(base.spine) ? base.spine.editorVersion : null, skeletonFile: null, skeletonSha256: null },
    space: base.space,
    view: base.view,
    sideNaming: base.sideNaming,
    tolerances: base.tolerances,
    bones,
    slots,
    points,
    animations: base.animations,
    mirroring: base.mirroring
  };
}
