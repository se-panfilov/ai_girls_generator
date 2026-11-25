import { json } from '@control/commands';
import { parseControlContract } from '@control/contract';
import type { PlannedFile } from '@control/output';
import { decodePng, encodePng, pixelHash, type PngLimits, sha256 } from '@control/png';
import { ControlError, fail, isRecord, type Problem, problem, show } from '@control/problems';
import { Raster } from '@control/raster';
import { templateCommand } from '@control/template';

// Modular Sheet Contract v0.1 (Pipeline v2, step V2-1). See docs/PIPELINE_V2_MODULAR_SHEET.md.
// This module validates a layout descriptor (structure and rig contract rules), checks a sheet PNG against a descriptor, and makes the
// deterministic synthetic test sheet from the T1a mock parts. It does not extract parts, classify regions, or write a character package.

export const sheetFormat = 'aigg.modular-sheet/0.1';
export const sheetCheckFormat = 'aigg.modular-sheet-check/0.1';

/** Pixels with alpha below this value are weak alpha: they do not count as part content (bounds, stray content). */
export const foregroundAlpha = 16;
/** A part region must have at least this number of foreground pixels. */
export const minPartPixels = 64;
/** Sheet size limits. They are checked before the pixel data is inflated. */
export const sheetLimits = { minSide: 256, maxSide: 8192, maxPixels: 32 * 1024 * 1024, maxBytes: 128 * 1024 * 1024 } as const;
export const sheetPngLimits: PngLimits = { maxBytes: sheetLimits.maxBytes, maxWidth: sheetLimits.maxSide, maxHeight: sheetLimits.maxSide, maxPixels: sheetLimits.maxPixels };
/** Upper limits of the descriptor itself. */
export const maxDescriptorBytes = 1024 * 1024;
export const maxRegions = 256;

export type SheetBox = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
export type SheetPoint = { readonly x: number; readonly y: number };
export type RegionRole = 'part' | 'reference' | 'ignore';
export const regionRoles: readonly RegionRole[] = ['part', 'reference', 'ignore'];
export type RegionOrigin = 'manual' | 'tool';
export type SheetRegion = {
  readonly id: string;
  readonly role: RegionRole;
  readonly box: SheetBox;
  readonly slot?: string;
  readonly joints?: Readonly<Record<string, SheetPoint>>;
  readonly origin?: RegionOrigin;
  readonly note?: string;
};
export type SheetDescriptor = {
  readonly format: typeof sheetFormat;
  readonly sheet: { readonly file: string; readonly sha256: string; readonly width: number; readonly height: number };
  readonly rig: { readonly rigId: string; readonly contractVersion: string };
  readonly scale?: { readonly sheetPxPerContractPx: number };
  readonly regions: readonly SheetRegion[];
  readonly absentSlots: readonly string[];
};

const idPattern = /^[a-z][a-z0-9_]{0,63}$/;
const filePattern = /^[a-z0-9][a-z0-9_.-]{0,127}\.png$/;
const hexPattern = /^[0-9a-f]{64}$/;
const semverPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const maxNote = 500;

const isSide = (value: unknown, min: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= sheetLimits.maxSide;
const isOffset = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < sheetLimits.maxSide;
const isCoordinate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= sheetLimits.maxSide;

function extraKeys(value: Record<string, unknown>, keys: readonly string[], subject: string, problems: Problem[]): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) problems.push(problem('E_SHEET_FORMAT', `${subject} has the unknown field ${show(key)}.`, subject));
}

function boxOf(value: unknown, subject: string, problems: Problem[]): SheetBox | null {
  if (!isRecord(value)) {
    problems.push(problem('E_SHEET_BOX', `${subject} must be an object with x, y, w, h.`, subject));
    return null;
  }
  extraKeys(value, ['x', 'y', 'w', 'h'], subject, problems);
  const { x, y, w, h } = value;
  if (!isOffset(x) || !isOffset(y) || !isSide(w, 1) || !isSide(h, 1)) {
    problems.push(problem('E_SHEET_BOX', `${subject} needs integer x and y from 0 and integer w and h from 1 (at most ${sheetLimits.maxSide}).`, subject));
    return null;
  }
  return { x, y, w, h };
}

