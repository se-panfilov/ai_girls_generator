import { Raster } from '@control/raster';

// L0-1b: geometric analysis and separation of one semantic layer mask into independent parts (prototype).
// The functions use only the alpha channel to select pixels. They copy RGBA values without change.
// A pixel is in the layer when its alpha is not 0. Each layer pixel goes to exactly one output: a part or the residual.
// The residual keeps the pixels that cannot be assigned without a guess. Nothing is dropped.

export type Bounds = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
export type Component = {
  readonly id: number;
  readonly area: number;
  readonly alphaSum: number;
  readonly bounds: Bounds;
  readonly centroid: { readonly x: number; readonly y: number };
};
export type Labeling = { readonly labels: Int32Array; readonly components: readonly Component[] };

export type SplitOptions = {
  /** The number of parts to find. */
  readonly expected: number;
  /** A component is major when its area is at least this fraction of the layer area. */
  readonly minFraction: number;
  /** Alpha thresholds that are tried to separate the parts at the soft edge, in order. */
  readonly alphaThresholds: readonly number[];
  /** The largest erosion radius (pixels, 8-neighbor steps) that is tried to open a thin contact. */
  readonly maxErosion: number;
  /** A pixel goes to the nearest seed only when the second seed is farther by more than this margin (pixels). Otherwise it is a contact pixel. */
  readonly contactMargin: number;
  /** A fragment that is not connected to a seed is attached to the nearest part only at this distance (pixels) or less. */
  readonly attachDistance: number;
  /** Also try seeds from scan rows with exactly `expected` runs. In this mode, a non-seed region that touches two seeds stays in the residual (merged region); a region that touches one seed goes to it. */
  readonly scanRows: boolean;
};

export const defaultSplitOptions: SplitOptions = { expected: 2, minFraction: 0.02, alphaThresholds: [32, 64, 128, 192], maxErosion: 12, contactMargin: 2, attachDistance: 8, scanRows: false };

export type SplitMethod = 'components' | 'alpha_threshold' | 'erosion' | 'scan_rows' | 'none';
export type SplitStatus = 'split' | 'not_split' | 'empty';

/** Label values in the assignment map. Part labels are 1 to 250. */
export const contactLabel = 254;
export const isolatedLabel = 255;
export const unsplitLabel = 253;
/** Residual pixels of a region that touches two or more parts (scan_rows method). */
export const mergedLabel = 252;

export type SplitResult = {
  readonly status: SplitStatus;
  readonly method: SplitMethod;
  readonly reason: string;
  /** Parameters that made the seeds: the alpha threshold or the erosion radius. */
  readonly parameter: number | null;
  /** 0: not in the layer. 1..n: part in the order of `parts`. contactLabel, isolatedLabel, unsplitLabel: residual. */
  readonly assignment: Uint8Array;
  /** Parts in image order: sorted by the centroid x (image left first). */
  readonly parts: readonly { readonly label: number; readonly seedArea: number; readonly attachedFragmentPixels: number }[];
  readonly layerArea: number;
  readonly contactPixels: number;
  readonly isolatedPixels: number;
  readonly mergedPixels: number;
  readonly unsplitPixels: number;
};

const neighbors8 = [-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1] as const;

/** Binary mask of the pixels with alpha at or above a threshold (at least 1). */
export function alphaMask(raster: Raster, threshold = 1): Uint8Array {
  const limit = Math.max(1, threshold);
  const mask = new Uint8Array(raster.width * raster.height);
  for (let p = 0; p < mask.length; p += 1) if ((raster.data[p * 4 + 3] ?? 0) >= limit) mask[p] = 1;
  return mask;
}

export function maskArea(mask: Uint8Array): number {
  let count = 0;
  for (const value of mask) count += value === 0 ? 0 : 1;
  return count;
}

