// Experiment C runner. It runs on the GPU host (a Runpod Pod), next to ComfyUI.
//
// This module is self-contained: it imports only Node.js built-ins, so the build gives one file that the bundle copies as runner.mjs.
// Scope: exactly the two approved model files, exactly the runs in the bundle.
//   Format 0.1 (C1): one baseline and one pose-guided run with the same seed.
//   Format 0.2 (C2): condition A (OpenPose) and condition B (OpenPose + depth) for each of three seeds. A and B of one seed must be
//   the same graph except the depth nodes; the runner checks this before any request to ComfyUI.
//
// Trust boundaries and controls:
// - The bundle is data from the repository. Each file is checked against bundle.json and against SHA256SUMS (run.sh) before use.
// - ComfyUI is reached only at http://127.0.0.1:<port>. The runner never opens a public endpoint and never sends credentials.
// - Model files come only from the pinned Hugging Face URLs of the approved list in this file. A bundle cannot add or change a model.
//   A downloaded file is written to a .part name and gets its final name only when its size and SHA-256 agree.
// - An existing model file with another SHA-256 is an error. The runner never replaces it.
// - Each run is submitted at most once. state.json records the prompt id before the wait. A lost prompt is an error, not a new attempt.
// - The result is PASS only when the images and the SHA256SUMS file are written and read back with the same SHA-256 values.
// - The log and the reports contain no environment values, no tokens, and no query strings of download URLs.

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
  writeSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const bundleFormat = 'aigg.exp-c-bundle/0.1';
export const bundleFormatC2 = 'aigg.exp-c-bundle/0.2';
export const maxRuns = 6;
export const resultFormat = 'aigg.exp-c-result/0.1';
export const minimumNode = '22.12.0';
export const comfyHost = '127.0.0.1';

/** An approved model file. The values are copied from docs/MODEL_LICENSES.md ("Approved for experiment C"). */
export type ApprovedModel = {
  readonly id: string;
  readonly repository: string;
  readonly revision: string;
  readonly file: string;
  readonly size: number;
  readonly sha256: string;
  readonly folder: 'checkpoints' | 'controlnet';
  readonly license: string;
};

export const approvedModels: readonly ApprovedModel[] = [
  {
    id: 'checkpoint',
    repository: 'cagliostrolab/animagine-xl-4.0',
    revision: '2b7c1b397761bf5bd3cc42e5b39ec99314a75a96',
    file: 'animagine-xl-4.0.safetensors',
    size: 6938434056,
    sha256: '1d5b43ff75b6ab598502d4c779d2fbfa3dceca51c60c3b609640a60772333916',
    folder: 'checkpoints',
    license: 'CreativeML Open RAIL++-M'
  },
  {
    id: 'controlNet',
    repository: 'xinsir/controlnet-union-sdxl-1.0',
    revision: '801a4a3fa3d4c936f4feea95b98607bc6726f80c',
    file: 'diffusion_pytorch_model_promax.safetensors',
    size: 2513342408,
    sha256: '9fae2e50cb431bfcbe05822b59ec2228df545ef27f711dea8949e9f4ed9f7cdc',
    folder: 'controlnet',
    license: 'Apache-2.0'
  }
];

/** The pinned download URL of a model file. */
export const modelUrl = (model: ApprovedModel): string => `https://huggingface.co/${model.repository}/resolve/${model.revision}/${model.file}`;

/** The ComfyUI core nodes that the workflows can use. Any other node type stops the run. */
export const allowedNodeTypes: readonly string[] = [
  'CheckpointLoaderSimple',
  'CLIPTextEncode',
  'EmptyLatentImage',
  'KSampler',
  'VAEDecode',
  'SaveImage',
  'LoadImage',
  'ControlNetLoader',
  'SetUnionControlNetType',
  'ControlNetApplyAdvanced'
];

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

function fail(code: string, message: string, hint?: string, exitCode = 1): never {
  throw new RunnerError(code, message, hint, exitCode);
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex64 = /^[0-9a-f]{64}$/;
const plainPath = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Prints untrusted text for a message: cut, printable ASCII only. */
export function show(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  const cut = text.length > 200 ? `${text.slice(0, 200)}...` : text;
  return cut.replace(/[^\x20-\x7e]/g, '?');
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** SHA-256 of a file, read as a stream. */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part as Buffer);
  return hash.digest('hex');
}

// ---------------------------------------------------------------- bundle

export type RunKind = 'baseline' | 'pose' | 'pose-depth';
export type BundleRun = { readonly id: string; readonly kind: RunKind; readonly seed: number; readonly workflow: string; readonly saveNode: string };
export type ControlRole = 'openpose' | 'depth';
export type ControlImage = { readonly role: ControlRole; readonly path: string; readonly uploadName: string };
/** The control images and union types that each run kind uses. */
export const kindControls: Readonly<Record<RunKind, readonly ControlRole[]>> = { baseline: [], pose: ['openpose'], 'pose-depth': ['openpose', 'depth'] };
export type BundleFile = { readonly path: string; readonly sha256: string };
export type Bundle = {
  readonly format: string;
  readonly experiment: string;
  readonly models: readonly ApprovedModel[];
  readonly controlImages: readonly ControlImage[];
  readonly image: { readonly width: number; readonly height: number };
  readonly runs: readonly BundleRun[];
  readonly files: readonly BundleFile[];
};

const maxBundleFileBytes = 16 * 1024 * 1024;

