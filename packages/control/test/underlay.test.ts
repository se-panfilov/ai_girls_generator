import { type Cut, limbStudyCommand, rotationTests } from '@control/limbstudy';
import { sha256 } from '@control/png';
import { type Color, Raster } from '@control/raster';
import { directionalFill, nearestEdgeFill, provenanceTag, type UnderlayFill, underlayRegion, underlayStudyCommand, withUnderlay } from '@control/underlay';
import { describe, expect, it } from 'vitest';

import { syntheticArm } from './helpers';

// L0-1f underlay-study tests. Synthetic limbs only: uniform skin, a gradient, a sharp contour, and a decorative band. No character image is used.
// The limb is vertical. The parent is above the cut line y = 100, the child is below it. The parent cross-section is x = 40..59.

const size = { width: 100, height: 140 };
const cut: Cut = { joint: { x: 50, y: 100 }, normal: { x: 0, y: 1 } };
const axis = { x: 0, y: 1 };
const radius = 15;
const extents = { extentNegativePx: 10, extentPositivePx: 10 };
const skin: Color = [230, 190, 160, 255];
const outline: Color = [20, 15, 15, 255];
const band: Color = [180, 30, 40, 255];

/** A parent limb from y = top to y = 99 with a color for each pixel, and a child limb from y = 100 to y = 129. */
function limb(color: (x: number, y: number) => Color, top = 60, left = 40, right = 60): { parent: Raster; child: Raster } {
  const parent = new Raster(size.width, size.height);
  const child = new Raster(size.width, size.height);
  for (let y = top; y < 100; y += 1) for (let x = left; x < right; x += 1) parent.data.set(color(x, y), (y * size.width + x) * 4);
  for (let y = 100; y < 130; y += 1) for (let x = 40; x < 60; x += 1) child.data.set(skin, (y * size.width + x) * 4);
  return { parent, child };
}

function fills(parent: Raster, child: Raster): { region: Uint8Array; regionPixels: number; a: UnderlayFill; b: UnderlayFill } {
  const { region, regionPixels } = underlayRegion(parent, cut, extents, radius);
  return { region, regionPixels, a: nearestEdgeFill(parent, cut, region, radius), b: directionalFill(parent, child, cut, axis, region) };
}

const rgba = (raster: Raster, x: number, y: number): number[] => Array.from(raster.pixel(x, y));
const newPixels = (fill: UnderlayFill): number[] => [...fill.newMask.keys()].filter((p) => fill.newMask[p] === 1);

/** The rules for each method and each limb: new pixels only in the region, provenance for each new pixel, and no source pixel changes. */
function expectSafe(parent: Raster, region: Uint8Array, fill: UnderlayFill): void {
  for (const p of newPixels(fill)) {
    expect(region[p]).toBe(1);
    expect(parent.data[p * 4 + 3]).toBe(0);
  }
  expect(fill.provenance).toHaveLength(fill.counts.newPixels);
  expect(newPixels(fill)).toHaveLength(fill.counts.newPixels);
  for (const entry of fill.provenance) {
    expect(fill.newMask[entry.y * size.width + entry.x]).toBe(1);
    expect(parent.data[(entry.sourceY * size.width + entry.sourceX) * 4 + 3]).toBeGreaterThan(0);
  }
  const before = Buffer.from(parent.data);
  const { part, changedSourcePixels } = withUnderlay(parent, [fill]);
  expect(changedSourcePixels).toBe(0);
  expect(Buffer.from(parent.data).equals(before)).toBe(true);
  for (let p = 0; p < size.width * size.height; p += 1) {
    const original = Array.from(parent.data.subarray(p * 4, p * 4 + 4));
    const after = Array.from(part.data.subarray(p * 4, p * 4 + 4));
    if ((original[3] ?? 0) > 0) expect(after).toEqual(original);
    else if (fill.newMask[p] !== 1) expect(after).toEqual([0, 0, 0, 0]);
  }
}

describe('underlay region', () => {
  it('contains only transparent parent pixels on the child side, inside the circle and the cross-section', () => {
    const { parent } = limb(() => skin);
    const { region, regionPixels } = underlayRegion(parent, cut, extents, radius);
    expect(regionPixels).toBeGreaterThan(150);
    for (let p = 0; p < region.length; p += 1) {
      if (region[p] !== 1) continue;
      const x = (p % size.width) + 0.5;
      const y = Math.floor(p / size.width) + 0.5;
      expect(y).toBeGreaterThanOrEqual(100);
      expect(Math.hypot(x - 50, y - 100)).toBeLessThanOrEqual(radius);
      expect(Math.abs(x - 50)).toBeLessThanOrEqual(10);
    }
  });
});

