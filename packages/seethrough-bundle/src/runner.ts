// L0-1 See-through runner. It runs on the GPU host (a Runpod Pod that the owner starts) and only there.
//
// This module is self-contained: it imports only Node.js built-ins, so the build gives one file that the bundle copies as runner.mjs.
// Scope: one standalone See-through decomposition (inference/scripts/inference_psd.py) of one pinned input image.
//
// Trust boundaries and controls:
// - The bundle is data from the repository. run.sh checks SHA256SUMS. The runner checks manifest.json against the pins in this file
//   and checks each bundle file against manifest.json.
// - Downloads come only from pinned sources: the See-through Git commit, Hugging Face files at pinned revisions, and Python wheels
//   on files.pythonhosted.org. Each file has a pinned size and hash. A file gets its final name only after the check.
//   An existing file with another hash stops the runner. The runner never replaces it.
// - Python packages are installed only from the checked local wheels: no index, no source builds, no dependency resolution.
// - preflight reads files only. It starts no process, uses no network, and does not import or run See-through code.
// - The See-through process gets a fixed argument list, a minimal environment without secrets, offline Hugging Face settings,
//   and the guard (guard.py) with audit hooks against network calls, new processes, pickle, and writes outside the run directories.
// - The run is accepted only when the guard recorded no denial, the expected configuration files were read, and the outputs are
//   regular files inside the output directory.
// - The log and the reports contain no environment values and no tokens.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
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

export const bundleFormat = 'aigg.l0-seethrough-bundle/0.1';
export const resultFormat = 'aigg.l0-seethrough-result/0.1';
export const guardFormat = 'aigg.l0-seethrough-guard/0.1';
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
  outputFiles: 2000,
  outputBytes: 4 * 1024 ** 3,
  commandTimeoutSeconds: 1800
} as const;

const downloadHosts = [/^huggingface\.co$/, /^([a-z0-9-]+\.)*hf\.co$/, /^([a-z0-9-]+\.)*huggingface\.co$/, /^files\.pythonhosted\.org$/] as const;

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

