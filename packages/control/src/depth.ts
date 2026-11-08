import type { ControlContract, Joint, Size } from '@control/contract';
import { type Landmark, referenceBody } from '@control/mannequin';
import { round, toContract, type Transform } from '@control/pose';
import { fail } from '@control/problems';
import { type Color, Raster } from '@control/raster';

// An approximate depth image of the C0.5 reference body, for the depth mode of the union ControlNet (experiment C2).
//
// **Approximation, not a body scan.** The body is a set of simple volumes: ellipsoids for the head and the torso, capsules for the neck,
// the limbs, the hands and the feet. The positions and most sizes come from `referenceBody` (C0.5). The values that `referenceBody` does not
// have are listed in `depthAssumptions` and in the report. No hair, no clothing, no fingers, no breasts, and no face detail except a small nose.
//
// Camera and frames are the same as in mannequin.ts: orthographic, yaw 40 degrees, body frame (left, up, forward) in head units.
// Each pixel sends one ray along the camera axis. The nearest surface wins, so the near limbs cover the far limbs and the torso covers the far arm.
// The image is a relative depth map: near surfaces are bright, far surfaces are dark, the background is black (the MiDaS convention).
// The build is deterministic: no random values, fixed 2 x 2 samples per pixel, fixed rounding.

type Vec = { readonly l: number; readonly up: number; readonly f: number };
export type DepthPart = 'head' | 'neck' | 'torso' | 'arm_near' | 'arm_far' | 'leg_near' | 'leg_far';
export type Section = { readonly up: number; readonly w: number; readonly d: number };
export type Primitive =
  | { readonly kind: 'ellipsoid'; readonly id: string; readonly part: DepthPart; readonly center: Vec; readonly radii: Vec }
  | { readonly kind: 'loft'; readonly id: string; readonly part: DepthPart; readonly sections: readonly Section[]; readonly bottomCap: number; readonly topCap: number }
  | { readonly kind: 'capsule'; readonly id: string; readonly part: DepthPart; readonly a: Vec; readonly b: Vec; readonly r: number };

/** Values that `referenceBody` does not give. All in head units. They are assumptions of this renderer, not contract data. */
export const depthAssumptions = {
  version: 'depth-mannequin-0',
  torso: {
    source: 'One smooth volume with elliptic cross-sections. w and d at pelvis, waist and chest from radii; the other sections, the heights, and the end caps are assumed.',
    sections: [
      { up: 3.3, w: 0.62, d: 0.44 },
      { up: 3.6, w: 0.8, d: 0.52 },
      { up: 4.3, w: 0.58, d: 0.41 },
      { up: 4.95, w: 0.78, d: 0.5 },
      { up: 5.35, w: 0.76, d: 0.45 },
      { up: 5.55, w: 0.6, d: 0.36 }
    ],
    bottomCap: 0.15,
    topCap: 0.2
  },
  head: { centerUp: 6.5, source: 'center = head_top.up - radii.head.h; forward offset from landmarks.head' },
  neck: { fromUp: 5.35, toUp: 6.15, source: 'assumed: from inside the shoulders to inside the head; radius from radii.neck' },
  nose: { radius: 0.08, inset: 0.05, source: 'assumed: a small sphere at landmarks.face_nose, so the face direction shows in the depth' },
  hand: { length: 0.5, source: 'assumed: a capsule from the wrist down; radius from radii.hand' },
  foot: { source: 'capsule from landmarks.foot to landmarks.toe; radius from radii.foot; surfaces below the ground are cut' },
  encoding: { near: 255, far: 40, background: 0, source: 'assumed: linear in camera depth between the nearest and the farthest body surface' },
  samplesPerPixel: 4
} as const;

