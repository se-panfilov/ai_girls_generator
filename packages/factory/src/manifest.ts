import { fail, isRecord, safeText, shaPattern } from '@factory/files';

// The job manifest (job.json): the one state file of a job. The factory validates it at each read, because a person or another
// program can change the file. The JSON Schema in schemas/job.schema.json documents the same structure.

export const manifestFormat = 'aigg.factory.job/0.1';

/** The stages in their fixed order. The names are the MVP-D stage names. */
export const stageIds = ['INPUT', 'W_APPROVAL', 'L', 'L_REVIEW', 'LANDMARKS', 'M', 'SPINE', 'PREVIEW', 'FINAL_APPROVAL'] as const;
export type StageId = (typeof stageIds)[number];

export type StageKind = 'auto' | 'import' | 'checkpoint';
export const stageKinds: Record<StageId, StageKind> = {
  INPUT: 'auto',
  W_APPROVAL: 'checkpoint',
  L: 'import',
  L_REVIEW: 'checkpoint',
  LANDMARKS: 'import',
  M: 'auto',
  SPINE: 'auto',
  PREVIEW: 'auto',
  FINAL_APPROVAL: 'checkpoint'
};
export const checkpointIds = ['W_APPROVAL', 'L_REVIEW', 'FINAL_APPROVAL'] as const;
export type CheckpointId = (typeof checkpointIds)[number];
export const isCheckpoint = (id: string): id is CheckpointId => (checkpointIds as readonly string[]).includes(id);

/** The inputs that a person gives with init or provide. */
export const inputNames = ['contract', 'concept', 'layers', 'landmarks', 'correspondence'] as const;
export type InputName = (typeof inputNames)[number];

export const runStatuses = ['NOT_STARTED', 'RUNNING', 'PASS', 'FAIL', 'ERROR', 'INTERRUPTED'] as const;
export type RunStatus = (typeof runStatuses)[number];

export type ToolRecord = { readonly name: string; readonly version: string | null; readonly path: string; readonly digest: string };

export type StageRecord = {
  status: RunStatus;
  runId: string | null;
  attempts: number;
  startedAt: string | null;
  endedAt: string | null;
  fingerprint: string | null;
  inputs: Record<string, string>;
  params: Record<string, string>;
  tool: ToolRecord | null;
  /** The output folder relative to the job folder, its digest, and its file count. */
  output: { dir: string; digest: string; files: number } | null;
  /** The machine-readable report of the last run, relative to the job folder. */
  report: string | null;
  exitCode: number | null;
  code: string | null;
  message: string | null;
};

export type InputRecord = { path: string; sha256: string | null };

export type ApprovalRecord = {
  readonly checkpoint: CheckpointId;
  readonly decision: 'approved' | 'rejected';
  /** The digest of the artifact that the person saw. The decision is valid only while the artifact has this digest. */
  readonly digest: string;
  /** The run of the stage that made the artifact, or the input file for the concept. */
  readonly artifactVersion: string;
  readonly by: string;
  readonly note: string;
  readonly at: string;
  readonly tool: string;
};

export type JobManifest = {
  format: typeof manifestFormat;
  jobId: string;
  createdAt: string;
  createdBy: { tool: string; version: string };
  /** True for a licensed test character. A test character is never a product character, also after the final approval. */
  testAsset: boolean;
  inputs: Record<InputName, InputRecord | null>;
  tools: {
    spine: { path: string; version: string } | null;
    /** Only for tests and development: another control or viewer command. A job with an override never shows a real end-to-end result. */
    controlCli: string | null;
    viewerCli: string | null;
  };
  stages: Record<StageId, StageRecord>;
  approvals: ApprovalRecord[];
  /** Earlier input paths and digests. provide never removes them. */
  inputHistory: { name: InputName | 'spine'; path: string; replacedAt: string }[];
};

export const jobIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const spineVersionPattern = /^(\d{1,2}\.\d{1,2}\.\d{1,3}|latest|lateststable|stable)$/;
export const maxApprovals = 1000;