describe('underlay methods on synthetic limbs', () => {
  it('uniform skin: both methods fill the whole region with the exact skin color', () => {
    const { parent, child } = limb(() => skin);
    const { region, regionPixels, a, b } = fills(parent, child);
    for (const fill of [a, b]) {
      expectSafe(parent, region, fill);
      expect(fill.counts.newPixels).toBe(regionPixels);
      expect(fill.counts.unresolvedPixels).toBe(0);
      for (const p of newPixels(fill)) expect(rgba(fill.pixels, p % size.width, Math.floor(p / size.width))).toEqual([...skin]);
    }
  });

  it('gradient: A keeps the last row, B continues the gradient and stops at the step between its two samples', () => {
    const shade = (y: number): number => 100 + (y - 60) * 2;
    const { parent, child } = limb((_, y) => [shade(y), 120, 120, 255]);
    const { region, a, b } = fills(parent, child);
    expectSafe(parent, region, a);
    expectSafe(parent, region, b);
    const last = shade(99);
    const span = last - shade(93);
    for (const p of newPixels(a)) expect(a.pixels.data[p * 4]).toBe(last);
    expect(b.counts.gradientPixels).toBe(b.counts.newPixels);
    for (let x = 41; x < 59; x += 1) {
      let previous = last;
      for (let y = 100; y < 116; y += 1) {
        const p = y * size.width + x;
        if (b.newMask[p] !== 1) continue;
        const value = b.pixels.data[p * 4] ?? 0;
        expect(value).toBeGreaterThanOrEqual(previous);
        expect(value).toBeLessThanOrEqual(last + span);
        expect(b.pixels.data[p * 4 + 3]).toBe(255);
        previous = value;
      }
      expect(previous).toBeGreaterThan(last);
    }
  });

  it('sharp contour: the outline continues at the sides and does not mix with the skin', () => {
    const { parent, child } = limb((x) => (x <= 41 || x >= 58 ? outline : skin));
    const { region, a, b } = fills(parent, child);
    for (const fill of [a, b]) {
      expectSafe(parent, region, fill);
      for (const p of newPixels(fill)) {
        const x = p % size.width;
        expect(rgba(fill.pixels, x, Math.floor(p / size.width))).toEqual([...(x <= 41 || x >= 58 ? outline : skin)]);
      }
    }
  });

  it('partly transparent edge: B copies the RGBA of the edge pixel and does not make a gradient with it', () => {
    const soft: Color = [20, 15, 15, 128];
    const { parent, child } = limb((x) => (x === 40 ? soft : skin));
    const { region, b } = fills(parent, child);
    expectSafe(parent, region, b);
    for (const p of newPixels(b)) if (p % size.width === 40) expect(rgba(b.pixels, 40, Math.floor(p / size.width))).toEqual([...soft]);
    expect(b.provenance.filter((entry) => entry.x === 40).every((entry) => entry.rule === 'directional_copy')).toBe(true);
  });

  it('decorative band: a band edge at the cut gives the band color as a copy, not a mix of band and skin', () => {
    const { parent, child } = limb((_, y) => (y >= 95 ? band : skin));
    const { region, a, b } = fills(parent, child);
    for (const fill of [a, b]) {
      expectSafe(parent, region, fill);
      for (const p of newPixels(fill)) expect(rgba(fill.pixels, p % size.width, Math.floor(p / size.width))).toEqual([...band]);
    }
    expect(b.counts.gradientPixels).toBe(0);
    expect(b.provenance.every((entry) => entry.rule === 'directional_copy')).toBe(true);
  });

  it('marks pixels unresolved when no parent color is available, and does not invent a color', () => {
    // The parent stops at y = 90: method A has no edge pixel, method B has no pixel at the cut. The child continues below the cut.
    const { parent, child } = limb(() => skin, 60, 40, 60);
    for (let y = 90; y < 100; y += 1) for (let x = 40; x < 60; x += 1) parent.data.set([0, 0, 0, 0], (y * size.width + x) * 4);
    const region = underlayRegion(parent, cut, extents, radius).region;
    const a = nearestEdgeFill(parent, cut, region, radius);
    const b = directionalFill(parent, child, cut, axis, region);
    expect(a.counts.newPixels).toBe(0);
    expect(b.counts.newPixels).toBe(0);
    expect(a.counts.unresolvedPixels + b.counts.unresolvedPixels).toBeGreaterThan(0);
    for (const fill of [a, b]) for (let p = 0; p < fill.pixels.data.length; p += 1) expect(fill.pixels.data[p]).toBe(0);
    // A narrow parent (x = 44..55) under a wide child: B leaves the child-only side pixels unresolved.
    const narrow = limb(() => skin, 60, 44, 56);
    const narrowRegion = underlayRegion(narrow.parent, cut, extents, radius).region;
    const narrowB = directionalFill(narrow.parent, narrow.child, cut, axis, narrowRegion);
    expect(narrowB.counts.unresolvedPixels).toBeGreaterThan(0);
    for (let p = 0; p < narrowB.unresolved.length; p += 1) if (narrowB.unresolved[p] === 1) expect(narrowB.newMask[p]).toBe(0);
  });

  it('gives the same output for the same input', () => {
    const { parent, child } = limb((x, y) => [(x * 7 + y * 3) % 256, (x * 5) % 256, (y * 11) % 256, 255]);
    const first = fills(parent, child);
    const second = fills(parent, child);
    for (const key of ['a', 'b'] as const) {
      expect(Buffer.from(first[key].pixels.data).equals(Buffer.from(second[key].pixels.data))).toBe(true);
      expect(first[key].provenance).toEqual(second[key].provenance);
    }
  });
});