function pointOf(value: unknown, subject: string, problems: Problem[]): SheetPoint | null {
  if (!isRecord(value) || !isCoordinate(value.x) || !isCoordinate(value.y)) {
    problems.push(problem('E_SHEET_JOINT', `${subject} needs finite x and y from 0.`, subject));
    return null;
  }
  extraKeys(value, ['x', 'y'], subject, problems);
  return { x: value.x, y: value.y };
}

function regionOf(value: unknown, index: number, problems: Problem[]): SheetRegion | null {
  const subject = `regions[${index}]`;
  if (!isRecord(value)) {
    problems.push(problem('E_SHEET_FORMAT', `${subject} must be an object.`, subject));
    return null;
  }
  extraKeys(value, ['id', 'role', 'box', 'slot', 'joints', 'origin', 'note'], subject, problems);
  const { id, role, slot, joints, origin, note } = value;
  let ok = true;
  if (typeof id !== 'string' || !idPattern.test(id)) {
    problems.push(problem('E_SHEET_FORMAT', `${subject}.id must be a snake_case identifier.`, subject));
    ok = false;
  }
  if (typeof role !== 'string' || !(regionRoles as readonly string[]).includes(role)) {
    problems.push(problem('E_SHEET_FORMAT', `${subject}.role must be part, reference, or ignore.`, subject));
    ok = false;
  }
  const box = boxOf(value.box, `${subject}.box`, problems);
  if (slot !== undefined && (typeof slot !== 'string' || !idPattern.test(slot))) {
    problems.push(problem('E_SHEET_FORMAT', `${subject}.slot must be a snake_case identifier.`, subject));
    ok = false;
  }
  if (role === 'part' && slot === undefined) {
    problems.push(problem('E_SHEET_ROLE', `${subject} has the role part, but no slot.`, subject));
    ok = false;
  }
  if (role !== 'part' && (slot !== undefined || joints !== undefined)) {
    problems.push(problem('E_SHEET_ROLE', `${subject} has the role ${show(role)}. Only a part region can have a slot or joints.`, subject));
    ok = false;
  }
  let jointMap: Record<string, SheetPoint> | undefined;
  if (joints !== undefined) {
    if (!isRecord(joints) || Object.keys(joints).length === 0 || Object.keys(joints).length > 8) {
      problems.push(problem('E_SHEET_JOINT', `${subject}.joints must be an object with 1 to 8 bone ids.`, subject));
      ok = false;
    } else {
      jointMap = {};
      for (const [bone, point] of Object.entries(joints)) {
        if (!idPattern.test(bone)) {
          problems.push(problem('E_SHEET_JOINT', `${subject}.joints has the bad bone id ${show(bone)}.`, subject));
          ok = false;
          continue;
        }
        const parsed = pointOf(point, `${subject}.joints.${bone}`, problems);
        if (parsed === null) ok = false;
        else jointMap[bone] = parsed;
      }
    }
  }
  if (origin !== undefined && origin !== 'manual' && origin !== 'tool') {
    problems.push(problem('E_SHEET_FORMAT', `${subject}.origin must be manual or tool.`, subject));
    ok = false;
  }
  if (note !== undefined && (typeof note !== 'string' || note.length > maxNote)) {
    problems.push(problem('E_SHEET_FORMAT', `${subject}.note must be a string of at most ${maxNote} characters.`, subject));
    ok = false;
  }
  if (!ok || box === null) return null;
  return {
    id: id as string,
    role: role as RegionRole,
    box,
    ...(slot === undefined ? {} : { slot: slot as string }),
    ...(jointMap === undefined ? {} : { joints: jointMap }),
    ...(origin === undefined ? {} : { origin: origin as RegionOrigin }),
    ...(note === undefined ? {} : { note: note as string })
  };
}

/**
 * Structural check of a layout descriptor: the same rules as schemas/modular-sheet.schema.json, plus unique region ids, boxes inside the
 * canvas, and no overlap of two boxes. Throws one ControlError with all problems.
 */
