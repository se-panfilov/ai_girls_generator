import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type Capture,
  captureProcess,
  checkQualifyOutput,
  collect,
  type FetchFunction,
  isolationCheck,
  layout,
  modelPath,
  networkMode,
  parseNetDev,
  preflight,
  prepare,
  qualify,
  requiredGlibc,
  resolveRunUser,
  RunnerError,
  runOnce,
  type Spawner,
  spawnProcess,
  wheelCompatible
} from '@seethrough-bundle/runner';
import { describe, expect, it } from 'vitest';

import { loopbackOnly, quietLog, readyWork, sha256, syntheticGroup, syntheticImage, syntheticPasswd, temporaryDirectory, testHost, writeQualified } from './helpers';

// Tests for the remediation of the independent audit: run user, permissions, network isolation, qualify, model cache, wheel tags,
// and output types. All tests use synthetic files. No model, wheel, or See-through code runs.

const noSpawn: Spawner = () => Promise.reject(new Error('No process may start in this test.'));
const noFetch: FetchFunction = () => Promise.reject(new Error('No network access may happen in this test.'));
const gpu =
  (isolation: string | null): Capture =>
  (command) =>
    Promise.resolve(command === 'unshare' ? (isolation === null ? { code: 1, stdout: '' } : { code: 0, stdout: isolation }) : { code: 0, stdout: 'NVIDIA RTX A5000, 24564, 575.57.08\n' });

async function codeOf(action: () => unknown): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof RunnerError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

describe('run user', () => {
  it('accepts a separate unprivileged user and refuses root, the runner user, administrative groups, and a missing user', async () => {
    expect(resolveRunUser(syntheticPasswd, syntheticGroup, 0)).toEqual({ name: 'aigg-l0', uid: 1500, gid: 1500 });
    expect(await codeOf(() => resolveRunUser('aigg-l0:x:0:1500::/:/bin/sh\n', syntheticGroup, 1000))).toBe('E_RUN_USER');
    expect(await codeOf(() => resolveRunUser(syntheticPasswd, syntheticGroup, 1500))).toBe('E_RUN_USER');
    expect(await codeOf(() => resolveRunUser(syntheticPasswd, `${syntheticGroup}docker:x:999:aigg-l0\n`, 0))).toBe('E_RUN_USER');
    expect(await codeOf(() => resolveRunUser(syntheticPasswd, 'sudo:x:1500:\n', 0))).toBe('E_RUN_USER');
    expect(await codeOf(() => resolveRunUser('root:x:0:0::/root:/bin/sh\n', syntheticGroup, 0))).toBe('E_RUN_USER_MISSING');
  });

  it('makes prepare, qualify, and run BLOCKED when they do not start as root, before any process or download', async () => {
    const { bundle, lay, inputPath } = readyWork();
    const notRoot = { ...testHost(), isRoot: false };
    expect(await codeOf(() => prepare(bundle, lay, quietLog, { fetcher: noFetch, spawner: noSpawn, env: {}, host: notRoot }))).toBe('E_ROOT_REQUIRED');
    expect(await codeOf(() => qualify(bundle, lay, quietLog, { spawner: noSpawn, capture: gpu(loopbackOnly), env: {}, host: notRoot }))).toBe('E_ROOT_REQUIRED');
    expect(await codeOf(() => runOnce(bundle, lay, inputPath, quietLog, { spawner: noSpawn, capture: gpu(loopbackOnly), env: {}, host: notRoot }))).toBe('E_ROOT_REQUIRED');
  });

  it('gives INCOMPLETE in preflight when the run user does not exist yet', async () => {
    const { bundle, lay, inputPath } = readyWork();
    const host = { ...testHost(), readText: () => null };
    const report = await preflight(bundle, lay, inputPath, quietLog, {}, sha256(syntheticImage), host);
    expect(report.status).toBe('INCOMPLETE');
    expect(report.checks.find((check) => check.id === 'run-user')?.status).toBe('MISSING');
  });
});