type Metrics = {
  status: { invariants: string };
  fills: { method: string; newPixelsOutsideRegions: number; changedSourcePixels: number; joints: { newPixels: number }[] }[];
  neutralPose: { variant: string; differentPixels: number }[];
  comparison: { id: string; variants: { variant: string; changedFramePixelsOutsideMovedNewPixels: number; joints: { gapPixels: number; protrusionPixels: number }[] }[] }[];
};

describe('underlay-study command', () => {
  const { contractBytes, metadataBytes, layerFiles, imageBytes, landmarkBytes, study } = syntheticArm;
  const options = { contractBytes, metadataBytes, metadataName: 'synthetic.psd.json', layerFiles, imageBytes, landmarkBytes, studyBytes: study(landmarkBytes), toolVersion: '0' };
  const result = underlayStudyCommand(options);
  const read = (files: typeof result.files, name: string): unknown => JSON.parse(files.find((file) => file.name === name)?.bytes.toString('utf8') ?? '{}');
  const metrics = read(result.files, 'metrics.json') as Metrics;

  it('adds new pixels only in the regions, changes no source pixel, and keeps the L0-1e baseline metrics', () => {
    expect(metrics.status.invariants).toBe('PASS');
    expect((result.report as { status: string }).status).toBe('PASS');
    expect(metrics.fills.map((fill) => fill.method)).toEqual(['nearest_edge', 'directional']);
    for (const fill of metrics.fills) {
      expect(fill.newPixelsOutsideRegions).toBe(0);
      expect(fill.changedSourcePixels).toBe(0);
      expect(fill.joints.reduce((sum, joint) => sum + joint.newPixels, 0)).toBeGreaterThan(0);
    }
    expect(metrics.comparison.map((test) => test.id)).toEqual(rotationTests.map((test) => test.id));
    const old = JSON.parse(
      limbStudyCommand(options)
        .files.find((file) => file.name === 'metrics.json')
        ?.bytes.toString('utf8') ?? '{}'
    ) as {
      tests: { id: string; joints: { gapPixels: number; protrusionPixels: number }[] }[];
    };
    for (const [index, test] of metrics.comparison.entries()) {
      const baseline = test.variants.find((variant) => variant.variant === 'baseline');
      expect(baseline?.joints.map((joint) => [joint.gapPixels, joint.protrusionPixels])).toEqual(old.tests[index]?.joints.map((joint) => [joint.gapPixels, joint.protrusionPixels]));
      for (const variant of test.variants) expect(variant.changedFramePixelsOutsideMovedNewPixels).toBe(0);
    }
    expect(metrics.neutralPose.find((item) => item.variant === 'baseline')?.differentPixels).toBe(0);
  });

  it('reduces the gap of a turned joint on the synthetic arm', () => {
    const elbow = metrics.comparison.find((test) => test.id === 'elbow+30');
    const gap = (variant: string): number => elbow?.variants.find((item) => item.variant === variant)?.joints[0]?.gapPixels ?? 0;
    expect(gap('baseline')).toBeGreaterThan(0);
    expect(gap('nearest_edge')).toBeLessThan(gap('baseline'));
    expect(gap('directional')).toBeLessThan(gap('baseline'));
  });

  it('writes provenance for each new pixel and the same files twice', () => {
    const provenance = read(result.files, 'provenance.json') as { provenance: string; entries: { method: string; pixels: unknown[] }[] };
    expect(provenance.provenance).toBe(provenanceTag);
    const counted = provenance.entries.reduce((sum, entry) => sum + entry.pixels.length, 0);
    expect(counted).toBe(metrics.fills.reduce((sum, fill) => sum + fill.joints.reduce((inner, joint) => inner + joint.newPixels, 0), 0));
    const again = underlayStudyCommand(options);
    expect(again.files.map((file) => [file.name, sha256(file.bytes)])).toEqual(result.files.map((file) => [file.name, sha256(file.bytes)]));
    const names = result.files.map((file) => file.name);
    for (const name of ['1-new-pixel-masks.png', '2-comparison-on-body.png', '3-comparison-on-magenta.png', '4-problem-heatmaps.png', '5-zoom-elbow.png', '5-zoom-wrist.png', '6-source-pose.png']) {
      expect(names).toContain(name);
    }
  });
});