export function parseSheetDescriptor(value: unknown): SheetDescriptor {
  const problems: Problem[] = [];
  if (!isRecord(value)) fail('E_SHEET_FORMAT', 'The descriptor must be a JSON object.');
  if (value.format !== sheetFormat) {
    if (typeof value.format === 'string' && value.format.startsWith('aigg.modular-sheet/'))
      fail('E_SHEET_VERSION', `The descriptor format ${show(value.format)} is not supported. Supported: ${sheetFormat}.`);
    fail('E_SHEET_FORMAT', `format must be ${sheetFormat}.`);
  }
  extraKeys(value, ['format', 'sheet', 'rig', 'scale', 'regions', 'absentSlots'], 'descriptor', problems);
  const { sheet, rig, scale, regions, absentSlots } = value;
  let sheetInfo: SheetDescriptor['sheet'] | null = null;
  if (!isRecord(sheet)) problems.push(problem('E_SHEET_FORMAT', 'sheet must be an object.', 'sheet'));
  else {
    extraKeys(sheet, ['file', 'sha256', 'width', 'height'], 'sheet', problems);
    const { file, sha256: digest, width, height } = sheet;
    if (typeof file !== 'string' || !filePattern.test(file)) problems.push(problem('E_SHEET_FORMAT', 'sheet.file must be a plain lowercase PNG file name.', 'sheet'));
    if (typeof digest !== 'string' || !hexPattern.test(digest)) problems.push(problem('E_SHEET_FORMAT', 'sheet.sha256 must be 64 lowercase hexadecimal characters.', 'sheet'));
    if (!isSide(width, sheetLimits.minSide) || !isSide(height, sheetLimits.minSide) || width * height > sheetLimits.maxPixels) {
      problems.push(
        problem('E_SHEET_FORMAT', `sheet.width and sheet.height must be integers from ${sheetLimits.minSide} to ${sheetLimits.maxSide}, at most ${sheetLimits.maxPixels} pixels.`, 'sheet')
      );
    } else if (typeof file === 'string' && typeof digest === 'string') sheetInfo = { file, sha256: digest, width, height };
  }
  let rigInfo: SheetDescriptor['rig'] | null = null;
  if (!isRecord(rig)) problems.push(problem('E_SHEET_FORMAT', 'rig must be an object.', 'rig'));
  else {
    extraKeys(rig, ['rigId', 'contractVersion'], 'rig', problems);
    if (typeof rig.rigId !== 'string' || !idPattern.test(rig.rigId) || typeof rig.contractVersion !== 'string' || !semverPattern.test(rig.contractVersion)) {
      problems.push(problem('E_SHEET_FORMAT', 'rig needs a snake_case rigId and a contractVersion X.Y.Z.', 'rig'));
    } else rigInfo = { rigId: rig.rigId, contractVersion: rig.contractVersion };
  }
  let scaleInfo: SheetDescriptor['scale'];
  if (scale !== undefined) {
    if (!isRecord(scale) || typeof scale.sheetPxPerContractPx !== 'number' || !(scale.sheetPxPerContractPx >= 0.05 && scale.sheetPxPerContractPx <= 20)) {
      problems.push(problem('E_SHEET_FORMAT', 'scale.sheetPxPerContractPx must be a number from 0.05 to 20.', 'scale'));
    } else {
      extraKeys(scale, ['sheetPxPerContractPx'], 'scale', problems);
      scaleInfo = { sheetPxPerContractPx: scale.sheetPxPerContractPx };
    }
  }
  const parsedRegions: SheetRegion[] = [];
  if (!Array.isArray(regions) || regions.length === 0 || regions.length > maxRegions) {
    problems.push(problem('E_SHEET_FORMAT', `regions must be an array of 1 to ${maxRegions} regions.`, 'regions'));
  } else {
    regions.forEach((item, index) => {
      const region = regionOf(item, index, problems);
      if (region !== null) parsedRegions.push(region);
    });
  }
  const absent: string[] = [];
  if (!Array.isArray(absentSlots) || absentSlots.length > maxRegions) problems.push(problem('E_SHEET_FORMAT', 'absentSlots must be an array of slot ids.', 'absentSlots'));
  else {
    for (const item of absentSlots) {
      if (typeof item !== 'string' || !idPattern.test(item)) problems.push(problem('E_SHEET_FORMAT', `absentSlots has the bad slot id ${show(item)}.`, 'absentSlots'));
      else if (absent.includes(item)) problems.push(problem('E_SHEET_ABSENT', `The slot ${item} is in absentSlots twice.`, 'absentSlots'));
      else absent.push(item);
    }
  }

  // Rules that a JSON Schema cannot express: unique ids, boxes inside the canvas, no overlap of two boxes.
  const seen = new Set<string>();
  for (const region of parsedRegions) {
    if (seen.has(region.id)) problems.push(problem('E_SHEET_REGION_DUPLICATE', `The region id ${region.id} is used twice.`, region.id));
    seen.add(region.id);
    if (sheetInfo !== null && (region.box.x + region.box.w > sheetInfo.width || region.box.y + region.box.h > sheetInfo.height)) {
      problems.push(problem('E_SHEET_BOX_OUTSIDE', `The box of ${region.id} goes outside the ${sheetInfo.width}x${sheetInfo.height} canvas.`, region.id));
    }
  }
  for (let i = 0; i < parsedRegions.length; i += 1) {
    for (let j = i + 1; j < parsedRegions.length; j += 1) {
      const a = parsedRegions[i] as SheetRegion;
      const b = parsedRegions[j] as SheetRegion;
      if (a.box.x < b.box.x + b.box.w && b.box.x < a.box.x + a.box.w && a.box.y < b.box.y + b.box.h && b.box.y < a.box.y + a.box.h) {
        problems.push(problem('E_SHEET_BOX_OVERLAP', `The boxes of ${a.id} and ${b.id} overlap. Each sheet pixel must belong to at most one region.`, a.id));
      }
    }
  }
  if (problems.length > 0) throw new ControlError(problems);
  return {
    format: sheetFormat,
    sheet: sheetInfo as SheetDescriptor['sheet'],
    rig: rigInfo as SheetDescriptor['rig'],
    ...(scaleInfo === undefined ? {} : { scale: scaleInfo }),
    regions: parsedRegions,
    absentSlots: absent
  };
}

