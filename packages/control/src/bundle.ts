import { type CommandResult, parseContractBytes, poseCommand, toolName, workflowCommand } from '@control/commands';
import type { PlannedFile } from '@control/output';
import { sha256 } from '@control/png';
import { fail } from '@control/problems';
import { type ApprovedModel, approvedModels, bundleFormat, minimumNode } from '@control/runner';

// The experiment C execution bundle: a flat directory that the owner copies to the GPU host and starts with one command.
// The build is deterministic: the same contract and the same runner give the same bytes. No date or host name is written.

export const bundleSeed = 1001;
export const bundleSize = '832x1216';
export const bundleControlImage = 'openpose-anatomical.png';

const runScript = `#!/bin/sh
# Experiment C bundle: a thin wrapper only. It checks the bundle files and Node.js, then starts runner.mjs.
# All logic is in runner.mjs. Its TypeScript source is packages/control/src/runner.ts in the repository.
set -eu
cd "$(dirname "$0")"
command -v sha256sum >/dev/null 2>&1 || { echo "E_TOOL: sha256sum is necessary." >&2; exit 2; }
sha256sum --check --quiet --strict SHA256SUMS || { echo "E_BUNDLE_INTEGRITY: a bundle file is missing or changed. Copy the bundle again." >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "E_NODE_MISSING: Node.js ${minimumNode} or later is necessary. See README.md." >&2; exit 2; }
exec node runner.mjs "$@"
`;

function readme(models: readonly ApprovedModel[], seed: number): string {
  const rows = models.map((model) => `| \`${model.file}\` | \`${model.repository}\` at \`${model.revision}\` | ${model.size} | \`${model.sha256}\` |`).join('\n');
  return `# Experiment C execution bundle

**Draft, experiment C only.** This bundle runs exactly two ComfyUI workflows on a GPU host: one text-only baseline and one pose-guided run with the C0.5 candidate OpenPose image, both with seed ${seed}.
It downloads only the two approved model files below, from pinned revisions, and checks their SHA-256 values. It never retries a generation by itself.

The owner does every step on the GPU host. The bundle needs no credentials, no API key, and no public HTTP port.

## Files

| File | Use |
| --- | --- |
| \`run.sh\` | Thin wrapper: checks \`SHA256SUMS\` and Node.js, then starts \`runner.mjs\` |
| \`runner.mjs\` | The runner (compiled from \`packages/control/src/runner.ts\`, Node.js built-ins only) |
| \`bundle.json\` | Model manifest, runs, image size, and the SHA-256 of each bundle file |
| \`${bundleControlImage}\` | The OpenPose control image of the C0.5 candidate |
| \`c0-baseline-${seed}.api.json\`, \`c0-pose-${seed}.api.json\` | The two ComfyUI API workflows |
| \`run-plan.json\` | The prompt, the settings, and the file hashes of the plan |
| \`SHA256SUMS\` | The SHA-256 of every other file |

## Approved model files

| File | Source | Bytes | SHA-256 |
| --- | --- | --- | --- |
${rows}

## Prerequisites on the Pod

- ComfyUI runs on the Pod and answers at \`http://127.0.0.1:8188\`. Do not expose an HTTP port of the Pod. Use SSH only.
- Node.js ${minimumNode} or later (the repository uses the version in \`.nvmrc\`). Check with \`node --version\`. If Node.js is missing, install the official Linux x64 build from nodejs.org and check it against the \`SHASUMS256.txt\` file of the same release before you extract it.
- About 10 GB free space in the ComfyUI models folder.

## Steps

1. Check the bundle on your computer: \`cd <bundle>\` and \`shasum -a 256 -c SHA256SUMS\` (macOS) or \`sha256sum -c SHA256SUMS\` (Linux).
2. Copy it to the Pod: \`scp -P <PORT> -i ~/.ssh/<key> -r <bundle> root@<IP>:/workspace/exp-c-bundle\`.
3. Connect: \`ssh -p <PORT> -i ~/.ssh/<key> root@<IP>\`.
4. Find the ComfyUI models folder: \`find / -type d -path '*ComfyUI/models/checkpoints' 2>/dev/null\`. The models folder is that path without \`/checkpoints\`.
5. Check without download or generation: \`sh /workspace/exp-c-bundle/run.sh check --models-dir <models folder>\`. Before the download, the result is INCOMPLETE (exit status 3) because the models are missing.
6. Run everything with one command: \`sh /workspace/exp-c-bundle/run.sh --models-dir <models folder>\`. It checks, downloads the missing approved files, runs the two workflows once, and saves the images.
7. Status at any time (also from a second SSH session): \`sh /workspace/exp-c-bundle/run.sh status\`.
8. Copy the results to your computer: \`scp -P <PORT> -i ~/.ssh/<key> -r root@<IP>:/workspace/exp-c-bundle/results ./exp-c-results\`, then \`cd exp-c-results && shasum -a 256 -c SHA256SUMS\`.
9. Terminate the Pod (not only Stop). A stopped Pod still pays for its volume disk.

## Results

\`results/\` contains \`baseline-${seed}.png\`, \`pose-${seed}.png\`, \`SHA256SUMS\`, \`result.json\` (models with SHA-256, ComfyUI, Python, PyTorch and GPU data, prompt ids, image hashes), \`state.json\`, and \`run.log\` (JSON Lines, no secrets).
The runner reports PASS only after the images and \`SHA256SUMS\` are written and read back with the same SHA-256 values.

## Repeat runs and errors

- A second \`run.sh\` after PASS does nothing and prints the saved result.
- After an interruption, the same command continues: it waits for the recorded prompt and does not submit it again. If ComfyUI lost the prompt (for example after a restart), the runner stops with \`E_PROMPT_LOST\`. A new run is the owner's decision: move \`results/\` away and run again.
- An existing model file with another SHA-256 stops the runner (\`E_MODEL_HASH_MISMATCH\`). The runner never replaces it. A failed download removes its \`.part\` file.
- Each error prints a code, a message, and a hint. Exit status: 0 PASS, 1 FAIL, 2 usage or input error, 3 INCOMPLETE.
`;
}

