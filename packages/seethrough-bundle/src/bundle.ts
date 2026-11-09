import { createHash } from 'node:crypto';

import {
  type BundleFile,
  bundleFormat,
  fail,
  forbiddenArguments,
  input,
  limits,
  type Manifest,
  minimumNode,
  modelRepositories,
  parseManifest,
  parseModelFile,
  parseSourceFile,
  parseWheel,
  requirementsLock,
  runUser,
  seed,
  seeThrough
} from '@seethrough-bundle/runner';

// The L0-1 bundle: a flat directory that the owner copies to the GPU host. The build is deterministic: the same data files, guard,
// and runner give the same bytes. No date or host name is written. Building the bundle uses no network and runs no model.

/** Wheels must be older than this time. The lock was resolved with uv --exclude-newer at this time (two weeks before the lock). */
export const wheelCutoff = '2026-10-26T00:00:00Z';

export type PlannedFile = { readonly name: string; readonly bytes: Buffer };
export type BundleData = {
  readonly wheels: unknown;
  readonly modelFiles: unknown;
  readonly sourceFiles: unknown;
  readonly guard: Buffer;
  readonly qualify: Buffer;
  readonly runner: Buffer;
};

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const text = (value: string): Buffer => Buffer.from(value, 'utf8');
const json = (value: unknown): Buffer => text(`${JSON.stringify(value, null, 2)}\n`);

const runScript = `#!/bin/sh
# L0-1 See-through bundle: a thin wrapper only. It checks the bundle files and Node.js, then starts runner.mjs.
# All logic is in runner.mjs. Its TypeScript source is packages/seethrough-bundle/src/runner.ts in the repository.
# The runner starts with an empty environment except PATH: no NODE_OPTIONS, no TLS or proxy settings, no tokens.
set -eu
cd "$(dirname "$0")"
command -v sha256sum >/dev/null 2>&1 || { echo "E_TOOL: sha256sum is necessary." >&2; exit 2; }
sha256sum --check --quiet --strict SHA256SUMS || { echo "E_BUNDLE_INTEGRITY: a bundle file is missing or changed. Copy the bundle again." >&2; exit 2; }
NODE="$(command -v node)" || { echo "E_NODE_MISSING: Node.js ${minimumNode} or later is necessary. See README.md." >&2; exit 2; }
exec env -i PATH="$PATH" "$NODE" runner.mjs "$@"
`;

function checkWheelAges(wheels: readonly unknown[]): void {
  for (const item of wheels) {
    const uploaded = (item as { uploaded?: unknown }).uploaded;
    if (typeof uploaded !== 'string' || Number.isNaN(Date.parse(uploaded)) || Date.parse(uploaded) >= Date.parse(wheelCutoff))
      fail('E_DATA_WHEEL_AGE', `A wheel was uploaded at ${String(uploaded)}, not before ${wheelCutoff}.`);
  }
}