export const emptyStage = (): StageRecord => ({
  status: 'NOT_STARTED',
  runId: null,
  attempts: 0,
  startedAt: null,
  endedAt: null,
  fingerprint: null,
  inputs: {},
  params: {},
  tool: null,
  output: null,
  report: null,
  exitCode: null,
  code: null,
  message: null
});

const bad = (path: string, rule: string): never => fail('E_MANIFEST', `job.json is not valid: ${path} ${rule}.`);

function text(value: unknown, path: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max) bad(path, `must be a string of at most ${max} characters`);
  return value as string;
}

function nullableText(value: unknown, path: string, max = 4096): string | null {
  return value === null ? null : text(value, path, max);
}

function keysOnly(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) bad(`${path}.${safeText(key, 40)}`, 'is not a known field');
  for (const key of allowed) if (!(key in value)) bad(`${path}.${key}`, 'is missing');
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) bad(path, 'must be an object');
  return value as Record<string, unknown>;
}

function stringMap(value: unknown, path: string): Record<string, string> {
  const map = record(value, path);
  for (const [key, item] of Object.entries(map)) text(item, `${path}.${safeText(key, 40)}`);
  return map as Record<string, string>;
}

function digest(value: unknown, path: string): string {
  if (typeof value !== 'string' || !shaPattern.test(value)) bad(path, 'must be a SHA-256 digest');
  return value as string;
}

function stage(value: unknown, path: string): StageRecord {
  const item = record(value, path);
  keysOnly(item, Object.keys(emptyStage()), path);
  if (!(runStatuses as readonly unknown[]).includes(item.status)) bad(`${path}.status`, `must be one of ${runStatuses.join(', ')}`);
  if (!Number.isSafeInteger(item.attempts) || (item.attempts as number) < 0) bad(`${path}.attempts`, 'must be a whole number');
  for (const key of ['runId', 'startedAt', 'endedAt', 'report', 'code', 'message'] as const) nullableText(item[key], `${path}.${key}`);
  if (item.fingerprint !== null) digest(item.fingerprint, `${path}.fingerprint`);
  stringMap(item.inputs, `${path}.inputs`);
  stringMap(item.params, `${path}.params`);
  if (item.tool !== null) {
    const tool = record(item.tool, `${path}.tool`);
    keysOnly(tool, ['name', 'version', 'path', 'digest'], `${path}.tool`);
    text(tool.name, `${path}.tool.name`);
    nullableText(tool.version, `${path}.tool.version`);
    text(tool.path, `${path}.tool.path`);
    digest(tool.digest, `${path}.tool.digest`);
  }
  if (item.output !== null) {
    const output = record(item.output, `${path}.output`);
    keysOnly(output, ['dir', 'digest', 'files'], `${path}.output`);
    const dir = text(output.dir, `${path}.output.dir`);
    if (!/^stages\/[A-Z_]+\/runs\/[a-z0-9-]+\/out$/.test(dir)) bad(`${path}.output.dir`, 'must be a run folder of the job');
    digest(output.digest, `${path}.output.digest`);
    if (!Number.isSafeInteger(output.files)) bad(`${path}.output.files`, 'must be a whole number');
  }
  if (item.exitCode !== null && !Number.isSafeInteger(item.exitCode)) bad(`${path}.exitCode`, 'must be a whole number or null');
  return item as unknown as StageRecord;
}