type ContractSlotRule = { readonly id: string; readonly bone: string; readonly required: boolean; readonly childBones: readonly string[] };

/** Reads the slot rules (required flag, overlap child bones) from the contract bytes. The control contract parser does not keep them. */
function contractSlotRules(contractBytes: Buffer): { rigId: string; contractVersion: string; slots: ContractSlotRule[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(contractBytes.toString('utf8'));
  } catch {
    fail('E_CONTRACT_FORMAT', 'The contract is not valid JSON.');
  }
  const contract = parseControlContract(raw);
  const slots: ContractSlotRule[] = [];
  for (const item of (raw as { slots: unknown[] }).slots) {
    const slot = item as Record<string, unknown>;
    const overlap = Array.isArray(slot.overlap) ? slot.overlap : [];
    const childBones = overlap
      .filter(isRecord)
      .map((entry) => entry.childBone)
      .filter((bone): bone is string => typeof bone === 'string');
    slots.push({ id: slot.id as string, bone: slot.bone as string, required: slot.required === true, childBones });
  }
  return { rigId: contract.rigId, contractVersion: contract.contractVersion, slots };
}

/**
 * Structural check plus the rig contract rules: the rig id and version, known slot ids, one region for each slot, every required slot mapped,
 * every optional slot either mapped or in absentSlots, joints only for the bones of the slot, and joints inside the region box.
 */
