import { type CommandResult, depthCommand, parseContractBytes, poseCommand, toolName, workflowCommand } from '@control/commands';
import type { PlannedFile } from '@control/output';
import { sha256 } from '@control/png';
import { fail } from '@control/problems';
import { type ApprovedModel, approvedModels, bundleFormat, bundleFormatC2, c2RunIdA, c2RunIdB, c2Runs, c2Seeds, minimumNode } from '@control/runner';
import { c0Defaults, c2Depth, c2Prompt, type GenerationSettings, poseDepthWorkflow, poseWorkflow, unionControlType } from '@control/workflow';

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

- A second \`run.sh\` after PASS reads both images and \`SHA256SUMS\` again and compares them with \`result.json\`. If they agree, it prints the saved result and runs nothing. If a file is missing or changed, it stops with \`E_RESULT_CHANGED\` (FAIL) and does not generate again.
- The runner records each submission in \`state.json\` before it sends the prompt to ComfyUI. If the connection breaks before ComfyUI gives a prompt id, the prompt was possibly queued. The runner then stops with \`E_SUBMISSION_AMBIGUOUS\`, also on each repeat run, and never submits that run again. Check the ComfyUI queue and history by hand (the hint gives the commands and the \`client_id\`). ComfyUI gives no exactly-once guarantee, and the runner does not claim one.
- After an interruption, the same command continues: it waits for the recorded prompt and does not submit it again. If ComfyUI lost the prompt (for example after a restart), the runner stops with \`E_PROMPT_LOST\`. A new run is the owner's decision: move \`results/\` away and run again.
- An existing model file with another SHA-256 stops the runner (\`E_MODEL_HASH_MISMATCH\`). The runner never replaces it. A failed download removes its \`.part\` file.
- Each error prints a code, a message, and a hint. Exit status: 0 PASS, 1 FAIL, 2 usage or input error, 3 INCOMPLETE.
`;
}

const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

export type BundleOptions = { readonly contractBytes: Buffer; readonly runnerBytes: Buffer; readonly approved?: readonly ApprovedModel[]; readonly experiment?: 'c1' | 'c2' };

