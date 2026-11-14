import { type Affine, angleDifference, applyAffine, decompose, directionDegrees, fitAffine, fitBend, fitSimilarity, fitUniform, triangleAffine } from '@control/align';
import type { Joint } from '@control/contract';
import { describe, expect, it } from 'vitest';

// L0-1c alignment math. Each fit must recover a known synthetic transform. Seeded cases replace a property-test library.

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const similarity = (scale: number, degrees: number, tx: number, ty: number): Affine => {
  const r = (degrees * Math.PI) / 180;
  return { a: scale * Math.cos(r), b: -scale * Math.sin(r), c: scale * Math.sin(r), d: scale * Math.cos(r), tx, ty };
};

const cloud = (next: () => number, count: number): Joint[] => Array.from({ length: count }, () => ({ x: next() * 1000, y: next() * 1500 }));

const close = (a: Affine | null, b: Affine, digits = 6): void => {
  expect(a).not.toBeNull();
  for (const key of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) expect(a?.[key]).toBeCloseTo(b[key], digits);
};

describe('fits', () => {
  it('fitSimilarity recovers rotation, uniform scale, and translation', () => {
    const next = random(7);
    for (let trial = 0; trial < 50; trial += 1) {
      const m = similarity(0.2 + next() * 4, next() * 340 - 170, next() * 400 - 200, next() * 400 - 200);
      const source = cloud(next, 3 + Math.floor(next() * 10));
      close(
        fitSimilarity(
          source,
          source.map((p) => applyAffine(m, p))
        ),
        m
      );
    }
  });

  it('fitUniform has no rotation and recovers a pure scale and translation', () => {
    const next = random(11);
    const m = { a: 1.7, b: 0, c: 0, d: 1.7, tx: -40, ty: 12 };
    const source = cloud(next, 8);
    close(
      fitUniform(
        source,
        source.map((p) => applyAffine(m, p))
      ),
      m
    );
    const rotated = fitUniform(
      source,
      source.map((p) => applyAffine(similarity(1, 30, 0, 0), p))
    );
    expect(rotated?.b).toBe(0);
    expect(rotated?.c).toBe(0);
  });

  it('fitAffine recovers non-uniform scale, shear, and reflection', () => {
    const next = random(13);
    for (let trial = 0; trial < 50; trial += 1) {
      const m = { a: next() * 4 - 2, b: next() * 4 - 2, c: next() * 4 - 2, d: next() * 4 - 2, tx: next() * 100, ty: next() * 100 };
      if (Math.abs(m.a * m.d - m.b * m.c) < 0.05) continue;
      const source = cloud(next, 3 + Math.floor(next() * 10));
      close(
        fitAffine(
          source,
          source.map((p) => applyAffine(m, p))
        ),
        m,
        4
      );
    }
  });

  it('a similarity fit cannot fit a mirror image, but an affine fit shows the reflection', () => {
    const next = random(17);
    const source = cloud(next, 10);
    const mirror = { a: -1, b: 0, c: 0, d: 1, tx: 1000, ty: 0 };
    const target = source.map((p) => applyAffine(mirror, p));
    const best = fitSimilarity(source, target) as Affine;
    expect(decompose(best).determinant).toBeGreaterThan(0);
    const error = source.reduce((sum, p, i) => sum + Math.hypot(applyAffine(best, p).x - (target[i]?.x ?? 0), applyAffine(best, p).y - (target[i]?.y ?? 0)), 0);
    expect(error / source.length).toBeGreaterThan(50);
    expect(decompose(fitAffine(source, target) as Affine).determinant).toBeCloseTo(-1, 6);
  });

  it('returns null when a fit is not defined', () => {
    expect(fitSimilarity([{ x: 1, y: 1 }], [{ x: 2, y: 2 }])).toBeNull();
    expect(
      fitSimilarity(
        [
          { x: 1, y: 1 },
          { x: 1, y: 1 }
        ],
        [
          { x: 0, y: 0 },
          { x: 5, y: 5 }
        ]
      )
    ).toBeNull();
    const line = [0, 1, 2, 3].map((t) => ({ x: t, y: 2 * t }));
    expect(fitAffine(line, line)).toBeNull();
    expect(
      fitUniform(
        line,
        line.map((p) => ({ x: -p.x, y: -p.y }))
      )
    ).toBeNull();
  });
});

describe('decompose and triangles', () => {
  it('gives singular values, rotation, and determinant', () => {
    const parts = decompose({ a: 3, b: 0, c: 0, d: 2, tx: 5, ty: 5 });
    expect(parts.s1).toBeCloseTo(3);
    expect(parts.s2).toBeCloseTo(2);
    expect(parts.rotationDegrees).toBeCloseTo(0);
    expect(parts.determinant).toBeCloseTo(6);
    const turned = decompose(similarity(2, 40, 0, 0));
    expect(turned.s1).toBeCloseTo(2);
    expect(turned.s2).toBeCloseTo(2);
    expect(turned.rotationDegrees).toBeCloseTo(40);
  });

  it('maps a triangle exactly and refuses a degenerate one', () => {
    const m = { a: 1.5, b: 0.3, c: -0.2, d: 0.8, tx: 10, ty: -4 };
    const source: [Joint, Joint, Joint] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 3, y: 7 }
    ];
    close(triangleAffine(source, source.map((p) => applyAffine(m, p)) as unknown as [Joint, Joint, Joint]), m);
    expect(
      triangleAffine(
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: 2, y: 2 }
        ],
        source
      )
    ).toBeNull();
  });
});

describe('angles and bends', () => {
  it('uses y down and wraps angle differences', () => {
    expect(directionDegrees({ x: 0, y: 0 }, { x: 0, y: 5 })).toBeCloseTo(90);
    expect(angleDifference(170, -170)).toBeCloseTo(-20);
    expect(angleDifference(-170, 170)).toBeCloseTo(20);
    expect(angleDifference(180, 0)).toBeCloseTo(180);
  });

  it('finds the break of a bent polyline', () => {
    const points: Joint[] = [];
    for (let y = 0; y <= 40; y += 1) points.push({ x: 50 - y * 0.25, y });
    for (let y = 41; y <= 80; y += 1) points.push({ x: 40 + (y - 40) * 0.4, y });
    const bend = fitBend(points, 8);
    expect(bend?.index).toBe(40);
    expect(bend?.point).toEqual({ x: 40, y: 40 });
    expect(bend?.bendDegrees).toBeCloseTo(Math.abs(angleDifference(directionDegrees({ x: 40, y: 40 }, { x: 56, y: 80 }), directionDegrees({ x: 50, y: 0 }, { x: 40, y: 40 }))), 6);
    expect(bend?.bentError).toBeLessThan(bend?.straightError ?? 0);
  });

  it('gives a near-zero bend for a straight polyline and null for a short one', () => {
    const straight = Array.from({ length: 60 }, (_, y) => ({ x: 10 + y * 0.3, y }));
    expect(fitBend(straight, 8)?.bendDegrees).toBeLessThan(1e-6);
    expect(fitBend(straight.slice(0, 10), 8)).toBeNull();
  });
});
