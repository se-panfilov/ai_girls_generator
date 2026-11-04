#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { createManifest, formatManifest, type ManifestEntry, parseManifest, verifyManifest } from '@rig-runtime/manifest';
import { RigRuntimeError } from '@rig-runtime/problems';

const help = `Usage: aigg-rig-runtime <command> [options]

Commands:
  manifest <dir> <out.sha256> [--dry-run] [--overwrite]
      Write a SHA-256 manifest of the asset files under <dir>. macOS metadata (.DS_Store, ._*) is skipped.
  verify <dir> <manifest.sha256> [--strict]
      Check the files under <dir>. --strict also fails on asset files that the manifest does not list.
  hash-invariance <before> <after-dir>
      Check that every asset file of <before> (a directory or a manifest) is unchanged in <after-dir>.
      New files in <after-dir> are permitted and listed in the report.

Each command writes one JSON report to stdout. Exit status: 0 PASS, 1 FAIL, 2 usage or input error.
`;

type Report = Record<string, unknown> & { status: 'PASS' | 'FAIL' };

function usage(message: string): never {
  throw new RigRuntimeError([{ code: 'E_USAGE', message }]);
}

function directory(path: string | undefined): string {
  if (!path) usage('A directory argument is missing.');
  const full = resolve(path);
  if (!existsSync(full) || !statSync(full).isDirectory()) usage(`${path} is not a directory.`);
  return full;
}

/**
 * Writes the manifest without a check-then-write race. A new file uses the exclusive flag `wx`.
 * A replacement goes to a new temporary file in the same folder and then replaces the target name with one rename.
 * The rename replaces a symbolic link itself, so the write never follows a link to another file.
 */
function writeManifest(out: string, label: string, text: string, overwrite: boolean): void {
  if (!overwrite) {
    try {
      writeFileSync(out, text, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') usage(`${label} exists. Give --overwrite to replace it.`);
      throw error;
    }
    return;
  }
  const temporary = `${out}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { flag: 'wx' });
  try {
    renameSync(temporary, out);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readManifestOrDirectory(path: string): { entries: ManifestEntry[]; ignored: string[] } {
  const full = resolve(path);
  if (existsSync(full) && statSync(full).isDirectory()) return createManifest(full);
  if (!existsSync(full)) usage(`${path} is not found.`);
  return { entries: parseManifest(readFileSync(full, 'utf8')), ignored: [] };
}

function run(argv: readonly string[]): Report {
  const flags = new Set(argv.filter((item) => item.startsWith('--')));
  const args = argv.filter((item) => !item.startsWith('--'));
  const [command, first, second] = args;
  const known: Record<string, readonly string[]> = { manifest: ['--dry-run', '--overwrite'], verify: ['--strict'], 'hash-invariance': [] };
  if (!command || !(command in known)) usage(`Unknown command. ${help}`);
  for (const flag of flags) if (!(known[command] ?? []).includes(flag)) usage(`The option ${flag} is not valid for ${command}.`);
  if (args.length !== 3) usage(`${command} needs two arguments.`);
  if (command === 'manifest') {
    const dir = directory(first);
    const out = resolve(second ?? '');
    const inside = relative(dir, out);
    if (!inside.startsWith(`..`) && !inside.startsWith(sep)) usage('The manifest file must be outside the directory that it describes.');
    const { entries, ignored } = createManifest(dir);
    if (flags.has('--dry-run')) {
      if (existsSync(out) && !flags.has('--overwrite')) usage(`${second} exists. Give --overwrite to replace it.`);
    } else writeManifest(out, second ?? '', formatManifest(entries), flags.has('--overwrite'));
    return { status: 'PASS', command, files: entries.length, ignored, written: !flags.has('--dry-run'), out };
  }
  if (command === 'verify') {
    const dir = directory(first);
    const result = verifyManifest(dir, parseManifest(readFileSync(resolve(second ?? ''), 'utf8')), flags.has('--strict'));
    return { status: result.ok ? 'PASS' : 'FAIL', command, ...result };
  }
  const before = readManifestOrDirectory(first ?? '');
  const result = verifyManifest(directory(second), before.entries, false);
  return { status: result.ok ? 'PASS' : 'FAIL', command, ...result, ignored: [...new Set([...before.ignored, ...result.ignored])].sort() };
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(help);
} else {
  try {
    const report = run(argv);
    process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  } catch (error) {
    const problems = error instanceof RigRuntimeError ? error.problems : [{ code: 'E_INTERNAL', message: String(error) }];
    process.stdout.write(`${JSON.stringify({ status: 'ERROR', problems }, null, 1)}\n`);
    process.exitCode = 2;
  }
}
