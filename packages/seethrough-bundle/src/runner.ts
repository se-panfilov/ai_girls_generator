// L0-1 See-through runner. It runs on the GPU host (a Runpod Pod that the owner starts) and only there.
//
// This module is self-contained: it imports only Node.js built-ins, so the build gives one file that the bundle copies as runner.mjs.
// Scope: one standalone See-through decomposition (inference/scripts/inference_psd.py) of one pinned input image.
//
// Trust boundaries and controls:
// - The bundle is data from the repository. run.sh checks SHA256SUMS and starts the runner with an empty environment (only PATH).
//   The runner checks manifest.json against the pins in this file and checks each bundle file against manifest.json.
// - Identities: the runner itself runs as root. Every third-party Python process (venv creation, pip, qualify, See-through) runs as
//   the dedicated unprivileged user aigg-l0. The bundle, the guard configuration, the code, the venv, and the model cache belong
//   to root and are not writable by group or others. The run user can write only in run/ and output/.
// - Network: downloads happen only in prepare, only from pinned sources, and each file has a pinned size and hash.
//   qualify and run use a new network namespace (only a loopback interface) when the host allows it. When it does not,
//   they are BLOCKED. Only the owner can accept the weaker guard-only mode with --accept-guard-only-network.
// - Python packages are installed only from the checked local wheels: no index, no source builds, no dependency resolution.
// - preflight reads files only. It starts no process, uses no network, and does not import or run See-through code.
// - The See-through process gets a fixed argument list, a minimal environment without secrets, offline Hugging Face settings,
//   and the guard (guard.py) with audit hooks against network calls, new processes, pickle, and writes outside the run directories.
//   The guard is defense in depth, not the sandbox.
// - The run is accepted only when qualify passed, the guard recorded no denial, the expected configuration files were read, and
//   the outputs are regular PSD, PNG, or JSON files inside the output directory.
// - The log and the reports contain no environment values and no tokens.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  fchmodSync,
  fstatSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
  writeSync
} from 'node:fs';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------- pins

export const bundleFormat = 'aigg.l0-seethrough-bundle/0.2';
export const resultFormat = 'aigg.l0-seethrough-result/0.2';
export const qualifyFormat = 'aigg.l0-seethrough-qualify/0.1';
export const guardFormat = 'aigg.l0-seethrough-guard/0.2';
export const minimumNode = '22.12.0';

export const seeThrough = {
  repository: 'https://github.com/shitagaki-lab/see-through.git',
  commit: 'df019de5129d6c4b406587a14c3501669441a783',
  script: 'inference/scripts/inference_psd.py',
  checkedDirectories: ['common', 'inference/scripts']
} as const;

export type ModelRepository = { readonly key: string; readonly repository: string; readonly revision: string };
export const modelRepositories: readonly ModelRepository[] = [
  { key: 'layerdiff3d', repository: 'layerdifforg/seethroughv0.0.2_layerdiff3d', revision: '4477e6ce529bc6a141732e1a55a4932176db3b89' },
  { key: 'marigold', repository: '24yearsold/seethroughv0.0.1_marigold', revision: '4f4ffc46050b6feb764b628859968a26e76e6b6a' }
];

export const input = {
  name: 'concept-mirrored.png',
  stem: 'concept-mirrored',
  sha256: '175b3292437165380dd6cfb07c2b46b05a7dee11f90cd24307ba05326e8eae8b',
  maxBytes: 256 * 1024 * 1024
} as const;

export const seed = 1001;

/** The dedicated unprivileged user for all third-party Python. The owner makes it on the Pod (see docs/OWNER_RUN.md). */
export const runUser = 'aigg-l0';

/** Groups that give administrative rights or access to secrets. The run user must not be in one of them. */
export const privilegedGroups = ['root', 'sudo', 'admin', 'wheel', 'docker', 'lxd', 'disk', 'shadow', 'adm', 'kmem', 'sys', 'staff'] as const;

/** Paths on the Pod that can hold credentials. Each one that exists must not be readable by others (the run user is an other). */
export const hostSecretPaths = ['/root', '/etc/rp_environment', '/etc/sudoers'] as const;

/** Python modules that qualify imports: the direct requirements of the run path. Distribution name, then import name. */
export const qualifyModules: readonly { readonly distribution: string; readonly module: string }[] = [
  { distribution: 'torch', module: 'torch' },
  { distribution: 'torchvision', module: 'torchvision' },
  { distribution: 'numpy', module: 'numpy' },
  { distribution: 'opencv-python', module: 'cv2' },
  { distribution: 'pillow', module: 'PIL.Image' },
  { distribution: 'scipy', module: 'scipy' },
  { distribution: 'scikit-learn', module: 'sklearn' },
  { distribution: 'matplotlib', module: 'matplotlib' },
  { distribution: 'einops', module: 'einops' },
  { distribution: 'transformers', module: 'transformers' },
  { distribution: 'diffusers', module: 'diffusers' },
  { distribution: 'huggingface-hub', module: 'huggingface_hub' },
  { distribution: 'tokenizers', module: 'tokenizers' },
  { distribution: 'accelerate', module: 'accelerate' },
  { distribution: 'safetensors', module: 'safetensors' },
  { distribution: 'pycocotools', module: 'pycocotools' },
  { distribution: 'psd-tools', module: 'psd_tools' },
  { distribution: 'tqdm', module: 'tqdm' },
  { distribution: 'pyyaml', module: 'yaml' }
];

/** The CUDA version of the pinned PyTorch build. */
export const cudaVersion = '12.8';

/** Files that the run must read from the Hugging Face cache. If one is not read, See-through possibly used its built-in fallback. */
export const requiredReads: readonly { readonly key: string; readonly path: string }[] = [
  { key: 'layerdiff3d', path: 'model_index.json' },
  { key: 'layerdiff3d', path: 'scheduler/scheduler_config.json' },
  { key: 'marigold', path: 'model_index.json' }
];

/** Arguments that must never reach See-through. They enable LaMa (pickle download), offload, or other checkpoints. */
export const forbiddenArguments = ['--tblr_split', '--group_offload', '--vae_ckpt', '--unet_ckpt'] as const;

/** The fixed See-through arguments. Paths are absolute paths in the work directory. */
export function seeThroughArguments(inputPath: string, outputDirectory: string): string[] {
  const [layerdiff, marigold] = modelRepositories;
  return [
    '--srcp',
    inputPath,
    '--save_dir',
    outputDirectory,
    '--seed',
    String(seed),
    '--repo_id_layerdiff',
    layerdiff?.repository ?? '',
    '--repo_id_depth',
    marigold?.repository ?? '',
    '--resolution',
    '1280',
    '--resolution_depth',
    '768',
    '--inference_steps',
    '30',
    '--inference_steps_depth',
    '-1',
    '--save_to_psd',
    '--disable_progressbar'
  ];
}

export const limits = {
  gpuMemoryMiB: 16384,
  driverMajor: 570,
  venvBytes: 12 * 1024 ** 3,
  marginBytes: 2 * 1024 ** 3,
  runFreeBytes: 10 * 1024 ** 3,
  runTimeoutSeconds: 3600,
  qualifyTimeoutSeconds: 900,
  evidenceFileBytes: 256 * 1024 * 1024,
  outputFiles: 2000,
  outputBytes: 4 * 1024 ** 3,
  commandTimeoutSeconds: 1800
} as const;

/**
 * Allowed download hosts for each source. Wheels come only from files.pythonhosted.org. Model files start at huggingface.co and can
 * be sent to the storage hosts of Hugging Face: names below hf.co or huggingface.co (both domains belong to Hugging Face).
 * Any other host stops the download.
 */
export const downloadHosts = {
  wheels: [/^files\.pythonhosted\.org$/],
  models: [/^huggingface\.co$/, /^([a-z0-9-]+\.)+hf\.co$/, /^([a-z0-9-]+\.)+huggingface\.co$/]
} as const;
export type DownloadSource = keyof typeof downloadHosts;

/** Output files of See-through that the runner accepts: PSD files, part images, and JSON metadata. */
export const outputExtensions = ['.psd', '.png', '.json'] as const;

// ---------------------------------------------------------------- errors and small helpers

export class RunnerError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(code: string, message: string, hint?: string, exitCode = 1) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

export function fail(code: string, message: string, hint?: string, exitCode = 1): never {
  throw new RunnerError(code, message, hint, exitCode);
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex64 = /^[0-9a-f]{64}$/;
const hex40 = /^[0-9a-f]{40}$/;
const plainPath = /^[A-Za-z0-9_.][A-Za-z0-9._-]*(\/[A-Za-z0-9_.][A-Za-z0-9._-]*)*$/;
const outputPart = /^[A-Za-z0-9_.-]+(?: [A-Za-z0-9_.-]+)*$/;
const windowsDevice = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:[ .]|$)/i;
const wheelName = /^[A-Za-z0-9_.+-]+\.whl$/;
const packageName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Prints untrusted text for a message: cut, printable ASCII only. */
export function show(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  const cut = text.length > 200 ? `${text.slice(0, 200)}...` : text;
  return cut.replace(/[^\x20-\x7e]/g, '?');
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** SHA-256 of a file, read as a stream. The file must be a regular file (no link). */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  for await (const part of createReadStream('', { fd, autoClose: true })) hash.update(part as Buffer);
  return hash.digest('hex');
}

/** The Git blob id (SHA-1) of a file, as the Hugging Face tree API gives it for files without LFS. */
export function gitBlobSha1(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Normalizes a Python distribution name (PEP 503). */
export const normalizeName = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');

function isSafePlainPath(path: string): boolean {
  return plainPath.test(path) && !path.split('/').some((part) => part === '.' || part === '..');
}

/** A path inside a root. The relative path must be plain. */
export function inside(root: string, relative: string): string {
  if (!isSafePlainPath(relative)) fail('E_PATH', `The path ${show(relative)} is not a plain relative path.`, undefined, 2);
  return join(root, ...relative.split('/'));
}

/** Output paths may have single internal ASCII spaces. Other bundle paths keep the stricter syntax. */
export function outputPath(root: string, relative: string): string {
  const parts = relative.split('/');
  if (parts.some((part) => !outputPart.test(part) || part === '.' || part === '..' || part.endsWith('.') || part.includes(' .') || part.includes('. ') || windowsDevice.test(part)))
    fail('E_PATH', `The path ${show(relative)} is not a plain relative path.`, undefined, 2);
  return join(root, ...parts);
}

/** Kind of an existing path, without following links. */
function kind(path: string): 'missing' | 'file' | 'directory' | 'link' | 'other' {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  if (info.isSymbolicLink()) return 'link';
  if (info.isFile()) return 'file';
  if (info.isDirectory()) return 'directory';
  return 'other';
}

/**
 * Makes sure that each part of a directory path below root is a real directory. Creates missing parts with the given mode
 * (default 0755: the run user must read the code, the venv, and the model cache, but cannot write there).
 */
export function realDirectoryBelow(root: string, relative: string, mode = 0o755): string {
  let current = root;
  for (const part of relative.split('/')) {
    if (part === '' || part === '.' || part === '..') fail('E_PATH', `The directory ${show(relative)} is not a plain path.`, undefined, 2);
    current = join(current, part);
    const found = kind(current);
    if (found === 'missing') {
      mkdirSync(current, { mode });
      chmodNoFollow(current, mode);
    } else if (found !== 'directory') fail('E_PATH', `${current} exists and is not a real directory (links are refused).`, 'Remove it, then run the command again.');
  }
  return current;
}

/** Reads a small file through one descriptor without following a link. */
export function readSmall(path: string, maxBytes: number, label: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return fail('E_FILE', `${label} cannot be opened (${show(code)}).`, code === 'ELOOP' ? 'Links are refused. Give the real file.' : undefined, 2);
  }
  try {
    if (!fstatSync(fd).isFile()) fail('E_FILE', `${label} is not a regular file.`, undefined, 2);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
      if (length > maxBytes) fail('E_FILE', `${label} is larger than ${maxBytes} bytes.`, undefined, 2);
    }
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/** Writes a file atomically: exclusive temporary file, then rename. A rename replaces a link itself and never follows it. */
export function writeAtomic(path: string, bytes: Uint8Array | string, mode = 0o600): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes, { flag: 'wx', mode });
  chmodSync(temporary, mode);
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Changes the mode of a directory or regular file through a descriptor opened without following a link. Other kinds are left as they are. */
export function chmodNoFollow(path: string, mode: number): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (info.isDirectory() || info.isFile()) fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

export type Logger = { readonly event: (event: string, data?: Record<string, unknown>) => void; readonly progress: (text: string) => void };

export function fileLogger(path: string | null, quiet = false): Logger {
  const fd = path === null ? null : openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  return {
    event: (event, data = {}) => {
      if (fd !== null) writeSync(fd, `${JSON.stringify({ time: new Date().toISOString(), event, ...data })}\n`);
    },
    progress: (text) => {
      if (!quiet) process.stderr.write(`${text}\n`);
    }
  };
}

// ---------------------------------------------------------------- manifest

export type ModelFile = { readonly repo: string; readonly path: string; readonly size: number; readonly gitBlobSha1: string; readonly sha256: string | null };
export type Wheel = { readonly name: string; readonly version: string; readonly file: string; readonly url: string; readonly size: number; readonly sha256: string };
export type SourceFile = { readonly path: string; readonly size: number; readonly sha256: string; readonly mode: string };
export type BundleFile = { readonly path: string; readonly sha256: string };