function readBundleFile(root: string, path: string): Buffer {
  if (!plainPath.test(path) || path.split('/').some((part) => part === '.' || part === '..')) fail('E_BUNDLE', `The bundle path ${show(path)} is not a plain relative path.`);
  // One file descriptor for the type check, the size check and the read, so they see the same file. O_NOFOLLOW refuses a link.
  let fd: number;
  try {
    fd = openSync(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return fail(
      'E_BUNDLE_INTEGRITY',
      code === 'ENOENT' ? `The bundle file ${path} is missing.` : `The bundle file ${path} cannot be opened (${show(code)}).`,
      'Copy the complete bundle directory again.'
    );
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) fail('E_BUNDLE_INTEGRITY', `The bundle file ${path} is not a regular file.`);
    const buffer = Buffer.alloc(maxBundleFileBytes + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
      if (length > maxBundleFileBytes) fail('E_BUNDLE_INTEGRITY', `The bundle file ${path} is too large.`);
    }
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

const uploadNamePattern = /^[A-Za-z0-9._-]{1,200}\.png$/;

function parseRun(run: unknown, allowed: readonly RunKind[]): BundleRun {
  if (!isRecord(run) || typeof run.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(run.id)) return fail('E_BUNDLE_RUNS', 'A run has no valid id.');
  if (typeof run.kind !== 'string' || !(allowed as readonly string[]).includes(run.kind)) return fail('E_BUNDLE_RUNS', `Run ${run.id} has an unknown kind.`);
  if (!Number.isSafeInteger(run.seed) || typeof run.workflow !== 'string' || typeof run.saveNode !== 'string') return fail('E_BUNDLE_RUNS', `Run ${run.id} is not complete.`);
  return { id: run.id, kind: run.kind as RunKind, seed: run.seed as number, workflow: run.workflow, saveNode: run.saveNode };
}

/** Parses bundle.json and checks that the models are exactly the approved list and the runs are the approved runs. */
export function parseBundle(value: unknown, approved: readonly ApprovedModel[] = approvedModels): Bundle {
  if (!isRecord(value)) return fail('E_BUNDLE', 'bundle.json is not a JSON object.');
  if (value.format !== bundleFormat && value.format !== bundleFormatC2) fail('E_BUNDLE', `bundle.json format must be ${bundleFormat} or ${bundleFormatC2}.`);
  const c2 = value.format === bundleFormatC2;
  if (typeof value.experiment !== 'string') fail('E_BUNDLE', 'bundle.json has no experiment name.');
  const models = value.models;
  if (!Array.isArray(models) || JSON.stringify(models) !== JSON.stringify(approved))
    fail('E_BUNDLE_MODELS', 'The models in bundle.json are not exactly the approved model files.', 'Only the two files approved for experiment C can be used. Build the bundle again.');
  const controls: ControlImage[] = [];
  if (c2) {
    const list = value.controlImages;
    if (!Array.isArray(list) || list.length !== 2) fail('E_BUNDLE', 'bundle.json controlImages must list the OpenPose and the depth image.');
    for (const item of list as unknown[]) {
      if (!isRecord(item) || (item.role !== 'openpose' && item.role !== 'depth') || typeof item.path !== 'string' || typeof item.uploadName !== 'string' || !uploadNamePattern.test(item.uploadName))
        fail('E_BUNDLE', 'A control image entry in bundle.json is not valid.');
      controls.push({ role: item.role, path: item.path, uploadName: item.uploadName });
    }
    if (new Set(controls.map((item) => item.role)).size !== 2 || new Set(controls.map((item) => item.uploadName)).size !== 2)
      fail('E_BUNDLE', 'The control images must be one OpenPose and one depth image with different names.');
  } else {
    const control = value.controlImage;
    if (!isRecord(control) || typeof control.path !== 'string' || typeof control.uploadName !== 'string' || !uploadNamePattern.test(control.uploadName))
      fail('E_BUNDLE', 'bundle.json controlImage is not valid.');
    controls.push({ role: 'openpose', path: control.path, uploadName: control.uploadName });
  }
  const image = value.image;
  if (!isRecord(image) || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)) fail('E_BUNDLE', 'bundle.json image size is not valid.');
  const runs = value.runs;
  if (!Array.isArray(runs) || runs.length > maxRuns) return fail('E_BUNDLE_RUNS', `bundle.json must have a list of at most ${maxRuns} runs.`);
  const parsedRuns = (runs as unknown[]).map((run) => parseRun(run, c2 ? ['pose', 'pose-depth'] : ['baseline', 'pose']));
  if (new Set(parsedRuns.map((run) => run.id)).size !== parsedRuns.length) fail('E_BUNDLE_RUNS', 'Two runs have the same id.');
  if (c2) {
    // Exactly one condition A and one condition B for each of three different seeds.
    const seeds = [...new Set(parsedRuns.map((run) => run.seed))];
    if (parsedRuns.length !== 6 || seeds.length !== 3) fail('E_BUNDLE_RUNS', 'A C2 bundle must have six runs: conditions A and B for three seeds.');
    for (const seed of seeds) {
      const kinds = parsedRuns
        .filter((run) => run.seed === seed)
        .map((run) => run.kind)
        .sort();
      if (kinds.length !== 2 || kinds[0] !== 'pose' || kinds[1] !== 'pose-depth') fail('E_BUNDLE_RUNS', `Seed ${seed} must have one OpenPose run and one OpenPose + depth run.`);
    }
  } else {
    if (parsedRuns.length !== 2) fail('E_BUNDLE_RUNS', 'bundle.json must have exactly two runs: one baseline and one pose-guided run.');
    const kinds = parsedRuns.map((run) => run.kind).sort();
    if (kinds[0] !== 'baseline' || kinds[1] !== 'pose') fail('E_BUNDLE_RUNS', 'The runs must be one baseline and one pose-guided run.');
    if (parsedRuns[0]?.seed !== parsedRuns[1]?.seed) fail('E_BUNDLE_RUNS', 'The two runs must use the same seed.');
  }
  const files = value.files;
  if (!Array.isArray(files) || files.length === 0) fail('E_BUNDLE', 'bundle.json has no file list.');
  const parsedFiles = (files as unknown[]).map((file): BundleFile => {
    if (!isRecord(file) || typeof file.path !== 'string' || typeof file.sha256 !== 'string' || !hex64.test(file.sha256)) return fail('E_BUNDLE', 'A file entry in bundle.json is not valid.');
    return { path: file.path, sha256: file.sha256 };
  });
  return {
    format: c2 ? bundleFormatC2 : bundleFormat,
    experiment: value.experiment,
    models: approved,
    controlImages: controls,
    image: { width: image.width as number, height: image.height as number },
    runs: parsedRuns,
    files: parsedFiles
  };
}

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

const link = (value: unknown): string | null => (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isSafeInteger(value[1]) ? value[0] : null);

/**
 * Checks a workflow graph: only allowed core nodes, the approved model names, the run seed, one image of the bundle size, one save node,
 * and the control wiring of the run kind: each control application uses a union type node of its role and the control image of the same
 * role, the applications form one chain from the prompts to the sampler, and no other image is loaded.
 */
export function checkWorkflow(value: unknown, run: BundleRun, bundle: Bundle): Graph {
  if (!isRecord(value)) return fail('E_WORKFLOW', `The workflow of run ${run.id} is not a JSON object.`);
  const graph = value as Graph;
  const checkpoint = bundle.models.find((model) => model.folder === 'checkpoints')?.file;
  const controlNet = bundle.models.find((model) => model.folder === 'controlnet')?.file;
  let samplers = 0;
  const loads: string[] = [];
  const applies: string[] = [];
  for (const [id, node] of Object.entries(graph)) {
    if (!isRecord(node) || typeof node.class_type !== 'string' || !isRecord(node.inputs)) fail('E_WORKFLOW', `Node ${show(id)} of run ${run.id} is not valid.`);
    if (!allowedNodeTypes.includes(node.class_type)) fail('E_WORKFLOW_NODE', `Run ${run.id} uses the node type ${show(node.class_type)}, which is not allowed.`);
    const inputs = node.inputs;
    if (node.class_type === 'CheckpointLoaderSimple' && inputs.ckpt_name !== checkpoint) fail('E_WORKFLOW_MODEL', `Run ${run.id} loads a checkpoint that is not approved.`);
    if (node.class_type === 'ControlNetLoader' && inputs.control_net_name !== controlNet) fail('E_WORKFLOW_MODEL', `Run ${run.id} loads a ControlNet that is not approved.`);
    if (node.class_type === 'KSampler') {
      samplers += 1;
      if (inputs.seed !== run.seed) fail('E_WORKFLOW_SEED', `The sampler seed of run ${run.id} is not ${run.seed}.`);
    }
    if (node.class_type === 'EmptyLatentImage' && (inputs.batch_size !== 1 || inputs.width !== bundle.image.width || inputs.height !== bundle.image.height))
      fail('E_WORKFLOW', `Run ${run.id} must make one image of ${bundle.image.width}x${bundle.image.height}.`);
    if (node.class_type === 'LoadImage') loads.push(id);
    if (node.class_type === 'ControlNetApplyAdvanced') applies.push(id);
    if (node.class_type === 'SaveImage' && id !== run.saveNode) fail('E_WORKFLOW', `Run ${run.id} has a second save node.`);
  }
  if (samplers !== 1) fail('E_WORKFLOW', `Run ${run.id} must have exactly one sampler.`);
  if (graph[run.saveNode]?.class_type !== 'SaveImage') fail('E_WORKFLOW', `Run ${run.id} has no save node ${run.saveNode}.`);
  const roles = kindControls[run.kind];
  if (loads.length !== roles.length || applies.length !== roles.length) fail('E_WORKFLOW', `Run ${run.id} (${run.kind}) must load and apply exactly ${roles.length} control image(s).`);
  const seen: ControlRole[] = [];
  for (const id of applies) {
    const inputs = (graph[id] as Graph[string]).inputs;
    const typeNode = graph[link(inputs.control_net) ?? ''];
    const imageNode = graph[link(inputs.image) ?? ''];
    if (typeNode?.class_type !== 'SetUnionControlNetType' || imageNode?.class_type !== 'LoadImage')
      fail('E_WORKFLOW_CONTROL', `Control node ${id} of run ${run.id} must use a union type node and a loaded image.`);
    if (graph[link(typeNode.inputs.control_net) ?? '']?.class_type !== 'ControlNetLoader')
      fail('E_WORKFLOW_CONTROL', `The union type node of control ${id} in run ${run.id} must use the ControlNet loader.`);
    const role = typeNode.inputs.type;
    const control = bundle.controlImages.find((item) => item.role === role);
    if (!control || !roles.includes(control.role)) fail('E_WORKFLOW_CONTROL', `Run ${run.id} uses the union type ${show(role)}, which is not allowed for ${run.kind}.`);
    if (imageNode.inputs.image !== control.uploadName) fail('E_WORKFLOW_CONTROL', `Run ${run.id} applies ${control.role} control to an image other than ${control.uploadName}.`);
    seen.push(control.role);
  }
  if ([...seen].sort().join() !== [...roles].sort().join()) fail('E_WORKFLOW_CONTROL', `Run ${run.id} must apply each of ${roles.join(', ') || 'no'} control once.`);
  // The sampler conditioning must come through every control application, in one chain, back to two different prompts.
  const sampler = Object.values(graph).find((node) => node.class_type === 'KSampler') as Graph[string];
  const ends: string[] = [];
  for (const [input, index] of [
    ['positive', 0],
    ['negative', 1]
  ] as const) {
    let ref = sampler.inputs[input];
    let steps = 0;
    for (;;) {
      const id = link(ref);
      const node = id === null ? undefined : graph[id];
      if (node?.class_type !== 'ControlNetApplyAdvanced') break;
      if ((ref as unknown[])[1] !== index) fail('E_WORKFLOW_CONTROL', `The ${input} conditioning of run ${run.id} uses the wrong output of control node ${id}.`);
      ref = node.inputs[input];
      steps += 1;
      if (steps > applies.length) fail('E_WORKFLOW_CONTROL', `The ${input} conditioning of run ${run.id} has a loop.`);
    }
    const end = link(ref);
    if (steps !== applies.length || end === null || graph[end]?.class_type !== 'CLIPTextEncode')
      fail('E_WORKFLOW_CONTROL', `The ${input} conditioning of run ${run.id} does not pass through all control nodes to a prompt.`);
    ends.push(end);
  }
  if (ends[0] === ends[1]) fail('E_WORKFLOW_CONTROL', `Run ${run.id} uses the same prompt for the positive and the negative conditioning.`);
  return graph;
}

/** A graph without node titles and with a neutral save prefix, for the comparison of the two conditions. */
const comparable = (graph: Graph): string =>
  JSON.stringify(
    Object.keys(graph)
      .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))
      .map((id) => {
        const node = graph[id] as Graph[string];
        const inputs = node.class_type === 'SaveImage' ? { ...node.inputs, filename_prefix: null } : node.inputs;
        return [
          id,
          node.class_type,
          Object.keys(inputs)
            .sort()
            .map((key) => [key, inputs[key]])
        ];
      })
  );

