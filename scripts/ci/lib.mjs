import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRegularFile } from './files.mjs';

export const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
// Each of these workflows has a `package` choice input that must list `all` and every package directory.
export const workflows = ['.github/workflows/test.yml'];

// Package directory names from the new-package skill: kebab case, lowercase.
export const directoryName = /^[a-z][a-z0-9-]{0,63}$/;
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const command = /^[a-z][a-z0-9-]{0,63}$/;

// Remove control and format characters before untrusted text reaches the log.
export const safe = (value) => String(value).replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === '\n' ? character : '?'));

export function readJson(path) {
  // One descriptor opened without following links prevents a change between the check and the read.
  const text = readRegularFile(path);
  if (text === undefined) throw new Error(`File not found: ${safe(path)}`);
  return JSON.parse(text);
}

// Read and validate every package in packages/. An unexpected entry stops the workflow instead of being skipped.
// An empty list is valid: the repository has no package before the first pipeline stage needs code.
// The package name is not fixed here, because the name scope is an open decision (D21 in docs/DECISIONS.md).
export function listPackages(base = root) {
  const packagesDir = join(base, 'packages');
  if (!existsSync(packagesDir)) return [];
  const packages = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`packages/ can contain only package directories: ${safe(entry.name)}`);
    if (!directoryName.test(entry.name)) throw new Error(`Package directory name is not valid: ${safe(entry.name)}. Use lowercase kebab case.`);
    const manifest = readJson(join(packagesDir, entry.name, 'package.json'));
    if (typeof manifest.name !== 'string' || manifest.name.trim() === '') throw new Error(`packages/${entry.name}/package.json must have a name.`);
    const name = manifest.name;
    if (manifest.private !== true) throw new Error(`Package ${safe(name)} must be private. Publication needs a separate human decision.`);
    if (typeof manifest.version !== 'string' || !version.test(manifest.version)) throw new Error(`Package ${safe(name)} must have a version X.Y.Z.`);
    const bin = manifest.bin ?? {};
    if (typeof bin !== 'object' || bin === null || Array.isArray(bin)) throw new Error(`Package ${safe(name)} must declare bin as an object.`);
    for (const [key, target] of Object.entries(bin)) {
      if (!command.test(key) || typeof target !== 'string' || !isPackagePath(target)) throw new Error(`Package ${safe(name)} has a bin entry that is not valid.`);
    }
    packages.push({ dir: entry.name, name, version: manifest.version, bin });
  }
  packages.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  if (new Set(packages.map((item) => item.name)).size !== packages.length) throw new Error('Two packages have the same name.');
  return packages;
}