export type Manifest = {
  readonly format: string;
  readonly seeThrough: { readonly repository: string; readonly commit: string; readonly script: string; readonly files: readonly SourceFile[] };
  readonly models: { readonly repositories: readonly ModelRepository[]; readonly files: readonly ModelFile[] };
  readonly python: { readonly version: string; readonly wheels: readonly Wheel[] };
  readonly input: { readonly name: string; readonly sha256: string };
  readonly run: { readonly seed: number; readonly forbiddenArguments: readonly string[] };
  readonly bundleFiles: readonly BundleFile[];
};

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) return fail('E_MANIFEST', `manifest.json ${label} must be a non-empty list.`);
  return value;
}

const positiveSize = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

export function parseModelFile(value: unknown): ModelFile {
  if (!isRecord(value)) return fail('E_MANIFEST', 'A model file entry is not an object.');
  const { repo, path, size, gitBlobSha1: blob, sha256: hash } = value;
  if (typeof repo !== 'string' || !modelRepositories.some((item) => item.key === repo)) fail('E_MANIFEST', `The model repository key ${show(repo)} is not pinned.`);
  if (typeof path !== 'string' || !isSafePlainPath(path)) fail('E_MANIFEST', `The model file path ${show(path)} is not a plain path.`);
  if (!positiveSize(size)) fail('E_MANIFEST', `The model file ${path} has no valid size.`);
  if (typeof blob !== 'string' || !hex40.test(blob)) fail('E_MANIFEST', `The model file ${path} has no valid Git blob id.`);
  if (hash !== null && (typeof hash !== 'string' || !hex64.test(hash))) fail('E_MANIFEST', `The model file ${path} has no valid SHA-256.`);
  if (/\.(bin|pt|pth|ckpt|pkl|pickle)$/i.test(path)) fail('E_MANIFEST_PICKLE', `The model file ${path} has a pickle-based format. Only safetensors weights are allowed.`);
  if (/\.safetensors$/.test(path) && hash === null) fail('E_MANIFEST', `The weight file ${path} has no SHA-256.`);
  return { repo, path, size, gitBlobSha1: blob, sha256: hash };
}

/** The compatibility tags of a wheel file name (PEP 427): Python tags, ABI tags, and platform tags. */
export function wheelTags(file: string): { readonly python: string[]; readonly abi: string[]; readonly platform: string[] } | null {
  const parts = file.replace(/\.whl$/, '').split('-');
  if (parts.length !== 5 && parts.length !== 6) return null;
  const [python = '', abi = '', platform = ''] = parts.slice(-3);
  return { python: python.split('.'), abi: abi.split('.'), platform: platform.split('.') };
}

const legacyManylinux: Record<string, number> = { manylinux1_x86_64: 5, manylinux2010_x86_64: 12, manylinux2014_x86_64: 17 };

/** The glibc minor version (2.x) that a platform tag needs, or null when the tag is not for Linux x86_64 with glibc. */
export function manylinuxGlibc(tag: string): number | null {
  if (tag === 'any') return 0;
  if (tag in legacyManylinux) return legacyManylinux[tag] ?? null;
  const match = /^manylinux_2_(\d+)_x86_64$/.exec(tag);
  return match ? Number(match[1]) : null;
}

/** The highest glibc minor version that the platform tags of the wheels need. Each wheel uses its least demanding tag. */
export function requiredGlibc(wheels: readonly Wheel[]): number {
  let highest = 0;
  for (const wheel of wheels) {
    const values = (wheelTags(wheel.file)?.platform ?? []).map(manylinuxGlibc).filter((value): value is number => value !== null);
    highest = Math.max(highest, Math.min(...values));
  }
  return highest;
}

/** A wheel must install on CPython 3.12, Linux x86_64, glibc 2.28: tag cp312, abi3 from cp3x to cp312, or py3, and a manylinux tag up to 2_28. */
export function wheelCompatible(file: string): boolean {
  const tags = wheelTags(file);
  if (tags === null) return false;
  const abi3 = tags.abi.includes('abi3') && tags.python.some((tag) => /^cp3\d+$/.test(tag) && Number(tag.slice(3)) <= 12);
  const python = abi3 || tags.python.some((tag) => tag === 'cp312' || tag === 'py3' || tag === 'py312');
  const abi = abi3 || tags.abi.some((tag) => tag === 'cp312' || tag === 'none');
  const platform = tags.platform.some((tag) => {
    const glibc = manylinuxGlibc(tag);
    return glibc !== null && glibc <= 28;
  });
  return python && abi && platform;
}

export function parseWheel(value: unknown): Wheel {
  if (!isRecord(value)) return fail('E_MANIFEST', 'A wheel entry is not an object.');
  const { name, version, file, url, size, sha256: hash } = value;
  if (typeof name !== 'string' || !packageName.test(name) || typeof version !== 'string' || !/^[A-Za-z0-9.+!_-]+$/.test(version))
    fail('E_MANIFEST', `The wheel ${show(name)} has no valid name or version.`);
  if (typeof file !== 'string' || !wheelName.test(file)) fail('E_MANIFEST_SOURCE_BUILD', `The package ${name} is not a wheel file. Source builds are not allowed.`);
  if (!wheelCompatible(file)) fail('E_MANIFEST_WHEEL_TAG', `The wheel ${file} is not for CPython 3.12 on Linux x86_64 with glibc 2.28.`);
  if (typeof url !== 'string' || !url.startsWith('https://files.pythonhosted.org/packages/') || !url.endsWith(`/${file}`) || url.includes('?') || url.includes('#'))
    fail('E_MANIFEST', `The wheel ${file} has no pinned files.pythonhosted.org URL.`);
  if (!positiveSize(size) || typeof hash !== 'string' || !hex64.test(hash)) fail('E_MANIFEST', `The wheel ${file} has no valid size or SHA-256.`);
  return { name, version, file, url, size, sha256: hash };
}

export function parseSourceFile(value: unknown): SourceFile {
  if (!isRecord(value)) return fail('E_MANIFEST', 'A See-through file entry is not an object.');
  const { path, size, sha256: hash, mode } = value;
  if (typeof path !== 'string' || !isSafePlainPath(path)) fail('E_MANIFEST', `The See-through path ${show(path)} is not a plain path.`);
  if (!Number.isSafeInteger(size) || (size as number) < 0 || typeof hash !== 'string' || !hex64.test(hash)) fail('E_MANIFEST', `The See-through file ${path} has no valid size or SHA-256.`);
  if (mode !== '100644' && mode !== '100755') fail('E_MANIFEST', `The See-through file ${path} is not a regular file in Git.`);
  return { path, size: size as number, sha256: hash, mode };
}

/** Parses manifest.json and checks it against the pins in this file. */
export function parseManifest(value: unknown): Manifest {
  if (!isRecord(value) || value.format !== bundleFormat) return fail('E_MANIFEST', `manifest.json format must be ${bundleFormat}.`);
  const st = value.seeThrough;
  if (!isRecord(st) || st.repository !== seeThrough.repository || st.commit !== seeThrough.commit || st.script !== seeThrough.script)
    fail('E_MANIFEST_PIN', 'The See-through repository, commit, or script in manifest.json is not the pinned value.');
  const sourceFiles = list(st.files, 'seeThrough.files').map(parseSourceFile);
  if (!sourceFiles.some((file) => file.path === seeThrough.script)) fail('E_MANIFEST', 'manifest.json does not list the See-through script.');
  if (!sourceFiles.every((file) => seeThrough.checkedDirectories.some((directory) => file.path.startsWith(`${directory}/`)) || file.path === 'LICENSE'))
    fail('E_MANIFEST', 'manifest.json lists a See-through file outside the checked directories.');
  const models = value.models;
  if (!isRecord(models) || JSON.stringify(models.repositories) !== JSON.stringify(modelRepositories))
    fail('E_MANIFEST_PIN', 'The model repositories or revisions in manifest.json are not the pinned values.');
  const modelFiles = list(models.files, 'models.files').map(parseModelFile);
  for (const required of requiredReads)
    if (!modelFiles.some((file) => file.repo === required.key && file.path === required.path)) fail('E_MANIFEST', `manifest.json does not list ${required.key}/${required.path}.`);
  const python = value.python;
  if (!isRecord(python) || python.version !== '3.12') fail('E_MANIFEST', 'manifest.json python.version must be 3.12.');
  const wheels = list(python.wheels, 'python.wheels').map(parseWheel);
  if (!wheels.some((wheel) => wheel.name === 'pip')) fail('E_MANIFEST', 'manifest.json does not list the pip wheel.');
  const inputValue = value.input;
  if (!isRecord(inputValue) || inputValue.name !== input.name || inputValue.sha256 !== input.sha256) fail('E_MANIFEST_PIN', 'The input image in manifest.json is not the pinned image.');
  const run = value.run;
  if (!isRecord(run) || run.seed !== seed || JSON.stringify(run.forbiddenArguments) !== JSON.stringify(forbiddenArguments))
    fail('E_MANIFEST_PIN', 'The run settings in manifest.json are not the pinned values.');
  const bundleFiles = list(value.bundleFiles, 'bundleFiles').map((item): BundleFile => {
    if (!isRecord(item) || typeof item.path !== 'string' || !/^[a-z0-9.-]+$/.test(item.path) || typeof item.sha256 !== 'string' || !hex64.test(item.sha256))
      return fail('E_MANIFEST', 'A bundle file entry is not valid.');
    return { path: item.path, sha256: item.sha256 };
  });
  for (const required of ['guard.py', 'qualify.py', 'requirements.lock']) if (!bundleFiles.some((file) => file.path === required)) fail('E_MANIFEST', `manifest.json does not list ${required}.`);
  const unique = (items: readonly string[], label: string): void => {
    if (new Set(items).size !== items.length) fail('E_MANIFEST', `manifest.json has duplicate ${label}.`);
  };
  unique(
    sourceFiles.map((file) => file.path),
    'See-through files'
  );
  unique(
    modelFiles.map((file) => `${file.repo}/${file.path}`),
    'model files'
  );
  unique(
    wheels.map((wheel) => normalizeName(wheel.name)),
    'wheel names'
  );
  unique(
    wheels.map((wheel) => wheel.file),
    'wheel files'
  );
  return {
    format: bundleFormat,
    seeThrough: { repository: seeThrough.repository, commit: seeThrough.commit, script: seeThrough.script, files: sourceFiles },
    models: { repositories: modelRepositories, files: modelFiles },
    python: { version: '3.12', wheels },
    input: { name: input.name, sha256: input.sha256 },
    run: { seed, forbiddenArguments },
    bundleFiles
  };
}

/** The pip requirements file: one line per wheel, with only the SHA-256 of that wheel. */
export function requirementsLock(wheels: readonly Wheel[]): string {
  return `${[...wheels]
    .sort((a, b) => (normalizeName(a.name) < normalizeName(b.name) ? -1 : 1))
    .map((wheel) => `${normalizeName(wheel.name)}==${wheel.version} --hash=sha256:${wheel.sha256}`)
    .join('\n')}\n`;
}

export type LoadedBundle = { readonly root: string; readonly manifest: Manifest; readonly manifestSha256: string };

/** Reads manifest.json and checks each listed bundle file. */
export function loadBundle(root: string): LoadedBundle {
  let parsed: unknown;
  const manifestBytes = readSmall(join(root, 'manifest.json'), 4 * 1024 * 1024, 'manifest.json');
  try {
    parsed = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    return fail('E_MANIFEST', 'manifest.json is not valid JSON.');
  }
  const manifest = parseManifest(parsed);
  for (const file of manifest.bundleFiles) {
    const actual = sha256(readSmall(inside(root, file.path), 4 * 1024 * 1024, `The bundle file ${file.path}`));
    if (actual !== file.sha256) fail('E_BUNDLE_INTEGRITY', `The bundle file ${file.path} was changed.`, 'Copy the bundle again and check SHA256SUMS.');
  }
  const lock = readSmall(join(root, 'requirements.lock'), 4 * 1024 * 1024, 'requirements.lock').toString('utf8');
  if (lock !== requirementsLock(manifest.python.wheels)) fail('E_BUNDLE_INTEGRITY', 'requirements.lock does not agree with the wheels in manifest.json.');
  return { root, manifest, manifestSha256: sha256(manifestBytes) };
}

// ---------------------------------------------------------------- work directory layout

export type Layout = {
  readonly work: string;
  readonly wheelhouse: string;
  readonly hfHome: string;
  readonly hfCache: string;
  readonly seeThrough: string;
  readonly venv: string;
  readonly python: string;
  readonly inputDirectory: string;
  readonly inputPath: string;
  readonly control: string;
  readonly runDirectory: string;
  readonly logs: string;
  readonly output: string;
  readonly evidence: string;
};

export function layout(work: string): Layout {
  const venv = join(work, 'venv');
  return {
    work,
    wheelhouse: join(work, 'wheelhouse'),
    hfHome: join(work, 'hf'),
    hfCache: join(work, 'hf', 'hub'),
    seeThrough: join(work, 'see-through'),
    venv,
    python: join(venv, 'bin', 'python'),
    inputDirectory: join(work, 'input'),
    inputPath: join(work, 'input', input.name),
    control: join(work, 'control'),
    runDirectory: join(work, 'run'),
    logs: join(work, 'run', 'logs'),
    output: join(work, 'output'),
    evidence: join(work, 'evidence')
  };
}

