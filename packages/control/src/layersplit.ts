import { type CommandResult, type CommandStatus, type FileRecord, json, record, sheetOf, toolName } from '@control/commands';
import { drawText } from '@control/glyphs';
import type { PlannedFile } from '@control/output';
import { decodePng, encodePng, pixelHash, type PngLimits, sha256 } from '@control/png';
import { fail, isRecord, show } from '@control/problems';
import { type Color, Raster } from '@control/raster';
import {
  alphaMask,
  type Bounds,
  checkConservation,
  contactLabel,
  defaultSplitOptions,
  extractLabel,
  isolatedLabel,
  labelComponents,
  maskBounds,
  mergedLabel,
  splitLayer,
  type SplitResult,
  unsplitLabel
} from '@control/split';

// `split-layers` (experiment L0-1b, prototype): analyze See-through semantic layers and try to split limb layers into independent parts.
// Inputs: the per-layer PNG files of one See-through run (full canvas, 8-bit RGBA) and its `<stem>.psd.json` metadata.
// The command reads the inputs only. It does not change them. All results are diagnostic. They are not a Spine-ready package.

export const splitFormat = 'aigg.l0-1b.split-layers/0.1';
export const maxMetadataBytes = 256 * 1024;
export const layerPngLimits: PngLimits = { maxBytes: 32 * 1024 * 1024, maxWidth: 2048, maxHeight: 2048, maxPixels: 2048 * 2048 };

/** Layers that are analyzed (task A). */
export const analyzedLayers = ['handwear', 'legwear', 'footwear', 'topwear', 'bottomwear'] as const;

/** Layers that the prototype tries to split (task B), with the expected anatomical parts and the trial motion angle (degrees). */
export const splitTargets = [
  { layer: 'handwear', parts: 'arm', scanRows: false, angle: 20 },
  { layer: 'legwear', parts: 'leg', scanRows: true, angle: 12 },
  { layer: 'footwear', parts: 'foot', scanRows: false, angle: 15 }
] as const;

type LayerMeta = { readonly tag: string; readonly xyxy: readonly [number, number, number, number]; readonly partId: number; readonly depthMedian: number };
export type SeeThroughMetadata = { readonly frame: { readonly width: number; readonly height: number }; readonly layers: readonly LayerMeta[] };

const tagPattern = /^[a-z][a-z ]{0,31}$/;

/** Parses the See-through `<stem>.psd.json` file: `{ parts: { <tag>: { xyxy, tag, part_id, depth_median } }, frame_size: [w, h] }`. */
export function parseSeeThroughMetadata(bytes: Buffer): SeeThroughMetadata {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('E_METADATA', 'The See-through metadata is not valid JSON.');
  }
  if (!isRecord(value) || !isRecord(value.parts) || !Array.isArray(value.frame_size)) fail('E_METADATA', 'The See-through metadata must have "parts" and "frame_size".');
  const [width, height] = value.frame_size as unknown[];
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) < 1 || (height as number) < 1 || (width as number) > 2048 || (height as number) > 2048) {
    fail('E_METADATA', 'frame_size must be two integers from 1 to 2048.');
  }
  const layers: LayerMeta[] = [];
  for (const [key, part] of Object.entries(value.parts)) {
    if (!tagPattern.test(key)) fail('E_METADATA', `The layer tag ${show(key)} is not supported. Use lowercase letters and spaces.`);
    if (!isRecord(part) || part.tag !== key) fail('E_METADATA', `The part ${show(key)} must have the same "tag".`);
    const xyxy = part.xyxy;
    if (!Array.isArray(xyxy) || xyxy.length !== 4 || !xyxy.every((item) => Number.isSafeInteger(item) && item >= 0 && item <= 4096)) fail('E_METADATA', `The part ${show(key)} has no valid "xyxy".`);
    if (!Number.isSafeInteger(part.part_id) || typeof part.depth_median !== 'number' || !Number.isFinite(part.depth_median))
      fail('E_METADATA', `The part ${show(key)} needs "part_id" and "depth_median".`);
    layers.push({ tag: key, xyxy: xyxy as unknown as LayerMeta['xyxy'], partId: part.part_id as number, depthMedian: part.depth_median });
  }
  if (layers.length === 0) fail('E_METADATA', 'The See-through metadata has no part.');
  return { frame: { width: width as number, height: height as number }, layers };
}

