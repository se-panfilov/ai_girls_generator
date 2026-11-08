import { contractReport, json, parseContractBytes, parseSize, record, sheetOf, toolName } from '@control/commands';
import type { ControlContract, Joint, Rect, Size } from '@control/contract';
import { type Box, cameraBox, cameraOf, depthAssumptions, depthPrimitives, fromCamera, intersect, loftSection, type Primitive, toCamera, topView } from '@control/depth';
import { drawText, textWidth } from '@control/glyphs';
import { bodyProjection, candidateFacePoints, candidateJoints, referenceBody } from '@control/mannequin';
import type { PlannedFile } from '@control/output';
import { encodePng, sha256 } from '@control/png';
import { fitTransform, round, toContract, toTarget, type Transform } from '@control/pose';
import { fail, isRecord } from '@control/problems';
import { type Color, type Point, Raster } from '@control/raster';

// T1a: a static template of the C0.5 prototype geometry (see docs/proposals/T0_TEMPLATE_FIRST_ARCHITECTURE.md, section 16).
//
// Geometry source: the simple volumes of the C0.5 reference body in depth.ts (`depthPrimitives`). They are the same volumes as the depth image.
// Each pixel sends one ray through its center. A slot "owns" a pixel when its volume is hit and no hit slot has a higher draw order.
// This is how Spine composites the setup pose: draw order decides, not 3D depth. Where the two disagree, the manifest lists the pixels.
//
// **Prototype only.** C0.5 is not an approved production rig. The outputs are geometry priors for later layer work. They do not prove that
// the parts animate correctly, that hidden areas are complete, or that a generated image can be cut with these masks.

export const templateFormat = 'aigg.t1a-template/0.1';
const mockCharacterId = 't1a_mock';

/** Slots that the reference body has no volume for. A required one gets a placeholder frame in the mock package, never invented geometry. */
export const notModeledSlots: readonly string[] = ['hair_back', 'hair_front', 'hair_tail', 'tail', 'ear_near', 'ear_far', 'skirt_front', 'skirt_back', 'acc_head', 'weapon', 'hand_near_front'];

/** Height (head units) where the torso volume changes from the `hips` slot to the `torso` slot: the `spine` joint, the child joint of the hips bone. */
const torsoSplitUp = referenceBody.landmarks.spine.up;

/**
 * Height (head units) below which a hit on the neck volume belongs to the `torso` slot: the `neck` joint, the pivot of the neck bone.
 * The neck volume starts inside the torso (depthAssumptions.neck). The depth image hides that part, because the nearest surface wins.
 * Here the draw order decides (neck over torso), so without this split the hidden part shows as a neck tube on the chest.
 */
const neckSplitUp = referenceBody.landmarks.neck.up;

/**
 * The slot of a volume hit. The torso volume belongs to two slots, split at the spine joint height. The neck volume below the neck joint
 * belongs to the torso. The nose belongs to the head.
 */
export function slotOfVolume(primitiveId: string, up: number): string {
  if (primitiveId === 'torso') return up >= torsoSplitUp ? 'torso' : 'hips';
  if (primitiveId === 'neck') return up >= neckSplitUp ? 'neck' : 'torso';
  if (primitiveId === 'nose') return 'head';
  return primitiveId;
}

/** Slot ids that the volumes fill, in a fixed order. A volume is named by the slot of its top part. */
export function modeledSlots(): string[] {
  const ids = new Set<string>(['torso', 'hips']);
  for (const primitive of depthPrimitives()) ids.add(slotOfVolume(primitive.id, Infinity));
  return [...ids];
}

type Overlap = { readonly childBone: string; readonly radiusPx: number };
type SlotInfo = {
  readonly id: string;
  readonly bone: string;
  readonly drawOrder: number;
  readonly required: boolean;
  readonly rect: Rect;
  readonly overlaps: readonly Overlap[];
  readonly modeled: boolean;
  readonly color: Color;
};

/** Reads the slot fields that the control contract parser does not keep: `required` and `overlap`. Checks the slot list against the volumes. */
function slotInfo(raw: Record<string, unknown>, contract: ControlContract): SlotInfo[] {
  const modeled = new Set(modeledSlots());
  const known = new Set([...modeled, ...notModeledSlots]);
  const rawSlots = Array.isArray(raw.slots) ? (raw.slots as unknown[]) : [];
  const unknown = [...contract.slots.keys()].filter((id) => !known.has(id));
  if (unknown.length > 0) fail('E_TEMPLATE_SLOT_UNKNOWN', `The contract has slots that the template does not know: ${unknown.join(', ')}.`);
  const missing = [...modeled].filter((id) => !contract.slots.has(id));
  if (missing.length > 0) fail('E_TEMPLATE_SLOT_MISSING', `The contract has no slot for these reference volumes: ${missing.join(', ')}.`);
  const sorted = [...contract.slots.values()].sort((a, b) => a.drawOrder - b.drawOrder);
  return sorted.map((slot, index) => {
    const item = rawSlots.find((entry) => isRecord(entry) && entry.id === slot.id);
    if (!isRecord(item) || typeof item.required !== 'boolean') return fail('E_CONTRACT_FORMAT', `Slot ${slot.id} needs required true or false.`, slot.id);
    const overlaps: Overlap[] = [];
    if (item.overlap !== undefined) {
      if (!Array.isArray(item.overlap)) return fail('E_CONTRACT_FORMAT', `overlap of slot ${slot.id} must be an array.`, slot.id);
      for (const entry of item.overlap as unknown[]) {
        if (!isRecord(entry) || typeof entry.childBone !== 'string' || !contract.bones.has(entry.childBone) || typeof entry.radiusPx !== 'number' || !(entry.radiusPx > 0 && entry.radiusPx <= 512)) {
          return fail('E_CONTRACT_FORMAT', `overlap of slot ${slot.id} needs an existing childBone and a radiusPx from 0 to 512.`, slot.id);
        }
        overlaps.push({ childBone: entry.childBone, radiusPx: entry.radiusPx });
      }
    }
    return { id: slot.id, bone: slot.bone, drawOrder: slot.drawOrder, required: item.required, rect: slot.attachmentRect, overlaps, modeled: modeled.has(slot.id), color: regionColor(index) };
  });
}