/** Exact bounds of the non-zero pixels as xyxy with exclusive right and bottom edges, or null for an empty mask. */
export function maskBounds(mask: Uint8Array, width: number): Bounds | null {
  let left = Infinity;
  let top = Infinity;
  let right = -1;
  let bottom = -1;
  for (let p = 0; p < mask.length; p += 1) {
    if (mask[p] === 0) continue;
    const x = p % width;
    const y = (p - x) / width;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  return right < 0 ? null : { left, top, right: right + 1, bottom: bottom + 1 };
}

/**
 * 8-connected components of a mask. Components are numbered from 1 in raster order of their first pixel, so the result is deterministic.
 * The alpha values come from `raster` when it is given; otherwise alphaSum is the area.
 */
export function labelComponents(mask: Uint8Array, width: number, height: number, raster?: Raster): Labeling {
  const labels = new Int32Array(mask.length);
  const components: Component[] = [];
  const stack = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || labels[start] !== 0) continue;
    const id = components.length + 1;
    let top = 0;
    stack[top++] = start;
    labels[start] = id;
    let area = 0;
    let alphaSum = 0;
    let sx = 0;
    let sy = 0;
    let left = Infinity;
    let upper = Infinity;
    let right = -1;
    let bottom = -1;
    while (top > 0) {
      const p = stack[--top] as number;
      const x = p % width;
      const y = (p - x) / width;
      area += 1;
      alphaSum += raster ? (raster.data[p * 4 + 3] ?? 0) : 1;
      sx += x + 0.5;
      sy += y + 0.5;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < upper) upper = y;
      if (y > bottom) bottom = y;
      for (let k = 0; k < 16; k += 2) {
        const nx = x + (neighbors8[k] as number);
        const ny = y + (neighbors8[k + 1] as number);
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (mask[q] === 0 || labels[q] !== 0) continue;
        labels[q] = id;
        stack[top++] = q;
      }
    }
    components.push({ id, area, alphaSum, bounds: { left, top: upper, right: right + 1, bottom: bottom + 1 }, centroid: { x: sx / area, y: sy / area } });
  }
  return { labels, components };
}

/** Erosion by one 8-neighbor step: a pixel stays when all 8 neighbors are in the mask. Pixels at the image edge are removed. */
export function erode(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x;
      if (mask[p] === 0) continue;
      let keep = 1;
      for (let k = 0; k < 16 && keep === 1; k += 2) if (mask[(y + (neighbors8[k + 1] as number)) * width + x + (neighbors8[k] as number)] === 0) keep = 0;
      out[p] = keep;
    }
  }
  return out;
}

/**
 * Breadth-first distance in 8-neighbor steps from the seed pixels.
 * With `within`, the path stays inside that mask (geodesic distance). Unreached pixels get Infinity.
 */
export function stepDistance(seed: Uint8Array, width: number, height: number, within?: Uint8Array): Float64Array {
  const distance = new Float64Array(seed.length).fill(Infinity);
  const queue = new Int32Array(seed.length);
  let head = 0;
  let tail = 0;
  for (let p = 0; p < seed.length; p += 1) {
    if (seed[p] === 0) continue;
    distance[p] = 0;
    queue[tail++] = p;
  }
  while (head < tail) {
    const p = queue[head++] as number;
    const x = p % width;
    const y = (p - x) / width;
    const next = (distance[p] as number) + 1;
    for (let k = 0; k < 16; k += 2) {
      const nx = x + (neighbors8[k] as number);
      const ny = y + (neighbors8[k + 1] as number);
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const q = ny * width + nx;
      if (distance[q] !== Infinity || (within && within[q] === 0)) continue;
      distance[q] = next;
      queue[tail++] = q;
    }
  }
  return distance;
}

type Seeds = { readonly method: SplitMethod; readonly parameter: number | null; readonly masks: readonly Uint8Array[] };

function majors(labeling: Labeling, reference: number, minFraction: number): Component[] {
  return labeling.components.filter((item) => item.area >= minFraction * reference);
}

function seedMasks(labeling: Labeling, selected: readonly Component[]): Uint8Array[] {
  return selected.map((component) => {
    const mask = new Uint8Array(labeling.labels.length);
    for (let p = 0; p < mask.length; p += 1) if (labeling.labels[p] === component.id) mask[p] = 1;
    return mask;
  });
}

