import { type CommandResult, json } from '@control/commands';
import { checkSheetImage, contractSlotRules, foregroundAlpha, parseModularSheet, type SheetBox, type SheetDescriptor, sheetPngLimits, type SheetPoint } from '@control/modularsheet';
import type { PlannedFile } from '@control/output';
import { decodePng, encodePng, pixelHash, sha256 } from '@control/png';
import { fail } from '@control/problems';
import { Raster } from '@control/raster';

// Pipeline v2, step V2-2: deterministic extraction of the part regions of a validated modular sheet. See docs/PIPELINE_V2_MODULAR_SHEET.md.
// The descriptor is the only source of the slot mapping. The extraction copies the RGBA pixels of each part box without a change:
// no resampling, no alpha threshold, no color change, no geometric transform. It does not place parts on the skeleton (V2-3).

export const extractFormat = 'aigg.modular-sheet-extraction/0.1';
export const extractReportFormat = 'aigg.modular-sheet-extraction-report/0.1';
export const extractManifestName = 'extraction.json';
export const extractReportName = 'extraction-report.json';
export const partsDirectory = 'parts';

const slotFilePattern = /^[a-z][a-z0-9_]{0,63}$/;

export type AlphaCounts = { readonly transparent: number; readonly weak: number; readonly partial: number; readonly opaque: number };
export type JointRecord = { readonly bone: string; readonly sheet: SheetPoint; readonly local: SheetPoint };
export type ExtractedPart = {
  readonly slot: string;
  readonly bone: string;
  readonly regionId: string;
  readonly origin: string | null;
  readonly file: string;
  readonly sourceBox: SheetBox;
  readonly size: { readonly width: number; readonly height: number };
  readonly fileSha256: string;
  readonly pixelSha256: string;
  readonly alpha: AlphaCounts;
  readonly foregroundPixels: number;
  /** Tight bounds of the foreground (alpha >= 16) in part coordinates, or null. */
  readonly foregroundBounds: SheetBox | null;
  readonly components: number;
  readonly joints: { readonly status: 'supplied'; readonly points: readonly JointRecord[] } | { readonly status: 'absent' };
};

/** Copies the box of the sheet to a new raster. Bytes only: the RGBA values do not change. */
export function cropRaster(sheet: Raster, box: SheetBox): Raster {
  if (box.x < 0 || box.y < 0 || box.x + box.w > sheet.width || box.y + box.h > sheet.height) fail('E_EXTRACT_BOX', 'The box is outside the sheet.');
  const part = new Raster(box.w, box.h);
  for (let y = 0; y < box.h; y += 1) {
    const start = ((box.y + y) * sheet.width + box.x) * 4;
    part.data.set(sheet.data.subarray(start, start + box.w * 4), y * box.w * 4);
  }
  return part;
}

/** Joint position relative to the top-left corner of the box. A difference of a double and an integer below 2^52 is exact. */
export function localJoint(point: SheetPoint, box: SheetBox): SheetPoint {
  const local = { x: point.x - box.x, y: point.y - box.y };
  if (local.x + box.x !== point.x || local.y + box.y !== point.y) fail('E_EXTRACT_JOINT', 'The joint transform is not exact.');
  return local;
}

function alphaCounts(raster: Raster): AlphaCounts {
  let transparent = 0;
  let weak = 0;
  let partial = 0;
  let opaque = 0;
  for (let i = 3; i < raster.data.length; i += 4) {
    const alpha = raster.data[i] ?? 0;
    if (alpha === 0) transparent += 1;
    else if (alpha < foregroundAlpha) weak += 1;
    else if (alpha < 255) partial += 1;
    else opaque += 1;
  }
  return { transparent, weak, partial, opaque };
}

type RigInfo = { readonly rigId: string; readonly contractVersion: string; readonly contractSha256: string };
type Check = { readonly id: string; readonly status: 'PASS' | 'FAIL'; readonly detail: string };

export type SheetExtractOptions = { readonly contractBytes: Buffer; readonly descriptorBytes: Buffer; readonly sheetBytes: Buffer; readonly toolVersion: string };

/**
 * `sheet-extract`: validates the descriptor and the sheet (the `sheet-check` rules), then writes one PNG for each part region, the manifest,
 * the report, a summary, and SHA256SUMS. If a check fails, the result has no files. The caller publishes the files as one directory.
 */
