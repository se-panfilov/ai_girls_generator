import { Raster } from '@control/raster';
import {
  alphaMask,
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
import { describe, expect, it } from 'vitest';

// L0-1b split core tests on synthetic layers. No real character image is used.

type Rect = { x: number; y: number; w: number; h: number; alpha?: number };

function layer(width: number, height: number, rects: readonly Rect[]): Raster {
  const raster = new Raster(width, height);
  for (const [index, rect] of rects.entries()) {
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        // Each pixel gets a different color, so a moved or changed pixel is visible to the conservation check.
        raster.data.set([(x * 7 + index * 31) & 255, (y * 5) & 255, (x + y) & 255, rect.alpha ?? 255], (y * width + x) * 4);
      }
    }
  }
  return raster;
}

function outputsOf(source: Raster, result: SplitResult): Raster[] {
  const labels = [...result.parts.map((part) => part.label), contactLabel, isolatedLabel, unsplitLabel, mergedLabel];
  return labels.map((label) => extractLabel(source, result.assignment, label));
}

function count(result: SplitResult, label: number): number {
  return result.assignment.reduce((sum, value) => sum + (value === label ? 1 : 0), 0);
}

describe('labelComponents and bounds', () => {
  it('finds 8-connected components in raster order with exact xyxy bounds', () => {
    const raster = layer(20, 10, [
      { x: 12, y: 1, w: 3, h: 2 },
      { x: 2, y: 4, w: 4, h: 5 },
      { x: 15, y: 3, w: 1, h: 1 }
    ]);
    const { components } = labelComponents(alphaMask(raster), 20, 10, raster);
    expect(components.map((item) => item.area)).toEqual([7, 20]);
    expect(components[0]?.bounds).toEqual({ left: 12, top: 1, right: 16, bottom: 4 });
    expect(components[1]?.bounds).toEqual({ left: 2, top: 4, right: 6, bottom: 9 });
    expect(maskBounds(alphaMask(raster), 20)).toEqual({ left: 2, top: 1, right: 16, bottom: 9 });
    expect(maskBounds(new Uint8Array(4), 2)).toBeNull();
  });
});