/** A distinct, deterministic color for each slot (golden-angle hues). Never black (the background) and never white. */
export function regionColor(index: number): Color {
  const hue = (index * 137.508) % 360;
  const saturation = index % 2 === 0 ? 0.7 : 0.55;
  const value = index % 3 === 0 ? 0.95 : index % 3 === 1 ? 0.8 : 0.65;
  const c = value * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = value - c;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255), 255];
}

/** Ownership of each pixel: the slot that Spine draws on top, the slot of the nearest surface, and the camera depth of both. -1 is background. */
export type Ownership = {
  readonly size: Size;
  readonly transform: Transform;
  readonly owner: Int16Array;
  readonly ownerZ: Float32Array;
  readonly nearest: Int16Array;
};

/** Casts one ray through the center of each pixel. `slots` is sorted by draw order, so a larger index draws on top. */
export function castOwnership(contract: ControlContract, slots: readonly SlotInfo[], size: Size, transform: Transform): Ownership {
  const camera = cameraOf(contract);
  const primitives: Primitive[] = depthPrimitives();
  const boxes: Box[] = primitives.map((primitive) => cameraBox(primitive, camera.yawDegrees));
  const index = new Map(slots.map((slot, i) => [slot.id, i]));
  const direction = fromCamera(0, 0, -1, camera.yawDegrees);
  const far = 20;
  const count = size.width * size.height;
  const owner = new Int16Array(count).fill(-1);
  const nearest = new Int16Array(count).fill(-1);
  const ownerZ = new Float32Array(count).fill(Number.NaN);
  for (let py = 0; py < size.height; py += 1) {
    for (let px = 0; px < size.width; px += 1) {
      const point = toContract({ x: px + 0.5, y: py + 0.5 }, transform);
      const x = (point.x - camera.origin.x) / camera.unitPx;
      const y = (camera.origin.y - point.y) / camera.unitPx;
      const origin = fromCamera(x, y, far, camera.yawDegrees);
      let top = -1;
      let topZ = Number.NaN;
      let near = -1;
      let nearT = Infinity;
      for (const [i, primitive] of primitives.entries()) {
        const box = boxes[i] as Box;
        if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) continue;
        const t = intersect(primitive, origin, direction);
        if (t < 0) continue;
        const up = origin.up + direction.up * t;
        if (up < 0) continue;
        const slot = index.get(slotOfVolume(primitive.id, up));
        if (slot === undefined) continue;
        if (slot > top || (slot === top && far - t > topZ)) {
          top = slot;
          topZ = far - t;
        }
        if (t < nearT) {
          nearT = t;
          near = slot;
        }
      }
      const p = py * size.width + px;
      owner[p] = top;
      ownerZ[p] = topZ;
      nearest[p] = near;
    }
  }
  return { size, transform, owner, ownerZ, nearest };
}

/** Checks that the contract joints and face points are the projection of the reference body (1 px rounding), so masks and rig marks agree. */
function geometryMismatch(contract: ControlContract): { worst: number; id: string } {
  const camera = cameraOf(contract);
  const projection = bodyProjection(camera.origin, camera.unitPx * referenceBody.heads, camera.yawDegrees);
  const aim = contract.bones.get('aim')?.joint ?? { x: 0, y: 0 };
  let worst = 0;
  let id = '';
  for (const [bone, joint] of candidateJoints(projection, aim)) {
    const actual = contract.bones.get(bone)?.joint;
    if (!actual) fail('E_TEMPLATE_BONE_MISSING', `The contract has no bone ${bone}.`);
    const d = Math.hypot(actual.x - joint.x, actual.y - joint.y);
    if (d > worst) [worst, id] = [d, bone];
  }
  for (const face of candidateFacePoints(projection)) {
    const actual = contract.points.get(face.id)?.position;
    if (!actual) fail('E_TEMPLATE_POINT_MISSING', `The contract has no point ${face.id}.`);
    const d = Math.hypot(actual.x - face.position.x, actual.y - face.position.y);
    if (d > worst) [worst, id] = [d, face.id];
  }
  return { worst, id };
}