export function sheetExtractCommand(options: SheetExtractOptions): CommandResult {
  let value: unknown;
  try {
    value = JSON.parse(options.descriptorBytes.toString('utf8'));
  } catch {
    fail('E_SHEET_FORMAT', 'The descriptor is not valid JSON.');
  }
  const descriptor: SheetDescriptor = parseModularSheet(value, options.contractBytes);
  const rules = contractSlotRules(options.contractBytes);
  const tool = { name: '@aigg/control', command: 'sheet-extract', version: options.toolVersion };
  const rig: RigInfo = { rigId: rules.rigId, contractVersion: rules.contractVersion, contractSha256: sha256(options.contractBytes) };
  const descriptorInfo = { format: descriptor.format, sha256: sha256(options.descriptorBytes) };

  // Stage 1: the V2-1 sheet check. A FAIL stops the extraction before any file is planned.
  const check = checkSheetImage(descriptor, options.sheetBytes);
  if (check.status !== 'PASS') {
    return {
      report: {
        format: extractReportFormat,
        status: 'FAIL',
        stage: 'sheet-check',
        tool,
        rig,
        descriptor: descriptorInfo,
        sheetCheck: check,
        note: 'The sheet does not pass sheet-check. Nothing is extracted. Fix the sheet or the descriptor; the extractor does not repair input.'
      },
      files: []
    };
  }

  // Stage 2: extraction. The PNG is decoded again; checkSheetImage does not return its raster.
  const decoded = decodePng(options.sheetBytes, sheetPngLimits);
  const sheet = decoded.raster;
  const measures = new Map(check.regions.map((region) => [region.id, region]));
  const regionBySlot = new Map(descriptor.regions.filter((region) => region.role === 'part' && region.slot !== undefined).map((region) => [region.slot as string, region]));
  const parts: ExtractedPart[] = [];
  const files: PlannedFile[] = [];
  const absent: { slot: string; bone: string; status: 'absent_by_design' }[] = [];
  const checks: Check[] = [];
  const roundTripErrors: string[] = [];
  const jointErrors: string[] = [];

  for (const rule of rules.slots) {
    const region = regionBySlot.get(rule.id);
    if (region === undefined) {
      if (!descriptor.absentSlots.includes(rule.id)) fail('E_EXTRACT_SLOT', `The slot ${rule.id} is neither mapped nor absent.`);
      absent.push({ slot: rule.id, bone: rule.bone, status: 'absent_by_design' });
      continue;
    }
    if (!slotFilePattern.test(rule.id)) fail('E_EXTRACT_SLOT', `The slot id ${rule.id} cannot be a file name.`);
    const raster = cropRaster(sheet, region.box);
    const bytes = encodePng(raster);
    const back = decodePng(bytes, sheetPngLimits).raster;
    if (back.width !== raster.width || back.height !== raster.height || !Buffer.from(back.data).equals(Buffer.from(raster.data))) roundTripErrors.push(rule.id);
    const file = `${partsDirectory}/${rule.id}.png`;
    files.push({ name: file, bytes });
    const measure = measures.get(region.id);
    const bounds = measure?.bounds ?? null;
    const points: JointRecord[] = [];
    for (const bone of Object.keys(region.joints ?? {}).sort()) {
      const point = region.joints?.[bone] as SheetPoint;
      try {
        points.push({ bone, sheet: point, local: localJoint(point, region.box) });
      } catch {
        jointErrors.push(`${rule.id}.${bone}`);
      }
    }
    parts.push({
      slot: rule.id,
      bone: rule.bone,
      regionId: region.id,
      origin: region.origin ?? null,
      file,
      sourceBox: region.box,
      size: { width: raster.width, height: raster.height },
      fileSha256: sha256(bytes),
      pixelSha256: pixelHash(raster),
      alpha: alphaCounts(raster),
      foregroundPixels: measure?.foregroundPixels ?? 0,
      foregroundBounds: bounds === null ? null : { x: bounds.x - region.box.x, y: bounds.y - region.box.y, w: bounds.w, h: bounds.h },
      components: measure?.components ?? 0,
      joints: region.joints === undefined ? { status: 'absent' } : { status: 'supplied', points }
    });
  }

  // Partition of the sheet: each pixel with alpha > 0 is in at most one region box. Foreground outside the boxes is 0 (sheet-check P5).
  const coverage = new Uint8Array(sheet.width * sheet.height);
  for (const region of descriptor.regions)
    for (let y = region.box.y; y < region.box.y + region.box.h; y += 1)
      for (let x = region.box.x; x < region.box.x + region.box.w; x += 1) coverage[y * sheet.width + x] = (coverage[y * sheet.width + x] ?? 0) + 1;
  let sheetForeground = 0;
  let partForeground = 0;
  let excludedForeground = 0;
  let doubleCovered = 0;
  let lostForeground = 0;
  const partBoxes = new Uint8Array(sheet.width * sheet.height);
  for (const part of parts)
    for (let y = part.sourceBox.y; y < part.sourceBox.y + part.sourceBox.h; y += 1) partBoxes.fill(1, y * sheet.width + part.sourceBox.x, y * sheet.width + part.sourceBox.x + part.sourceBox.w);
  for (let p = 0; p < coverage.length; p += 1) {
    if ((coverage[p] ?? 0) > 1) doubleCovered += 1;
    if ((sheet.data[p * 4 + 3] ?? 0) < foregroundAlpha) continue;
    sheetForeground += 1;
    if (partBoxes[p] === 1) partForeground += 1;
    else if (coverage[p] === 1) excludedForeground += 1;
    else lostForeground += 1;
  }
  const extractedForeground = parts.reduce((sum, part) => sum + part.alpha.partial + part.alpha.opaque, 0);
  const excluded = descriptor.regions
    .filter((region) => region.role !== 'part')
    .map((region) => ({
      regionId: region.id,
      role: region.role,
      sourceBox: region.box,
      foregroundPixels: measures.get(region.id)?.foregroundPixels ?? 0,
      weakAlphaPixels: measures.get(region.id)?.weakAlphaPixels ?? 0
    }));
  const add = (id: string, pass: boolean, detail: string): void => {
    checks.push({ id, status: pass ? 'PASS' : 'FAIL', detail });
  };
  const required = rules.slots.filter((slot) => slot.required);
  const missingRequired = required.filter((slot) => !parts.some((part) => part.slot === slot.id)).map((slot) => slot.id);
  add(
    'X1_required_extracted',
    missingRequired.length === 0,
    missingRequired.length === 0 ? `All ${required.length} required slots are extracted.` : `Required slots not extracted: ${missingRequired.join(', ')}.`
  );
  add(
    'X2_slots_accounted',
    parts.length + absent.length === rules.slots.length,
    `${parts.length} extracted + ${absent.length} absent by design = ${parts.length + absent.length} of ${rules.slots.length} contract slots.`
  );
  add(
    'X3_pixel_round_trip',
    roundTripErrors.length === 0,
    roundTripErrors.length === 0 ? 'Each part PNG decodes to the exact RGBA bytes of its source box.' : `Part PNG files that do not decode to the source pixels: ${roundTripErrors.join(', ')}.`
  );
  add(
    'X4_foreground_partition',
    doubleCovered === 0 && lostForeground === 0 && partForeground === extractedForeground && partForeground + excludedForeground === sheetForeground,
    `Sheet foreground ${sheetForeground} = parts ${partForeground} + reference and ignore regions ${excludedForeground}. Lost: ${lostForeground}. Pixels in two boxes: ${doubleCovered}.`
  );
  add(
    'X5_joint_transform',
    jointErrors.length === 0,
    jointErrors.length === 0 ? 'Each local joint plus the box origin gives the sheet joint exactly.' : `Joints with an inexact transform: ${jointErrors.join(', ')}.`
  );
  const status: 'PASS' | 'FAIL' = checks.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
  const weakTotal = parts.reduce((sum, part) => sum + part.alpha.weak, 0);

  const manifest = {
    format: extractFormat,
    tool,
    source: {
      sheet: {
        declaredFile: descriptor.sheet.file,
        sha256: check.sheet.sha256,
        pixelSha256: check.sheet.pixelSha256,
        width: sheet.width,
        height: sheet.height,
        colorType: decoded.colorType,
        ignoredChunks: decoded.ignoredChunks
      },
      descriptor: descriptorInfo
    },
    rig,
    pixelPolicy: {
      copy: 'exact',
      alpha: 'straight, preserved',
      foregroundAlpha,
      note: 'RGBA values are copied without a change. No resampling, alpha threshold, alpha normalization, unpremultiplication, color change, or background repair. Weak alpha (1 to 15) stays in the part and is counted.'
    },
    coordinates:
      'Sheet: pixels, Y down, origin at the top-left corner of the sheet. Local: origin at the top-left corner of the part box (local = sheet - box origin). Joints are continuous coordinates and can be on the box edge.',
    counts: { contractSlots: rules.slots.length, required: required.length, extracted: parts.length, absentByDesign: absent.length, excludedRegions: excluded.length },
    parts,
    absentSlots: absent,
    excludedRegions: excluded
  };
  const report = {
    format: extractReportFormat,
    status,
    stage: 'extraction',
    tool,
    rig,
    descriptor: descriptorInfo,
    sheet: manifest.source.sheet,
    checks,
    sheetCheck: check,
    partition: { sheetForeground, partForeground, excludedForeground, lostForeground, doubleCovered, outsideWeakAlphaPixels: check.outside.weakAlphaPixels },
    weakAlpha: { inParts: weakTotal, byPart: Object.fromEntries(parts.filter((part) => part.alpha.weak > 0).map((part) => [part.slot, part.alpha.weak])) },
    limitations: [
      'The slot of each part comes from the descriptor. The tool does not check that the art is the named slot, side, or view.',
      'No placement on the skeleton, no pivots, and no attachment offsets (V2-3).',
      'The output is an intermediate result, not a character package.'
    ]
  };
  if (status !== 'PASS') return { report, files: [] };
  files.push({ name: extractManifestName, bytes: json(manifest) });
  files.push({ name: extractReportName, bytes: json(report) });
  files.push({ name: 'SUMMARY.md', bytes: Buffer.from(summary(manifest, report), 'utf8') });
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const sums = files.map((file) => `${sha256(file.bytes)}  ${file.name}\n`).join('');
  files.push({ name: 'SHA256SUMS', bytes: Buffer.from(sums, 'utf8') });
  return {
    report: {
      ...report,
      sheetCheck: { status: check.status, checks: check.checks },
      counts: manifest.counts,
      files: files.map((file) => ({ name: file.name, sha256: sha256(file.bytes) }))
    },
    files
  };
}

