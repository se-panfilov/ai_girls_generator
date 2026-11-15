import type { Joint } from '@control/contract';

// 2D alignment math for experiment L0-1c (prototype). Pure functions without input or output.
// Each fit maps source points (the character image) to target points (the rig contract space) by least squares.

export type Affine = { readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly tx: number; readonly ty: number };

/** x' = a x + b y + tx, y' = c x + d y + ty. */
export const applyAffine = (m: Affine, p: Joint): Joint => ({ x: m.a * p.x + m.b * p.y + m.tx, y: m.c * p.x + m.d * p.y + m.ty });

const mean = (list: readonly Joint[]): Joint => ({ x: list.reduce((sum, p) => sum + p.x, 0) / list.length, y: list.reduce((sum, p) => sum + p.y, 0) / list.length });

/** Translation and uniform scale without rotation. Null when the fit is not defined (fewer than 2 points or no spread). */
export function fitUniform(source: readonly Joint[], target: readonly Joint[]): Affine | null {
  if (source.length < 2 || source.length !== target.length) return null;
  const ms = mean(source);
  const mt = mean(target);
  let numerator = 0;
  let denominator = 0;
  source.forEach((s, i) => {
    const t = target[i] as Joint;
    numerator += (s.x - ms.x) * (t.x - mt.x) + (s.y - ms.y) * (t.y - mt.y);
    denominator += (s.x - ms.x) ** 2 + (s.y - ms.y) ** 2;
  });
  if (!(denominator > 0) || !(numerator > 0)) return null;
  const k = numerator / denominator;
  return { a: k, b: 0, c: 0, d: k, tx: mt.x - k * ms.x, ty: mt.y - k * ms.y };
}

/** Similarity (rotation, uniform scale, translation, no reflection), the 2D Umeyama solution. */
export function fitSimilarity(source: readonly Joint[], target: readonly Joint[]): Affine | null {
  if (source.length < 2 || source.length !== target.length) return null;
  const ms = mean(source);
  const mt = mean(target);
  let sxx = 0;
  let sxy = 0;
  let variance = 0;
  source.forEach((s, i) => {
    const t = target[i] as Joint;
    const px = s.x - ms.x;
    const py = s.y - ms.y;
    const qx = t.x - mt.x;
    const qy = t.y - mt.y;
    sxx += px * qx + py * qy;
    sxy += px * qy - py * qx;
    variance += px * px + py * py;
  });
  const norm = Math.hypot(sxx, sxy);
  if (!(variance > 0) || !(norm > 0)) return null;
  const k = norm / variance;
  const cos = sxx / norm;
  const sin = sxy / norm;
  const a = k * cos;
  const c = k * sin;
  return { a, b: -c, c, d: a, tx: mt.x - (a * ms.x - c * ms.y), ty: mt.y - (c * ms.x + a * ms.y) };
}

/** General affine map (non-uniform scale, shear, rotation, reflection). Null with fewer than 3 points or collinear points. */
export function fitAffine(source: readonly Joint[], target: readonly Joint[]): Affine | null {
  if (source.length < 3 || source.length !== target.length) return null;
  const ms = mean(source);
  const mt = mean(target);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let uxx = 0;
  let uxy = 0;
  let vxx = 0;
  let vxy = 0;
  source.forEach((s, i) => {
    const t = target[i] as Joint;
    const x = s.x - ms.x;
    const y = s.y - ms.y;
    const u = t.x - mt.x;
    const v = t.y - mt.y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    uxx += u * x;
    uxy += u * y;
    vxx += v * x;
    vxy += v * y;
  });
  const det = sxx * syy - sxy * sxy;
  if (!(Math.abs(det) > 1e-9 * Math.max(1, sxx * syy))) return null;
  const a = (uxx * syy - uxy * sxy) / det;
  const b = (uxy * sxx - uxx * sxy) / det;
  const c = (vxx * syy - vxy * sxy) / det;
  const d = (vxy * sxx - vxx * sxy) / det;
  return { a, b, c, d, tx: mt.x - (a * ms.x + b * ms.y), ty: mt.y - (c * ms.x + d * ms.y) };
}