/** Rows of the mask where exactly `expected` runs exist. Pixels of those runs are separated by background in their row. */
export function separatedRows(mask: Uint8Array, width: number, height: number, expected: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const runs: [number, number][] = [];
    let start = -1;
    for (let x = 0; x <= width; x += 1) {
      const inside = x < width && mask[y * width + x] === 1;
      if (inside && start < 0) start = x;
      if (!inside && start >= 0) {
        runs.push([start, x]);
        start = -1;
      }
    }
    if (runs.length !== expected) continue;
    for (const [from, to] of runs) for (let x = from; x < to; x += 1) out[y * width + x] = 1;
  }
  return out;
}

/**
 * Finds one seed for each expected part, or returns the reason. The search order is fixed, so the result is deterministic:
 * 1. connected components at alpha thresholds 1, then the configured higher thresholds;
 * 2. erosion of the alpha 128 core;
 * 3. with `scanRows`, the runs of the rows where the parts are separated by background (vertical parts, such as legs).
 */
function findSeeds(raster: Raster, layer: Uint8Array, layerArea: number, options: SplitOptions): Seeds | { readonly reason: string; readonly majorCount: number } {
  const { width, height } = raster;
  const counts: string[] = [];
  let fullCount = 0;
  for (const threshold of [1, ...options.alphaThresholds]) {
    const labeling = labelComponents(threshold === 1 ? layer : alphaMask(raster, threshold), width, height);
    const found = majors(labeling, layerArea, options.minFraction);
    if (threshold === 1) fullCount = found.length;
    counts.push(`${found.length} at alpha >= ${threshold}`);
    if (found.length === options.expected) return { method: threshold === 1 ? 'components' : 'alpha_threshold', parameter: threshold === 1 ? null : threshold, masks: seedMasks(labeling, found) };
  }
  let eroded = alphaMask(raster, 128);
  for (let radius = 1; radius <= options.maxErosion; radius += 1) {
    eroded = erode(eroded, width, height);
    const labeling = labelComponents(eroded, width, height);
    const found = majors(labeling, layerArea, options.minFraction / 2);
    if (found.length === options.expected) return { method: 'erosion', parameter: radius, masks: seedMasks(labeling, found) };
    if (found.length > options.expected) break;
  }
  if (options.scanRows) {
    const labeling = labelComponents(separatedRows(layer, width, height, options.expected), width, height);
    const found = majors(labeling, layerArea, options.minFraction);
    if (found.length === options.expected) return { method: 'scan_rows', parameter: null, masks: seedMasks(labeling, found) };
  }
  return {
    reason: `Major components: ${counts.join(', ')}. Erosion up to ${options.maxErosion} px${options.scanRows ? ' and separated scan rows' : ''} do not give ${options.expected} parts. The parts touch or overlap over a wide area, or the layer has other parts.`,
    majorCount: fullCount
  };
}

/**
 * Splits the layer into `expected` parts without a cut line. Seeds come from connected components, from a higher alpha threshold, or from erosion.
 * Each layer pixel goes to the seed with the shortest path inside the layer. When two seeds are at almost the same distance, the pixel is a contact pixel (residual).
 * A fragment without a path to a seed attaches to the nearest part only when it is near and the choice is clear. Otherwise it is an isolated residual pixel.
 */
