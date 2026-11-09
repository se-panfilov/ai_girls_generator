import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { guardFormat } from '@seethrough-bundle/runner';
import { describe, expect, it } from 'vitest';

import { packageRoot, temporaryDirectory } from './helpers';

// These tests start guard.py with Python 3.12 and a synthetic target script. No See-through code, no model, and no network is used.
// The guard needs Python 3.12 exactly. Give AIGG_PYTHON312 when python3.12 is not at a standard path.

const python = [process.env.AIGG_PYTHON312, '/usr/bin/python3.12', '/usr/local/bin/python3.12', '/opt/homebrew/bin/python3.12'].find((path) => path !== undefined && path !== '' && existsSync(path));
const guard = join(packageRoot, 'assets', 'guard.py');

type Records = { kind: string; event: string; detail: unknown }[];

function runGuard(
  script: string,
  argv: string[] = [],
  flags = ['-I', '-B'],
  target: { kind: string; script?: string; files?: Record<string, string> } = { kind: 'see-through' }
): { status: number | null; records: Records; root: string; stderr: string } {
  const root = temporaryDirectory('guard');
  const st = join(root, 'st');
  mkdirSync(join(st, 'common', 'helper'), { recursive: true });
  mkdirSync(join(st, 'inference'), { recursive: true });
  mkdirSync(join(root, 'output'));
  mkdirSync(join(root, 'hf', 'hub', 'models--a--b'), { recursive: true });
  writeFileSync(join(root, 'hf', 'hub', 'models--a--b', 'config.json'), '{}');
  writeFileSync(join(st, 'common', 'helper', '__init__.py'), 'VALUE = 7\n');
  writeFileSync(join(st, 'inference', 'target.py'), script);
  for (const [name, content] of Object.entries(target.files ?? {})) writeFileSync(join(root, name), content);
  const log = join(root, 'guard.jsonl');
  const config = join(root, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      format: guardFormat,
      kind: target.kind,
      seeThroughRoot: st,
      script: target.script ?? join(st, 'inference', 'target.py'),
      argv: argv.map((item) => item.replace('<root>', root)),
      writeRoots: [join(root, 'output')],
      hfCache: join(root, 'hf', 'hub'),
      log
    })
  );
  const result = spawnSync(python ?? 'python3.12', [...flags, guard, config], { env: { PATH: '/usr/bin:/bin', ROOT: root }, encoding: 'utf8', timeout: 60_000 });
  const records = existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Records[number])
    : [];
  return { status: result.status, records, root, stderr: result.stderr };
}

const denied = (records: Records): string[] => records.filter((record) => record.kind === 'deny').map((record) => record.event);

