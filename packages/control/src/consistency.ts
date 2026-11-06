import type { ControlContract, Joint } from '@control/contract';
import { hullOfCircles, mannequinPieces } from '@control/figure';
import { rigPose } from '@control/pose';
import type { Point } from '@control/raster';

// Consistency checks of a contract against the intended view: a front-visible three-quarter view that faces the right of the image.
// The intended view is a proposed interpretation of `three_quarter_right`. The owner accepts it or not.
//
// Kinds:
// - `geometric`: follows from the joint coordinates of the setup pose and the stated view definition.
// - `heuristic`: a measured proxy with a chosen threshold (proportions, separation).
// - `visual`: a person must confirm it on the pictures.
// A lateral (x) order of joints is a valid view cue only for the neutral setup pose. In other poses, limbs can cross.

export type CheckStatus = 'PASS' | 'FAIL' | 'INCOMPLETE' | 'INFO';
export type Check = { readonly id: string; readonly kind: 'geometric' | 'heuristic' | 'visual'; readonly status: CheckStatus; readonly message: string };

const fmt = (value: number): string => String(Math.round(value * 10) / 10);

function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i] as Point;
    const b = polygon[j] as Point;
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Signed gap from a circle to a convex polygon outline: negative when they overlap. */
function circleGap(center: Point, radius: number, polygon: readonly Point[]): number {
  if (pointInPolygon(center, polygon)) return -radius;
  let best = Infinity;
  for (let i = 0; i < polygon.length; i += 1) best = Math.min(best, distanceToSegment(center, polygon[i] as Point, polygon[(i + 1) % polygon.length] as Point));
  return best - radius;
}