export function parseModularSheet(value: unknown, contractBytes: Buffer): SheetDescriptor {
  const descriptor = parseSheetDescriptor(value);
  const rules = contractSlotRules(contractBytes);
  const problems: Problem[] = [];
  if (descriptor.rig.rigId !== rules.rigId || descriptor.rig.contractVersion !== rules.contractVersion) {
    problems.push(
      problem('E_SHEET_RIG_MISMATCH', `The descriptor targets ${descriptor.rig.rigId} ${descriptor.rig.contractVersion}, but the contract is ${rules.rigId} ${rules.contractVersion}.`, 'rig')
    );
  }
  const bySlot = new Map(rules.slots.map((slot) => [slot.id, slot]));
  const mapped = new Map<string, string>();
  for (const region of descriptor.regions) {
    if (region.role !== 'part' || region.slot === undefined) continue;
    const rule = bySlot.get(region.slot);
    if (rule === undefined) {
      problems.push(problem('E_SHEET_SLOT_UNKNOWN', `${region.id} maps to ${region.slot}, which is not a slot of the contract.`, region.id));
      continue;
    }
    const earlier = mapped.get(region.slot);
    if (earlier !== undefined) problems.push(problem('E_SHEET_SLOT_DUPLICATE', `The slot ${region.slot} has two regions: ${earlier} and ${region.id}.`, region.id));
    mapped.set(region.slot, region.id);
    for (const [bone, point] of Object.entries(region.joints ?? {})) {
      if (bone !== rule.bone && !rule.childBones.includes(bone)) {
        problems.push(
          problem('E_SHEET_JOINT', `${region.id}: the bone ${bone} is not the slot bone ${rule.bone} or one of its overlap child bones (${rule.childBones.join(', ') || 'none'}).`, region.id)
        );
      }
      const { x, y, w, h } = region.box;
      if (point.x < x || point.y < y || point.x > x + w || point.y > y + h) problems.push(problem('E_SHEET_JOINT', `${region.id}: the joint ${bone} is outside the region box.`, region.id));
    }
  }
  for (const slot of descriptor.absentSlots) {
    const rule = bySlot.get(slot);
    if (rule === undefined) problems.push(problem('E_SHEET_ABSENT', `absentSlots names ${slot}, which is not a slot of the contract.`, slot));
    else if (rule.required) problems.push(problem('E_SHEET_ABSENT', `The slot ${slot} is required. It cannot be absent.`, slot));
    else if (mapped.has(slot)) problems.push(problem('E_SHEET_ABSENT', `The slot ${slot} is in absentSlots, but the region ${mapped.get(slot) ?? ''} maps to it.`, slot));
  }
  for (const rule of rules.slots) {
    if (mapped.has(rule.id) || descriptor.absentSlots.includes(rule.id)) continue;
    if (rule.required) problems.push(problem('E_SHEET_REQUIRED_MISSING', `The required slot ${rule.id} has no part region.`, rule.id));
    else problems.push(problem('E_SHEET_SLOT_UNDECLARED', `The optional slot ${rule.id} has no part region and is not in absentSlots.`, rule.id));
  }
  if (problems.length > 0) throw new ControlError(problems);
  return descriptor;
}

export type SheetCheck = { readonly id: string; readonly status: 'PASS' | 'FAIL'; readonly detail: string };
export type RegionMeasure = {
  readonly id: string;
  readonly role: RegionRole;
  readonly slot: string | null;
  readonly foregroundPixels: number;
  readonly weakAlphaPixels: number;
  /** Tight bounds of the foreground pixels in sheet pixels, or null for an empty region. */
  readonly bounds: SheetBox | null;
  /** 8-connected foreground components. More than one is permitted (for example hair strands) and is reported only. */
  readonly components: number;
};

function measureRegion(raster: Raster, region: SheetRegion): RegionMeasure {
  const { x: bx, y: by, w, h } = region.box;
  const mask = new Uint8Array(w * h);
  let foreground = 0;
  let weak = 0;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const alpha = raster.data[((by + y) * raster.width + bx + x) * 4 + 3] ?? 0;
      if (alpha >= foregroundAlpha) {
        mask[y * w + x] = 1;
        foreground += 1;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      } else if (alpha > 0) weak += 1;
    }
  }
  let components = 0;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1) continue;
    components += 1;
    mask[start] = 2;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop() as number;
      const px = p % w;
      const py = Math.floor(p / w);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (mask[q] === 1) {
            mask[q] = 2;
            stack.push(q);
          }
        }
      }
    }
  }
  const bounds = foreground === 0 ? null : { x: bx + left, y: by + top, w: right - left + 1, h: bottom - top + 1 };
  return { id: region.id, role: region.role, slot: region.slot ?? null, foregroundPixels: foreground, weakAlphaPixels: weak, bounds, components };
}