describe('permissions', () => {
  it('refuses a bundle file that others can write, and starts nothing', async () => {
    const { bundle, lay, inputPath } = readyWork();
    chmodSync(join(bundle.root, 'guard.py'), 0o666);
    const report = await preflight(bundle, lay, inputPath, quietLog, {}, sha256(syntheticImage), testHost());
    expect(report.checks.find((check) => check.id === 'permissions')?.message).toContain('E_BUNDLE_PERMISSIONS');
    expect(await codeOf(() => prepare(bundle, lay, quietLog, { fetcher: noFetch, spawner: noSpawn, env: {}, host: testHost() }))).toBe('E_BUNDLE_PERMISSIONS');
  });

  it('refuses a venv, a model file, or code that others can write', async () => {
    for (const target of ['venv', 'model', 'code'] as const) {
      const { bundle, lay, inputPath } = readyWork();
      const path = target === 'venv' ? join(lay.venv, 'pyvenv.cfg') : target === 'model' ? modelPath(lay, bundle.manifest.models.files[0]!) : join(lay.seeThrough, 'common', 'utils', 'helper.py');
      chmodSync(path, 0o646);
      const report = await preflight(bundle, lay, inputPath, quietLog, {}, sha256(syntheticImage), testHost());
      expect(report.checks.find((check) => check.id === 'permissions')?.status).toBe('FAIL');
    }
  });

  it('refuses a work directory below a parent that others can write', async () => {
    const root = temporaryDirectory('parent');
    chmodSync(root, 0o777);
    mkdirSync(join(root, 'work'), { mode: 0o755 });
    const { bundle, inputPath } = readyWork();
    const lay = layout(join(root, 'work'));
    const report = await preflight(bundle, lay, inputPath, quietLog, {}, sha256(syntheticImage), testHost());
    expect(report.checks.find((check) => check.id === 'permissions')?.message).toContain('writable by group or others');
  });

  it('refuses to start third-party Python while a credential path is readable by others', async () => {
    const { bundle, lay } = readyWork();
    const secret = join(temporaryDirectory('secret'), 'rp_environment');
    writeFileSync(secret, 'export RUNPOD_API_KEY="synthetic"\n', { mode: 0o644 });
    chmodSync(secret, 0o644);
    const host = { ...testHost(), secretPaths: [secret] };
    expect(await codeOf(() => prepare(bundle, lay, quietLog, { fetcher: noFetch, spawner: noSpawn, env: {}, host }))).toBe('E_HOST_SECRET_READABLE');
    chmodSync(secret, 0o600);
    const report = await preflight(bundle, lay, null, quietLog, {}, sha256(syntheticImage), host);
    expect(report.checks.find((check) => check.id === 'host-secrets')?.status).toBe('PASS');
  });
});

describe('network isolation', () => {
  it('reads interface names and accepts only a namespace with loopback alone', async () => {
    expect(parseNetDev(loopbackOnly)).toEqual(['lo']);
    const lay = layout('/work');
    const identity = { name: 'aigg-l0', uid: 1500, gid: 1500 };
    expect((await isolationCheck(lay, identity, gpu(loopbackOnly), {}, quietLog)).status).toBe('ISOLATED');
    expect((await isolationCheck(lay, identity, gpu(`${loopbackOnly}  eth0: 1 2\n`), {}, quietLog)).status).toBe('UNAVAILABLE');
    expect((await isolationCheck(lay, identity, gpu(null), {}, quietLog)).status).toBe('UNAVAILABLE');
    const failing: Capture = () => Promise.reject(new Error('unshare: unshare failed: Operation not permitted'));
    expect((await isolationCheck(lay, identity, failing, {}, quietLog)).status).toBe('UNAVAILABLE');
  });

  it('is BLOCKED without isolation unless the owner accepts guard-only mode, and records the choice', async () => {
    const report = { status: 'UNAVAILABLE', method: 'network-namespace', interfaces: [], message: 'synthetic' } as const;
    expect(await codeOf(() => networkMode(report, false))).toBe('E_NETWORK_ISOLATION_UNAVAILABLE');
    expect(networkMode(report, true).mode).toBe('guard-only-owner-accepted');

    const { bundle, lay, inputPath } = readyWork();
    writeQualified(lay, bundle);
    const deps = { spawner: noSpawn, capture: gpu(null), env: {}, expectedInputSha256: sha256(syntheticImage), host: testHost() };
    expect(await codeOf(() => runOnce(bundle, lay, inputPath, quietLog, deps))).toBe('E_NETWORK_ISOLATION_UNAVAILABLE');
    expect(existsSync(lay.output)).toBe(false);

    const commands: string[] = [];
    const spawner: Spawner = (command, args) => {
      commands.push(command);
      const config = JSON.parse(readFileSync(args[args.length - 1] ?? '', 'utf8')) as { log: string };
      writeFileSync(config.log, `${JSON.stringify({ kind: 'start', event: 'guard', detail: {} })}\n${JSON.stringify({ kind: 'end', event: 'guard', detail: {} })}\n`);
      return Promise.resolve({ code: 0, signal: null, timedOut: false });
    };
    const result = await runOnce(bundle, lay, inputPath, quietLog, { ...deps, spawner, acceptGuardOnlyNetwork: true });
    expect(commands).toEqual([lay.python]);
    expect(result.network).toMatchObject({ mode: 'guard-only-owner-accepted' });
  });
});

