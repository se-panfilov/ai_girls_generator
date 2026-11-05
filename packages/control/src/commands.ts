import { type ControlContract, parseControlContract, type Size } from '@control/contract';
import { measure, type Measurement, parseMarks } from '@control/measure';
import type { PlannedFile } from '@control/output';
import { decodePng, encodePng, pixelHash, sha256 } from '@control/png';
import { fitTransform, type Keypoint, type KeypointName, openPoseJson, poseLineRatio, renderOpenPose, type RigPose, rigPose, round, type SideMapping, toTarget, type Transform } from '@control/pose';
import { fail, type Problem } from '@control/problems';
import { type Color, Raster } from '@control/raster';
import { drawSkeletonOverlay, referenceSvg, renderReference } from '@control/reference';
import { baselineWorkflow, c0Defaults, c0Prompt, type GenerationSettings, poseWorkflow, unionControlType } from '@control/workflow';

export const toolName = '@aigg/control';
export const maxContractBytes = 1024 * 1024;

export type FileRecord = { readonly name: string; readonly sha256: string; readonly pixelSha256?: string };
export type CommandResult = { readonly report: Record<string, unknown>; readonly files: readonly PlannedFile[] };

const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

function record(file: PlannedFile, raster?: Raster): FileRecord {
  return raster ? { name: file.name, sha256: sha256(file.bytes), pixelSha256: pixelHash(raster) } : { name: file.name, sha256: sha256(file.bytes) };
}

export function parseContractBytes(bytes: Buffer): ControlContract {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('E_CONTRACT_JSON', 'The rig contract is not valid JSON.');
  }
  return parseControlContract(value);
}

/** Parses WxH. Without a value, the contract generation resolution is used. */
export function parseSize(text: string | undefined, contract: ControlContract): Size {
  if (text === undefined) return contract.generationResolution;
  const match = /^([1-9]\d{1,4})x([1-9]\d{1,4})$/.exec(text);
  if (!match) fail('E_USAGE', '--size must be WIDTHxHEIGHT, for example 832x1216.');
  const size = { width: Number(match[1]), height: Number(match[2]) };
  if (size.width > 4096 || size.height > 4096) fail('E_USAGE', '--size must be at most 4096x4096.');
  return size;
}

function keypointReport(pose: RigPose, transform: Transform): Record<string, unknown>[] {
  return pose.keypoints.map((item) => ({
    name: item.name,
    source: item.source,
    contract: item.point ? { x: round(item.point.x), y: round(item.point.y) } : null,
    target: item.point ? (({ x, y }) => ({ x: round(x), y: round(y) }))(toTarget(item.point, transform)) : null
  }));
}

function contractReport(contract: ControlContract, bytes: Buffer): Record<string, unknown> {
  return { rigId: contract.rigId, contractVersion: contract.contractVersion, sha256: sha256(bytes), view: contract.view, sideNaming: contract.sideNaming, canvas: contract.canvas };
}

/** `pose`: OpenPose images and JSON for each side mapping, the proportion reference (PNG and SVG), and control.json. */
export function poseCommand(contractBytes: Buffer, sizeText: string | undefined, mappings: readonly SideMapping[]): CommandResult {
  const contract = parseContractBytes(contractBytes);
  const size = parseSize(sizeText, contract);
  const transform = fitTransform(contract.canvas, size);
  const files: PlannedFile[] = [];
  const records: FileRecord[] = [];
  const poses: Record<string, unknown>[] = [];
  const warnings = new Map<string, Problem>();
  const notes: string[] = [];
  if (size.width % 64 !== 0 || size.height % 64 !== 0) notes.push(`The size ${size.width}x${size.height} is not a multiple of 64. SDXL models are trained on 64-pixel buckets.`);
  if (transform.offsetX !== 0 || transform.offsetY !== 0)
    notes.push(`The contract canvas is scaled by ${round(transform.scale)} and centered with offsets ${round(transform.offsetX)}, ${round(transform.offsetY)} px. The proportions do not change.`);
  let referencePose: RigPose | undefined;
  for (const mapping of mappings) {
    const pose = rigPose(contract, mapping);
    referencePose ??= pose;
    for (const warning of pose.warnings) warnings.set(warning.code, warning);
    const raster = renderOpenPose(pose.keypoints, size, transform);
    const png: PlannedFile = { name: `openpose-${mapping}.png`, bytes: encodePng(raster) };
    const keypoints: PlannedFile = { name: `openpose-${mapping}.json`, bytes: json(openPoseJson(pose.keypoints, size, transform)) };
    files.push(png, keypoints);
    records.push(record(png, raster), record(keypoints));
    poses.push({ mapping, image: png.name, keypointsFile: keypoints.name, warnings: pose.warnings.map((item) => item.code), keypoints: keypointReport(pose, transform) });
  }
  if (!referencePose) fail('E_USAGE', 'Give at least one side mapping.');
  const referenceRaster = renderReference(contract, referencePose, size, transform);
  const referencePng: PlannedFile = { name: 'reference.png', bytes: encodePng(referenceRaster) };
  const referenceText: PlannedFile = { name: 'reference.svg', bytes: Buffer.from(referenceSvg(contract, referencePose), 'utf8') };
  files.push(referencePng, referenceText);
  records.push(record(referencePng, referenceRaster), record(referenceText));
  const control = {
    format: 'aigg.control/0.1',
    tool: toolName,
    contract: contractReport(contract, contractBytes),
    target: { size, transform: { scale: round(transform.scale), offsetX: round(transform.offsetX), offsetY: round(transform.offsetY) } },
    openPose: { keypointSet: 'BODY_18 (COCO order)', lineRatio: poseLineRatio(size), limbHalfWidth: 4 * poseLineRatio(size), jointRadius: 4 * poseLineRatio(size), background: 'black' },
    bodyHeight: { px: referencePose.bodyHeight, source: referencePose.bodyHeightSource },
    poses,
    warnings: [...warnings.values()],
    notes,
    files: records
  };
  const controlFile: PlannedFile = { name: 'control.json', bytes: json(control) };
  files.push(controlFile);
  return { report: { status: 'PASS', command: 'pose', ...control, files: [...records, record(controlFile)] }, files };
}

