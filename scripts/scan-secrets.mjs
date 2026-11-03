import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRegularFile } from './ci/files.mjs';

const root = realpathSync.native(fileURLToPath(new URL('../', import.meta.url)));
const gitNullConfig = process.platform === 'win32' ? 'nul' : devNull;
class ScanFailure extends Error {}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|GITLEAKS_)/i.test(key)));
Object.assign(env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: gitNullConfig,
  GIT_CONFIG_GLOBAL: gitNullConfig,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'core.fsmonitor',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_CONFIG_KEY_2: 'core.pager',
  GIT_CONFIG_VALUE_2: '',
  NO_COLOR: '1',
  FORCE_COLOR: '0'
});

function run(program, args) {
  const result = spawnSync(program, args, { cwd: root, env, encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (result.error) throw new ScanFailure(`Cannot start ${program}. Examine the tool installation.`, { cause: result.error });
  return result;
}

function git(args) {
  const result = run('git', ['--no-pager', ...args]);
  if (result.status !== 0) throw new ScanFailure('Cannot read the Git state.');
  return result.stdout;
}

function stagedIndex() {
  const values = Object.entries(process.env)
    .filter(([key]) => key.toUpperCase() === 'GIT_INDEX_FILE')
    .map(([, value]) => resolve(root, value));
  if (new Set(values).size > 1) throw new ScanFailure('Different Git index files are given.');
  if (!values.length) return;
  const path = values[0];
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new ScanFailure('The Git index must be a regular file without links.');
  // Git can supply a temporary index for commit --only or commit --all.
  env.GIT_INDEX_FILE = realpathSync.native(path);
}

function main() {
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length || !['staged', 'history', 'files'].includes(mode)) throw new ScanFailure('Give one mode: staged, history, or files.');
  if (realpathSync.native(git(['rev-parse', '--show-toplevel']).trim()) !== root) throw new ScanFailure('The script must be in the root of the selected repository.');
  const keys = git(['config', '--null', '--name-only', '--list']).split('\0');
  if (keys.some((key) => /^filter\.[\s\S]*\.(?:clean|smudge|process)$/i.test(key))) throw new ScanFailure('Git filters are not supported for the secret scan.');
  if (keys.some((key) => /^(?:diff\.[\s\S]*\.(?:textconv|command)|diff\.external)$/i.test(key))) throw new ScanFailure('External Git diff drivers are not supported for the secret scan.');
  if (mode === 'staged') stagedIndex();
  if (mode === 'history' && git(['rev-parse', '--is-shallow-repository']).trim() !== 'false') throw new ScanFailure('The history scan needs a full clone, not a shallow clone.');
  const version = run('gitleaks', ['version']);
  const match = /^v?(\d+)\.(\d+)\.(\d+)\s*$/.exec(version.stdout);
  if (version.status !== 0 || !match || Number(match[1]) !== 8 || Number(match[2]) < 28) throw new ScanFailure('Gitleaks 8.28.0 or a later 8.x version is necessary.');
  const temporary = mkdtempSync(join(tmpdir(), 'aigg-secret-scan-'));
  try {
    const ignore = join(temporary, 'empty.ignore');
    const report = join(temporary, 'findings.json');
    writeFileSync(ignore, '', { flag: 'wx', mode: 0o600 });
    writeFileSync(report, '', { flag: 'wx', mode: 0o600 });
    const command = mode === 'files' ? ['dir'] : mode === 'staged' ? ['git', '--pre-commit', '--staged'] : ['git', '--log-opts=--all --full-history --no-ext-diff --no-textconv'];
    const result = run('gitleaks', [
      ...command,
      '--config',
      join(root, '.gitleaks.toml'),
      '--redact=100',
      '--no-banner',
      '--no-color',
      '--log-level=error',
      '--ignore-gitleaks-allow',
      '--gitleaks-ignore-path',
      ignore,
      '--report-format=json',
      '--report-path',
      report,
      root
    ]);
    if (result.status === 0) {
      console.log('The secret scan passed.');
      return;
    }
    if (result.status !== 1) throw new ScanFailure('Gitleaks did not complete the scan.');
    // Check and read the report through one file descriptor, so that the checked file is the file that is read.
    let text;
    try {
      text = readRegularFile(report, 64 * 1024 * 1024);
    } catch {
      text = undefined;
    }
    if (text === undefined) throw new ScanFailure('The Gitleaks report is larger than the limit or has an unsupported type.');
    const findings = JSON.parse(text);
    if (!Array.isArray(findings) || !findings.length) throw new ScanFailure('Gitleaks did not complete the scan or returned a report that is not valid.');
    const rules = [...new Set(findings.map((finding) => finding.RuleID).filter((rule) => typeof rule === 'string' && /^[a-z0-9-]+$/.test(rule)))];
    // Do not print excerpts, secrets, filenames, or raw scanner diagnostics.
    console.error(`Possible secrets found: ${findings.length}. Rules: ${rules.join(', ')}. See docs/GIT_HOOKS.md.`);
    process.exitCode = 1;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof ScanFailure ? error.message : 'The secret scan did not run. Examine Git, Gitleaks, and the settings in docs/GIT_HOOKS.md.');
  process.exitCode = 2;
}