/**
 * Draw order from the metadata: back to front by `depth_median` from far (high) to near (low), then by part_id.
 * Assumption: See-through writes the PSD layers in this order. The L0-1 PSD structure agrees for the 18 layers of the run.
 */
export function drawOrder(metadata: SeeThroughMetadata): string[] {
  return [...metadata.layers].sort((a, b) => b.depthMedian - a.depthMedian || a.partId - b.partId).map((item) => item.tag);
}

export type SplitLayersOptions = {
  readonly metadataBytes: Buffer;
  /** PNG bytes for each tag that has a file. */
  readonly layerFiles: ReadonlyMap<string, { readonly name: string; readonly bytes: Buffer }>;
  readonly metadataName: string;
  readonly toolVersion: string;
};

type Layer = { readonly tag: string; readonly raster: Raster; readonly file: { readonly name: string; readonly sha256: string; readonly pixelSha256: string } };

const boundsArray = (bounds: Bounds | null): number[] | null => (bounds ? [bounds.left, bounds.top, bounds.right, bounds.bottom] : null);
const round = (value: number, digits = 4): number => Number(value.toFixed(digits));

function alphaStats(raster: Raster): { area: number; opaque: number; partial: number; alphaSum: number; transparentColorPixels: number } {
  let area = 0;
  let opaque = 0;
  let alphaSum = 0;
  let transparentColorPixels = 0;
  for (let p = 0; p < raster.width * raster.height; p += 1) {
    const alpha = raster.data[p * 4 + 3] ?? 0;
    alphaSum += alpha;
    if (alpha > 0) area += 1;
    if (alpha === 255) opaque += 1;
    if (alpha === 0 && ((raster.data[p * 4] ?? 0) | (raster.data[p * 4 + 1] ?? 0) | (raster.data[p * 4 + 2] ?? 0)) !== 0) transparentColorPixels += 1;
  }
  return { area, opaque, partial: area - opaque, alphaSum, transparentColorPixels };
}

function outsideXyxy(mask: Uint8Array, width: number, xyxy: readonly number[]): number {
  const [left, top, right, bottom] = xyxy as [number, number, number, number];
  let count = 0;
  for (let p = 0; p < mask.length; p += 1) {
    if (mask[p] === 0) continue;
    const x = p % width;
    const y = (p - x) / width;
    if (x < left || x >= right || y < top || y >= bottom) count += 1;
  }
  return count;
}

/** Source-over composite of layers in order onto a transparent canvas. */
export function composite(width: number, height: number, layers: readonly Raster[]): Raster {
  const out = new Raster(width, height);
  for (const layer of layers) {
    for (let p = 0; p < width * height; p += 1) {
      const a = layer.data[p * 4 + 3] ?? 0;
      if (a === 0) continue;
      const x = p % width;
      out.blend(x, (p - x) / width, [layer.data[p * 4] ?? 0, layer.data[p * 4 + 1] ?? 0, layer.data[p * 4 + 2] ?? 0, a]);
    }
  }
  return out;
}

/** Pixels of a mask where the composite of the given upper layers is fully opaque: painted by See-through but not visible in the reference pose. */
function hiddenPixels(mask: Uint8Array, above: Raster): number {
  let count = 0;
  for (let p = 0; p < mask.length; p += 1) if (mask[p] === 1 && (above.data[p * 4 + 3] ?? 0) === 255) count += 1;
  return count;
}