const add = (a: Vec, b: Vec): Vec => ({ l: a.l + b.l, up: a.up + b.up, f: a.f + b.f });
const sub = (a: Vec, b: Vec): Vec => ({ l: a.l - b.l, up: a.up - b.up, f: a.f - b.f });
const scale = (a: Vec, s: number): Vec => ({ l: a.l * s, up: a.up * s, f: a.f * s });
const dot = (a: Vec, b: Vec): number => a.l * b.l + a.up * b.up + a.f * b.f;
const vec = (landmark: Landmark): Vec => ({ l: landmark.left, up: landmark.up, f: landmark.forward });
const mirrored = (landmark: Landmark): Vec => ({ l: -landmark.left, up: landmark.up, f: landmark.forward });

/** The volumes of the reference body. The near side is the subject's right side (`left` < 0), as in mannequin.ts. */
export function depthPrimitives(): Primitive[] {
  const l = referenceBody.landmarks;
  const r = referenceBody.radii;
  const a = depthAssumptions;
  const list: Primitive[] = [];
  list.push({ kind: 'loft', id: 'torso', part: 'torso', sections: a.torso.sections, bottomCap: a.torso.bottomCap, topCap: a.torso.topCap });
  list.push({ kind: 'ellipsoid', id: 'head', part: 'head', center: { l: 0, up: a.head.centerUp, f: l.head.forward }, radii: { l: r.head.w, up: r.head.h, f: r.head.d } });
  const nose = vec(l.face_nose);
  list.push({ kind: 'ellipsoid', id: 'nose', part: 'head', center: { ...nose, f: nose.f - a.nose.inset }, radii: { l: a.nose.radius, up: a.nose.radius, f: a.nose.radius } });
  list.push({ kind: 'capsule', id: 'neck', part: 'neck', a: { l: 0, up: a.neck.fromUp, f: l.neck.forward }, b: { l: 0, up: a.neck.toUp, f: l.head.forward }, r: r.neck.w });
  for (const side of ['near', 'far'] as const) {
    const at = (landmark: Landmark): Vec => (side === 'near' ? vec(landmark) : mirrored(landmark));
    const arm: DepthPart = side === 'near' ? 'arm_near' : 'arm_far';
    const leg: DepthPart = side === 'near' ? 'leg_near' : 'leg_far';
    const wrist = at(l.hand);
    list.push({ kind: 'capsule', id: `upper_arm_${side}`, part: arm, a: at(l.upper_arm), b: at(l.forearm), r: r.upper_arm });
    list.push({ kind: 'capsule', id: `forearm_${side}`, part: arm, a: at(l.forearm), b: wrist, r: r.forearm });
    list.push({ kind: 'capsule', id: `hand_${side}`, part: arm, a: wrist, b: add(wrist, { l: 0, up: -a.hand.length, f: 0 }), r: r.hand });
    list.push({ kind: 'capsule', id: `thigh_${side}`, part: leg, a: at(l.thigh), b: at(l.shin), r: r.thigh });
    list.push({ kind: 'capsule', id: `shin_${side}`, part: leg, a: at(l.shin), b: at(l.foot), r: r.shin });
    list.push({ kind: 'capsule', id: `foot_${side}`, part: leg, a: at(l.foot), b: at(l.toe), r: r.foot });
  }
  return list;
}

/**
 * Half-width and half-depth of a loft at a height, or null outside it. Between two sections the radii follow a cosine ease (smooth outline).
 * Below the first section and above the last, a round cap of the given height closes the volume.
 */
export function loftSection(sections: readonly Section[], bottomCap: number, topCap: number, up: number): { w: number; d: number } | null {
  const first = sections[0] as Section;
  const last = sections[sections.length - 1] as Section;
  if (up < first.up) {
    const k = (first.up - up) / bottomCap;
    return k >= 1 ? null : { w: first.w * Math.sqrt(1 - k * k), d: first.d * Math.sqrt(1 - k * k) };
  }
  if (up > last.up) {
    const k = (up - last.up) / topCap;
    return k >= 1 ? null : { w: last.w * Math.sqrt(1 - k * k), d: last.d * Math.sqrt(1 - k * k) };
  }
  for (let i = 1; i < sections.length; i += 1) {
    const a = sections[i - 1] as Section;
    const b = sections[i] as Section;
    if (up <= b.up) {
      const t = (1 - Math.cos((Math.PI * (up - a.up)) / (b.up - a.up))) / 2;
      return { w: a.w + (b.w - a.w) * t, d: a.d + (b.d - a.d) * t };
    }
  }
  return null;
}