/** The work directory must exist, be a real directory of the runner user, and not be writable by other users. */
export function checkWork(path: string, host: Host = realHost): Layout {
  const full = resolve(path);
  const found = kind(full);
  if (found === 'missing') fail('E_WORK', `The work directory ${full} does not exist.`, 'Create it first, for example mkdir -m 755 /workspace/l0-1.', 2);
  if (found !== 'directory') fail('E_WORK', `The work directory ${full} is not a real directory (links are refused).`, undefined, 2);
  const info = lstatSync(full);
  if ((info.mode & 0o022) !== 0) fail('E_WORK', `The work directory ${full} is writable by group or others.`, 'Run chmod 755 on it.', 2);
  if (info.uid !== host.uid) fail('E_WORK', `The work directory ${full} does not belong to the user of the runner.`, 'Make it as the same user (root on the Pod).', 2);
  if (realpathSync(full) !== full) fail('E_WORK', `The path of the work directory ${full} contains a link.`, 'Give the real path.', 2);
  return layout(full);
}

// ---------------------------------------------------------------- identity and permissions

export type RunIdentity = { readonly name: string; readonly uid: number; readonly gid: number };

/**
 * Finds the run user in the passwd and group files (no process is started). The user must exist, must not be root or the runner
 * user, and must not be in a group that gives administrative rights.
 */
export function resolveRunUser(passwd: string | null, group: string | null, runnerUid: number, name: string = runUser): RunIdentity {
  const entry = (passwd ?? '')
    .split('\n')
    .map((line) => line.split(':'))
    .find((fields) => fields[0] === name);
  if (!entry)
    return fail(
      'E_RUN_USER_MISSING',
      `The run user ${name} does not exist.`,
      `BLOCKED: make it as in docs/OWNER_RUN.md (useradd --system --user-group --no-create-home --shell /usr/sbin/nologin ${name}).`,
      3
    );
  const uid = Number(entry[2]);
  const gid = Number(entry[3]);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || entry[2] === '' || entry[3] === '') return fail('E_RUN_USER', `The passwd entry of ${name} is not valid.`);
  if (uid === 0 || gid === 0) fail('E_RUN_USER', `The run user ${name} has user id or group id 0.`, 'The run user must be unprivileged.');
  if (uid === runnerUid) fail('E_RUN_USER', `The run user ${name} is the user of the runner.`, 'The run user must be a separate user.');
  for (const line of (group ?? '').split('\n')) {
    const [groupName = '', , groupId = '', members = ''] = line.split(':');
    if (groupName === '') continue;
    const member = Number(groupId) === gid || members.split(',').includes(name);
    if (member && (Number(groupId) === 0 || (privilegedGroups as readonly string[]).includes(groupName)))
      fail('E_RUN_USER', `The run user ${name} is in the group ${show(groupName)}.`, 'Remove it from administrative groups.');
  }
  return { name, uid, gid };
}

/** Commands that start third-party Python must start as root, because only root can start a process as the run user. */
export function requireRoot(host: Host): void {
  if (!host.isRoot) fail('E_ROOT_REQUIRED', 'This command must start as root on the Pod.', 'BLOCKED: the runner starts all third-party Python as the run user, and only root can do that.', 3);
}

const othersCanWrite = (mode: number): boolean => (mode & 0o022) !== 0;