/** Pivot hypothesis H1: the centroid of the part pixels in the top 20 rows of the part. It is not a rig pivot. */
function pivotHypothesis(mask: Uint8Array, width: number, bounds: Bounds): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (let y = bounds.top; y < Math.min(bounds.bottom, bounds.top + 20); y += 1) {
    for (let x = bounds.left; x < bounds.right; x += 1) {
      if (mask[y * width + x] === 0) continue;
      sx += x + 0.5;
      sy += y + 0.5;
      count += 1;
    }
  }
  return { x: round(sx / count, 1), y: round(sy / count, 1) };
}

/** Rotates a raster about a pivot by nearest-neighbor inverse mapping. Diagnostic only: the pixels are resampled. */
function rotate(source: Raster, pivot: { x: number; y: number }, degrees: number): Raster {
  const out = new Raster(source.width, source.height);
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const dx = x + 0.5 - pivot.x;
      const dy = y + 0.5 - pivot.y;
      const sx = Math.floor(pivot.x + dx * cos + dy * sin);
      const sy = Math.floor(pivot.y - dx * sin + dy * cos);
      if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
      const i = (sy * source.width + sx) * 4;
      if ((source.data[i + 3] ?? 0) === 0) continue;
      out.data.set(source.data.subarray(i, i + 4), (y * source.width + x) * 4);
    }
  }
  return out;
}

type MotionCounts = { readonly holePixels: number; readonly revealedPixels: number; readonly newOverlapPixels: number; readonly jointGapPixels: number };

const holeColor: Color = [230, 0, 0, 255];
const revealColor: Color = [245, 200, 0, 255];
const overlapColor: Color = [0, 90, 230, 255];
const jointColor: Color = [220, 0, 220, 255];
const residualColor: Color = [255, 120, 0, 255];

/**
 * Compares the reference composite with the composite after the trial motion of the moved parts.
 * hole: a pixel that the part left, with nothing behind it. revealed: a pixel that the part left, where a lower layer now shows.
 * new overlap: a pixel that the moved part now covers over another visible layer. joint gap: a hole or revealed pixel near a pivot.
 */
function motionMap(before: Raster, after: Raster, movedBefore: Uint8Array, movedAfter: Uint8Array, pivots: readonly { x: number; y: number }[], radius: number): { map: Raster; counts: MotionCounts } {
  const { width, height } = before;
  const map = new Raster(width, height);
  let holePixels = 0;
  let revealedPixels = 0;
  let newOverlapPixels = 0;
  let jointGapPixels = 0;
  for (let p = 0; p < width * height; p += 1) {
    const x = p % width;
    const y = (p - x) / width;
    const near = pivots.some((pivot) => Math.hypot(x + 0.5 - pivot.x, y + 0.5 - pivot.y) <= radius);
    if (movedBefore[p] === 1 && movedAfter[p] === 0) {
      const hole = (after.data[p * 4 + 3] ?? 0) === 0;
      if (hole) holePixels += 1;
      else revealedPixels += 1;
      if (near) jointGapPixels += 1;
      map.data.set(near ? jointColor : hole ? holeColor : revealColor, p * 4);
    } else if (movedAfter[p] === 1 && movedBefore[p] === 0 && (before.data[p * 4 + 3] ?? 0) > 0) {
      newOverlapPixels += 1;
      map.data.set(overlapColor, p * 4);
    }
  }
  return { map, counts: { holePixels, revealedPixels, newOverlapPixels, jointGapPixels } };
}

// Review images: half size, checkerboard for transparency, labels.

export function checker(width: number, height: number): Raster {
  const out = new Raster(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const light = ((x >> 3) + (y >> 3)) % 2 === 0;
      out.data.set(light ? [235, 235, 235, 255] : [205, 205, 205, 255], (y * width + x) * 4);
    }
  }
  return out;
}

