import { demoAnimations } from '@control/bodyassembly';
import { animationLength, type BodyBoneSpec, type BodyRigSpec, type BodySlotSpec, buildBodySkeleton, checkBodySkeleton, poseAt, type RegionImage, renderPose } from '@control/bodyrig';
import { type CommandResult, json, sheetOf } from '@control/commands';
import { type ControlContract, type Joint, parseControlContract } from '@control/contract';
import { checker, half } from '@control/layersplit';
import { titled } from '@control/limbstudy';
import { contractSlotRules } from '@control/modularsheet';
import type { PlannedFile } from '@control/output';
import { decodePng, encodePng, pixelHash, sha256 } from '@control/png';
import { fail, isRecord } from '@control/problems';
import { type Color, Raster } from '@control/raster';
import { extractFormat } from '@control/sheetextract';
import { differentPixels, manifests } from '@control/spinearm';
import { type Check, type ImageBox, skeletonBytes, type SpineFrame, toImage, type WorldBone, worldBones } from '@control/spineskeleton';

// Pipeline v2, step V2-3 (HACK-FIRST spike): put the V2-2 extracted parts on the C0.5 candidate skeleton.
// Inputs: the rig contract and one sheet-extract output directory. The skeleton is the contract skeleton (all bones at the contract joints).
// A descriptor joint of the slot bone places the part (character placement data). Without it, the part goes to its attachment rectangle.
// The source PNG bytes are copied without a change. Reuses the MVP-A skeleton builder, local renderer, and demonstration animations.

export const sheetAssemblyFormat = 'aigg.v2-3.sheet-assembly/0.1';
export const assemblySkeletonPath = 'spine/skeleton.json';
export const assemblyImageDirectory = 'spine/images';
/** Time in the wave animation for the evidence frame: upper arm 80 degrees, forearm 70 degrees (screen). */
export const waveEvidenceTime = 1;
export const maxManifestBytes = 4 * 1024 * 1024;

const slotPattern = /^[a-z][a-z0-9_]{0,63}$/;
const hexPattern = /^[0-9a-f]{64}$/;

type ManifestPoint = { readonly bone: string; readonly local: Joint };
export type ManifestPart = {
  readonly slot: string;
  readonly bone: string;
  readonly file: string;
  readonly size: { readonly width: number; readonly height: number };
  readonly fileSha256: string;
  readonly pixelSha256: string;
  readonly joints: readonly ManifestPoint[] | null;
};
export type ExtractionInput = {
  readonly rig: { readonly rigId: string; readonly contractVersion: string; readonly contractSha256: string };
  readonly parts: readonly ManifestPart[];
  readonly absent: readonly string[];
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Reads the fields of extraction.json that the assembly uses. The manifest is untrusted: each used field is checked. */
export function parseExtraction(bytes: Buffer): ExtractionInput {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('E_EXTRACTION_FORMAT', 'extraction.json is not valid JSON.');
  }
  if (!isRecord(value) || value.format !== extractFormat) fail('E_EXTRACTION_FORMAT', `extraction.json must have the format ${extractFormat}.`);
  const rig = value.rig;
  if (!isRecord(rig) || typeof rig.rigId !== 'string' || typeof rig.contractVersion !== 'string' || typeof rig.contractSha256 !== 'string' || !hexPattern.test(rig.contractSha256))
    fail('E_EXTRACTION_FORMAT', 'extraction.json has no valid rig.');
  if (!Array.isArray(value.parts) || value.parts.length === 0 || value.parts.length > 64) fail('E_EXTRACTION_FORMAT', 'extraction.json must have 1 to 64 parts.');
  const parts: ManifestPart[] = value.parts.map((item: unknown, index: number): ManifestPart => {
    const subject = `parts[${index}]`;
    if (!isRecord(item) || typeof item.slot !== 'string' || !slotPattern.test(item.slot) || typeof item.bone !== 'string' || !slotPattern.test(item.bone))
      fail('E_EXTRACTION_FORMAT', `${subject} needs snake_case slot and bone.`);
    const size = item.size;
    if (!isRecord(size) || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || (size.width as number) < 1 || (size.height as number) < 1)
      fail('E_EXTRACTION_FORMAT', `${subject}.size is not valid.`);
    if (typeof item.fileSha256 !== 'string' || !hexPattern.test(item.fileSha256) || typeof item.pixelSha256 !== 'string' || !hexPattern.test(item.pixelSha256))
      fail('E_EXTRACTION_FORMAT', `${subject} needs fileSha256 and pixelSha256.`);
    if (item.file !== `parts/${item.slot}.png`) fail('E_EXTRACTION_FORMAT', `${subject}.file must be parts/${item.slot}.png.`);
    const joints = item.joints;
    let points: ManifestPoint[] | null = null;
    if (isRecord(joints) && joints.status === 'supplied' && Array.isArray(joints.points)) {
      points = joints.points.map((point: unknown) => {
        if (!isRecord(point) || typeof point.bone !== 'string' || !slotPattern.test(point.bone) || !isRecord(point.local) || !finite(point.local.x) || !finite(point.local.y))
          fail('E_EXTRACTION_FORMAT', `${subject}.joints has a point that is not valid.`);
        return { bone: point.bone, local: { x: point.local.x, y: point.local.y } };
      });
    } else if (!isRecord(joints) || joints.status !== 'absent') fail('E_EXTRACTION_FORMAT', `${subject}.joints must be supplied or absent.`);
    return {
      slot: item.slot,
      bone: item.bone,
      file: item.file,
      size: { width: size.width as number, height: size.height as number },
      fileSha256: item.fileSha256,
      pixelSha256: item.pixelSha256,
      joints: points
    };
  });
  if (!Array.isArray(value.absentSlots)) fail('E_EXTRACTION_FORMAT', 'extraction.json has no absentSlots.');
  const absent = value.absentSlots.map((item: unknown) => {
    if (!isRecord(item) || typeof item.slot !== 'string' || !slotPattern.test(item.slot) || item.status !== 'absent_by_design')
      fail('E_EXTRACTION_FORMAT', 'absentSlots has an entry that is not valid.');
    return item.slot;
  });
  return { rig: { rigId: rig.rigId, contractVersion: rig.contractVersion, contractSha256: rig.contractSha256 }, parts, absent };
}