/**
 * C2: condition B of a seed minus its depth nodes must be the same graph as condition A of that seed. So the only experimental difference
 * is the depth control. The depth nodes are the depth control application, its union type node, and its image loader.
 */
export function checkPair(poseGraph: Graph, depthGraph: Graph, seed: number): void {
  const copy: Graph = JSON.parse(JSON.stringify(depthGraph)) as Graph;
  const depthApply = Object.entries(copy).find(([, node]) => node.class_type === 'ControlNetApplyAdvanced' && copy[link(node.inputs.control_net) ?? '']?.inputs.type === 'depth');
  if (!depthApply) fail('E_WORKFLOW_PAIR', `Seed ${seed}: condition B has no depth control.`);
  const [applyId, apply] = depthApply;
  const typeId = link(apply.inputs.control_net) as string;
  const imageId = link(apply.inputs.image) ?? '';
  for (const node of Object.values(copy)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      if (link(value) === applyId) node.inputs[key] = key === 'positive' ? apply.inputs.positive : key === 'negative' ? apply.inputs.negative : value;
    }
  }
  const removed = new Set([applyId, typeId, imageId]);
  const rest: Graph = Object.fromEntries(Object.entries(copy).filter(([id]) => !removed.has(id)));
  for (const node of Object.values(rest))
    for (const value of Object.values(node.inputs)) if (removed.has(link(value) ?? '')) fail('E_WORKFLOW_PAIR', `Seed ${seed}: another node uses the depth nodes.`);
  if (comparable(rest) !== comparable(poseGraph)) fail('E_WORKFLOW_PAIR', `Seed ${seed}: conditions A and B differ in more than the depth control.`, 'Build the bundle again.');
}

export type LoadedBundle = {
  readonly root: string;
  readonly bundle: Bundle;
  readonly bundleSha256: string;
  readonly workflows: ReadonlyMap<string, Graph>;
  readonly controlImages: ReadonlyMap<string, Buffer>;
};

/** Reads bundle.json, checks the SHA-256 of each listed file, and checks the workflows. */
export function loadBundle(root: string, approved: readonly ApprovedModel[] = approvedModels): LoadedBundle {
  const raw = readBundleFile(root, 'bundle.json');
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    fail('E_BUNDLE', 'bundle.json is not valid JSON.');
  }
  const bundle = parseBundle(value, approved);
  const listed = new Map<string, Buffer>();
  for (const file of bundle.files) {
    const bytes = readBundleFile(root, file.path);
    if (sha256(bytes) !== file.sha256) fail('E_BUNDLE_INTEGRITY', `The SHA-256 of ${file.path} does not agree with bundle.json.`, 'The bundle was changed. Copy it again from the original build.');
    listed.set(file.path, bytes);
  }
  const need = (path: string): Buffer => listed.get(path) ?? fail('E_BUNDLE', `${path} is not in the file list of bundle.json.`);
  const workflows = new Map<string, Graph>();
  for (const run of bundle.runs) {
    let graph: unknown;
    try {
      graph = JSON.parse(need(run.workflow).toString('utf8'));
    } catch {
      fail('E_WORKFLOW', `The workflow of run ${run.id} is not valid JSON.`);
    }
    workflows.set(run.id, checkWorkflow(graph, run, bundle));
  }
  if (bundle.format === bundleFormatC2) {
    for (const seed of new Set(bundle.runs.map((run) => run.seed))) {
      const a = bundle.runs.find((run) => run.seed === seed && run.kind === 'pose') as BundleRun;
      const b = bundle.runs.find((run) => run.seed === seed && run.kind === 'pose-depth') as BundleRun;
      checkPair(workflows.get(a.id) as Graph, workflows.get(b.id) as Graph, seed);
    }
  }
  const controlImages = new Map<string, Buffer>();
  for (const control of bundle.controlImages) {
    const bytes = need(control.path);
    const size = pngSize(bytes);
    if (size.width !== bundle.image.width || size.height !== bundle.image.height) fail('E_BUNDLE', `The ${control.role} control image size does not agree with bundle.json.`);
    controlImages.set(control.uploadName, bytes);
  }
  return { root, bundle, bundleSha256: sha256(raw), workflows, controlImages };
}

/** Reads the width and height from the PNG header. */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  const signature = '89504e470d0a1a0a';
  if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== signature || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return fail('E_IMAGE', 'The file is not a PNG image.');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// ---------------------------------------------------------------- log and files

export type Logger = { readonly event: (event: string, data?: Record<string, unknown>) => void; readonly progress: (text: string) => void };

