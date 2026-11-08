import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { fail } from '@control/problems';

// File system rules for the CLI.
// - Input files are regular files below a size limit. A symbolic link to a file is read, but its target is reported by the caller's hash only.
// - An output directory is new, or, with --force, an existing real directory (not a symbolic link).
// - A file is written to a new temporary name in the output directory and is renamed. A rename replaces a link itself, so a write never follows a link.

export type PlannedFile = { readonly name: string; readonly bytes: Buffer };

/**
 * Reads an input file through one open file descriptor, so the size check and the read see the same file.
 * The read stops at maxBytes + 1 bytes, so a file that grows after the check is still refused.
 */
export function readInput(path: string, maxBytes: number, label: string): Buffer {
  let fd: number;
  try {
    fd = openSync(resolve(path), 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('E_INPUT', `${label} is not found.`);
    if ((error as NodeJS.ErrnoException).code === 'EISDIR') fail('E_INPUT', `${label} is not a regular file.`);
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) fail('E_INPUT', `${label} is not a regular file.`);
    if (info.size > maxBytes) fail('E_INPUT_TOO_LARGE', `${label} has ${info.size} bytes. The limit is ${maxBytes}.`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
      if (length > maxBytes) fail('E_INPUT_TOO_LARGE', `${label} has more than ${maxBytes} bytes.`);
    }
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/** Checks the output directory. Returns true when it must be created. */
export function checkOutputDirectory(path: string, force: boolean): boolean {
  const full = resolve(path);
  let info;
  try {
    info = lstatSync(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(full);
    try {
      if (!lstatSync(parent).isDirectory()) fail('E_OUTPUT', 'The parent of the output directory is not a directory.');
    } catch (inner) {
      if ((inner as NodeJS.ErrnoException).code === 'ENOENT') fail('E_OUTPUT', 'The parent of the output directory does not exist.');
      throw inner;
    }
    return true;
  }
  if (info.isSymbolicLink()) fail('E_OUTPUT', 'The output directory is a symbolic link. Give a real directory.');
  if (!info.isDirectory()) fail('E_OUTPUT', 'The output path exists and is not a directory.');
  if (!force && readdirSync(full).length > 0) fail('E_OUTPUT_EXISTS', 'The output directory is not empty. Give --force to replace the files with the same names.');
  return false;
}

/**
 * Writes the planned files. The caller checks the directory first.
 * A name can have subdirectories separated by `/`. Each part must be a plain name (no `.`, `..`, or leading dot).
 * An existing subdirectory must be a real directory, not a symbolic link. All names and subdirectories are checked before the first write.
 */
export function writeFiles(path: string, files: readonly PlannedFile[], create: boolean): void {
  const full = resolve(path);
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.name.split('/');
    if (parts.some((part) => part === '' || basename(part) !== part || part.startsWith('.'))) fail('E_OUTPUT', `The file name ${file.name} is not a plain relative name.`);
    for (let depth = 1; depth < parts.length; depth += 1) directories.add(parts.slice(0, depth).join('/'));
  }
  const sorted = [...directories].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
  const missing: string[] = [];
  if (!create) {
    for (const directory of sorted) {
      let info;
      try {
        info = lstatSync(join(full, directory));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        missing.push(directory);
        continue;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) fail('E_OUTPUT', `The output subdirectory ${directory} is not a real directory.`);
    }
  }
  if (create) mkdirSync(full);
  for (const directory of create ? sorted : missing) mkdirSync(join(full, directory));
  for (const file of files) {
    const target = join(full, file.name);
    const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    writeFileSync(temporary, file.bytes, { flag: 'wx' });
    try {
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}