export type SheetImageReport = {
  readonly format: typeof sheetCheckFormat;
  readonly status: 'PASS' | 'FAIL';
  readonly sheet: { readonly sha256: string; readonly pixelSha256: string | null; readonly width: number; readonly height: number; readonly colorType: string | null };
  readonly checks: readonly SheetCheck[];
  readonly regions: readonly RegionMeasure[];
  readonly outside: { readonly foregroundPixels: number; readonly weakAlphaPixels: number };
};

/**
 * Checks a sheet PNG against a validated descriptor. Pixel rules only: file hash, size, alpha channel, a non-empty part in each part region,
 * and no foreground pixel outside all region boxes. It cannot check semantic rules (correct slot, view, near/far side, hidden content).
 */
export function checkSheetImage(descriptor: SheetDescriptor, pngBytes: Buffer): SheetImageReport {
  const checks: SheetCheck[] = [];
  const add = (id: string, pass: boolean, detail: string): void => {
    checks.push({ id, status: pass ? 'PASS' : 'FAIL', detail });
  };
  const digest = sha256(pngBytes);
  add(
    'P1_sha256',
    digest === descriptor.sheet.sha256,
    digest === descriptor.sheet.sha256 ? 'The file SHA-256 matches the descriptor.' : `The file SHA-256 is ${digest}, not ${descriptor.sheet.sha256}.`
  );
  const decoded = decodePng(pngBytes, sheetPngLimits);
  const raster = decoded.raster;
  const sizeOk = raster.width === descriptor.sheet.width && raster.height === descriptor.sheet.height;
  add('P2_size', sizeOk, `The image is ${raster.width}x${raster.height}. The descriptor says ${descriptor.sheet.width}x${descriptor.sheet.height}.`);
  add(
    'P3_alpha_channel',
    decoded.colorType === 'rgba',
    decoded.colorType === 'rgba' ? 'The PNG has an alpha channel.' : 'The PNG has no alpha channel. Remove the background in a recorded preprocessing step first.'
  );
  if (!sizeOk) {
    return {
      format: sheetCheckFormat,
      status: 'FAIL',
      sheet: { sha256: digest, pixelSha256: null, width: raster.width, height: raster.height, colorType: decoded.colorType },
      checks,
      regions: [],
      outside: { foregroundPixels: 0, weakAlphaPixels: 0 }
    };
  }
  const regions = descriptor.regions.map((region) => measureRegion(raster, region));
  const empty = regions.filter((item) => item.role === 'part' && item.foregroundPixels < minPartPixels).map((item) => item.id);
  add(
    'P4_parts_not_empty',
    empty.length === 0,
    empty.length === 0 ? `Each part region has at least ${minPartPixels} foreground pixels (alpha >= ${foregroundAlpha}).` : `Part regions with too few foreground pixels: ${empty.join(', ')}.`
  );
  const owner = new Uint8Array(raster.width * raster.height);
  for (const region of descriptor.regions) {
    for (let y = region.box.y; y < region.box.y + region.box.h; y += 1) owner.fill(1, y * raster.width + region.box.x, y * raster.width + region.box.x + region.box.w);
  }
  let outsideForeground = 0;
  let outsideWeak = 0;
  for (let p = 0; p < owner.length; p += 1) {
    if (owner[p] === 1) continue;
    const alpha = raster.data[p * 4 + 3] ?? 0;
    if (alpha >= foregroundAlpha) outsideForeground += 1;
    else if (alpha > 0) outsideWeak += 1;
  }
  add(
    'P5_no_content_outside_regions',
    outsideForeground === 0,
    outsideForeground === 0
      ? `No foreground pixel is outside the region boxes. Weak alpha pixels outside: ${outsideWeak} (ignored).`
      : `${outsideForeground} foreground pixels are outside all region boxes. Add a region (part, reference, or ignore) or clean the sheet.`
  );
  const status = checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL';
  return {
    format: sheetCheckFormat,
    status,
    sheet: { sha256: digest, pixelSha256: pixelHash(raster), width: raster.width, height: raster.height, colorType: decoded.colorType },
    checks,
    regions,
    outside: { foregroundPixels: outsideForeground, weakAlphaPixels: outsideWeak }
  };
}