/** A JSON Lines log in the output directory plus short progress lines on stderr. */
export function fileLogger(path: string | null, quiet = false): Logger {
  return {
    event(event, data = {}) {
      if (path !== null) writeFileSync(path, `${JSON.stringify({ time: new Date().toISOString(), event, ...data })}\n`, { flag: 'a', mode: 0o600 });
    },
    progress(text) {
      if (!quiet) process.stderr.write(`${text}\n`);
    }
  };
}

/** Writes a file through a new temporary name and a rename. The target directory must be a real directory. */
export function writeAtomic(path: string, bytes: Uint8Array | string): void {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Makes or checks a real directory. A symbolic link is refused, unless followLinks is true: then the link target is used.
 * Runpod templates can link ComfyUI model folders to the volume disk, so the model folders follow links. The results directory does not.
 */
export function realDirectory(path: string, create: boolean, label: string, followLinks = false): string {
  const full = followLinks && existsSync(path) ? realpathSync(path) : resolve(path);
  let info;
  try {
    info = lstatSync(full);
  } catch {
    if (!create) return fail('E_PATH', `${label} ${full} does not exist.`, undefined, 2);
    mkdirSync(full, { recursive: true, mode: 0o700 });
    return full;
  }
  if (info.isSymbolicLink()) fail('E_PATH', `${label} ${full} is a symbolic link. Give the real directory.`, undefined, 2);
  if (!info.isDirectory()) fail('E_PATH', `${label} ${full} is not a directory.`, undefined, 2);
  return full;
}

// ---------------------------------------------------------------- models

export type FetchFunction = (url: string, init?: RequestInit) => Promise<Response>;

export type ModelStatus = { readonly id: string; readonly file: string; readonly path: string; readonly sha256: string | null; readonly state: 'verified' | 'downloaded' | 'missing' };

/** Checks one model file. An existing file must have the approved SHA-256. */
async function existingModel(model: ApprovedModel, path: string, log: Logger): Promise<ModelStatus | null> {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return null;
  }
  if (!info.isFile()) fail('E_MODEL_PATH', `${path} exists and is not a regular file.`, 'Remove it. The runner does not follow links for model files.');
  log.progress(`Checking SHA-256 of ${model.file} ...`);
  const actual = await fileSha256(path);
  log.event('model.hash', { id: model.id, file: model.file, sha256: actual, expected: model.sha256 });
  if (actual !== model.sha256)
    fail(
      'E_MODEL_HASH_MISMATCH',
      `${model.file} exists and its SHA-256 ${actual} is not the approved ${model.sha256}.`,
      'Do not load it. Remove the file and run the command again. The runner never replaces it.'
    );
  return { id: model.id, file: model.file, path, sha256: actual, state: 'verified' };
}

/** Downloads one approved model file to <file>.part, checks size and SHA-256, and renames it. */
export async function downloadModel(model: ApprovedModel, folder: string, log: Logger, fetchImpl: FetchFunction = fetch, url = modelUrl(model)): Promise<ModelStatus> {
  const target = join(folder, model.file);
  const partial = `${target}.part`;
  const free = statfsSync(folder);
  const available = Number(free.bavail) * Number(free.bsize);
  if (available < model.size + 1024 ** 3) fail('E_DISK_SPACE', `${folder} has ${available} free bytes. ${model.file} needs ${model.size} bytes plus 1 GiB.`, 'Give the Pod a larger volume disk.');
  rmSync(partial, { force: true });
  log.event('model.download.start', { id: model.id, file: model.file, url });
  log.progress(`Downloading ${model.file} (${(model.size / 1024 ** 3).toFixed(2)} GiB) from ${model.repository}@${model.revision.slice(0, 8)} ...`);
  const controller = new AbortController();
  let idle = setTimeout(() => {
    controller.abort();
  }, 120_000);
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
  } catch (error) {
    clearTimeout(idle);
    return fail('E_DOWNLOAD', `The download of ${model.file} failed: ${show(error instanceof Error ? error.message : error)}.`, 'Check the network of the Pod and run the command again.');
  }
  const finalUrl = new URL(response.url || url);
  const announced = Number(response.headers.get('content-length') ?? Number.NaN);
  const refusal =
    finalUrl.protocol !== 'https:'
      ? new RunnerError('E_DOWNLOAD', `The download of ${model.file} was redirected to a non-HTTPS address.`)
      : !response.ok || !response.body
        ? new RunnerError('E_DOWNLOAD', `The download of ${model.file} failed with HTTP ${response.status}.`, 'Check that the pinned revision is still available on Hugging Face.')
        : Number.isFinite(announced) && announced !== model.size
          ? new RunnerError('E_DOWNLOAD_SIZE', `The server announces ${announced} bytes for ${model.file}. The approved size is ${model.size}.`)
          : null;
  if (refusal) {
    clearTimeout(idle);
    controller.abort();
    throw refusal;
  }
  const hash = createHash('sha256');
  const fd = openSync(partial, 'wx', 0o600);
  let received = 0;
  let reported = 0;
  try {
    for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
      clearTimeout(idle);
      idle = setTimeout(() => {
        controller.abort();
      }, 120_000);
      received += part.length;
      if (received > model.size) fail('E_DOWNLOAD_SIZE', `${model.file} is larger than the approved ${model.size} bytes.`);
      hash.update(part);
      let offset = 0;
      while (offset < part.length) offset += writeSync(fd, part, offset, part.length - offset);
      if (received - reported >= model.size / 10) {
        reported = received;
        log.progress(`  ${Math.floor((received / model.size) * 100)} %`);
      }
    }
  } catch (error) {
    rmSync(partial, { force: true });
    if (error instanceof RunnerError) throw error;
    fail('E_DOWNLOAD', `The download of ${model.file} stopped: ${show(error instanceof Error ? error.message : error)}.`, 'Run the command again. The partial file was removed.');
  } finally {
    clearTimeout(idle);
    closeSync(fd);
  }
  const actual = hash.digest('hex');
  log.event('model.download.end', { id: model.id, file: model.file, bytes: received, sha256: actual, expected: model.sha256, host: finalUrl.host });
  if (received !== model.size || actual !== model.sha256) {
    rmSync(partial, { force: true });
    fail(
      'E_MODEL_HASH_MISMATCH',
      `The downloaded ${model.file} has ${received} bytes and SHA-256 ${actual}. The approved values are ${model.size} and ${model.sha256}.`,
      'The file was removed and not loaded.'
    );
  }
  if (existsSync(target)) {
    rmSync(partial, { force: true });
    fail('E_MODEL_PATH', `${target} appeared during the download.`, 'Make sure that only one runner is active.');
  }
  renameSync(partial, target);
  return { id: model.id, file: model.file, path: target, sha256: actual, state: 'downloaded' };
}

/** Makes sure that each approved model file is in place with the approved SHA-256. Downloads only missing files, and only when allowed. */
export async function ensureModels(
  modelsDir: string,
  models: readonly ApprovedModel[],
  log: Logger,
  options: { readonly download: boolean; readonly fetchImpl?: FetchFunction; readonly urlFor?: (model: ApprovedModel) => string }
): Promise<ModelStatus[]> {
  const root = realDirectory(modelsDir, false, 'The models directory', true);
  const result: ModelStatus[] = [];
  for (const model of models) {
    const folder = realDirectory(join(root, model.folder), false, `The ComfyUI ${model.folder} folder`, true);
    const path = join(folder, model.file);
    const existing = await existingModel(model, path, log);
    if (existing) {
      result.push(existing);
      continue;
    }
    if (!options.download) {
      result.push({ id: model.id, file: model.file, path, sha256: null, state: 'missing' });
      continue;
    }
    result.push(await downloadModel(model, folder, log, options.fetchImpl, options.urlFor ? options.urlFor(model) : modelUrl(model)));
  }
  return result;
}

// ---------------------------------------------------------------- ComfyUI