export function splitLayer(raster: Raster, options: SplitOptions = defaultSplitOptions): SplitResult {
  const { width, height } = raster;
  const layer = alphaMask(raster, 1);
  const layerArea = maskArea(layer);
  const assignment = new Uint8Array(layer.length);
  const empty = (status: SplitStatus, reason: string): SplitResult => ({
    status,
    method: 'none',
    reason,
    parameter: null,
    assignment,
    parts: [],
    layerArea,
    contactPixels: 0,
    isolatedPixels: 0,
    mergedPixels: 0,
    unsplitPixels: status === 'not_split' ? layerArea : 0
  });
  if (layerArea === 0) return empty('empty', 'The layer has no pixel with alpha above 0.');
  if (options.expected < 2 || options.expected > 250) throw new RangeError('expected must be from 2 to 250.');
  const seeds = findSeeds(raster, layer, layerArea, options);
  if (!('masks' in seeds)) {
    for (let p = 0; p < layer.length; p += 1) if (layer[p] === 1) assignment[p] = unsplitLabel;
    return empty('not_split', seeds.reason);
  }
  const geodesic = seeds.masks.map((mask) => stepDistance(mask, width, height, layer));
  const free = seeds.masks.map((mask) => stepDistance(mask, width, height));
  const order = seeds.masks.map((mask, index) => ({ index, x: centroidX(mask, width) })).sort((a, b) => a.x - b.x || a.index - b.index);
  const labelOf = new Map(order.map((item, rank) => [item.index, rank + 1]));
  const attached = new Array<number>(seeds.masks.length).fill(0);
  const restTouch = seeds.method === 'scan_rows' ? touchMap(layer, seeds.masks, width, height) : undefined;
  let contactPixels = 0;
  let isolatedPixels = 0;
  let mergedPixels = 0;
  for (let p = 0; p < layer.length; p += 1) {
    if (layer[p] === 0) continue;
    const reachable = geodesic.some((distance) => (distance[p] as number) !== Infinity);
    const [nearest, margin] = nearestOf((reachable ? geodesic : free).map((distance) => distance[p] as number));
    const touching = restTouch?.[p];
    if (touching !== undefined && touching >= 0) {
      if (touching === seeds.masks.length) {
        assignment[p] = mergedLabel;
        mergedPixels += 1;
      } else assignment[p] = labelOf.get(touching) as number;
    } else if (reachable) {
      if (margin > options.contactMargin) assignment[p] = labelOf.get(nearest) as number;
      else {
        assignment[p] = contactLabel;
        contactPixels += 1;
      }
    } else if ((free[nearest]?.[p] ?? Infinity) <= options.attachDistance && margin > options.contactMargin) {
      assignment[p] = labelOf.get(nearest) as number;
      attached[nearest] = (attached[nearest] ?? 0) + 1;
    } else {
      assignment[p] = isolatedLabel;
      isolatedPixels += 1;
    }
  }
  const parts = order.map((item, rank) => ({ label: rank + 1, seedArea: maskArea(seeds.masks[item.index] as Uint8Array), attachedFragmentPixels: attached[item.index] ?? 0 }));
  return {
    status: 'split',
    method: seeds.method,
    reason: splitReason(seeds.method, seeds.parameter),
    parameter: seeds.parameter,
    assignment,
    parts,
    layerArea,
    contactPixels,
    isolatedPixels,
    mergedPixels,
    unsplitPixels: 0
  };
}

function splitReason(method: SplitMethod, parameter: number | null): string {
  if (method === 'components') return 'The parts are separate connected components.';
  if (method === 'alpha_threshold') return `The parts touch only at soft edge pixels with alpha below ${parameter}.`;
  if (method === 'scan_rows') return 'The parts are separated by background in the scan rows below or above a merged region. The merged region stays in the residual.';
  return `The parts touch at a thin contact. Erosion by ${parameter} px opens it. Pixels at almost equal path distance stay in the residual.`;
}

/**
 * For the scan_rows method: the layer pixels outside the seeds make "rest" components. For each rest pixel, the value is
 * the index of the only seed that its rest component touches (8-neighbors), `masks.length` when it touches two or more seeds (merged region),
 * and -1 when it touches no seed. A seed pixel gets the index of its seed.
 */
function touchMap(layer: Uint8Array, masks: readonly Uint8Array[], width: number, height: number): Int32Array {
  const seedOf = new Int32Array(layer.length).fill(-1);
  masks.forEach((mask, index) => {
    for (let p = 0; p < mask.length; p += 1) if (mask[p] === 1) seedOf[p] = index;
  });
  const rest = new Uint8Array(layer.length);
  for (let p = 0; p < layer.length; p += 1) if (layer[p] === 1 && seedOf[p] === -1) rest[p] = 1;
  const { labels, components } = labelComponents(rest, width, height);
  const touched = components.map(() => new Set<number>());
  for (let p = 0; p < layer.length; p += 1) {
    const id = labels[p] as number;
    if (id === 0) continue;
    const x = p % width;
    const y = (p - x) / width;
    for (let k = 0; k < 16; k += 2) {
      const nx = x + (neighbors8[k] as number);
      const ny = y + (neighbors8[k + 1] as number);
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const seed = seedOf[ny * width + nx] as number;
      if (seed >= 0) touched[id - 1]?.add(seed);
    }
  }
  const out = seedOf;
  for (let p = 0; p < layer.length; p += 1) {
    const id = labels[p] as number;
    if (id === 0) continue;
    const set = touched[id - 1] as Set<number>;
    out[p] = set.size === 0 ? -1 : set.size === 1 ? ([...set][0] as number) : masks.length;
  }
  return out;
}