/** The path and each parent directory: a real directory of root or the runner user, not writable by others unless sticky (like /tmp). */
export function checkTrustedPath(path: string, host: Host, label: string): void {
  let current = resolve(path);
  if (realpathSync(current) !== current) fail('E_PERMISSIONS', `The path of ${label} contains a link.`, 'Give the real path.');
  for (;;) {
    const info = lstatSync(current);
    if (!info.isDirectory()) fail('E_PERMISSIONS', `${current} is not a directory.`);
    if (info.uid !== 0 && info.uid !== host.uid) fail('E_PERMISSIONS', `${current} (a parent of ${label}) belongs to another user.`, 'Use a path that only root controls.');
    if (othersCanWrite(info.mode) && (info.mode & 0o1000) === 0) fail('E_PERMISSIONS', `${current} (a parent of ${label}) is writable by group or others.`, 'Use a path that only root can change.');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** The bundle directory and every file in it: owned by the runner user or root, not writable by group or others, no links. */
export function checkBundlePermissions(root: string, host: Host): void {
  checkTrustedPath(root, host, 'the bundle');
  for (const name of readdirSync(root)) {
    const info = lstatSync(join(root, name));
    if (!info.isFile()) fail('E_BUNDLE_PERMISSIONS', `The bundle entry ${show(name)} is not a regular file.`, 'Copy the bundle again.');
    if (info.uid !== 0 && info.uid !== host.uid) fail('E_BUNDLE_PERMISSIONS', `The bundle file ${show(name)} belongs to another user.`, 'Run chown -R root:root on the bundle.');
    if (othersCanWrite(info.mode)) fail('E_BUNDLE_PERMISSIONS', `The bundle file ${show(name)} is writable by group or others.`, 'Run chmod -R go-w on the bundle.');
  }
}

/**
 * A tree that the run user may read but not change: every entry belongs to the runner user (or root) and is not writable by group or
 * others. Links are allowed only where allowLinks is true (the venv has links to the system Python); their targets are not followed.
 */
export function checkSealedTree(root: string, host: Host, label: string, allowLinks = false): number {
  let count = 0;
  const visit = (path: string): void => {
    const info = lstatSync(path);
    count += 1;
    if (info.uid !== 0 && info.uid !== host.uid) fail('E_PERMISSIONS', `${label}: ${show(path)} belongs to another user.`, `Remove ${label} and run prepare again.`);
    if (info.isSymbolicLink()) {
      if (!allowLinks) fail('E_PERMISSIONS', `${label}: ${show(path)} is a link.`, `Remove ${label} and run prepare again.`);
      return;
    }
    if (othersCanWrite(info.mode)) fail('E_PERMISSIONS', `${label}: ${show(path)} is writable by group or others.`, `Remove ${label} and run prepare again.`);
    if (info.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else if (!info.isFile()) fail('E_PERMISSIONS', `${label}: ${show(path)} is a special file.`);
  };
  visit(root);
  return count;
}

/** Gives a tree to the runner user and removes write rights for group and others. Links are changed, never followed. */
export function sealTree(root: string, host: Host): void {
  const visit = (path: string): void => {
    host.chown(path, host.uid, host.gid);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return;
    chmodNoFollow(path, info.mode & 0o0755);
    if (info.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
  };
  visit(root);
}

/** A directory that only the run user can write (mode 0700). Its parent must already exist. */
export function runUserDirectory(lay: Layout, relative: string, identity: RunIdentity, host: Host): string {
  const path = realDirectoryBelow(lay.work, relative, 0o700);
  host.chown(path, identity.uid, identity.gid);
  chmodNoFollow(path, 0o700);
  return path;
}

/** run/ and its parts belong to the run user: home, temporary files, caches, and the guard logs. Nothing else is writable for it. */
export function prepareRunDirectories(lay: Layout, identity: RunIdentity, host: Host): void {
  for (const directory of ['run', 'run/home', 'run/tmp', 'run/mpl', 'run/cache', 'run/torch', 'run/logs']) runUserDirectory(lay, directory, identity, host);
}

/** Each existing secret path must not be readable by others: the run user is an other. */
export function checkHostSecrets(host: Host): void {
  for (const path of host.secretPaths) {
    let info;
    try {
      info = lstatSync(path);
    } catch {
      continue;
    }
    if ((info.mode & (info.isDirectory() ? 0o005 : 0o004)) !== 0)
      fail('E_HOST_SECRET_READABLE', `${path} is readable by other users. It can hold credentials.`, `Run chmod o-rwx ${path} before any third-party Python runs.`);
  }
}

const repositoryFolder = (repository: string): string => `models--${repository.replace('/', '--')}`;

export function modelPath(lay: Layout, file: ModelFile): string {
  const repository = modelRepositories.find((item) => item.key === file.repo);
  if (!repository) return fail('E_MANIFEST', `Unknown model repository ${show(file.repo)}.`);
  return inside(join(lay.hfCache, repositoryFolder(repository.repository), 'snapshots', repository.revision), file.path);
}

// ---------------------------------------------------------------- checks of existing files

export type FileState = 'verified' | 'missing';

/** Checks an existing file by size and hash. A file with other content stops the runner. */
export async function checkExisting(path: string, size: number, check: (path: string) => Promise<boolean>, label: string): Promise<FileState> {
  const found = kind(path);
  if (found === 'missing') return 'missing';
  if (found !== 'file') fail('E_FILE', `${label} exists and is not a regular file (links are refused).`, 'Remove it. The runner never replaces it.');
  if (lstatSync(path).size !== size) fail('E_HASH_MISMATCH', `${label} exists with ${lstatSync(path).size} bytes, not the pinned ${size}.`, 'Do not use it. Remove it and run prepare again.');
  if (!(await check(path))) fail('E_HASH_MISMATCH', `${label} exists and its hash is not the pinned value.`, 'Do not use it. Remove it and run prepare again. The runner never replaces it.');
  return 'verified';
}

export function modelCheck(file: ModelFile): (path: string) => Promise<boolean> {
  return async (path) => {
    if (file.sha256 !== null) return (await fileSha256(path)) === file.sha256;
    return gitBlobSha1(readSmall(path, 16 * 1024 * 1024, file.path)) === file.gitBlobSha1;
  };
}

export const wheelCheck =
  (wheel: Wheel) =>
  async (path: string): Promise<boolean> =>
    (await fileSha256(path)) === wheel.sha256;

/** Walks a directory. Links and special files are errors. Returns relative file paths. */
export function walk(root: string, relative = ''): string[] {
  const directory = relative === '' ? root : join(root, ...relative.split('/'));
  const result: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const path = relative === '' ? name : `${relative}/${name}`;
    const found = kind(join(directory, name));
    if (found === 'directory') result.push(...walk(root, path));
    else if (found === 'file') result.push(path);
    else fail('E_TREE', `${show(path)} is a link or a special file.`, 'Links are refused in checked directories.');
  }
  return result;
}

/** Checks the See-through checkout: every pinned file has its pinned SHA-256, and the checked directories have no other files. */
export async function checkSource(lay: Layout, manifest: Manifest): Promise<'verified' | 'missing'> {
  if (kind(lay.seeThrough) === 'missing') return 'missing';
  realDirectoryBelow(lay.work, 'see-through');
  const expected = new Map(manifest.seeThrough.files.map((file) => [file.path, file]));
  for (const directory of seeThrough.checkedDirectories) {
    const base = inside(lay.seeThrough, directory);
    if (kind(base) !== 'directory') return fail('E_SOURCE', `The See-through checkout has no directory ${directory}.`);
    for (const path of walk(base)) {
      const full = `${directory}/${path}`;
      if (full.split('/').includes('__pycache__')) fail('E_SOURCE', `The See-through checkout has a cache file ${show(full)}.`, 'Remove the checkout and run prepare again.');
      if (!expected.has(full)) fail('E_SOURCE_EXTRA_FILE', `The See-through checkout has a file that is not pinned: ${show(full)}.`, 'Remove the checkout and run prepare again.');
    }
  }
  for (const file of manifest.seeThrough.files) {
    const path = inside(lay.seeThrough, file.path);
    if ((await checkExisting(path, file.size, async (p) => (await fileSha256(p)) === file.sha256, `See-through file ${file.path}`)) === 'missing')
      fail('E_SOURCE', `The See-through file ${file.path} is missing.`, 'Remove the checkout and run prepare again.');
  }
  return 'verified';
}

/**
 * The Hugging Face home must hold only hub/ with the two pinned repository folders, and each folder only refs/main and the pinned files
 * in snapshots/<revision>/ (a .part file of a pinned file is an interrupted download). No token file, no other revision, no blobs, no links.
 * Then the offline lookup of the pinned revision can find only the pinned files.
 */
export function checkModelCache(lay: Layout, manifest: Manifest): void {
  if (kind(lay.hfHome) === 'missing') return;
  const extra = (path: string): never => fail('E_MODEL_CACHE_EXTRA', `The model cache has an entry that is not pinned: ${show(path)}.`, 'Remove it. The cache must hold only the pinned files.');
  for (const name of readdirSync(lay.hfHome)) if (name !== 'hub') extra(`hf/${name}`);
  if (kind(lay.hfCache) === 'missing') return;
  for (const name of readdirSync(lay.hfCache)) {
    const repository = modelRepositories.find((item) => repositoryFolder(item.repository) === name);
    if (!repository) {
      extra(`hf/hub/${name}`);
      continue;
    }
    const allowed = new Set(['refs/main']);
    for (const file of manifest.models.files.filter((item) => item.repo === repository.key)) {
      allowed.add(`snapshots/${repository.revision}/${file.path}`);
      allowed.add(`snapshots/${repository.revision}/${file.path}.part`);
    }
    const folder = join(lay.hfCache, name);
    const only = (directory: string, names: readonly string[]): void => {
      if (kind(join(folder, directory)) === 'directory') for (const entry of readdirSync(join(folder, directory))) if (!names.includes(entry)) extra(`hf/hub/${name}/${directory}/${entry}`);
    };
    for (const entry of readdirSync(folder)) if (entry !== 'refs' && entry !== 'snapshots') extra(`hf/hub/${name}/${entry}`);
    only('refs', ['main']);
    only('snapshots', [repository.revision]);
    for (const path of walk(folder)) if (!allowed.has(path)) extra(`hf/hub/${name}/${path}`);
  }
}

/** The wheelhouse must hold only the pinned wheels (and .part files of interrupted downloads). */
export function checkWheelhouse(lay: Layout, manifest: Manifest): void {
  if (kind(lay.wheelhouse) === 'missing') return;
  const allowed = new Set(manifest.python.wheels.flatMap((wheel) => [wheel.file, `${wheel.file}.part`]));
  for (const path of walk(lay.wheelhouse)) if (!allowed.has(path)) fail('E_WHEELHOUSE_EXTRA', `The wheelhouse has a file that is not pinned: ${show(path)}.`, 'Remove it.');
}

/** Reads the installed distributions from the venv metadata. No Python is started. */
export function installedPackages(lay: Layout): Map<string, string> {
  const site = join(lay.venv, 'lib', 'python3.12', 'site-packages');
  const found = new Map<string, string>();
  if (kind(site) !== 'directory') return found;
  for (const name of readdirSync(site)) {
    if (!name.endsWith('.dist-info')) continue;
    const metadata = readSmall(join(site, name, 'METADATA'), 4 * 1024 * 1024, `${name}/METADATA`).toString('utf8');
    const head = metadata.split(/\r?\n\r?\n/, 1)[0] ?? '';
    const packageValue = /^Name: *(.+)$/m.exec(head)?.[1]?.trim();
    const version = /^Version: *(.+)$/m.exec(head)?.[1]?.trim();
    if (!packageValue || !version) fail('E_VENV', `The metadata ${show(name)} has no name or version.`);
    const key = normalizeName(packageValue);
    if (found.has(key)) fail('E_VENV', `The venv has two versions of ${show(key)}.`);
    found.set(key, version);
  }
  return found;
}

export type VenvState = { readonly state: 'verified' | 'missing'; readonly python: string | null };

/** Checks the venv: Python 3.12 in pyvenv.cfg and exactly the pinned packages. */
export function checkVenv(lay: Layout, manifest: Manifest): VenvState {
  if (kind(lay.venv) === 'missing') return { state: 'missing', python: null };
  realDirectoryBelow(lay.work, 'venv');
  const config = readSmall(join(lay.venv, 'pyvenv.cfg'), 64 * 1024, 'venv/pyvenv.cfg').toString('utf8');
  const version = /^version(?:_info)? *= *(\d+\.\d+\.\d+)/m.exec(config)?.[1] ?? null;
  if (version === null || !version.startsWith('3.12.')) fail('E_VENV_PYTHON', `The venv uses Python ${show(version)}, not 3.12.`, 'Remove venv and run prepare with Python 3.12.');
  if (/^include-system-site-packages *= *true/m.test(config)) fail('E_VENV', 'The venv includes the system site packages.', 'Remove venv and run prepare again.');
  const installed = installedPackages(lay);
  const expected = new Map(manifest.python.wheels.map((wheel) => [normalizeName(wheel.name), wheel.version]));
  for (const [name, versionValue] of expected) {
    const actual = installed.get(name);
    if (actual === undefined) fail('E_VENV_PACKAGE_MISSING', `The venv has no ${name}.`, 'Remove venv and run prepare again.');
    if (actual !== versionValue) fail('E_VENV_PACKAGE_VERSION', `The venv has ${name} ${show(actual)}, not ${versionValue}.`, 'Remove venv and run prepare again.');
  }
  for (const name of installed.keys()) if (!expected.has(name)) fail('E_VENV_PACKAGE_EXTRA', `The venv has a package that is not pinned: ${show(name)}.`, 'Remove venv and run prepare again.');
  return { state: 'verified', python: version };
}

/** Finds python3.12 in PATH without starting it. */
export function findPython(pathValue: string | undefined): string | null {
  for (const directory of (pathValue ?? '').split(delimiter)) {
    if (directory === '' || !directory.startsWith('/')) continue;
    const candidate = join(directory, 'python3.12');
    try {
      const real = realpathSync(candidate);
      if (lstatSync(real).isFile()) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

export type InputState = { readonly state: 'verified' | 'missing'; readonly path: string | null };

export function checkInputFile(path: string, expected: string = input.sha256): void {
  const bytes = readSmall(path, input.maxBytes, 'The input image');
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail('E_INPUT', 'The input image is not a PNG file.', undefined, 2);
  if (sha256(bytes) !== expected) fail('E_INPUT_HASH', `The input image is not the pinned ${input.name} (SHA-256 ${input.sha256}).`, 'Use concept-mirrored.png from l0-input-v1.tar.gz.', 2);
}

// ---------------------------------------------------------------- preflight

export type Check = { readonly id: string; readonly status: 'PASS' | 'MISSING' | 'FAIL'; readonly message: string };
export type PreflightReport = { readonly format: string; readonly status: 'READY' | 'INCOMPLETE' | 'FAIL'; readonly checks: readonly Check[] };

/**
 * preflight: reads files only. It starts no process, uses no network, and does not import See-through code.
 * Missing files give INCOMPLETE. Files with other content give FAIL.
 */
export async function preflight(
  bundle: LoadedBundle,
  lay: Layout,
  inputPath: string | null,
  log: Logger,
  env: NodeJS.ProcessEnv = process.env,
  expectedInput: string = input.sha256,
  host: Host = realHost
): Promise<PreflightReport> {
  const checks: Check[] = [];
  const run = async (id: string, action: () => Promise<string | null> | string | null): Promise<void> => {
    try {
      const missing = await action();
      checks.push(missing === null ? { id, status: 'PASS', message: 'OK' } : { id, status: 'MISSING', message: missing });
    } catch (error) {
      if (!(error instanceof RunnerError)) throw error;
      checks.push({ id, status: 'FAIL', message: `${error.code}: ${error.message}` });
    }
  };
  const { manifest } = bundle;
  await run('node', () => (versionAtLeast(process.versions.node, minimumNode) ? null : fail('E_NODE', `Node.js ${process.versions.node} is older than ${minimumNode}.`)));
  await run('platform', () => (host.platform === 'linux' && host.arch === 'x64' ? null : fail('E_PLATFORM', 'The GPU host must be Linux x86_64.')));
  await run('glibc', () => {
    const needed = requiredGlibc(manifest.python.wheels);
    const actual = host.glibc();
    if (actual === null || !versionAtLeast(actual, `2.${needed}.0`)) fail('E_GLIBC', `The host glibc is ${show(actual)}. The pinned wheels need glibc 2.${needed} or later.`);
    return null;
  });
  await run('run-user', () => {
    try {
      identityFor(host);
      return null;
    } catch (error) {
      if (error instanceof RunnerError && error.code === 'E_RUN_USER_MISSING') return `${error.message} ${error.hint ?? ''}`.trim();
      throw error;
    }
  });
  await run('host-secrets', () => {
    checkHostSecrets(host);
    return null;
  });
  await run('permissions', () => {
    checkBundlePermissions(bundle.root, host);
    checkTrustedPath(lay.work, host, 'the work directory');
    for (const [path, label] of [
      [lay.seeThrough, 'see-through'],
      [lay.wheelhouse, 'wheelhouse'],
      [lay.hfHome, 'hf'],
      [lay.inputDirectory, 'input'],
      [lay.control, 'control']
    ] as const)
      if (kind(path) !== 'missing') checkSealedTree(path, host, label);
    if (kind(lay.venv) !== 'missing') checkSealedTree(lay.venv, host, 'venv', true);
    return null;
  });
  await run('python', () => (kind(lay.venv) === 'missing' && findPython(env.PATH) === null ? 'python3.12 is not in PATH. prepare needs it to make the venv.' : null));
  await run('disk', () => {
    const free = host.freeBytes(lay.work);
    return free < limits.runFreeBytes ? fail('E_DISK', `Only ${free} bytes are free in the work directory.`) : null;
  });
  await run('see-through', async () => ((await checkSource(lay, manifest)) === 'missing' ? 'The See-through checkout is missing.' : null));
  await run('wheels', async () => {
    checkWheelhouse(lay, manifest);
    let missing = 0;
    for (const wheel of manifest.python.wheels) if ((await checkExisting(inside(lay.wheelhouse, wheel.file), wheel.size, wheelCheck(wheel), wheel.file)) === 'missing') missing += 1;
    return missing === 0 ? null : `${missing} of ${manifest.python.wheels.length} wheels are missing.`;
  });
  await run('models', async () => {
    checkModelCache(lay, manifest);
    let missing = 0;
    for (const file of manifest.models.files) {
      if (file.sha256 !== null && kind(modelPath(lay, file)) === 'file') log.progress(`Checking SHA-256 of ${file.repo}/${file.path} ...`);
      if ((await checkExisting(modelPath(lay, file), file.size, modelCheck(file), `${file.repo}/${file.path}`)) === 'missing') missing += 1;
    }
    for (const repository of modelRepositories) {
      const reference = join(lay.hfCache, repositoryFolder(repository.repository), 'refs', 'main');
      if (kind(reference) === 'missing') missing += 1;
      else if (readSmall(reference, 64, 'refs/main').toString('utf8') !== repository.revision) fail('E_MODEL_REF', `refs/main of ${repository.repository} is not the pinned revision.`);
    }
    return missing === 0 ? null : `${missing} model files or references are missing.`;
  });
  await run('venv', () => (checkVenv(lay, manifest).state === 'missing' ? 'The venv is missing.' : null));
  await run('input', () => {
    const path = inputPath ?? (kind(lay.inputPath) === 'missing' ? null : lay.inputPath);
    if (path === null || kind(path) === 'missing') return 'No input image. Give --input concept-mirrored.png.';
    checkInputFile(path, expectedInput);
    return null;
  });
  const status = checks.some((check) => check.status === 'FAIL') ? 'FAIL' : checks.some((check) => check.status === 'MISSING') ? 'INCOMPLETE' : 'READY';
  log.event('preflight', { status, checks });
  return { format: 'aigg.l0-seethrough-preflight/0.1', status, checks };
}

export function versionAtLeast(actual: string, minimum: string): boolean {
  const a = actual.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function freeBytes(path: string): number {
  const info = statfsSync(path);
  return info.bavail * info.bsize;
}

function readSystemText(path: string): string | null {
  try {
    return readSmall(path, 4 * 1024 * 1024, path).toString('utf8');
  } catch {
    return null;
  }
}

function runtimeGlibc(): string | null {
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } };
  const value = report.header?.glibcVersionRuntime;
  return typeof value === 'string' ? value : null;
}

/**
 * Host facts and the one host change (chown) that the runner uses. Tests give synthetic values.
 * isRoot and uid are separate only for tests: on the Pod, isRoot is uid === 0.
 */
export type Host = {
  readonly platform: string;
  readonly arch: string;
  readonly freeBytes: (path: string) => number;
  readonly isRoot: boolean;
  readonly uid: number;
  readonly gid: number;
  readonly readText: (path: string) => string | null;
  readonly secretPaths: readonly string[];
  readonly glibc: () => string | null;
  readonly chown: (path: string, uid: number, gid: number) => void;
  /** Kills the remaining processes of a user id (collect after a stop). Tests record the call. */
  readonly reapUser: (uid: number) => Promise<{ killed: number; survivors: number[] }>;
};
const processUid = process.getuid?.() ?? -1;
export const realHost: Host = {
  platform: process.platform,
  arch: process.arch,
  freeBytes,
  isRoot: processUid === 0,
  uid: processUid,
  gid: process.getgid?.() ?? -1,
  readText: readSystemText,
  secretPaths: hostSecretPaths,
  glibc: runtimeGlibc,
  chown: lchownSync,
  reapUser: (uid) => reapProcesses(byUid(uid))
};

export const identityFor = (host: Host): RunIdentity => resolveRunUser(host.readText('/etc/passwd'), host.readText('/etc/group'), host.uid);

// ---------------------------------------------------------------- subprocesses

/**
 * The end of a process. cancelled: the runner got SIGINT, SIGTERM, or SIGHUP and stopped the process.
 * leftovers: processes of the same selection (the run user) that were still alive after the process ended. The runner kills them;
 * survivors are those that were still alive after the bounded wait. Fakes in tests can leave out the optional fields.
 */
export type ProcessResult = {
  readonly code: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled?: boolean;
  readonly leftovers?: { readonly killed: number; readonly survivors: readonly number[] };
};

/** Problems in a process result that make a stage FAIL: cancel, leftover processes, and survivors. */
export function processProblems(result: ProcessResult, label: string): string[] {
  const problems: string[] = [];
  if (result.cancelled === true) problems.push(`E_CANCELLED: ${label} was stopped by a signal to the runner.`);
  if ((result.leftovers?.killed ?? 0) > 0)
    problems.push(`E_ORPHAN_PROCESSES: ${result.leftovers?.killed ?? 0} processes of the run user were still alive after ${label} ended. The runner killed them.`);
  if ((result.leftovers?.survivors.length ?? 0) > 0)
    problems.push(`E_PROCESS_SURVIVED: processes of the run user are still alive after the kill: ${(result.leftovers?.survivors ?? []).join(', ')}. Terminate the Pod.`);
  return problems;
}

// ---------------------------------------------------------------- process tree control (Linux /proc)

/** Selects a process by its pid. */
export type ProcessSelector = (pid: number) => boolean;

function procText(pid: number, file: string): string | null {
  try {
    return readFileSync(`/proc/${pid}/${file}`, 'latin1');
  } catch {
    return null;
  }
}

/** Live processes (not zombies) in /proc. A zombie holds no memory, no GPU context, and runs no code. */
export function liveProcesses(): number[] {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return [];
  }
  return names
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .filter((pid) => pid !== process.pid && !/^State:\s+[ZX]/m.test(procText(pid, 'status') ?? 'State:\tZ'));
}

/** Processes with this real, effective, saved, or file-system user id. A process cannot leave its user id without privileges. */
export const byUid =
  (uid: number): ProcessSelector =>
  (pid) => {
    const line = /^Uid:\s+(.+)$/m.exec(procText(pid, 'status') ?? '')?.[1];
    return line !== undefined && line.split(/\s+/).some((value) => Number(value) === uid);
  };

/** Processes whose environment holds this exact NAME=value entry. For tests that cannot use a separate user. */
export const byEnvironmentEntry =
  (entry: string): ProcessSelector =>
  (pid) =>
    (procText(pid, 'environ') ?? '').split('\0').includes(entry);

const pause = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/**
 * Kills every selected process with SIGKILL and repeats until none is alive or the time limit is reached. The repeat also stops
 * processes that a process made between two passes. Returns the number of killed processes and the pids that survived.
 */
export async function reapProcesses(select: ProcessSelector, limitMs = 10_000): Promise<{ killed: number; survivors: number[] }> {
  const killed = new Set<number>();
  const end = Date.now() + limitMs;
  for (;;) {
    const alive = liveProcesses().filter(select);
    if (alive.length === 0) return { killed: killed.size, survivors: [] };
    if (Date.now() > end) return { killed: killed.size, survivors: alive };
    for (const pid of alive) {
      try {
        process.kill(pid, 'SIGKILL');
        killed.add(pid);
      } catch {
        // The process ended between the scan and the kill.
      }
    }
    await pause(100);
  }
}

/** The pids of the processes that use the GPU, from nvidia-smi. An empty list means no compute process is on the GPU. */
export async function gpuProcesses(capture: Capture, env: Record<string, string>): Promise<string[] | null> {
  try {
    const result = await capture('nvidia-smi', ['--query-compute-apps=pid', '--format=csv,noheader'], env);
    if (result.code !== 0) return null;
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !/^no running/i.test(line));
  } catch {
    return null;
  }
}

/** Waits (at most limitMs) until nvidia-smi shows no compute process. null: nvidia-smi gave no answer. */
export async function waitGpuFree(capture: Capture, env: Record<string, string>, limitMs = 15_000): Promise<string[] | null> {
  const end = Date.now() + limitMs;
  for (;;) {
    const found = await gpuProcesses(capture, env);
    if (found === null || found.length === 0 || Date.now() > end) return found;
    await pause(500);
  }
}

/**
 * The GPU release state after qualify or run. UNKNOWN: nvidia-smi gave no list. This is not a proof that the GPU is free.
 * BUSY: nvidia-smi still shows a compute process (E_GPU_PROCESS_REMAINS). FREE: the list is empty.
 */
export function gpuReleaseState(gpuAfter: readonly string[] | null): 'FREE' | 'BUSY' | 'UNKNOWN' {
  if (gpuAfter === null) return 'UNKNOWN';
  return gpuAfter.length > 0 ? 'BUSY' : 'FREE';
}

/** The base environment for every subprocess. Nothing from the caller's environment is passed except PATH. */
export function baseEnvironment(lay: Layout, pathValue: string | undefined): Record<string, string> {
  const home = join(lay.runDirectory, 'home');
  return {
    PATH: (pathValue ?? '/usr/bin:/bin')
      .split(delimiter)
      .filter((item) => item.startsWith('/'))
      .join(delimiter),
    HOME: home,
    TMPDIR: join(lay.runDirectory, 'tmp'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8'
  };
}

/** The environment of the See-through process: offline Hugging Face settings, run-local caches, and no secrets. */
export function seeThroughEnvironment(lay: Layout, pathValue: string | undefined): Record<string, string> {
  return {
    ...baseEnvironment(lay, pathValue),
    PATH: [join(lay.venv, 'bin'), '/usr/bin', '/bin'].join(delimiter),
    HF_HOME: lay.hfHome,
    HF_HUB_CACHE: lay.hfCache,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_DATASETS_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
    DO_NOT_TRACK: '1',
    MPLCONFIGDIR: join(lay.runDirectory, 'mpl'),
    XDG_CACHE_HOME: join(lay.runDirectory, 'cache'),
    TORCH_HOME: join(lay.runDirectory, 'torch'),
    PYTHONHASHSEED: '0',
    CUDA_VISIBLE_DEVICES: '0'
  };
}

export type SpawnOptions = { cwd: string; env: Record<string, string>; timeoutSeconds: number; logPath: string; user?: RunIdentity; reap?: ProcessSelector };
export type Spawner = (command: string, args: readonly string[], options: SpawnOptions) => Promise<ProcessResult>;

/**
 * Starts a process with an argument array (no shell). Output goes to a log file that the runner opens (the child gets only the
 * descriptor). With user, the child runs with that user id and group id and no supplementary groups.
 *
 * Stop control (Linux): the child starts in a new session and process group. On timeout, or when the runner gets SIGINT, SIGTERM, or
 * SIGHUP, the runner kills the whole process group with SIGKILL. A descendant can leave the group (setsid) or ignore its parent, so
 * after the end of the child the runner also kills every process of the selection (default with user: all processes of the run user)
 * and waits at most 10 s until none is alive. The selection must be empty before the start: a busy run user is an error.
 */
export const spawnProcess: Spawner = async (command, args, options) => {
  const select = options.reap ?? (options.user === undefined ? undefined : byUid(options.user.uid));
  if (select !== undefined) {
    const busy = liveProcesses().filter(select);
    if (busy.length > 0) fail('E_RUN_USER_BUSY', `Processes of the run user are already alive: ${busy.join(', ')}.`, 'Stop them (pkill -KILL -u aigg-l0) and check with ps -u aigg-l0.', 3);
  }
  const ended = await new Promise<ProcessResult>((resolvePromise, reject) => {
    const fd = openSync(options.logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    const identity = options.user === undefined ? {} : { uid: options.user.uid, gid: options.user.gid };
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, shell: false, stdio: ['ignore', fd, fd], detached: true, ...identity });
    let timedOut = false;
    let cancelled = false;
    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const onSignal = (): void => {
      cancelled = true;
      killGroup();
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    for (const signal of signals) process.on(signal, onSignal);
    const done = (): void => {
      clearTimeout(timer);
      for (const signal of signals) process.off(signal, onSignal);
      closeSync(fd);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutSeconds * 1000);
    child.on('error', (error) => {
      done();
      reject(error);
    });
    child.on('close', (code, signal) => {
      done();
      resolvePromise({ code, signal, timedOut, cancelled });
    });
  });
  if (select === undefined) return ended;
  const leftovers = await reapProcesses(select);
  return { ...ended, leftovers };
};

/** Runs a process and captures its standard output (small). Used for nvidia-smi and the network isolation check only. */
export type Capture = (command: string, args: readonly string[], env: Record<string, string>, user?: RunIdentity) => Promise<{ code: number | null; stdout: string }>;

export const captureProcess: Capture = (command, args, env, user) =>
  new Promise((resolvePromise, reject) => {
    const identity = user === undefined ? {} : { uid: user.uid, gid: user.gid };
    const child = spawn(command, [...args], { env, shell: false, stdio: ['ignore', 'pipe', 'ignore'], ...identity });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (part: string) => {
      if (stdout.length < 64 * 1024) stdout += part;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout });
    });
  });

// ---------------------------------------------------------------- network isolation

/** The command prefix that starts a process in a new user and network namespace. The process keeps its user id (no root mapping). */
export const isolationPrefix = ['unshare', '--user', '--net', '--map-current-user', '--'] as const;

export type IsolationReport = {
  readonly status: 'ISOLATED' | 'UNAVAILABLE';
  readonly method: 'network-namespace';
  readonly interfaces: readonly string[];
  readonly message: string;
};

/** Interface names from /proc/self/net/dev. */
export function parseNetDev(text: string): string[] {
  return text
    .split(/\r?\n/)
    .slice(2)
    .map((line) => line.split(':')[0]?.trim() ?? '')
    .filter((name) => name !== '');
}

/**
 * Checks, as the run user, that a new network namespace can be made and that it has only the loopback interface.
 * It starts only unshare and cat (system tools). A host that does not allow user namespaces gives UNAVAILABLE. It never changes
 * firewall rules or other host settings.
 */
export async function isolationCheck(lay: Layout, identity: RunIdentity, capture: Capture, env: NodeJS.ProcessEnv, log: Logger): Promise<IsolationReport> {
  let result;
  try {
    result = await capture(isolationPrefix[0], [...isolationPrefix.slice(1), 'cat', '/proc/self/net/dev'], baseEnvironment(lay, env.PATH), identity);
  } catch {
    result = { code: null, stdout: '' };
  }
  const interfaces = result.code === 0 ? parseNetDev(result.stdout) : [];
  const report: IsolationReport =
    result.code === 0 && interfaces.length === 1 && interfaces[0] === 'lo'
      ? { status: 'ISOLATED', method: 'network-namespace', interfaces, message: 'A new network namespace with only the loopback interface is available.' }
      : {
          status: 'UNAVAILABLE',
          method: 'network-namespace',
          interfaces: interfaces.map(show),
          message:
            result.code === 0
              ? 'The new network namespace has other interfaces than lo.'
              : 'The host does not allow a new user and network namespace for the run user (for example a seccomp profile or a kernel setting).'
        };
  log.event('isolation', report);
  return report;
}

export type NetworkMode = { readonly mode: 'network-namespace' | 'guard-only-owner-accepted'; readonly report: IsolationReport };

/** The network decision for qualify and run: isolated, or BLOCKED unless the owner gave --accept-guard-only-network. Never silent. */
export function networkMode(report: IsolationReport, acceptGuardOnly: boolean): NetworkMode {
  if (report.status === 'ISOLATED') return { mode: 'network-namespace', report };
  if (acceptGuardOnly) return { mode: 'guard-only-owner-accepted', report };
  return fail(
    'E_NETWORK_ISOLATION_UNAVAILABLE',
    `Network isolation is not available: ${report.message}`,
    'BLOCKED. The owner decides: stop here, or accept the weaker guard-only mode with --accept-guard-only-network (see SECURITY.md).',
    3
  );
}

/** The command and arguments for a Python process in the chosen network mode. */
export function isolatedCommand(mode: NetworkMode, command: string, args: readonly string[]): [string, string[]] {
  return mode.mode === 'network-namespace' ? [isolationPrefix[0], [...isolationPrefix.slice(1), command, ...args]] : [command, [...args]];
}

// ---------------------------------------------------------------- downloads

export type FetchFunction = (url: string, init?: RequestInit) => Promise<Response>;

export function allowedHost(url: string, source: DownloadSource): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.port === '' && downloadHosts[source].some((pattern) => pattern.test(parsed.hostname));
}