function readme(manifest: Manifest): string {
  const weights = manifest.models.files.filter((file) => file.sha256 !== null);
  const total = manifest.models.files.reduce((sum, file) => sum + file.size, 0);
  const wheelBytes = manifest.python.wheels.reduce((sum, wheel) => sum + wheel.size, 0);
  const gb = (bytes: number): string => (bytes / 1e9).toFixed(2);
  const rows = weights.map((file) => `| \`${file.repo}/${file.path}\` | ${file.size} | \`${file.sha256 ?? ''}\` |`).join('\n');
  const repos = modelRepositories.map((item) => `| \`${item.key}\` | \`${item.repository}\` | \`${item.revision}\` |`).join('\n');
  return `# L0-1 See-through bundle

**Draft, L0-1 only.** This bundle does one standalone See-through layer decomposition of one pinned image on a GPU host that the owner starts.
The owner gave a preliminary agreement for the two models below, for L0-1 only. The final permission to download and use them comes after the audit of this bundle.
Do not run any step on the GPU host before that permission.

The bundle needs no credentials, no API key, no Hugging Face token, and no public HTTP port. Do not put secrets on the Pod.
Do not copy the original Akane PSD, the original concept image, or other Akane files to the Pod. Only \`${input.name}\` goes there.

## What it uses

- See-through code: \`${seeThrough.repository}\` at commit \`${seeThrough.commit}\` (Apache-2.0). ${manifest.seeThrough.files.length} files in \`common/\` and \`inference/scripts/\` are checked by SHA-256 before each use.
- Model repositories (${gb(total)} GB, safetensors weights only, pinned revisions):

| Key | Repository | Revision |
| --- | --- | --- |
${repos}

| Weight file | Bytes | SHA-256 |
| --- | --- | --- |
${rows}

  Configuration and tokenizer files have no published SHA-256. The runner checks their Git blob id (SHA-1) at the pinned revision and records their SHA-256 in the evidence.
- Python 3.12 and ${manifest.python.wheels.length} pinned wheels (${gb(wheelBytes)} GB) from files.pythonhosted.org, each with its SHA-256. No source builds.
- Not used and not allowed: SAM, LaMa, \`--tblr_split\`, NF4, block swap, other models, and fallbacks.

## Host requirements

| Item | Requirement |
| --- | --- |
| GPU | One NVIDIA GPU with ${limits.gpuMemoryMiB} MiB or more (for example RTX A5000 24 GB). Offload modes are not allowed. |
| Driver | NVIDIA driver ${limits.driverMajor} or later (PyTorch 2.8.0 uses CUDA 12.8). Check with \`nvidia-smi\`. |
| System | Linux x86_64, glibc 2.28 or later, \`git\`, \`sha256sum\`, \`python3.12\` (only for \`prepare\`; Ubuntu 24.04 has it), Node.js ${minimumNode} or later. |
| Disk | About ${gb(total + wheelBytes)} GB of downloads plus about ${(limits.venvBytes / 1024 ** 3).toFixed(0)} GiB for the venv. Minimum: a volume of 40 GB. Suggested: 60 GB (headroom for the first full installation). |
| Run user | The unprivileged user \`${runUser}\` (no administrative groups). Third-party Python runs only as this user. The runner starts as root. |
| Network isolation | \`unshare\` (util-linux 2.38 or later) and a host that allows a new user and network namespace. Without it, \`qualify\` and \`run\` are BLOCKED unless the owner gives \`--accept-guard-only-network\`. |
| Time limit | The run stops after ${limits.runTimeoutSeconds} s. |

If an item is not available, the result is BLOCKED. The runner has no fallback.

## Files

| File | Use |
| --- | --- |
| \`run.sh\` | Thin wrapper: checks \`SHA256SUMS\` and Node.js, then starts \`runner.mjs\` |
| \`runner.mjs\` | The runner (compiled from \`packages/seethrough-bundle/src/runner.ts\`, Node.js built-ins only) |
| \`guard.py\` | Starts See-through or \`qualify.py\` with audit hooks: no network, no new process, no pickle, no write outside the run directories |
| \`qualify.py\` | Imports each direct requirement, compares installed versions, runs one small CUDA operation. Loads no model |
| \`manifest.json\` | Every pinned file: See-through files, model files, wheels, and the input image hash |
| \`requirements.lock\` | One wheel per package with its SHA-256, for pip \`--require-hashes\` |
| \`SHA256SUMS\` | The SHA-256 of every other file |

## Commands

All commands need \`--work <dir>\`: a real directory of root with mode 755 on the Pod volume. Exit status: 0 PASS or READY, 1 FAIL, 2 usage or input error, 3 INCOMPLETE or BLOCKED.
The owner runs them in this order and can stop after each one. \`qualify\` and \`run\` need separate owner permissions.

| Command | Network | Process and user | Third-party code |
| --- | --- | --- | --- |
| \`preflight [--input <png>]\` | No | None | Not imported |
| \`prepare\` | Yes (pinned URLs only) | root: git. Run user: python3.12 -m venv, pip from the pinned wheel | Wheels installed, See-through not run |
| \`gpu\` | No | root: nvidia-smi | No |
| \`isolation\` | No | Run user: unshare, cat | No |
| \`qualify\` | No (namespace, offline, guard) | Run user: guarded Python | Imports only, one CUDA operation, no model |
| \`run [--input <png>]\` | No (namespace, offline, guard) | Run user: guarded Python | See-through run once |
| \`collect\` | No | None | No |
| \`status\` | No | None | No |

See the owner instructions in the repository (\`packages/seethrough-bundle/docs/OWNER_RUN.md\`) for the complete steps: Pod start, CUDA check, run, evidence, and Pod stop.

## Fixed run

\`inference_psd.py\` with seed ${seed}, resolution 1280, depth resolution 768, 30 steps, \`--save_to_psd\`, and \`--disable_progressbar\`.
Forbidden arguments: ${forbiddenArguments.map((item) => `\`${item}\``).join(', ')}.
Input: \`${input.name}\`, SHA-256 \`${input.sha256}\`. Any other image is refused.
One run per work directory. A second run needs a new work directory and an owner decision.
`;
}

/** Builds the bundle files from the data files, the guard, and the compiled runner. */
export function bundleFiles(data: BundleData): PlannedFile[] {
  if (data.runner.length === 0) fail('E_INPUT', 'The runner file is empty. Build the package first.');
  if (!Array.isArray(data.wheels) || !Array.isArray(data.modelFiles) || !Array.isArray(data.sourceFiles)) return fail('E_DATA', 'A data file is not a JSON list.');
  checkWheelAges(data.wheels);
  const wheels = data.wheels.map(parseWheel);
  const modelFiles = data.modelFiles.map(parseModelFile);
  const sourceFiles = data.sourceFiles.map(parseSourceFile);
  const lock = text(requirementsLock(wheels));
  const fixed: PlannedFile[] = [
    { name: 'guard.py', bytes: data.guard },
    { name: 'qualify.py', bytes: data.qualify },
    { name: 'requirements.lock', bytes: lock }
  ];
  const listed: BundleFile[] = fixed.map((file) => ({ path: file.name, sha256: sha256(file.bytes) }));
  const manifest = parseManifest({
    format: bundleFormat,
    seeThrough: { repository: seeThrough.repository, commit: seeThrough.commit, script: seeThrough.script, files: sourceFiles },
    models: { repositories: modelRepositories, files: modelFiles },
    python: { version: '3.12', wheels },
    input: { name: input.name, sha256: input.sha256 },
    run: { seed, forbiddenArguments },
    bundleFiles: listed
  });
  const files: PlannedFile[] = [
    { name: 'run.sh', bytes: text(runScript) },
    { name: 'runner.mjs', bytes: data.runner },
    ...fixed,
    { name: 'manifest.json', bytes: json(manifest) },
    { name: 'README.md', bytes: text(readme(manifest)) }
  ];
  const sums = files.map((file) => `${sha256(file.bytes)}  ${file.name}`).join('\n');
  return [...files, { name: 'SHA256SUMS', bytes: text(`${sums}\n`) }];
}