export function half(source: Raster): Raster {
  const out = new Raster(Math.ceil(source.width / 2), Math.ceil(source.height / 2));
  for (let y = 0; y < out.height; y += 1) {
    for (let x = 0; x < out.width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1]
      ] as const) {
        const [pr, pg, pb, pa] = source.pixel(2 * x + dx, 2 * y + dy);
        r += pr * pa;
        g += pg * pa;
        b += pb * pa;
        a += pa;
      }
      if (a > 0) out.data.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / 4)], (y * out.width + x) * 4);
    }
  }
  return out;
}

export function panel(content: Raster, title: string, lines: readonly string[] = [], background?: Raster): Raster {
  const small = half(content);
  const out = background ? half(background) : checker(small.width, small.height);
  if (background) out.draw(checker(small.width, small.height), 0, 0, 0.35);
  out.draw(small, 0, 0);
  drawText(out, title, 6, 6, 2, [0, 0, 0, 255], [255, 255, 255, 230]);
  lines.forEach((line, index) => {
    drawText(out, line, 6, 26 + index * 12, 1, [0, 0, 0, 255], [255, 255, 255, 230]);
  });
  return out;
}

const partColors: readonly Color[] = [
  [30, 110, 230, 255],
  [230, 120, 20, 255],
  [40, 170, 70, 255],
  [170, 40, 170, 255]
];

function componentMap(raster: Raster, layerArea: number): Raster {
  const mask = alphaMask(raster, 1);
  const { labels, components } = labelComponents(mask, raster.width, raster.height);
  const majorIds = components.filter((item) => item.area >= 0.02 * layerArea).map((item) => item.id);
  const out = new Raster(raster.width, raster.height);
  for (let p = 0; p < mask.length; p += 1) {
    const id = labels[p] as number;
    if (id === 0) continue;
    const major = majorIds.indexOf(id);
    out.data.set(major >= 0 ? (partColors[major % partColors.length] as Color) : [0, 0, 0, 255], p * 4);
  }
  return out;
}

function assignmentMap(result: SplitResult, width: number, height: number): Raster {
  const out = new Raster(width, height);
  for (let p = 0; p < result.assignment.length; p += 1) {
    const label = result.assignment[p] as number;
    if (label === 0) continue;
    const color: Color =
      label <= 250
        ? (partColors[(label - 1) % partColors.length] as Color)
        : label === mergedLabel
          ? residualColor
          : label === contactLabel
            ? holeColor
            : label === unsplitLabel
              ? [120, 120, 120, 255]
              : [0, 0, 0, 255];
    out.data.set(color, p * 4);
  }
  return out;
}

function outline(target: Raster, xyxy: readonly number[], color: Color): void {
  const [left, top, right, bottom] = xyxy as [number, number, number, number];
  target.strokeRect(left, top, right - left, bottom - top, 2, color);
}

const residualKinds = [
  { label: mergedLabel, kind: 'merged', meaning: 'A region that touches two parts. The parts overlap or are joined there.' },
  { label: contactLabel, kind: 'contact', meaning: 'Pixels at almost equal path distance from two parts.' },
  { label: isolatedLabel, kind: 'isolated', meaning: 'Fragments that are not connected to a part and are not near exactly one part.' },
  { label: unsplitLabel, kind: 'unsplit', meaning: 'The layer was not split. All pixels stay together.' }
] as const;

function confidence(result: SplitResult): 'high' | 'medium' | 'low' | 'none' {
  if (result.status !== 'split') return 'none';
  const residual = (result.contactPixels + result.isolatedPixels + result.mergedPixels) / result.layerArea;
  if (result.method === 'components' && residual <= 0.005) return 'high';
  if (residual <= 0.05 && result.method !== 'scan_rows') return 'medium';
  if (result.method === 'scan_rows' && residual <= 0.4) return 'medium';
  return 'low';
}