const redirectStatus = new Set([301, 302, 303, 307, 308]);
const maxRedirects = 5;
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return '<not a URL>';
  }
};

/**
 * Downloads one file of a source to a .part name. It follows at most 5 redirects; each target must be HTTPS on an allowed host of
 * that source. TLS certificates are checked by Node.js (no option turns this off). The size and the hash are checked before the
 * rename. A Content-Length that is not the pinned size stops the download before the body is read.
 */
export async function download(fetcher: FetchFunction, source: DownloadSource, url: string, target: string, size: number, check: (path: string) => Promise<boolean>, log: Logger): Promise<void> {
  const name = show(url.split('?')[0]);
  let current = url;
  let response: Response;
  for (let hop = 0; ; hop += 1) {
    if (!allowedHost(current, source)) fail('E_DOWNLOAD_HOST', `The download host ${show(hostOf(current))} is not allowed for ${source}.`, 'Nothing was kept. Stop and report it.');
    response = await fetcher(current, { redirect: 'manual', headers: { 'user-agent': 'aigg-l0-seethrough-runner', 'accept-encoding': 'identity' } });
    if (!redirectStatus.has(response.status)) break;
    await response.body?.cancel();
    if (hop >= maxRedirects) fail('E_DOWNLOAD_REDIRECT', `The download of ${name} has more than ${maxRedirects} redirects.`);
    const location = response.headers.get('location');
    if (location === null || location === '') fail('E_DOWNLOAD_REDIRECT', `A redirect of ${name} has no location.`);
    try {
      current = new URL(location, current).toString();
    } catch {
      fail('E_DOWNLOAD_REDIRECT', `A redirect of ${name} has a location that is not a URL.`);
    }
  }
  if (response.status !== 200 || response.body === null) fail('E_DOWNLOAD', `The download of ${name} failed with HTTP ${response.status}.`);
  const length = response.headers.get('content-length');
  const encoded = (response.headers.get('content-encoding') ?? 'identity') !== 'identity';
  if (length !== null && !encoded && length !== String(size)) {
    await response.body.cancel();
    fail('E_DOWNLOAD_SIZE', `The download of ${name} has Content-Length ${show(length)}, not the pinned ${size}.`);
  }
  const part = `${target}.part`;
  rmSync(part, { force: true });
  const fd = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  let written = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      written += chunk.length;
      if (written > size) fail('E_DOWNLOAD_SIZE', `The download of ${name} is larger than the pinned ${size} bytes.`);
      writeSync(fd, chunk);
    }
  } catch (error) {
    closeSync(fd);
    rmSync(part, { force: true });
    throw error;
  }
  closeSync(fd);
  if (written !== size || !(await check(part))) {
    rmSync(part, { force: true });
    fail('E_DOWNLOAD_HASH', `The download of ${name} does not agree with the pinned size and hash.`, 'Nothing was kept. Run prepare again. If it repeats, stop and report it.');
  }
  chmodSync(part, 0o644);
  renameSync(part, target);
  log.event('download', { url: url.split('?')[0], bytes: size });
}