export type Comfy = { readonly base: string; readonly fetchImpl: FetchFunction };

export const comfyAt = (port: number, fetchImpl: FetchFunction = fetch): Comfy => ({ base: `http://${comfyHost}:${port}`, fetchImpl });

async function comfyRequest(comfy: Comfy, path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  try {
    return await comfy.fetchImpl(`${comfy.base}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return fail(
      'E_COMFYUI_UNREACHABLE',
      `ComfyUI at ${comfy.base} does not answer (${show(error instanceof Error ? error.message : error)}).`,
      'Start ComfyUI on the Pod, wait until it is ready, and check the port.'
    );
  }
}

async function comfyJson(comfy: Comfy, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await comfyRequest(comfy, path, init);
  const text = await response.text();
  if (!response.ok) fail('E_COMFYUI_HTTP', `ComfyUI ${path.split('?')[0]} returned HTTP ${response.status}: ${show(text)}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail('E_COMFYUI_HTTP', `ComfyUI ${path.split('?')[0]} did not return JSON.`);
  }
}

async function comfyBytes(comfy: Comfy, path: string, maxBytes: number): Promise<Buffer> {
  const response = await comfyRequest(comfy, path, {}, 120_000);
  if (!response.ok) fail('E_COMFYUI_HTTP', `ComfyUI ${path.split('?')[0]} returned HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) fail('E_IMAGE', `ComfyUI returned more than ${maxBytes} bytes.`);
  return bytes;
}

export type ComfyInfo = { readonly comfyuiVersion: string | null; readonly pythonVersion: string | null; readonly pytorchVersion: string | null; readonly devices: readonly Record<string, unknown>[] };

/** Reads /system_stats: versions and GPU devices for the provenance record. */
export async function comfyInfo(comfy: Comfy): Promise<ComfyInfo> {
  const stats = await comfyJson(comfy, '/system_stats');
  const system = isRecord(stats) && isRecord(stats.system) ? stats.system : {};
  const text = (value: unknown): string | null => (typeof value === 'string' ? show(value) : null);
  const devices = isRecord(stats) && Array.isArray(stats.devices) ? stats.devices.filter(isRecord) : [];
  return {
    comfyuiVersion: text(system.comfyui_version),
    pythonVersion: text(system.python_version),
    pytorchVersion: text(system.pytorch_version),
    devices: devices.map((device) => ({ name: text(device.name), type: text(device.type), vramTotal: typeof device.vram_total === 'number' ? device.vram_total : null }))
  };
}

export type NodeSpec = { readonly required: Record<string, unknown>; readonly optional: Record<string, unknown> };

/** The input lists of one node type from /object_info. */
export function nodeSpec(value: unknown): NodeSpec {
  const input = isRecord(value) && isRecord(value.input) ? value.input : {};
  return { required: isRecord(input.required) ? input.required : {}, optional: isRecord(input.optional) ? input.optional : {} };
}

/** The choices of a combo input in both /object_info forms: [[choices], options] and ["COMBO", { options: [choices] }]. Null when it is not a combo. */
export function comboChoices(spec: unknown): unknown[] | null {
  if (!Array.isArray(spec)) return null;
  if (Array.isArray(spec[0])) return spec[0] as unknown[];
  if (spec[0] === 'COMBO' && isRecord(spec[1]) && Array.isArray(spec[1].options)) return spec[1].options as unknown[];
  return null;
}

/** Inputs whose fixed value must be one of the choices that ComfyUI lists. Model and image names are checked elsewhere. */
const checkedCombos: Readonly<Record<string, readonly string[]>> = { KSampler: ['sampler_name', 'scheduler'], SetUnionControlNetType: ['type'] };

/** Each graph input must be a known input of its node type, each required input must be given, and fixed combo values must be listed. */
export function checkGraphInputs(graph: Graph, specs: ReadonlyMap<string, NodeSpec>, runId: string): void {
  for (const [id, node] of Object.entries(graph)) {
    const spec = specs.get(node.class_type);
    if (!spec) fail('E_COMFYUI_NODE', `ComfyUI gave no input list for ${node.class_type}.`);
    for (const key of Object.keys(node.inputs))
      if (!(key in spec.required) && !(key in spec.optional))
        fail(
          'E_COMFYUI_INPUT',
          `Run ${runId}: node ${id} (${node.class_type}) has the input ${show(key)}, which this ComfyUI does not know.`,
          'The workflow does not fit this ComfyUI version. Nothing was generated.'
        );
    for (const key of Object.keys(spec.required))
      if (!(key in node.inputs))
        fail(
          'E_COMFYUI_INPUT',
          `Run ${runId}: node ${id} (${node.class_type}) has no value for the required input ${show(key)}.`,
          'The workflow does not fit this ComfyUI version. Nothing was generated.'
        );
    for (const key of checkedCombos[node.class_type] ?? []) {
      const choices = comboChoices(spec.required[key] ?? spec.optional[key]);
      if (!choices || !choices.includes(node.inputs[key]))
        fail('E_COMFYUI_CHOICE', `Run ${runId}: ${node.class_type} does not offer ${key} = ${show(node.inputs[key])} in this ComfyUI.`, 'Nothing was generated. Report the ComfyUI version.');
    }
  }
}

/** Checks that ComfyUI has every node type of the workflows, and, after the models are in place, that it lists the approved files. */
export async function checkComfyNodes(comfy: Comfy, loaded: LoadedBundle, modelsVisible: boolean): Promise<void> {
  const types = new Set<string>();
  for (const graph of loaded.workflows.values()) for (const node of Object.values(graph)) types.add(node.class_type);
  const specs = new Map<string, NodeSpec>();
  for (const type of [...types].sort()) {
    const info = await comfyJson(comfy, `/object_info/${encodeURIComponent(type)}`);
    if (!isRecord(info) || !isRecord(info[type])) fail('E_COMFYUI_NODE', `ComfyUI has no node type ${type}.`, 'Use a current ComfyUI version. Do not install custom nodes for this experiment.');
    specs.set(type, nodeSpec(info[type]));
  }
  // Do not assume that the graphs fit this ComfyUI version: check the input names and the fixed choices before any generation.
  for (const [runId, graph] of loaded.workflows) checkGraphInputs(graph, specs, runId);
  if (!modelsVisible) return;
  for (const [type, input, model] of [
    ['CheckpointLoaderSimple', 'ckpt_name', loaded.bundle.models.find((item) => item.folder === 'checkpoints')],
    ['ControlNetLoader', 'control_net_name', loaded.bundle.models.find((item) => item.folder === 'controlnet')]
  ] as const) {
    const info = await comfyJson(comfy, `/object_info/${type}`);
    const required = isRecord(info) && isRecord(info[type]) && isRecord(info[type].input) && isRecord(info[type].input.required) ? info[type].input.required : {};
    const choices = comboChoices(required[input]) ?? [];
    if (!model || !choices.includes(model.file))
      fail('E_COMFYUI_MODEL_NOT_VISIBLE', `ComfyUI does not list ${model?.file ?? 'the model'} for ${type}.`, 'Give --models-dir as the models folder that this ComfyUI uses.');
  }
}

/** Uploads each control image under its fixed name and reads it back to check the bytes. */
export async function uploadControlImages(comfy: Comfy, loaded: LoadedBundle, log: Logger): Promise<void> {
  for (const [name, bytes] of loaded.controlImages) {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), name);
    form.append('type', 'input');
    form.append('overwrite', 'true');
    const answer = await comfyJson(comfy, '/upload/image', { method: 'POST', body: form });
    if (!isRecord(answer) || answer.name !== name || (answer.subfolder !== undefined && answer.subfolder !== ''))
      fail('E_COMFYUI_UPLOAD', `ComfyUI stored the control image as ${show(isRecord(answer) ? answer.name : answer)}, not ${name}.`);
    const back = await comfyBytes(comfy, `/view?${new URLSearchParams({ filename: name, type: 'input', subfolder: '' }).toString()}`, 16 * 1024 * 1024);
    if (sha256(back) !== sha256(bytes)) fail('E_COMFYUI_UPLOAD', `The control image ${name} in ComfyUI is not the same as the bundle file.`);
    log.event('control.uploaded', { name, sha256: sha256(back) });
  }
}

// ---------------------------------------------------------------- state and runs

export type RunState = {
  promptId?: string;
  clientId?: string;
  /** Written before POST /prompt. With no promptId, the submission state is unknown: the runner never submits the run again by itself. */
  submissionStartedAt?: string;
  submittedAt?: string;
  finishedAt?: string;
  output?: { file: string; sha256: string; bytes: number; width: number; height: number; comfyFilename: string };
};
export type State = { format: string; bundleSha256: string; runs: Record<string, RunState> };

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return fail('E_STATE', `${path} is not valid JSON.`, 'Move the results directory away and run again.');
  }
}

export function readState(out: string, bundleSha256: string): State {
  const value = readJsonFile(join(out, 'state.json'));
  if (value === undefined) return { format: 'aigg.exp-c-state/0.1', bundleSha256, runs: {} };
  if (!isRecord(value) || !isRecord(value.runs) || typeof value.bundleSha256 !== 'string') return fail('E_STATE', 'state.json is not valid.');
  if (value.bundleSha256 !== bundleSha256) fail('E_STATE_BUNDLE', 'The results directory belongs to another bundle.', 'Give a new --out directory for this bundle. Keep the old results.', 2);
  return value as unknown as State;
}

const saveState = (out: string, state: State): void => {
  writeAtomic(join(out, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
};

type History = { status: string; messages: string[]; images: Record<string, unknown>[] } | null;

async function readHistory(comfy: Comfy, promptId: string, saveNode: string): Promise<History> {
  const value = await comfyJson(comfy, `/history/${encodeURIComponent(promptId)}`);
  if (!isRecord(value) || !isRecord(value[promptId])) return null;
  const entry = value[promptId];
  const status = isRecord(entry.status) ? entry.status : {};
  const messages: string[] = [];
  if (Array.isArray(status.messages))
    for (const message of status.messages) {
      if (Array.isArray(message) && message[0] === 'execution_error' && isRecord(message[1])) messages.push(`${show(message[1].node_type)}: ${show(message[1].exception_message)}`);
    }
  const outputs = isRecord(entry.outputs) && isRecord(entry.outputs[saveNode]) ? entry.outputs[saveNode] : {};
  const images = Array.isArray(outputs.images) ? outputs.images.filter(isRecord) : [];
  const done = status.completed === true || status.status_str === 'success';
  const text = status.status_str === 'error' ? 'error' : done ? 'success' : 'running';
  return { status: text, messages, images };
}

async function inQueue(comfy: Comfy, promptId: string): Promise<boolean> {
  const value = await comfyJson(comfy, '/queue');
  if (!isRecord(value)) return false;
  for (const key of ['queue_running', 'queue_pending']) {
    const list = value[key];
    if (Array.isArray(list) && list.some((item) => Array.isArray(item) && item[1] === promptId)) return true;
  }
  return false;
}

/** The prompt was possibly queued, but its id is unknown. The runner does not guess and does not submit again. */
function ambiguousSubmission(run: BundleRun, runState: RunState, comfy: Comfy): never {
  return fail(
    'E_SUBMISSION_AMBIGUOUS',
    `Run ${run.id} was possibly submitted at ${show(runState.submissionStartedAt)} (client_id ${show(runState.clientId)}), but the runner did not get a prompt id.`,
    `Do a manual check on the Pod: curl -s ${comfy.base}/queue and curl -s '${comfy.base}/history?max_items=20', and look for client_id ${show(runState.clientId)}. ` +
      'The runner does not submit this run again. A new run is the decision of the owner: move the results directory away and run again.'
  );
}

export type RunOptions = {
  readonly comfy: Comfy;
  readonly out: string;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly log: Logger;
};

/** Runs one workflow: submits it once (or resumes the recorded prompt), waits, downloads the one image, and records its SHA-256. */
export async function runOne(loaded: LoadedBundle, run: BundleRun, state: State, options: RunOptions): Promise<NonNullable<RunState['output']>> {
  const { comfy, out, log } = options;
  const runState: RunState = (state.runs[run.id] ??= {});
  const target = join(out, `${run.id}.png`);
  if (runState.output) {
    const bytes = existsSync(target) ? readFileSync(target) : null;
    if (bytes && sha256(bytes) === runState.output.sha256) {
      log.progress(`Run ${run.id}: already done (${runState.output.sha256}).`);
      return runState.output;
    }
    fail('E_RESULT_CHANGED', `${target} is missing or changed after the run.`, 'Move the results directory away. A new run is a new decision of the owner.');
  }
  if (runState.promptId) {
    log.progress(`Run ${run.id}: resuming prompt ${runState.promptId}.`);
    const history = await readHistory(comfy, runState.promptId, run.saveNode);
    if (!history && !(await inQueue(comfy, runState.promptId)))
      fail(
        'E_PROMPT_LOST',
        `ComfyUI no longer knows prompt ${runState.promptId} of run ${run.id}.`,
        'The runner does not submit it again by itself. Move the results directory away to start a new run.'
      );
  } else if (runState.submissionStartedAt) {
    ambiguousSubmission(run, runState, comfy);
  } else {
    // Record the intent before the request. If the answer is lost, a repeat run must not submit a second prompt.
    const clientId = randomUUID();
    runState.clientId = clientId;
    runState.submissionStartedAt = new Date().toISOString();
    saveState(out, state);
    log.event('run.submitting', { run: run.id, clientId, seed: run.seed });
    const workflow = loaded.workflows.get(run.id);
    let answer: Response;
    let text: string;
    try {
      answer = await comfy.fetchImpl(`${comfy.base}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000)
      });
      text = await answer.text();
    } catch (error) {
      log.event('run.submission_ambiguous', { run: run.id, clientId, message: show(error instanceof Error ? error.message : error) });
      return ambiguousSubmission(run, runState, comfy);
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      value = null;
    }
    const promptId = isRecord(value) && typeof value.prompt_id === 'string' ? value.prompt_id : null;
    if (!answer.ok || promptId === null) {
      // ComfyUI validates a prompt before it queues it and answers HTTP 4xx when it refuses it. Only then is the intent removed.
      // Any other answer without a prompt id leaves the intent, so a repeat run stops with E_SUBMISSION_AMBIGUOUS.
      if (answer.status >= 400 && answer.status < 500) {
        delete runState.submissionStartedAt;
        delete runState.clientId;
        saveState(out, state);
      }
      fail('E_PROMPT_REJECTED', `ComfyUI rejected run ${run.id} (HTTP ${answer.status}): ${show(isRecord(value) ? (value.node_errors ?? value.error) : text)}`);
    }
    runState.promptId = promptId;
    runState.submittedAt = new Date().toISOString();
    saveState(out, state);
    log.event('run.submitted', { run: run.id, promptId: runState.promptId, seed: run.seed });
    log.progress(`Run ${run.id}: submitted as prompt ${runState.promptId}.`);
  }
  const promptId = runState.promptId;
  const deadline = Date.now() + options.timeoutMs;
  let history = await readHistory(comfy, promptId, run.saveNode);
  while (!history || history.status === 'running') {
    if (Date.now() > deadline)
      fail(
        'E_TIMEOUT',
        `Run ${run.id} did not finish in ${Math.round(options.timeoutMs / 60000)} minutes.`,
        'Check ComfyUI. Run the same command again later: it waits for the same prompt and does not submit a new one.',
        3
      );
    await new Promise((done) => setTimeout(done, options.pollMs));
    history = await readHistory(comfy, promptId, run.saveNode);
  }
  if (history.status === 'error') {
    log.event('run.failed', { run: run.id, promptId, messages: history.messages });
    fail('E_GENERATION_FAILED', `ComfyUI reports an error for run ${run.id}: ${history.messages.join('; ') || 'no message'}.`);
  }
  const images = history.images.filter((image) => image.type === 'output');
  if (images.length !== 1) fail('E_GENERATION_OUTPUT', `Run ${run.id} gave ${images.length} output images. Exactly one is expected.`);
  const image = images[0] as Record<string, unknown>;
  const filename = typeof image.filename === 'string' ? image.filename : '';
  const subfolder = typeof image.subfolder === 'string' ? image.subfolder : '';
  const bytes = await comfyBytes(comfy, `/view?${new URLSearchParams({ filename, subfolder, type: 'output' }).toString()}`, 64 * 1024 * 1024);
  const size = pngSize(bytes);
  if (size.width !== loaded.bundle.image.width || size.height !== loaded.bundle.image.height)
    fail('E_GENERATION_OUTPUT', `Run ${run.id} gave a ${size.width}x${size.height} image. ${loaded.bundle.image.width}x${loaded.bundle.image.height} is expected.`);
  if (existsSync(target)) fail('E_RESULT_CHANGED', `${target} exists, but state.json has no result for it.`, 'Move the results directory away.');
  writeAtomic(target, bytes);
  const digest = sha256(bytes);
  if (sha256(readFileSync(target)) !== digest) fail('E_RESULT_WRITE', `${target} does not read back with the same SHA-256.`);
  runState.output = { file: `${run.id}.png`, sha256: digest, bytes: bytes.length, width: size.width, height: size.height, comfyFilename: show(filename) };
  runState.finishedAt = new Date().toISOString();
  saveState(out, state);
  log.event('run.saved', { run: run.id, promptId, file: runState.output.file, sha256: digest });
  log.progress(`Run ${run.id}: saved ${runState.output.file} (${digest}).`);
  return runState.output;
}