describe('qualify', () => {
  function fakeQualify(output: (expect: { packages: Record<string, string> }) => Record<string, unknown>): Spawner {
    return (command, args, options) => {
      expect(command).toBe('unshare');
      expect(options.user?.uid).toBe(1500);
      const config = JSON.parse(readFileSync(args[args.length - 1] ?? '', 'utf8')) as { log: string; argv: string[]; kind: string; script: string };
      expect(config.kind).toBe('qualify');
      expect(config.script.endsWith('qualify.py')).toBe(true);
      const expectData = JSON.parse(readFileSync(config.argv[1] ?? '', 'utf8')) as { packages: Record<string, string> };
      writeFileSync(config.argv[3] ?? '', JSON.stringify(output(expectData)));
      writeFileSync(config.log, `${JSON.stringify({ kind: 'start', event: 'guard', detail: {} })}\n${JSON.stringify({ kind: 'end', event: 'guard', detail: {} })}\n`);
      return Promise.resolve({ code: 0, signal: null, timedOut: false });
    };
  }
  const passing = (expectData: { packages: Record<string, string> }): Record<string, unknown> => ({
    format: 'aigg.l0-seethrough-qualify/0.1',
    status: 'PASS',
    python: '3.12.3',
    problems: [],
    modules: [],
    distributions: expectData.packages,
    torch: { cuda: '12.8', cudaAvailable: true, operation: 'PASS' }
  });

  it('passes only with exact versions and a working CUDA runtime, and run needs that PASS for the same bundle', async () => {
    const { bundle, lay, inputPath } = readyWork();
    const deps = { capture: gpu(loopbackOnly), env: {}, expectedInputSha256: sha256(syntheticImage), host: testHost() };
    expect(await codeOf(() => runOnce(bundle, lay, inputPath, quietLog, { ...deps, spawner: noSpawn }))).toBe('E_NOT_QUALIFIED');
    const report = await qualify(bundle, lay, quietLog, { ...deps, spawner: fakeQualify(passing) });
    expect(report.status).toBe('PASS');
    expect(JSON.parse(readFileSync(join(lay.evidence, 'qualify.json'), 'utf8'))).toMatchObject({ status: 'PASS', bundle: bundle.manifestSha256 });
    expect(existsSync(join(lay.evidence, 'qualify-guard.jsonl'))).toBe(true);

    const wrong = await qualify(bundle, lay, quietLog, { ...deps, spawner: fakeQualify((e) => ({ ...passing(e), distributions: { ...e.packages, einops: '0.8.1' } })) });
    expect(wrong.status).toBe('FAIL');
    expect(await codeOf(() => runOnce(bundle, lay, inputPath, quietLog, { ...deps, spawner: noSpawn }))).toBe('E_NOT_QUALIFIED');
  });

  it('reports a missing report, an extra package, and no CUDA', () => {
    const { bundle } = readyWork();
    const packages = Object.fromEntries(bundle.manifest.python.wheels.map((wheel) => [wheel.name, wheel.version]));
    expect(checkQualifyOutput(null, bundle.manifest)[0]).toContain('E_QUALIFY_OUTPUT');
    const base = passing({ packages });
    expect(checkQualifyOutput(base, bundle.manifest)).toEqual([]);
    expect(checkQualifyOutput({ ...base, distributions: { ...packages, requests: '2.0.0' } }, bundle.manifest).join()).toContain('E_QUALIFY_EXTRA');
    expect(checkQualifyOutput({ ...base, torch: { cuda: '12.8', cudaAvailable: false, operation: 'NOT_RUN' } }, bundle.manifest).join()).toContain('E_QUALIFY_CUDA');
    expect(checkQualifyOutput({ ...base, torch: { cuda: '12.6', cudaAvailable: true, operation: 'PASS' } }, bundle.manifest).join()).toContain('E_QUALIFY_CUDA');
  });
});

