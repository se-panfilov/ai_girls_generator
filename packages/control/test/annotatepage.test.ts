import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { landmarkFormat } from '@control/alignstudy';
import { annotatePageCommand, parseAutomaticLandmarks, scriptJson } from '@control/annotatepage';
import { encodePng, sha256 } from '@control/png';
import { ControlError } from '@control/problems';
import { Raster } from '@control/raster';
import { describe, expect, it } from 'vitest';

import { temporaryDirectory } from './helpers';

// L0-1d annotate-page tests with a synthetic image and synthetic automatic landmarks.

const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const pageCode = (): Buffer => readFileSync(fileURLToPath(new URL('../dist/src/annotator.js', import.meta.url)));
const frame = { width: 64, height: 96 };
const image = encodePng(new Raster(frame.width, frame.height, [200, 200, 200, 255]));

const automatic = (overrides: Record<string, unknown> = {}): Buffer =>
  Buffer.from(
    JSON.stringify({
      format: landmarkFormat,
      frame,
      landmarks: [
        { id: 'nose', point: { x: 30, y: 10 }, range: null, visibility: 'visible', confidence: 'high', method: 'layer centroid', note: '</script><script>alert(1)</script>' },
        { id: 'hip_image_left', point: null, range: { left: 10, top: 40, right: 50, bottom: 60 }, visibility: 'unknown', confidence: 'none', method: 'range', note: 'skirt' }
      ],
      regions: [{ id: 'skirt', range: { left: 5, top: 35, right: 60, bottom: 65 }, reason: 'skirt' }],
      ...overrides
    })
  );

const codeOf = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    if (error instanceof ControlError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

describe('parseAutomaticLandmarks', () => {
  it('reads the align-study landmarks and refuses invalid files', () => {
    const parsed = parseAutomaticLandmarks(automatic());
    expect(parsed.frame).toEqual(frame);
    expect(parsed.landmarks).toHaveLength(2);
    expect(codeOf(() => parseAutomaticLandmarks(Buffer.from('{')))).toBe('E_LANDMARKS');
    expect(codeOf(() => parseAutomaticLandmarks(automatic({ format: 'x' })))).toBe('E_LANDMARKS');
    expect(codeOf(() => parseAutomaticLandmarks(automatic({ landmarks: [{ id: 'nose', point: { x: 999, y: 1 }, visibility: 'visible', confidence: 'high' }] })))).toBe('E_LANDMARKS');
    expect(codeOf(() => parseAutomaticLandmarks(automatic({ landmarks: [{ id: 'nose', point: { x: 1, y: 1 }, visibility: 'unknown', confidence: 'none' }] })))).toBe('E_LANDMARKS');
    expect(codeOf(() => parseAutomaticLandmarks(automatic({ landmarks: [{ id: 'tail', point: null, visibility: 'unknown', confidence: 'none' }] })))).toBe('E_LANDMARKS');
  });
});

describe('annotatePageCommand', () => {
  it('writes one self-contained, deterministic page without external references', () => {
    const first = annotatePageCommand({ imageBytes: image, imageName: 'src.png', landmarkBytes: automatic(), pageCode: pageCode(), toolVersion: '0' });
    const second = annotatePageCommand({ imageBytes: image, imageName: 'src.png', landmarkBytes: automatic(), pageCode: pageCode(), toolVersion: '0' });
    expect(first.files.map((file) => file.name)).toEqual(['annotate.html']);
    expect(sha256(first.files[0]?.bytes ?? Buffer.alloc(0))).toBe(sha256(second.files[0]?.bytes ?? Buffer.alloc(0)));
    const html = first.files[0]?.bytes.toString('utf8') ?? '';
    expect(html).toContain(`data:image/png;base64,${image.toString('base64')}`);
    expect(html).not.toMatch(/(src|href)=["']https?:/);
    expect(html).toContain("connect-src 'none'");
    // The untrusted note cannot close the script element.
    expect(html.match(/<\/script>/g)).toHaveLength(2);
  });

  it('loads earlier manual marks through the reference parser', () => {
    const manual = Buffer.from(JSON.stringify({ format: landmarkFormat, markedBy: 'p', landmarks: [{ id: 'nose', visibility: 'visible', confidence: 'high', x: 31, y: 11, method: 'm', note: 'n' }] }));
    const result = annotatePageCommand({ imageBytes: image, imageName: 'src.png', landmarkBytes: automatic(), manualBytes: manual, pageCode: pageCode(), toolVersion: '0' });
    expect(result.report.priorManualEntries).toBe(1);
    const bad = Buffer.from(JSON.stringify({ format: landmarkFormat, markedBy: 'p', landmarks: [{ id: 'nose', visibility: 'unknown', confidence: 'none', x: 1, y: 1, method: 'm', note: 'n' }] }));
    expect(codeOf(() => annotatePageCommand({ imageBytes: image, imageName: 'src.png', landmarkBytes: automatic(), manualBytes: bad, pageCode: pageCode(), toolVersion: '0' }))).toBe('E_LANDMARKS');
  });

  it('refuses a wrong image size and page code with an import', () => {
    expect(codeOf(() => annotatePageCommand({ imageBytes: encodePng(new Raster(10, 10)), imageName: 'x.png', landmarkBytes: automatic(), pageCode: pageCode(), toolVersion: '0' }))).toBe('E_IMAGE');
    expect(
      codeOf(() => annotatePageCommand({ imageBytes: image, imageName: 'x.png', landmarkBytes: automatic(), pageCode: Buffer.from("import x from 'y';\nfunction start(){}"), toolVersion: '0' }))
    ).toBe('E_INPUT');
  });

  it('escapes script-breaking characters in embedded JSON', () => {
    const text = scriptJson({ a: '</script>&\u2028' });
    expect(text).not.toMatch(/[<>&\u2028]/);
    expect(JSON.parse(text)).toEqual({ a: '</script>&\u2028' });
  });
});

describe('annotate-page CLI', () => {
  it('writes the page and does not change the inputs', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'src.png'), image);
    writeFileSync(join(root, 'landmarks.json'), automatic());
    const before = [sha256(readFileSync(join(root, 'src.png'))), sha256(readFileSync(join(root, 'landmarks.json')))];
    const args = ['annotate-page', '--image', join(root, 'src.png'), '--landmarks', join(root, 'landmarks.json'), '--out', join(root, 'out')];
    expect(spawnSync(process.execPath, [cli, ...args, '--dry-run'], { encoding: 'utf8' }).status).toBe(0);
    expect(() => readdirSync(join(root, 'out'))).toThrow();
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(readdirSync(join(root, 'out'))).toEqual(['annotate.html']);
    expect([sha256(readFileSync(join(root, 'src.png'))), sha256(readFileSync(join(root, 'landmarks.json')))]).toEqual(before);
    expect(spawnSync(process.execPath, [cli, ...args, '--contract', 'x'], { encoding: 'utf8' }).status).toBe(2);
  });
});