function summary(
  manifest: { counts: Record<string, number>; parts: readonly ExtractedPart[]; absentSlots: readonly { slot: string }[]; excludedRegions: readonly { regionId: string; role: string }[]; rig: RigInfo },
  report: { status: string; checks: readonly Check[]; weakAlpha: { inParts: number } }
): string {
  const lines = [
    '# Modular sheet extraction (V2-2)',
    '',
    `Status: ${report.status}. Target: ${manifest.rig.rigId} ${manifest.rig.contractVersion}.`,
    `Parts: ${manifest.counts.extracted ?? 0}. Absent by design: ${manifest.counts.absentByDesign ?? 0}. Excluded regions: ${manifest.counts.excludedRegions ?? 0}. Weak alpha pixels in parts (kept): ${report.weakAlpha.inParts}.`,
    '',
    '| Slot | File | Source box (x, y, w, h) | Joints |',
    '| ---- | ---- | ----------------------- | ------ |',
    ...manifest.parts.map(
      (part) =>
        `| ${part.slot} | ${part.file} | ${part.sourceBox.x}, ${part.sourceBox.y}, ${part.sourceBox.w}, ${part.sourceBox.h} | ${part.joints.status === 'supplied' ? part.joints.points.map((point) => point.bone).join(', ') : 'absent'} |`
    ),
    '',
    `Absent by design: ${manifest.absentSlots.map((item) => item.slot).join(', ') || 'none'}.`,
    `Excluded (never parts): ${manifest.excludedRegions.map((item) => `${item.regionId} (${item.role})`).join(', ') || 'none'}.`,
    '',
    '## Checks',
    '',
    ...report.checks.map((item) => `- ${item.id}: ${item.status}. ${item.detail}`),
    '',
    'The slot mapping comes from the descriptor. A human checks that the art is the named slot. This is an intermediate result, not a character package.',
    ''
  ];
  return lines.join('\n');
}
