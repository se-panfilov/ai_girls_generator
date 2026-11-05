import type { ControlContract, Rect, Size } from '@control/contract';
import { type Keypoint, keypointColors, limbs, type RigPose, toTarget, type Transform } from '@control/pose';
import { type Color, Raster } from '@control/raster';

// The proportion reference: attachment rectangles, bones, joints, and a grid of eighths of the body height.
// It is a picture for people. It is not a control image for a model.

type Side = 'near' | 'far' | 'center';
const sideOf = (id: string): Side => (id.endsWith('_near') ? 'near' : id.endsWith('_far') ? 'far' : 'center');
const sideColor: Record<Side, readonly [number, number, number]> = { near: [40, 110, 230], far: [235, 130, 30], center: [120, 120, 120] };

function scaledRect(rect: Rect, transform: Transform): Rect {
  const a = toTarget({ x: rect.x, y: rect.y }, transform);
  return { x: a.x, y: a.y, w: rect.w * transform.scale, h: rect.h * transform.scale };
}

function boneSegments(contract: ControlContract): [string, string][] {
  return [...contract.bones.values()].filter((bone) => bone.parent !== null).map((bone) => [bone.parent as string, bone.id]);
}

/** Grid lines at each eighth of the body height, from the top of the head rectangle to the ground, in contract pixels. */
export function bodyGrid(pose: RigPose, contract: ControlContract): number[] {
  const top = contract.rigOrigin.y - pose.bodyHeight;
  return Array.from({ length: 9 }, (_, index) => top + (pose.bodyHeight * index) / 8);
}

/** Raster version of the proportion reference. */
export function renderReference(contract: ControlContract, pose: RigPose, size: Size, transform: Transform): Raster {
  const raster = new Raster(size.width, size.height, [255, 255, 255, 255]);
  const lineWidth = Math.max(1, Math.round(2 * transform.scale));
  for (const y of bodyGrid(pose, contract)) {
    const ty = toTarget({ x: 0, y }, transform).y;
    raster.line({ x: 0, y: ty }, { x: size.width, y: ty }, 1, [180, 180, 180, 255]);
  }
  const slots = [...contract.slots.values()].sort((a, b) => a.drawOrder - b.drawOrder);
  for (const slot of slots) {
    const rect = scaledRect(slot.attachmentRect, transform);
    const rgb = sideColor[sideOf(slot.bone)];
    raster.fillPolygon(
      [
        { x: rect.x, y: rect.y },
        { x: rect.x + rect.w, y: rect.y },
        { x: rect.x + rect.w, y: rect.y + rect.h },
        { x: rect.x, y: rect.y + rect.h }
      ],
      [rgb[0], rgb[1], rgb[2], 40]
    );
    raster.strokeRect(rect.x, rect.y, rect.w, rect.h, 1, [rgb[0], rgb[1], rgb[2], 160]);
  }
  for (const [parent, child] of boneSegments(contract)) {
    const a = contract.bones.get(parent);
    const b = contract.bones.get(child);
    if (!a || !b) continue;
    raster.line(toTarget(a.joint, transform), toTarget(b.joint, transform), lineWidth, [30, 30, 30, 255]);
  }
  for (const bone of contract.bones.values()) {
    const rgb = sideColor[sideOf(bone.id)];
    raster.fillCircle(toTarget(bone.joint, transform), Math.max(2, 6 * transform.scale), [rgb[0], rgb[1], rgb[2], 255]);
  }
  return raster;
}

const fmt = (value: number): string => String(Math.round(value * 100) / 100);
const escapeXml = (text: string): string => text.replace(/[<>&"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[char] ?? char);

/** SVG version of the proportion reference in contract space, with bone and keypoint labels. */
export function referenceSvg(contract: ControlContract, pose: RigPose): string {
  const { width, height } = contract.canvas;
  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="sans-serif">`,
    `<title>${escapeXml(`${contract.rigId} ${contract.contractVersion} proportion reference (${pose.mapping} mapping)`)}</title>`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`
  ];
  for (const [index, y] of bodyGrid(pose, contract).entries()) {
    lines.push(`<line x1="0" y1="${fmt(y)}" x2="${width}" y2="${fmt(y)}" stroke="#b4b4b4" stroke-width="1"/>`);
    lines.push(`<text x="4" y="${fmt(y - 4)}" font-size="14" fill="#777">${index}/8</text>`);
  }
  for (const slot of [...contract.slots.values()].sort((a, b) => a.drawOrder - b.drawOrder)) {
    const { x, y, w, h } = slot.attachmentRect;
    const [r, g, b] = sideColor[sideOf(slot.bone)];
    lines.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgb(${r},${g},${b})" fill-opacity="0.12" stroke="rgb(${r},${g},${b})" stroke-opacity="0.6"><title>${escapeXml(slot.id)}</title></rect>`
    );
  }
  for (const [parent, child] of boneSegments(contract)) {
    const a = contract.bones.get(parent)?.joint;
    const b = contract.bones.get(child)?.joint;
    if (a && b) lines.push(`<line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(b.x)}" y2="${fmt(b.y)}" stroke="#1e1e1e" stroke-width="3"/>`);
  }
  for (const bone of contract.bones.values()) {
    const [r, g, b] = sideColor[sideOf(bone.id)];
    lines.push(`<circle cx="${fmt(bone.joint.x)}" cy="${fmt(bone.joint.y)}" r="6" fill="rgb(${r},${g},${b})"/>`);
    lines.push(`<text x="${fmt(bone.joint.x + 8)}" y="${fmt(bone.joint.y - 4)}" font-size="11" fill="#333">${escapeXml(bone.id)}</text>`);
  }
  for (const [index, item] of pose.keypoints.entries()) {
    if (!item.point) continue;
    const rgb = keypointColors[index] ?? [0, 0, 0];
    const dashed = item.source.startsWith('assumption:') ? ' stroke-dasharray="3 2"' : '';
    lines.push(
      `<circle cx="${fmt(item.point.x)}" cy="${fmt(item.point.y)}" r="9" fill="none" stroke="rgb(${rgb.join(',')})" stroke-width="3"${dashed}><title>${escapeXml(`${item.name} (${item.source})`)}</title></circle>`
    );
  }
  lines.push(`<text x="${width - 8}" y="${height - 8}" font-size="14" text-anchor="end" fill="#555">near: blue, far: orange, body: gray. Dashed rings: assumed face keypoints.</text>`);
  lines.push('</svg>', '');
  return lines.join('\n');
}

/** Draws the rig skeleton over an image: the OpenPose limbs as thin lines and the joints as rings. */
export function drawSkeletonOverlay(raster: Raster, keypoints: readonly Keypoint[], transform: Transform, opacity = 230): void {
  const width = Math.max(2, Math.round(3 * transform.scale * 1.5));
  const points = keypoints.map((item) => (item.point ? toTarget(item.point, transform) : null));
  for (const [index, [from, to]] of limbs.entries()) {
    const a = points[from];
    const b = points[to];
    const rgb = keypointColors[index];
    if (a && b && rgb) raster.line(a, b, width, [rgb[0], rgb[1], rgb[2], opacity]);
  }
  for (const [index, point] of points.entries()) {
    const rgb = keypointColors[index];
    if (!point || !rgb) continue;
    const ring: Color = [rgb[0], rgb[1], rgb[2], 255];
    raster.fillCircle(point, width * 2.2, [0, 0, 0, 200]);
    raster.fillCircle(point, width * 1.5, ring);
  }
}
