import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { changedPackages, isDryRun, listPackages, lockfilePackages, root, selectPackages, workflowChoices, workflowProblems, workflows } from '../../scripts/ci/lib.mjs';
import { workspaceDirectories } from '../../scripts/workspaces.mjs';

const item = { dir: 'demo', name: '@scope/demo', version: '1.2.3', bin: {} };
const posixOnly = { skip: process.platform === 'win32' ? 'symbolic links differ on Windows' : false };

function temporary(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function packagesFixture(t, entries) {
  const base = temporary(t, 'aigg-ci-packages-');
  mkdirSync(join(base, 'packages'));
  for (const [dir, manifest] of Object.entries(entries)) {
    mkdirSync(join(base, 'packages', dir), { recursive: true });
    writeFileSync(join(base, 'packages', dir, 'package.json'), JSON.stringify(manifest));
  }
  return base;
}

test('repository packages match every workflow choice list', () => {
  const packages = listPackages();
  assert.deepEqual(workflowProblems(packages), []);
  for (const file of workflows) assert.deepEqual(workflowChoices(readFileSync(join(root, file), 'utf8')), ['all', ...packages.map((entry) => entry.dir)]);
});

test('a missing, extra, or reordered package choice is reported', (t) => {
  const base = temporary(t, 'aigg-ci-workflows-');
  cpSync(join(root, '.github'), join(base, '.github'), { recursive: true });
  const [file] = workflows.map((path) => join(base, path));
  const packages = [item, { ...item, dir: 'other', name: '@scope/other' }];
  // Start from a list with only `all`, so that the packages of the repository do not change the result.
  writeFileSync(file, readFileSync(file, 'utf8').replace(/( {10}- all\n)(?: {10}- [a-z0-9-]+\n)*/, '$1'));
  writeFileSync(file, readFileSync(file, 'utf8').replace(/( {10}- all\n)/, '$1          - demo\n          - removed\n'));
  const problems = workflowProblems(packages, base);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing other/);
  assert.match(problems[0], /extra removed/);
  writeFileSync(file, readFileSync(file, 'utf8').replace(/( {10}- all\n)( {10}- demo\n)( {10}- removed\n)/, '$2$1          - other\n'));
  assert.match(workflowProblems(packages, base).join(''), /in this order/);
});

test('workflow choice parsing rejects flow lists and missing inputs', () => {
  assert.throws(() => workflowChoices('on:\n  push:\n'), /workflow_dispatch/);
  assert.throws(() => workflowChoices('on:\n  workflow_dispatch:\n    inputs:\n      package:\n        type: string\n'), /choice/);
  assert.throws(() => workflowChoices('on:\n  workflow_dispatch:\n    inputs:\n      package:\n        type: choice\n        options:\n          - [all, x]\n'), /simple values/);
});

test('package selection accepts only all or an exact directory name', () => {
  const packages = [item];
  assert.deepEqual(selectPackages('all', packages), packages);
  assert.deepEqual(selectPackages('demo', packages), packages);
  for (const value of ['Demo', '@scope/demo', '../demo', 'demo; rm -rf /', '$(id)', 'demo\n', '', ' all', 'other']) {
    assert.throws(() => selectPackages(value, packages), undefined, JSON.stringify(value));
  }
  assert.throws(() => selectPackages('demo', []), /none/);
});

test('pull request selection tests only changed packages unless a shared file changes', () => {
  const packages = [item, { ...item, dir: 'other', name: '@scope/other' }, { ...item, dir: 'third', name: '@scope/third' }];
  const dirs = (files) => changedPackages(files, packages).packages.map((entry) => entry.dir);
  assert.deepEqual(dirs(['packages/demo/src/cli.ts']), ['demo']);
  assert.deepEqual(dirs(['packages/other/README.md', 'packages/demo/package.json', 'packages/other/test/a.test.ts']), ['demo', 'other']);
  for (const shared of [
    'package-lock.json',
    'configs/vite.config.mjs',
    '.github/workflows/test.yml',
    'scripts/ci/lib.mjs',
    'docs/WRITING.md',
    'packages/removed/src/cli.ts',
    'packages/Demo/src/cli.ts',
    'packages/README.md',
    'packages/demo'
  ]) {
    assert.deepEqual(changedPackages(['packages/demo/src/cli.ts', shared], packages), { packages, shared }, shared);
  }
  assert.deepEqual(changedPackages([], packages), { packages, shared: undefined });
});