// ---------------------------------------------------------------- prepare

/** Free space that prepare needs: the files that are not there yet, the venv when it is missing, and a margin. No hashing. */
export function requiredPrepareBytes(lay: Layout, manifest: Manifest): number {
  let bytes = limits.marginBytes;
  for (const wheel of manifest.python.wheels) if (kind(inside(lay.wheelhouse, wheel.file)) === 'missing') bytes += wheel.size;
  for (const file of manifest.models.files) if (kind(modelPath(lay, file)) === 'missing') bytes += file.size;
  if (kind(lay.venv) === 'missing') bytes += limits.venvBytes;
  return bytes;
}

export type PrepareDependencies = { readonly fetcher: FetchFunction; readonly spawner: Spawner; readonly env: NodeJS.ProcessEnv; readonly host?: Host };

/**
 * prepare: gets the pinned code, wheels and model files as root, and installs the venv from the local wheels as the run user.
 * Then it gives the venv to root (read-only for the run user). It never runs See-through.
 */
export async function prepare(bundle: LoadedBundle, lay: Layout, log: Logger, deps: PrepareDependencies): Promise<Record<string, unknown>> {
  const { manifest } = bundle;
  const host = deps.host ?? realHost;
  requireRoot(host);
  const identity = identityFor(host);
  checkHostSecrets(host);
  checkBundlePermissions(bundle.root, host);
  checkTrustedPath(lay.work, host, 'the work directory');
  realDirectoryBelow(lay.work, 'evidence', 0o700);
  realDirectoryBelow(lay.work, 'wheelhouse');
  prepareRunDirectories(lay, identity, host);
  checkWheelhouse(lay, manifest);
  checkModelCache(lay, manifest);
  const needed = requiredPrepareBytes(lay, manifest);
  if (host.freeBytes(lay.work) < needed) fail('E_DISK', `${needed} bytes must be free in the work directory for prepare.`, 'BLOCKED: use a larger volume.', 3);
  const env = baseEnvironment(lay, deps.env.PATH);
  const summary: Record<string, unknown> = {};

  // 1. See-through code at the pinned commit (git with an isolated configuration, HTTPS only).
  if ((await checkSource(lay, manifest)) === 'missing') {
    log.progress('Getting See-through at the pinned commit ...');
    const gitEnv = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };
    const gitLog = join(lay.evidence, 'git.log');
    const git = async (args: string[]): Promise<void> => {
      const result = await deps.spawner('git', ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: lay.work,
        env: gitEnv,
        timeoutSeconds: limits.commandTimeoutSeconds,
        logPath: gitLog
      });
      if (result.code !== 0) fail('E_GIT', `git ${args[0] ?? ''} failed (see evidence/git.log).`, 'Remove see-through and run prepare again.');
    };
    await git(['init', '--quiet', lay.seeThrough]);
    await git(['-C', lay.seeThrough, 'fetch', '--quiet', '--depth', '1', seeThrough.repository, seeThrough.commit]);
    await git(['-C', lay.seeThrough, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', seeThrough.commit]);
    const head = readSmall(join(lay.seeThrough, '.git', 'HEAD'), 128, '.git/HEAD')
      .toString('utf8')
      .trim();
    if (head !== seeThrough.commit) fail('E_GIT', 'The See-through checkout is not at the pinned commit.');
    await checkSource(lay, manifest);
  }
  summary.seeThrough = { commit: seeThrough.commit, files: manifest.seeThrough.files.length };

  // 2. Wheels.
  let downloadedWheels = 0;
  for (const wheel of manifest.python.wheels) {
    const target = inside(lay.wheelhouse, wheel.file);
    if ((await checkExisting(target, wheel.size, wheelCheck(wheel), wheel.file)) === 'verified') continue;
    log.progress(`Downloading ${wheel.file} ...`);
    await download(deps.fetcher, 'wheels', wheel.url, target, wheel.size, wheelCheck(wheel), log);
    downloadedWheels += 1;
  }
  summary.wheels = { total: manifest.python.wheels.length, downloaded: downloadedWheels };

  // 3. Model files into the Hugging Face cache layout: refs/main and real files in snapshots/<revision>/ (no links).
  let downloadedModels = 0;
  for (const repository of modelRepositories) {
    const folder = `hf/hub/${repositoryFolder(repository.repository)}`;
    realDirectoryBelow(lay.work, `${folder}/refs`);
    realDirectoryBelow(lay.work, `${folder}/snapshots/${repository.revision}`);
    const reference = join(lay.work, ...folder.split('/'), 'refs', 'main');
    if (kind(reference) === 'missing') writeAtomic(reference, repository.revision, 0o644);
    else if (readSmall(reference, 64, 'refs/main').toString('utf8') !== repository.revision) fail('E_MODEL_REF', `refs/main of ${repository.repository} is not the pinned revision.`);
  }
  for (const file of manifest.models.files) {
    const repository = modelRepositories.find((item) => item.key === file.repo);
    if (!repository) continue;
    const target = modelPath(lay, file);
    const parent = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    if (parent !== '') realDirectoryBelow(lay.work, `hf/hub/${repositoryFolder(repository.repository)}/snapshots/${repository.revision}/${parent}`);
    if ((await checkExisting(target, file.size, modelCheck(file), `${file.repo}/${file.path}`)) === 'verified') continue;
    log.progress(`Downloading ${file.repo}/${file.path} (${file.size} bytes) ...`);
    const url = `https://huggingface.co/${repository.repository}/resolve/${repository.revision}/${file.path}`;
    await download(deps.fetcher, 'models', url, target, file.size, modelCheck(file), log);
    downloadedModels += 1;
  }
  summary.models = { total: manifest.models.files.length, downloaded: downloadedModels };

  // 4. The venv, as the run user: Python 3.12 without pip, then pip from the checked pip wheel, offline, hash-checked wheels only.
  //    Then root takes the venv, so that the run user cannot change it later.
  if (checkVenv(lay, manifest).state === 'missing') {
    const python = findPython(deps.env.PATH);
    if (python === null) fail('E_PYTHON_MISSING', 'python3.12 is not in PATH.', 'Use a Pod image with Python 3.12 (see README.md). This is BLOCKED until Python 3.12 is available.', 3);
    const pip = manifest.python.wheels.find((wheel) => wheel.name === 'pip');
    if (!pip) return fail('E_MANIFEST', 'No pip wheel.');
    const installLog = join(lay.evidence, 'install.log');
    log.progress('Making the venv as the run user ...');
    runUserDirectory(lay, 'venv', identity, host);
    chmodNoFollow(lay.venv, 0o755);
    const venv = await deps.spawner(python, ['-I', '-m', 'venv', '--without-pip', lay.venv], { cwd: lay.work, env, timeoutSeconds: 300, logPath: installLog, user: identity });
    const venvProblems = processProblems(venv, 'python3.12 -m venv');
    if (venvProblems.length > 0) fail('E_PROCESS', venvProblems.join(' '), 'Remove venv. Stop here and report it.');
    if (venv.code !== 0) fail('E_VENV', 'python3.12 -m venv failed (see evidence/install.log).', 'Remove venv and run prepare again.');
    log.progress('Installing the pinned wheels (offline, hash-checked) ...');
    const install = await deps.spawner(
      lay.python,
      [
        '-E',
        '-s',
        `${inside(lay.wheelhouse, pip.file)}/pip`,
        'install',
        '--isolated',
        '--no-index',
        '--find-links',
        lay.wheelhouse,
        '--require-hashes',
        '--only-binary',
        ':all:',
        '--no-deps',
        '--no-cache-dir',
        '--disable-pip-version-check',
        '--no-input',
        '--requirement',
        join(bundle.root, 'requirements.lock')
      ],
      { cwd: lay.work, env: { ...env, PIP_CONFIG_FILE: '/dev/null', PIP_NO_INPUT: '1' }, timeoutSeconds: limits.commandTimeoutSeconds, logPath: installLog, user: identity }
    );
    const installProblems = processProblems(install, 'pip install');
    if (installProblems.length > 0) fail('E_PROCESS', installProblems.join(' '), 'Remove venv. Stop here and report it.');
    if (install.code !== 0) fail('E_INSTALL', 'pip install failed (see evidence/install.log).', 'Remove venv and run prepare again. Do not install other versions.');
    sealTree(lay.venv, host);
  }
  summary.venv = checkVenv(lay, manifest);
  for (const [path, label] of [
    [lay.seeThrough, 'see-through'],
    [lay.wheelhouse, 'wheelhouse'],
    [lay.hfHome, 'hf']
  ] as const)
    checkSealedTree(path, host, label);
  checkSealedTree(lay.venv, host, 'venv', true);
  summary.identity = { runUser: identity.name, uid: identity.uid };
  log.event('prepare', summary);
  return summary;
}

// ---------------------------------------------------------------- GPU check

export type GpuReport = { readonly status: 'PASS' | 'BLOCKED'; readonly name: string; readonly memoryMiB: number; readonly driver: string; readonly message: string };

export function parseGpu(stdout: string): GpuReport {
  const line = stdout.split(/\r?\n/).find((item) => item.trim() !== '');
  const parts = (line ?? '').split(',').map((item) => item.trim());
  const [name = '', memoryText = '', driver = ''] = parts;
  const memoryMiB = Number(memoryText);
  const major = Number(driver.split('.')[0]);
  if (parts.length !== 3 || !Number.isFinite(memoryMiB) || !Number.isFinite(major))
    return { status: 'BLOCKED', name: show(name), memoryMiB: 0, driver: show(driver), message: 'nvidia-smi gave no GPU data.' };
  if (memoryMiB < limits.gpuMemoryMiB)
    return { status: 'BLOCKED', name: show(name), memoryMiB, driver, message: `The GPU has ${memoryMiB} MiB. ${limits.gpuMemoryMiB} MiB or more is necessary. Offload modes are not allowed.` };
  if (major < limits.driverMajor)
    return {
      status: 'BLOCKED',
      name: show(name),
      memoryMiB,
      driver,
      message: `The driver ${driver} is older than ${limits.driverMajor}. PyTorch 2.8.0 with CUDA 12.8 needs ${limits.driverMajor} or later.`
    };
  return { status: 'PASS', name: show(name), memoryMiB, driver, message: 'OK' };
}

export async function gpuCheck(lay: Layout, log: Logger, capture: Capture, env: NodeJS.ProcessEnv): Promise<GpuReport> {
  let result;
  try {
    result = await capture('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], baseEnvironment(lay, env.PATH));
  } catch {
    return { status: 'BLOCKED', name: '', memoryMiB: 0, driver: '', message: 'nvidia-smi cannot be started. The host has no usable NVIDIA GPU.' };
  }
  const report = result.code === 0 ? parseGpu(result.stdout) : { status: 'BLOCKED' as const, name: '', memoryMiB: 0, driver: '', message: 'nvidia-smi failed.' };
  log.event('gpu', report);
  return report;
}

// ---------------------------------------------------------------- run

export type GuardRecord = { readonly kind: string; readonly event: string; readonly detail: unknown };

export function parseGuardLog(text: string): GuardRecord[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line): GuardRecord => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return fail('E_GUARD_LOG', 'The guard log has a line that is not JSON.');
      }
      if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.event !== 'string') return fail('E_GUARD_LOG', 'The guard log has a record that is not valid.');
      return { kind: value.kind, event: value.event, detail: value.detail };
    });
}

export type GuardSummary = {
  readonly started: boolean;
  readonly ended: boolean;
  readonly denied: readonly GuardRecord[];
  readonly reads: readonly string[];
  readonly unexpectedReads: readonly string[];
  readonly missingReads: readonly string[];
};

/** Checks the guard records: no denial, start and end present, every read below the cache is a pinned file, the required reads happened. */
export function checkGuard(records: readonly GuardRecord[], lay: Layout, manifest: Manifest): GuardSummary {
  const allowed = new Map(manifest.models.files.map((file) => [modelPath(lay, file), `${file.repo}/${file.path}`]));
  const reads = [...new Set(records.filter((record) => record.kind === 'read' && typeof record.detail === 'string').map((record) => record.detail as string))].sort();
  const known = reads.filter((path) => allowed.has(path)).map((path) => allowed.get(path) as string);
  const unexpectedReads = reads.filter((path) => !allowed.has(path) && !path.endsWith(`${sep}refs${sep}main`));
  const missingReads = requiredReads.map((item) => `${item.key}/${item.path}`).filter((item) => !known.includes(item));
  return {
    started: records.some((record) => record.kind === 'start'),
    ended: records.some((record) => record.kind === 'end'),
    denied: records.filter((record) => record.kind === 'deny'),
    reads: known,
    unexpectedReads,
    missingReads
  };
}

export type OutputFile = { readonly path: string; readonly bytes: number; readonly sha256: string };

/**
 * The SHA-256 of every model file for the evidence. Weight files have a pinned SHA-256 that preflight checked.
 * Configuration and tokenizer files are small: their SHA-256 is computed here (they were checked by Git blob id).
 */
export function modelFileHashes(lay: Layout, manifest: Manifest): { file: string; sha256: string; source: 'pinned' | 'computed' }[] {
  return manifest.models.files.map((file) => ({
    file: `${file.repo}/${file.path}`,
    sha256: file.sha256 ?? sha256(readSmall(modelPath(lay, file), 16 * 1024 * 1024, file.path)),
    source: file.sha256 === null ? 'computed' : 'pinned'
  }));
}

