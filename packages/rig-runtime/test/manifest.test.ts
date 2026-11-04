import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createManifest, formatManifest, isPlatformMetadata, parseManifest, verifyManifest } from '@rig-runtime/manifest';
import { seededRandom } from '@rig-runtime/modules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
// The five game asset files of the owner L1-04 snapshot (synthetic bytes here; the real files are checked in the gate bench).
const assets = ['skeleton.json', 'a/a.atlas', 'a/a.png', 'b/b.atlas', 'b/b.png'];

let root: string;
const write = (path: string, data: string | Buffer): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
};
/** Makes the layout of the owner run: before-c/ and the later editor-out/ with c/ and changed Finder metadata. */
function ownerLayout(): { before: string; after: string } {
  const before = join(root, 'editor out ü', 'before-c');
  const after = join(root, 'editor out ü');
  for (const [index, path] of assets.entries()) {
    const bytes = Buffer.from(`asset ${index} ${path}\n`.repeat(50 + index));
    write(join(before, path), bytes);
    write(join(after, path), bytes);
  }
  write(join(before, '.DS_Store'), 'finder state 1');
  write(join(before, '._.DS_Store'), 'appledouble 1');
  write(join(after, '.DS_Store'), 'finder state 2 after packing C');
  write(join(after, '._.DS_Store'), 'appledouble 2');
  write(join(after, 'c', 'c.atlas'), 'new character C');
  write(join(after, 'c', 'c.png'), 'png C');
  return { before, after };
}
const runCli = (args: string[]): { status: number | null; report: Record<string, unknown> } => {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', shell: false });
  return { status: result.status, report: JSON.parse(result.stdout) as Record<string, unknown> };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aigg manifest '));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('platform metadata policy', () => {
  it('skips only .DS_Store and AppleDouble files', () => {
    expect(['.DS_Store', 'a/.DS_Store', '._a.png', 'x/._.DS_Store'].every(isPlatformMetadata)).toBe(true);
    expect(['a.png', '.hidden/a.png', 'DS_Store', '.DS_Store.png', 'a._b', 'Thumbs.db', '.gitkeep'].some(isPlatformMetadata)).toBe(false);
  });
});

describe('L1-04 hash invariance (P1)', () => {
  it('passes when A, B and the skeleton are unchanged and only Finder metadata changed', () => {
    const { before, after } = ownerLayout();
    const snapshot = createManifest(before);
    expect(snapshot.entries.map((entry) => entry.path)).toEqual(['a/a.atlas', 'a/a.png', 'b/b.atlas', 'b/b.png', 'skeleton.json']);
    expect(snapshot.ignored).toEqual(['.DS_Store', '._.DS_Store']);
    const result = verifyManifest(after, snapshot.entries);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(5);
    expect(result.added).toContain('c/c.atlas');
  });

  it('passes with nested metadata files', () => {
    const { before, after } = ownerLayout();
    const snapshot = createManifest(before);
    write(join(after, 'a', '.DS_Store'), 'nested');
    write(join(after, 'b', '._b.png'), 'nested appledouble');
    expect(verifyManifest(after, snapshot.entries, false).ok).toBe(true);
  });

  it('skips a .DS_Store entry of an old v4 manifest and reports it', () => {
    const { before, after } = ownerLayout();
    const old = `${formatManifest(createManifest(before).entries)}${'0'.repeat(64)}  ./.DS_Store\n`;
    const result = verifyManifest(after, parseManifest(old));
    expect(result.ok).toBe(true);
    expect(result.ignored).toContain('.DS_Store');
  });

  it.each(assets)('fails on a 1-byte change of %s and names the file', (path) => {
    const { before, after } = ownerLayout();
    const snapshot = createManifest(before);
    const full = join(after, path);
    const bytes = readFileSync(full);
    const offset = Math.floor(seededRandom(path.length)() * bytes.length);
    bytes[offset] = (bytes[offset] ?? 0) ^ 1;
    writeFileSync(full, bytes);
    const result = verifyManifest(after, snapshot.entries);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ code: 'E_CHECKSUM', subject: path })]);
  });

  it('fails when a game asset file disappears', () => {
    const { before, after } = ownerLayout();
    const snapshot = createManifest(before);
    rmSync(join(after, 'b', 'b.atlas'));
    expect(verifyManifest(after, snapshot.entries).problems).toEqual([expect.objectContaining({ code: 'E_MISSING', subject: 'b/b.atlas' })]);
  });

  it('hashes hidden files that are not metadata, and strict mode reports new files', () => {
    const { before } = ownerLayout();
    write(join(before, '.hidden', 'x.png'), 'hidden asset');
    const snapshot = createManifest(before);
    expect(snapshot.entries.map((entry) => entry.path)).toContain('.hidden/x.png');
    write(join(before, '.hidden', 'x.png'), 'changed hidden asset');
    expect(verifyManifest(before, snapshot.entries).problems[0]?.code).toBe('E_CHECKSUM');
    write(join(before, 'new.atlas'), 'new');
    expect(verifyManifest(before, snapshot.entries, true).problems.map((item) => item.code)).toEqual(['E_CHECKSUM', 'E_UNEXPECTED_FILE']);
  });

  it('rejects symbolic links and unsafe manifest paths', () => {
    const { before } = ownerLayout();
    symlinkSync(join(before, 'skeleton.json'), join(before, 'link.json'));
    expect(() => createManifest(before)).toThrow(/E_SYMLINK/);
    for (const line of [`${'a'.repeat(64)}  ../x`, `${'a'.repeat(64)}  /etc/x`, `${'a'.repeat(64)}  ./a\\b`, 'bad line']) {
      expect(() => parseManifest(`${line}\n`)).toThrow(/E_MANIFEST_FORMAT/);
    }
  });
});

describe('aigg-rig-runtime CLI', () => {
  it('runs the L1-04 check on a path with spaces and non-ASCII letters', () => {
    const { before, after } = ownerLayout();
    const pass = runCli(['hash-invariance', before, after]);
    expect(pass.status).toBe(0);
    expect(pass.report).toMatchObject({ status: 'PASS', checked: 5 });
    writeFileSync(join(after, 'a', 'a.png'), 'mutated');
    const fail = runCli(['hash-invariance', before, after]);
    expect(fail.status).toBe(1);
    expect(fail.report.problems).toEqual([expect.objectContaining({ code: 'E_CHECKSUM', subject: 'a/a.png' })]);
  });

  it('writes a manifest only outside the input folder, never replaces a file silently, and supports a dry run', () => {
    const { before } = ownerLayout();
    const out = join(root, 'before.sha256');
    expect(runCli(['manifest', before, out, '--dry-run']).report).toMatchObject({ status: 'PASS', written: false });
    expect(existsSync(out)).toBe(false);
    expect(runCli(['manifest', before, out]).status).toBe(0);
    expect(readFileSync(out, 'utf8')).not.toContain('.DS_Store');
    expect(runCli(['manifest', before, out])).toMatchObject({ status: 2, report: { status: 'ERROR' } });
    expect(runCli(['manifest', before, join(before, 'inside.sha256')]).status).toBe(2);
    expect(runCli(['verify', before, out, '--strict']).report).toMatchObject({ status: 'PASS', checked: 5 });
    expect(runCli(['verify', before, out, '--bad']).status).toBe(2);
  });
});