export type WorkflowOptions = {
  readonly checkpoint: string;
  readonly controlNet: string;
  readonly checkpointSha256?: string;
  readonly controlNetSha256?: string;
  readonly seeds: readonly number[];
  readonly baselineSeed?: number;
  readonly poseImageName: string;
  readonly poseImageBytes: Buffer;
};

/** `workflow`: ComfyUI API graphs for one baseline and up to three pose-guided runs, and run-plan.json. No network access. */
export function workflowCommand(options: WorkflowOptions): CommandResult {
  if (options.seeds.length < 1 || options.seeds.length > 3) fail('E_USAGE', 'Give one to three pose seeds. C0 limits the number of generations.');
  for (const hash of [options.checkpointSha256, options.controlNetSha256]) if (hash !== undefined && !/^[0-9a-f]{64}$/.test(hash)) fail('E_USAGE', 'A SHA-256 value must be 64 lowercase hex digits.');
  const pose = decodePng(options.poseImageBytes).raster;
  const size = { width: pose.width, height: pose.height };
  const settings: GenerationSettings = { checkpoint: options.checkpoint, controlNet: options.controlNet, positive: c0Prompt.positive, negative: c0Prompt.negative, ...c0Defaults };
  const files: PlannedFile[] = [];
  const runs: Record<string, unknown>[] = [];
  const baselineSeed = options.baselineSeed ?? options.seeds[0];
  if (baselineSeed !== undefined) {
    const name = `c0-baseline-${baselineSeed}.api.json`;
    files.push({ name, bytes: json(baselineWorkflow(settings, size, baselineSeed, `c0_baseline_${baselineSeed}`)) });
    runs.push({ id: `baseline-${baselineSeed}`, kind: 'baseline', seed: baselineSeed, workflow: name });
  }
  for (const seed of options.seeds) {
    const name = `c0-pose-${seed}.api.json`;
    files.push({ name, bytes: json(poseWorkflow(settings, size, seed, `c0_pose_${seed}`, options.poseImageName)) });
    runs.push({ id: `pose-${seed}`, kind: 'pose', seed, workflow: name, controlImage: options.poseImageName });
  }
  const plan = {
    format: 'aigg.run-plan/0.1',
    tool: toolName,
    runStatus: 'NOT RUN',
    approval: 'The models are Candidate entries in docs/MODEL_LICENSES.md, not Approved. Do not run this plan before the owner approves the exact files and the hardware or cost.',
    models: {
      checkpoint: { file: options.checkpoint, sha256: options.checkpointSha256 ?? null },
      controlNet: { file: options.controlNet, sha256: options.controlNetSha256 ?? null, unionType: unionControlType }
    },
    controlImage: { file: options.poseImageName, sha256: sha256(options.poseImageBytes), pixelSha256: pixelHash(pose), size: size },
    settings: { ...c0Defaults, size: size },
    prompt: c0Prompt,
    runs,
    record: [
      'Before the run: sha256 of each model file, the ComfyUI version (git commit), Python, PyTorch, GPU model, and driver.',
      'After the run: the output file name and sha256 for each run id, the duration, and any cost.'
    ],
    files: files.map((file) => record(file))
  };
  const planFile: PlannedFile = { name: 'run-plan.json', bytes: json(plan) };
  files.push(planFile);
  return { report: { status: 'PASS', command: 'workflow', ...plan, files: files.map((file) => record(file)) }, files };
}

export type OverlayOptions = {
  readonly contractBytes: Buffer;
  readonly mapping: SideMapping;
  readonly imageBytes: Buffer;
  readonly marksBytes?: Buffer;
};

