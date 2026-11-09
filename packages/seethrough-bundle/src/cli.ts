#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { bundleFiles, type PlannedFile } from '@seethrough-bundle/bundle';
import { RunnerError, show } from '@seethrough-bundle/runner';

const help = `Usage: aigg-seethrough-bundle bundle --out <dir> [--dry-run] [--force]

Write the L0-1 See-through owner-run bundle: run.sh, runner.mjs, guard.py, manifest.json, requirements.lock, README.md, and SHA256SUMS.
The command reads the pinned data files of this package. It uses no network, starts no process, and runs no model.
The owner copies the bundle to the GPU host. See docs/OWNER_RUN.md.

Options:
  --out <dir>  The output directory. It must be new or empty, or --force must be given. A link is refused.
  --dry-run    Print the report and write nothing.
  --force      Replace files with the same names in an existing output directory.
  --help       Print this text.

The command writes one JSON report to stdout. Exit status: 0 PASS, 1 FAIL, 2 usage or input error.
`;

class UsageError extends Error {}

/** Reads a package file without following a link. */
function readPackageFile(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new UsageError(`${basename(path)} is not a regular file.`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
      if (length > maxBytes) throw new UsageError(`${basename(path)} is too large.`);
    }
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/** The package root: two levels above dist/src/cli.js. */
export function packageRoot(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', '..');
}

export function loadData(root: string): Parameters<typeof bundleFiles>[0] {
  const data = (name: string): unknown => JSON.parse(readPackageFile(join(root, 'data', name), 4 * 1024 * 1024).toString('utf8'));
  return {
    wheels: data('wheels.json'),
    modelFiles: data('model-files.json'),
    sourceFiles: data('seethrough-files.json'),
    guard: readPackageFile(join(root, 'assets', 'guard.py'), 1024 * 1024),
    runner: readPackageFile(join(root, 'dist', 'src', 'runner.js'), 4 * 1024 * 1024)
  };
}

/** Checks the output directory and writes the files. Each file goes to a new temporary name and is renamed. */
export function writeBundle(out: string, files: readonly PlannedFile[], force: boolean): void {
  const full = resolve(out);
  let exists = true;
  try {
    const info = lstatSync(full);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new UsageError('The output path is a link or not a directory.');
    if (!force && readdirSync(full).length > 0) throw new UsageError('The output directory is not empty. Give --force to replace the files with the same names.');
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    exists = false;
  }
  if (!exists) mkdirSync(full, { mode: 0o755 });
  for (const file of files) {
    const target = join(full, file.name);
    const temporary = join(full, `.${file.name}.${process.pid}.tmp`);
    writeFileSync(temporary, file.bytes, { flag: 'wx', mode: 0o644 });
    try {
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}

export function run(argv: readonly string[], root: string): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: { out: { type: 'string' }, 'dry-run': { type: 'boolean' }, force: { type: 'boolean' }, help: { type: 'boolean' } }
    });
  } catch (error) {
    process.stderr.write(`E_USAGE: ${show(error instanceof Error ? error.message : 'arguments')}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(help);
    return 0;
  }
  try {
    if (positionals.length !== 1 || positionals[0] !== 'bundle') throw new UsageError('Give the command bundle. Run aigg-seethrough-bundle --help.');
    if (values.out === undefined || values.out === '') throw new UsageError('--out <dir> is required.');
    const files = bundleFiles(loadData(root));
    const report = {
      format: 'aigg.l0-seethrough-bundle-report/0.1',
      status: 'PASS',
      dryRun: values['dry-run'] === true,
      out: resolve(values.out),
      files: files.map((file) => ({ name: file.name, bytes: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex') }))
    };
    if (values['dry-run'] !== true) writeBundle(values.out, files, values.force === true);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`E_USAGE: ${error.message}\n`);
      return 2;
    }
    if (error instanceof RunnerError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      return error.exitCode === 2 ? 2 : 1;
    }
    if ((error as NodeJS.ErrnoException).code !== undefined) {
      process.stderr.write(`E_FILE: ${show((error as NodeJS.ErrnoException).code)}\n`);
      return 2;
    }
    throw error;
  }
}

const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) process.exitCode = run(process.argv.slice(2), packageRoot(import.meta.url));