export type Placement = {
  readonly slot: string;
  readonly bone: string;
  readonly method: 'descriptor_joint' | 'attachment_rect';
  readonly anchorBone: string | null;
  /** Top-left corner of the part on the contract canvas (contract px, y down), before and after rounding to whole pixels. */
  readonly exact: Joint;
  readonly box: ImageBox;
  readonly rounding: Joint;
  /** Box corner minus the attachment rectangle corner. 0 means the joint placement and the contract rectangle agree. */
  readonly rectDelta: Joint;
  /** Part size divided by the attachment rectangle size. 1 means no scale difference. No resampling is done. */
  readonly scale: { readonly x: number; readonly y: number };
  /** For each supplied joint: its canvas position after placement, minus the contract joint of that bone. */
  readonly jointResiduals: readonly { readonly bone: string; readonly dx: number; readonly dy: number; readonly distance: number }[];
};

/** Places one part on the contract canvas. Pure arithmetic: no pixel is changed. */
export function placePart(part: ManifestPart, contract: ControlContract): Placement {
  const slot = contract.slots.get(part.slot);
  if (slot === undefined) fail('E_ASSEMBLY_SLOT', `The contract has no slot ${part.slot}.`);
  const rect = slot.attachmentRect;
  const anchor = part.joints?.find((point) => point.bone === slot.bone) ?? null;
  const contractJoint = anchor ? contract.bones.get(anchor.bone)?.joint : undefined;
  const exact = anchor && contractJoint ? { x: contractJoint.x - anchor.local.x, y: contractJoint.y - anchor.local.y } : { x: rect.x, y: rect.y };
  const left = Math.round(exact.x);
  const top = Math.round(exact.y);
  const residuals = (part.joints ?? []).map((point) => {
    const target = contract.bones.get(point.bone)?.joint;
    if (target === undefined) fail('E_ASSEMBLY_JOINT', `${part.slot}: the contract has no bone ${point.bone}.`);
    const dx = left + point.local.x - target.x;
    const dy = top + point.local.y - target.y;
    return { bone: point.bone, dx, dy, distance: Math.hypot(dx, dy) };
  });
  return {
    slot: part.slot,
    bone: slot.bone,
    method: anchor && contractJoint ? 'descriptor_joint' : 'attachment_rect',
    anchorBone: anchor ? anchor.bone : null,
    exact,
    box: { left, top, width: part.size.width, height: part.size.height },
    rounding: { x: left - exact.x, y: top - exact.y },
    rectDelta: { x: left - rect.x, y: top - rect.y },
    scale: { x: part.size.width / rect.w, y: part.size.height / rect.h },
    jointResiduals: residuals
  };
}

