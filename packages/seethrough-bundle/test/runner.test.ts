import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  allowedHost,
  type Capture,
  checkExisting,
  checkGuard,
  checkInputFile,
  checkSource,
  checkVenv,
  checkWork,
  download,
  type FetchFunction,
  forbiddenArguments,
  gitBlobSha1,
  type Host,
  input,
  layout,
  loadBundle,
  modelCheck,
  modelPath,
  parseGpu,
  parseGuardLog,
  parseManifest,
  preflight,
  prepare,
  RunnerError,
  runOnce,
  seeThroughArguments,
  seeThroughEnvironment,
  type Spawner
} from '@seethrough-bundle/runner';
import { describe, expect, it } from 'vitest';

import { loopbackOnly, quietLog, readyWork, sha256, syntheticImage, syntheticManifest, temporaryDirectory, testHost, writeBundle, writeQualified } from './helpers';

const host: Host = testHost();
/** nvidia-smi gives an RTX A5000 and no compute process. unshare gives a namespace with only loopback. */
const gpuOk: Capture = (command, args) =>
  Promise.resolve(
    command === 'unshare' ? { code: 0, stdout: loopbackOnly } : args.includes('--query-compute-apps=pid') ? { code: 0, stdout: '' } : { code: 0, stdout: 'NVIDIA RTX A5000, 24564, 575.57.08\n' }
  );
const noSpawn: Spawner = () => Promise.reject(new Error('No process may start in this test.'));
const noFetch: FetchFunction = () => Promise.reject(new Error('No network access may happen in this test.'));

