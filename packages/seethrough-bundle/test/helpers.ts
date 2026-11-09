import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bundleFormat,
  forbiddenArguments,
  gitBlobSha1,
  input,
  type Layout,
  layout,
  loadBundle,
  type LoadedBundle,
  type Logger,
  modelPath,
  modelRepositories,
  requirementsLock,
  seed,
  seeThrough
} from '@seethrough-bundle/runner';

// Synthetic test data only: small text files stand in for code, wheels and model files. No real model, wheel, or image is used.

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const guardSource = readFileSync(join(packageRoot, 'assets', 'guard.py'));

export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

export const quietLog: Logger = { event: () => undefined, progress: () => undefined };

export function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `aigg-${prefix}-`));
  chmodSync(path, 0o700);
  return path;
}

/** A small PNG-like file: the PNG signature and some bytes. The runner checks only the signature and the SHA-256. */
export const syntheticImage = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('synthetic image for tests')]);

export const sourceContent: Record<string, string> = {
  [seeThrough.script]: 'print("synthetic")\n',
  'common/utils/helper.py': 'VALUE = 1\n'
};

const weightBytes = Buffer.from('synthetic weights');
const configBytes = Buffer.from('{"synthetic": true}\n');

export type Synthetic = { readonly manifest: Record<string, unknown>; readonly wheelBytes: Map<string, Buffer>; readonly modelBytes: Map<string, Buffer> };

export function syntheticManifest(): Synthetic {
  const wheelBytes = new Map<string, Buffer>([
    ['pip-26.2.2-py3-none-any.whl', Buffer.from('synthetic pip wheel')],
    ['einops-0.8.2-py3-none-any.whl', Buffer.from('synthetic einops wheel')]
  ]);
  const wheels = [...wheelBytes].map(([file, bytes]) => {
    const [name = '', version = ''] = file.split('-');
    return { name, version, file, url: `https://files.pythonhosted.org/packages/aa/bb/${file}`, size: bytes.length, sha256: sha256(bytes) };
  });
  const modelBytes = new Map<string, Buffer>();
  const modelFiles: Record<string, unknown>[] = [];
  for (const repository of modelRepositories) {
    for (const path of ['model_index.json', 'scheduler/scheduler_config.json']) {
      modelBytes.set(`${repository.key}/${path}`, configBytes);
      modelFiles.push({ repo: repository.key, path, size: configBytes.length, gitBlobSha1: gitBlobSha1(configBytes), sha256: null });
    }
    modelBytes.set(`${repository.key}/unet/diffusion_pytorch_model.safetensors`, weightBytes);
    modelFiles.push({ repo: repository.key, path: 'unet/diffusion_pytorch_model.safetensors', size: weightBytes.length, gitBlobSha1: '0'.repeat(40), sha256: sha256(weightBytes) });
  }
  const sourceFiles = Object.entries(sourceContent).map(([path, content]) => ({ path, size: Buffer.byteLength(content), sha256: sha256(content), mode: '100644' }));
  const lock = requirementsLock(wheels);
  const manifest = {
    format: bundleFormat,
    seeThrough: { repository: seeThrough.repository, commit: seeThrough.commit, script: seeThrough.script, files: sourceFiles },
    models: { repositories: modelRepositories, files: modelFiles },
    python: { version: '3.12', wheels },
    input: { name: input.name, sha256: input.sha256 },
    run: { seed, forbiddenArguments },
    bundleFiles: [
      { path: 'guard.py', sha256: sha256(guardSource) },
      { path: 'requirements.lock', sha256: sha256(lock) }
    ]
  };
  return { manifest, wheelBytes, modelBytes };
}

export function writeBundle(directory: string, synthetic: Synthetic): LoadedBundle {
  mkdirSync(directory, { recursive: true });
  const manifest = synthetic.manifest as { python: { wheels: Parameters<typeof requirementsLock>[0] } };
  writeFileSync(join(directory, 'guard.py'), guardSource);
  writeFileSync(join(directory, 'requirements.lock'), requirementsLock(manifest.python.wheels));
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(synthetic.manifest, null, 2)}\n`);
  return loadBundle(directory);
}

export function writeSource(lay: Layout): void {
  for (const [path, content] of Object.entries(sourceContent)) {
    mkdirSync(dirname(join(lay.seeThrough, path)), { recursive: true });
    writeFileSync(join(lay.seeThrough, path), content);
  }
}

export function writeWheels(lay: Layout, synthetic: Synthetic): void {
  mkdirSync(lay.wheelhouse, { recursive: true });
  for (const [file, bytes] of synthetic.wheelBytes) writeFileSync(join(lay.wheelhouse, file), bytes);
}

export function writeModels(lay: Layout, bundle: LoadedBundle, synthetic: Synthetic): void {
  for (const file of bundle.manifest.models.files) {
    const path = modelPath(lay, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, synthetic.modelBytes.get(`${file.repo}/${file.path}`) ?? Buffer.alloc(0));
  }
  for (const repository of modelRepositories) {
    const refs = join(lay.hfCache, `models--${repository.repository.replace('/', '--')}`, 'refs');
    mkdirSync(refs, { recursive: true });
    writeFileSync(join(refs, 'main'), repository.revision);
  }
}

export function writeVenv(lay: Layout, synthetic: Synthetic, version = '3.12.3'): void {
  const site = join(lay.venv, 'lib', 'python3.12', 'site-packages');
  mkdirSync(site, { recursive: true });
  mkdirSync(join(lay.venv, 'bin'), { recursive: true });
  writeFileSync(join(lay.venv, 'pyvenv.cfg'), `home = /usr/bin\ninclude-system-site-packages = false\nversion = ${version}\n`);
  for (const file of synthetic.wheelBytes.keys()) {
    const [name = '', versionValue = ''] = file.split('-');
    mkdirSync(join(site, `${name}-${versionValue}.dist-info`), { recursive: true });
    writeFileSync(join(site, `${name}-${versionValue}.dist-info`, 'METADATA'), `Metadata-Version: 2.1\nName: ${name}\nVersion: ${versionValue}\n\nDescription.\n`);
  }
}

/** A complete synthetic work directory: bundle, code, wheels, models, venv, and the synthetic input. */
export function readyWork(): { bundle: LoadedBundle; lay: Layout; synthetic: Synthetic; inputPath: string; root: string } {
  const root = temporaryDirectory('seethrough');
  const synthetic = syntheticManifest();
  const bundle = writeBundle(join(root, 'bundle'), synthetic);
  const work = join(root, 'work');
  mkdirSync(work, { mode: 0o700 });
  const lay = layout(work);
  writeSource(lay);
  writeWheels(lay, synthetic);
  writeModels(lay, bundle, synthetic);
  writeVenv(lay, synthetic);
  const inputPath = join(root, input.name);
  writeFileSync(inputPath, syntheticImage);
  return { bundle, lay, synthetic, inputPath, root };
}
