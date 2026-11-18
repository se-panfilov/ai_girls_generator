import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { digestDirectory, digestOf, fail, isRecord, readFileNoFollow, safeText } from '@factory/files';
import type { ToolRecord } from '@factory/manifest';

// The adapter to the existing commands. The factory starts them as Node.js subprocesses with argument arrays (never a shell),
// a small fixed environment, a time limit, and stdout and stderr in files of the run folder. It does not import their code.

export type ToolName = '@aigg/control' | '@aigg/viewer';

/** The folder of the factory package (the folder with its package.json). */
function factoryRoot(): string {
  let folder = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const data = readFileNoFollow(join(folder, 'package.json'), 64 * 1024);
    if (Buffer.isBuffer(data)) {
      const value: unknown = JSON.parse(data.toString('utf8'));
      if (isRecord(value) && value.name === '@aigg/factory') return folder;
    }
    folder = dirname(folder);
  }
  return fail('E_TOOL', 'The factory package folder is not found.');
}

export function factoryVersion(): string {
  const data = readFileNoFollow(join(factoryRoot(), 'package.json'), 64 * 1024);
  const value: unknown = Buffer.isBuffer(data) ? JSON.parse(data.toString('utf8')) : null;
  return isRecord(value) && typeof value.version === 'string' ? value.version : 'unknown';
}

/** The compiled command of a workspace package: packages/<dir>/dist/src/cli.js next to the factory package. */
export function defaultCli(name: ToolName): string {
  return join(factoryRoot(), '..', name === '@aigg/control' ? 'control' : 'viewer', 'dist', 'src', 'cli.js');
}

/**
 * Describes a command for the provenance and the fingerprints: its path, its package version, and the digest of all files in its
 * folder (dist/src), so that a new build with other code makes the dependent stages stale.
 */
export function describeTool(name: ToolName, override: string | null): ToolRecord {
  const path = resolve(override ?? defaultCli(name));
  const data = readFileNoFollow(path, 16 * 1024 * 1024);
  if (!Buffer.isBuffer(data)) {
    const workspace = name === '@aigg/control' ? '@aigg/control' : '@aigg/viewer';
    return fail('E_TOOL_MISSING', `The command of ${name} is not built (${safeText(path)}). Run: npm run build --workspace ${workspace}`);
  }
  const packageJson = readFileNoFollow(join(dirname(path), '..', '..', 'package.json'), 64 * 1024);
  const meta: unknown = Buffer.isBuffer(packageJson) ? JSON.parse(packageJson.toString('utf8')) : null;
  const version = isRecord(meta) && meta.name === name && typeof meta.version === 'string' ? meta.version : null;
  return { name, version, path, digest: digestDirectory(dirname(path)).digest };
}

export type SpineCheck = { ok: true; digest: string } | { ok: false; code: string; message: string };

/** Checks the Spine executable without starting it. The digest uses the path, the size, and the change time, not the file content. */
export function checkSpine(path: string, version: string): SpineCheck {
  if (!isAbsolute(path)) return { ok: false, code: 'E_SPINE_PATH', message: 'The Spine path must be absolute, for example /Applications/Spine.app/Contents/MacOS/Spine.' };
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, code: 'E_SPINE_NOT_FOUND', message: `The Spine executable ${safeText(path)} is not found.` };
    return { ok: false, code: 'E_SPINE_NOT_FOUND', message: `The Spine executable ${safeText(path)} cannot be opened (${code ?? 'error'}).` };
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return { ok: false, code: 'E_SPINE_NOT_FOUND', message: 'The Spine path is not a file. On macOS give .../Spine.app/Contents/MacOS/Spine, not Spine.app.' };
    if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) return { ok: false, code: 'E_SPINE_NOT_EXECUTABLE', message: 'The Spine file is not executable.' };
    return { ok: true, digest: digestOf({ path, version, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) }) };
  } finally {
    closeSync(descriptor);
  }
}

/** The environment of a subprocess: only these names pass. NODE_OPTIONS and other variables that can load code are removed. */
export const passedEnvironment = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SystemRoot'] as const;

export function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  for (const name of passedEnvironment) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

export type ToolRun = {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
  readonly report: Record<string, unknown> | null;
};

/**
 * Runs `node <cli> <args>` and waits. stdout goes to <runDir>/stdout.json and stderr to <runDir>/stderr.txt.
 * The report is the JSON on stdout. A time-out or a signal is an ambiguous result: the caller records ERROR and does not retry.
 */
export function runTool(cli: string, args: readonly string[], runDir: string, timeoutMs: number): ToolRun {
  const stdoutPath = join(runDir, 'stdout.json');
  const stderrPath = join(runDir, 'stderr.txt');
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const out = openSync(stdoutPath, flags, 0o644);
  const err = openSync(stderrPath, flags, 0o644);
  let result;
  try {
    result = spawnSync(process.execPath, [cli, ...args], { stdio: ['ignore', out, err], env: childEnvironment(), timeout: timeoutMs, killSignal: 'SIGTERM', windowsHide: true, shell: false });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  const data = readFileNoFollow(stdoutPath, 16 * 1024 * 1024);
  let report: Record<string, unknown> | null = null;
  if (Buffer.isBuffer(data)) {
    try {
      const value: unknown = JSON.parse(data.toString('utf8'));
      if (isRecord(value)) report = value;
    } catch {
      report = null;
    }
  }
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return {
    exitCode: result.status,
    signal: result.signal,
    timedOut,
    spawnError: result.error !== undefined && !timedOut ? safeText(result.error.message) : null,
    report
  };
}
