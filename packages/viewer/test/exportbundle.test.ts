import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { attachmentImages, exportReport, parseAtlas, pngSize, readExport, ViewerError } from '@viewer/exportbundle';
import { describe, expect, it } from 'vitest';

import { png, syntheticAtlas, syntheticExport, syntheticSkeleton } from './helpers';

const codeOf = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    if (error instanceof ViewerError) return error.code;
    throw error;
  }
  return 'no error';
};

const withSkeleton = (edit: (skeleton: Record<string, unknown>) => void): string =>
  syntheticExport((files) => {
    const skeleton = syntheticSkeleton();
    edit(skeleton);
    files.set('character.json', JSON.stringify(skeleton));
  });

describe('export folder checks', () => {
  it('reads a valid export once and reports names, sizes, hashes, and animations', () => {
    const folder = syntheticExport();
    const bundle = readExport(folder);
    expect(bundle.skeleton.name).toBe('character.json');
    expect(bundle.skeleton.animations).toEqual(['idle', 'wave']);
    expect(bundle.skeleton.spine).toBe('4.3.26');
    expect(bundle.atlas.regions).toBe(2);
    expect(bundle.pages.map(({ name, width, height }) => ({ name, width, height }))).toEqual([{ name: 'parts.png', width: 256, height: 64 }]);
    const report = exportReport(bundle);
    expect(JSON.stringify(report)).not.toContain('"data"');
    expect((report.skeleton as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    // The export folder is not changed.
    expect(readFileSync(join(folder, 'character.atlas'), 'utf8')).toBe(syntheticAtlas);
  });

  it('refuses a missing folder, a missing atlas, and a missing page image', () => {
    expect(codeOf(() => readExport('/nonexistent/aigg-viewer-folder'))).toBe('E_FOLDER_MISSING');
    const noAtlas = syntheticExport((files) => files.delete('character.atlas'));
    expect(codeOf(() => readExport(noAtlas))).toBe('E_FILE_MISSING');
    const noPage = syntheticExport((files) => files.delete('parts.png'));
    expect(codeOf(() => readExport(noPage))).toBe('E_FILE_MISSING');
  });

  it('asks for a selection when the folder has two skeleton files, and accepts --skeleton', () => {
    const folder = syntheticExport((files) => files.set('other.json', '{}'));
    expect(codeOf(() => readExport(folder))).toBe('E_AMBIGUOUS');
    expect(readExport(folder, { skeleton: 'character.json' }).skeleton.name).toBe('character.json');
    expect(codeOf(() => readExport(folder, { skeleton: 'other.json' }))).toBe('E_SKELETON_JSON');
  });

  it('refuses another Spine version, missing animations, and attachments without an atlas region', () => {
    expect(codeOf(() => readExport(withSkeleton((skeleton) => ((skeleton.skeleton as Record<string, unknown>).spine = '4.2.43'))))).toBe('E_SPINE_VERSION');
    expect(codeOf(() => readExport(withSkeleton((skeleton) => delete (skeleton.animations as Record<string, unknown>).wave)))).toBe('E_ANIMATION_MISSING');
    expect(codeOf(() => readExport(syntheticExport((files) => files.set('character.atlas', syntheticAtlas.replace('arm\n', 'hand\n')))))).toBe('E_REGION_MISSING');
    expect(codeOf(() => readExport(syntheticExport((files) => files.set('character.json', '{not json'))))).toBe('E_SKELETON_JSON');
  });

  it('refuses page names with folder parts, symbolic links, non-PNG pages, and a size that differs from the atlas', () => {
    const parent = syntheticExport((files) => files.set('character.atlas', syntheticAtlas.replace('parts.png', '../parts.png')));
    expect(codeOf(() => readExport(parent))).toBe('E_FILE_NAME');
    const linked = syntheticExport();
    const outside = syntheticExport();
    unlinkSync(join(linked, 'parts.png'));
    symlinkSync(join(outside, 'parts.png'), join(linked, 'parts.png'));
    expect(codeOf(() => readExport(linked))).toBe('E_FILE_LINK');
    expect(codeOf(() => readExport(syntheticExport((files) => files.set('parts.png', 'not a png'))))).toBe('E_PAGE_PNG');
    expect(
      codeOf(() =>
        readExport(
          syntheticExport((files) =>
            files.set(
              'parts.png',
              png(16, 16, () => [0, 0, 0, 255])
            )
          )
        )
      )
    ).toBe('E_PAGE_SIZE');
    const folderPage = syntheticExport((files) => files.delete('parts.png'));
    mkdirSync(join(folderPage, 'parts.png'));
    expect(codeOf(() => readExport(folderPage))).toBe('E_FILE_TYPE');
  });

  it('refuses a page image that is too large before it is decoded', () => {
    const folder = syntheticExport();
    const big = png(1, 1, () => [0, 0, 0, 255]);
    big.writeUInt32BE(20000, 16);
    writeFileSync(join(folder, 'parts.png'), big);
    writeFileSync(join(folder, 'character.atlas'), syntheticAtlas.replace('size:256,64', 'size:20000,1'));
    expect(codeOf(() => readExport(folder))).toBe('E_PAGE_SIZE');
  });
});

describe('atlas, PNG, and attachment helpers', () => {
  it('parses Spine 4 atlas pages and regions', () => {
    const text = `\uFEFFa.png\nsize:4,2\nfilter:Linear,Linear\nx\nbounds:0,0,1,1\ny\nbounds:1,0,1,1\n\nb.png\nsize:8,8\nz\nbounds:0,0,2,2\n`;
    expect(parseAtlas(text)).toEqual({
      pages: [
        { name: 'a.png', size: [4, 2] },
        { name: 'b.png', size: [8, 8] }
      ],
      regions: ['x', 'y', 'z']
    });
    expect(() => parseAtlas('size:1,1\n')).toThrow(ViewerError);
  });

  it('reads the PNG size without decoding and rejects other data', () => {
    expect(pngSize(png(7, 3, () => [1, 2, 3, 4]))).toEqual({ width: 7, height: 3 });
    expect(pngSize(Buffer.from('GIF89a'))).toBeNull();
  });

  it('lists the images of region and mesh attachments, with path before name', () => {
    expect(
      attachmentImages({
        skins: [{ name: 'default', attachments: { a: { one: {}, two: { path: 'p2' }, box: { type: 'boundingbox' }, mesh: { type: 'mesh', name: 'm' } } } }]
      })
    ).toEqual(['m', 'one', 'p2']);
  });
});
