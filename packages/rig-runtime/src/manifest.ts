import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

import { type Problem, problem, RigRuntimeError, show } from '@rig-runtime/problems';

// SHA-256 manifests of exported game assets (skeleton JSON, atlas text, page images).
// Exclusion policy: only operating system metadata files are skipped, by exact file name rule:
//   - `.DS_Store` (macOS Finder view settings), in any directory;
//   - `._*` (macOS AppleDouble files that hold extended attributes on non-HFS volumes and in archives), in any directory.
// Every other file is hashed, also hidden files and files in hidden directories. A symbolic link is an error.

export type ManifestEntry = { readonly path: string; readonly sha256: string };
export type VerifyResult = {
  readonly ok: boolean;
  readonly checked: number;
  readonly problems: readonly Problem[];
  /** Files that the policy skipped (metadata). They are reported, never hashed. */
  readonly ignored: readonly string[];
  /** Files on disk that the manifest does not list. In strict mode they are E_UNEXPECTED_FILE problems. */
  readonly added: readonly string[];
};

/** True for operating system metadata that is not game asset content. */
export function isPlatformMetadata(relativePath: string): boolean {
  const name = relativePath.split('/').pop() ?? '';
  return name === '.DS_Store' || name.startsWith('._');
}

const compareBytes = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right));

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Lists files under `dir` with POSIX relative paths, sorted by UTF-8 bytes. Symbolic links and special files stop the walk. */
export function listFiles(dir: string): { files: string[]; ignored: string[] } {
  const files: string[] = [];
  const ignored: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = relative(dir, full).split(sep).join(posix.sep);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new RigRuntimeError([problem('E_SYMLINK', `${show(rel)} is a symbolic link. Asset folders must hold regular files only.`, rel)]);
      if (stat.isDirectory()) walk(full);
      else if (!stat.isFile()) throw new RigRuntimeError([problem('E_SPECIAL_FILE', `${show(rel)} is not a regular file.`, rel)]);
      else if (isPlatformMetadata(rel)) ignored.push(rel);
      else files.push(rel);
    }
  };
  walk(dir);
  return { files: files.sort(compareBytes), ignored: ignored.sort(compareBytes) };
}

/** Makes a manifest of every asset file under `dir`. */
export function createManifest(dir: string): { entries: ManifestEntry[]; ignored: string[] } {
  const { files, ignored } = listFiles(dir);
  return { entries: files.map((path) => ({ path, sha256: sha256File(join(dir, ...path.split('/'))) })), ignored };
}

/** sha256sum-compatible text: `<hash>  ./<path>` per line. */
export function formatManifest(entries: readonly ManifestEntry[]): string {
  return entries.map((entry) => `${entry.sha256}  ./${entry.path}\n`).join('');
}

const manifestLine = /^([0-9a-f]{64}) [ *](.+)$/;
const hasUnsafeCharacter = (path: string): boolean => {
  for (let index = 0; index < path.length; index += 1) if (path.charCodeAt(index) < 0x20 || path[index] === '\\') return true;
  return false;
};

/** Parses sha256sum text. Paths must be relative, without `..`, backslash or control characters. */
export function parseManifest(text: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const seen = new Set<string>();
  for (const [index, line] of text.split('\n').entries()) {
    if (line === '') continue;
    const match = manifestLine.exec(line);
    const path = match?.[2]?.replace(/^\.\//, '');
    if (!match || !path || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '' || part === '.') || hasUnsafeCharacter(path)) {
      throw new RigRuntimeError([problem('E_MANIFEST_FORMAT', `Line ${index + 1} of the manifest is not "<sha256>  ./<relative path>".`)]);
    }
    if (seen.has(path)) throw new RigRuntimeError([problem('E_MANIFEST_FORMAT', `The manifest lists ${show(path)} more than once.`)]);
    seen.add(path);
    entries.push({ path, sha256: match[1] ?? '' });
  }
  return entries;
}

/**
 * Verifies `dir` against a manifest. Every listed asset file must exist with the same hash (E_CHECKSUM, E_MISSING).
 * A listed metadata file (from an old manifest) is skipped and reported in `ignored`.
 * `strict` also fails on asset files that the manifest does not list (E_UNEXPECTED_FILE).
 */
export function verifyManifest(dir: string, entries: readonly ManifestEntry[], strict = false): VerifyResult {
  const problems: Problem[] = [];
  const { files, ignored } = listFiles(dir);
  const onDisk = new Set(files);
  const listed = new Set<string>();
  const skipped = new Set(ignored);
  let checked = 0;
  for (const entry of entries) {
    listed.add(entry.path);
    if (isPlatformMetadata(entry.path)) {
      skipped.add(entry.path);
      continue;
    }
    checked += 1;
    if (!onDisk.has(entry.path)) problems.push(problem('E_MISSING', `${show(entry.path)} is listed but not found.`, entry.path));
    else if (sha256File(join(dir, ...entry.path.split('/'))) !== entry.sha256) problems.push(problem('E_CHECKSUM', `${show(entry.path)} changed.`, entry.path));
  }
  const added = files.filter((path) => !listed.has(path));
  if (strict) for (const path of added) problems.push(problem('E_UNEXPECTED_FILE', `${show(path)} is not in the manifest.`, path));
  return { ok: problems.length === 0, checked, problems, ignored: [...skipped].sort(compareBytes), added };
}