// ---------------------------------------------------------------- commands

export type ExecuteOptions = {
  readonly command: 'check' | 'models' | 'run' | 'all';
  readonly bundleRoot: string;
  readonly modelsDir: string | undefined;
  readonly out: string;
  readonly port: number;
  readonly timeoutMs: number;
  readonly pollMs?: number;
  readonly quiet?: boolean;
  readonly approved?: readonly ApprovedModel[];
  readonly fetchImpl?: FetchFunction;
  readonly urlFor?: (model: ApprovedModel) => string;
};

export type Report = Record<string, unknown> & { status: 'PASS' | 'FAIL' | 'INCOMPLETE' };

function acquireLock(out: string): () => void {
  const path = join(out, '.lock');
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch {
    return fail('E_LOCKED', `${path} exists. Another runner is active, or a runner stopped without cleanup.`, 'If no runner is active, remove the .lock file and run again.', 2);
  }
  writeSync(fd, `${process.pid}\n`);
  closeSync(fd);
  // On Ctrl+C or a terminate signal, remove the lock and stop. state.json already has each submitted prompt id.
  const stop = (signal: NodeJS.Signals): void => {
    rmSync(path, { force: true });
    process.stderr.write(`Stopped by ${signal}. Run the same command again to continue; it does not submit a recorded prompt again.\n`);
    process.exit(130);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return () => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    rmSync(path, { force: true });
  };
}