/** Checks the structure of a parsed job.json and returns it typed. It rejects unknown fields and missing fields. */
export function parseManifest(value: unknown): JobManifest {
  const job = record(value, '$');
  keysOnly(job, ['format', 'jobId', 'createdAt', 'createdBy', 'testAsset', 'inputs', 'tools', 'stages', 'approvals', 'inputHistory'], '$');
  if (job.format !== manifestFormat) bad('$.format', `must be ${manifestFormat}`);
  if (typeof job.jobId !== 'string' || !jobIdPattern.test(job.jobId)) bad('$.jobId', 'must match ^[a-z0-9][a-z0-9_-]{0,63}$');
  text(job.createdAt, '$.createdAt', 64);
  const createdBy = record(job.createdBy, '$.createdBy');
  keysOnly(createdBy, ['tool', 'version'], '$.createdBy');
  text(createdBy.tool, '$.createdBy.tool', 64);
  text(createdBy.version, '$.createdBy.version', 64);
  if (typeof job.testAsset !== 'boolean') bad('$.testAsset', 'must be true or false');
  const inputs = record(job.inputs, '$.inputs');
  keysOnly(inputs, inputNames, '$.inputs');
  for (const name of inputNames) {
    if (inputs[name] === null) continue;
    const input = record(inputs[name], `$.inputs.${name}`);
    keysOnly(input, ['path', 'sha256'], `$.inputs.${name}`);
    text(input.path, `$.inputs.${name}.path`);
    if (input.sha256 !== null) digest(input.sha256, `$.inputs.${name}.sha256`);
  }
  const tools = record(job.tools, '$.tools');
  keysOnly(tools, ['spine', 'controlCli', 'viewerCli'], '$.tools');
  if (tools.spine !== null) {
    const spine = record(tools.spine, '$.tools.spine');
    keysOnly(spine, ['path', 'version'], '$.tools.spine');
    text(spine.path, '$.tools.spine.path');
    if (typeof spine.version !== 'string' || !spineVersionPattern.test(spine.version)) bad('$.tools.spine.version', 'must be a Spine version such as 4.3.26');
  }
  nullableText(tools.controlCli, '$.tools.controlCli');
  nullableText(tools.viewerCli, '$.tools.viewerCli');
  const stages = record(job.stages, '$.stages');
  keysOnly(stages, stageIds, '$.stages');
  for (const id of stageIds) stage(stages[id], `$.stages.${id}`);
  if (!Array.isArray(job.approvals) || job.approvals.length > maxApprovals) bad('$.approvals', `must be a list of at most ${maxApprovals} decisions`);
  (job.approvals as unknown[]).forEach((item, index) => {
    const path = `$.approvals[${index}]`;
    const approval = record(item, path);
    keysOnly(approval, ['checkpoint', 'decision', 'digest', 'artifactVersion', 'by', 'note', 'at', 'tool'], path);
    if (!isCheckpoint(String(approval.checkpoint))) bad(`${path}.checkpoint`, `must be one of ${checkpointIds.join(', ')}`);
    if (approval.decision !== 'approved' && approval.decision !== 'rejected') bad(`${path}.decision`, 'must be approved or rejected');
    digest(approval.digest, `${path}.digest`);
    for (const key of ['artifactVersion', 'by', 'note', 'at', 'tool'] as const) text(approval[key], `${path}.${key}`, 2000);
  });
  if (!Array.isArray(job.inputHistory) || job.inputHistory.length > 1000) bad('$.inputHistory', 'must be a list of at most 1000 entries');
  (job.inputHistory as unknown[]).forEach((item, index) => {
    const path = `$.inputHistory[${index}]`;
    const entry = record(item, path);
    keysOnly(entry, ['name', 'path', 'replacedAt'], path);
    if (!([...inputNames, 'spine'] as unknown[]).includes(entry.name)) bad(`${path}.name`, 'must be an input name');
    text(entry.path, `${path}.path`);
    text(entry.replacedAt, `${path}.replacedAt`, 64);
  });
  return job as unknown as JobManifest;
}

export function newManifest(jobId: string, version: string, now: string): JobManifest {
  return {
    format: manifestFormat,
    jobId,
    createdAt: now,
    createdBy: { tool: '@aigg/factory', version },
    testAsset: false,
    inputs: { contract: null, concept: null, layers: null, landmarks: null, correspondence: null },
    tools: { spine: null, controlCli: null, viewerCli: null },
    stages: Object.fromEntries(stageIds.map((id) => [id, emptyStage()])) as Record<StageId, StageRecord>,
    approvals: [],
    inputHistory: []
  };
}