function code(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof RunnerError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

async function codeAsync(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof RunnerError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

type Editable = {
  seeThrough: { commit: string; files: { path: string }[] };
  models: { repositories: { revision: string }[]; files: { path: string; repo: string; sha256: string | null }[] };
  python: { wheels: { file: string; url: string }[] };
  input: { sha256: string };
  run: { seed: number; forbiddenArguments: string[] };
};

function mutate(change: (manifest: Editable) => void): string {
  const { manifest } = syntheticManifest();
  const copy = JSON.parse(JSON.stringify(manifest)) as Editable;
  change(copy);
  return code(() => parseManifest(copy));
}

describe('manifest pins', () => {
  it('accepts the synthetic manifest with the pinned values', () => {
    expect(code(() => parseManifest(syntheticManifest().manifest))).toBe('NO_ERROR');
  });

  it('refuses another See-through commit, model revision, input image, seed, or forbidden argument list', () => {
    expect(mutate((m) => (m.seeThrough.commit = 'a'.repeat(40)))).toBe('E_MANIFEST_PIN');
    expect(mutate((m) => (m.models.repositories[0]!.revision = 'b'.repeat(40)))).toBe('E_MANIFEST_PIN');
    expect(mutate((m) => (m.input.sha256 = 'c'.repeat(64)))).toBe('E_MANIFEST_PIN');
    expect(mutate((m) => (m.run.seed = 1))).toBe('E_MANIFEST_PIN');
    expect(mutate((m) => (m.run.forbiddenArguments = ['--tblr_split']))).toBe('E_MANIFEST_PIN');
  });

  it('refuses pickle-based model files, source distributions, other download hosts, and unsafe paths', () => {
    expect(mutate((m) => (m.models.files[0]!.path = 'lama_large_512px.ckpt'))).toBe('E_MANIFEST_PICKLE');
    expect(mutate((m) => (m.models.files[0]!.path = 'checkpoint-18000.pt'))).toBe('E_MANIFEST_PICKLE');
    expect(mutate((m) => (m.python.wheels[1]!.file = 'einops-0.8.2.tar.gz'))).toBe('E_MANIFEST_SOURCE_BUILD');
    expect(mutate((m) => (m.python.wheels[1]!.url = 'https://example.com/packages/einops-0.8.2-py3-none-any.whl'))).toBe('E_MANIFEST');
    expect(mutate((m) => (m.models.files[0]!.path = '../outside.json'))).toBe('E_MANIFEST');
    expect(mutate((m) => (m.seeThrough.files[0]!.path = 'annotators/lama_inpainter/__init__.py'))).toBe('E_MANIFEST');
  });

  it('refuses a weight file without SHA-256 and a repository key that is not pinned', () => {
    expect(mutate((m) => (m.models.files[2]!.sha256 = null))).toBe('E_MANIFEST');
    expect(mutate((m) => (m.models.files[0]!.repo = 'sam'))).toBe('E_MANIFEST');
  });
});

describe('fixed run arguments and environment', () => {
  it('never gives a forbidden argument and always writes a PSD with the pinned seed', () => {
    const argv = seeThroughArguments('/w/input/x.png', '/w/output');
    for (const forbidden of forbiddenArguments) expect(argv).not.toContain(forbidden);
    expect(argv).toContain('--save_to_psd');
    expect(argv[argv.indexOf('--seed') + 1]).toBe('1001');
    expect(argv[argv.indexOf('--repo_id_layerdiff') + 1]).toBe('layerdifforg/seethroughv0.0.2_layerdiff3d');
  });

  it('passes no value from the caller environment except PATH, and sets the offline settings', () => {
    const lay = layout('/work');
    const env = seeThroughEnvironment(lay, '/usr/local/bin:/usr/bin:relative');
    expect(Object.keys(env).sort()).toEqual(
      [
        'CUDA_VISIBLE_DEVICES',
        'DO_NOT_TRACK',
        'HF_DATASETS_OFFLINE',
        'HF_HOME',
        'HF_HUB_CACHE',
        'HF_HUB_DISABLE_IMPLICIT_TOKEN',
        'HF_HUB_DISABLE_TELEMETRY',
        'HF_HUB_OFFLINE',
        'HOME',
        'LANG',
        'LC_ALL',
        'MPLCONFIGDIR',
        'PATH',
        'PYTHONHASHSEED',
        'TMPDIR',
        'TORCH_HOME',
        'TRANSFORMERS_OFFLINE',
        'XDG_CACHE_HOME'
      ].sort()
    );
    expect(env.HF_HUB_OFFLINE).toBe('1');
    expect(env.HOME).toBe('/work/run/home');
    expect(env.PATH?.split(':')[0]).toBe('/work/venv/bin');
  });
});

describe('work directory and input', () => {
  it('refuses a missing work directory, a link, and a directory writable by others', () => {
    const root = temporaryDirectory('work');
    expect(code(() => checkWork(join(root, 'missing')))).toBe('E_WORK');
    mkdirSync(join(root, 'real'), { mode: 0o700 });
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(code(() => checkWork(join(root, 'link')))).toBe('E_WORK');
    mkdirSync(join(root, 'open'));
    chmodSync(join(root, 'open'), 0o777);
    expect(code(() => checkWork(join(root, 'open')))).toBe('E_WORK');
    expect(code(() => checkWork(join(root, 'real')))).toBe('NO_ERROR');
  });

  it('accepts only the input with the expected SHA-256, a PNG signature, and no link', () => {
    const root = temporaryDirectory('input');
    const path = join(root, input.name);
    writeFileSync(path, syntheticImage);
    expect(code(() => checkInputFile(path))).toBe('E_INPUT_HASH');
    expect(code(() => checkInputFile(path, sha256(syntheticImage)))).toBe('NO_ERROR');
    writeFileSync(join(root, 'text.png'), 'not a png');
    expect(code(() => checkInputFile(join(root, 'text.png'), sha256('not a png')))).toBe('E_INPUT');
    symlinkSync(path, join(root, 'link.png'));
    expect(code(() => checkInputFile(join(root, 'link.png'), sha256(syntheticImage)))).toBe('E_FILE');
  });
});

describe('existing files', () => {
  it('stops on a file with other size or content and never replaces it', async () => {
    const root = temporaryDirectory('files');
    const path = join(root, 'file.bin');
    writeFileSync(path, 'abc');
    const check = (expected: string) => (p: string) => Promise.resolve(sha256(readFileSync(p)) === expected);
    expect(await checkExisting(path, 3, check(sha256('abc')), 'file')).toBe('verified');
    expect(await codeAsync(() => checkExisting(path, 4, check(sha256('abc')), 'file'))).toBe('E_HASH_MISMATCH');
    expect(await codeAsync(() => checkExisting(path, 3, check(sha256('xyz')), 'file'))).toBe('E_HASH_MISMATCH');
    expect(readFileSync(path, 'utf8')).toBe('abc');
    symlinkSync(path, join(root, 'link.bin'));
    expect(await codeAsync(() => checkExisting(join(root, 'link.bin'), 3, check(sha256('abc')), 'link'))).toBe('E_FILE');
    expect(await checkExisting(join(root, 'none.bin'), 3, check(sha256('abc')), 'none')).toBe('missing');
  });

  it('checks configuration files by Git blob id and weight files by SHA-256', async () => {
    const root = temporaryDirectory('blob');
    const path = join(root, 'config.json');
    writeFileSync(path, '{}\n');
    const config = { repo: 'layerdiff3d', path: 'config.json', size: 3, gitBlobSha1: gitBlobSha1(Buffer.from('{}\n')), sha256: null };
    expect(await modelCheck(config)(path)).toBe(true);
    expect(await modelCheck({ ...config, gitBlobSha1: '1'.repeat(40) })(path)).toBe(false);
    expect(await modelCheck({ ...config, sha256: sha256('{}\n') })(path)).toBe(true);
  });

  it('computes the Git blob id like git hash-object', () => {
    expect(gitBlobSha1(Buffer.from(''))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(gitBlobSha1(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});

describe('See-through checkout and venv', () => {
  it('refuses an extra file, a changed file, and a link in the checked directories', async () => {
    const { bundle, lay } = readyWork();
    expect(await checkSource(lay, bundle.manifest)).toBe('verified');
    writeFileSync(join(lay.seeThrough, 'common', 'extra.py'), 'import os\n');
    expect(await codeAsync(() => checkSource(lay, bundle.manifest))).toBe('E_SOURCE_EXTRA_FILE');
    rmSync(join(lay.seeThrough, 'common', 'extra.py'));
    writeFileSync(join(lay.seeThrough, 'common', 'utils', 'helper.py'), 'VALUE = 2\n');
    expect(await codeAsync(() => checkSource(lay, bundle.manifest))).toBe('E_HASH_MISMATCH');
    rmSync(join(lay.seeThrough, 'common', 'utils', 'helper.py'));
    symlinkSync('/etc/hostname', join(lay.seeThrough, 'common', 'utils', 'helper.py'));
    expect(await codeAsync(() => checkSource(lay, bundle.manifest))).toBe('E_TREE');
  });

  it('accepts exactly the pinned packages and Python 3.12', () => {
    const { bundle, lay } = readyWork();
    expect(checkVenv(lay, bundle.manifest).state).toBe('verified');
    const site = join(lay.venv, 'lib', 'python3.12', 'site-packages');
    mkdirSync(join(site, 'requests-2.0.0.dist-info'));
    writeFileSync(join(site, 'requests-2.0.0.dist-info', 'METADATA'), 'Name: requests\nVersion: 2.0.0\n');
    expect(code(() => checkVenv(lay, bundle.manifest))).toBe('E_VENV_PACKAGE_EXTRA');
    rmSync(join(site, 'requests-2.0.0.dist-info'), { recursive: true });
    writeFileSync(join(site, 'einops-0.8.2.dist-info', 'METADATA'), 'Name: einops\nVersion: 0.8.1\n');
    expect(code(() => checkVenv(lay, bundle.manifest))).toBe('E_VENV_PACKAGE_VERSION');
    writeFileSync(join(lay.venv, 'pyvenv.cfg'), 'version = 3.13.1\n');
    expect(code(() => checkVenv(lay, bundle.manifest))).toBe('E_VENV_PYTHON');
  });
});

describe('bundle integrity', () => {
  it('refuses a changed guard and a lock that does not agree with the manifest', () => {
    const root = temporaryDirectory('bundle');
    const synthetic = syntheticManifest();
    writeBundle(root, synthetic);
    writeFileSync(join(root, 'guard.py'), '# changed\n');
    expect(code(() => loadBundle(root))).toBe('E_BUNDLE_INTEGRITY');
    const other = temporaryDirectory('bundle');
    writeBundle(other, synthetic);
    writeFileSync(join(other, 'requirements.lock'), 'einops==0.8.2\n');
    expect(code(() => loadBundle(other))).toBe('E_BUNDLE_INTEGRITY');
  });
});

describe('preflight', () => {
  it('starts no process and uses no network: READY with complete files, INCOMPLETE with missing files', async () => {
    const { bundle, lay, inputPath, synthetic } = readyWork();
    const ready = await preflight(bundle, lay, inputPath, quietLog, { PATH: '/nonexistent' }, sha256(syntheticImage), host);
    expect(ready.status).toBe('READY');
    rmSync(join(lay.wheelhouse, [...synthetic.wheelBytes.keys()][1] ?? ''));
    const incomplete = await preflight(bundle, lay, inputPath, quietLog, { PATH: '/nonexistent' }, sha256(syntheticImage), host);
    expect(incomplete.status).toBe('INCOMPLETE');
  });

  it('gives FAIL for a changed model file, a wrong platform, and a wrong input', async () => {
    const { bundle, lay, inputPath } = readyWork();
    const weight = bundle.manifest.models.files.find((file) => file.sha256 !== null);
    writeFileSync(modelPath(lay, weight ?? bundle.manifest.models.files[0]!), 'tampered weights');
    const report = await preflight(bundle, lay, inputPath, quietLog, {}, sha256(syntheticImage), host);
    expect(report.status).toBe('FAIL');
    expect(report.checks.find((check) => check.id === 'models')?.status).toBe('FAIL');
    const other = readyWork();
    const mac = await preflight(other.bundle, other.lay, other.inputPath, quietLog, {}, sha256(syntheticImage), { ...host, platform: 'darwin' });
    expect(mac.checks.find((check) => check.id === 'platform')?.status).toBe('FAIL');
    const wrong = await preflight(other.bundle, other.lay, other.inputPath, quietLog, {}, input.sha256, host);
    expect(wrong.checks.find((check) => check.id === 'input')?.status).toBe('FAIL');
  });
});

describe('downloads', () => {
  const response = (status: number, body: string | null, headers: Record<string, string> = {}): Response => new Response(body, { status, headers });

  it('allows only HTTPS on the pinned hosts', () => {
    expect(allowedHost('https://huggingface.co/a', 'models')).toBe(true);
    expect(allowedHost('https://cas-bridge.xethub.hf.co/a', 'models')).toBe(true);
    expect(allowedHost('https://cdn-lfs-us-1.hf.co/a', 'models')).toBe(true);
    expect(allowedHost('https://files.pythonhosted.org/packages/a.whl', 'wheels')).toBe(true);
    expect(allowedHost('https://files.pythonhosted.org/packages/a.whl', 'models')).toBe(false);
    expect(allowedHost('https://cdn-lfs.hf.co/a.whl', 'wheels')).toBe(false);
    expect(allowedHost('https://hf.co/a', 'models')).toBe(false);
    expect(allowedHost('http://huggingface.co/a', 'models')).toBe(false);
    expect(allowedHost('https://huggingface.co.evil.example/a', 'models')).toBe(false);
    expect(allowedHost('https://evilhf.co/a', 'models')).toBe(false);
    expect(allowedHost('https://user:pass@huggingface.co/a', 'models')).toBe(false);
    expect(allowedHost('https://huggingface.co:8443/a', 'models')).toBe(false);
    expect(allowedHost('not a url', 'models')).toBe(false);
  });

  it('keeps a file only when size and hash agree, and removes the partial file otherwise', async () => {
    const root = temporaryDirectory('download');
    const target = join(root, 'file.bin');
    const check = (p: string): Promise<boolean> => Promise.resolve(sha256(readFileSync(p)) === sha256('payload'));
    const good: FetchFunction = () => Promise.resolve(response(200, 'payload'));
    await download(good, 'models', 'https://huggingface.co/x', target, 7, check, quietLog);
    expect(readFileSync(target, 'utf8')).toBe('payload');
    const bad: FetchFunction = () => Promise.resolve(response(200, 'PAYLOAD'));
    expect(await codeAsync(() => download(bad, 'models', 'https://huggingface.co/x', join(root, 'b.bin'), 7, check, quietLog))).toBe('E_DOWNLOAD_HASH');
    const large: FetchFunction = () => Promise.resolve(response(200, 'payload and more'));
    expect(await codeAsync(() => download(large, 'models', 'https://huggingface.co/x', join(root, 'c.bin'), 7, check, quietLog))).toBe('E_DOWNLOAD_SIZE');
    expect(readdirSync(root)).toEqual(['file.bin']);
  });

  it('refuses redirects to other hosts, to HTTP, without a valid location, and more than 5 redirects', async () => {
    const root = temporaryDirectory('redirect');
    const ok = (): Promise<boolean> => Promise.resolve(true);
    const redirectTo =
      (location: string | null, status = 302): FetchFunction =>
      (url) =>
        Promise.resolve(url === 'https://huggingface.co/x' ? response(status, null, location === null ? {} : { location }) : response(200, 'payload'));
    const attempt = (fetcher: FetchFunction, source: 'models' | 'wheels' = 'models', url = 'https://huggingface.co/x'): Promise<string> =>
      codeAsync(() => download(fetcher, source, url, join(root, 'f.bin'), 7, ok, quietLog));
    expect(await attempt(redirectTo('https://evil.example/file'))).toBe('E_DOWNLOAD_HOST');
    expect(await attempt(redirectTo('http://cdn-lfs.hf.co/file'))).toBe('E_DOWNLOAD_HOST');
    expect(await attempt(redirectTo('https://files.pythonhosted.org/packages/x.whl'))).toBe('E_DOWNLOAD_HOST');
    expect(await attempt(redirectTo(null))).toBe('E_DOWNLOAD_REDIRECT');
    expect(await attempt(redirectTo('https://[bad'))).toBe('E_DOWNLOAD_REDIRECT');
    const wheelToHub: FetchFunction = () => Promise.resolve(response(302, null, { location: 'https://cdn-lfs.hf.co/x.whl' }));
    expect(await attempt(wheelToHub, 'wheels', 'https://files.pythonhosted.org/packages/x.whl')).toBe('E_DOWNLOAD_HOST');
    let hops = 0;
    const loop: FetchFunction = () => Promise.resolve(response(307, null, { location: `https://cdn-lfs.hf.co/hop${(hops += 1)}` }));
    expect(await attempt(loop)).toBe('E_DOWNLOAD_REDIRECT');
    expect(hops).toBe(6);
    expect(await attempt(redirectTo('/relative/path', 308))).toBe('NO_ERROR');
    expect(readFileSync(join(root, 'f.bin'), 'utf8')).toBe('payload');
    rmSync(join(root, 'f.bin'));
    const wrongLength: FetchFunction = () => Promise.resolve(response(200, 'payload', { 'content-length': '8' }));
    expect(await attempt(wrongLength)).toBe('E_DOWNLOAD_SIZE');
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('prepare', () => {
  it('gets only pinned URLs and starts processes only with argument arrays and a minimal environment', async () => {
    const root = temporaryDirectory('prepare');
    const synthetic = syntheticManifest();
    const bundle = writeBundle(join(root, 'bundle'), synthetic);
    mkdirSync(join(root, 'work'), { mode: 0o700 });
    const lay = checkWork(join(root, 'work'));
    const urls: string[] = [];
    const fetcher: FetchFunction = (url) => {
      urls.push(url);
      const name = url.split('/').pop() ?? '';
      const wheel = synthetic.wheelBytes.get(name);
      if (wheel) return Promise.resolve(new Response(wheel, { status: 200 }));
      const match = /resolve\/[0-9a-f]{40}\/(.+)$/.exec(url);
      const key = bundle.manifest.models.files.find((file) => url.endsWith(`/${file.path}`) && url.includes(file.repo === 'marigold' ? 'marigold' : 'layerdiff3d'));
      const bytes = key ? synthetic.modelBytes.get(`${key.repo}/${key.path}`) : undefined;
      return Promise.resolve(match && bytes ? new Response(bytes, { status: 200 }) : new Response(null, { status: 404 }));
    };
    const calls: { command: string; args: readonly string[]; env: Record<string, string>; uid: number | undefined }[] = [];
    const spawner: Spawner = (command, args, options) => {
      calls.push({ command, args, env: options.env, uid: options.user?.uid });
      if (command === 'git' && args.includes('checkout')) {
        mkdirSync(join(lay.seeThrough, '.git'), { recursive: true });
        writeFileSync(join(lay.seeThrough, '.git', 'HEAD'), `${bundle.manifest.seeThrough.commit}\n`);
        mkdirSync(join(lay.seeThrough, 'common', 'utils'), { recursive: true });
        mkdirSync(join(lay.seeThrough, 'inference', 'scripts'), { recursive: true });
        writeFileSync(join(lay.seeThrough, 'inference', 'scripts', 'inference_psd.py'), 'print("synthetic")\n');
        writeFileSync(join(lay.seeThrough, 'common', 'utils', 'helper.py'), 'VALUE = 1\n');
      }
      if (args.includes('install')) {
        const site = join(lay.venv, 'lib', 'python3.12', 'site-packages');
        for (const file of synthetic.wheelBytes.keys()) {
          const [name = '', version = ''] = file.split('-');
          mkdirSync(join(site, `${name}-${version}.dist-info`), { recursive: true });
          writeFileSync(join(site, `${name}-${version}.dist-info`, 'METADATA'), `Name: ${name}\nVersion: ${version}\n`);
        }
      } else if (args.includes('venv')) {
        mkdirSync(join(lay.venv, 'bin'), { recursive: true });
        writeFileSync(join(lay.venv, 'pyvenv.cfg'), 'include-system-site-packages = false\nversion = 3.12.3\n');
      }
      return Promise.resolve({ code: 0, signal: null, timedOut: false });
    };
    const pythonDir = join(root, 'bin');
    mkdirSync(pythonDir);
    writeFileSync(join(pythonDir, 'python3.12'), '');
    const env = { PATH: pythonDir, HF_TOKEN: 'secret-token', AWS_SECRET_ACCESS_KEY: 'secret' };
    const chowns: { path: string; uid: number }[] = [];
    const summary = await prepare(bundle, lay, quietLog, { fetcher, spawner, env, host: testHost(chowns) });
    expect(summary.identity).toEqual({ runUser: 'aigg-l0', uid: 1500 });
    // git runs as root (no third-party Python). The venv and pip run as the run user. Then root takes the venv back.
    expect(calls.filter((call) => call.command === 'git').every((call) => call.uid === undefined)).toBe(true);
    expect(calls.filter((call) => call.command !== 'git').map((call) => call.uid)).toEqual([1500, 1500]);
    expect(chowns.find((item) => item.path === lay.venv)?.uid).toBe(1500);
    expect(chowns.filter((item) => item.path === lay.venv).map((item) => item.uid)).toEqual([1500, process.getuid?.() ?? 0]);
    for (const directory of ['run', 'run/home', 'run/logs']) expect(chowns.some((item) => item.path === join(lay.work, ...directory.split('/')) && item.uid === 1500)).toBe(true);
    for (const url of urls) expect(url.startsWith('https://files.pythonhosted.org/packages/') || /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//.test(url)).toBe(true);
    for (const call of calls) {
      expect(JSON.stringify(call.env)).not.toContain('secret');
      expect(call.command === 'git' || call.command.endsWith('python3.12') || call.command === lay.python).toBe(true);
    }
    const pip = calls.find((call) => call.args.includes('install'));
    expect(pip?.args).toEqual(expect.arrayContaining(['--no-index', '--require-hashes', '--only-binary', ':all:', '--no-deps', '--isolated']));
    const fetch = calls.find((call) => call.args.includes('fetch'));
    expect(fetch?.args).toEqual(expect.arrayContaining(['protocol.allow=never', 'https://github.com/shitagaki-lab/see-through.git', bundle.manifest.seeThrough.commit]));
    expect(readFileSync(join(lay.hfCache, 'models--layerdifforg--seethroughv0.0.2_layerdiff3d', 'refs', 'main'), 'utf8')).toBe(bundle.manifest.models.repositories[0]?.revision);
    const report = await preflight(bundle, lay, null, quietLog, {}, sha256(syntheticImage), host);
    expect(report.checks.filter((check) => check.status !== 'PASS').map((check) => check.id)).toEqual(['input']);
  });

  it('is BLOCKED without Python 3.12 and starts nothing', async () => {
    const root = temporaryDirectory('prepare');
    const synthetic = syntheticManifest();
    const bundle = writeBundle(join(root, 'bundle'), synthetic);
    mkdirSync(join(root, 'work'), { mode: 0o700 });
    const lay = checkWork(join(root, 'work'));
    const { writeSource, writeWheels, writeModels } = await import('./helpers');
    writeSource(lay);
    writeWheels(lay, synthetic);
    writeModels(lay, bundle, synthetic);
    expect(await codeAsync(() => prepare(bundle, lay, quietLog, { fetcher: noFetch, spawner: noSpawn, env: { PATH: '/nonexistent' }, host }))).toBe('E_PYTHON_MISSING');
  });
});

describe('GPU check', () => {
  it('passes only with enough memory and a new driver', () => {
    expect(parseGpu('NVIDIA RTX A5000, 24564, 575.57.08').status).toBe('PASS');
    expect(parseGpu('NVIDIA RTX A4000, 16376, 575.57.08').status).toBe('BLOCKED');
    expect(parseGpu('NVIDIA RTX A5000, 24564, 550.54.15').status).toBe('BLOCKED');
    expect(parseGpu('garbage').status).toBe('BLOCKED');
  });
});

describe('guard records', () => {
  it('reports denials, missing required reads, and reads of files that are not pinned', () => {
    const { bundle, lay } = readyWork();
    const reads = bundle.manifest.models.files.filter((file) => file.sha256 === null).map((file) => JSON.stringify({ kind: 'read', event: 'open', detail: modelPath(lay, file) }));
    const start = JSON.stringify({ kind: 'start', event: 'guard', detail: {} });
    const end = JSON.stringify({ kind: 'end', event: 'guard', detail: { denied: 0 } });
    const clean = checkGuard(parseGuardLog([start, ...reads, end].join('\n')), lay, bundle.manifest);
    expect(clean.denied).toHaveLength(0);
    expect(clean.missingReads).toEqual([]);
    const denied = checkGuard(parseGuardLog([start, JSON.stringify({ kind: 'deny', event: 'socket.connect', detail: '' }), end].join('\n')), lay, bundle.manifest);
    expect(denied.denied).toHaveLength(1);
    expect(denied.missingReads).toContain('layerdiff3d/scheduler/scheduler_config.json');
    const extra = checkGuard(parseGuardLog(JSON.stringify({ kind: 'read', event: 'open', detail: join(lay.hfCache, 'models--frankjoshua--x', 'scheduler_config.json') })), lay, bundle.manifest);
    expect(extra.unexpectedReads).toHaveLength(1);
    expect(code(() => parseGuardLog('not json'))).toBe('E_GUARD_LOG');
  });
});

describe('run', () => {
  function fakeSeeThrough(lay: ReturnType<typeof readyWork>['lay'], bundle: ReturnType<typeof readyWork>['bundle'], extra: string[] = []): Spawner {
    return (command, args, options) => {
      const config = JSON.parse(readFileSync(args[args.length - 1] ?? '', 'utf8')) as { log: string; argv: string[]; kind: string };
      expect(config.argv).not.toContain('--tblr_split');
      expect(config.kind).toBe('see-through');
      expect(options.env.HF_HUB_OFFLINE).toBe('1');
      expect(options.user?.uid).toBe(1500);
      expect([command, ...args.slice(0, 4)]).toEqual(['unshare', '--user', '--net', '--map-current-user', '--']);
      expect(config.log.startsWith(lay.logs)).toBe(true);
      const reads = bundle.manifest.models.files.filter((file) => file.sha256 === null).map((file) => JSON.stringify({ kind: 'read', event: 'open', detail: modelPath(lay, file) }));
      writeFileSync(config.log, `${[JSON.stringify({ kind: 'start', event: 'guard', detail: {} }), ...reads, ...extra, JSON.stringify({ kind: 'end', event: 'guard', detail: {} })].join('\n')}\n`);
      for (const name of ['concept-mirrored.psd', 'concept-mirrored_depth.psd', 'concept-mirrored.psd.json']) writeFileSync(join(lay.output, name), name);
      return Promise.resolve({ code: 0, signal: null, timedOut: false });
    };
  }

  it('gives PASS with a complete guard log and outputs, and refuses a second run', async () => {
    const { bundle, lay, inputPath } = readyWork();
    writeQualified(lay, bundle);
    const deps = { spawner: fakeSeeThrough(lay, bundle), capture: gpuOk, env: {}, expectedInputSha256: sha256(syntheticImage), host };
    const result = await runOnce(bundle, lay, inputPath, quietLog, deps);
    expect(result.status).toBe('PASS');
    expect((result.modelFiles as { source: string }[]).filter((item) => item.source === 'computed')).toHaveLength(4);
    expect(readFileSync(join(lay.evidence, 'SHA256SUMS'), 'utf8')).toContain('output/concept-mirrored.psd');
    expect(readFileSync(join(lay.evidence, 'SHA256SUMS'), 'utf8')).toContain('evidence/guard.jsonl');
    expect(result.network).toMatchObject({ mode: 'network-namespace' });
    expect(result.identity).toEqual({ runUser: 'aigg-l0', uid: 1500 });
    expect(await codeAsync(() => runOnce(bundle, lay, inputPath, quietLog, deps))).toBe('E_ALREADY_RUN');
  });

  it('gives FAIL when the guard denied an action, also when See-through ended with code 0', async () => {
    const { bundle, lay, inputPath } = readyWork();
    writeQualified(lay, bundle);
    const denial = JSON.stringify({ kind: 'deny', event: 'socket.getaddrinfo', detail: 'huggingface.co' });
    const result = await runOnce(bundle, lay, inputPath, quietLog, { spawner: fakeSeeThrough(lay, bundle, [denial]), capture: gpuOk, env: {}, expectedInputSha256: sha256(syntheticImage), host });
    expect(result.status).toBe('FAIL');
    expect(String(result.problems)).toContain('E_GUARD_DENIED');
  });

  it('is BLOCKED on a small GPU and starts no Python process', async () => {
    const { bundle, lay, inputPath } = readyWork();
    writeQualified(lay, bundle);
    const small: Capture = () => Promise.resolve({ code: 0, stdout: 'NVIDIA T4, 15360, 575.57.08\n' });
    expect(await codeAsync(() => runOnce(bundle, lay, inputPath, quietLog, { spawner: noSpawn, capture: small, env: {}, expectedInputSha256: sha256(syntheticImage), host }))).toBe('E_GPU_BLOCKED');
    expect(existsSync(lay.output)).toBe(false);
  });

  it('refuses another input image before any process starts', async () => {
    const { bundle, lay, inputPath } = readyWork();
    writeQualified(lay, bundle);
    expect(await codeAsync(() => runOnce(bundle, lay, inputPath, quietLog, { spawner: noSpawn, capture: gpuOk, env: {}, host }))).toBe('E_PREFLIGHT');
  });
});