const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

export type BundleOptions = { readonly contractBytes: Buffer; readonly runnerBytes: Buffer; readonly approved?: readonly ApprovedModel[] };

/** \`bundle\`: the experiment C execution bundle for the C0.5 candidate contract. No network access. */
export function bundleCommand(options: BundleOptions): CommandResult {
  const approved = options.approved ?? approvedModels;
  const contract = parseContractBytes(options.contractBytes);
  if (!contract.rigId.endsWith('_c05_candidate')) fail('E_CONTRACT_NOT_CANDIDATE', `The contract ${contract.rigId} is not the C0.5 candidate. Experiment C uses the C0.5 candidate geometry.`);
  if (options.runnerBytes.length === 0) fail('E_INPUT', 'The runner file is empty. Build the package first.');
  const checkpoint = approved.find((model) => model.folder === 'checkpoints');
  const controlNet = approved.find((model) => model.folder === 'controlnet');
  if (!checkpoint || !controlNet || approved.length !== 2) fail('E_MODELS', 'The approved list must have one checkpoint and one ControlNet.');
  const pose = poseCommand(options.contractBytes, bundleSize, ['anatomical']);
  const poseImage = pose.files.find((file) => file.name === bundleControlImage);
  if (!poseImage) return fail('E_INTERNAL', 'The pose command gave no anatomical OpenPose image.');
  const workflows = workflowCommand({
    checkpoint: checkpoint.file,
    controlNet: controlNet.file,
    checkpointSha256: checkpoint.sha256,
    controlNetSha256: controlNet.sha256,
    seeds: [bundleSeed],
    baselineSeed: bundleSeed,
    poseImageName: bundleControlImage,
    poseImageBytes: poseImage.bytes
  });
  const files: PlannedFile[] = [
    { name: 'run.sh', bytes: Buffer.from(runScript, 'utf8') },
    { name: 'runner.mjs', bytes: options.runnerBytes },
    { name: 'README.md', bytes: Buffer.from(readme(approved, bundleSeed), 'utf8') },
    { name: bundleControlImage, bytes: poseImage.bytes },
    ...workflows.files
  ];
  const [width, height] = bundleSize.split('x').map(Number);
  const manifest = {
    format: bundleFormat,
    experiment: 'C first run: one baseline and one pose-guided image, C0.5 candidate',
    tool: toolName,
    contract: { rigId: contract.rigId, contractVersion: contract.contractVersion, sha256: sha256(options.contractBytes) },
    models: approved,
    controlImage: { path: bundleControlImage, uploadName: bundleControlImage },
    image: { width, height },
    runs: [
      { id: `baseline-${bundleSeed}`, kind: 'baseline', seed: bundleSeed, workflow: `c0-baseline-${bundleSeed}.api.json`, saveNode: '7' },
      { id: `pose-${bundleSeed}`, kind: 'pose', seed: bundleSeed, workflow: `c0-pose-${bundleSeed}.api.json`, saveNode: '7' }
    ],
    files: files.map((file) => ({ path: file.name, sha256: sha256(file.bytes) }))
  };
  files.push({ name: 'bundle.json', bytes: json(manifest) });
  const sums = files.map((file) => `${sha256(file.bytes)}  ${file.name}\n`).join('');
  files.push({ name: 'SHA256SUMS', bytes: Buffer.from(sums, 'utf8') });
  return {
    report: {
      status: 'PASS',
      command: 'bundle',
      contract: manifest.contract,
      models: approved.map((model) => ({ file: model.file, revision: model.revision, sha256: model.sha256 })),
      runs: manifest.runs,
      files: files.map((file) => ({ name: file.name, sha256: sha256(file.bytes) }))
    },
    files
  };
}
