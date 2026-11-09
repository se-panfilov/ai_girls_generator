import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { bundleFiles, wheelCutoff } from '@seethrough-bundle/bundle';
import { loadData } from '@seethrough-bundle/cli';
import { type ModelFile, normalizeName, parseManifest, seeThrough, type SourceFile, type Wheel } from '@seethrough-bundle/runner';
import { describe, expect, it } from 'vitest';

import { packageRoot, sha256 } from './helpers';

// These tests read the committed data files. They do not download, install, or run anything.

const data = loadData(packageRoot);
const wheels = data.wheels as Wheel[];
const models = data.modelFiles as ModelFile[];
const sources = data.sourceFiles as SourceFile[];

/** The See-through files that inference_psd.py imports (static import analysis at the pinned commit). */
const executedFiles = [
  'inference/scripts/inference_psd.py',
  'common/utils/inference_utils.py',
  'common/utils/io_utils.py',
  'common/utils/cv.py',
  'common/utils/torch_utils.py',
  'common/utils/torchcv.py',
  'common/modules/layerdiffuse/diffusers_kdiffusion_sdxl.py',
  'common/modules/layerdiffuse/layerdiff3d.py',
  'common/modules/layerdiffuse/transformer3d.py',
  'common/modules/layerdiffuse/vae.py',
  'common/modules/marigold/__init__.py',
  'common/modules/marigold/marigold_depth_pipeline.py',
  'common/modules/marigold/util/batchsize.py',
  'common/modules/marigold/util/ensemble.py',
  'common/modules/marigold/util/image_util.py'
];

describe('pinned data', () => {
  it('lists only wheels from files.pythonhosted.org, one per package, uploaded before the cutoff', () => {
    expect(wheels.length).toBeGreaterThan(0);
    for (const wheel of wheels) {
      expect(wheel.file.endsWith('.whl')).toBe(true);
      expect(wheel.url).toBe(`${wheel.url.slice(0, wheel.url.lastIndexOf('/'))}/${wheel.file}`);
      expect(wheel.url.startsWith('https://files.pythonhosted.org/packages/')).toBe(true);
      expect(Date.parse((wheel as Wheel & { uploaded: string }).uploaded)).toBeLessThan(Date.parse(wheelCutoff));
      expect(/-(cp312|py3|py2\.py3|cp3\d+)-(cp312|abi3|none)-(manylinux|any)/.test(wheel.file)).toBe(true);
    }
    expect(new Set(wheels.map((wheel) => normalizeName(wheel.name))).size).toBe(wheels.length);
  });

  it('pins the package versions of the See-through requirements for the packages on the run path', () => {
    const version = (name: string): string | undefined => wheels.find((wheel) => normalizeName(wheel.name) === name)?.version;
    expect(version('torch')).toBe('2.8.0');
    expect(version('torchvision')).toBe('0.23.0');
    expect(version('diffusers')).toBe('0.37.0');
    expect(version('transformers')).toBe('5.0.0');
    expect(version('huggingface-hub')).toBe('1.7.2');
    expect(version('safetensors')).toBe('0.7.0');
    expect(version('psd-tools')).toBe('1.14.2');
    expect(version('nvidia-cuda-runtime-cu12')?.startsWith('12.8.')).toBe(true);
    for (const excluded of ['pyqt6', 'timm', 'lpips', 'deepspeed', 'detectron2', 'sam2', 'mmdet', 'mmcv', 'bitsandbytes']) expect(version(excluded)).toBeUndefined();
  });

  it('lists only safetensors weights with SHA-256 and no SAM or LaMa files', () => {
    for (const file of models) {
      expect(/\.(ckpt|pt|pth|bin|pkl)$/.test(file.path)).toBe(false);
      if (file.path.endsWith('.safetensors')) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(models.filter((file) => file.path.endsWith('.safetensors'))).toHaveLength(8);
    expect(models.reduce((sum, file) => sum + file.size, 0)).toBe(13435921592);
  });

  it('lists the See-through files that the run path imports, and nothing from annotators', () => {
    const paths = sources.map((file) => file.path);
    for (const path of executedFiles) expect(paths).toContain(path);
    expect(paths.some((path) => path.startsWith('annotators/'))).toBe(false);
    expect(seeThrough.commit).toBe('df019de5129d6c4b406587a14c3501669441a783');
  });
});

describe('bundle', () => {
  it('is deterministic and has SHA256SUMS for every other file', () => {
    const first = bundleFiles(data);
    const second = bundleFiles(data);
    expect(first.map((file) => sha256(file.bytes))).toEqual(second.map((file) => sha256(file.bytes)));
    expect(first.map((file) => file.name)).toEqual(['run.sh', 'runner.mjs', 'guard.py', 'requirements.lock', 'manifest.json', 'README.md', 'SHA256SUMS']);
    const sums = first.find((file) => file.name === 'SHA256SUMS')?.bytes.toString('utf8') ?? '';
    for (const file of first.filter((item) => item.name !== 'SHA256SUMS')) expect(sums).toContain(`${sha256(file.bytes)}  ${file.name}`);
    const manifest = parseManifest(JSON.parse(first.find((file) => file.name === 'manifest.json')?.bytes.toString('utf8') ?? '') as unknown);
    expect(manifest.python.wheels).toHaveLength(wheels.length);
    expect(first.find((file) => file.name === 'guard.py')?.bytes.equals(readFileSync(join(packageRoot, 'assets', 'guard.py')))).toBe(true);
  });

  it('refuses a wheel that was uploaded after the cutoff and a pickle-based model file', () => {
    const late = wheels.map((wheel, index) => (index === 0 ? { ...wheel, uploaded: '2026-11-01T00:00:00Z' } : wheel));
    expect(() => bundleFiles({ ...data, wheels: late })).toThrow(/uploaded/);
    const pickle = [...models, { repo: 'layerdiff3d', path: 'lama_large_512px.ckpt', size: 1, gitBlobSha1: '0'.repeat(40), sha256: '0'.repeat(64) }];
    expect(() => bundleFiles({ ...data, modelFiles: pickle })).toThrow(/pickle/);
  });

  it('writes no date, host name, or local path into the bundle', () => {
    for (const file of bundleFiles(data).filter((item) => item.name !== 'runner.mjs')) {
      const text = file.bytes.toString('utf8');
      expect(text).not.toContain('/home/');
      expect(text).not.toContain('/tmp/');
    }
  });
});