/** Makes sure that each part of a directory path below root is a real directory. Creates missing parts with mode 0700. */
export function realDirectoryBelow(root: string, relative: string): string {
  let current = root;
  for (const part of relative.split('/')) {
    if (part === '' || part === '.' || part === '..') fail('E_PATH', `The directory ${show(relative)} is not a plain path.`, undefined, 2);
    current = join(current, part);
    const found = kind(current);
    if (found === 'missing') mkdirSync(current, { mode: 0o700 });
    else if (found !== 'directory') fail('E_PATH', `${current} exists and is not a real directory (links are refused).`, 'Remove it, then run the command again.');
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
export function writeAtomic(path: string, bytes: Uint8Array | string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
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

export function parseWheel(value: unknown): Wheel {
  if (!isRecord(value)) return fail('E_MANIFEST', 'A wheel entry is not an object.');
  const { name, version, file, url, size, sha256: hash } = value;
  if (typeof name !== 'string' || !packageName.test(name) || typeof version !== 'string' || !/^[A-Za-z0-9.+!_-]+$/.test(version))
    fail('E_MANIFEST', `The wheel ${show(name)} has no valid name or version.`);
  if (typeof file !== 'string' || !wheelName.test(file)) fail('E_MANIFEST_SOURCE_BUILD', `The package ${name} is not a wheel file. Source builds are not allowed.`);
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
  for (const required of ['guard.py', 'requirements.lock']) if (!bundleFiles.some((file) => file.path === required)) fail('E_MANIFEST', `manifest.json does not list ${required}.`);
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

export type LoadedBundle = { readonly root: string; readonly manifest: Manifest };

/** Reads manifest.json and checks each listed bundle file. */
export function loadBundle(root: string): LoadedBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readSmall(join(root, 'manifest.json'), 4 * 1024 * 1024, 'manifest.json').toString('utf8'));
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
  return { root, manifest };
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
  readonly runDirectory: string;
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
    runDirectory: join(work, 'run'),
    output: join(work, 'output'),
    evidence: join(work, 'evidence')
  };
}

/** The work directory must exist, be a real directory, and not be writable by other users. */
export function checkWork(path: string): Layout {
  const full = resolve(path);
  const found = kind(full);
  if (found === 'missing') fail('E_WORK', `The work directory ${full} does not exist.`, 'Create it first, for example mkdir -m 700 /workspace/l0-1.', 2);
  if (found !== 'directory') fail('E_WORK', `The work directory ${full} is not a real directory (links are refused).`, undefined, 2);
  if ((lstatSync(full).mode & 0o022) !== 0) fail('E_WORK', `The work directory ${full} is writable by group or others.`, 'Run chmod 700 on it.', 2);
  if (realpathSync(full) !== full) fail('E_WORK', `The path of the work directory ${full} contains a link.`, 'Give the real path.', 2);
  return layout(full);
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
  await run('python', () => (kind(lay.venv) === 'missing' && findPython(env.PATH) === null ? 'python3.12 is not in PATH. prepare needs it to make the venv.' : null));
  await run('disk', () => {
    const free = host.freeBytes(lay.work);
    return free < limits.runFreeBytes ? fail('E_DISK', `Only ${free} bytes are free in the work directory.`) : null;
  });
  await run('see-through', async () => ((await checkSource(lay, manifest)) === 'missing' ? 'The See-through checkout is missing.' : null));
  await run('wheels', async () => {
    let missing = 0;
    for (const wheel of manifest.python.wheels) if ((await checkExisting(inside(lay.wheelhouse, wheel.file), wheel.size, wheelCheck(wheel), wheel.file)) === 'missing') missing += 1;
    return missing === 0 ? null : `${missing} of ${manifest.python.wheels.length} wheels are missing.`;
  });
  await run('models', async () => {
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

/** Host facts that preflight checks. Tests give synthetic values. */
export type Host = { readonly platform: string; readonly arch: string; readonly freeBytes: (path: string) => number };
export const realHost: Host = { platform: process.platform, arch: process.arch, freeBytes };

// ---------------------------------------------------------------- subprocesses

export type ProcessResult = { readonly code: number | null; readonly signal: string | null; readonly timedOut: boolean };

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

export type Spawner = (command: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; timeoutSeconds: number; logPath: string }) => Promise<ProcessResult>;

/** Starts a process with an argument array (no shell). Output goes to a log file. A timeout kills the process. */
export const spawnProcess: Spawner = (command, args, options) =>
  new Promise((resolvePromise, reject) => {
    const fd = openSync(options.logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, shell: false, stdio: ['ignore', fd, fd] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutSeconds * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      closeSync(fd);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      closeSync(fd);
      resolvePromise({ code, signal, timedOut });
    });
  });

/** Runs a process and captures its standard output (small). Used for nvidia-smi only. */
export type Capture = (command: string, args: readonly string[], env: Record<string, string>) => Promise<{ code: number | null; stdout: string }>;

export const captureProcess: Capture = (command, args, env) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { env, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
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

// ---------------------------------------------------------------- downloads

export type FetchFunction = (url: string, init?: RequestInit) => Promise<Response>;

export function allowedHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.port === '' && downloadHosts.some((pattern) => pattern.test(parsed.hostname));
}

/** Downloads one file to a .part name, follows at most 5 redirects to allowed HTTPS hosts, and checks size and hash before the rename. */
export async function download(fetcher: FetchFunction, url: string, target: string, size: number, check: (path: string) => Promise<boolean>, log: Logger): Promise<void> {
  let current = url;
  let response: Response | null = null;
  for (let hop = 0; hop <= 5; hop += 1) {
    if (!allowedHost(current)) fail('E_DOWNLOAD_HOST', `The download host of ${show(new URL(current).hostname)} is not allowed.`);
    response = await fetcher(current, { redirect: 'manual', headers: { 'user-agent': 'aigg-l0-seethrough-runner' } });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (location === null) fail('E_DOWNLOAD', 'A redirect has no location.');
      current = new URL(location, current).toString();
      continue;
    }
    break;
  }
  if (response === null || response.status !== 200 || response.body === null) fail('E_DOWNLOAD', `The download of ${show(url.split('?')[0])} failed with HTTP ${response?.status ?? 'none'}.`);
  const part = `${target}.part`;
  rmSync(part, { force: true });
  const fd = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let written = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      written += chunk.length;
      if (written > size) fail('E_DOWNLOAD_SIZE', `The download of ${show(url.split('?')[0])} is larger than the pinned ${size} bytes.`);
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
    fail('E_DOWNLOAD_HASH', `The download of ${show(url.split('?')[0])} does not agree with the pinned size and hash.`, 'Nothing was kept. Run prepare again. If it repeats, stop and report it.');
  }
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

/** prepare: gets the pinned code, wheels and model files, and installs the venv from the local wheels. It never runs See-through. */
export async function prepare(bundle: LoadedBundle, lay: Layout, log: Logger, deps: PrepareDependencies): Promise<Record<string, unknown>> {
  const { manifest } = bundle;
  for (const directory of ['evidence', 'run/home', 'run/tmp', 'wheelhouse']) realDirectoryBelow(lay.work, directory);
  const needed = requiredPrepareBytes(lay, manifest);
  if ((deps.host ?? realHost).freeBytes(lay.work) < needed) fail('E_DISK', `${needed} bytes must be free in the work directory for prepare.`, 'BLOCKED: use a larger volume.', 3);
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
    await download(deps.fetcher, wheel.url, target, wheel.size, wheelCheck(wheel), log);
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
    if (kind(reference) === 'missing') writeAtomic(reference, repository.revision);
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
    await download(deps.fetcher, url, target, file.size, modelCheck(file), log);
    downloadedModels += 1;
  }
  summary.models = { total: manifest.models.files.length, downloaded: downloadedModels };

  // 4. The venv: Python 3.12 without pip, then pip from the checked pip wheel, offline, hash-checked wheels only.
  if (checkVenv(lay, manifest).state === 'missing') {
    const python = findPython(deps.env.PATH);
    if (python === null) fail('E_PYTHON_MISSING', 'python3.12 is not in PATH.', 'Use a Pod image with Python 3.12 (see README.md). This is BLOCKED until Python 3.12 is available.', 3);
    const pip = manifest.python.wheels.find((wheel) => wheel.name === 'pip');
    if (!pip) return fail('E_MANIFEST', 'No pip wheel.');
    const installLog = join(lay.evidence, 'install.log');
    log.progress('Making the venv ...');
    const venv = await deps.spawner(python, ['-I', '-m', 'venv', '--without-pip', lay.venv], { cwd: lay.work, env, timeoutSeconds: 300, logPath: installLog });
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
      { cwd: lay.work, env: { ...env, PIP_CONFIG_FILE: '/dev/null', PIP_NO_INPUT: '1' }, timeoutSeconds: limits.commandTimeoutSeconds, logPath: installLog }
    );
    if (install.code !== 0) fail('E_INSTALL', 'pip install failed (see evidence/install.log).', 'Remove venv and run prepare again. Do not install other versions.');
  }
  summary.venv = checkVenv(lay, manifest);
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
    const full = inside(lay.output, path);
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
};

