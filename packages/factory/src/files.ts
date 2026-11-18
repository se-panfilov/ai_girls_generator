import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

// File helpers of the factory: reads without symbolic links, SHA-256 digests, canonical JSON, and atomic JSON writes.
// The factory never changes an input file. It writes only in the job folder.

/** An error with a stable code. The command line prints the code and the message. */
export class FactoryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'FactoryError';
  }
}

export const fail = (code: string, message: string): never => {
  throw new FactoryError(code, message);
};

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

export const shaPattern = /^[0-9a-f]{64}$/;

/** Replaces control characters (C0, C1, line and paragraph separators) with "?" and cuts long text. Use it for text that goes to a terminal. */
export function safeText(value: unknown, max = 300): string {
  const input = String(value);
  let text = '';
  for (let index = 0; index < input.length && index < max; index += 1) {
    const code = input.charCodeAt(index);
    text += code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 ? '?' : input.charAt(index);
  }
  return input.length > max ? `${text}…` : text;
}

/** JSON with sorted object keys, so that equal data gives equal text and equal digests. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const digestOf = (value: unknown): string => sha256(canonicalJson(value));

export type ReadProblem = 'missing' | 'link' | 'type' | 'size' | 'changed';

/**
 * Reads a regular file. It opens the path first with O_NOFOLLOW and O_NONBLOCK and does all checks on the open descriptor,
 * so that no link or other file can take its place between the check and the read.
 */
export function readFileNoFollow(path: string, maxBytes: number): Buffer | ReadProblem {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ELOOP' || code === 'EMLINK' ? 'link' : code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'type';
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return 'type';
    if (stat.size > maxBytes) return 'size';
    const data = readFileSync(descriptor);
    return data.length === stat.size ? data : 'changed';
  } finally {
    closeSync(descriptor);
  }
}

const problemText: Record<ReadProblem, string> = {
  missing: 'does not exist',
  link: 'is a symbolic link (give the real file)',
  type: 'is not a regular file',
  size: 'is larger than the limit',
  changed: 'changed while it was read'
};

/** Reads a file or throws a FactoryError with the code and a short reason. */
export function readOrFail(path: string, maxBytes: number, label: string, code = 'E_INPUT'): Buffer {
  const data = readFileNoFollow(path, maxBytes);
  if (Buffer.isBuffer(data)) return data;
  return fail(data === 'missing' ? `${code}_MISSING` : code, `${label} ${safeText(path)} ${problemText[data]}.`);
}

export type DirectoryDigest = { readonly digest: string; readonly files: number; readonly bytes: number };
export const directoryLimits = { maxFiles: 20_000, maxBytes: 4 * 1024 * 1024 * 1024, maxFileBytes: 1024 * 1024 * 1024 };

/**
 * The digest of all regular files in a folder and its subfolders: the SHA-256 of the sorted list of relative names and file digests.
 * A symbolic link or another special entry is an error, so the digest cannot follow a link out of the folder.
 */
export function digestDirectory(root: string): DirectoryDigest {
  const entries: { name: string; sha256: string; bytes: number }[] = [];
  let bytes = 0;
  const visit = (folder: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(folder).sort();
    } catch {
      fail('E_OUTPUT_MISSING', `The folder ${safeText(folder)} cannot be read.`);
      return;
    }
    for (const name of names) {
      const path = join(folder, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) fail('E_OUTPUT_LINK', `The output has a symbolic link: ${safeText(`${prefix}${name}`)}.`);
      if (info.isDirectory()) {
        visit(path, `${prefix}${name}/`);
        continue;
      }
      if (!info.isFile()) fail('E_OUTPUT_TYPE', `The output has an entry that is not a regular file: ${safeText(`${prefix}${name}`)}.`);
      const data = readOrFail(path, directoryLimits.maxFileBytes, 'The output file', 'E_OUTPUT');
      bytes += data.length;
      entries.push({ name: `${prefix}${name}`, sha256: sha256(data), bytes: data.length });
      if (entries.length > directoryLimits.maxFiles || bytes > directoryLimits.maxBytes) fail('E_OUTPUT_SIZE', `The folder ${safeText(root)} is larger than the limit.`);
    }
  };
  const info = (() => {
    try {
      return lstatSync(root);
    } catch {
      return null;
    }
  })();
  if (info === null) fail('E_OUTPUT_MISSING', `The folder ${safeText(root)} does not exist.`);
  if (info?.isSymbolicLink() === true || info?.isDirectory() !== true) fail('E_OUTPUT_TYPE', `${safeText(root)} is not a real folder.`);
  visit(root, '');
  return { digest: digestOf(entries.map((entry) => [entry.name, entry.sha256])), files: entries.length, bytes };
}

/** A random hexadecimal identifier. */
export const randomId = (bytes = 4): string => randomBytes(bytes).toString('hex');

/**
 * Writes a JSON file atomically: a new temporary file in the same folder, fsync, rename over the target, and fsync of the folder.
 * A crash leaves the old file or the new file, never a part of a file.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = join(dirname(path), `.${randomId(6)}.tmp`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    writeSync(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  syncFolder(dirname(path));
}

/** Writes a new file. It fails when the path exists. */
export function writeNewFile(path: string, data: string | Buffer): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    writeSync(descriptor, typeof data === 'string' ? Buffer.from(data) : data);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncFolder(path: string): void {
  if (process.platform === 'win32') return;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    // Some file systems do not support fsync on a folder. The rename is still atomic.
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/** Reads the width and height from a PNG header without decoding the pixels. Returns null when the data is not a PNG file. */
export function pngSize(data: Buffer): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length < 24 || signature.some((byte, index) => data[index] !== byte) || data.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}