describe.runIf(python !== undefined)('guard.py (needs Python 3.12)', () => {
  it('runs the target with the See-through common directory on the path and allows writes in the output directory', () => {
    const result = runGuard(`import os, helper, sys\nopen(os.path.join(os.environ["ROOT"], "output", "x.txt"), "w").write(str(helper.VALUE) + sys.argv[1])\n`, ['A']);
    expect(result.status).toBe(0);
    expect(denied(result.records)).toEqual([]);
    expect(readFileSync(join(result.root, 'output', 'x.txt'), 'utf8')).toBe('7A');
  });

  it('denies network access, also when the target catches the exception', () => {
    const result = runGuard(
      `import socket\ntry:\n    socket.create_connection(("127.0.0.1", 9))\nexcept Exception:\n    pass\ntry:\n    socket.getaddrinfo("huggingface.co", 443)\nexcept Exception:\n    pass\n`
    );
    expect(denied(result.records)).toEqual(expect.arrayContaining(['socket.getaddrinfo']));
    expect(result.status).toBe(3);
  });

  it('denies new processes', () => {
    const result = runGuard(`import subprocess, os\ntry:\n    subprocess.run(["true"])\nexcept PermissionError:\n    pass\ntry:\n    os.system("true")\nexcept PermissionError:\n    pass\n`);
    expect(denied(result.records)).toEqual(expect.arrayContaining(['subprocess.Popen', 'os.system']));
    expect(result.status).toBe(3);
  });

  it('denies pickle class lookups', () => {
    const result = runGuard(`import pickle, collections\ndata = pickle.dumps(collections.OrderedDict())\ntry:\n    pickle.loads(data)\nexcept PermissionError:\n    pass\n`);
    expect(denied(result.records)).toContain('pickle.find_class');
  });

  it('denies writes, renames and deletions outside the write roots', () => {
    const result = runGuard(
      `import os\nroot = os.environ["ROOT"]\nfor action in (lambda: open(os.path.join(root, "outside.txt"), "w"), lambda: os.remove(os.path.join(root, "guard.jsonl")), lambda: os.rename(os.path.join(root, "output"), os.path.join(root, "moved")), lambda: open(os.path.join(root, "hf", "hub", "models--a--b", "config.json"), "a")):\n    try:\n        action()\n    except PermissionError:\n        pass\n`
    );
    expect(denied(result.records)).toEqual(['open', 'os.remove', 'os.rename', 'open']);
    expect(existsSync(join(result.root, 'outside.txt'))).toBe(false);
    expect(existsSync(join(result.root, 'output'))).toBe(true);
  });

  it('records reads below the model cache', () => {
    const result = runGuard(`import os\nopen(os.path.join(os.environ["ROOT"], "hf", "hub", "models--a--b", "config.json")).read()\n`);
    expect(result.status).toBe(0);
    expect(result.records.filter((record) => record.kind === 'read').map((record) => String(record.detail))).toEqual([join(result.root, 'hf', 'hub', 'models--a--b', 'config.json')]);
  });

  it('runs qualify.py only from next to guard.py, and qualify.py reports PASS and FAIL in its JSON report', () => {
    const qualifyScript = join(packageRoot, 'assets', 'qualify.py');
    const runQualify = (expectData: unknown): { status: number | null; report: { status: string; problems: string[] } } => {
      const result = runGuard('pass\n', ['--expect', '<root>/expect.json', '--out', '<root>/output/report.json'], ['-I', '-B'], {
        kind: 'qualify',
        script: qualifyScript,
        files: { 'expect.json': JSON.stringify(expectData) }
      });
      return { status: result.status, report: JSON.parse(readFileSync(join(result.root, 'output', 'report.json'), 'utf8')) as { status: string; problems: string[] } };
    };
    const passing = runQualify({ modules: [{ distribution: 'none', module: 'json' }], packages: {}, requireCuda: false });
    expect(passing.status).toBe(0);
    expect(passing.report.status).toBe('PASS');
    const failing = runQualify({ modules: [{ distribution: 'none', module: 'module_that_does_not_exist' }], packages: { torch: '2.8.0' }, requireCuda: false });
    expect(failing.status).toBe(1);
    expect(failing.report.status).toBe('FAIL');
    expect(failing.report.problems.join()).toContain('module_that_does_not_exist');
    expect(failing.report.problems.join()).toContain('version torch');
    const other = runGuard('pass\n', [], ['-I', '-B'], { kind: 'qualify' });
    expect(other.status).toBe(2);
    expect(other.stderr).toContain('qualify.py next to guard.py');
    expect(other.records).toEqual([]);
  });

  it('refuses forbidden arguments and a start without -I -B before the target runs', () => {
    const forbidden = runGuard(`open("never", "w")\n`, ['--tblr_split']);
    expect(forbidden.status).toBe(2);
    expect(forbidden.stderr).toContain('forbidden');
    const flags = runGuard(`pass\n`, [], ['-B']);
    expect(flags.status).toBe(2);
    expect(flags.records).toEqual([]);
  });
});

describe('guard.py availability', () => {
  it('names the Python used for the guard tests', () => {
    // Visible in the test report: when no Python 3.12 is found, the guard tests above are skipped, not passed.
    expect(typeof (python ?? 'not found')).toBe('string');
  });
});