/** \`bundle\`: the experiment C execution bundle for the C0.5 candidate contract. No network access. */
export function bundleCommand(options: BundleOptions): CommandResult {
  if (options.experiment === 'c2') return c2BundleCommand(options);
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

// ---------------------------------------------------------------- experiment C2

export const c2DepthImage = 'depth-c05.png';
const c2Experiment = 'C2: OpenPose only (A) against OpenPose + depth (B), seeds 1001 to 1003, C0.5 candidate';

const runIdA = c2RunIdA;
const runIdB = c2RunIdB;

function c2Readme(models: readonly ApprovedModel[]): string {
  const rows = models.map((model) => `| \`${model.file}\` | \`${model.repository}\` at \`${model.revision}\` | ${model.size} | \`${model.sha256}\` |`).join('\n');
  const runs = c2Seeds.map((seed) => `| ${seed} | \`${runIdA(seed)}\` | \`${runIdB(seed)}\` |`).join('\n');
  return `# Experiment C2 execution bundle

**Draft, experiment C2 only. Not run yet.** This bundle runs six ComfyUI workflows on a GPU host: condition A (OpenPose only) and condition B
(OpenPose + depth) for the seeds ${c2Seeds.join(', ')}. The only difference between A and B of one seed is the depth control. The runner checks this before it contacts ComfyUI.
It downloads only the two approved model files below, from pinned revisions, and checks their SHA-256 values. It never retries a generation by itself.

**No real ComfyUI or GPU test of this bundle was done.** The C1 run confirmed the OpenPose graph on ComfyUI 0.35.0. The depth union type and two chained control applications
are new. The \`check\` command compares every node input and the union types with the live ComfyUI (\`/object_info\`) before any download or generation.

The owner does every step on the GPU host. The bundle needs no credentials, no API key, and no public HTTP port.

## Runs

| Seed | Condition A: OpenPose (strength ${c0Defaults.strength}, 0 to ${c0Defaults.endPercent}) | Condition B: OpenPose + depth (depth strength ${c2Depth.strength}, ${c2Depth.startPercent} to ${c2Depth.endPercent}) |
| --- | --- | --- |
${runs}

## Files

| File | Use |
| --- | --- |
| \`run.sh\` | Thin wrapper: checks \`SHA256SUMS\` and Node.js, then starts \`runner.mjs\` |
| \`runner.mjs\` | The runner (compiled from \`packages/control/src/runner.ts\`, Node.js built-ins only) |
| \`bundle.json\` | Model manifest, control images, runs, image size, and the SHA-256 of each bundle file |
| \`${bundleControlImage}\` | The OpenPose control image of the C0.5 candidate (the same file as in C1) |
| \`${c2DepthImage}\` | The approximate depth image of the C0.5 reference body (\`aigg-control depth\`) |
| \`c2-a-<seed>.api.json\`, \`c2-b-<seed>.api.json\` | The six ComfyUI API workflows |
| \`run-plan.json\` | The prompt, the settings, the depth control, and the file hashes of the plan |
| \`SHA256SUMS\` | The SHA-256 of every other file |

## Approved model files

| File | Source | Bytes | SHA-256 |
| --- | --- | --- | --- |
${rows}

## Runpod steps

The steps are the same as for C1. Do them in this order. Stop at the first error and report it. Do not repeat a step that failed with a generation error.

1. On your computer, check the bundle: \`shasum -a 256 -c SHA256SUMS\` (macOS) or \`sha256sum -c SHA256SUMS\` (Linux).
2. Create the Pod: the official ComfyUI template, On-Demand, RTX A5000 24 GB (alternative RTX 3090 or the A6000 of C1). Remove all HTTP ports. Keep only TCP 22 with your SSH key.
   Container and volume disk: at least 20 GB free for the two model files (about 9.5 GB) and ComfyUI.
3. Connect: \`ssh -p <PORT> -i ~/.ssh/<key> root@<IP>\`. Check that ComfyUI answers only on the Pod: \`curl -s http://127.0.0.1:8188/system_stats\`.
4. Check Node.js: \`node --version\` must be ${minimumNode} or later. If Node.js is missing, install the official Linux x64 build from nodejs.org and check it against the \`SHASUMS256.txt\` file of the same release before you extract it.
5. Copy the bundle: \`scp -P <PORT> -i ~/.ssh/<key> -r <bundle> root@<IP>:/workspace/exp-c2-bundle\`.
6. Find the models folder: \`find / -type d -path '*ComfyUI/models/checkpoints' 2>/dev/null\`. The models folder is that path without \`/checkpoints\`.
7. **Check first, before the download:** \`sh /workspace/exp-c2-bundle/run.sh check --models-dir <models folder>\`.
   It checks the bundle, every node input of the six graphs, the union types \`openpose\` and \`depth\`, and the sampler choices against this ComfyUI.
   INCOMPLETE (exit status 3) with "Model files are missing" is the expected result. Any \`E_COMFYUI_*\` error means the graph does not fit this ComfyUI: stop, terminate the Pod, and report it.
8. Run: \`sh /workspace/exp-c2-bundle/run.sh --models-dir <models folder>\`. It downloads the missing approved files, checks again, uploads the two control images, and runs the six workflows once.
9. Status at any time: \`sh /workspace/exp-c2-bundle/run.sh status\`.
10. Copy the results: \`scp -P <PORT> -i ~/.ssh/<key> -r root@<IP>:/workspace/exp-c2-bundle/results ./exp-c2-results\`, then \`cd exp-c2-results && shasum -a 256 -c SHA256SUMS\`.
11. Terminate the Pod (not only Stop). A stopped Pod still pays for its volume disk.

## Results

\`results/\` contains the six images (\`<run id>.png\`), \`SHA256SUMS\`, \`result.json\` (models with SHA-256, ComfyUI, Python, PyTorch and GPU data, prompt ids, image hashes), \`state.json\`, and \`run.log\` (JSON Lines, no secrets).
The runner reports PASS only after all six images and \`SHA256SUMS\` are written and read back with the same SHA-256 values.

## Repeat runs and errors

- A second \`run.sh\` after PASS reads the images and \`SHA256SUMS\` again and compares them with \`result.json\`. It never generates again. A changed result is \`E_RESULT_CHANGED\` (FAIL).
- Each submission is recorded in \`state.json\` before it is sent. A lost answer gives \`E_SUBMISSION_AMBIGUOUS\`, also on each repeat run, and that run is never submitted again by the runner. Check the ComfyUI queue and history by hand.
- After an interruption, the same command continues with the recorded prompts. A prompt that ComfyUI lost gives \`E_PROMPT_LOST\`. A new run is the owner's decision.
- A generation error (\`E_GENERATION_FAILED\`) stops the runner. The runs before it keep their images. Do not start again without a decision.
- Exit status: 0 PASS, 1 FAIL, 2 usage or input error, 3 INCOMPLETE.
- The runner accepts only the six runs above (seeds ${c2Seeds.join(', ')}, conditions A and B). Another seed or run list gives \`E_BUNDLE_RUNS\` before any request to ComfyUI.

## Owner actions: cost and stop

The runner stops only on its own errors. **It does not stop, terminate, or pay for the Pod, and nothing in this bundle terminates a Runpod Pod automatically.**
These limits need your action:

- Spend: the expected cost is below $1. Watch the Runpod balance and the elapsed time. If the spend for C2 goes above $3, terminate the Pod.
- Visual stop: look at the images. If an image breaks the content rules (explicit content, a character that does not look adult), stop and report it. Do not run again.
- Teardown: terminate the Pod after step 10, and also after any stop. A Pod that you do not terminate continues to cost money.
`;
}

/** The C2 bundle: the same OpenPose image as C1, the depth image, and conditions A and B for three seeds. */
function c2BundleCommand(options: BundleOptions): CommandResult {
  const approved = options.approved ?? approvedModels;
  const contract = parseContractBytes(options.contractBytes);
  if (!contract.rigId.endsWith('_c05_candidate')) fail('E_CONTRACT_NOT_CANDIDATE', `The contract ${contract.rigId} is not the C0.5 candidate. Experiment C2 uses the C0.5 candidate geometry.`);
  if (options.runnerBytes.length === 0) fail('E_INPUT', 'The runner file is empty. Build the package first.');
  const checkpoint = approved.find((model) => model.folder === 'checkpoints');
  const controlNet = approved.find((model) => model.folder === 'controlnet');
  if (!checkpoint || !controlNet || approved.length !== 2) fail('E_MODELS', 'The approved list must have one checkpoint and one ControlNet.');
  const pose = poseCommand(options.contractBytes, bundleSize, ['anatomical']).files.find((file) => file.name === bundleControlImage);
  if (!pose) return fail('E_INTERNAL', 'The pose command gave no anatomical OpenPose image.');
  const depthResult = depthCommand(options.contractBytes, bundleSize);
  if (depthResult.report.status !== 'PASS') fail('E_DEPTH_CHECK', 'The depth image fails its checks D1 to D7. Run aigg-control depth for the details.');
  const depth = depthResult.files.find((file) => file.name === c2DepthImage);
  if (!depth) return fail('E_INTERNAL', 'The depth command gave no depth image.');
  const [width, height] = bundleSize.split('x').map(Number) as [number, number];
  const size = { width, height };
  const settings: GenerationSettings = { checkpoint: checkpoint.file, controlNet: controlNet.file, positive: c2Prompt.positive, negative: c2Prompt.negative, ...c0Defaults };
  const workflows: PlannedFile[] = [];
  const runs = c2Runs();
  for (const run of runs) {
    const graph =
      run.kind === 'pose'
        ? poseWorkflow(settings, size, run.seed, `c2_a_openpose_${run.seed}`, bundleControlImage)
        : poseDepthWorkflow(settings, size, run.seed, `c2_b_openpose_depth_${run.seed}`, bundleControlImage, c2DepthImage);
    workflows.push({ name: run.workflow, bytes: json(graph) });
  }
  const plan = {
    format: 'aigg.run-plan/0.2',
    tool: toolName,
    experiment: c2Experiment,
    runStatus: 'NOT RUN',
    approval: 'Owner decisions after C1: depth mode of the approved union ControlNet file for C2, no new model weights. The owner starts each paid run.',
    models: { checkpoint: { file: checkpoint.file, sha256: checkpoint.sha256 }, controlNet: { file: controlNet.file, sha256: controlNet.sha256 } },
    controlImages: [
      {
        role: 'openpose',
        file: bundleControlImage,
        sha256: sha256(pose.bytes),
        unionType: unionControlType,
        strength: c0Defaults.strength,
        startPercent: 0,
        endPercent: c0Defaults.endPercent,
        conditions: ['A', 'B']
      },
      {
        role: 'depth',
        file: c2DepthImage,
        sha256: sha256(depth.bytes),
        unionType: c2Depth.type,
        strength: c2Depth.strength,
        startPercent: c2Depth.startPercent,
        endPercent: c2Depth.endPercent,
        conditions: ['B']
      }
    ],
    application: 'Condition B chains a second ControlNetApplyAdvanced (depth) after the OpenPose application. Both use the same union ControlNet loader through separate SetUnionControlNetType nodes.',
    settings: { steps: c0Defaults.steps, cfg: c0Defaults.cfg, sampler: c0Defaults.sampler, scheduler: c0Defaults.scheduler, size },
    prompt: c2Prompt,
    runs: runs.map(({ saveNode: _saveNode, ...run }) => run),
    files: workflows.map((file) => ({ name: file.name, sha256: sha256(file.bytes) }))
  };
  const files: PlannedFile[] = [
    { name: 'run.sh', bytes: Buffer.from(runScript, 'utf8') },
    { name: 'runner.mjs', bytes: options.runnerBytes },
    { name: 'README.md', bytes: Buffer.from(c2Readme(approved), 'utf8') },
    { name: bundleControlImage, bytes: pose.bytes },
    { name: c2DepthImage, bytes: depth.bytes },
    ...workflows,
    { name: 'run-plan.json', bytes: json(plan) }
  ];
  const manifest = {
    format: bundleFormatC2,
    experiment: c2Experiment,
    tool: toolName,
    contract: { rigId: contract.rigId, contractVersion: contract.contractVersion, sha256: sha256(options.contractBytes) },
    models: approved,
    controlImages: [
      { role: 'openpose', path: bundleControlImage, uploadName: bundleControlImage },
      { role: 'depth', path: c2DepthImage, uploadName: c2DepthImage }
    ],
    image: size,
    runs,
    files: files.map((file) => ({ path: file.name, sha256: sha256(file.bytes) }))
  };
  files.push({ name: 'bundle.json', bytes: json(manifest) });
  files.push({ name: 'SHA256SUMS', bytes: Buffer.from(files.map((file) => `${sha256(file.bytes)}  ${file.name}\n`).join(''), 'utf8') });
  return {
    report: {
      status: 'PASS',
      command: 'bundle',
      experiment: 'c2',
      contract: manifest.contract,
      models: approved.map((model) => ({ file: model.file, revision: model.revision, sha256: model.sha256 })),
      runs: manifest.runs,
      files: files.map((file) => ({ name: file.name, sha256: sha256(file.bytes) }))
    },
    files
  };
}