test('a lockfile change selects only packages whose own entries change', () => {
  const packages = [item, { ...item, dir: 'other', name: '@scope/other' }];
  const lock = (entries, extra = {}) => ({
    name: 'ai-girls-generator',
    lockfileVersion: 3,
    packages: { '': { name: 'ai-girls-generator' }, 'node_modules/vite': { version: '1.0.0' }, ...entries },
    ...extra
  });
  const base = lock({ 'packages/demo': { version: '1.0.0' }, 'packages/other': { version: '2.0.0' } });
  assert.deepEqual(lockfilePackages(base, lock({ 'packages/demo': { version: '1.0.1' }, 'packages/other': { version: '2.0.0' } }), packages), ['demo']);
  assert.deepEqual(lockfilePackages(base, lock({ 'packages/demo': { version: '1.0.0' }, 'packages/other': { version: '2.0.0' }, 'packages/other/node_modules/x': { version: '1.0.0' } }), packages), [
    'other'
  ]);
  for (const head of [
    lock({ 'packages/demo': { version: '1.0.1' }, 'packages/other': { version: '2.0.0' }, 'node_modules/new': { version: '1.0.0' } }),
    lock({ 'packages/demo': { version: '1.0.0' }, 'packages/other': { version: '2.0.0' }, 'packages/removed': { version: '1.0.0' } }),
    lock({ 'packages/demo': { version: '1.0.0' }, 'packages/other': { version: '2.0.0' } }, { lockfileVersion: 4 }),
    undefined,
    []
  ]) {
    assert.equal(lockfilePackages(base, head, packages), undefined, JSON.stringify(head));
  }
  assert.deepEqual(changedPackages(['package-lock.json', 'packages/demo/package.json'], packages, ['demo']).packages, [item]);
  assert.deepEqual(changedPackages(['package-lock.json', 'packages/demo/package.json'], packages, undefined), { packages, shared: 'package-lock.json' });
});

test('pull request selection rejects commit names that are not full object names', () => {
  for (const sha of ['', 'HEAD', 'master', '--output=x', 'abc123']) {
    const result = spawnSync(process.execPath, [join(root, 'scripts/ci/packages.mjs'), 'select'], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, EVENT: 'pull_request', BASE_SHA: sha, HEAD_SHA: sha, DRY_RUN: 'false' }
    });
    assert.equal(result.status, 1, sha);
    assert.match(result.stderr, /BASE_SHA/);
  }
});

test('package metadata must follow the package rules', (t) => {
  const good = { name: '@scope/demo', private: true, version: '0.1.0', bin: { 'demo-cli': 'dist/src/cli.js' } };
  assert.deepEqual(
    listPackages(packagesFixture(t, { demo: good })).map((entry) => entry.name),
    ['@scope/demo']
  );
  assert.deepEqual(listPackages(packagesFixture(t, { demo: { ...good, bin: undefined } }))[0]?.bin, {});
  assert.throws(() => listPackages(packagesFixture(t, { demo: { ...good, name: '' } })), /name/);
  assert.throws(() => listPackages(packagesFixture(t, { demo: { ...good, private: false } })), /private/);
  assert.throws(() => listPackages(packagesFixture(t, { demo: { ...good, version: '1.0.0-beta.1' } })), /X\.Y\.Z/);
  assert.throws(() => listPackages(packagesFixture(t, { demo: { ...good, bin: { 'demo-cli': '../outside.js' } } })), /bin/);
  assert.throws(() => listPackages(packagesFixture(t, { 'demo app': good })), /kebab case/);
  assert.throws(() => listPackages(packagesFixture(t, { Demo: good })), /kebab case/);
  assert.throws(() => listPackages(packagesFixture(t, { demo: good, other: good })), /same name/);
});

test('an empty or missing packages directory gives no packages', (t) => {
  assert.deepEqual(listPackages(packagesFixture(t, {})), []);
  assert.deepEqual(listPackages(temporary(t, 'aigg-ci-empty-')), []);
  assert.deepEqual(workspaceDirectories(temporary(t, 'aigg-ci-empty-')), []);
});

test('a linked package directory is rejected', posixOnly, (t) => {
  const base = packagesFixture(t, { demo: { name: '@scope/demo', private: true, version: '0.1.0' } });
  symlinkSync(join(base, 'packages', 'demo'), join(base, 'packages', 'linked'));
  assert.throws(() => listPackages(base), /only package directories/);
});

test('dry run values are strict', () => {
  assert.equal(isDryRun('true'), true);
  assert.equal(isDryRun('false'), false);
  assert.equal(isDryRun(undefined), false);
  assert.throws(() => isDryRun('yes'));
});

test('the workspace runner succeeds without packages and rejects unknown options', () => {
  const runner = join(root, 'scripts', 'workspaces.mjs');
  if (workspaceDirectories().length === 0) {
    const empty = spawnSync(process.execPath, [runner, 'test'], { cwd: root, encoding: 'utf8' });
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /No package in packages/);
  }
  for (const args of [[], ['test', '--force'], ['Test'], ['test; id']]) {
    assert.equal(spawnSync(process.execPath, [runner, ...args], { cwd: root, encoding: 'utf8' }).status, 1, args.join(' '));
  }
});