const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : isRecord(value)
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(',')}}`
      : JSON.stringify(value);

const inside = (rect: Rect, x: number, y: number): boolean => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
const toImageRect = (rect: Rect, t: Transform): { x: number; y: number; w: number; h: number } => ({
  x: round(rect.x * t.scale + t.offsetX),
  y: round(rect.y * t.scale + t.offsetY),
  w: round(rect.w * t.scale),
  h: round(rect.h * t.scale)
});
const lighten = (color: Color, amount: number): Color => [
  Math.round(color[0] + (255 - color[0]) * amount),
  Math.round(color[1] + (255 - color[1]) * amount),
  Math.round(color[2] + (255 - color[2]) * amount),
  255
];
const sideColor = (id: string): Color => (id.endsWith('_near') ? [30, 90, 210, 255] : id.endsWith('_far') ? [215, 110, 20, 255] : [110, 110, 120, 255]);

export type TemplateCheck = { readonly id: string; readonly status: 'PASS' | 'FAIL'; readonly detail: string };

/** Line art types. Larger is drawn on top. */
const lineStyle = {
  seam: { radius: 0.9, color: [150, 150, 150, 255] as Color },
  occlusion: { radius: 1.3, color: [40, 40, 40, 255] as Color },
  silhouette: { radius: 1.7, color: [0, 0, 0, 255] as Color }
};
/** Camera depth difference (head units) above which a border between two slots is an occlusion contour, not a seam. */
const occlusionDepth = 0.12;

/**
 * Contour line art: the outer silhouette and occlusion edges in black, seams between touching parts in mid gray,
 * and light gray form lines (front midlines, eye and nose dots) that show the three-quarter turn. White background.
 */
export function contourLineArt(contract: ControlContract, own: Ownership, slots: readonly SlotInfo[]): Raster {
  const { width, height } = own.size;
  const kind = new Uint8Array(width * height);
  const mark = (p: number, value: number): void => {
    if ((kind[p] ?? 0) < value) kind[p] = value;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      const a = own.owner[p] ?? -1;
      for (const [dx, dy] of [
        [1, 0],
        [0, 1]
      ] as const) {
        if (x + dx >= width || y + dy >= height) continue;
        const q = (y + dy) * width + x + dx;
        const b = own.owner[q] ?? -1;
        if (a === b) continue;
        const value = a < 0 || b < 0 ? 3 : Math.abs((own.ownerZ[p] ?? 0) - (own.ownerZ[q] ?? 0)) > occlusionDepth ? 2 : 1;
        mark(a < 0 ? q : p, value);
      }
    }
  }
  const raster = new Raster(width, height, [255, 255, 255, 255]);
  drawFormCurves(raster, contract, own, slots, 1.6, [185, 185, 185, 255]);
  for (const value of [1, 2, 3]) {
    const style = value === 1 ? lineStyle.seam : value === 2 ? lineStyle.occlusion : lineStyle.silhouette;
    for (let p = 0; p < width * height; p += 1) if (kind[p] === value) raster.fillCircle({ x: (p % width) + 0.5, y: Math.floor(p / width) + 0.5 }, style.radius, style.color);
  }
  return raster;
}

/** Region map: each visible pixel has the flat color of its slot. Background black. */
export function regionMap(own: Ownership, slots: readonly SlotInfo[]): Raster {
  const raster = new Raster(own.size.width, own.size.height, [0, 0, 0, 255]);
  for (let p = 0; p < own.owner.length; p += 1) {
    const slot = own.owner[p] ?? -1;
    if (slot >= 0) raster.data.set((slots[slot] as SlotInfo).color, p * 4);
  }
  return raster;
}

/** Binary mask of one slot: white where the slot is visible in the setup pose, black elsewhere. Opaque. */
export function visibleMask(own: Ownership, slot: number): Raster {
  const raster = new Raster(own.size.width, own.size.height, [0, 0, 0, 255]);
  for (let p = 0; p < own.owner.length; p += 1) if (own.owner[p] === slot) raster.data.set([255, 255, 255, 255], p * 4);
  return raster;
}

/** A form line on the surface of one slot volume, in camera coordinates (head units). */
export type FormCurve = { readonly id: string; readonly slots: readonly string[]; readonly points: readonly Point[] };

/**
 * Form lines that show the body turn: the front midline of the torso and of the head (l = 0 on the front surface).
 * They come from the same volumes as the masks. They are construction lines, not part borders.
 * Horizontal cross-section rings are not drawn: with a level orthographic camera they project to straight lines and show no turn.
 */
export function formCurves(): FormCurve[] {
  const yaw = referenceBody.yawDegrees;
  const { sections, bottomCap, topCap } = depthAssumptions.torso;
  const torso: Point[] = [];
  for (let up = sections[0].up; up <= sections[5].up + 1e-9; up += 0.02) {
    const section = loftSection(sections, bottomCap, topCap, up);
    if (!section) continue;
    const c = toCamera({ l: 0, up, f: section.d }, yaw);
    torso.push({ x: c.x, y: c.y });
  }
  const head = depthAssumptions.head;
  const radii = referenceBody.radii.head;
  const forward = referenceBody.landmarks.head.forward;
  const headLine: Point[] = [];
  for (let up = head.centerUp - radii.h * 0.8; up <= head.centerUp + radii.h * 0.8 + 1e-9; up += 0.01) {
    const k = Math.sqrt(1 - ((up - head.centerUp) / radii.h) ** 2);
    const c = toCamera({ l: 0, up, f: forward + radii.d * k }, yaw);
    headLine.push({ x: c.x, y: c.y });
  }
  return [
    { id: 'torso_midline', slots: ['torso', 'hips'], points: torso },
    { id: 'head_midline', slots: ['head'], points: headLine }
  ];
}

/** Draws the form lines where one of their slots is visible, so a near arm in front hides them. */
function drawFormCurves(raster: Raster, contract: ControlContract, own: Ownership, slots: readonly SlotInfo[], width: number, color: Color): void {
  const camera = cameraOf(contract);
  const index = new Map(slots.map((slot, i) => [slot.id, i]));
  const toImage = (point: Point): Point => toTarget({ x: camera.origin.x + point.x * camera.unitPx, y: camera.origin.y - point.y * camera.unitPx }, own.transform);
  for (const curve of formCurves()) {
    const allowed = new Set(curve.slots.map((id) => index.get(id)));
    const points = curve.points.map(toImage);
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1] as Point;
      const b = points[i] as Point;
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
      for (let k = 0; k <= steps; k += 1) {
        const x = a.x + ((b.x - a.x) * k) / steps;
        const y = a.y + ((b.y - a.y) * k) / steps;
        const px = Math.floor(x);
        const py = Math.floor(y);
        if (px < 0 || py < 0 || px >= own.size.width || py >= own.size.height || !allowed.has(own.owner[py * own.size.width + px])) continue;
        raster.fillCircle({ x, y }, width / 2, color);
      }
    }
  }
  // Face marks: both eyes and the nose (contract points), as small dots. The near eye is farther from the head midline than the far eye.
  const radius = Math.max(1.5, referenceBody.radii.head.w * 0.12 * camera.unitPx * own.transform.scale);
  for (const id of ['face_eye_near', 'face_eye_far', 'face_nose']) {
    const point = contract.points.get(id)?.position;
    if (point) raster.fillCircle(toTarget(point, own.transform), radius, color);
  }
}

type Marks = {
  readonly headCenter: Joint;
  readonly nose: Joint;
  readonly feet: readonly { readonly side: 'near' | 'far'; readonly ankle: Joint; readonly toe: Joint }[];
};

function marksOf(contract: ControlContract): Marks {
  const camera = cameraOf(contract);
  const projection = bodyProjection(camera.origin, camera.unitPx * referenceBody.heads, camera.yawDegrees);
  const head = contract.bones.get('head')?.joint as Joint;
  const top = contract.points.get('head_top')?.position as Joint;
  const nose = contract.points.get('face_nose')?.position as Joint;
  const feet = (['near', 'far'] as const).map((side) => {
    const toe = referenceBody.landmarks.toe;
    const point = projection.project(side === 'near' ? toe : { ...toe, left: -toe.left });
    return { side, ankle: contract.bones.get(`foot_${side}`)?.joint as Joint, toe: { x: round(point.x), y: round(point.y) } };
  });
  return { headCenter: { x: (head.x + top.x) / 2, y: (head.y + top.y) / 2 }, nose, feet };
}

function arrow(raster: Raster, from: Point, to: Point, width: number, color: Color): void {
  raster.line(from, to, width, color);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = width * 4;
  raster.fillPolygon(
    [to, { x: to.x - size * Math.cos(angle - 0.45), y: to.y - size * Math.sin(angle - 0.45) }, { x: to.x - size * Math.cos(angle + 0.45), y: to.y - size * Math.sin(angle + 0.45) }],
    color
  );
}

function centroid(own: Ownership, slot: number): Point | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let p = 0; p < own.owner.length; p += 1) {
    if (own.owner[p] !== slot) continue;
    sx += p % own.size.width;
    sy += Math.floor(p / own.size.width);
    n += 1;
  }
  return n === 0 ? null : { x: sx / n + 0.5, y: sy / n + 0.5 };
}

function labelScale(size: Size): number {
  return Math.max(1, Math.round(Math.min(size.width, size.height) / 420));
}

/** Panel 1: region map (lightened), contour, and slot labels at the center of each visible region. */
function regionsPanel(own: Ownership, slots: readonly SlotInfo[], lines: Raster): Raster {
  const panel = new Raster(own.size.width, own.size.height, [255, 255, 255, 255]);
  for (let p = 0; p < own.owner.length; p += 1) {
    const slot = own.owner[p] ?? -1;
    if (slot >= 0) panel.data.set(lighten((slots[slot] as SlotInfo).color, 0.35), p * 4);
  }
  for (let p = 0; p < own.owner.length; p += 1) {
    const value = lines.data[p * 4] ?? 255;
    if (value < 200) panel.data.set([value, value, value, 255], p * 4);
  }
  const s = labelScale(own.size);
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const [index, slot] of slots.entries()) {
    const center = centroid(own, index);
    if (!center) continue;
    const w = textWidth(slot.id, s);
    let x = center.x - w / 2;
    let y = center.y - 3.5 * s;
    while (placed.some((box) => x < box.x1 + 4 * s && x + w + 4 * s > box.x0 && y < box.y1 && y + 9 * s > box.y0)) y += 10 * s;
    x = Math.min(Math.max(x, 2), own.size.width - w - 2);
    placed.push({ x0: x, y0: y, x1: x + w, y1: y + 9 * s });
    drawText(panel, slot.id, x, y, s, [0, 0, 0, 255], [255, 255, 255, 190]);
  }
  drawText(panel, 'regions: slot owner by draw order', 8 * s, 8 * s, s, [0, 0, 0, 255], [255, 255, 255, 220]);
  const missing = slots.filter((slot) => !slot.modeled).map((slot) => slot.id);
  drawText(panel, 'not modeled (no mask):', 8 * s, 20 * s, s, [150, 0, 0, 255], [255, 255, 255, 220]);
  for (let line = 0; line * 3 < missing.length; line += 1) {
    drawText(panel, missing.slice(line * 3, line * 3 + 3).join(' '), 8 * s, (30 + line * 10) * s, s, [150, 0, 0, 255], [255, 255, 255, 220]);
  }
  return panel;
}

/** Panel 2: rig geometry over a light silhouette: rectangles, pivots, joint overlap circles, near/far lines, face and feet directions. */
function rigPanel(contract: ControlContract, own: Ownership, slots: readonly SlotInfo[]): Raster {
  const t = (point: Point): Point => toTarget(point, own.transform);
  const panel = new Raster(own.size.width, own.size.height, [255, 255, 255, 255]);
  for (let p = 0; p < own.owner.length; p += 1) if ((own.owner[p] ?? -1) >= 0) panel.data.set([228, 228, 234, 255], p * 4);
  const s = labelScale(own.size);
  drawFormCurves(panel, contract, own, slots, 2, [110, 160, 110, 255]);
  for (const slot of slots) {
    const a = t({ x: slot.rect.x, y: slot.rect.y });
    const color = sideColor(slot.id);
    panel.strokeRect(a.x, a.y, slot.rect.w * own.transform.scale, slot.rect.h * own.transform.scale, slot.modeled ? 2 : 1, [color[0], color[1], color[2], slot.modeled ? 200 : 110]);
  }
  for (const slot of slots) {
    for (const overlap of slot.overlaps) {
      const center = t(contract.bones.get(overlap.childBone)?.joint as Joint);
      const r = overlap.radiusPx * own.transform.scale;
      for (let step = 0; step < 48; step += 1) {
        const a0 = (step / 48) * Math.PI * 2;
        const a1 = ((step + 1) / 48) * Math.PI * 2;
        panel.line({ x: center.x + Math.cos(a0) * r, y: center.y + Math.sin(a0) * r }, { x: center.x + Math.cos(a1) * r, y: center.y + Math.sin(a1) * r }, 2, [200, 0, 0, 255]);
      }
    }
  }
  for (const bone of contract.bones.values()) {
    const parent = bone.parent ? contract.bones.get(bone.parent) : undefined;
    if (parent && bone.id !== 'aim' && parent.id !== 'root') panel.line(t(parent.joint), t(bone.joint), 2, [60, 60, 60, 200]);
  }
  for (const bone of contract.bones.values()) {
    if (bone.id === 'aim' || bone.id === 'root') continue;
    panel.fillCircle(t(bone.joint), 3 + 2 * s, [255, 255, 255, 255]);
    panel.fillCircle(t(bone.joint), 1 + 2 * s, sideColor(bone.id));
  }
  for (const [near, far, label] of [
    ['upper_arm_near', 'upper_arm_far', 'shoulders'],
    ['thigh_near', 'thigh_far', 'hips']
  ] as const) {
    const a = t(contract.bones.get(near)?.joint as Joint);
    const b = t(contract.bones.get(far)?.joint as Joint);
    panel.line(a, b, 3, [90, 0, 140, 255]);
    drawText(panel, 'near', a.x - textWidth('near', s) - 6 * s, a.y - 3.5 * s, s, [30, 90, 210, 255], [255, 255, 255, 200]);
    drawText(panel, `far (${label})`, b.x + 6 * s, b.y - 3.5 * s, s, [215, 110, 20, 255], [255, 255, 255, 200]);
  }
  const marks = marksOf(contract);
  arrow(panel, t(marks.headCenter), t(marks.nose), 3, [200, 0, 0, 255]);
  drawText(panel, 'face', t(marks.nose).x + 6 * s, t(marks.nose).y - 3.5 * s, s, [200, 0, 0, 255], [255, 255, 255, 200]);
  for (const foot of marks.feet) arrow(panel, t(foot.ankle), t(foot.toe), 3, [200, 0, 0, 255]);
  for (const point of contract.points.values()) {
    if (point.id.startsWith('face_') || point.id === 'head_top') panel.fillCircle(t(point.position), 1 + s, [200, 0, 0, 255]);
  }
  drawText(panel, 'rig: pivots, rects, overlap circles (red)', 8 * s, 8 * s, s, [0, 0, 0, 255], [255, 255, 255, 220]);
  drawText(panel, 'blue near = subject right, orange far', 8 * s, 18 * s, s, [0, 0, 0, 255], [255, 255, 255, 220]);
  drawText(panel, 'green: form lines (front midlines, eyes, nose)', 8 * s, 28 * s, s, [0, 0, 0, 255], [255, 255, 255, 220]);
  return panel;
}

/** Panel 3: top view of the volumes with the camera at the bottom, padded to the panel size. */
function topPanel(size: Size, yawDegrees: number): Raster {
  const side = Math.min(size.width, size.height);
  const panel = new Raster(size.width, size.height, [255, 255, 255, 255]);
  panel.draw(topView({ width: side, height: side }, yawDegrees), Math.floor((size.width - side) / 2), Math.floor((size.height - side) / 2));
  const s = labelScale(size);
  drawText(panel, `top view, yaw ${yawDegrees} deg`, 8 * s, 8 * s, s, [0, 0, 0, 255], [255, 255, 255, 220]);
  drawText(panel, 'red line: facing. black: camera (bottom)', 8 * s, 18 * s, s, [0, 0, 0, 255], [255, 255, 255, 220]);
  drawText(panel, 'blue: near side (subject right)', 8 * s, 28 * s, s, [0, 0, 0, 255], [255, 255, 255, 220]);
  return panel;
}

/** A rectangle-sized part image: the slot color where the slot is visible (contract pixels) or inside one of its joint overlap circles. */
function mockPart(contract: ControlContract, slot: SlotInfo, index: number, own: Ownership): { raster: Raster; visible: number; overlapOnly: number; overlapOutside: number } {
  const { rect } = slot;
  const raster = new Raster(rect.w, rect.h);
  const circles = slot.overlaps.map((overlap) => ({ center: contract.bones.get(overlap.childBone)?.joint as Joint, r: overlap.radiusPx }));
  const inCircle = (x: number, y: number): boolean => circles.some((c) => (x - c.center.x) ** 2 + (y - c.center.y) ** 2 <= c.r * c.r);
  let visible = 0;
  let overlapOnly = 0;
  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      const cx = rect.x + x;
      const cy = rect.y + y;
      const owned = cx >= 0 && cy >= 0 && cx < own.size.width && cy < own.size.height && own.owner[cy * own.size.width + cx] === index;
      const circle = inCircle(cx + 0.5, cy + 0.5);
      if (!owned && !circle) continue;
      raster.data.set(slot.color, (y * rect.w + x) * 4);
      if (owned) visible += 1;
      else overlapOnly += 1;
    }
  }
  let overlapOutside = 0;
  for (const c of circles) {
    for (let y = Math.floor(c.center.y - c.r); y <= Math.ceil(c.center.y + c.r); y += 1) {
      for (let x = Math.floor(c.center.x - c.r); x <= Math.ceil(c.center.x + c.r); x += 1) {
        if ((x + 0.5 - c.center.x) ** 2 + (y + 0.5 - c.center.y) ** 2 <= c.r * c.r && !inside(rect, x, y)) overlapOutside += 1;
      }
    }
  }
  return { raster, visible, overlapOnly, overlapOutside };
}

/** A placeholder for a required slot without a reference volume: a hatched frame of the attachment rectangle. It is not hair or any other shape. */
function placeholderPart(slot: SlotInfo): Raster {
  const { w, h } = slot.rect;
  const raster = new Raster(w, h);
  const border = 3;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const edge = x < border || y < border || x >= w - border || y >= h - border;
      const hatch = (x + y) % 24 < 3;
      if (edge || hatch) raster.data.set(slot.color, (y * w + x) * 4);
    }
  }
  return raster;
}

export type TemplateOptions = { readonly contractBytes: Buffer; readonly size?: string; readonly toolVersion: string };

/** `template`: the T1a static template of the C0.5 prototype geometry and a flat mock package. */
export function templateCommand(options: TemplateOptions): { report: Record<string, unknown>; files: PlannedFile[] } {
  if (!/^\d+\.\d+\.\d+$/.test(options.toolVersion)) fail('E_USAGE', 'The tool version must be X.Y.Z.');
  const contract = parseContractBytes(options.contractBytes);
  if (contract.view !== 'three_quarter_right' || contract.sideNaming !== 'near_far') {
    fail('E_VIEW_UNSUPPORTED', 'The template supports only the view three_quarter_right with near_far side names (the C0.5 prototype).');
  }
  if (!contract.rigId.endsWith('_c05_candidate')) fail('E_CONTRACT_NOT_CANDIDATE', `The contract ${contract.rigId} is not the C0.5 candidate. The template uses the C0.5 reference body.`);
  const raw = JSON.parse(options.contractBytes.toString('utf8')) as Record<string, unknown>;
  const mismatch = geometryMismatch(contract);
  if (mismatch.worst > 1) {
    fail('E_GEOMETRY_MISMATCH', `The contract does not match the reference body: ${mismatch.id} differs by ${round(mismatch.worst)} contract px (limit 1). The masks would not match the rig marks.`);
  }
  const slots = slotInfo(raw, contract);
  const size = parseSize(options.size, contract);
  const transform = fitTransform(contract.canvas, size);
  const own = castOwnership(contract, slots, size, transform);
  const canvasOwn = castOwnership(contract, slots, contract.canvas, { scale: 1, offsetX: 0, offsetY: 0 });

  const lines = contourLineArt(contract, own, slots);
  const regions = regionMap(own, slots);
  const files: { file: PlannedFile; raster: Raster }[] = [];
  const add = (name: string, raster: Raster): void => {
    files.push({ file: { name, bytes: encodePng(raster) }, raster });
  };
  add('contour-lineart.png', lines);
  add('region-map.png', regions);

  const checks: TemplateCheck[] = [];
  const slotReports: Record<string, unknown>[] = [];
  const parts: Record<string, { status: 'present'; file: string } | { status: 'absent_by_design' }> = {};
  const outsideRect: string[] = [];
  const emptyVisible: string[] = [];
  const overlapOutside: string[] = [];
  for (const [index, slot] of slots.entries()) {
    const pivot = contract.bones.get(slot.bone)?.joint as Joint;
    let maskFile: string | null = null;
    let visibleImagePixels = 0;
    let outsideImage = 0;
    let outsideCanvas = 0;
    if (slot.modeled) {
      maskFile = `masks/${slot.id}.visible.png`;
      add(maskFile, visibleMask(own, index));
      for (let p = 0; p < own.owner.length; p += 1) {
        if (own.owner[p] !== index) continue;
        visibleImagePixels += 1;
        const c = toContract({ x: (p % size.width) + 0.5, y: Math.floor(p / size.width) + 0.5 }, transform);
        if (!inside(slot.rect, c.x, c.y)) outsideImage += 1;
      }
      for (let p = 0; p < canvasOwn.owner.length; p += 1) {
        if (canvasOwn.owner[p] === index && !inside(slot.rect, p % contract.canvas.width, Math.floor(p / contract.canvas.width))) outsideCanvas += 1;
      }
      if (outsideImage + outsideCanvas > 0) outsideRect.push(`${slot.id} (${outsideCanvas} contract px)`);
      if (visibleImagePixels === 0) emptyVisible.push(slot.id);
    }
    let mock: Record<string, unknown>;
    if (!slot.required) {
      parts[slot.id] = { status: 'absent_by_design' };
      mock = { status: 'absent_by_design' };
    } else {
      const file = `parts/${slot.id}.png`;
      parts[slot.id] = { status: 'present', file };
      if (slot.modeled) {
        const part = mockPart(contract, slot, index, canvasOwn);
        if (part.overlapOutside > 0) overlapOutside.push(`${slot.id} (${part.overlapOutside} px)`);
        add(`mock-package/${file}`, part.raster);
        mock = { status: 'present', file, content: 'visible_mask_plus_overlap_circles', offset: { x: slot.rect.x, y: slot.rect.y }, visiblePixels: part.visible, overlapOnlyPixels: part.overlapOnly };
      } else {
        add(`mock-package/${file}`, placeholderPart(slot));
        mock = { status: 'present', file, content: 'placeholder_frame', offset: { x: slot.rect.x, y: slot.rect.y } };
      }
    }
    slotReports.push({
      slot: slot.id,
      bone: slot.bone,
      drawOrder: slot.drawOrder,
      required: slot.required,
      geometry: slot.modeled ? 'modeled' : 'not_modeled',
      regionColor: [slot.color[0], slot.color[1], slot.color[2]],
      attachmentRect: slot.rect,
      attachmentRectImage: toImageRect(slot.rect, transform),
      pivot: { contract: pivot, image: (({ x, y }) => ({ x: round(x), y: round(y) }))(toTarget(pivot, transform)) },
      overlaps: slot.overlaps.map((overlap) => ({ ...overlap, center: contract.bones.get(overlap.childBone)?.joint })),
      visibleMask: maskFile,
      visibleImagePixels,
      mockPart: mock
    });
  }
  const joint = (id: string): Joint => contract.bones.get(id)?.joint as Joint;
  const marks = marksOf(contract);
  checks.push({
    id: 'G1',
    status: 'PASS',
    detail: `Contract joints and face points match the reference body projection. Largest difference ${round(mismatch.worst)} contract px (${mismatch.id || 'none'}), limit 1.`
  });
  checks.push({
    id: 'N1',
    status: joint('upper_arm_near').x < joint('upper_arm_far').x && joint('thigh_near').x < joint('thigh_far').x ? 'PASS' : 'FAIL',
    detail: `Near shoulder x ${joint('upper_arm_near').x} < far ${joint('upper_arm_far').x}; near hip x ${joint('thigh_near').x} < far ${joint('thigh_far').x} (near side on the image left).`
  });
  checks.push({
    id: 'N2',
    status: marks.nose.x > marks.headCenter.x ? 'PASS' : 'FAIL',
    detail: `Nose x ${marks.nose.x} > head center x ${round(marks.headCenter.x)} (face to the image right).`
  });
  checks.push({
    id: 'N3',
    status: marks.feet.every((foot) => foot.toe.x > foot.ankle.x) ? 'PASS' : 'FAIL',
    detail: marks.feet.map((foot) => `${foot.side} toe x ${foot.toe.x} > ankle x ${foot.ankle.x}`).join('; ') + ' (feet to the image right).'
  });
  checks.push({
    id: 'M1',
    status: outsideRect.length === 0 ? 'PASS' : 'FAIL',
    detail:
      outsideRect.length === 0
        ? 'Every visible mask is inside the attachment rectangle of its slot.'
        : `Visible pixels outside the attachment rectangle: ${outsideRect.join(', ')}. The masks keep them. The mock parts have the rectangle size, so these pixels are missing there.`
  });
  checks.push({
    id: 'M2',
    status: emptyVisible.length === 0 ? 'PASS' : 'FAIL',
    detail: emptyVisible.length === 0 ? 'Every modeled slot has visible pixels.' : `No visible pixels: ${emptyVisible.join(', ')}.`
  });
  checks.push({
    id: 'M3',
    status: overlapOutside.length === 0 ? 'PASS' : 'FAIL',
    detail:
      overlapOutside.length === 0
        ? 'Every joint overlap circle is inside the attachment rectangle.'
        : `Overlap circle pixels outside the rectangle (cut off in the mock part): ${overlapOutside.join(', ')}.`
  });

  const conflicts = new Map<string, number>();
  for (let p = 0; p < own.owner.length; p += 1) {
    const a = own.owner[p] ?? -1;
    const b = own.nearest[p] ?? -1;
    if (a >= 0 && b >= 0 && a !== b) {
      const key = `${(slots[a] as SlotInfo).id}>${(slots[b] as SlotInfo).id}`;
      conflicts.set(key, (conflicts.get(key) ?? 0) + 1);
    }
  }
  const drawOrderConflicts = [...conflicts.entries()]
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    .map(([key, pixels]) => ({ drawnOnTop: key.split('>')[0], nearerIn3d: key.split('>')[1], imagePixels: pixels }));

  const sheet = sheetOf([[regionsPanel(own, slots, lines), rigPanel(contract, own, slots), topPanel(size, cameraOf(contract).yawDegrees)]], 16);
  add('overlay-sheet.png', sheet);

  const character = {
    characterId: mockCharacterId,
    rigId: contract.rigId,
    parts: Object.fromEntries(slots.map((slot): [string, unknown] => [slot.id, parts[slot.id]]).sort((a, b) => (a[0] < b[0] ? -1 : 1)))
  };
  const characterFile: PlannedFile = { name: 'mock-package/character.json', bytes: json(character) };
  const failed = checks.filter((check) => check.status === 'FAIL');
  const fileRecords = [...files.map(({ file, raster }) => record(file, raster)), record(characterFile)];
  const manifest = {
    format: templateFormat,
    status: 'prototype',
    validation: {
      motionCoverage: 'not_validated',
      spineCompatibility: 'not_validated',
      note: 'A static template of the C0.5 prototype in the setup pose. It is not evidence of animation compatibility, hidden-area coverage, or a correct cut of generated art.'
    },
    tool: { name: toolName, version: options.toolVersion, command: 'template' },
    inputs: {
      contract: { ...contractReport(contract, options.contractBytes), note: 'C0.5 candidate contract, used as a prototype only. Not an approved production rig.' },
      referenceBody: { version: referenceBody.version, heads: referenceBody.heads, yawDegrees: referenceBody.yawDegrees, sha256: sha256(canonical(referenceBody)) },
      volumes: {
        version: depthAssumptions.version,
        sha256: sha256(canonical({ assumptions: depthAssumptions, primitives: depthPrimitives() })),
        source: 'depthPrimitives() of @aigg/control (the C2 depth volumes)'
      },
      spineExport: null
    },
    coordinates: {
      contractSpace: { canvas: contract.canvas, yAxis: 'down', origin: 'top-left', rigOrigin: contract.rigOrigin, unit: 'contract pixel' },
      image: { width: size.width, height: size.height, fit: 'uniform_scale_centered' },
      transform: { scale: round(transform.scale), offsetX: round(transform.offsetX), offsetY: round(transform.offsetY), rule: 'image = contract * scale + offset' },
      sampling: 'One ray through the center of each pixel.',
      mockParts: 'Each mock part image has the size of its attachment rectangle. Its top-left pixel is the top-left corner of the rectangle in contract space (scale 1).'
    },
    view: { id: contract.view, sideNaming: contract.sideNaming, yawDegrees: referenceBody.yawDegrees, faceDirection: 'image_right', nearSideInImage: 'image_left', nearSide: 'subject right' },
    images: {
      colorSpace: 'sRGB (assumed; no ICC or gamma chunk is written)',
      alpha: 'straight',
      masks: 'Opaque 8-bit RGBA. White (255) = visible, black (0) = not visible. Geometry priors, not segmentation of any image.',
      regionMap: 'Opaque. Black = background. Slot colors in slots[].regionColor.',
      lineArt:
        'White background. Black: outer silhouette and occlusion contours. Mid gray: seams between touching parts. Light gray: form lines (front midlines of the torso and head, eye and nose dots) that show the turn.'
    },
    assumptions: [
      'Geometry comes from simple volumes (capsules, ellipsoids, one torso volume with elliptic sections). No hair, clothing, fingers, ears, or face detail except a small nose.',
      `The torso volume is split between the torso and hips slots at the spine joint height (${torsoSplitUp} head units).`,
      `The neck volume below the neck joint height (${neckSplitUp} head units) is inside the torso and belongs to the torso slot.`,
      'Visibility follows the slot draw order, as Spine draws the setup pose. drawOrderConflicts lists pixels where another slot is nearer in 3D.',
      'Slots without a volume have no mask. A required one gets a hatched placeholder frame in the mock package.'
    ],
    checks,
    drawOrderConflicts,
    slots: slotReports,
    mockPackage: { directory: 'mock-package', characterJson: 'mock-package/character.json', characterId: mockCharacterId, rule: 'D22: optional slots are absent_by_design, with no PNG.' },
    files: fileRecords
  };
  const review = reviewText(manifest, slots, checks, drawOrderConflicts);
  const reviewFile: PlannedFile = { name: 'review.md', bytes: Buffer.from(review, 'utf8') };
  const manifestFile: PlannedFile = { name: 'template.json', bytes: json({ ...manifest, files: [...fileRecords, record(reviewFile)] }) };
  const planned = [...files.map((item) => item.file), characterFile, reviewFile, manifestFile];
  return {
    report: { status: failed.length === 0 ? 'PASS' : 'FAIL', command: 'template', format: templateFormat, templateStatus: 'prototype', checks, files: planned.map((file) => record(file)) },
    files: planned
  };
}

function reviewText(
  manifest: { coordinates: { image: { width: number; height: number } }; inputs: { contract: Record<string, unknown> } },
  slots: readonly SlotInfo[],
  checks: readonly TemplateCheck[],
  conflicts: readonly Record<string, unknown>[]
): string {
  const contract = manifest.inputs.contract;
  const notModeled = slots.filter((slot) => !slot.modeled);
  const placeholders = notModeled.filter((slot) => slot.required).map((slot) => `\`${slot.id}\``);
  const lines = [
    '# T1a static template: review notes',
    '',
    '**Prototype.** This is a static template of the C0.5 candidate geometry in the setup pose. C0.5 is not an approved production rig.',
    'Nothing here shows that the parts animate correctly in Spine. Motion coverage and Spine compatibility are not validated.',
    '',
    `Contract: \`${String(contract.rigId)}\` ${String(contract.contractVersion)}, SHA-256 \`${String(contract.sha256)}\`. Image size: ${manifest.coordinates.image.width} x ${manifest.coordinates.image.height}.`,
    '',
    '## Files',
    '',
    '| File | What it shows |',
    '| --- | --- |',
    '| `contour-lineart.png` | Contour of the reference volumes. Black: outer silhouette and occlusion edges. Mid gray: seams between touching parts. Light gray: form lines that show the turn. |',
    '| `region-map.png` | One flat color for each slot, where the slot is visible in the setup pose. Colors are in `template.json` (`slots[].regionColor`). |',
    '| `masks/<slot>.visible.png` | One white-on-black mask for each slot with a reference volume. |',
    '| `overlay-sheet.png` | Left: regions with slot names. Middle: pivots, attachment rectangles, joint overlap circles, near/far lines, face and feet arrows. Right: top view. |',
    '| `mock-package/` | `character.json` and flat-color parts for the required slots, for a later manual Spine check (F0a). |',
    '| `template.json` | Manifest: inputs and hashes, coordinates, checks, slots, files with SHA-256. |',
    '',
    '## How to check the geometry',
    '',
    '1. Open `overlay-sheet.png`.',
    '2. Middle panel: the blue (near) shoulder and hip are on the image left, the orange (far) ones on the image right. The face arrow and both foot arrows point to the image right.',
    '3. Middle panel: each pivot dot sits at a joint of the light silhouette. Each red overlap circle is at the child joint and inside the slot rectangle.',
    '4. Left panel: each slot name is on its own color. The near arm and leg cover the torso and hips. The far arm is mostly behind the torso.',
    '5. Right panel: the red facing line turns about 40 degrees from the camera direction (black, bottom) toward the image right.',
    '6. Compare `contour-lineart.png` with `region-map.png`: the lines are the borders of the colored regions.',
    '',
    'Expected orientation: front-visible three-quarter view, face and feet to the image right, near side (subject right) on the image left.',
    '',
    '## Checks',
    '',
    '| Id | Status | Detail |',
    '| --- | --- | --- |',
    ...checks.map((check) => `| ${check.id} | ${check.status} | ${check.detail.replace(/\|/g, '/')} |`),
    '',
    '## Draw order and 3D depth',
    '',
    'Spine draws by slot draw order. These pixels show a slot on top that is not the nearest surface in 3D. Check them in Spine.',
    '',
    ...(conflicts.length === 0
      ? ['None.']
      : [
          '| On top (draw order) | Nearer in 3D | Image pixels |',
          '| --- | --- | --- |',
          ...conflicts.map((item) => `| ${String(item.drawnOnTop)} | ${String(item.nearerIn3d)} | ${String(item.imagePixels)} |`)
        ]),
    '',
    '## Known approximations',
    '',
    '- The body is simple volumes: capsules for limbs, hands and feet, ellipsoids for the head and nose, one smooth torso volume. No fingers, no breasts, no clothing.',
    '- The torso volume is split between `torso` and `hips` at the spine joint height. The real seam position is a design choice for the artist.',
    '- The neck volume below the neck joint is inside the torso and belongs to `torso`. The neck part starts at the neck joint.',
    `- These slots have no reference volume and no mask: ${notModeled.map((slot) => `\`${slot.id}\``).join(', ')}.`,
    `- Required slots without a volume get a hatched placeholder frame in the mock package, not a shape: ${placeholders.join(', ') || 'none'}.`,
    '- Masks are sampled at pixel centers. Borders can differ by one pixel from another renderer.',
    '',
    '## What the static masks cannot prove',
    '',
    '- That hidden areas are complete. A mask shows only what is visible in the setup pose. Parts move in animations and show pixels that are hidden here.',
    '- That a generated image can be cut with these masks. A generated character has hair, clothing and a silhouette that differ from these volumes.',
    '- That the draw order is correct in every pose.',
    '- That parser acceptance means pixel quality, rig compatibility, or correct animation. `parseCharacter` checks structure only.',
    '',
    '## What a real Spine rig check (F0a) must look at',
    '',
    '- A candidate rig that has the C0.5 setup pose. The current test rig (L1) has another lateral order and does not fit these parts.',
    '- Every shared animation in both facings, including mixes between animations.',
    '- Gaps or holes at the shoulders, elbows, wrists, hips, knees, ankles, the neck, and the torso/hips seam.',
    '- Draw order problems, mostly where the list above shows conflicts.',
    '- Parts that the attachment rectangles cut off.',
    '',
    '## Limits for later layer (L) experiments',
    '',
    '- Use the masks, the region map and the line art as references or priors. They are not ground truth for a generated image.',
    '- A later L experiment can choose another segmentation or editing method if these masks are not sufficient.',
    '- No mask exists for hair, ears, tail, skirt, accessories, or the weapon.',
    '- The body is one archetype (7 heads, yaw 40 degrees). Other proportions need other templates.',
    ''
  ];
  return lines.join('\n');
}
