import { geometryStudyCommand, occlusionSafe, regionReach, tubeRegion, variantSpecs } from '@control/jointgeometry';
import { type Cut, limbStudyCommand, rotationTests } from '@control/limbstudy';
import { sha256 } from '@control/png';
import { type Color, Raster } from '@control/raster';
import { underlayRegion } from '@control/underlay';
import { describe, expect, it } from 'vitest';

import { syntheticArm } from './helpers';

// L0-1g geometry-study tests. Synthetic limbs and a synthetic arm only. No character image is used.

const size = { width: 100, height: 140 };
const skin: Color = [230, 190, 160, 255];
const cut: Cut = { joint: { x: 50, y: 100 }, normal: { x: 0, y: 1 } };
const extents = { extentNegativePx: 10, extentPositivePx: 10 };

/** A parent limb above y = 100 between x = left and x = right, and a child below. */
function limb(left = 40, right = 60): { parent: Raster; child: Raster } {
  const parent = new Raster(size.width, size.height);
  const child = new Raster(size.width, size.height);
  for (let y = 60; y < 100; y += 1) for (let x = left; x < right; x += 1) parent.data.set(skin, (y * size.width + x) * 4);
  for (let y = 100; y < 130; y += 1) for (let x = 40; x < 60; x += 1) child.data.set(skin, (y * size.width + x) * 4);
  return { parent, child };
}

describe('diagnostic regions', () => {
  it('tube: follows the parent contour along the axis, to the given depth, only where the parent has no pixel', () => {
    const { parent } = limb();
    const tube = tubeRegion(parent, cut, { x: 0, y: 1 }, extents, 15);
    expect(tube.regionPixels).toBe(20 * 15);
    for (let p = 0; p < tube.region.length; p += 1) {
      if (tube.region[p] !== 1) continue;
      const x = p % size.width;
      const y = Math.floor(p / size.width);
      expect(x >= 40 && x < 60 && y >= 100 && y < 115).toBe(true);
    }
    // The circle of the same depth is smaller: it cuts the corners of the limb end.
    expect(underlayRegion(parent, cut, extents, 15).regionPixels).toBeLessThan(tube.regionPixels);
  });

  it('tube: a slanted parent axis moves the region with the contour', () => {
    const parent = new Raster(size.width, size.height);
    // A parallelogram limb: each row shifts 0.5 px to the right toward the cut line.
    for (let y = 60; y < 100; y += 1) for (let x = 0; x < 20; x += 1) parent.data.set(skin, (y * size.width + 40 + Math.floor((y - 60) / 2) + x) * 4);
    const axis = { x: 1 / Math.hypot(1, 2), y: 2 / Math.hypot(1, 2) };
    const slanted: Cut = { joint: { x: 70, y: 100 }, normal: { x: 0, y: 1 } };
    const tube = tubeRegion(parent, slanted, axis, { extentNegativePx: 10, extentPositivePx: 10 }, 10);
    expect(tube.regionPixels).toBeGreaterThan(150);
    for (let p = 0; p < tube.region.length; p += 1) {
      if (tube.region[p] !== 1) continue;
      const x = p % size.width;
      const y = Math.floor(p / size.width);
      const left = 40 + (y - 60) / 2;
      expect(x).toBeGreaterThanOrEqual(Math.floor(left) - 1);
      expect(x).toBeLessThanOrEqual(Math.ceil(left + 20) + 1);
    }
  });

  it('wide circle: contains the circle; reach covers the farthest region pixel', () => {
    const { parent } = limb();
    const circle = underlayRegion(parent, cut, extents, 8);
    const wide = underlayRegion(parent, cut, extents, 12);
    for (let p = 0; p < circle.region.length; p += 1) if (circle.region[p] === 1) expect(wide.region[p]).toBe(1);
    expect(regionReach(wide.region, cut.joint, size.width)).toBeLessThanOrEqual(13);
    expect(regionReach(wide.region, cut.joint, size.width)).toBeGreaterThan(11);
  });

  it('occlusion-safe: removes region pixels where the child is not fully opaque', () => {
    const { parent, child } = limb();
    for (let y = 100; y < 130; y += 1) child.data.set([230, 190, 160, 120], (y * size.width + 40) * 4);
    const region = underlayRegion(parent, cut, extents, 15);
    const safe = occlusionSafe(region, child);
    expect(safe.removedPixels).toBeGreaterThan(0);
    expect(safe.regionPixels + safe.removedPixels).toBe(region.regionPixels);
    for (let p = 0; p < safe.region.length; p += 1) if (safe.region[p] === 1) expect(child.data[p * 4 + 3]).toBe(255);
  });
});

describe('straight-alpha compositing in the neutral pose', () => {
  const composite = (under: Color | null, child: Color): number[] => {
    const frame = new Raster(1, 1, [250, 250, 250, 255]);
    if (under) frame.blend(0, 0, under);
    frame.blend(0, 0, child);
    return Array.from(frame.data);
  };
  it('an underlay pixel changes the frame under a partly transparent child pixel and not under an opaque one', () => {
    const underlay: Color = [20, 15, 15, 255];
    expect(composite(underlay, [200, 150, 120, 116])).not.toEqual(composite(null, [200, 150, 120, 116]));
    expect(composite(underlay, [200, 150, 120, 255])).toEqual(composite(null, [200, 150, 120, 255]));
  });
  it('source-over keeps the straight-alpha formula', () => {
    // 0.5 * 200 + 0.5 * 250 = 225 on an opaque background.
    expect(composite(null, [200, 200, 200, 128])[0]).toBe(Math.round((200 * 128 + 250 * 127) / 255));
  });
});