/** run: one guarded See-through decomposition of the pinned input. At most one run per work directory. */
export async function runOnce(bundle: LoadedBundle, lay: Layout, inputPath: string, log: Logger, deps: RunDependencies): Promise<Record<string, unknown>> {
  const { manifest } = bundle;
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
  const expectedInput = deps.expectedInputSha256 ?? input.sha256;
  const report = await preflight(bundle, lay, inputPath, log, deps.env, expectedInput, deps.host ?? realHost);
  if (report.status !== 'READY') return fail('E_PREFLIGHT', `preflight is ${report.status}.`, 'Run preflight and fix each item that is not PASS.', report.status === 'FAIL' ? 1 : 3);
  const gpu = await gpuCheck(lay, log, deps.capture, deps.env);
  if (gpu.status !== 'PASS') return fail('E_GPU_BLOCKED', gpu.message, 'BLOCKED: use a GPU that meets the limits in README.md.', 3);

  for (const directory of ['input', 'run/home', 'run/tmp', 'run/mpl', 'run/cache', 'run/torch', 'evidence']) realDirectoryBelow(lay.work, directory);
  if (inputPath !== lay.inputPath) {
    if (kind(lay.inputPath) !== 'missing') fail('E_INPUT', 'work/input already has an image.', 'Remove it or run without --input.', 2);
    writeAtomic(lay.inputPath, readSmall(inputPath, input.maxBytes, 'The input image'));
  }
  checkInputFile(lay.inputPath, expectedInput);
  mkdirSync(lay.output, { mode: 0o700 });

  const guardLog = join(lay.evidence, 'guard.jsonl');
  const configPath = join(lay.runDirectory, 'guard-config.json');
  if (kind(guardLog) !== 'missing') fail('E_ALREADY_RUN', 'evidence/guard.jsonl exists.', 'Use a new work directory.', 3);
  const argv = seeThroughArguments(lay.inputPath, lay.output);
  for (const forbidden of forbiddenArguments) if (argv.includes(forbidden)) fail('E_INTERNAL', `The argument ${forbidden} is forbidden.`);
  writeAtomic(
    configPath,
    `${JSON.stringify(
      {
        format: guardFormat,
        seeThroughRoot: lay.seeThrough,
        script: inside(lay.seeThrough, seeThrough.script),
        argv,
        writeRoots: [lay.output, lay.runDirectory],
        hfCache: lay.hfCache,
        log: guardLog
      },
      null,
      2
    )}\n`
  );
  const started = new Date();
  log.event('run.start', { argv, seed });
  log.progress('Running See-through (guarded, offline). This can take some minutes ...');
  const processResult = await deps.spawner(lay.python, ['-I', '-B', join(bundle.root, 'guard.py'), configPath], {
    cwd: lay.seeThrough,
    env: seeThroughEnvironment(lay, deps.env.PATH),
    timeoutSeconds: limits.runTimeoutSeconds,
    logPath: join(lay.evidence, 'see-through.log')
  });
  const seconds = (Date.now() - started.getTime()) / 1000;
  log.event('run.end', { ...processResult, seconds });

  const guard = checkGuard(kind(guardLog) === 'file' ? parseGuardLog(readSmall(guardLog, 64 * 1024 * 1024, 'guard.jsonl').toString('utf8')) : [], lay, manifest);
  const problems: string[] = [];
  if (processResult.timedOut) problems.push(`E_TIMEOUT: See-through ran longer than ${limits.runTimeoutSeconds} s and was stopped.`);
  else if (processResult.code !== 0) problems.push(`E_SEETHROUGH_EXIT: See-through ended with code ${String(processResult.code)} (see evidence/see-through.log).`);
  if (!guard.started || !guard.ended) problems.push('E_GUARD: the guard log is not complete.');
  if (guard.denied.length > 0) problems.push(`E_GUARD_DENIED: the guard stopped ${guard.denied.length} actions (see evidence/guard.jsonl).`);
  if (guard.unexpectedReads.length > 0) problems.push('E_UNEXPECTED_READ: files below the model cache that are not pinned were read.');
  if (guard.missingReads.length > 0) problems.push(`E_FALLBACK_SUSPECTED: these pinned files were not read: ${guard.missingReads.join(', ')}.`);
  let outputs: OutputFile[] = [];
  if (problems.length === 0) {
    try {
      outputs = await collectOutputs(lay);
    } catch (error) {
      if (!(error instanceof RunnerError)) throw error;
      problems.push(`${error.code}: ${error.message}`);
    }
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
    python: checkVenv(lay, manifest).python,
    packages: Object.fromEntries([...installedPackages(lay)].sort(([a], [b]) => (a < b ? -1 : 1))),
    gpu,
    node: process.versions.node,
    started: started.toISOString(),
    seconds,
    exit: processResult,
    guard: { denied: guard.denied.length, reads: guard.reads, unexpectedReads: guard.unexpectedReads, missingReads: guard.missingReads },
    modelFiles: modelFileHashes(lay, manifest),
    outputs
  };
  writeAtomic(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  const sums = await evidenceSums(lay);
  writeAtomic(join(lay.evidence, 'SHA256SUMS'), sums);
  if (readFileSync(join(lay.evidence, 'SHA256SUMS'), 'utf8') !== sums) fail('E_WRITE', 'SHA256SUMS was not written correctly.');
  return result;
}

/** SHA256SUMS over evidence/ and output/, with paths relative to the work directory. */
export async function evidenceSums(lay: Layout): Promise<string> {
  const lines: string[] = [];
  for (const [base, prefix] of [
    [lay.evidence, 'evidence'],
    [lay.output, 'output']
  ] as const) {
    if (kind(base) !== 'directory') continue;
    for (const path of walk(base)) if (!(prefix === 'evidence' && path === 'SHA256SUMS')) lines.push(`${await fileSha256(inside(base, path))}  ${prefix}/${path}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- command line

const help = `Usage: sh run.sh <command> --work <dir> [--input <concept-mirrored.png>]

Commands:
  preflight   Check the bundle, the work directory, and every file that exists. Reads files only: no network, no process,
              no See-through code. Result READY, INCOMPLETE (files missing), or FAIL.
  prepare     Get See-through at the pinned commit, the pinned wheels and model files, and install the venv offline from
              the checked wheels. Downloads about 18 GB. Does not run See-through.
  gpu         Check the GPU with nvidia-smi (memory and driver). Starts no Python.
  run         preflight, gpu, then one guarded See-through run of the pinned input. Writes output/ and evidence/.
  status      Print evidence/result.json, if it exists.

Exit status: 0 PASS or READY, 1 FAIL, 2 usage or input error, 3 INCOMPLETE or BLOCKED.
`;

export async function main(argv: readonly string[], deps: PrepareDependencies & RunDependencies): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: { work: { type: 'string' }, input: { type: 'string' }, help: { type: 'boolean' } } });
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
    if (rest.length > 0 || !['preflight', 'prepare', 'gpu', 'run', 'status'].includes(command)) fail('E_USAGE', 'Unknown command or extra arguments.', 'Run sh run.sh --help.', 2);
    if (parsed.values.work === undefined) fail('E_USAGE', '--work <dir> is required.', undefined, 2);
    if (parsed.values.input !== undefined && command !== 'preflight' && command !== 'run') fail('E_USAGE', `--input is not valid for ${command}.`, undefined, 2);
    const lay = checkWork(parsed.values.work);
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
    realDirectoryBelow(lay.work, 'evidence');
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
    const inputPath = parsed.values.input === undefined ? lay.inputPath : resolve(parsed.values.input);
    const result = await runOnce(bundle, lay, inputPath, log, deps);
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