/** The commands. check: no writes outside --out, no downloads, no generation. models: downloads missing approved files. run: generates. all: models + run. */
export async function execute(options: ExecuteOptions): Promise<Report> {
  const approved = options.approved ?? approvedModels;
  const loaded = loadBundle(options.bundleRoot, approved);
  const writes = options.command !== 'check';
  const out = writes ? realDirectory(options.out, true, 'The results directory') : resolve(options.out);
  const finalResult = join(out, 'result.json');
  const previous = writes ? readJsonFile(finalResult) : undefined;
  if ((options.command === 'run' || options.command === 'all') && isRecord(previous) && previous.status === 'PASS') {
    if (previous.bundleSha256 !== loaded.bundleSha256) fail('E_STATE_BUNDLE', 'The results directory belongs to another bundle.', 'Give a new --out directory.', 2);
    // Do not trust result.json alone: read the images and SHA256SUMS again. A changed result is FAIL, never a new generation.
    const problems = resultProblems(
      out,
      previous,
      loaded.bundle.runs.map((run) => run.id)
    );
    if (problems.length > 0)
      fail(
        'E_RESULT_CHANGED',
        `The saved results do not agree with result.json: ${problems.join('; ')}.`,
        'Nothing was run again. Move the results directory away. A new run is a new decision of the owner.'
      );
    return { ...(previous as Report), note: 'The results exist already and agree with result.json and SHA256SUMS. Nothing was run again.' };
  }
  const release = writes ? acquireLock(out) : () => undefined;
  const log = fileLogger(writes ? join(out, 'run.log') : null, options.quiet);
  try {
    log.event('start', { command: options.command, bundleSha256: loaded.bundleSha256, node: process.version, port: options.port });
    const comfy = comfyAt(options.port, options.fetchImpl);
    const info = await comfyInfo(comfy);
    log.event('comfyui', info);
    log.progress(`ComfyUI ${info.comfyuiVersion ?? '(version unknown)'} on ${info.devices.map((device) => device.name).join(', ') || 'unknown device'}.`);
    await checkComfyNodes(comfy, loaded, false);
    const modelsDir = options.modelsDir ?? fail('E_USAGE', '--models-dir is necessary.', 'Give the models folder of ComfyUI, for example /workspace/ComfyUI/models.', 2);
    const download = options.command === 'models' || options.command === 'all';
    const models = await ensureModels(modelsDir, approved, log, {
      download,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.urlFor ? { urlFor: options.urlFor } : {})
    });
    const missing = models.filter((model) => model.state === 'missing');
    const base = { format: resultFormat, bundleSha256: loaded.bundleSha256, experiment: loaded.bundle.experiment, node: process.version, comfyui: info, models };
    if (missing.length > 0) {
      if (options.command === 'run') fail('E_MODEL_MISSING', `Missing model files: ${missing.map((model) => model.file).join(', ')}.`, 'Run the models command (or the default all command) first.');
      return { status: 'INCOMPLETE', command: options.command, ...base, note: 'Model files are missing. The check did not download them.' };
    }
    await checkComfyNodes(comfy, loaded, true);
    if (options.command === 'check' || options.command === 'models') return { status: 'PASS', command: options.command, ...base };

    const state = readState(out, loaded.bundleSha256);
    saveState(out, state);
    const startedAt = new Date().toISOString();
    if (loaded.bundle.runs.some((run) => !state.runs[run.id]?.promptId && !state.runs[run.id]?.submissionStartedAt)) await uploadControlImages(comfy, loaded, log);
    const runs = [];
    for (const run of loaded.bundle.runs) {
      const output = await runOne(loaded, run, state, { comfy, out, timeoutMs: options.timeoutMs, pollMs: options.pollMs ?? 2000, log });
      runs.push({ id: run.id, kind: run.kind, seed: run.seed, workflow: run.workflow, promptId: state.runs[run.id]?.promptId, ...output });
    }
    const sums = runs.map((run) => `${run.sha256}  ${run.file}\n`).join('');
    writeAtomic(join(out, 'SHA256SUMS'), sums);
    for (const run of runs) if (sha256(readFileSync(join(out, run.file))) !== run.sha256) fail('E_RESULT_WRITE', `${run.file} does not read back with the recorded SHA-256.`);
    if (readFileSync(join(out, 'SHA256SUMS'), 'utf8') !== sums) fail('E_RESULT_WRITE', 'SHA256SUMS does not read back correctly.');
    const report: Report = { status: 'PASS', command: options.command, ...base, startedAt, finishedAt: new Date().toISOString(), runs };
    writeAtomic(finalResult, `${JSON.stringify(report, null, 2)}\n`);
    log.event('finish', { status: 'PASS' });
    return report;
  } catch (error) {
    log.event('error', error instanceof RunnerError ? { code: error.code, message: error.message } : { code: 'E_UNEXPECTED', message: show(error instanceof Error ? error.message : error) });
    throw error;
  } finally {
    release();
  }
}

