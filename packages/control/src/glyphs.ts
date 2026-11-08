import type { Color, Raster } from '@control/raster';

// A small 5 x 7 bitmap font for labels in review images. Lowercase letters, digits, and a few signs.
// Drawing is deterministic: each font pixel is a filled square. Characters without a glyph are drawn as a box.

const rows: Readonly<Record<string, string>> = {
  a: '00000 00000 01110 00001 01111 10001 01111',
  b: '10000 10000 10110 11001 10001 10001 11110',
  c: '00000 00000 01110 10000 10000 10001 01110',
  d: '00001 00001 01101 10011 10001 10001 01111',
  e: '00000 00000 01110 10001 11111 10000 01110',
  f: '00110 01001 01000 11100 01000 01000 01000',
  g: '00000 01111 10001 10001 01111 00001 01110',
  h: '10000 10000 10110 11001 10001 10001 10001',
  i: '00100 00000 01100 00100 00100 00100 01110',
  j: '00010 00000 00110 00010 00010 10010 01100',
  k: '10000 10000 10010 10100 11000 10100 10010',
  l: '01100 00100 00100 00100 00100 00100 01110',
  m: '00000 00000 11010 10101 10101 10001 10001',
  n: '00000 00000 10110 11001 10001 10001 10001',
  o: '00000 00000 01110 10001 10001 10001 01110',
  p: '00000 11110 10001 10001 11110 10000 10000',
  q: '00000 01111 10001 10001 01111 00001 00001',
  r: '00000 00000 10110 11001 10000 10000 10000',
  s: '00000 00000 01111 10000 01110 00001 11110',
  t: '01000 01000 11100 01000 01000 01001 00110',
  u: '00000 00000 10001 10001 10001 10011 01101',
  v: '00000 00000 10001 10001 10001 01010 00100',
  w: '00000 00000 10001 10001 10101 10101 01010',
  x: '00000 00000 10001 01010 00100 01010 10001',
  y: '00000 10001 10001 10001 01111 00001 01110',
  z: '00000 00000 11111 00010 00100 01000 11111',
  '0': '01110 10001 10011 10101 11001 10001 01110',
  '1': '00100 01100 00100 00100 00100 00100 01110',
  '2': '01110 10001 00001 00010 00100 01000 11111',
  '3': '11111 00010 00100 00010 00001 10001 01110',
  '4': '00010 00110 01010 10010 11111 00010 00010',
  '5': '11111 10000 11110 00001 00001 10001 01110',
  '6': '00110 01000 10000 11110 10001 10001 01110',
  '7': '11111 00001 00010 00100 01000 01000 01000',
  '8': '01110 10001 10001 01110 10001 10001 01110',
  '9': '01110 10001 10001 01111 00001 00010 01100',
  _: '00000 00000 00000 00000 00000 00000 11111',
  '-': '00000 00000 00000 11111 00000 00000 00000',
  '.': '00000 00000 00000 00000 00000 00000 01100',
  ':': '00000 01100 01100 00000 01100 01100 00000',
  '/': '00001 00010 00010 00100 01000 01000 10000',
  '=': '00000 00000 11111 00000 11111 00000 00000',
  ',': '00000 00000 00000 00000 00110 00100 01000',
  '(': '00010 00100 01000 01000 01000 00100 00010',
  ')': '01000 00100 00010 00010 00010 00100 01000',
  ' ': '00000 00000 00000 00000 00000 00000 00000'
};

const box = '11111 10001 10001 10001 10001 10001 11111';

/** Width in pixels of a text at a scale: 6 font pixels for each character (5 and a gap). */
export const textWidth = (text: string, scale: number): number => text.length * 6 * scale;
export const textHeight = (scale: number): number => 7 * scale;

/** Draws text with its top-left corner at (x, y). Uppercase letters are drawn as lowercase. An optional background box makes it readable on images. */
export function drawText(raster: Raster, text: string, x: number, y: number, scale: number, color: Color, background?: Color): void {
  const left = Math.round(x);
  const top = Math.round(y);
  if (background) {
    for (let py = top - scale; py < top + textHeight(scale) + scale; py += 1) {
      for (let px = left - scale; px < left + textWidth(text, scale); px += 1) raster.blend(px, py, background);
    }
  }
  const lower = text.toLowerCase();
  for (let index = 0; index < lower.length; index += 1) {
    const glyph = (rows[lower.charAt(index)] ?? box).split(' ');
    for (const [row, bits] of glyph.entries()) {
      for (let column = 0; column < 5; column += 1) {
        if (bits[column] !== '1') continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) raster.blend(left + (index * 6 + column) * scale + dx, top + row * scale + dy, color);
        }
      }
    }
  }
}