/** Runs all checks. The contract must have the view `three_quarter_right` and `near_far` side names. */
export function consistencyChecks(contract: ControlContract): Check[] {
  const checks: Check[] = [];
  const add = (id: string, kind: Check['kind'], status: CheckStatus, message: string): void => {
    checks.push({ id, kind, status, message });
  };
  const j = (id: string): Joint | undefined => contract.bones.get(id)?.joint;
  const pair = (id: string, base: string, what: string): void => {
    const near = j(`${base}_near`);
    const far = j(`${base}_far`);
    if (!near || !far) {
      add(id, 'geometric', 'INCOMPLETE', `The contract has no ${base}_near and ${base}_far bones.`);
      return;
    }
    add(
      id,
      'geometric',
      near.x < far.x ? 'PASS' : 'FAIL',
      `${what}: near x ${fmt(near.x)}, far x ${fmt(far.x)}. In the setup pose of a front-visible view that faces right, the near side (subject's right) is on the left of the image.`
    );
  };
  pair('V1_SHOULDER_ORDER', 'upper_arm', 'Shoulders');
  pair('V2_HIP_ORDER', 'thigh', 'Hip joints');
  pair('V3_EAR_BONE_ORDER', 'ear', 'Animal ear bones');

  const cues: [string, Joint | undefined, Joint | undefined][] = [
    ['skirt_front right of skirt_back', j('skirt_front'), j('skirt_back')],
    ['hips right of tail_1', j('hips'), j('tail_1')],
    ['head right of hair_tail_1', j('head'), j('hair_tail_1')],
    ['aim right of root', j('aim'), j('root')],
    ['muzzle right of grip', contract.points.get('muzzle')?.position, contract.points.get('grip')?.position]
  ];
  const failed = cues.filter(([, a, b]) => a && b && !(a.x > b.x)).map(([name]) => name);
  const present = cues.filter(([, a, b]) => a && b).length;
  add(
    'V4_FRONT_BACK_CUES',
    'geometric',
    present === 0 ? 'INCOMPLETE' : failed.length === 0 ? 'PASS' : 'FAIL',
    failed.length === 0 ? `${present} front/back cues agree with facing right.` : `Cues that disagree with facing right: ${failed.join(', ')}.`
  );

  const nose = contract.points.get('face_nose')?.position;
  const eyeNear = contract.points.get('face_eye_near')?.position;
  const eyeFar = contract.points.get('face_eye_far')?.position;
  const head = j('head');
  if (!nose || !eyeNear || !eyeFar || !head)
    add('V5_FACE_DIRECTION', 'geometric', 'INCOMPLETE', 'The contract has no face points (face_nose, face_eye_near, face_eye_far). The face direction is not defined by the contract.');
  else {
    const ok = nose.x > head.x && eyeFar.x > eyeNear.x && nose.x > (eyeNear.x + eyeFar.x) / 2;
    add(
      'V5_FACE_DIRECTION',
      'geometric',
      ok ? 'PASS' : 'FAIL',
      `Nose x ${fmt(nose.x)}, near eye x ${fmt(eyeNear.x)}, far eye x ${fmt(eyeFar.x)}, chin x ${fmt(head.x)}. Facing right needs the nose right of the chin and of the midpoint of the eyes, and the far eye right of the near eye.`
    );
  }

  const anatomical = rigPose(contract, 'anatomical');
  const detector = rigPose(contract, 'detector');
  const same = JSON.stringify(anatomical.keypoints.map((item) => item.point)) === JSON.stringify(detector.keypoints.map((item) => item.point));
  const k = (name: string): Joint | null => anatomical.keypoints.find((item) => item.name === name)?.point ?? null;
  const rs = k('r_shoulder');
  const ls = k('l_shoulder');
  const rh = k('r_hip');
  const lh = k('l_hip');
  const labelsOk = same && rs && ls && rh && lh && rs.x < ls.x && rh.x < lh.x && anatomical.warnings.length === 0;
  add(
    'V6_OPENPOSE_LABELS',
    'geometric',
    labelsOk ? 'PASS' : 'FAIL',
    labelsOk
      ? 'The anatomical labels (near = subject right) and the detector labels give the same BODY_18 keypoints. The right shoulder and hip are on the left of the image.'
      : `The anatomical and detector labels differ or give warnings: ${anatomical.warnings.map((item) => item.code).join(', ') || 'keypoints differ'}.`
  );

  const order = (id: string): number | undefined => contract.slots.get(id)?.drawOrder;
  const torso = order('torso');
  const hips = order('hips');
  const behind = ['upper_arm_far', 'forearm_far', 'hand_far', 'thigh_far', 'shin_far', 'foot_far'].filter((id) => torso !== undefined && (order(id) ?? -1) > torso);
  const front = ['upper_arm_near', 'forearm_near', 'hand_near'].filter((id) => torso !== undefined && (order(id) ?? Infinity) < torso);
  const legs = ['thigh_near', 'shin_near', 'foot_near'].filter((id) => hips !== undefined && (order(id) ?? Infinity) < hips);
  const drawOk = behind.length === 0 && front.length === 0 && legs.length === 0;
  add(
    'V7_DRAW_ORDER',
    'geometric',
    drawOk ? 'PASS' : 'FAIL',
    drawOk ? 'Far limbs are behind the torso, near arm parts are in front of the torso, and near leg parts are in front of the hips.' : `Out of order: ${[...behind, ...front, ...legs].join(', ')}.`
  );

  const children = new Map<string, string[]>();
  for (const bone of contract.bones.values()) if (bone.parent) children.set(bone.parent, [...(children.get(bone.parent) ?? []), bone.id]);
  const rectProblems: string[] = [];
  const canvas = contract.canvas;
  const inside = (p: Joint, r: { x: number; y: number; w: number; h: number }, margin = 0): boolean =>
    p.x - margin >= r.x && p.x + margin <= r.x + r.w && p.y - margin >= r.y && p.y + margin <= r.y + r.h;
  const bodySlots = [
    'torso',
    'hips',
    'neck',
    'upper_arm_near',
    'forearm_near',
    'hand_near',
    'upper_arm_far',
    'forearm_far',
    'hand_far',
    'thigh_near',
    'shin_near',
    'foot_near',
    'thigh_far',
    'shin_far',
    'foot_far'
  ];
  for (const slot of contract.slots.values()) {
    const r = slot.attachmentRect;
    if (r.x < 0 || r.y < 0 || r.x + r.w > canvas.width || r.y + r.h > canvas.height) rectProblems.push(`${slot.id} leaves the canvas`);
    if (!bodySlots.includes(slot.id)) continue;
    const pivot = j(slot.bone);
    if (pivot && !inside(pivot, r)) rectProblems.push(`${slot.id} does not contain its pivot`);
    const child = (children.get(slot.bone) ?? []).find((id) => !id.startsWith('weapon') && !id.startsWith('tail') && !id.startsWith('skirt'));
    const childJoint = child ? j(child) : undefined;
    if (childJoint && ['upper_arm', 'forearm', 'thigh', 'shin'].some((prefix) => slot.id.startsWith(prefix)) && !inside(childJoint, r, 24))
      rectProblems.push(`${slot.id} does not cover the overlap circle of ${String(child)}`);
  }
  add(
    'V8_SLOT_RECTS',
    'geometric',
    rectProblems.length === 0 ? 'PASS' : 'FAIL',
    rectProblems.length === 0 ? 'All slot rectangles are on the canvas. Each limb rectangle contains its pivot and the 24 px overlap circle of its child joint.' : rectProblems.join('; ')
  );

  const top = contract.points.get('head_top')?.position;
  if (!top || !head) add('V9_ADULT_PROPORTION', 'heuristic', 'INCOMPLETE', 'The contract has no head_top point, so the head height is not defined.');
  else {
    const heads = (contract.rigOrigin.y - top.y) / (head.y - top.y);
    add('V9_ADULT_PROPORTION', 'heuristic', heads >= 6.5 ? 'PASS' : 'FAIL', `Body height is ${fmt(heads)} head heights (threshold 6.5, a proxy for an adult anime figure, not a proof of age).`);
  }

  const bodyHeight = anatomical.bodyHeight;
  const pieces = mannequinPieces(contract, bodyHeight, 1);
  const torsoHull = pieces.filter((piece) => piece.slot === 'torso' || piece.slot === 'hips').map((piece) => hullOfCircles(piece.circles, 0));
  const gaps: string[] = [];
  let minGap = Infinity;
  for (const id of ['forearm_near', 'hand_near']) {
    const point = j(id);
    if (!point) continue;
    const radius = (id === 'hand_near' ? 0.023 * 0.8 : 0.02) * bodyHeight;
    const gap = Math.min(...torsoHull.map((polygon) => circleGap(point, radius, polygon)));
    minGap = Math.min(minGap, gap);
    gaps.push(`${id} ${fmt(gap)} px`);
  }
  add(
    'V10_NEAR_ARM_SEPARATION',
    'heuristic',
    minGap > 0 ? 'PASS' : 'FAIL',
    `Gap between the near elbow and wrist and the torso silhouette of the flat mannequin: ${gaps.join(', ')} (must be above 0).`
  );
  add(
    'V11_VISUAL_REVIEW',
    'visual',
    'INFO',
    'A person must confirm on the pictures that the mannequin reads as a front-visible three-quarter view facing right, and that the near and far limbs are read correctly.'
  );
  return checks;
}
