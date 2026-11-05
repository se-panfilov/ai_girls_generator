// A small 8-bit RGBA raster with deterministic drawing. Coordinates are pixels, Y down, origin at the top-left corner.
// Shapes are filled by pixel centers (x + 0.5, y + 0.5). The result is not bit-exact to OpenCV, but uses the same geometry rules.

export type Color = readonly [number, number, number, number];
export type Point = { readonly x: number; readonly y: number };

export class Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number, fill: Color = [0, 0, 0, 0]) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new RangeError('The raster size must be positive integers.');
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i += 1) this.data.set(fill, i * 4);
  }

  /** RGBA value at a pixel. Outside pixels give transparent black. */
  pixel(x: number, y: number): Color {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return [0, 0, 0, 0];
    const i = (y * this.width + x) * 4;
    return [this.data[i] ?? 0, this.data[i + 1] ?? 0, this.data[i + 2] ?? 0, this.data[i + 3] ?? 0];
  }

  /** Source-over blend of one pixel with straight alpha. An opaque color replaces the pixel. */
  blend(x: number, y: number, color: Color): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const sa = color[3] / 255;
    if (sa >= 1) {
      this.data.set(color, i);
      return;
    }
    if (sa <= 0) return;
    const da = (this.data[i + 3] ?? 0) / 255;
    const oa = sa + da * (1 - sa);
    for (let c = 0; c < 3; c += 1) {
      const value = ((color[c] ?? 0) * sa + (this.data[i + c] ?? 0) * da * (1 - sa)) / oa;
      this.data[i + c] = Math.round(value);
    }
    this.data[i + 3] = Math.round(oa * 255);
  }

  /** Fills a polygon with the even-odd rule at pixel centers. */
  fillPolygon(points: readonly Point[], color: Color): void {
    if (points.length < 3) return;
    const ys = points.map((point) => point.y);
    const top = Math.max(0, Math.floor(Math.min(...ys)));
    const bottom = Math.min(this.height - 1, Math.ceil(Math.max(...ys)));
    for (let y = top; y <= bottom; y += 1) {
      const cy = y + 0.5;
      const crossings: number[] = [];
      for (let i = 0; i < points.length; i += 1) {
        const a = points[i] as Point;
        const b = points[(i + 1) % points.length] as Point;
        if (a.y <= cy !== b.y <= cy) crossings.push(a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
      crossings.sort((left, right) => left - right);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const from = Math.max(0, Math.ceil((crossings[k] as number) - 0.5));
        const to = Math.min(this.width - 1, Math.floor((crossings[k + 1] as number) - 0.5));
        for (let x = from; x <= to; x += 1) this.blend(x, y, color);
      }
    }
  }

  /** Fills a circle. A pixel is inside when its center is at radius or less. */
  fillCircle(center: Point, radius: number, color: Color): void {
    const r2 = radius * radius;
    for (let y = Math.max(0, Math.floor(center.y - radius)); y <= Math.min(this.height - 1, Math.ceil(center.y + radius)); y += 1) {
      for (let x = Math.max(0, Math.floor(center.x - radius)); x <= Math.min(this.width - 1, Math.ceil(center.x + radius)); x += 1) {
        const dx = x + 0.5 - center.x;
        const dy = y + 0.5 - center.y;
        if (dx * dx + dy * dy <= r2) this.blend(x, y, color);
      }
    }
  }

  /** Draws a line segment of a width as a filled quadrilateral. */
  line(a: Point, b: Point, width: number, color: Color): void {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length === 0) {
      this.fillCircle(a, width / 2, color);
      return;
    }
    const nx = (-(b.y - a.y) / length) * (width / 2);
    const ny = ((b.x - a.x) / length) * (width / 2);
    this.fillPolygon(
      [
        { x: a.x + nx, y: a.y + ny },
        { x: b.x + nx, y: b.y + ny },
        { x: b.x - nx, y: b.y - ny },
        { x: a.x - nx, y: a.y - ny }
      ],
      color
    );
  }

  /** Draws the outline of a rectangle. */
  strokeRect(x: number, y: number, w: number, h: number, width: number, color: Color): void {
    this.fillPolygon(rectangle(x, y, w, width), color);
    this.fillPolygon(rectangle(x, y + h - width, w, width), color);
    this.fillPolygon(rectangle(x, y + width, width, h - 2 * width), color);
    this.fillPolygon(rectangle(x + w - width, y + width, width, h - 2 * width), color);
  }

  /** Composites another raster at an integer offset, with an extra opacity from 0 to 1. */
  draw(source: Raster, dx: number, dy: number, opacity = 1): void {
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const [r, g, b, a] = source.pixel(x, y);
        this.blend(x + dx, y + dy, [r, g, b, Math.round(a * opacity)]);
      }
    }
  }
}

function rectangle(x: number, y: number, w: number, h: number): Point[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h }
  ];
}

/**
 * Points of an ellipse polygon, as OpenCV `ellipse2Poly(center, axes, angle, 0, 360, delta)` makes them.
 * The angle is in whole degrees. Each point is rounded to an integer, and repeated points are removed.
 */
export function ellipsePolygon(center: Point, axes: { readonly a: number; readonly b: number }, angleDegrees: number, delta = 1): Point[] {
  let angle = Math.round(angleDegrees);
  while (angle < 0) angle += 360;
  while (angle > 360) angle -= 360;
  const alpha = Math.cos((angle * Math.PI) / 180);
  const beta = Math.sin((angle * Math.PI) / 180);
  const points: Point[] = [];
  for (let step = 0; step < 360 + delta; step += delta) {
    const t = (Math.min(step, 360) * Math.PI) / 180;
    const x = axes.a * Math.cos(t);
    const y = axes.b * Math.sin(t);
    const point = { x: Math.round(center.x + x * alpha - y * beta), y: Math.round(center.y + x * beta + y * alpha) };
    const last = points.at(-1);
    if (!last || last.x !== point.x || last.y !== point.y) points.push(point);
  }
  return points;
}