/** The 28 contract bones at the contract joints. A bone points to its first child in contract order; a leaf has no direction. */
export function contractBoneSpecs(contract: ControlContract): BodyBoneSpec[] {
  const bones = [...contract.bones.values()];
  return bones.map((bone) => {
    const child = bones.find((other) => other.parent === bone.id);
    return { name: bone.id, parent: bone.parent, joint: bone.joint, end: bone.parent !== null && child ? child.joint : null };
  });
}

export type SheetAssemblyOptions = {
  readonly contractBytes: Buffer;
  readonly manifestBytes: Buffer;
  /** Part PNG bytes by slot id, read from `parts/<slot>.png` of the extraction directory. */
  readonly partFiles: ReadonlyMap<string, Buffer>;
  readonly toolVersion: string;
};

const red: Color = [220, 30, 30, 255];
const magenta: Color = [255, 0, 255, 255];

function mark(target: Raster, at: Joint, color: Color): void {
  target.line({ x: at.x - 6, y: at.y }, { x: at.x + 6, y: at.y }, 2, color);
  target.line({ x: at.x, y: at.y - 6 }, { x: at.x, y: at.y + 6 }, 2, color);
}

/** True when a pixel with alpha >= 16 is within `radius` px of the point. */
function covered(image: Raster, at: Joint, radius: number): boolean {
  for (let y = Math.floor(at.y - radius); y <= Math.ceil(at.y + radius); y += 1)
    for (let x = Math.floor(at.x - radius); x <= Math.ceil(at.x + radius); x += 1) if ((image.pixel(x, y)[3] ?? 0) >= 16) return true;
  return false;
}