/** Singular values (largest first), rotation angle of the linear part (degrees), and the determinant. A negative determinant is a reflection. */
export function decompose(m: Affine): { readonly s1: number; readonly s2: number; readonly rotationDegrees: number; readonly determinant: number } {
  const e = (m.a + m.d) / 2;
  const f = (m.a - m.d) / 2;
  const g = (m.c + m.b) / 2;
  const h = (m.c - m.b) / 2;
  const q = Math.hypot(e, h);
  const r = Math.hypot(f, g);
  return { s1: q + r, s2: Math.abs(q - r), rotationDegrees: (Math.atan2(h, e) * 180) / Math.PI, determinant: m.a * m.d - m.b * m.c };
}

/** The exact affine map of one triangle to another. Null for a degenerate source triangle. */
export function triangleAffine(source: readonly [Joint, Joint, Joint], target: readonly [Joint, Joint, Joint]): Affine | null {
  const [p0, p1, p2] = source;
  const [q0, q1, q2] = target;
  const x1 = p1.x - p0.x;
  const y1 = p1.y - p0.y;
  const x2 = p2.x - p0.x;
  const y2 = p2.y - p0.y;
  const det = x1 * y2 - x2 * y1;
  if (Math.abs(det) < 1e-9) return null;
  const u1 = q1.x - q0.x;
  const v1 = q1.y - q0.y;
  const u2 = q2.x - q0.x;
  const v2 = q2.y - q0.y;
  const a = (u1 * y2 - u2 * y1) / det;
  const b = (u2 * x1 - u1 * x2) / det;
  const c = (v1 * y2 - v2 * y1) / det;
  const d = (v2 * x1 - v1 * x2) / det;
  return { a, b, c, d, tx: q0.x - (a * p0.x + b * p0.y), ty: q0.y - (c * p0.x + d * p0.y) };
}

/** Angle of the direction from a to b, in degrees, with y down (0 = image right, 90 = image down). */
export const directionDegrees = (a: Joint, b: Joint): number => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

/** Smallest signed difference of two angles in degrees, in (-180, 180]. */
export function angleDifference(a: number, b: number): number {
  let value = (a - b) % 360;
  if (value <= -180) value += 360;
  if (value > 180) value -= 360;
  return value;
}

const distanceToLine = (p: Joint, a: Joint, b: Joint): number => {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / length;
};

export type BendFit = {
  /** Index into the polyline of the best break point. */
  readonly index: number;
  readonly point: Joint;
  /** Turn angle at the break, in degrees (0 = straight). */
  readonly bendDegrees: number;
  /** Mean distance of the points to the one straight line from the first to the last point. */
  readonly straightError: number;
  /** Mean distance of the points to the two lines through the break point. */
  readonly bentError: number;
};

/**
 * Finds the break point of a polyline that best fits two straight segments from the first point to the break and from the break to the last point.
 * Only points with at least `margin` points on each side are tried. Null when the polyline is too short.
 */
export function fitBend(points: readonly Joint[], margin = 5): BendFit | null {
  if (points.length < 2 * margin + 1) return null;
  const first = points[0] as Joint;
  const last = points.at(-1) as Joint;
  const straightError = points.reduce((sum, p) => sum + distanceToLine(p, first, last), 0) / points.length;
  let best: BendFit | null = null;
  for (let index = margin; index < points.length - margin; index += 1) {
    const point = points[index] as Joint;
    let error = 0;
    points.forEach((p, i) => {
      error += i <= index ? distanceToLine(p, first, point) : distanceToLine(p, point, last);
    });
    error /= points.length;
    if (!best || error < best.bentError) {
      const bendDegrees = Math.abs(angleDifference(directionDegrees(point, last), directionDegrees(first, point)));
      best = { index, point, bendDegrees, straightError, bentError: error };
    }
  }
  return best;
}