export async function collectOutputs(lay: Layout): Promise<OutputFile[]> {
  const files = walk(lay.output);
  if (files.length > limits.outputFiles) fail('E_OUTPUT_LIMIT', `The output has ${files.length} files. The limit is ${limits.outputFiles}.`);
  const result: OutputFile[] = [];
  let total = 0;
  for (const path of files) {
    if (!outputExtensions.some((extension) => path.toLowerCase().endsWith(extension)))
      fail('E_OUTPUT_TYPE', `The output has a file that is not PSD, PNG, or JSON: ${show(path)}.`, 'Do not copy it. Report it.');
    const full = outputPath(lay.output, path);
    const bytes = lstatSync(full).size;
    total += bytes;
    if (total > limits.outputBytes) fail('E_OUTPUT_LIMIT', `The output is larger than ${limits.outputBytes} bytes.`);
    result.push({ path, bytes, sha256: await fileSha256(full) });
  }
  for (const expected of [`${input.stem}.psd`, `${input.stem}_depth.psd`, `${input.stem}.psd.json`])
    if (!result.some((file) => file.path === expected)) fail('E_OUTPUT_MISSING', `The output has no ${expected}.`);
  return result;
}

/** expectedInputSha256 exists for tests with synthetic images only. The command line never sets it. */
export type RunDependencies = {
  readonly spawner: Spawner;
  readonly capture: Capture;
  readonly env: NodeJS.ProcessEnv;
  readonly expectedInputSha256?: string;
  readonly host?: Host;
  readonly acceptGuardOnlyNetwork?: boolean;
  /** How long to wait until nvidia-smi shows no compute process after the stage. Tests use a short time. */
  readonly gpuReleaseMs?: number;
};

/** Copies a guard log of the run user into evidence/ (root only). A missing log gives no records. */
function takeGuardLog(from: string, to: string): GuardRecord[] {
  if (kind(from) !== 'file') return [];
  const bytes = readSmall(from, 64 * 1024 * 1024, 'the guard log');
  writeAtomic(to, bytes);
  return parseGuardLog(bytes.toString('utf8'));
}

/** Writes a guard configuration into control/ (root, read-only for the run user). */
function writeGuardConfig(lay: Layout, name: string, config: Record<string, unknown>): string {
  realDirectoryBelow(lay.work, 'control');
  const path = join(lay.control, name);
  if (kind(path) !== 'missing') rmSync(path);
  writeAtomic(path, `${JSON.stringify({ format: guardFormat, ...config }, null, 2)}\n`, 0o644);
  return path;
}

/** preflight for qualify: everything must be PASS, except that the input image can be missing. */
function requireReadyWithoutInput(report: PreflightReport): void {
  const open = report.checks.filter((check) => check.status !== 'PASS' && !(check.id === 'input' && check.status === 'MISSING'));
  if (open.length > 0)
    fail(
      'E_PREFLIGHT',
      `preflight is not ready: ${open.map((check) => check.id).join(', ')}.`,
      'Run preflight and fix each item that is not PASS.',
      open.some((check) => check.status === 'FAIL') ? 1 : 3
    );
}

export type QualifyOutput = {
  readonly status: string;
  readonly python: unknown;
  readonly problems: readonly unknown[];
  readonly modules: unknown;
  readonly distributions: Record<string, unknown>;
  readonly torch: Record<string, unknown> | null;
};

/** Checks the report of qualify.py again in the runner: exact distribution versions, all modules, and the CUDA runtime. */
export function checkQualifyOutput(value: unknown, manifest: Manifest): string[] {
  if (!isRecord(value) || value.format !== qualifyFormat) return ['E_QUALIFY_OUTPUT: the qualify report is missing or not valid.'];
  const out = value as unknown as QualifyOutput;
  const problems: string[] = [];
  if (out.status !== 'PASS') problems.push(`E_QUALIFY: qualify.py gave ${show(out.status)}: ${show(out.problems)}.`);
  const distributions = isRecord(out.distributions) ? out.distributions : {};
  const expected = new Map(manifest.python.wheels.map((wheel) => [normalizeName(wheel.name), wheel.version]));
  for (const [name, version] of expected) if (distributions[name] !== version) problems.push(`E_QUALIFY_VERSION: ${name} is ${show(distributions[name])}, not ${version}.`);
  for (const name of Object.keys(distributions)) if (!expected.has(name)) problems.push(`E_QUALIFY_EXTRA: ${show(name)} is installed but not pinned.`);
  const torch = isRecord(out.torch) ? out.torch : {};
  if (torch.cuda !== cudaVersion) problems.push(`E_QUALIFY_CUDA: PyTorch CUDA is ${show(torch.cuda)}, not ${cudaVersion}.`);
  if (torch.cudaAvailable !== true || torch.operation !== 'PASS') problems.push('E_QUALIFY_CUDA: the CUDA runtime did not run a small operation.');
  return problems;
}

/**
 * qualify: an owner-approved gate between prepare and run. As the run user, in the network mode, with the guard, it imports every
 * direct requirement, compares the installed distributions with the pins, and runs one small CUDA operation. It loads no model file.
 */
export async function qualify(bundle: LoadedBundle, lay: Layout, log: Logger, deps: RunDependencies): Promise<Record<string, unknown>> {
  const { manifest } = bundle;
  const host = deps.host ?? realHost;
  requireRoot(host);
  const identity = identityFor(host);
  realDirectoryBelow(lay.work, 'evidence', 0o700);
  requireReadyWithoutInput(await preflight(bundle, lay, null, log, deps.env, deps.expectedInputSha256 ?? input.sha256, host));
  const gpu = await gpuCheck(lay, log, deps.capture, deps.env);
  if (gpu.status !== 'PASS') return fail('E_GPU_BLOCKED', gpu.message, 'BLOCKED: use a GPU that meets the limits in README.md.', 3);
  const network = networkMode(await isolationCheck(lay, identity, deps.capture, deps.env, log), deps.acceptGuardOnlyNetwork === true);
  prepareRunDirectories(lay, identity, host);
  const out = join(lay.logs, 'qualify-out.json');
  const guardLog = join(lay.logs, 'qualify-guard.jsonl');
  for (const path of [out, guardLog]) rmSync(path, { force: true });
  const expect = {
    modules: qualifyModules,
    packages: Object.fromEntries(manifest.python.wheels.map((wheel) => [normalizeName(wheel.name), wheel.version])),
    cuda: cudaVersion,
    requireCuda: true
  };
  realDirectoryBelow(lay.work, 'control');
  const expectPath = join(lay.control, 'qualify-expect.json');
  rmSync(expectPath, { force: true });
  writeAtomic(expectPath, `${JSON.stringify(expect, null, 2)}\n`, 0o644);
  const configPath = writeGuardConfig(lay, 'guard-qualify.json', {
    kind: 'qualify',
    seeThroughRoot: lay.seeThrough,
    script: join(bundle.root, 'qualify.py'),
    argv: ['--expect', expectPath, '--out', out],
    writeRoots: [lay.runDirectory],
    hfCache: lay.hfCache,
    log: guardLog
  });
  const [command, args] = isolatedCommand(network, lay.python, ['-I', '-B', join(bundle.root, 'guard.py'), configPath]);
  log.progress('Qualifying the Python environment (imports and one small CUDA operation, no model) ...');
  const processResult = await deps.spawner(command, args, {
    cwd: lay.seeThrough,
    env: seeThroughEnvironment(lay, deps.env.PATH),
    timeoutSeconds: limits.qualifyTimeoutSeconds,
    logPath: join(lay.evidence, 'qualify.log'),
    user: identity
  });
  const records = takeGuardLog(guardLog, join(lay.evidence, 'qualify-guard.jsonl'));
  const problems: string[] = [];
  if (processResult.timedOut) problems.push(`E_TIMEOUT: qualify ran longer than ${limits.qualifyTimeoutSeconds} s.`);
  else if (processResult.code !== 0) problems.push(`E_QUALIFY_EXIT: qualify ended with code ${String(processResult.code)} (see evidence/qualify.log).`);
  problems.push(...processProblems(processResult, 'qualify'));
  const gpuAfter = await waitGpuFree(deps.capture, baseEnvironment(lay, deps.env.PATH), deps.gpuReleaseMs);
  if (gpuAfter !== null && gpuAfter.length > 0) problems.push(`E_GPU_PROCESS_REMAINS: nvidia-smi still shows compute processes: ${gpuAfter.map(show).join(', ')}.`);
  if (!records.some((record) => record.kind === 'start') || !records.some((record) => record.kind === 'end')) problems.push('E_GUARD: the guard log is not complete.');
  const denied = records.filter((record) => record.kind === 'deny');
  if (denied.length > 0) problems.push(`E_GUARD_DENIED: the guard stopped ${denied.length} actions (see evidence/qualify-guard.jsonl).`);
  let output: unknown = null;
  if (kind(out) === 'file') {
    try {
      output = JSON.parse(readSmall(out, 4 * 1024 * 1024, 'the qualify report').toString('utf8'));
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      output = null;
    }
  }
  problems.push(...checkQualifyOutput(output, manifest));
  const report = {
    format: qualifyFormat,
    status: problems.length === 0 ? 'PASS' : 'FAIL',
    problems,
    bundle: bundle.manifestSha256,
    identity: { runUser: identity.name, uid: identity.uid },
    network,
    gpu,
    exit: processResult,
    gpuAfter,
    gpuRelease: gpuReleaseState(gpuAfter),
    output
  };
  writeAtomic(join(lay.evidence, 'qualify.json'), `${JSON.stringify(report, null, 2)}\n`);
  log.event('qualify', { status: report.status, problems });
  return report;
}

/** run needs a PASS of qualify for the same bundle in this work directory. */
export function requireQualified(lay: Layout, bundle: LoadedBundle): string {
  const path = join(lay.evidence, 'qualify.json');
  if (kind(path) !== 'file') return fail('E_NOT_QUALIFIED', 'qualify has not passed in this work directory.', 'BLOCKED: run qualify first (an owner-approved step).', 3);
  const bytes = readSmall(path, 16 * 1024 * 1024, 'evidence/qualify.json');
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return fail('E_NOT_QUALIFIED', 'evidence/qualify.json is not valid JSON.', 'Run qualify again.', 3);
  }
  if (!isRecord(value) || value.status !== 'PASS') return fail('E_NOT_QUALIFIED', 'The last qualify did not pass.', 'BLOCKED: see evidence/qualify.json.', 3);
  if (value.bundle !== bundle.manifestSha256) return fail('E_NOT_QUALIFIED', 'qualify passed for another bundle.', 'Run qualify again with this bundle.', 3);
  return sha256(bytes);
}