function centroidX(mask: Uint8Array, width: number): number {
  let sum = 0;
  let count = 0;
  for (let p = 0; p < mask.length; p += 1) {
    if (mask[p] === 0) continue;
    sum += (p % width) + 0.5;
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

/** Index of the smallest value and the margin to the second smallest value (Infinity when there is no second finite value). */
function nearestOf(values: readonly number[]): [number, number] {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) if ((values[i] as number) < (values[best] as number)) best = i;
  let second = Infinity;
  for (let i = 0; i < values.length; i += 1) if (i !== best && (values[i] as number) < second) second = values[i] as number;
  return [best, second - (values[best] as number)];
}

/** Copies the source pixels with one assignment label to a new raster of the same size. Other pixels are transparent black. */
export function extractLabel(source: Raster, assignment: Uint8Array, label: number): Raster {
  const out = new Raster(source.width, source.height);
  for (let p = 0; p < assignment.length; p += 1) if (assignment[p] === label) out.data.set(source.data.subarray(p * 4, p * 4 + 4), p * 4);
  return out;
}

export type Conservation = {
  readonly sourcePixels: number;
  readonly outputPixels: number;
  readonly lostPixels: number;
  readonly duplicatedPixels: number;
  readonly changedPixels: number;
  readonly extraPixels: number;
  readonly sourceAlphaSum: number;
  readonly outputAlphaSum: number;
  readonly exact: boolean;
};

/**
 * Checks that the outputs are an exact partition of the source layer:
 * each source pixel with alpha above 0 is in exactly one output with the same RGBA value, and no output has a pixel outside the source.
 * Limit: the RGB values of source pixels with alpha 0 are not kept in the outputs (they are transparent black). Those values are not visible.
 */
export function checkConservation(source: Raster, outputs: readonly Raster[]): Conservation {
  let sourcePixels = 0;
  let outputPixels = 0;
  let lostPixels = 0;
  let duplicatedPixels = 0;
  let changedPixels = 0;
  let extraPixels = 0;
  let sourceAlphaSum = 0;
  let outputAlphaSum = 0;
  for (const output of outputs) if (output.width !== source.width || output.height !== source.height) throw new RangeError('The output size is not the source size.');
  for (let p = 0; p < source.width * source.height; p += 1) {
    const i = p * 4;
    const alpha = source.data[i + 3] ?? 0;
    sourceAlphaSum += alpha;
    if (alpha > 0) sourcePixels += 1;
    let count = 0;
    let changed = false;
    for (const output of outputs) {
      const outAlpha = output.data[i + 3] ?? 0;
      if (outAlpha === 0) continue;
      count += 1;
      outputPixels += 1;
      outputAlphaSum += outAlpha;
      for (let c = 0; c < 4; c += 1) if (output.data[i + c] !== source.data[i + c]) changed = true;
    }
    if (alpha > 0 && count === 0) lostPixels += 1;
    if (count > 1) duplicatedPixels += 1;
    if (alpha === 0 && count > 0) extraPixels += 1;
    if (changed) changedPixels += 1;
  }
  return {
    sourcePixels,
    outputPixels,
    lostPixels,
    duplicatedPixels,
    changedPixels,
    extraPixels,
    sourceAlphaSum,
    outputAlphaSum,
    exact: lostPixels === 0 && duplicatedPixels === 0 && changedPixels === 0 && extraPixels === 0 && sourceAlphaSum === outputAlphaSum
  };
}