// Synthetic test sheet (V2-1 fixture). It uses the T1a mock parts of the C0.5 candidate: flat colors, no art, no model.
export const syntheticSheet = { file: 'synthetic-sheet.png', width: 1600, margin: 32, gap: 32, previewScale: 4 } as const;

type PlacedPart = { readonly slot: string; readonly raster: Raster; readonly rectX: number; readonly rectY: number; readonly x: number; readonly y: number };

/** Makes the synthetic sheet, its descriptor, and the check report. Deterministic for the same contract and template code. */
export function syntheticSheetCommand(options: { readonly contractBytes: Buffer; readonly toolVersion: string }): {
  report: Record<string, unknown> & { status: 'PASS' | 'FAIL' };
  files: PlannedFile[];
} {
  const template = templateCommand({ contractBytes: options.contractBytes, toolVersion: options.toolVersion });
  const contract = parseControlContract(JSON.parse(options.contractBytes.toString('utf8')));
  const rules = contractSlotRules(options.contractBytes);
  const partFile = (slot: string): Buffer | undefined => template.files.find((file) => file.name === `mock-package/parts/${slot}.png`)?.bytes;
  const present = rules.slots.filter((slot) => slot.required);
  const absent = rules.slots.filter((slot) => !slot.required).map((slot) => slot.id);

  // Shelf layout in contract draw order. The position on the sheet has no meaning for the rig.
  const placed: PlacedPart[] = [];
  let x = syntheticSheet.margin;
  let y = syntheticSheet.margin;
  let shelf = 0;
  const ordered = [...present].sort((a, b) => (contract.slots.get(a.id)?.drawOrder ?? 0) - (contract.slots.get(b.id)?.drawOrder ?? 0));
  for (const slot of ordered) {
    const bytes = partFile(slot.id);
    if (bytes === undefined) fail('E_TEMPLATE', `The T1a mock package has no part for the required slot ${slot.id}.`);
    const raster = decodePng(bytes).raster;
    if (x + raster.width + syntheticSheet.margin > syntheticSheet.width) {
      x = syntheticSheet.margin;
      y += shelf + syntheticSheet.gap;
      shelf = 0;
    }
    const rect = contract.slots.get(slot.id)?.attachmentRect as { x: number; y: number };
    placed.push({ slot: slot.id, raster, rectX: rect.x, rectY: rect.y, x, y });
    x += raster.width + syntheticSheet.gap;
    shelf = Math.max(shelf, raster.height);
  }
  y += shelf + syntheticSheet.gap;

  // Reference preview: the mock parts at their contract positions in draw order, reduced by previewScale (nearest pixel).
  const canvas = new Raster(contract.canvas.width, contract.canvas.height);
  for (const part of placed) {
    for (let py = 0; py < part.raster.height; py += 1) {
      for (let px = 0; px < part.raster.width; px += 1) canvas.blend(part.rectX + px, part.rectY + py, part.raster.pixel(px, py));
    }
  }
  const s = syntheticSheet.previewScale;
  const preview = new Raster(Math.floor(canvas.width / s), Math.floor(canvas.height / s));
  for (let py = 0; py < preview.height; py += 1) for (let px = 0; px < preview.width; px += 1) preview.data.set(canvas.pixel(px * s + 1, py * s + 1), (py * preview.width + px) * 4);
  const previewBox = { x: syntheticSheet.margin, y, w: preview.width, h: preview.height };
  const height = y + preview.height + syntheticSheet.margin;

  const sheet = new Raster(syntheticSheet.width, height);
  for (const part of placed)
    for (let py = 0; py < part.raster.height; py += 1)
      sheet.data.set(part.raster.data.subarray(py * part.raster.width * 4, (py + 1) * part.raster.width * 4), ((part.y + py) * sheet.width + part.x) * 4);
  for (let py = 0; py < preview.height; py += 1) sheet.data.set(preview.data.subarray(py * preview.width * 4, (py + 1) * preview.width * 4), ((previewBox.y + py) * sheet.width + previewBox.x) * 4);
  const png = encodePng(sheet);

  const regions: SheetRegion[] = placed.map((part) => {
    const rule = rules.slots.find((item) => item.id === part.slot) as ContractSlotRule;
    const joints: Record<string, SheetPoint> = {};
    for (const bone of [rule.bone, ...rule.childBones]) {
      const joint = contract.bones.get(bone)?.joint;
      if (joint === undefined) continue;
      const jx = joint.x - part.rectX;
      const jy = joint.y - part.rectY;
      if (jx < 0 || jy < 0 || jx > part.raster.width || jy > part.raster.height) continue;
      joints[bone] = { x: part.x + jx, y: part.y + jy };
    }
    return {
      id: `part_${part.slot}`,
      role: 'part',
      box: { x: part.x, y: part.y, w: part.raster.width, h: part.raster.height },
      slot: part.slot,
      ...(Object.keys(joints).length > 0 ? { joints } : {}),
      origin: 'tool'
    };
  });
  regions.push({ id: 'reference_preview', role: 'reference', box: previewBox, origin: 'tool', note: 'Assembled preview of the mock parts at contract positions, scale 1/4. Never imported.' });
  const descriptor: SheetDescriptor = {
    format: sheetFormat,
    sheet: { file: syntheticSheet.file, sha256: sha256(png), width: sheet.width, height: sheet.height },
    rig: { rigId: rules.rigId, contractVersion: rules.contractVersion },
    scale: { sheetPxPerContractPx: 1 },
    regions,
    absentSlots: absent
  };
  const validated = parseModularSheet(JSON.parse(JSON.stringify(descriptor)), options.contractBytes);
  const check = checkSheetImage(validated, png);
  const report = {
    format: 'aigg.modular-sheet-fixture/0.1',
    status: check.status,
    tool: { name: '@aigg/control', version: options.toolVersion },
    contract: { rigId: rules.rigId, contractVersion: rules.contractVersion, sha256: sha256(options.contractBytes) },
    sheet: check.sheet,
    counts: { regions: regions.length, parts: placed.length, reference: 1, absentSlots: absent.length },
    checks: check.checks,
    note: 'Synthetic flat-color sheet from the T1a mock parts. It proves the contract and the checks, not that AI-generated sheets work.'
  };
  return {
    report,
    files: [
      { name: syntheticSheet.file, bytes: png },
      { name: 'synthetic-sheet.json', bytes: json(descriptor) },
      { name: 'synthetic-sheet.check.json', bytes: json(check) }
    ]
  };
}

/** `sheet-check`: validates a descriptor against the rig contract and checks the sheet PNG against the descriptor. Writes one JSON report. */
export function sheetCheckCommand(options: { readonly contractBytes: Buffer; readonly descriptorBytes: Buffer; readonly sheetBytes: Buffer }): {
  report: Record<string, unknown> & { status: 'PASS' | 'FAIL' };
  files: PlannedFile[];
} {
  let value: unknown;
  try {
    value = JSON.parse(options.descriptorBytes.toString('utf8'));
  } catch {
    fail('E_SHEET_FORMAT', 'The descriptor is not valid JSON.');
  }
  const descriptor = parseModularSheet(value, options.contractBytes);
  const check = checkSheetImage(descriptor, options.sheetBytes);
  const report = { ...check, contract: { rigId: descriptor.rig.rigId, contractVersion: descriptor.rig.contractVersion, sha256: sha256(options.contractBytes) } };
  return { report, files: [{ name: 'sheet-check.json', bytes: json(report) }] };
}
