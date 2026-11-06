import type { ControlContract, Joint, Rect, Size } from '@control/contract';
import { fail, type Problem, problem } from '@control/problems';
import { type Color, ellipsePolygon, Raster } from '@control/raster';

// OpenPose BODY_18 (COCO) keypoints from the rig contract, and a pose image in the style that ControlNet pose models expect.
//
// Format reference (data, not code copied into this package):
// - Keypoint order, limb list, and colors: `draw_bodypose` in controlnet_aux (open_pose/util.py).
// - Line width: the xinsir/controlnet-openpose-sdxl-1.0 model card replaces `draw_bodypose` with a version that scales
//   the limb half-width (4) and the joint radius (4) by a ratio from max(W, H). The card says that thin default lines give unstable results.
// The image is not bit-exact to OpenCV output: polygon filling and rounding differ by at most one pixel at edges.

export const keypointNames = [
  'nose',
  'neck',
  'r_shoulder',
  'r_elbow',
  'r_wrist',
  'l_shoulder',
  'l_elbow',
  'l_wrist',
  'r_hip',
  'r_knee',
  'r_ankle',
  'l_hip',
  'l_knee',
  'l_ankle',
  'r_eye',
  'l_eye',
  'r_ear',
  'l_ear'
] as const;
export type KeypointName = (typeof keypointNames)[number];

/** Limb pairs as indices into keypointNames (controlnet_aux limbSeq minus 1). The first 17 are drawn. */
export const limbs: readonly (readonly [number, number])[] = [
  [1, 2],
  [1, 5],
  [2, 3],
  [3, 4],
  [5, 6],
  [6, 7],
  [1, 8],
  [8, 9],
  [9, 10],
  [1, 11],
  [11, 12],
  [12, 13],
  [1, 0],
  [0, 14],
  [14, 16],
  [0, 15],
  [15, 17]
];

/** One color for each keypoint and for the limb with the same index. */
export const keypointColors: readonly (readonly [number, number, number])[] = [
  [255, 0, 0],
  [255, 85, 0],
  [255, 170, 0],
  [255, 255, 0],
  [170, 255, 0],
  [85, 255, 0],
  [0, 255, 0],
  [0, 255, 85],
  [0, 255, 170],
  [0, 255, 255],
  [0, 170, 255],
  [0, 85, 255],
  [0, 0, 255],
  [85, 0, 255],
  [170, 0, 255],
  [255, 0, 255],
  [255, 0, 170],
  [255, 0, 85]
];

/**
 * How the contract sides map to the OpenPose subject sides.
 * - `detector`: the keypoints a pose detector gives for this layout seen from the front: the side on the left of the image is the subject's right.
 * - `anatomical`: `_near` is the subject's right, as the view `three_quarter_right` implies.
 */
export type SideMapping = 'detector' | 'anatomical';
export const sideMappings: readonly SideMapping[] = ['detector', 'anatomical'];

/**
 * Face keypoints are not in the contract. These fractions of the `head` attachment rectangle place them.
 * **Assumption** for the placeholder test rig: a face turned to the right of the image. Replace them with mannequin data when it exists.
 * `null` marks a keypoint that is hidden in this view.
 */
export const faceTemplate = {
  version: 'face-template-0',
  nose: { fx: 0.76, fy: 0.66 },
  r_eye: { fx: 0.45, fy: 0.55 },
  l_eye: { fx: 0.72, fy: 0.55 },
  r_ear: { fx: 0.22, fy: 0.56 },
  l_ear: null
} as const;

export type Keypoint = { readonly name: KeypointName; readonly point: Joint | null; readonly source: string };
export type Transform = { readonly scale: number; readonly offsetX: number; readonly offsetY: number };

export type RigPose = {
  readonly mapping: SideMapping;
  readonly keypoints: readonly Keypoint[];
  /** Body height in contract pixels: from the top of the `head` rectangle to the rig origin (ground). Measurements divide by it. */
  readonly bodyHeight: number;
  readonly bodyHeightSource: string;
  readonly warnings: readonly Problem[];
};

function boneJoint(contract: ControlContract, id: string): Joint {
  const bone = contract.bones.get(id);
  if (!bone) fail('E_CONTRACT_BONE_MISSING', `The contract has no bone ${id}, which the pose needs.`, id);
  return bone.joint;
}

function headRect(contract: ControlContract): Rect {
  const slot = contract.slots.get('head');
  if (!slot) fail('E_CONTRACT_SLOT_MISSING', 'The contract has no head slot, which the face keypoints need.', 'head');
  return slot.attachmentRect;
}