/** run: one guarded See-through decomposition of the pinned input, as the run user. At most one run per work directory. */
export async function runOnce(bundle: LoadedBundle, lay: Layout, inputPath: string, log: Logger, deps: RunDependencies): Promise<Record<string, unknown>> {
  const { manifest } = bundle;
  const host = deps.host ?? realHost;
  requireRoot(host);
  const identity = identityFor(host);
  const resultPath = join(lay.evidence, 'result.json');
  if (kind(resultPath) !== 'missing')
    fail(
      'E_ALREADY_RUN',
      'This work directory has a result. The runner never runs See-through twice in one work directory.',
      'Use status. A new run is an owner decision: use a new work directory.',
      3
    );
  if (kind(lay.output) !== 'missing')
    fail('E_OUTPUT_EXISTS', 'The output directory exists. A previous run possibly stopped.', 'Keep it as evidence. A new run is an owner decision: use a new work directory.', 3);
  const qualifySha256 = requireQualified(lay, bundle);
  const expectedInput = deps.expectedInputSha256 ?? input.sha256;
  const report = await preflight(bundle, lay, inputPath, log, deps.env, expectedInput, host);
  if (report.status !== 'READY') return fail('E_PREFLIGHT', `preflight is ${report.status}.`, 'Run preflight and fix each item that is not PASS.', report.status === 'FAIL' ? 1 : 3);
  const gpu = await gpuCheck(lay, log, deps.capture, deps.env);
  if (gpu.status !== 'PASS') return fail('E_GPU_BLOCKED', gpu.message, 'BLOCKED: use a GPU that meets the limits in README.md.', 3);
  const network = networkMode(await isolationCheck(lay, identity, deps.capture, deps.env, log), deps.acceptGuardOnlyNetwork === true);

  realDirectoryBelow(lay.work, 'input');
  realDirectoryBelow(lay.work, 'evidence', 0o700);
  prepareRunDirectories(lay, identity, host);
  if (inputPath !== lay.inputPath) {
    if (kind(lay.inputPath) !== 'missing') fail('E_INPUT', 'work/input already has an image.', 'Remove it or run without --input.', 2);
    writeAtomic(lay.inputPath, readSmall(inputPath, input.maxBytes, 'The input image'), 0o644);
  }
  checkInputFile(lay.inputPath, expectedInput);
  runUserDirectory(lay, 'output', identity, host);

  const guardLog = join(lay.logs, 'guard.jsonl');
  if (kind(guardLog) !== 'missing' || kind(join(lay.evidence, 'guard.jsonl')) !== 'missing') fail('E_ALREADY_RUN', 'A guard log of a run exists.', 'Use a new work directory.', 3);
  const argv = seeThroughArguments(lay.inputPath, lay.output);
  for (const forbidden of forbiddenArguments) if (argv.includes(forbidden)) fail('E_INTERNAL', `The argument ${forbidden} is forbidden.`);
  const configPath = writeGuardConfig(lay, 'guard-run.json', {
    kind: 'see-through',
    seeThroughRoot: lay.seeThrough,
    script: inside(lay.seeThrough, seeThrough.script),
    argv,
    writeRoots: [lay.output, lay.runDirectory],
    hfCache: lay.hfCache,
    log: guardLog
  });
  const started = new Date();
  log.event('run.start', { argv, seed, network: network.mode, runUser: identity.name });
  log.progress(`Running See-through as ${identity.name} (${network.mode}, guarded, offline). This can take some minutes ...`);
  const [command, args] = isolatedCommand(network, lay.python, ['-I', '-B', join(bundle.root, 'guard.py'), configPath]);
  const processResult = await deps.spawner(command, args, {
    cwd: lay.seeThrough,
    env: seeThroughEnvironment(lay, deps.env.PATH),
    timeoutSeconds: limits.runTimeoutSeconds,
    logPath: join(lay.evidence, 'see-through.log'),
    user: identity
  });
  const seconds = (Date.now() - started.getTime()) / 1000;
  log.event('run.end', { ...processResult, seconds });

  const guard = checkGuard(takeGuardLog(guardLog, join(lay.evidence, 'guard.jsonl')), lay, manifest);
  const problems: string[] = [];
  if (processResult.timedOut) problems.push(`E_TIMEOUT: See-through ran longer than ${limits.runTimeoutSeconds} s and was stopped.`);
  else if (processResult.code !== 0) problems.push(`E_SEETHROUGH_EXIT: See-through ended with code ${String(processResult.code)} (see evidence/see-through.log).`);
  problems.push(...processProblems(processResult, 'See-through'));
  const gpuAfter = await waitGpuFree(deps.capture, baseEnvironment(lay, deps.env.PATH), deps.gpuReleaseMs);
  if (gpuAfter !== null && gpuAfter.length > 0) problems.push(`E_GPU_PROCESS_REMAINS: nvidia-smi still shows compute processes: ${gpuAfter.map(show).join(', ')}.`);
  if (!guard.started || !guard.ended) problems.push('E_GUARD: the guard log is not complete.');
  if (guard.denied.length > 0) problems.push(`E_GUARD_DENIED: the guard stopped ${guard.denied.length} actions (see evidence/guard.jsonl).`);
  if (guard.unexpectedReads.length > 0) problems.push('E_UNEXPECTED_READ: files below the model cache that are not pinned were read.');
  if (guard.missingReads.length > 0) problems.push(`E_FALLBACK_SUSPECTED: these pinned files were not read: ${guard.missingReads.join(', ')}.`);
  // The run user must not change the outputs after the run: root takes them before the check.
  sealTree(lay.output, host);
  let outputs: OutputFile[] = [];
  try {
    outputs = await collectOutputs(lay);
  } catch (error) {
    if (!(error instanceof RunnerError)) throw error;
    problems.push(`${error.code}: ${error.message}`);
  }
  const result = {
    format: resultFormat,
    status: problems.length === 0 ? 'PASS' : 'FAIL',
    problems,
    seeThrough: { repository: seeThrough.repository, commit: seeThrough.commit, script: seeThrough.script },
    models: modelRepositories,
    input: { name: input.name, sha256: input.sha256 },
    argv: argv.map((item) => item.replace(lay.work, '<work>')),
    seed,
    identity: { runUser: identity.name, uid: identity.uid },
    network,
    qualify: { sha256: qualifySha256 },
    bundle: bundle.manifestSha256,
    python: checkVenv(lay, manifest).python,
    packages: Object.fromEntries([...installedPackages(lay)].sort(([a], [b]) => (a < b ? -1 : 1))),
    gpu,
    node: process.versions.node,
    started: started.toISOString(),
    seconds,
    exit: processResult,
    gpuAfter,
    gpuRelease: gpuReleaseState(gpuAfter),
    guard: { denied: guard.denied.length, reads: guard.reads, unexpectedReads: guard.unexpectedReads, missingReads: guard.missingReads },
    modelFiles: modelFileHashes(lay, manifest),
    outputs
  };
  writeAtomic(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  await writeEvidenceSums(lay);
  return result;
}

/** Writes evidence/SHA256SUMS and reads it back. */
export async function writeEvidenceSums(lay: Layout): Promise<string> {
  const sums = await evidenceSums(lay);
  writeAtomic(join(lay.evidence, 'SHA256SUMS'), sums);
  if (readFileSync(join(lay.evidence, 'SHA256SUMS'), 'utf8') !== sums) fail('E_WRITE', 'SHA256SUMS was not written correctly.');
  return sums;
}

/**
 * collect: after any stop (PASS, FAIL, or BLOCKED), checks that evidence/ and output/ hold only regular files (output: PSD, PNG, JSON
 * only, within the limits) and writes evidence/SHA256SUMS. The owner then archives exactly these two directories.
 */
export async function collect(lay: Layout, host: Host): Promise<Record<string, unknown>> {
  realDirectoryBelow(lay.work, 'evidence', 0o700);
  // A runner that was killed itself (for example kill -9) cannot stop its child. collect stops what is left, as root.
  let processes: { killed: number; survivors: number[] } | null = null;
  if (host.isRoot) {
    let identity: RunIdentity | null;
    try {
      identity = identityFor(host);
    } catch {
      identity = null;
    }
    if (identity !== null) processes = await host.reapUser(identity.uid);
    if (processes !== null && processes.survivors.length > 0) fail('E_PROCESS_SURVIVED', `Processes of the run user survived SIGKILL: ${processes.survivors.join(', ')}.`, 'Terminate the Pod.');
  }
  if (kind(lay.output) === 'directory') sealTree(lay.output, host);
  const evidence = walk(lay.evidence).filter((path) => path !== 'SHA256SUMS');
  let outputs = 0;
  if (kind(lay.output) === 'directory') {
    const files = walk(lay.output);
    if (files.length > limits.outputFiles) fail('E_OUTPUT_LIMIT', `The output has ${files.length} files.`);
    let total = 0;
    for (const path of files) {
      if (!outputExtensions.some((extension) => path.toLowerCase().endsWith(extension)))
        fail('E_OUTPUT_TYPE', `The output has a file that is not PSD, PNG, or JSON: ${show(path)}.`, 'Do not copy it. Report it.');
      total += lstatSync(outputPath(lay.output, path)).size;
    }
    if (total > limits.outputBytes) fail('E_OUTPUT_LIMIT', `The output is larger than ${limits.outputBytes} bytes.`);
    outputs = files.length;
  }
  for (const path of evidence) if (lstatSync(inside(lay.evidence, path)).size > limits.evidenceFileBytes) fail('E_EVIDENCE_LIMIT', `evidence/${show(path)} is too large.`);
  await writeEvidenceSums(lay);
  return { status: 'COLLECTED', evidence: evidence.length, outputs, runUserProcessesKilled: processes?.killed ?? null, archive: 'tar -czf l0-1-results.tar.gz -C <work> evidence output' };
}

/** SHA256SUMS over evidence/ and output/, with paths relative to the work directory. */
export async function evidenceSums(lay: Layout): Promise<string> {
  const lines: string[] = [];
  for (const [base, prefix] of [
    [lay.evidence, 'evidence'],
    [lay.output, 'output']
  ] as const) {
    if (kind(base) !== 'directory') continue;
    for (const path of walk(base))
      if (!(prefix === 'evidence' && path === 'SHA256SUMS')) lines.push(`${await fileSha256(prefix === 'output' ? outputPath(base, path) : inside(base, path))}  ${prefix}/${path}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- command line

const help = `Usage: sh run.sh <command> --work <dir> [--input <concept-mirrored.png>] [--accept-guard-only-network]

Commands (the owner runs them in this order and can stop after each one):
  preflight   Check the bundle, permissions, the run user, and every file that exists. Reads files only: no network, no process,
              no See-through code. Result READY, INCOMPLETE (files missing), or FAIL.
  prepare     As root: get See-through at the pinned commit, the pinned wheels and model files (about 18 GB, pinned URLs only).
              As the run user: make the venv and install the checked wheels offline. Then root takes the venv. No See-through.
  gpu         Check the GPU with nvidia-smi (memory and driver). Starts no Python.
  isolation   Check, as the run user, that a new network namespace with only loopback is available. Starts unshare and cat only.
  qualify     As the run user, isolated, guarded: import each direct requirement, compare the installed versions with the pins,
              and run one small CUDA operation. No model file is loaded. Needs a separate owner permission.
  run         preflight, gpu, isolation, a passed qualify, then one guarded See-through run of the pinned input as the run user.
              Needs a separate owner permission. Writes output/ and evidence/.
  collect     Check evidence/ and output/ (only regular files; output only PSD, PNG, JSON) and write evidence/SHA256SUMS.
  status      Print evidence/result.json, if it exists.

--accept-guard-only-network (qualify and run only): the owner accepts the weaker mode when isolation is not available.
Without it, qualify and run are BLOCKED on such a host. The choice is written to the evidence.

Exit status: 0 PASS or READY, 1 FAIL, 2 usage or input error, 3 INCOMPLETE or BLOCKED.
`;

export async function main(argv: readonly string[], deps: PrepareDependencies & RunDependencies): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: { work: { type: 'string' }, input: { type: 'string' }, 'accept-guard-only-network': { type: 'boolean' }, help: { type: 'boolean' } }
    });
  } catch (error) {
    process.stderr.write(`E_USAGE: ${show(error instanceof Error ? error.message : 'arguments')}\n${help}`);
    return 2;
  }
  const [command, ...rest] = parsed.positionals;
  if (parsed.values.help || command === undefined) {
    process.stdout.write(help);
    return command === undefined && !parsed.values.help ? 2 : 0;
  }
  try {
    if (rest.length > 0 || !['preflight', 'prepare', 'gpu', 'isolation', 'qualify', 'run', 'collect', 'status'].includes(command))
      fail('E_USAGE', 'Unknown command or extra arguments.', 'Run sh run.sh --help.', 2);
    if (parsed.values.work === undefined) fail('E_USAGE', '--work <dir> is required.', undefined, 2);
    if (parsed.values.input !== undefined && command !== 'preflight' && command !== 'run') fail('E_USAGE', `--input is not valid for ${command}.`, undefined, 2);
    const acceptGuardOnlyNetwork = parsed.values['accept-guard-only-network'] === true;
    if (acceptGuardOnlyNetwork && command !== 'qualify' && command !== 'run') fail('E_USAGE', `--accept-guard-only-network is not valid for ${command}.`, undefined, 2);
    const host = deps.host ?? realHost;
    const lay = checkWork(parsed.values.work, host);
    if (command === 'status') {
      const path = join(lay.evidence, 'result.json');
      if (kind(path) === 'missing') {
        process.stdout.write(`${JSON.stringify({ status: 'NOT_RUN' })}\n`);
        return 3;
      }
      process.stdout.write(readSmall(path, 16 * 1024 * 1024, 'result.json').toString('utf8'));
      return 0;
    }
    const bundle = loadBundle(dirname(fileURLToPath(import.meta.url)));
    realDirectoryBelow(lay.work, 'evidence', 0o700);
    const log = fileLogger(join(lay.evidence, 'runner.log'));
    log.event('command', { command, bundle: bundleFormat });
    if (command === 'preflight') {
      const report = await preflight(bundle, lay, parsed.values.input === undefined ? null : resolve(parsed.values.input), log, deps.env);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.status === 'READY' ? 0 : report.status === 'FAIL' ? 1 : 3;
    }
    if (command === 'prepare') {
      process.stdout.write(`${JSON.stringify({ status: 'PREPARED', ...(await prepare(bundle, lay, log, deps)) }, null, 2)}\n`);
      return 0;
    }
    if (command === 'gpu') {
      const report = await gpuCheck(lay, log, deps.capture, deps.env);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.status === 'PASS' ? 0 : 3;
    }
    if (command === 'isolation') {
      requireRoot(host);
      const report = await isolationCheck(lay, identityFor(host), deps.capture, deps.env, log);
      writeAtomic(join(lay.evidence, 'isolation.json'), `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.status === 'ISOLATED' ? 0 : 3;
    }
    if (command === 'collect') {
      process.stdout.write(`${JSON.stringify(await collect(lay, host), null, 2)}\n`);
      return 0;
    }
    if (command === 'qualify') {
      const report = await qualify(bundle, lay, log, { ...deps, acceptGuardOnlyNetwork });
      process.stdout.write(`${JSON.stringify({ status: report.status, problems: report.problems }, null, 2)}\n`);
      return report.status === 'PASS' ? 0 : 1;
    }
    const inputPath = parsed.values.input === undefined ? lay.inputPath : resolve(parsed.values.input);
    const result = await runOnce(bundle, lay, inputPath, log, { ...deps, acceptGuardOnlyNetwork });
    process.stdout.write(`${JSON.stringify({ status: result.status, problems: result.problems, seconds: result.seconds }, null, 2)}\n`);
    return result.status === 'PASS' ? 0 : 1;
  } catch (error) {
    if (error instanceof RunnerError) {
      process.stderr.write(`${error.code}: ${error.message}${error.hint ? `\nHint: ${error.hint}` : ''}\n`);
      return error.exitCode;
    }
    process.stderr.write(`E_INTERNAL: ${show(error instanceof Error ? error.message : error)}\n`);
    return 1;
  }
}

const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  process.exitCode = await main(process.argv.slice(2), { fetcher: fetch, spawner: spawnProcess, capture: captureProcess, env: process.env });
}