type Variant = {
  id: string;
  occlusionSafe: boolean | null;
  sourcePose: { differentPixels: number };
  invariants: { changedSourcePixels: number; newPixelsOutsideRegion: number; maxChangedFramePixelsOutsideMovedNewPixels: number };
  groups: { group: string; joints: { joint: string; gapPixels: number }[] }[];
};
type Metrics = {
  status: { invariants: string };
  regions: { joint: string; pixels: Record<string, { full: number; occlusionSafe: number }> }[];
  baseline: { group: string; joints: { gapPixels: number }[] }[];
  variants: Variant[];
  sensitivity: { shift: { x: number; y: number }; variants: { id: string; sourcePoseDifferentPixels: number }[] }[];
};

describe('geometry-study command', () => {
  const { contractBytes, metadataBytes, layerFiles, imageBytes, landmarkBytes, study } = syntheticArm;
  const options = { contractBytes, metadataBytes, metadataName: 'synthetic.psd.json', layerFiles, imageBytes, landmarkBytes, studyBytes: study(landmarkBytes), toolVersion: '0' };
  const settings = { extended: false, shifts: [{ x: 2, y: 0 }] };
  const result = geometryStudyCommand(options, settings);
  const metrics = JSON.parse(result.files.find((file) => file.name === 'metrics.json')?.bytes.toString('utf8') ?? '{}') as Metrics;

  it('keeps the invariants for all variants and the L0-1e baseline', () => {
    expect(result.report.status).toBe('PASS');
    expect(metrics.status.invariants).toBe('PASS');
    expect(metrics.variants.map((variant) => variant.id)).toEqual(['baseline', ...variantSpecs.map((spec) => spec.id)]);
    for (const variant of metrics.variants) {
      expect(variant.invariants.changedSourcePixels).toBe(0);
      expect(variant.invariants.newPixelsOutsideRegion).toBe(0);
      expect(variant.invariants.maxChangedFramePixelsOutsideMovedNewPixels).toBe(0);
    }
    const old = JSON.parse(
      limbStudyCommand(options)
        .files.find((file) => file.name === 'metrics.json')
        ?.bytes.toString('utf8') ?? '{}'
    ) as { tests: { joints: { gapPixels: number }[] }[] };
    const sum = [0, 1].map((joint) => old.tests.slice(1).reduce((total, test) => total + (test.joints[joint]?.gapPixels ?? 0), 0));
    expect(metrics.baseline[0]?.joints.map((joint) => joint.gapPixels)).toEqual(sum);
    expect(rotationTests[0]?.id).toBe('source');
  });

  it('gives a bit-exact source pose for the occlusion-safe variants and for the baseline', () => {
    for (const variant of metrics.variants) if (variant.id === 'baseline' || variant.occlusionSafe === true) expect(variant.sourcePose.differentPixels).toBe(0);
    for (const row of metrics.sensitivity[0]?.variants ?? []) if (row.id === 'baseline' || row.id.includes('_safe_')) expect(row.sourcePoseDifferentPixels).toBe(0);
  });

  it('measures larger regions for the wide circle and the tube', () => {
    for (const joint of metrics.regions) {
      expect(joint.pixels.wide_circle?.full ?? 0).toBeGreaterThanOrEqual(joint.pixels.circle?.full ?? 0);
      expect(joint.pixels.tube?.full ?? 0).toBeGreaterThan(0);
      for (const kind of Object.values(joint.pixels)) expect(kind.occlusionSafe).toBeLessThanOrEqual(kind.full);
    }
  });

  it('writes the same files twice', () => {
    const again = geometryStudyCommand(options, settings);
    expect(again.files.map((file) => [file.name, sha256(file.bytes)])).toEqual(result.files.map((file) => [file.name, sha256(file.bytes)]));
    const names = result.files.map((file) => file.name);
    for (const name of [
      '1-regions.png',
      '2-sheet-body.png',
      '2-sheet-transparent.png',
      '2-sheet-magenta.png',
      '3-zoom-elbow-body.png',
      '3-zoom-wrist-magenta.png',
      '4-problem-heatmaps.png',
      '5-source-pose-difference.png'
    ]) {
      expect(names).toContain(name);
    }
  });
});

describe('limb-study exit status', () => {
  it('reports PASS for the technical invariants and keeps the study result apart', () => {
    const { contractBytes, metadataBytes, layerFiles, imageBytes, landmarkBytes, study } = syntheticArm;
    const result = limbStudyCommand({ contractBytes, metadataBytes, metadataName: 'synthetic.psd.json', layerFiles, imageBytes, landmarkBytes, studyBytes: study(landmarkBytes), toolVersion: '0' });
    expect(result.report.status).toBe('PASS');
    expect(result.report.study).toEqual({ cut: 'PASS', sourcePose: 'PASS' });
  });
});