/** The checks of the side layout. They do not change the contract. They report what a pose model can misread. */
export function layoutWarnings(contract: ControlContract, keypoints: readonly Keypoint[]): Problem[] {
  const warnings: Problem[] = [];
  const near = boneJoint(contract, 'upper_arm_near');
  const far = boneJoint(contract, 'upper_arm_far');
  const nearHip = boneJoint(contract, 'thigh_near');
  const farHip = boneJoint(contract, 'thigh_far');
  // In a three-quarter view that faces right, the subject's right side is closer to the camera and is on the left of the image.
  if (near.x > far.x || nearHip.x > farHip.x) {
    warnings.push(
      problem(
        'W_RIG_SIDE_LAYOUT_VIEW_MISMATCH',
        `The near shoulder (x ${near.x}) and hip (x ${nearHip.x}) are on the right of the far shoulder (x ${far.x}) and hip (x ${farHip.x}). ` +
          'In a three-quarter view that faces right, the near side is on the left of the image. This layout reads as a body that faces left, or a back view.',
        'contract'
      )
    );
  }
  const find = (name: KeypointName): Joint | null => keypoints.find((item) => item.name === name)?.point ?? null;
  const [rs, ls, nose, neck] = [find('r_shoulder'), find('l_shoulder'), find('nose'), find('neck')];
  if (rs && ls && nose && neck && nose.x > neck.x && rs.x > ls.x) {
    warnings.push(
      problem('W_POSE_BACK_VIEW_SIGNAL', 'The right shoulder keypoint is on the right of the left shoulder keypoint, and the face looks right. A pose model can read this as a back view.', 'keypoints')
    );
  }
  return warnings;
}

/** Builds the OpenPose keypoints of the rig in contract space. Only the view `three_quarter_right` with `near_far` names is supported. */
export function rigPose(contract: ControlContract, mapping: SideMapping): RigPose {
  if (contract.view !== 'three_quarter_right') fail('E_VIEW_UNSUPPORTED', `The view ${contract.view} is not supported. Only three_quarter_right is.`);
  if (contract.sideNaming !== 'near_far') fail('E_VIEW_UNSUPPORTED', `The side naming ${contract.sideNaming} is not supported. Only near_far is.`);
  // `detector` gives the subject's right to the side whose shoulder is on the left of the image, as a detector does for a front view.
  const nearOnLeft = boneJoint(contract, 'upper_arm_near').x <= boneJoint(contract, 'upper_arm_far').x;
  const right = mapping === 'anatomical' || nearOnLeft ? 'near' : 'far';
  const left = right === 'near' ? 'far' : 'near';
  const fromBone = (name: KeypointName, bone: string): Keypoint => ({ name, point: boneJoint(contract, bone), source: `bone:${bone}` });
  const shoulderNear = boneJoint(contract, 'upper_arm_near');
  const shoulderFar = boneJoint(contract, 'upper_arm_far');
  const head = headRect(contract);
  // Face keypoints come from the contract points `face_nose`, `face_eye_<side>` and `face_ear_<side>` when the contract has them.
  // A missing face point is a hidden keypoint. Without any face point, the face template (an assumption) places them.
  const hasFacePoints = [...contract.points.keys()].some((id) => id.startsWith('face_'));
  const faceSide = { r_eye: `face_eye_${right}`, l_eye: `face_eye_${left}`, r_ear: `face_ear_${right}`, l_ear: `face_ear_${left}`, nose: 'face_nose' } as const;
  const face = (name: 'nose' | 'r_eye' | 'l_eye' | 'r_ear' | 'l_ear'): Keypoint => {
    if (hasFacePoints) {
      const point = contract.points.get(faceSide[name]);
      return point ? { name, point: point.position, source: `point:${point.id}` } : { name, point: null, source: `point:${faceSide[name]}:absent` };
    }
    const spec = faceTemplate[name];
    if (spec === null) return { name, point: null, source: `assumption:${faceTemplate.version}:hidden` };
    return { name, point: { x: head.x + spec.fx * head.w, y: head.y + spec.fy * head.h }, source: `assumption:${faceTemplate.version}:slot:head` };
  };
  const byName: Record<KeypointName, Keypoint> = {
    nose: face('nose'),
    neck: {
      name: 'neck',
      point: { x: (shoulderNear.x + shoulderFar.x) / 2, y: (shoulderNear.y + shoulderFar.y) / 2 },
      source: 'derived:midpoint(bone:upper_arm_near,bone:upper_arm_far)'
    },
    r_shoulder: fromBone('r_shoulder', `upper_arm_${right}`),
    r_elbow: fromBone('r_elbow', `forearm_${right}`),
    r_wrist: fromBone('r_wrist', `hand_${right}`),
    l_shoulder: fromBone('l_shoulder', `upper_arm_${left}`),
    l_elbow: fromBone('l_elbow', `forearm_${left}`),
    l_wrist: fromBone('l_wrist', `hand_${left}`),
    r_hip: fromBone('r_hip', `thigh_${right}`),
    r_knee: fromBone('r_knee', `shin_${right}`),
    r_ankle: fromBone('r_ankle', `foot_${right}`),
    l_hip: fromBone('l_hip', `thigh_${left}`),
    l_knee: fromBone('l_knee', `shin_${left}`),
    l_ankle: fromBone('l_ankle', `foot_${left}`),
    r_eye: face('r_eye'),
    l_eye: face('l_eye'),
    r_ear: face('r_ear'),
    l_ear: face('l_ear')
  };
  const keypoints = keypointNames.map((name) => byName[name]);
  const headTop = contract.points.get('head_top');
  const bodyHeight = contract.rigOrigin.y - (headTop ? headTop.position.y : head.y);
  if (!(bodyHeight > 0)) fail('E_CONTRACT_GEOMETRY', 'The top of the head is not above the rig origin.');
  return {
    mapping,
    keypoints,
    bodyHeight,
    bodyHeightSource: headTop ? 'space.rigOrigin.y - points.head_top.y' : 'space.rigOrigin.y - slots.head.attachmentRect.y',
    warnings: layoutWarnings(contract, keypoints)
  };
}