/** `sheet-assemble`: the V2-3 spike package (Spine 4.3 JSON, region PNGs, evidence, previews) from one sheet-extract result. */
export function sheetAssembleCommand(options: SheetAssemblyOptions): CommandResult {
  let raw: unknown;
  try {
    raw = JSON.parse(options.contractBytes.toString('utf8'));
  } catch {
    fail('E_CONTRACT_FORMAT', 'The contract is not valid JSON.');
  }
  const contract = parseControlContract(raw);
  const rules = contractSlotRules(options.contractBytes);
  const extraction = parseExtraction(options.manifestBytes);
  if (extraction.rig.rigId !== contract.rigId || extraction.rig.contractVersion !== contract.contractVersion || extraction.rig.contractSha256 !== sha256(options.contractBytes))
    fail('E_ASSEMBLY_RIG', 'The extraction was made for another rig contract (rig id, version, or contract SHA-256 differ).');

  // Inputs: every contract slot is a part or absent by design; each part PNG is the file that the manifest names.
  const problems: string[] = [];
  const bySlot = new Map(extraction.parts.map((part) => [part.slot, part]));
  if (bySlot.size !== extraction.parts.length) problems.push('A slot has two parts.');
  for (const rule of rules.slots) {
    const part = bySlot.get(rule.id);
    const absent = extraction.absent.includes(rule.id);
    if (part && absent) problems.push(`${rule.id} is both a part and absent.`);
    if (!part && !absent) problems.push(`${rule.id} is neither a part nor absent.`);
    if (!part && absent && rule.required) problems.push(`The required slot ${rule.id} is absent.`);
    if (part && part.bone !== rule.bone) problems.push(`${rule.id}: the manifest bone ${part.bone} is not the contract bone ${rule.bone}.`);
  }
  for (const part of extraction.parts) if (!rules.slots.some((rule) => rule.id === part.slot)) problems.push(`The contract has no slot ${part.slot}.`);
  const images = new Map<string, Raster>();
  for (const part of extraction.parts) {
    const bytes = options.partFiles.get(part.slot);
    if (bytes === undefined) {
      problems.push(`${part.file} is missing.`);
      continue;
    }
    if (sha256(bytes) !== part.fileSha256) problems.push(`${part.file}: the SHA-256 is not the manifest value.`);
    const raster = decodePng(bytes).raster;
    if (raster.width !== part.size.width || raster.height !== part.size.height || pixelHash(raster) !== part.pixelSha256) problems.push(`${part.file}: the pixels are not the manifest pixels.`);
    images.set(part.slot, raster);
  }
  if (problems.length > 0) fail('E_ASSEMBLY_INPUT', problems.slice(0, 8).join(' '));

  // Geometry: coordinate frames. Sheet px (V2-2 source box) -> part px (crop) -> contract canvas px (y down) -> Spine units (y up, origin = rigOrigin).
  const frame: SpineFrame = { origin: contract.rigOrigin };
  const placements = extraction.parts.map((part) => placePart(part, contract));
  const placementOf = new Map(placements.map((item) => [item.slot, item]));
  const ordered = [...contract.slots.values()].sort((a, b) => a.drawOrder - b.drawOrder);
  const slotSpecs: BodySlotSpec[] = ordered.map((slot) => ({ name: slot.id, bone: slot.bone, box: placementOf.get(slot.id)?.box ?? null }));
  const boneSpecs = contractBoneSpecs(contract);
  const animations = demoAnimations(new Set(boneSpecs.map((bone) => bone.name)));
  const spec: BodyRigSpec = { frame, bones: boneSpecs, slots: slotSpecs, animations };
  const skeleton = buildBodySkeleton(spec);
  const bytes = skeletonBytes(skeleton);
  const parsed = JSON.parse(bytes.toString('utf8')) as ReturnType<typeof buildBodySkeleton>;
  const regionImages = new Map<string, RegionImage>();
  for (const placement of placements) regionImages.set(placement.slot, { raster: images.get(placement.slot) as Raster, box: placement.box });

  const checks: Check[] = [...checkBodySkeleton(parsed, spec)];
  const add = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, status: ok ? 'PASS' : 'FAIL', detail });
  };
  const required = rules.slots.filter((rule) => rule.required);
  add(
    'parts_and_absent_slots',
    required.every((rule) => bySlot.has(rule.id)) && extraction.absent.every((slot) => parsed.slots.some((item) => item.name === slot && item.attachment === undefined)),
    `${extraction.parts.length} parts with a region attachment; ${extraction.absent.length} absent optional slots are empty slots.`
  );
  add(
    'contract_hierarchy_and_draw_order',
    parsed.bones.length === contract.bones.size &&
      parsed.bones.every((bone) => (contract.bones.get(bone.name)?.parent ?? null) === (bone.parent ?? null)) &&
      parsed.slots.map((slot) => slot.name).join() === ordered.map((slot) => slot.id).join() &&
      parsed.slots.every((slot) => contract.slots.get(slot.name)?.bone === slot.bone),
    `${parsed.bones.length} bones with the contract parents; ${parsed.slots.length} slots in contract draw order with the contract bones.`
  );
  const tolerancePx = (contract.tolerances.jointErrorMaxPctHeight / 100) * contract.canvas.height;
  const worst = placements.flatMap((item) => item.jointResiduals.map((residual) => ({ slot: item.slot, ...residual }))).sort((a, b) => b.distance - a.distance)[0];
  add(
    'joint_residuals',
    worst === undefined || worst.distance <= tolerancePx,
    worst === undefined ? 'No descriptor joints.' : `Largest joint residual after placement: ${worst.distance.toFixed(3)} px (${worst.slot}.${worst.bone}). Tolerance ${tolerancePx.toFixed(1)} px.`
  );
  const scaled = placements.filter((item) => item.scale.x !== 1 || item.scale.y !== 1);
  add(
    'scale',
    scaled.length === 0,
    scaled.length === 0
      ? 'Each part has the size of its attachment rectangle. No scale change, no resampling.'
      : `Parts with another size than the attachment rectangle (not resampled): ${scaled.map((item) => item.slot).join(', ')}.`
  );

  // Renders (local nearest-neighbor renderer of the MVP-A package, not Spine).
  const { width, height } = contract.canvas;
  const setup = renderPose(parsed, frame, regionImages, {}, width, height);
  const direct = new Raster(width, height);
  for (const slot of ordered) {
    const placement = placementOf.get(slot.id);
    const raster = images.get(slot.id);
    if (!placement || !raster) continue;
    for (let y = 0; y < raster.height; y += 1) for (let x = 0; x < raster.width; x += 1) direct.blend(placement.box.left + x, placement.box.top + y, raster.pixel(x, y));
  }
  const setupDifference = differentPixels(direct, setup);
  add('setup_pose_render', setupDifference.pixels === 0, `The skeleton setup pose gives ${setupDifference.pixels} different pixels against the direct placement of the parts in draw order.`);
  const rectComposite = new Raster(width, height);
  for (const slot of ordered) {
    const raster = images.get(slot.id);
    if (raster) for (let y = 0; y < raster.height; y += 1) for (let x = 0; x < raster.width; x += 1) rectComposite.blend(slot.attachmentRect.x + x, slot.attachmentRect.y + y, raster.pixel(x, y));
  }
  const rectDifference = differentPixels(rectComposite, setup);
  add(
    'setup_matches_attachment_rects',
    true,
    `Informational: ${rectDifference.pixels} pixels differ from the parts at their contract attachment rectangles (0 means the descriptor joints agree with the contract).`
  );

  const wave = poseAt(parsed, 'wave', waveEvidenceTime);
  const waveImage = renderPose(parsed, frame, regionImages, wave, width, height);
  const setupWorld = worldBones(parsed.bones);
  const waveWorld = worldBones(parsed.bones, wave);
  const moved = (bone: string): number => {
    const a = setupWorld.get(bone) as WorldBone;
    const b = waveWorld.get(bone) as WorldBone;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const handMove = moved('hand_near');
  const stillBones = ['hips', 'thigh_near', 'thigh_far', 'foot_near', 'foot_far'];
  const stillMove = Math.max(...stillBones.map(moved));
  const waveDifference = differentPixels(setup, waveImage);
  add(
    'wave_moves_near_arm',
    handMove > 100 && stillMove < 1e-6 && waveDifference.pixels > 0,
    `At wave t=${waveEvidenceTime} s the near wrist moves ${handMove.toFixed(1)} px; the hips and legs move ${stillMove.toFixed(6)} px; ${waveDifference.pixels} pixels change.`
  );
  // Attachment of the moving near arm: each joint of the chain must be covered by art in both poses (no detached segment).
  const armJoints = ['upper_arm_near', 'forearm_near', 'hand_near'];
  const uncovered: string[] = [];
  for (const [name, image, world] of [
    ['setup', setup, setupWorld],
    ['wave', waveImage, waveWorld]
  ] as const) {
    for (const bone of armJoints) {
      const point = toImage(frame, world.get(bone) as WorldBone);
      if (!covered(image, point, 3)) uncovered.push(`${name}:${bone}`);
    }
  }
  add(
    'near_arm_joints_covered',
    uncovered.length === 0,
    uncovered.length === 0 ? 'The near shoulder, elbow, and wrist have art within 3 px in the setup pose and the wave frame.' : `Joints without art within 3 px: ${uncovered.join(', ')}.`
  );

  // Previews.
  const background = checker(width, height);
  const frameAt = (delta: Record<string, number>, bones: boolean): Raster => {
    const image = renderPose(parsed, frame, regionImages, delta, width, height, background);
    if (bones) {
      const world = worldBones(parsed.bones, delta);
      for (const bone of armJoints) mark(image, toImage(frame, world.get(bone) as WorldBone), red);
    }
    return half(image);
  };
  const changed = new Raster(width, height, [255, 255, 255, 255]);
  for (let p = 0; p < width * height; p += 1) {
    const a = (setup.data[p * 4 + 3] ?? 0) > 0;
    const b = (waveImage.data[p * 4 + 3] ?? 0) > 0;
    let d = false;
    for (let c = 0; c < 4; c += 1) if (setup.data[p * 4 + c] !== waveImage.data[p * 4 + c]) d = true;
    changed.data.set(d ? magenta : a || b ? [170, 170, 170, 255] : [255, 255, 255, 255], p * 4);
  }
  const files: PlannedFile[] = [];
  files.push({ name: 'previews/setup.png', bytes: encodePng(titled(frameAt({}, true), 'V2-3 setup pose (local renderer, not Spine)')) });
  files.push({
    name: 'previews/wave.png',
    bytes: encodePng(
      titled(
        sheetOf(
          [
            [
              titled(frameAt({}, true), 'setup'),
              titled(frameAt(poseAt(parsed, 'wave', 0.4), true), 'wave t=0.4'),
              titled(frameAt(wave, true), `wave t=${waveEvidenceTime}`),
              titled(half(changed), 'changed pixels (magenta)')
            ]
          ],
          8
        ),
        'V2-3 wave: near arm (local nearest-neighbor renderer, not Spine). Red: near shoulder, elbow, wrist.'
      )
    )
  });
  const idleLength = animationLength(parsed, 'idle');
  files.push({
    name: 'previews/idle.png',
    bytes: encodePng(titled(sheetOf([[0, idleLength / 2].map((time) => titled(frameAt(poseAt(parsed, 'idle', time), false), `idle t=${time}`))], 8), 'V2-3 idle (local renderer, not Spine)'))
  });

  // Package: Spine JSON, region PNGs (the extracted bytes, unchanged), sidecar, evidence, manifests.
  const packageFiles: PlannedFile[] = [{ name: assemblySkeletonPath, bytes }];
  for (const part of extraction.parts) packageFiles.push({ name: `${assemblyImageDirectory}/${part.slot}.png`, bytes: options.partFiles.get(part.slot) as Buffer });
  const sidecar = {
    schemaVersion: '0.2.0',
    characterId: 'v2_synthetic_sheet',
    rigId: contract.rigId,
    parts: Object.fromEntries(ordered.map((slot) => [slot.id, bySlot.has(slot.id) ? { status: 'present', file: `${assemblyImageDirectory}/${slot.id}.png` } : { status: 'absent_by_design' }]))
  };
  packageFiles.push({ name: 'character.json', bytes: json(sidecar) });
  const status: 'PASS' | 'FAIL' = checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL';
  const evidence = {
    format: sheetAssemblyFormat,
    status,
    spineStatus: 'JSON_GENERATED',
    tool: { name: '@aigg/control', command: 'sheet-assemble', version: options.toolVersion },
    rig: { rigId: contract.rigId, contractVersion: contract.contractVersion, contractSha256: sha256(options.contractBytes) },
    extraction: { sha256: sha256(options.manifestBytes) },
    coordinates: {
      sheet: 'V2-2 source sheet px, y down (sourceBox in extraction.json).',
      part: 'Part px, origin at the top-left corner of the extracted PNG (local joints in extraction.json).',
      canvas: `Contract canvas px, ${width}x${height}, y down. Part box = contract joint of the slot bone - local joint, rounded to whole px.`,
      spine: `Spine units, y up, origin at the contract rigOrigin (${contract.rigOrigin.x}, ${contract.rigOrigin.y}), 1 unit = 1 canvas px.`
    },
    jointPolicy:
      'Owner decision for this spike: the skeleton uses the contract joints. A descriptor joint of the slot bone places the part on the contract joint. Other descriptor joints are compared with the contract (jointResiduals). The skeleton is not changed for a character.',
    placements,
    absentSlots: extraction.absent,
    animations: animations.map((animation) => ({ name: animation.name, duration: animation.duration, bones: animation.tracks.map((track) => track.bone) })),
    waveEvidence: { time: waveEvidenceTime, nearWristMovePx: handMove, changedPixels: waveDifference.pixels },
    checks,
    limitations: [
      'Local nearest-neighbor renderer, not Spine. No Spine CLI import or export, no browser playback in this command.',
      'idle and wave are the MVP-A demonstration animations. They are not the version 1 animation set.',
      'Synthetic flat-color parts at contract scale. A real sheet with another scale is reported (check scale) but not resampled.'
    ]
  };
  packageFiles.push({ name: 'evidence/assembly.json', bytes: json(evidence) });
  const all = [...packageFiles, ...files];
  all.push(...manifests(all));
  return {
    report: {
      format: sheetAssemblyFormat,
      status,
      spineStatus: 'JSON_GENERATED',
      rig: evidence.rig,
      counts: { bones: parsed.bones.length, slots: parsed.slots.length, parts: extraction.parts.length, absentSlots: extraction.absent.length },
      checks,
      waveEvidence: evidence.waveEvidence,
      files: all.map((file) => ({ name: file.name, sha256: sha256(file.bytes) }))
    },
    files: all
  };
}