function isPackagePath(path) {
  const normalized = posix.normalize(path.replace(/^\.\//, ''));
  return normalized === path.replace(/^\.\//, '') && !normalized.startsWith('../') && !posix.isAbsolute(normalized) && !normalized.includes('\\') && normalized !== '..';
}

// Resolve the workflow input. Only `all` or an exact package directory name is accepted.
export function selectPackages(value, packages) {
  if (value === 'all') return packages;
  if (typeof value !== 'string' || !directoryName.test(value)) throw new Error('The package value is not valid. Give all or a directory name from packages/.');
  const item = packages.find((candidate) => candidate.dir === value);
  if (!item) throw new Error(`Package not found: ${value}. Available: ${packages.map((candidate) => candidate.dir).join(', ') || 'none'}.`);
  return [item];
}

// Find the packages that a lockfile change affects. A version step changes only the `packages/<directory>` entry.
// Return undefined when the change can affect other packages, such as a change to a hoisted dependency.
export function lockfilePackages(baseLock, headLock, packages) {
  if (!isObject(baseLock) || !isObject(headLock) || !isObject(baseLock.packages) || !isObject(headLock.packages)) return undefined;
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  for (const key of new Set([...Object.keys(baseLock), ...Object.keys(headLock)])) {
    if (key !== 'packages' && !same(baseLock[key], headLock[key])) return undefined;
  }
  const dirs = new Set();
  for (const key of new Set([...Object.keys(baseLock.packages), ...Object.keys(headLock.packages)])) {
    if (same(baseLock.packages[key], headLock.packages[key])) continue;
    const match = /^packages\/([^/]+)(\/node_modules\/.+)?$/.exec(key);
    if (!match || !packages.some((item) => item.dir === match[1])) return undefined;
    dirs.add(match[1]);
  }
  return [...dirs];
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Select the packages that a pull request changes. A file in `packages/<directory>/` selects that package.
// A lockfile change selects the packages from `lockfile`, the result of lockfilePackages.
// Any other file, an unknown package directory, or an empty list selects all packages, because shared files can change every test result.
export function changedPackages(files, packages, lockfile = undefined) {
  const selected = new Set();
  for (const file of files) {
    if (file === 'package-lock.json' && lockfile) {
      for (const dir of lockfile) selected.add(dir);
      continue;
    }
    const match = /^packages\/([^/]+)\/./.exec(file);
    const item = match && packages.find((candidate) => candidate.dir === match[1]);
    if (!item) return { packages, shared: files.length ? file : undefined };
    selected.add(item.dir);
  }
  if (selected.size === 0) return { packages, shared: undefined };
  return { packages: packages.filter((item) => selected.has(item.dir)), shared: undefined };
}

// Read the options of the `package` input under `on.workflow_dispatch.inputs`. The parser expects block-style YAML lists.
export function workflowChoices(text) {
  const lines = text.split(/\r?\n/);
  const indent = (line) => line.length - line.trimStart().length;
  const find = (start, end, pattern) => {
    for (let index = start; index < end; index += 1) if (pattern.test(lines[index])) return index;
    return -1;
  };
  const blockEnd = (start) => {
    const level = indent(lines[start]);
    let index = start + 1;
    while (index < lines.length && (lines[index].trim() === '' || lines[index].trimStart().startsWith('#') || indent(lines[index]) > level)) index += 1;
    return index;
  };
  const dispatch = find(0, lines.length, /^\s*workflow_dispatch:\s*$/);
  if (dispatch < 0) throw new Error('workflow_dispatch not found.');
  const inputs = find(dispatch + 1, blockEnd(dispatch), /^\s*inputs:\s*$/);
  if (inputs < 0) throw new Error('workflow_dispatch.inputs not found.');
  const input = find(inputs + 1, blockEnd(inputs), /^\s*package:\s*$/);
  if (input < 0) throw new Error('The package input not found.');
  const inputEnd = blockEnd(input);
  if (find(input + 1, inputEnd, /^\s*type:\s*choice\s*$/) < 0) throw new Error('The package input must have type: choice.');
  const options = find(input + 1, inputEnd, /^\s*options:\s*$/);
  if (options < 0) throw new Error('The options list of the package input not found.');
  const choices = [];
  for (let index = options + 1; index < blockEnd(options); index += 1) {
    const match = /^\s*-\s*(['"]?)([^'"\s#]+)\1\s*(#.*)?$/.exec(lines[index]);
    if (match) choices.push(match[2]);
    else if (lines[index].trim() !== '' && !lines[index].trimStart().startsWith('#')) throw new Error('The options list of the package input must contain only simple values.');
  }
  return choices;
}

// Compare every workflow choice list with packages/. Return a list of problems.
export function workflowProblems(packages, base = root) {
  const expected = ['all', ...packages.map((item) => item.dir)];
  const problems = [];
  for (const file of workflows) {
    let choices;
    try {
      choices = workflowChoices(readFileSync(join(base, file), 'utf8'));
    } catch (error) {
      problems.push(`${file}: ${error.message}`);
      continue;
    }
    if (choices.join('\n') === expected.join('\n')) continue;
    const missing = expected.filter((item) => !choices.includes(item));
    const extra = choices.filter((item) => !expected.includes(item));
    const details = [missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `extra ${extra.join(', ')}` : ''].filter(Boolean).join('; ');
    problems.push(`${file}: the package options must be [${expected.join(', ')}]${details ? ` (${details})` : ' in this order'}.`);
  }
  return problems;
}

export function assertWorkflows(packages, base = root) {
  const problems = workflowProblems(packages, base);
  if (problems.length) throw new Error(`The package lists in GitHub Actions do not agree with packages/:\n${problems.join('\n')}`);
}

export function isDryRun(value) {
  if (value === 'true') return true;
  if (value === 'false' || value === '' || value === undefined) return false;
  throw new Error('DRY_RUN must be true or false.');
}

export function run(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000, windowsHide: true, ...options });
  if (result.error) throw new Error(`Cannot start ${program}: ${result.error.message}`, { cause: result.error });
  return result;
}

export function check(program, args, options = {}) {
  const result = run(program, args, options);
  if (result.status !== 0) throw new Error(`${program} ${args[0]} stopped with status ${result.status}.\n${safe(result.stderr ?? '')}`);
  return result.stdout ?? '';
}

export function output(key, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[\r\n]/.test(text) || !/^[a-z_]+$/.test(key)) throw new Error('The GITHUB_OUTPUT value is not valid.');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${text}\n`);
}

export function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

export async function main(action) {
  try {
    await action();
  } catch (error) {
    console.error(`::error::${safe(error.message).replace(/%/g, '%25').replace(/\n/g, '%0A')}`);
    process.exitCode = 1;
  }
}