/** `split-layers`: task A (mask analysis), B (split), C (metadata), D (diagnostic images), and E (measurements) of experiment L0-1b. */
export function splitLayersCommand(options: SplitLayersOptions): CommandResult {
  const metadata = parseSeeThroughMetadata(options.metadataBytes);
  const { width, height } = metadata.frame;
  const order = drawOrder(metadata);
  const layers = new Map<string, Layer>();
  const missingFiles: string[] = [];
  for (const tag of order) {
    const file = options.layerFiles.get(tag);
    if (!file) {
      missingFiles.push(tag);
      continue;
    }
    const decoded = decodePng(file.bytes, layerPngLimits);
    if (decoded.colorType !== 'rgba') fail('E_LAYER', `The layer ${show(tag)} has no alpha channel.`);
    if (decoded.raster.width !== width || decoded.raster.height !== height)
      fail('E_LAYER', `The layer ${show(tag)} is ${decoded.raster.width}x${decoded.raster.height}. The frame is ${width}x${height}.`);
    layers.set(tag, { tag, raster: decoded.raster, file: { name: file.name, sha256: sha256(file.bytes), pixelSha256: pixelHash(decoded.raster) } });
  }
  for (const tag of analyzedLayers) if (!layers.has(tag)) fail('E_LAYER', `The layer ${show(tag)} is required. Its PNG file or metadata entry is missing.`);
  const ordered = order.filter((tag) => layers.has(tag)).map((tag) => layers.get(tag) as Layer);
  const files: PlannedFile[] = [];
  const records: FileRecord[] = [];
  const png = (name: string, raster: Raster): FileRecord => {
    const file = { name, bytes: encodePng(raster) };
    files.push(file);
    const item = record(file, raster);
    records.push(item);
    return item;
  };
  const metaOf = new Map(metadata.layers.map((item) => [item.tag, item]));
  const masks = new Map(ordered.map((layer) => [layer.tag, alphaMask(layer.raster, 1)]));
  const aboveOf = (tag: string): Raster => {
    const index = ordered.findIndex((layer) => layer.tag === tag);
    return composite(
      width,
      height,
      ordered.slice(index + 1).map((layer) => layer.raster)
    );
  };

  // Task A: mask analysis.
  const analysis = analyzedLayers.map((tag) => {
    const layer = layers.get(tag) as Layer;
    const mask = masks.get(tag) as Uint8Array;
    const stats = alphaStats(layer.raster);
    const xyxy = (metaOf.get(tag) as LayerMeta).xyxy;
    const bounds = maskBounds(mask, width);
    const levels = [1, 32, 128, 250].map((threshold) => {
      const { components } = labelComponents(alphaMask(layer.raster, threshold), width, height, layer.raster);
      const major = components.filter((item) => item.area >= 0.02 * stats.area);
      return {
        alphaThreshold: threshold,
        components: components.length,
        majorComponents: major.map((item) => ({ area: item.area, alphaSum: item.alphaSum, xyxy: boundsArray(item.bounds), centroid: { x: round(item.centroid.x, 1), y: round(item.centroid.y, 1) } })),
        minorPixels: components.filter((item) => item.area < 0.02 * stats.area).reduce((sum, item) => sum + item.area, 0)
      };
    });
    const overlaps = ordered
      .filter((other) => other.tag !== tag)
      .map((other) => {
        const otherMask = masks.get(other.tag) as Uint8Array;
        let shared = 0;
        for (let p = 0; p < mask.length; p += 1) if (mask[p] === 1 && otherMask[p] === 1) shared += 1;
        return { layer: other.tag, sharedPixels: shared, otherIsAbove: order.indexOf(other.tag) > order.indexOf(tag) };
      })
      .filter((item) => item.sharedPixels > 0)
      .sort((a, b) => b.sharedPixels - a.sharedPixels);
    const map = componentMap(layer.raster, stats.area);
    outline(map, xyxy, [220, 0, 0, 255]);
    if (bounds) outline(map, boundsArray(bounds) as number[], [0, 160, 0, 255]);
    const mapRecord = png(`analysis/${tag}.components.png`, map);
    return {
      layer: tag,
      source: layer.file,
      alpha: stats,
      metadataXyxy: xyxy,
      alphaXyxy: boundsArray(bounds),
      xyxyDelta: bounds ? [bounds.left - xyxy[0], bounds.top - xyxy[1], bounds.right - xyxy[2], bounds.bottom - xyxy[3]] : null,
      pixelsOutsideMetadataXyxy: outsideXyxy(mask, width, xyxy),
      hiddenByUpperLayers: hiddenPixels(mask, aboveOf(tag)),
      componentLevels: levels,
      overlaps,
      componentMap: mapRecord.name
    };
  });

  // Task B and C: split and metadata.
  const replaced = new Map<string, Raster[]>();
  const splits = splitTargets.map((target) => {
    const layer = layers.get(target.layer) as Layer;
    const result = splitLayer(layer.raster, { ...defaultSplitOptions, scanRows: target.scanRows });
    const outputs: Raster[] = [];
    const above = aboveOf(target.layer);
    const parts = result.parts.map((part) => {
      const raster = extractLabel(layer.raster, result.assignment, part.label);
      outputs.push(raster);
      const mask = alphaMask(raster, 1);
      const bounds = maskBounds(mask, width) as Bounds;
      const side = part.label === 1 ? 'image_left' : 'image_right';
      const name = `${target.parts}_${side}`;
      const stats = alphaStats(raster);
      const fileRecord = png(`parts/${target.layer}.${name}.png`, raster);
      return {
        part: name,
        imageSide: side,
        file: fileRecord,
        sourceLayer: target.layer,
        sourceFile: layer.file,
        canvas: { width, height },
        alphaXyxy: boundsArray(bounds),
        area: stats.area,
        alphaSum: stats.alphaSum,
        opaquePixels: stats.opaque,
        seedArea: part.seedArea,
        attachedFragmentPixels: part.attachedFragmentPixels,
        hiddenByUpperLayers: hiddenPixels(mask, above),
        pivotHypothesis: { ...pivotHypothesis(mask, width, bounds), rule: 'H1: centroid of the part pixels in the top 20 rows of the part. Not a rig pivot.' },
        raster
      };
    });
    const residual = residualKinds
      .map((kind) => {
        const raster = extractLabel(layer.raster, result.assignment, kind.label);
        const stats = alphaStats(raster);
        if (stats.area === 0) return null;
        outputs.push(raster);
        const mask = alphaMask(raster, 1);
        const fileRecord = png(`residual/${target.layer}.${kind.kind}.png`, raster);
        return {
          kind: kind.kind,
          meaning: kind.meaning,
          file: fileRecord,
          alphaXyxy: boundsArray(maskBounds(mask, width)),
          area: stats.area,
          alphaSum: stats.alphaSum,
          hiddenByUpperLayers: hiddenPixels(mask, above)
        };
      })
      .filter((item) => item !== null);
    replaced.set(target.layer, outputs);
    const conservation = checkConservation(layer.raster, outputs);
    const map = assignmentMap(result, width, height);
    const mapRecord = png(`analysis/${target.layer}.assignment.png`, map);
    return { target, result, parts, residual, conservation, assignmentMap: mapRecord.name, confidence: confidence(result) };
  });

  // Task D: compositions and trial motion.
  const original = composite(
    width,
    height,
    ordered.map((layer) => layer.raster)
  );
  const fromParts = composite(
    width,
    height,
    ordered.flatMap((layer) => replaced.get(layer.tag) ?? [layer.raster])
  );
  const recomposeEqual = pixelHash(original) === pixelHash(fromParts);
  png('compose/reference-pose.png', original);
  png('compose/reference-pose-from-parts.png', fromParts);
  const motionPanels: Raster[] = [];
  const mapPanels: Raster[] = [];
  const motion = splits.map((split) => {
    if (split.result.status !== 'split') return { layer: split.target.layer, status: 'not_run', reason: 'The layer was not split.' };
    const angle = split.target.angle;
    const moved = split.parts.map((part, index) => ({ part, degrees: index === 0 ? angle : -angle }));
    const rotated = moved.map((item) => rotate(item.part.raster, item.part.pivotHypothesis, item.degrees));
    const residuals = (replaced.get(split.target.layer) ?? []).slice(split.parts.length);
    const after = composite(
      width,
      height,
      ordered.flatMap((layer) => (layer.tag === split.target.layer ? [...rotated, ...residuals] : [layer.raster]))
    );
    const before = alphaMask(
      composite(
        width,
        height,
        split.parts.map((part) => part.raster)
      ),
      1
    );
    const movedAfter = alphaMask(composite(width, height, rotated), 1);
    const pivots = split.parts.map((part) => part.pivotHypothesis);
    const radius = 40;
    const { map, counts } = motionMap(original, after, before, movedAfter, pivots, radius);
    const view = new Raster(width, height);
    view.draw(after, 0, 0);
    for (const pivot of pivots) view.fillCircle(pivot, 6, [255, 0, 0, 255]);
    const residualMask = new Raster(width, height);
    for (const raster of residuals) for (let p = 0; p < width * height; p += 1) if ((raster.data[p * 4 + 3] ?? 0) > 0) residualMask.data.set(residualColor, p * 4);
    const viewRecord = png(`motion/${split.target.layer}.moved.png`, view);
    const mapRecord = png(`motion/${split.target.layer}.holes.png`, map);
    motionPanels.push(panel(view, `${split.target.layer}: trial motion`, [moved.map((item) => `${item.part.part} ${item.degrees} deg`).join(', '), 'red dots: pivot hypothesis h1 (not rig pivots)']));
    const overlay = new Raster(width, height);
    overlay.draw(original, 0, 0, 0.25);
    overlay.draw(residualMask, 0, 0, 0.6);
    overlay.draw(map, 0, 0);
    mapPanels.push(
      panel(overlay, `${split.target.layer}: holes and overlaps`, [
        'red hole, yellow lower layer shows, blue new overlap',
        `magenta: gap within ${radius} px of a pivot, orange: residual`,
        `hole ${counts.holePixels} revealed ${counts.revealedPixels} overlap ${counts.newOverlapPixels} joint ${counts.jointGapPixels}`
      ])
    );
    return {
      layer: split.target.layer,
      status: 'run',
      moves: moved.map((item) => ({ part: item.part.part, degrees: item.degrees, pivot: item.part.pivotHypothesis })),
      jointRadius: radius,
      ...counts,
      image: viewRecord.name,
      map: mapRecord.name
    };
  });

  // Contact sheet.
  const sourcePanels = analysis.map((item) => panel((layers.get(item.layer) as Layer).raster, item.layer, [`area ${item.alpha.area}, outside xyxy ${item.pixelsOutsideMetadataXyxy}`]));
  const componentPanels = analysis.map((item) => {
    const level = item.componentLevels[0] as { components: number; majorComponents: unknown[] };
    const level32 = item.componentLevels[1] as { components: number; majorComponents: unknown[] };
    const map = componentMap((layers.get(item.layer) as Layer).raster, item.alpha.area);
    outline(map, item.metadataXyxy, [220, 0, 0, 255]);
    if (item.alphaXyxy) outline(map, item.alphaXyxy, [0, 160, 0, 255]);
    return panel(map, `${item.layer}: components`, [
      `alpha>=1: ${level.components} (${level.majorComponents.length} major)`,
      `alpha>=32: ${level32.components} (${level32.majorComponents.length} major)`,
      'red: metadata xyxy, green: alpha bounds'
    ]);
  });
  const splitPanels = splits.map((split) =>
    panel(assignmentMap(split.result, width, height), `${split.target.layer}: ${split.result.status} (${split.result.method})`, [
      'blue: image left part, orange: image right part',
      'dark orange: merged residual, red: contact, black: isolated',
      `confidence ${split.confidence}, exact ${split.conservation.exact}`
    ])
  );
  const partsPanels = splits.map((split) => {
    const view = new Raster(width, height);
    split.parts.forEach((part, index) => {
      const shifted = new Raster(width, height);
      shifted.draw(part.raster, index === 0 ? -40 : 40, 0);
      view.draw(shifted, 0, 0);
    });
    return panel(view, `${split.target.layer}: parts apart (+-40 px)`, ['diagnostic shift only']);
  });
  const sheet = sheetOf(
    [sourcePanels, componentPanels, [...splitPanels, panel(original, 'reference pose'), panel(fromParts, `from parts: equal ${recomposeEqual}`)], [...partsPanels], [...motionPanels], [...mapPanels]],
    8
  );
  png('contact-sheet.png', sheet);

  // Task E: measurements.
  const table = splits.map((split) => {
    const kept = split.parts.reduce((sum, part) => sum + part.area, 0);
    return {
      layer: split.target.layer,
      parts: split.parts.map((part) => part.part),
      status: split.result.status,
      method: split.result.method,
      parameter: split.result.parameter,
      reason: split.result.reason,
      layerPixels: split.result.layerArea,
      assignedPixels: kept,
      assignedPercent: round((100 * kept) / split.result.layerArea, 2),
      residualPixels: split.result.layerArea - kept,
      residualByKind: Object.fromEntries(split.residual.map((item) => [item.kind, item.area])),
      lostPixels: split.conservation.lostPixels,
      duplicatedPixels: split.conservation.duplicatedPixels,
      changedPixels: split.conservation.changedPixels,
      exactPartition: split.conservation.exact,
      confidence: split.confidence
    };
  });
  const checks = [
    { id: 'S1', name: 'exact partition of each split layer (no lost, duplicated, changed, or extra pixel; equal alpha sum)', pass: splits.every((split) => split.conservation.exact) },
    { id: 'S2', name: 'reference pose from parts equals the reference pose from the source layers (pixel hash)', pass: recomposeEqual },
    { id: 'S3', name: 'each analyzed layer has a PNG file and a metadata entry', pass: true }
  ];
  const status: CommandStatus = checks.every((check) => check.pass) ? 'PASS' : 'FAIL';
  const report = {
    format: splitFormat,
    tool: { name: toolName, version: options.toolVersion, command: 'split-layers' },
    status: status,
    prototype: true,
    spineReady: false,
    note: 'Diagnostic prototype. Parts, bounds, and pivots are not validated for Spine. The pivots are hypotheses. Side names are image sides, not rig sides.',
    inputs: {
      metadata: { name: options.metadataName, sha256: sha256(options.metadataBytes), frame: metadata.frame },
      layers: ordered.map((layer) => ({ tag: layer.tag, ...layer.file })),
      missingFiles
    },
    drawOrder: { rule: 'depth_median from high (far) to low (near), then part_id', order: ordered.map((layer) => layer.tag) },
    analysis,
    splits: splits.map((split) => ({
      layer: split.target.layer,
      status: split.result.status,
      method: split.result.method,
      parameter: split.result.parameter,
      reason: split.result.reason,
      options: { ...defaultSplitOptions, scanRows: split.target.scanRows },
      confidence: split.confidence,
      conservation: split.conservation,
      assignmentMap: split.assignmentMap,
      parts: split.parts.map(({ raster: _raster, ...part }) => part),
      residual: split.residual
    })),
    motion,
    measurements: table,
    checks,
    files: records
  };
  files.push({ name: 'l0-1b.json', bytes: json(report) });
  const summary = { format: splitFormat, status, checks, measurements: table, motion: motion.map((item) => ({ ...item })), files: files.length };
  return { report: summary, files };
}