const loftStep = 0.005;

/** Distance along the ray (unit direction) to the first surface, or -1. */
export function intersect(primitive: Primitive, origin: Vec, direction: Vec): number {
  if (primitive.kind === 'loft') {
    const { sections, bottomCap, topCap } = primitive;
    if (Math.abs(direction.up) < 1e-9) {
      // A horizontal ray stays at one height: the cross-section there is an ellipse, so the hit is exact.
      const section = loftSection(sections, bottomCap, topCap, origin.up);
      if (!section) return -1;
      const ox = origin.l / section.w;
      const oz = origin.f / section.d;
      const dx = direction.l / section.w;
      const dz = direction.f / section.d;
      const qa = dx * dx + dz * dz;
      const qb = ox * dx + oz * dz;
      const h = qb * qb - qa * (ox * ox + oz * oz - 1);
      if (h < 0) return -1;
      const t = (-qb - Math.sqrt(h)) / qa;
      return t > 0 ? t : -1;
    }
    // Other rays (the top view only): march in fixed steps. Deterministic, with an error of at most one step.
    // A vertical ray that passes outside the widest section cannot hit.
    const reach = Math.max(...sections.map((section) => Math.max(section.w, section.d)));
    if (Math.abs(direction.l) < 1e-9 && Math.abs(direction.f) < 1e-9 && Math.hypot(origin.l, origin.f) > reach) return -1;
    const top = (sections[sections.length - 1] as Section).up + topCap;
    const bottom = (sections[0] as Section).up - bottomCap;
    const t0 = Math.max(0, (direction.up < 0 ? top - origin.up : bottom - origin.up) / direction.up);
    const t1 = (direction.up < 0 ? bottom - origin.up : top - origin.up) / direction.up;
    for (let t = t0; t <= t1; t += loftStep) {
      const p = add(origin, scale(direction, t));
      const section = loftSection(sections, bottomCap, topCap, p.up);
      if (section && (p.l / section.w) ** 2 + (p.f / section.d) ** 2 <= 1) return t;
    }
    return -1;
  }
  if (primitive.kind === 'ellipsoid') {
    const { center, radii } = primitive;
    const o = { l: (origin.l - center.l) / radii.l, up: (origin.up - center.up) / radii.up, f: (origin.f - center.f) / radii.f };
    const d = { l: direction.l / radii.l, up: direction.up / radii.up, f: direction.f / radii.f };
    const qa = dot(d, d);
    const qb = dot(o, d);
    const qc = dot(o, o) - 1;
    const h = qb * qb - qa * qc;
    if (h < 0) return -1;
    const t = (-qb - Math.sqrt(h)) / qa;
    return t > 0 ? t : -1;
  }
  // Capsule: a cylinder between a and b with two end spheres (closed form, after the well-known ray-capsule derivation by I. Quilez).
  const { a, b, r } = primitive;
  const ba = sub(b, a);
  const oa = sub(origin, a);
  const baba = dot(ba, ba);
  const bard = dot(ba, direction);
  const baoa = dot(ba, oa);
  const rdoa = dot(direction, oa);
  const oaoa = dot(oa, oa);
  const qa = baba - bard * bard;
  const qb = baba * rdoa - baoa * bard;
  const qc = baba * oaoa - baoa * baoa - r * r * baba;
  let h = qb * qb - qa * qc;
  if (h < 0) return -1;
  if (qa > 1e-12) {
    const t = (-qb - Math.sqrt(h)) / qa;
    const y = baoa + t * bard;
    if (y > 0 && y < baba) return t > 0 ? t : -1;
  }
  let best = -1;
  for (const end of [a, b]) {
    const oc = sub(origin, end);
    const sb = dot(direction, oc);
    const sc = dot(oc, oc) - r * r;
    h = sb * sb - sc;
    if (h < 0) continue;
    const t = -sb - Math.sqrt(h);
    if (t > 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

/** The camera of the C0.5 reference body for a contract: origin, head unit, and yaw. */
export type DepthCamera = { readonly origin: Joint; readonly unitPx: number; readonly yawDegrees: number };

/** The camera from the contract: the rig origin, the body height from `head_top` to the origin, and the reference yaw. */
export function cameraOf(contract: ControlContract): DepthCamera {
  const top = contract.points.get('head_top');
  if (!top) return fail('E_DEPTH_CONTRACT', 'The contract has no head_top point. The depth image needs the C0.5 candidate contract.');
  const height = contract.rigOrigin.y - top.position.y;
  if (!(height > 0)) fail('E_DEPTH_CONTRACT', 'head_top is not above the rig origin.');
  return { origin: contract.rigOrigin, unitPx: height / referenceBody.heads, yawDegrees: referenceBody.yawDegrees };
}

/** Body frame to camera frame: x to the image right, y up, z toward the camera. In head units. */
export function toCamera(point: Vec, yawDegrees: number): { x: number; y: number; z: number } {
  const yaw = (yawDegrees * Math.PI) / 180;
  return { x: point.l * Math.cos(yaw) + point.f * Math.sin(yaw), y: point.up, z: -point.l * Math.sin(yaw) + point.f * Math.cos(yaw) };
}

function fromCamera(x: number, y: number, z: number, yawDegrees: number): Vec {
  const yaw = (yawDegrees * Math.PI) / 180;
  return { l: x * Math.cos(yaw) - z * Math.sin(yaw), up: y, f: x * Math.sin(yaw) + z * Math.cos(yaw) };
}

type Box = { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number };

function cameraBox(primitive: Primitive, yaw: number): Box {
  if (primitive.kind === 'loft') {
    const reach = Math.max(...primitive.sections.map((section) => Math.max(section.w, section.d)));
    const first = primitive.sections[0] as Section;
    const last = primitive.sections[primitive.sections.length - 1] as Section;
    return { x0: -reach, x1: reach, y0: first.up - primitive.bottomCap, y1: last.up + primitive.topCap };
  }
  const points = primitive.kind === 'ellipsoid' ? [primitive.center] : [primitive.a, primitive.b];
  const pad = primitive.kind === 'ellipsoid' ? Math.max(primitive.radii.l, primitive.radii.up, primitive.radii.f) : primitive.r;
  const cams = points.map((point) => toCamera(point, yaw));
  return {
    x0: Math.min(...cams.map((c) => c.x)) - pad,
    x1: Math.max(...cams.map((c) => c.x)) + pad,
    y0: Math.min(...cams.map((c) => c.y)) - pad,
    y1: Math.max(...cams.map((c) => c.y)) + pad
  };
}

export type Hit = { readonly z: number; readonly part: DepthPart; readonly id: string } | null;

const far = 20;

/** The nearest body surface on the camera ray through camera point (x, y). Surfaces below the ground are cut. */
export function castFront(primitives: readonly Primitive[], boxes: readonly Box[], x: number, y: number, yaw: number): Hit {
  const origin = fromCamera(x, y, far, yaw);
  const direction = fromCamera(0, 0, -1, yaw);
  let best: Hit = null;
  let bestT = Infinity;
  for (const [index, primitive] of primitives.entries()) {
    const box = boxes[index] as Box;
    if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) continue;
    const t = intersect(primitive, origin, direction);
    if (t < 0 || t >= bestT) continue;
    const point = add(origin, scale(direction, t));
    if (point.up < 0) continue;
    bestT = t;
    best = { z: far - t, part: primitive.part, id: primitive.id };
  }
  return best;
}

export type DepthRender = {
  readonly size: Size;
  /** Camera depth (head units, larger is nearer) of each sample, NaN for the background. 2 x 2 samples per pixel, row by row. */
  readonly samples: Float64Array;
  readonly parts: readonly (DepthPart | null)[];
  readonly zNear: number;
  readonly zFar: number;
};

/** Casts 2 x 2 rays for each target pixel. The target pixels map to the contract canvas with the overlay transform. */
export function renderDepthSamples(contract: ControlContract, size: Size, transform: Transform): DepthRender {
  const camera = cameraOf(contract);
  const primitives = depthPrimitives();
  const boxes = primitives.map((primitive) => cameraBox(primitive, camera.yawDegrees));
  const n = size.width * size.height * 4;
  const samples = new Float64Array(n).fill(Number.NaN);
  const parts: (DepthPart | null)[] = new Array<DepthPart | null>(n).fill(null);
  let zNear = -Infinity;
  let zFar = Infinity;
  for (let py = 0; py < size.height; py += 1) {
    for (let px = 0; px < size.width; px += 1) {
      for (let s = 0; s < 4; s += 1) {
        const point = toContract({ x: px + 0.25 + 0.5 * (s % 2), y: py + 0.25 + 0.5 * Math.floor(s / 2) }, transform);
        const hit = castFront(primitives, boxes, (point.x - camera.origin.x) / camera.unitPx, (camera.origin.y - point.y) / camera.unitPx, camera.yawDegrees);
        if (!hit) continue;
        const index = (py * size.width + px) * 4 + s;
        samples[index] = hit.z;
        parts[index] = hit.part;
        if (hit.z > zNear) zNear = hit.z;
        if (hit.z < zFar) zFar = hit.z;
      }
    }
  }
  if (!Number.isFinite(zNear)) fail('E_DEPTH_EMPTY', 'No body surface is inside the image. Check the contract and the size.');
  return { size, samples, parts, zNear, zFar };
}

/** The depth control image: gray RGB, near bright, far dark, background black, each pixel the mean of its 4 samples. */
export function depthImage(render: DepthRender): Raster {
  const { near, far: farValue, background } = depthAssumptions.encoding;
  const span = render.zNear - render.zFar || 1;
  const raster = new Raster(render.size.width, render.size.height, [background, background, background, 255]);
  for (let i = 0; i < render.size.width * render.size.height; i += 1) {
    let sum = 0;
    for (let s = 0; s < 4; s += 1) {
      const z = render.samples[i * 4 + s] as number;
      sum += Number.isNaN(z) ? background : farValue + ((near - farValue) * (z - render.zFar)) / span;
    }
    const value = Math.round(sum / 4);
    raster.data.set([value, value, value, 255], i * 4);
  }
  return raster;
}

export const partColors: Readonly<Record<DepthPart, readonly [number, number, number]>> = {
  head: [200, 200, 200],
  neck: [170, 170, 170],
  torso: [150, 150, 150],
  arm_near: [40, 110, 230],
  leg_near: [40, 110, 230],
  arm_far: [235, 130, 30],
  leg_far: [235, 130, 30]
};

/** A shaded view of the volumes: near side blue, far side orange, center parts gray, darker when farther. For human review only. */
export function partImage(render: DepthRender): Raster {
  const span = render.zNear - render.zFar || 1;
  const raster = new Raster(render.size.width, render.size.height, [255, 255, 255, 255]);
  for (let i = 0; i < render.size.width * render.size.height; i += 1) {
    const s = i * 4;
    const part = render.parts[s];
    const z = render.samples[s] as number;
    if (!part || Number.isNaN(z)) continue;
    const shade = 0.45 + (0.55 * (z - render.zFar)) / span;
    const rgb = partColors[part];
    raster.data.set([Math.round(rgb[0] * shade), Math.round(rgb[1] * shade), Math.round(rgb[2] * shade), 255], s);
  }
  return raster;
}

/** A top view of the volumes (looking down), camera at the bottom of the image, with the facing direction. For human review only. */
export function topView(size: Size, yawDegrees: number): Raster {
  const primitives = depthPrimitives();
  const raster = new Raster(size.width, size.height, [255, 255, 255, 255]);
  const unit = Math.min(size.width, size.height) / 4;
  const cx = size.width / 2;
  const cy = size.height / 2;
  const down = { l: 0, up: -1, f: 0 };
  for (let py = 0; py < size.height; py += 1) {
    for (let px = 0; px < size.width; px += 1) {
      const x = (px + 0.5 - cx) / unit;
      const z = (py + 0.5 - cy) / unit;
      const origin = { ...fromCamera(x, 0, z, yawDegrees), up: far };
      let bestT = Infinity;
      let part: DepthPart | null = null;
      for (const primitive of primitives) {
        const t = intersect(primitive, origin, down);
        if (t >= 0 && t < bestT) {
          bestT = t;
          part = primitive.part;
        }
      }
      if (!part) continue;
      const height = far - bestT;
      const shade = 0.4 + 0.6 * Math.min(1, Math.max(0, height / referenceBody.heads));
      const rgb = partColors[part];
      raster.data.set([Math.round(rgb[0] * shade), Math.round(rgb[1] * shade), Math.round(rgb[2] * shade), 255], (py * size.width + px) * 4);
    }
  }
  // Facing direction from the body center, and the camera direction (the view goes from the bottom of the image to the top).
  const yaw = (yawDegrees * Math.PI) / 180;
  const arrow: Color = [200, 0, 0, 255];
  raster.line({ x: cx, y: cy }, { x: cx + Math.sin(yaw) * unit * 1.6, y: cy + Math.cos(yaw) * unit * 1.6 }, Math.max(2, unit / 40), arrow);
  raster.line({ x: cx, y: size.height - unit * 0.15 }, { x: cx, y: size.height - unit * 0.6 }, Math.max(2, unit / 40), [0, 0, 0, 255]);
  return raster;
}

export type DepthCheck = { readonly id: string; readonly status: 'PASS' | 'FAIL'; readonly detail: string };

const projectPx = (point: Vec, camera: DepthCamera): Joint => {
  const c = toCamera(point, camera.yawDegrees);
  return { x: camera.origin.x + c.x * camera.unitPx, y: camera.origin.y - c.y * camera.unitPx };
};

/**
 * Checks that the volumes agree with the contract and with the intended view:
 * D1 joints and D2 face points project onto the contract (C0.5 is not changed), D3 the face and D4 the feet turn to the image right and to the camera,
 * D5 the near limbs are nearer than the far limbs, D6 the near limbs cover more pixels than the far limbs, D7 every part is visible.
 */
export function depthChecks(contract: ControlContract, render: DepthRender): DepthCheck[] {
  const camera = cameraOf(contract);
  const l = referenceBody.landmarks;
  const checks: DepthCheck[] = [];
  const pairs: [string, Vec][] = [
    ['hips', vec(l.hips)],
    ['spine', vec(l.spine)],
    ['chest', vec(l.chest)],
    ['neck', vec(l.neck)],
    ['head', vec(l.head)]
  ];
  for (const side of ['near', 'far'] as const) {
    const at = (landmark: Landmark): Vec => (side === 'near' ? vec(landmark) : mirrored(landmark));
    for (const [bone, landmark] of [
      ['upper_arm', l.upper_arm],
      ['forearm', l.forearm],
      ['hand', l.hand],
      ['thigh', l.thigh],
      ['shin', l.shin],
      ['foot', l.foot]
    ] as const)
      pairs.push([`${bone}_${side}`, at(landmark)]);
  }
  let worst = 0;
  let worstId = '';
  for (const [id, landmark] of pairs) {
    const joint = contract.bones.get(id)?.joint;
    if (!joint) return fail('E_DEPTH_CONTRACT', `The contract has no bone ${id}.`);
    const d = Math.hypot(projectPx(landmark, camera).x - joint.x, projectPx(landmark, camera).y - joint.y);
    if (d > worst) {
      worst = d;
      worstId = id;
    }
  }
  checks.push({ id: 'D1', status: worst <= 1 ? 'PASS' : 'FAIL', detail: `Largest joint difference to the contract: ${round(worst)} contract px (${worstId}). Limit 1 px (rounding).` });
  let worstFace = 0;
  for (const [id, landmark] of [
    ['head_top', vec(l.head_top)],
    ['face_nose', vec(l.face_nose)],
    ['face_eye_near', vec(l.face_eye)],
    ['face_eye_far', mirrored(l.face_eye)],
    ['face_ear_near', vec(l.face_ear)]
  ] as const) {
    const point = contract.points.get(id)?.position;
    if (!point) return fail('E_DEPTH_CONTRACT', `The contract has no point ${id}.`);
    worstFace = Math.max(worstFace, Math.hypot(projectPx(landmark, camera).x - point.x, projectPx(landmark, camera).y - point.y));
  }
  checks.push({ id: 'D2', status: worstFace <= 1 ? 'PASS' : 'FAIL', detail: `Largest face point difference to the contract: ${round(worstFace)} contract px. Limit 1 px.` });
  const nose = toCamera(vec(l.face_nose), camera.yawDegrees);
  const head = toCamera({ l: 0, up: depthAssumptions.head.centerUp, f: l.head.forward }, camera.yawDegrees);
  checks.push({
    id: 'D3',
    status: nose.x > head.x && nose.z > head.z ? 'PASS' : 'FAIL',
    detail: `Nose relative to the head center: ${round(nose.x - head.x)} head units to the image right, ${round(nose.z - head.z)} toward the camera.`
  });
  const feet = (['near', 'far'] as const).map((side) => {
    const ankle = toCamera(side === 'near' ? vec(l.foot) : mirrored(l.foot), camera.yawDegrees);
    const toe = toCamera(side === 'near' ? vec(l.toe) : mirrored(l.toe), camera.yawDegrees);
    return { side, dx: toe.x - ankle.x, dz: toe.z - ankle.z };
  });
  checks.push({
    id: 'D4',
    status: feet.every((foot) => foot.dx > 0 && foot.dz > 0) ? 'PASS' : 'FAIL',
    detail: feet.map((foot) => `${foot.side} toe: ${round(foot.dx)} to the image right, ${round(foot.dz)} toward the camera`).join('; ')
  });
  const meanZ = (side: 'near' | 'far'): number => {
    const values = [l.upper_arm, l.forearm, l.hand, l.thigh, l.shin, l.foot].map((landmark) => toCamera(side === 'near' ? vec(landmark) : mirrored(landmark), camera.yawDegrees).z);
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };
  checks.push({
    id: 'D5',
    status: meanZ('near') > meanZ('far') ? 'PASS' : 'FAIL',
    detail: `Mean camera depth of the limb joints: near ${round(meanZ('near'))}, far ${round(meanZ('far'))} head units (larger is nearer).`
  });
  const count = new Map<DepthPart, number>();
  for (const part of render.parts) if (part) count.set(part, (count.get(part) ?? 0) + 1);
  const c = (part: DepthPart): number => count.get(part) ?? 0;
  checks.push({
    id: 'D6',
    status: c('arm_near') > c('arm_far') && c('leg_near') > c('leg_far') ? 'PASS' : 'FAIL',
    detail: `Visible samples: arm near ${c('arm_near')}, arm far ${c('arm_far')}, leg near ${c('leg_near')}, leg far ${c('leg_far')}.`
  });
  const parts: DepthPart[] = ['head', 'neck', 'torso', 'arm_near', 'arm_far', 'leg_near', 'leg_far'];
  const hidden = parts.filter((part) => c(part) === 0);
  checks.push({ id: 'D7', status: hidden.length === 0 ? 'PASS' : 'FAIL', detail: hidden.length === 0 ? 'All parts have visible samples.' : `Not visible: ${hidden.join(', ')}.` });
  return checks;
}