describe('splitLayer', () => {
  it('splits separate components in image order and keeps every pixel', () => {
    const source = layer(60, 40, [
      { x: 35, y: 5, w: 10, h: 30 },
      { x: 5, y: 5, w: 10, h: 30 }
    ]);
    const result = splitLayer(source);
    expect(result.status).toBe('split');
    expect(result.method).toBe('components');
    expect(result.parts).toHaveLength(2);
    expect(maskBounds(alphaMask(extractLabel(source, result.assignment, 1)), 60)).toEqual({ left: 5, top: 5, right: 15, bottom: 35 });
    expect(checkConservation(source, outputsOf(source, result)).exact).toBe(true);
  });

  it('separates parts that touch only through low alpha edge pixels', () => {
    const source = layer(60, 40, [
      { x: 5, y: 5, w: 20, h: 30 },
      { x: 35, y: 5, w: 20, h: 30 },
      { x: 25, y: 18, w: 10, h: 4, alpha: 20 }
    ]);
    const result = splitLayer(source);
    expect(result.method).toBe('alpha_threshold');
    expect(result.parameter).toBe(32);
    expect(result.contactPixels).toBeGreaterThan(0);
    expect(checkConservation(source, outputsOf(source, result)).exact).toBe(true);
  });

  it('opens a thin opaque contact by erosion and keeps the contact pixels in the residual', () => {
    const source = layer(80, 40, [
      { x: 5, y: 5, w: 30, h: 30 },
      { x: 45, y: 5, w: 30, h: 30 },
      { x: 35, y: 19, w: 10, h: 2 }
    ]);
    const result = splitLayer(source);
    expect(result.method).toBe('erosion');
    expect(result.status).toBe('split');
    expect(count(result, contactLabel)).toBe(result.contactPixels);
    expect(result.contactPixels).toBeGreaterThan(0);
    expect(count(result, 1)).toBeGreaterThan(800);
    expect(count(result, 2)).toBeGreaterThan(800);
    expect(checkConservation(source, outputsOf(source, result)).exact).toBe(true);
  });

  it('does not split one wide region and keeps all pixels in the unsplit residual', () => {
    const source = layer(60, 60, [
      { x: 5, y: 5, w: 30, h: 50 },
      { x: 20, y: 5, w: 30, h: 50 }
    ]);
    const result = splitLayer(source);
    expect(result.status).toBe('not_split');
    expect(result.unsplitPixels).toBe(result.layerArea);
    expect(result.reason).toMatch(/touch or overlap/);
    expect(checkConservation(source, outputsOf(source, result)).exact).toBe(true);
  });

  it('does not group more major components than expected', () => {
    const source = layer(90, 40, [
      { x: 5, y: 5, w: 10, h: 30 },
      { x: 35, y: 5, w: 10, h: 30 },
      { x: 65, y: 5, w: 10, h: 30 }
    ]);
    const result = splitLayer(source);
    expect(result.status).toBe('not_split');
    expect(result.reason).toMatch(/3 at alpha >= 1/);
  });

  it('attaches a near fragment to its part and keeps a far or ambiguous fragment as isolated', () => {
    const source = layer(100, 60, [
      { x: 5, y: 5, w: 15, h: 40 },
      { x: 75, y: 5, w: 15, h: 40 },
      { x: 23, y: 10, w: 2, h: 2 },
      { x: 46, y: 50, w: 2, h: 2 }
    ]);
    const result = splitLayer(source);
    expect(result.status).toBe('split');
    expect(result.parts[0]?.attachedFragmentPixels).toBe(4);
    expect(result.isolatedPixels).toBe(4);
    expect(checkConservation(source, outputsOf(source, result)).exact).toBe(true);
  });

  it('splits vertical parts by separated scan rows and keeps the merged top in the residual', () => {
    const source = layer(60, 80, [
      { x: 5, y: 5, w: 50, h: 20 },
      { x: 5, y: 25, w: 18, h: 50 },
      { x: 37, y: 25, w: 18, h: 50 }
    ]);
    expect(splitLayer(source).status).toBe('not_split');
    const result = splitLayer(source, { ...defaultSplitOptions, scanRows: true });
    expect(result.status).toBe('split');
    expect(result.method).toBe('scan_rows');
    expect(result.mergedPixels).toBe(50 * 20);
    expect(count(result, 1)).toBe(18 * 50);
    expect(checkConservation(source, outputsOf(source, result)).exact).toBe(true);
  });

  it('uses a higher alpha threshold when a faint region adds a third component', () => {
    const source = layer(90, 40, [
      { x: 5, y: 5, w: 10, h: 30 },
      { x: 65, y: 5, w: 10, h: 30 },
      { x: 35, y: 5, w: 10, h: 10, alpha: 10 }
    ]);
    const result = splitLayer(source);
    expect(result.method).toBe('alpha_threshold');
    expect(result.isolatedPixels).toBe(100);
    expect(checkConservation(source, outputsOf(source, result)).exact).toBe(true);
  });

  it('reports an empty layer', () => {
    expect(splitLayer(new Raster(4, 4)).status).toBe('empty');
  });

  it('keeps an exact partition for random layers (seeded property check)', () => {
    let state = 12345;
    const random = (limit: number): number => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % limit;
    };
    for (let run = 0; run < 25; run += 1) {
      const rects: Rect[] = [];
      for (let i = 0; i < 1 + random(5); i += 1) rects.push({ x: random(50), y: random(30), w: 1 + random(20), h: 1 + random(15), alpha: 1 + random(255) });
      const source = layer(64, 48, rects);
      const result = splitLayer(source, { ...defaultSplitOptions, maxErosion: 4 });
      const conservation = checkConservation(source, outputsOf(source, result));
      expect(conservation.lostPixels).toBe(0);
      expect(conservation.duplicatedPixels).toBe(0);
      expect(conservation.exact).toBe(true);
    }
  });
});

describe('checkConservation', () => {
  it('detects lost, duplicated, changed and extra pixels', () => {
    const source = layer(10, 10, [{ x: 2, y: 2, w: 4, h: 4 }]);
    const copy = extractLabel(source, alphaMask(source), 1);
    const lost = checkConservation(source, [new Raster(10, 10)]);
    expect(lost.lostPixels).toBe(16);
    expect(checkConservation(source, [copy, copy]).duplicatedPixels).toBe(16);
    const changed = extractLabel(source, alphaMask(source), 1);
    changed.data[(3 * 10 + 3) * 4] = ((changed.data[(3 * 10 + 3) * 4] ?? 0) + 1) & 255;
    changed.data[3] = 9;
    const result = checkConservation(source, [changed]);
    expect(result.changedPixels).toBe(2);
    expect(result.extraPixels).toBe(1);
    expect(result.exact).toBe(false);
  });
});