const sideRgb = (bone: string): readonly [number, number, number] => (bone.endsWith('_near') ? [40, 110, 230] : bone.endsWith('_far') ? [235, 130, 30] : [140, 140, 140]);

function cross(raster: Raster, x: number, y: number, size: number, color: Color): void {
  raster.line({ x: x - size, y: y - size }, { x: x + size, y: y + size }, Math.max(2, size / 3), color);
  raster.line({ x: x - size, y: y + size }, { x: x + size, y: y - size }, Math.max(2, size / 3), color);
}

/** `overlay`: the rig over an image of the target size, a side-by-side sheet, and a measurement when manual marks are given. */
export function overlayCommand(options: OverlayOptions): CommandResult {
  const contract = parseContractBytes(options.contractBytes);
  const decoded = decodePng(options.imageBytes);
  const image = decoded.raster;
  const size = { width: image.width, height: image.height };
  const transform = fitTransform(contract.canvas, size);
  const pose = rigPose(contract, options.mapping);
  const overlay = new Raster(size.width, size.height, [255, 255, 255, 255]);
  overlay.draw(image, 0, 0);
  for (const slot of contract.slots.values()) {
    const a = toTarget({ x: slot.attachmentRect.x, y: slot.attachmentRect.y }, transform);
    const rgb = sideRgb(slot.bone);
    overlay.strokeRect(a.x, a.y, slot.attachmentRect.w * transform.scale, slot.attachmentRect.h * transform.scale, 1, [rgb[0], rgb[1], rgb[2], 110]);
  }
  drawSkeletonOverlay(overlay, pose.keypoints, transform);
  let measurement: Measurement | null = null;
  if (options.marksBytes) {
    let value: unknown;
    try {
      value = JSON.parse(options.marksBytes.toString('utf8'));
    } catch {
      fail('E_MARKS_FORMAT', 'The marks file is not valid JSON.');
    }
    const marks = parseMarks(value);
    if (marks.image.width !== size.width || marks.image.height !== size.height) fail('E_MARKS_IMAGE', 'The marks are for another image size.');
    if (marks.image.sha256 !== undefined && marks.image.sha256 !== sha256(options.imageBytes)) fail('E_MARKS_IMAGE', 'The marks are for another image (SHA-256 differs).');
    const expected = new Map<KeypointName, { x: number; y: number }>();
    for (const item of pose.keypoints) if (item.point) expected.set(item.name, item.point);
    measurement = measure(expected, marks, transform, pose.bodyHeight, contract.tolerances);
    const mark = Math.max(6, 10 * transform.scale);
    for (const joint of measurement.joints) {
      const a = toTarget(joint.expected, transform);
      const b = toTarget(joint.marked, transform);
      overlay.line(a, b, Math.max(2, mark / 4), [255, 0, 0, 230]);
      cross(overlay, b.x, b.y, mark, joint.pass ? [255, 255, 255, 255] : [255, 0, 0, 255]);
    }
  }
  const control = renderOpenPose(pose.keypoints, size, transform);
  const reference = renderReference(contract, pose, size, transform);
  const gap = 16;
  const sheet = new Raster(size.width * 4 + gap * 3, size.height, [255, 255, 255, 255]);
  [control, image, overlay, reference].forEach((panel, index) => {
    sheet.draw(panel, index * (size.width + gap), 0);
  });
  const overlayFile: PlannedFile = { name: 'overlay.png', bytes: encodePng(overlay) };
  const sheetFile: PlannedFile = { name: 'side-by-side.png', bytes: encodePng(sheet) };
  const result = {
    format: 'aigg.overlay/0.1',
    tool: toolName,
    contract: contractReport(contract, options.contractBytes),
    mapping: options.mapping,
    image: {
      sha256: sha256(options.imageBytes),
      pixelSha256: pixelHash(image),
      size,
      colorType: decoded.colorType,
      ignoredChunks: decoded.ignoredChunks,
      colorSpace: 'assumed sRGB, values used as stored'
    },
    transform: { scale: round(transform.scale), offsetX: round(transform.offsetX), offsetY: round(transform.offsetY) },
    sheet: 'Panels from left: OpenPose control, input image, rig overlay, proportion reference.',
    rigWarnings: pose.warnings,
    measurement: measurement ?? { status: 'NOT MEASURED', reason: 'No manual marks were given. The tool does not detect keypoints.' },
    keypoints: keypointReport(pose, transform).filter((item) => (item.contract as Keypoint['point']) !== null),
    files: [record(overlayFile, overlay), record(sheetFile, sheet)]
  };
  const reportFile: PlannedFile = { name: 'overlay.json', bytes: json(result) };
  const status = measurement === null ? 'PASS' : measurement.status;
  return { report: { status, command: 'overlay', ...result, files: [...result.files, record(reportFile)] }, files: [overlayFile, sheetFile, reportFile] };
}