/** Compares the images and SHA256SUMS with a PASS result.json. Returns the problems; an empty list means that all agree. */
function resultProblems(out: string, result: Record<string, unknown>, ids: readonly string[]): string[] {
  const problems: string[] = [];
  const runs = Array.isArray(result.runs) ? result.runs.filter(isRecord) : [];
  const lines: string[] = [];
  if (runs.length !== ids.length) problems.push(`result.json lists ${runs.length} runs, ${ids.length} are expected`);
  for (const id of ids) {
    const entry = runs.find((run) => run.id === id);
    const file = `${id}.png`;
    if (!entry || entry.file !== file || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      problems.push(`result.json has no valid entry for ${file}`);
      continue;
    }
    lines.push(`${entry.sha256}  ${file}\n`);
    const path = join(out, file);
    if (!existsSync(path)) problems.push(`${file} is missing`);
    else if (sha256(readFileSync(path)) !== entry.sha256) problems.push(`${file} has another SHA-256`);
  }
  const sumsPath = join(out, 'SHA256SUMS');
  if (!existsSync(sumsPath)) problems.push('SHA256SUMS is missing');
  else if (readFileSync(sumsPath, 'utf8') !== lines.join('')) problems.push('SHA256SUMS does not agree with result.json');
  return problems;
}

/** status: reads the results directory only. The required runs come from the checked bundle, never from result.json. */
export function status(out: string, bundleRoot: string, approved: readonly ApprovedModel[] = approvedModels): Report {
  const loaded = loadBundle(bundleRoot, approved);
  const full = resolve(out);
  const result = readJsonFile(join(full, 'result.json'));
  if (isRecord(result) && result.status === 'PASS') {
    const runs = Array.isArray(result.runs) ? result.runs.filter(isRecord) : [];
    const problems = resultProblems(
      full,
      result,
      loaded.bundle.runs.map((run) => run.id)
    );
    if (result.bundleSha256 !== loaded.bundleSha256) problems.unshift('result.json belongs to another bundle');
    const ok = problems.length === 0;
    return { status: ok ? 'PASS' : 'FAIL', command: 'status', results: full, runs: runs.map((run) => ({ id: run.id, file: run.file, sha256: run.sha256 })), ...(ok ? {} : { problems }) };
  }
  const state = readJsonFile(join(full, 'state.json'));
  const runs = isRecord(state) && isRecord(state.runs) ? state.runs : {};
  return {
    status: 'INCOMPLETE',
    command: 'status',
    results: full,
    locked: existsSync(join(full, '.lock')),
    runs: Object.entries(runs).map(([id, run]) => ({
      id,
      promptId: isRecord(run) ? (run.promptId ?? null) : null,
      submissionAmbiguous: isRecord(run) && run.promptId === undefined && run.submissionStartedAt !== undefined,
      saved: isRecord(run) && isRecord(run.output)
    }))
  };
}

// ---------------------------------------------------------------- CLI

const help = `Usage: sh run.sh [all|check|models|run|status] --models-dir <ComfyUI models folder> [options]

Commands:
  all      (default) check, download the missing approved models, run the two workflows once, save the results
  check    check the bundle, ComfyUI, the node types, and the model files. No download, no generation.
  models   check, then download the missing approved model files only
  run      check, then run the two workflows once (the models must be in place)
  status   print the state of the results directory

Options:
  --models-dir <dir>      the ComfyUI models folder (it contains checkpoints/ and controlnet/)
  --out <dir>             the results directory (default: results/ in the bundle)
  --port <n>              the local ComfyUI port on 127.0.0.1 (default 8188)
  --timeout-minutes <n>   the wait for one generation (default 20)
  --help                  print this text

Output: one JSON report on stdout, progress on stderr, the log in <out>/run.log.
Exit status: 0 PASS, 1 FAIL, 2 usage or input error, 3 INCOMPLETE.
`;

function versionAtLeast(actual: string, minimum: string): boolean {
  const a = actual.replace(/^v/, '').split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return true;
}

export async function main(argv: readonly string[], bundleRoot: string): Promise<number> {
  const print = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  };
  try {
    if (!versionAtLeast(process.version, minimumNode)) fail('E_NODE_VERSION', `Node.js ${minimumNode} or later is necessary. This is ${process.version}.`, 'See README.md.', 2);
    let parsed;
    try {
      parsed = parseArgs({
        args: [...argv],
        allowPositionals: true,
        strict: true,
        options: { 'models-dir': { type: 'string' }, out: { type: 'string' }, port: { type: 'string' }, 'timeout-minutes': { type: 'string' }, help: { type: 'boolean' } }
      });
    } catch (error) {
      return fail('E_USAGE', error instanceof Error ? error.message : 'The options are not valid.', 'Run sh run.sh --help.', 2);
    }
    const { values, positionals } = parsed;
    if (values.help) {
      process.stdout.write(help);
      return 0;
    }
    if (positionals.length > 1) fail('E_USAGE', 'Give at most one command.', 'Run sh run.sh --help.', 2);
    const command = positionals[0] ?? 'all';
    const out = values.out ?? join(bundleRoot, 'results');
    if (command === 'status') {
      const report = status(out, bundleRoot);
      print(report);
      return report.status === 'PASS' ? 0 : report.status === 'INCOMPLETE' ? 3 : 1;
    }
    if (command !== 'all' && command !== 'check' && command !== 'models' && command !== 'run') return fail('E_USAGE', `Unknown command ${show(command)}.`, 'Run sh run.sh --help.', 2);
    const port = Number(values.port ?? '8188');
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail('E_USAGE', '--port must be a port number.', undefined, 2);
    const minutes = Number(values['timeout-minutes'] ?? '20');
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 180) fail('E_USAGE', '--timeout-minutes must be an integer from 1 to 180.', undefined, 2);
    const report = await execute({ command, bundleRoot, modelsDir: values['models-dir'], out, port, timeoutMs: minutes * 60_000 });
    print(report);
    if (report.status === 'PASS') process.stderr.write(command === 'all' || command === 'run' ? `PASS. Results and SHA256SUMS are in ${out}.\n` : 'PASS.\n');
    return report.status === 'PASS' ? 0 : report.status === 'INCOMPLETE' ? 3 : 1;
  } catch (error) {
    if (error instanceof RunnerError) {
      print({ status: 'ERROR', code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) });
      process.stderr.write(`${error.code}: ${error.message}${error.hint ? `\n${error.hint}` : ''}\n`);
      return error.exitCode;
    }
    print({ status: 'ERROR', code: 'E_UNEXPECTED', message: show(error instanceof Error ? error.message : error) });
    return 2;
  }
}

// Run only as the entry file (runner.mjs in the bundle), not when a test or another module imports this file.
const realOrEmpty = (path: string | undefined): string => {
  try {
    return path === undefined ? '' : realpathSync(path);
  } catch {
    return '';
  }
};
const self = fileURLToPath(import.meta.url);
if (realOrEmpty(process.argv[1]) === realOrEmpty(self)) {
  void main(process.argv.slice(2), dirname(self)).then((code) => {
    process.exitCode = code;
  });
}