describe('model cache and wheelhouse', () => {
  it('refuses a token file, another revision, a blob directory, and an extra wheel', async () => {
    const cases: ((lay: ReturnType<typeof readyWork>['lay']) => void)[] = [
      (lay) => writeFileSync(join(lay.hfHome, 'token'), 'synthetic'),
      (lay) => mkdirSync(join(lay.hfCache, 'models--layerdifforg--seethroughv0.0.2_layerdiff3d', 'snapshots', 'f'.repeat(40)), { recursive: true }),
      (lay) => {
        mkdirSync(join(lay.hfCache, 'models--layerdifforg--seethroughv0.0.2_layerdiff3d', 'blobs'));
        writeFileSync(join(lay.hfCache, 'models--layerdifforg--seethroughv0.0.2_layerdiff3d', 'blobs', 'x'), 'x');
      },
      (lay) => mkdirSync(join(lay.hfCache, 'models--frankjoshua--juggernautXL_version6Rundiffusion')),
      (lay) => writeFileSync(join(lay.wheelhouse, 'requests-2.0.0-py3-none-any.whl'), 'x')
    ];
    for (const change of cases) {
      const { bundle, lay, inputPath } = readyWork();
      change(lay);
      const report = await preflight(bundle, lay, inputPath, quietLog, {}, sha256(syntheticImage), testHost());
      expect(report.status).toBe('FAIL');
      expect(
        report.checks
          .filter((check) => check.status === 'FAIL')
          .map((check) => check.message)
          .join()
      ).toMatch(/E_MODEL_CACHE_EXTRA|E_WHEELHOUSE_EXTRA/);
    }
  });

  it('treats a partial download of a pinned file as missing, not as ready', async () => {
    const { bundle, lay, inputPath } = readyWork();
    const file = bundle.manifest.models.files[0]!;
    const path = modelPath(lay, file);
    writeFileSync(`${path}.part`, readFileSync(path));
    const { rmSync } = await import('node:fs');
    rmSync(path);
    const report = await preflight(bundle, lay, inputPath, quietLog, {}, sha256(syntheticImage), testHost());
    expect(report.checks.find((check) => check.id === 'models')?.status).toBe('MISSING');
  });
});