/** Uniform scale of the contract canvas into the target image, centered. The proportions do not change. */
export function fitTransform(canvas: Size, target: Size): Transform {
  const scale = Math.min(target.width / canvas.width, target.height / canvas.height);
  return { scale, offsetX: (target.width - canvas.width * scale) / 2, offsetY: (target.height - canvas.height * scale) / 2 };
}

export const toTarget = (point: Joint, transform: Transform): Joint => ({ x: point.x * transform.scale + transform.offsetX, y: point.y * transform.scale + transform.offsetY });
export const toContract = (point: Joint, transform: Transform): Joint => ({ x: (point.x - transform.offsetX) / transform.scale, y: (point.y - transform.offsetY) / transform.scale });

/** The line-width ratio of the xinsir pose drawing, from the longer image side. */
export function poseLineRatio(size: Size): number {
  const side = Math.max(size.width, size.height);
  const steps = [500, 1000, 2000, 3000, 4000, 5000];
  const index = steps.findIndex((limit) => side < limit);
  return index === -1 ? 7 : index + 1;
}

/** Draws the OpenPose BODY_18 image: black background, limbs at 60 % color, then joints at full color. */
export function renderOpenPose(keypoints: readonly Keypoint[], size: Size, transform: Transform): Raster {
  const raster = new Raster(size.width, size.height, [0, 0, 0, 255]);
  const ratio = poseLineRatio(size);
  const stickWidth = 4;
  const points = keypoints.map((item) => (item.point ? toTarget(item.point, transform) : null));
  for (const [index, [from, to]] of limbs.entries()) {
    const a = points[from];
    const b = points[to];
    const rgb = keypointColors[index];
    if (!a || !b || !rgb) continue;
    const length = Math.hypot(a.x - b.x, a.y - b.y);
    const angle = (Math.atan2(a.y - b.y, a.x - b.x) * 180) / Math.PI;
    const center = { x: Math.trunc((a.x + b.x) / 2), y: Math.trunc((a.y + b.y) / 2) };
    const polygon = ellipsePolygon(center, { a: Math.trunc(length / 2), b: Math.trunc(stickWidth * ratio) }, Math.trunc(angle));
    const color: Color = [Math.trunc(rgb[0] * 0.6), Math.trunc(rgb[1] * 0.6), Math.trunc(rgb[2] * 0.6), 255];
    raster.fillPolygon(
      polygon.map((point) => ({ x: point.x + 0.5, y: point.y + 0.5 })),
      color
    );
  }
  for (const [index, point] of points.entries()) {
    const rgb = keypointColors[index];
    if (!point || !rgb) continue;
    raster.fillCircle({ x: Math.trunc(point.x) + 0.5, y: Math.trunc(point.y) + 0.5 }, Math.trunc(4 * ratio), [rgb[0], rgb[1], rgb[2], 255]);
  }
  return raster;
}

/** OpenPose JSON (format 1.3) in target pixels. A hidden keypoint is 0, 0, 0. */
export function openPoseJson(keypoints: readonly Keypoint[], size: Size, transform: Transform): Record<string, unknown> {
  const flat: number[] = [];
  for (const item of keypoints) {
    if (!item.point) flat.push(0, 0, 0);
    else {
      const point = toTarget(item.point, transform);
      flat.push(round(point.x), round(point.y), 1);
    }
  }
  return { version: 1.3, canvas_width: size.width, canvas_height: size.height, people: [{ pose_keypoints_2d: flat }] };
}

export const round = (value: number): number => Math.round(value * 1000) / 1000;