describe('wheel compatibility (static, no installation)', () => {
  it('accepts CPython 3.12 manylinux wheels up to glibc 2.28 and refuses other tags', () => {
    expect(wheelCompatible('torch-2.8.0-cp312-cp312-manylinux_2_28_x86_64.whl')).toBe(true);
    expect(wheelCompatible('tokenizers-0.22.2-cp39-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl')).toBe(true);
    expect(wheelCompatible('tqdm-4.67.3-py3-none-any.whl')).toBe(true);
    expect(wheelCompatible('numpy-2.2.6-cp311-cp311-manylinux_2_17_x86_64.whl')).toBe(false);
    expect(wheelCompatible('numpy-2.2.6-cp312-cp312-musllinux_1_2_x86_64.whl')).toBe(false);
    expect(wheelCompatible('numpy-2.2.6-cp312-cp312-macosx_14_0_arm64.whl')).toBe(false);
    expect(wheelCompatible('numpy-2.2.6-cp312-cp312-manylinux_2_31_x86_64.whl')).toBe(false);
    expect(wheelCompatible('numpy-2.2.6-cp312-cp312-manylinux_2_28_aarch64.whl')).toBe(false);
    expect(wheelCompatible('x-1.0-cp313-abi3-manylinux_2_17_x86_64.whl')).toBe(false);
  });

  it('gives FAIL in preflight when the host glibc is older than the wheels need', async () => {
    const { bundle, lay, inputPath } = readyWork();
    expect(requiredGlibc([{ name: 'a', version: '1', file: 'a-1-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl', url: '', size: 1, sha256: '' }])).toBe(27);
    const report = await preflight(bundle, lay, inputPath, quietLog, {}, sha256(syntheticImage), { ...testHost(), glibc: () => null });
    expect(report.checks.find((check) => check.id === 'glibc')?.status).toBe('FAIL');
  });
});

describe('outputs and evidence', () => {
  it('gives FAIL for an output file that is not PSD, PNG, or JSON, and collect refuses it', async () => {
    const { bundle, lay, inputPath } = readyWork();
    writeQualified(lay, bundle);
    const spawner: Spawner = (_command, args) => {
      const config = JSON.parse(readFileSync(args[args.length - 1] ?? '', 'utf8')) as { log: string };
      const reads = bundle.manifest.models.files.filter((file) => file.sha256 === null).map((file) => JSON.stringify({ kind: 'read', event: 'open', detail: modelPath(lay, file) }));
      writeFileSync(config.log, `${[JSON.stringify({ kind: 'start', event: 'guard', detail: {} }), ...reads, JSON.stringify({ kind: 'end', event: 'guard', detail: {} })].join('\n')}\n`);
      for (const name of ['concept-mirrored.psd', 'concept-mirrored_depth.psd', 'concept-mirrored.psd.json', 'unet.safetensors']) writeFileSync(join(lay.output, name), name);
      return Promise.resolve({ code: 0, signal: null, timedOut: false });
    };
    const result = await runOnce(bundle, lay, inputPath, quietLog, { spawner, capture: gpu(loopbackOnly), env: {}, expectedInputSha256: sha256(syntheticImage), host: testHost() });
    expect(result.status).toBe('FAIL');
    expect(String(result.problems)).toContain('E_OUTPUT_TYPE');
    expect(await codeOf(() => collect(lay, testHost()))).toBe('E_OUTPUT_TYPE');
  });
});

describe.runIf(process.platform === 'linux' && process.getuid?.() === 0)('real identity change (Linux, root only)', () => {
  it('starts a child process with the user id and group id of an unprivileged user and no supplementary groups', async () => {
    const root = temporaryDirectory('identity');
    const logPath = join(root, 'id.log');
    const result = await spawnProcess('id', [], { cwd: '/', env: { PATH: '/usr/bin:/bin' }, timeoutSeconds: 30, logPath, user: { name: 'nobody', uid: 65534, gid: 65534 } });
    expect(result.code).toBe(0);
    const text = readFileSync(logPath, 'utf8');
    expect(text).toMatch(/^uid=65534\([^)]*\) gid=65534\([^)]*\) groups=65534\([^)]*\)$/m);
  });

  it('reports the real network isolation of this host as ISOLATED (only lo) or UNAVAILABLE', async () => {
    const report = await isolationCheck(layout(temporaryDirectory('isolation')), { name: 'nobody', uid: 65534, gid: 65534 }, captureProcess, { PATH: '/usr/bin:/bin' }, quietLog);
    expect(['ISOLATED', 'UNAVAILABLE']).toContain(report.status);
    if (report.status === 'ISOLATED') expect(report.interfaces).toEqual(['lo']);
  });
});
