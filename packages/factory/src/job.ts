import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { digestDirectory, digestOf, FactoryError, fail, isRecord, randomId, readFileNoFollow, readOrFail, safeText, shaPattern, writeJsonAtomic, writeNewFile } from '@factory/files';
import { layerPaths, readConcept, readContract, readCorrespondence, readLandmarks, readLayerSet } from '@factory/inputs';
import {
  type ApprovalRecord,
  type CheckpointId,
  type InputName,
  inputNames,
  isCheckpoint,
  jobIdPattern,
  type JobManifest,
  newManifest,
  parseManifest,
  spineVersionPattern,
  type StageId,
  stageIds,
  type StageKind,
  stageKinds,
  type StageRecord,
  type ToolRecord
} from '@factory/manifest';
import { checkSpine, describeTool, factoryVersion, runTool, type ToolRun } from '@factory/tools';

// The job: one character, one folder, one manifest (job.json). Stages run in a fixed order, locally and one at a time.
// A stage is skipped when its fingerprint (input digests, parameters, tool) is unchanged and its output folder still has the
// recorded digest. Each run writes into a new run folder; the factory never deletes or replaces an earlier run folder.

export const manifestName = 'job.json';
export const lockName = 'job.lock';
export const stageReportFormat = 'aigg.factory.stage-report/0.1';
export const jobReportFormat = 'aigg.factory.job-report/0.1';
/** The command that the guidance prints. Run it from the repository root after `npm run build`. */
export const factoryCommand = 'node packages/factory/dist/src/cli.js';
export const timeouts = { M: 20 * 60_000, SPINE: 60 * 60_000, PREVIEW: 2 * 60_000 };

export type StageState = 'DONE' | 'READY' | 'STALE' | 'INVALID' | 'INTERRUPTED' | 'RUNNING' | 'FAILED' | 'BLOCKED' | 'WAITING_FOR_INPUT' | 'WAITING_FOR_APPROVAL' | 'APPROVED' | 'REJECTED';

export type Guidance = {
  readonly stage: StageId;
  readonly status: StageState;
  readonly missing: string;
  readonly format: string;
  readonly action: string;
  readonly continueWith: string;
};

export type StageView = {
  readonly id: StageId;
  readonly kind: StageKind;
  readonly state: StageState;
  readonly recorded: StageRecord['status'];
  readonly reason: string;
  readonly runId: string | null;
  readonly output: string | null;
  /** For a checkpoint: the digest that an approval must name. */
  readonly digest?: string;
  readonly artifactVersion?: string;
  readonly code?: string;
  readonly next?: Guidance;
};

export type JobStatus = 'COMPLETE' | 'READY' | 'RUNNING' | 'WAITING_FOR_INPUT' | 'WAITING_FOR_APPROVAL' | 'REJECTED' | 'FAILED';

export type JobReport = {
  readonly format: typeof jobReportFormat;
  readonly jobId: string;
  readonly job: string;
  readonly status: JobStatus;
  /** PASS only when the final approval is valid, every stage ran with the real commands of the repository, and Spine ran. */
  readonly endToEnd: 'PASS' | 'NOT_REACHED' | 'NOT_APPLICABLE_TOOL_OVERRIDE';
  readonly testAsset: boolean;
  readonly ran: readonly StageId[];
  readonly skipped: readonly StageId[];
  readonly stages: readonly StageView[];
  readonly next: Guidance | null;
  readonly approvals: readonly (ApprovalRecord & { readonly valid: boolean })[];
};

type Prepared = { inputs: Record<string, string>; params: Record<string, string>; tool: ToolRecord; fingerprint: string };
type Outcome = { ok: boolean; code: string | null; message: string; exitCode: number | null; toolReport: Record<string, unknown> | null; ambiguous?: boolean };

const now = (): string => new Date().toISOString();
const quote = (value: string): string => (/^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);
const command = (jobDir: string, ...rest: string[]): string => [factoryCommand, rest[0] ?? 'status', quote(jobDir), ...rest.slice(1)].join(' ');

// ---- Job folder, manifest, lock ----

export function readJob(jobDir: string): JobManifest {
  const data = readFileNoFollow(join(jobDir, manifestName), 16 * 1024 * 1024);
  if (data === 'missing') fail('E_JOB_MISSING', `${safeText(jobDir)} is not a job folder (no ${manifestName}). Make one with: ${factoryCommand} init <job-folder>`);
  if (!Buffer.isBuffer(data)) return fail('E_MANIFEST', `${manifestName} cannot be read (${data}).`);
  let value: unknown;
  try {
    value = JSON.parse(data.toString('utf8'));
  } catch {
    return fail('E_MANIFEST', `${manifestName} is not valid JSON.`);
  }
  return parseManifest(value);
}

const saveJob = (jobDir: string, job: JobManifest): void => {
  writeJsonAtomic(join(jobDir, manifestName), parseManifest(JSON.parse(JSON.stringify(job))));
};

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The process that holds the lock, or null. A lock of a process that does not run any more is stale. */
export function lockOwner(jobDir: string): { pid: number; alive: boolean } | null {
  const data = readFileNoFollow(join(jobDir, lockName), 4096);
  if (!Buffer.isBuffer(data)) return null;
  let pid = 0;
  try {
    const value: unknown = JSON.parse(data.toString('utf8'));
    if (isRecord(value) && Number.isSafeInteger(value.pid)) pid = value.pid as number;
  } catch {
    pid = 0;
  }
  return { pid, alive: pid > 0 && processAlive(pid) };
}

/** Runs the action with the job lock. Only one process changes a job at a time. A stale lock is removed. */
export function withLock<T>(jobDir: string, action: () => T): T {
  const path = join(jobDir, lockName);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = lockOwner(jobDir);
      if (owner?.alive === true) fail('E_LOCKED', `Another process (pid ${owner.pid}) works on this job. Wait until it stops.`);
      unlinkSync(path);
      continue;
    }
    try {
      writeSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: now() }));
    } finally {
      closeSync(descriptor);
    }
    try {
      return action();
    } finally {
      unlinkSync(path);
    }
  }
  return fail('E_LOCKED', 'The job lock cannot be taken.');
}

function checkJobFolder(jobDir: string): void {
  let info;
  try {
    info = lstatSync(jobDir);
  } catch {
    fail('E_JOB_MISSING', `The job folder ${safeText(jobDir)} does not exist.`);
  }
  if (info?.isSymbolicLink() === true || info?.isDirectory() !== true) fail('E_JOB_FOLDER', `${safeText(jobDir)} is not a real folder.`);
}

// ---- init and provide ----

export type InitOptions = {
  readonly jobDir: string;
  readonly jobId?: string;
  readonly testAsset?: boolean;
  readonly inputs?: Partial<Record<InputName, string>>;
  readonly spine?: string;
  readonly spineVersion?: string;
  readonly controlCli?: string;
  readonly viewerCli?: string;
};

/** Resolves an input path to the real path of an existing regular file. Links are resolved here, once, at registration. */
function inputPath(name: InputName, path: string): string {
  let real: string;
  try {
    real = realpathSync(resolve(path));
  } catch {
    return fail('E_INPUT_MISSING', `The ${name} file ${safeText(path)} does not exist.`);
  }
  if (!lstatSync(real).isFile()) fail('E_INPUT', `The ${name} path ${safeText(path)} is not a file.`);
  if (name === 'layers') layerPaths(real);
  return real;
}

export function initJob(options: InitOptions): JobManifest {
  const jobDir = resolve(options.jobDir);
  try {
    const info = lstatSync(jobDir);
    if (info.isSymbolicLink() || !info.isDirectory()) fail('E_JOB_FOLDER', `${safeText(jobDir)} exists and is not a real folder.`);
    if (readdirSync(jobDir).length > 0) fail('E_JOB_EXISTS', `${safeText(jobDir)} is not empty. Give a new folder. An existing job is never replaced.`);
  } catch (error) {
    if (error instanceof FactoryError) throw error;
    const parent = dirname(jobDir);
    if (!lstatSync(parent, { throwIfNoEntry: false })?.isDirectory()) fail('E_JOB_FOLDER', `The parent folder ${safeText(parent)} does not exist.`);
    mkdirSync(jobDir);
  }
  const jobId = options.jobId ?? 'job';
  if (!jobIdPattern.test(jobId)) fail('E_USAGE', '--id must match ^[a-z0-9][a-z0-9_-]{0,63}$.');
  const job = newManifest(jobId, factoryVersion(), now());
  job.testAsset = options.testAsset === true;
  for (const name of inputNames) {
    const path = options.inputs?.[name];
    if (path !== undefined) job.inputs[name] = { path: inputPath(name, path), sha256: null };
  }
  if (options.spine !== undefined) job.tools.spine = spineTool(options.spine, options.spineVersion);
  if (options.controlCli !== undefined) job.tools.controlCli = resolve(options.controlCli);
  if (options.viewerCli !== undefined) job.tools.viewerCli = resolve(options.viewerCli);
  mkdirSync(join(jobDir, 'stages'), { recursive: false });
  saveJob(jobDir, job);
  return job;
}

function spineTool(path: string, version = '4.3.26'): { path: string; version: string } {
  if (!isAbsolute(path)) fail('E_USAGE', 'The Spine path must be absolute, for example /Applications/Spine.app/Contents/MacOS/Spine.');
  if (!spineVersionPattern.test(version)) fail('E_USAGE', '--spine-version must be a version such as 4.3.26.');
  return { path, version };
}

/** Registers or replaces one input. The old path stays in inputHistory. The factory does not copy or change the file. */
export function provideInput(jobDir: string, name: string, path: string, spineVersion?: string): JobManifest {
  checkJobFolder(jobDir);
  return withLock(jobDir, () => {
    const job = readJob(jobDir);
    if (name === 'spine') {
      if (job.tools.spine !== null) job.inputHistory.push({ name: 'spine', path: job.tools.spine.path, replacedAt: now() });
      job.tools.spine = spineTool(path, spineVersion ?? job.tools.spine?.version ?? '4.3.26');
    } else {
      if (!(inputNames as readonly string[]).includes(name)) fail('E_USAGE', `The input name must be one of ${[...inputNames, 'spine'].join(', ')}.`);
      const key = name as InputName;
      const old = job.inputs[key];
      if (old !== null) job.inputHistory.push({ name: key, path: old.path, replacedAt: now() });
      job.inputs[key] = { path: inputPath(key, path), sha256: null };
    }
    saveJob(jobDir, job);
    return job;
  });
}

// ---- Evaluation ----

type Context = { jobDir: string; job: JobManifest; factoryTool: ToolRecord | null; done: Map<StageId, StageRecord> };

function factoryTool(context: Context): ToolRecord {
  context.factoryTool ??= { name: '@aigg/factory', version: factoryVersion(), path: 'internal', digest: digestOf({ name: '@aigg/factory', version: factoryVersion() }) };
  return context.factoryTool;
}

const fingerprint = (id: StageId, inputs: Record<string, string>, params: Record<string, string>, tool: ToolRecord): string =>
  digestOf({ stage: id, inputs, params, tool: { name: tool.name, version: tool.version, digest: tool.digest } });

const outputOf = (context: Context, id: StageId): { digest: string; dir: string; runId: string } => {
  const record = context.done.get(id);
  if (record?.output === undefined || record.output === null || record.runId === null) return fail('E_INTERNAL', `The stage ${id} has no output.`);
  return { digest: record.output.digest, dir: join(context.jobDir, record.output.dir), runId: record.runId };
};

const guidance = (stage: StageId, status: StageState, missing: string, format: string, action: string, continueWith: string): Guidance => ({ stage, status, missing, format, action, continueWith });

type Evaluation = { view: StageView; prepared?: Prepared; runnable: boolean };

const viewOf = (context: Context, id: StageId, state: StageState, reason: string, extra: Partial<StageView> = {}): StageView => {
  const record = context.job.stages[id];
  return { id, kind: stageKinds[id], state, recorded: record.status, reason, runId: record.runId, output: record.output?.dir ?? null, ...extra };
};

/** The inputs of an automatic or import stage, or a reason why the stage cannot start. */
function prepare(context: Context, id: StageId): Prepared | { waiting: Guidance; reason: string; failed?: { code: string; message: string } } {
  const { job, jobDir } = context;
  const inputError = (error: unknown, name: InputName): { waiting: Guidance; reason: string; failed: { code: string; message: string } } => {
    if (!(error instanceof FactoryError)) throw error;
    return {
      reason: error.message,
      failed: { code: error.code, message: error.message },
      waiting: guidance(id, 'FAILED', `A valid ${name} file`, `See the message: ${error.message}`, `Correct the file or give another one.`, command(jobDir, 'provide', name, '<path>'))
    };
  };
  const make = (inputs: Record<string, string>, params: Record<string, string>, tool: ToolRecord): Prepared => ({ inputs, params, tool, fingerprint: fingerprint(id, inputs, params, tool) });
  switch (id) {
    case 'INPUT': {
      const contract = job.inputs.contract;
      if (contract === null) {
        return {
          reason: 'The job has no contract or candidate rig.',
          waiting: guidance(
            id,
            'WAITING_FOR_INPUT',
            'The rig contract (or the candidate rig contract) of the job',
            'rig.contract.json (JSON), for example the C0.5 candidate contract',
            'Give the contract file.',
            command(jobDir, 'provide', 'contract', '<rig.contract.json>')
          )
        };
      }
      try {
        return make({ contract: readContract(contract.path).sha256 }, {}, factoryTool(context));
      } catch (error) {
        return inputError(error, 'contract');
      }
    }
    case 'L': {
      const layers = job.inputs.layers;
      if (layers === null) {
        return {
          reason: 'The job has no See-through layer result.',
          waiting: guidance(
            id,
            'WAITING_FOR_INPUT',
            'The See-through layer result of the approved concept (an import: the factory does not run See-through)',
            '<stem>.psd.json with the folder <stem>/ that has one <tag>.png for each part and src_img.png (the output of the owner-run See-through bundle)',
            'Run See-through outside the factory (owner-run bundle, see packages/seethrough-bundle) and give the .psd.json file of the result.',
            command(jobDir, 'provide', 'layers', '<stem>.psd.json')
          )
        };
      }
      const concept = outputOfCheckpoint(context, 'W_APPROVAL');
      try {
        return make({ concept, layerSet: readLayerSet(layers.path).digest }, {}, factoryTool(context));
      } catch (error) {
        return inputError(error, 'layers');
      }
    }
    case 'LANDMARKS': {
      const { landmarks, correspondence } = job.inputs;
      if (landmarks === null || correspondence === null) {
        const missing = [landmarks === null ? 'landmarks' : null, correspondence === null ? 'correspondence' : null].filter((item) => item !== null).join(' and ');
        const layers = job.inputs.layers?.path ?? '<stem>.psd.json';
        const { layersDir, imagePath } = layerPaths(layers);
        return {
          reason: `The job has no ${missing} file.`,
          waiting: guidance(
            id,
            'WAITING_FOR_INPUT',
            `The manual landmark marks (${missing}) for the reviewed layers`,
            'landmarks-manual.json (format aigg.l0-1c.landmarks/0.1) and correspondence.json of align-study run with these marks',
            [
              `Make the marks: node packages/control/dist/src/cli.js annotate-page --image ${quote(imagePath)} --landmarks <align-study landmarks.json> --out <dir>, open annotate.html, mark, and export landmarks-manual.json.`,
              `Then: node packages/control/dist/src/cli.js align-study --contract ${quote(job.inputs.contract?.path ?? '<rig.contract.json>')} --layers ${quote(layersDir)} --metadata ${quote(layers)} --image ${quote(imagePath)} --landmarks <landmarks-manual.json> --out <dir>.`,
              'Give both files.'
            ].join(' '),
            `${command(jobDir, 'provide', 'landmarks', '<landmarks-manual.json>')} && ${command(jobDir, 'provide', 'correspondence', '<correspondence.json>')}`
          )
        };
      }
      try {
        return make(
          { layers: outputOf(context, 'L').digest, landmarks: readLandmarks(landmarks.path).sha256, correspondence: readCorrespondence(correspondence.path).sha256 },
          {},
          factoryTool(context)
        );
      } catch (error) {
        return inputError(error, 'landmarks');
      }
    }
    case 'M':
      return make(
        { contract: outputOf(context, 'INPUT').digest, layers: outputOf(context, 'L').digest, landmarks: outputOf(context, 'LANDMARKS').digest },
        {},
        describeTool('@aigg/control', job.tools.controlCli)
      );
    case 'SPINE': {
      const spine = job.tools.spine;
      if (spine === null) {
        return {
          reason: 'The job has no Spine executable.',
          waiting: guidance(
            id,
            'WAITING_FOR_INPUT',
            'The path of the licensed Spine executable on this computer',
            'An absolute path. macOS: /Applications/Spine.app/Contents/MacOS/Spine',
            'Give the Spine path. The factory runs the existing spine-validate command with it.',
            command(jobDir, 'provide', 'spine', '/Applications/Spine.app/Contents/MacOS/Spine')
          )
        };
      }
      const check = checkSpine(spine.path, spine.version);
      if (!check.ok) {
        return {
          reason: check.message,
          failed: { code: check.code, message: check.message },
          waiting: guidance(
            id,
            'FAILED',
            'A Spine executable that exists',
            'An absolute path. macOS: /Applications/Spine.app/Contents/MacOS/Spine',
            'Give the correct Spine path. The assembled package is not changed.',
            command(jobDir, 'provide', 'spine', '<path>')
          )
        };
      }
      return make({ package: outputOf(context, 'M').digest }, { spineVersion: spine.version, spine: check.digest }, describeTool('@aigg/control', job.tools.controlCli));
    }
    case 'PREVIEW':
      return make({ spine: outputOf(context, 'SPINE').digest }, {}, describeTool('@aigg/viewer', job.tools.viewerCli));
    default:
      return fail('E_INTERNAL', `${id} is not an automatic stage.`);
  }
}

/** The digest of the artifact of a checkpoint, from the current state. */
function checkpointArtifact(context: Context, id: CheckpointId): { digest: string; version: string } | { waiting: Guidance; reason: string; failed?: { code: string; message: string } } {
  const { job, jobDir } = context;
  if (id === 'W_APPROVAL') {
    const concept = job.inputs.concept;
    if (concept === null) {
      return {
        reason: 'The job has no concept image.',
        waiting: guidance(
          id,
          'WAITING_FOR_INPUT',
          'The concept image of the character',
          'A PNG file (the selected concept)',
          'Give the concept image. Then a person reviews and approves it.',
          command(jobDir, 'provide', 'concept', '<concept.png>')
        )
      };
    }
    try {
      const sha = readConcept(concept.path).sha256;
      return { digest: sha, version: `concept sha256 ${sha}` };
    } catch (error) {
      if (!(error instanceof FactoryError)) throw error;
      return {
        reason: error.message,
        failed: { code: error.code, message: error.message },
        waiting: guidance(id, 'FAILED', 'A valid concept PNG file', error.message, 'Give another concept file.', command(jobDir, 'provide', 'concept', '<concept.png>'))
      };
    }
  }
  if (id === 'L_REVIEW') {
    const layers = outputOf(context, 'L');
    return { digest: layers.digest, version: `L run ${layers.runId}` };
  }
  const parts = (['M', 'SPINE', 'PREVIEW'] as const).map((stage) => outputOf(context, stage));
  return { digest: digestOf({ M: parts[0]?.digest, SPINE: parts[1]?.digest, PREVIEW: parts[2]?.digest }), version: `M ${parts[0]?.runId}, SPINE ${parts[1]?.runId}, PREVIEW ${parts[2]?.runId}` };
}

function outputOfCheckpoint(context: Context, id: CheckpointId): string {
  const artifact = checkpointArtifact(context, id);
  return 'digest' in artifact ? artifact.digest : fail('E_INTERNAL', `${id} has no artifact.`);
}

/** The decision that is valid for this artifact: the last decision with the same digest. Decisions for other digests are not valid. */
export function decisionFor(job: JobManifest, id: CheckpointId, digest: string): ApprovalRecord | null {
  for (let index = job.approvals.length - 1; index >= 0; index -= 1) {
    const approval = job.approvals[index] as ApprovalRecord;
    if (approval.checkpoint === id && approval.digest === digest) return approval;
  }
  return null;
}

const checkpointHelp: Record<CheckpointId, { what: string; check: string }> = {
  W_APPROVAL: {
    what: 'concept approval',
    check:
      'Look at the concept image. Approve it only if it is the selected concept and follows the content rules in AGENTS.md (no sexualized content of a minor or of a character that looks like a child).'
  },
  L_REVIEW: { what: 'layer review', check: 'Look at the layer PNG files and src_img.png (and the layer report of the L stage). Approve them only if the layers are clean enough for the assembly.' },
  FINAL_APPROVAL: {
    what: 'final approval',
    check: 'Play the export in the viewer (command in the PREVIEW output launch.json) and look at the Spine validation. Approve only if the character is acceptable.'
  }
};

function evaluateCheckpoint(context: Context, id: CheckpointId): Evaluation {
  const artifact = checkpointArtifact(context, id);
  if (!('digest' in artifact)) {
    const state: StageState = artifact.failed === undefined ? 'WAITING_FOR_INPUT' : 'FAILED';
    return { view: viewOf(context, id, state, artifact.reason, { next: artifact.waiting, ...(artifact.failed ? { code: artifact.failed.code } : {}) }), runnable: false };
  }
  const decision = decisionFor(context.job, id, artifact.digest);
  const base = { digest: artifact.digest, artifactVersion: artifact.version };
  const help = checkpointHelp[id];
  const testNote = context.job.testAsset
    ? ' This job is a licensed test character: a decision accepts it as technical test data only. It does not make it a product character or confirm its age.'
    : '';
  if (decision?.decision === 'approved') return { view: viewOf(context, id, 'APPROVED', `Approved by ${safeText(decision.by, 100)} at ${decision.at}.`, base), runnable: false };
  const approveCommand = command(context.jobDir, 'approve', id, '--by', '<your name>', '--digest', artifact.digest);
  if (decision?.decision === 'rejected') {
    return {
      view: viewOf(context, id, 'REJECTED', `Rejected by ${safeText(decision.by, 100)}: ${safeText(decision.note, 300)}`, {
        ...base,
        next: guidance(
          id,
          'REJECTED',
          `A new artifact for the ${help.what}`,
          'A changed input file (provide) makes a new artifact with a new digest.',
          'Correct the artifact and give it again, or change the decision.',
          `${command(context.jobDir, 'provide', '<input>', '<path>')} or ${approveCommand}`
        )
      }),
      runnable: false
    };
  }
  const earlier = context.job.approvals.some((approval) => approval.checkpoint === id && approval.digest !== artifact.digest);
  return {
    view: viewOf(
      context,
      id,
      'WAITING_FOR_APPROVAL',
      `${earlier ? 'The artifact changed after the earlier decision, so that decision is not valid. ' : ''}A person must make the ${help.what}.${testNote}`,
      {
        ...base,
        next: guidance(
          id,
          'WAITING_FOR_APPROVAL',
          `The human decision for the ${help.what} of artifact ${artifact.digest} (${artifact.version})`,
          'approve or reject in an interactive terminal, with your name and the digest above',
          help.check,
          `${approveCommand} (or reject ... --reason <text>)`
        )
      }
    ),
    runnable: false
  };
}

function evaluateStage(context: Context, id: StageId, retry: boolean): Evaluation {
  if (isCheckpoint(id)) return evaluateCheckpoint(context, id);
  const prepared = prepare(context, id);
  const record = context.job.stages[id];
  if (!('fingerprint' in prepared)) {
    const state: StageState = prepared.failed === undefined ? 'WAITING_FOR_INPUT' : 'FAILED';
    return { view: viewOf(context, id, state, prepared.reason, { next: prepared.waiting, ...(prepared.failed ? { code: prepared.failed.code } : {}) }), runnable: false };
  }
  const run = (state: StageState, reason: string): Evaluation => ({ view: viewOf(context, id, state, reason), prepared, runnable: true });
  switch (record.status) {
    case 'NOT_STARTED':
      return run('READY', 'The stage has not run.');
    case 'RUNNING':
      return { view: viewOf(context, id, 'RUNNING', `The run ${record.runId ?? ''} has not finished.`), prepared, runnable: false };
    case 'INTERRUPTED':
      return run('INTERRUPTED', `The run ${record.runId ?? ''} stopped before its end. Its folder is kept. The stage writes into a new folder, so it can run again.`);
    case 'FAIL':
    case 'ERROR': {
      if (record.fingerprint !== prepared.fingerprint) return run('READY', 'The inputs changed after the failed run.');
      if (retry) return run('READY', 'Retry of the failed run was requested.');
      const ambiguous = record.status === 'ERROR' ? ' The result was ambiguous (time-out, signal, or tool error); the factory does not retry it automatically.' : '';
      return {
        view: viewOf(context, id, 'FAILED', `${record.message ?? 'The stage failed.'}${ambiguous}`, {
          ...(record.code === null ? {} : { code: record.code }),
          next: guidance(
            id,
            'FAILED',
            'A correction of the inputs or of the tool',
            `See ${record.report ?? 'the stage report'} and the logs in the run folder.`,
            'Correct the cause. To run the same inputs again, use --retry.',
            command(context.jobDir, 'run', '--retry')
          )
        }),
        prepared,
        runnable: false
      };
    }
    case 'PASS': {
      if (record.fingerprint !== prepared.fingerprint) {
        const changed = Object.keys({ ...record.inputs, ...prepared.inputs }).filter((key) => record.inputs[key] !== prepared.inputs[key]);
        const tool = record.tool?.digest !== prepared.tool.digest ? ['tool'] : [];
        const params = Object.keys({ ...record.params, ...prepared.params }).filter((key) => record.params[key] !== prepared.params[key]);
        return run('STALE', `Changed since the last run: ${[...changed, ...params, ...tool].join(', ') || 'fingerprint'}.`);
      }
      const output = record.output;
      if (output === null) return run('INVALID', 'The run has no output record.');
      try {
        if (digestDirectory(join(context.jobDir, output.dir)).digest !== output.digest) return run('INVALID', `The output ${output.dir} changed after the run.`);
      } catch (error) {
        if (!(error instanceof FactoryError)) throw error;
        return run('INVALID', `The output ${output.dir} is missing or damaged: ${error.message}`);
      }
      return { view: viewOf(context, id, 'DONE', 'Unchanged: the same inputs, parameters, and tool, and the output has the recorded digest.'), prepared, runnable: false };
    }
    default:
      return fail('E_MANIFEST', `The stage ${id} has an unknown status.`);
  }
}

// ---- Stage execution ----

function toolOutcome(run: ToolRun, label: string): Outcome {
  const status = typeof run.report?.status === 'string' ? run.report.status : null;
  if (run.timedOut) return { ok: false, code: 'E_TIMEOUT', message: `${label} did not finish in the time limit and was stopped.`, exitCode: run.exitCode, toolReport: run.report, ambiguous: true };
  if (run.spawnError !== null) return { ok: false, code: 'E_SPAWN', message: `${label} did not start: ${run.spawnError}`, exitCode: null, toolReport: null, ambiguous: true };
  if (run.signal !== null) return { ok: false, code: 'E_SIGNAL', message: `${label} stopped with the signal ${run.signal}.`, exitCode: null, toolReport: run.report, ambiguous: true };
  if (run.exitCode === 0 && status === 'PASS') return { ok: true, code: null, message: `${label}: PASS.`, exitCode: 0, toolReport: run.report };
  const code = isRecord(run.report) && typeof run.report.code === 'string' ? run.report.code : run.exitCode === 2 ? 'E_TOOL_ERROR' : 'E_TOOL_FAIL';
  const problems =
    isRecord(run.report) && Array.isArray(run.report.problems)
      ? ` ${safeText(
          (run.report.problems as unknown[])
            .slice(0, 3)
            .map((item): unknown => (isRecord(item) ? item.message : item))
            .join(' '),
          600
        )}`
      : '';
  return {
    ok: false,
    code,
    message: `${label} returned ${status ?? 'no report'} (exit status ${run.exitCode ?? 'none'}).${problems}`,
    exitCode: run.exitCode,
    toolReport: run.report,
    ambiguous: run.exitCode === 2 && status !== 'ERROR'
  };
}

function summary(report: Record<string, unknown> | null): Record<string, unknown> | null {
  if (report === null) return null;
  const keep = ['format', 'status', 'overall', 'levels', 'code', 'dryRun', 'written'];
  return Object.fromEntries(Object.entries(report).filter(([key]) => keep.includes(key)));
}

function execute(context: Context, id: StageId, prepared: Prepared, runDir: string): Outcome {
  const { job } = context;
  const out = join(runDir, 'out');
  const write = (name: string, value: unknown): void => {
    writeNewFile(join(out, name), `${JSON.stringify(value, null, 2)}\n`);
  };
  switch (id) {
    case 'INPUT': {
      mkdirSync(out);
      const contract = readContract((job.inputs.contract as { path: string }).path);
      if (contract.sha256 !== prepared.inputs.contract) return { ok: false, code: 'E_INPUT_CHANGED', message: 'The contract changed during the run.', exitCode: null, toolReport: null };
      write('contract.json', { sha256: contract.sha256, bytes: contract.bytes });
      return { ok: true, code: null, message: 'The contract is a JSON object. Its digest is recorded.', exitCode: null, toolReport: null };
    }
    case 'L': {
      mkdirSync(out);
      const set = readLayerSet((job.inputs.layers as { path: string }).path);
      if (set.digest !== prepared.inputs.layerSet) return { ok: false, code: 'E_INPUT_CHANGED', message: 'The layer files changed during the run.', exitCode: null, toolReport: null };
      write('layers.json', {
        kind: 'import of an external See-through result (not generated by the factory)',
        concept: prepared.inputs.concept,
        metadataSha256: set.metadataSha256,
        imageSha256: set.imageSha256,
        frame: set.frame,
        layers: set.layers,
        missing: set.missing
      });
      const missing = set.missing.length > 0 ? ` Not found (skipped by assemble-body): ${set.missing.map((tag) => safeText(tag, 64)).join(', ')}.` : '';
      return { ok: true, code: null, message: `Imported ${set.layers.length} layer files.${missing}`, exitCode: null, toolReport: null };
    }
    case 'LANDMARKS': {
      mkdirSync(out);
      const layers = JSON.parse(readOrFail(join(outputOf(context, 'L').dir, 'layers.json'), 1024 * 1024, 'The L stage report').toString('utf8')) as { imageSha256: string };
      const marks = readLandmarks((job.inputs.landmarks as { path: string }).path);
      const study = readCorrespondence((job.inputs.correspondence as { path: string }).path);
      if (marks.sha256 !== prepared.inputs.landmarks || study.sha256 !== prepared.inputs.correspondence)
        return { ok: false, code: 'E_INPUT_CHANGED', message: 'The landmark files changed during the run.', exitCode: null, toolReport: null };
      if (study.imageSha256 !== layers.imageSha256)
        return {
          ok: false,
          code: 'E_LANDMARKS_IMAGE',
          message: 'The correspondence file was made for another image: its inputs.image.sha256 is not the digest of src_img.png of the layers.',
          exitCode: null,
          toolReport: null
        };
      if (study.landmarksSha256 !== marks.sha256)
        return {
          ok: false,
          code: 'E_LANDMARKS_STUDY',
          message: 'The correspondence file was made with other marks: its inputs.manualLandmarks is not the digest of the landmark file.',
          exitCode: null,
          toolReport: null
        };
      write('landmarks.json', {
        landmarksSha256: marks.sha256,
        correspondenceSha256: study.sha256,
        imageSha256: study.imageSha256,
        count: marks.count,
        markedBy: marks.markedBy,
        method: 'manual marks (human)'
      });
      return { ok: true, code: null, message: `${marks.count} manual landmarks; the correspondence matches the marks and the image.`, exitCode: null, toolReport: null };
    }
    case 'M': {
      const metadata = (job.inputs.layers as { path: string }).path;
      const { layersDir, imagePath } = layerPaths(metadata);
      const args = [
        'assemble-body',
        '--contract',
        (job.inputs.contract as { path: string }).path,
        '--layers',
        layersDir,
        '--metadata',
        metadata,
        '--image',
        imagePath,
        '--landmarks',
        (job.inputs.landmarks as { path: string }).path,
        '--study',
        (job.inputs.correspondence as { path: string }).path,
        '--out',
        out
      ];
      const outcome = toolOutcome(runTool(prepared.tool.path, args, runDir, timeouts.M), 'assemble-body');
      if (!outcome.ok) return outcome;
      // The command read the input files itself. Check that they are still the files of the earlier stages.
      const stages = job.stages;
      const unchanged =
        readContract((job.inputs.contract as { path: string }).path).sha256 === stages.INPUT.inputs.contract &&
        readLayerSet(metadata).digest === stages.L.inputs.layerSet &&
        readLandmarks((job.inputs.landmarks as { path: string }).path).sha256 === stages.LANDMARKS.inputs.landmarks &&
        readCorrespondence((job.inputs.correspondence as { path: string }).path).sha256 === stages.LANDMARKS.inputs.correspondence;
      if (!unchanged)
        return { ok: false, code: 'E_INPUT_CHANGED', message: 'An input file changed during the assembly. Run the job again.', exitCode: outcome.exitCode, toolReport: outcome.toolReport };
      return outcome;
    }
    case 'SPINE': {
      const spine = job.tools.spine as { path: string; version: string };
      const args = ['spine-validate', '--spine', spine.path, '--package', outputOf(context, 'M').dir, '--out', out, '--spine-version', spine.version];
      const outcome = toolOutcome(runTool(prepared.tool.path, args, runDir, timeouts.SPINE), 'spine-validate');
      if (outcome.ok && lstatSync(join(out, 'body', 'export'), { throwIfNoEntry: false })?.isDirectory() !== true) {
        return { ok: false, code: 'E_SPINE_EXPORT', message: 'spine-validate returned PASS, but body/export is missing.', exitCode: outcome.exitCode, toolReport: outcome.toolReport };
      }
      return outcome;
    }
    case 'PREVIEW': {
      mkdirSync(out);
      const exportDir = join(outputOf(context, 'SPINE').dir, 'body', 'export');
      const outcome = toolOutcome(runTool(prepared.tool.path, [exportDir, '--check'], runDir, timeouts.PREVIEW), 'aigg-viewer --check');
      write('viewer-check.json', outcome.toolReport ?? { status: 'NO_REPORT' });
      const launch = ['npm', 'start', '--workspace', '@aigg/viewer', '--', exportDir];
      write('launch.json', {
        exportFolder: exportDir,
        command: launch,
        commandText: launch.map(quote).join(' '),
        url: 'http://127.0.0.1:5180/',
        note: 'Run the command from the repository root, then open the URL.'
      });
      return outcome.ok ? { ...outcome, message: `The export passes the viewer checks. Play it with: ${launch.map(quote).join(' ')}` } : outcome;
    }
    default:
      return fail('E_INTERNAL', `${id} is not an automatic stage.`);
  }
}

function runStage(context: Context, id: StageId, prepared: Prepared): StageRecord {
  const { jobDir, job } = context;
  const previous = job.stages[id];
  const attempts = previous.attempts + 1;
  const runId = `${attempts}-${randomId()}`;
  const relative = `stages/${id}/runs/${runId}`;
  const runDir = join(jobDir, relative);
  mkdirSync(join(jobDir, 'stages', id, 'runs'), { recursive: true });
  mkdirSync(runDir);
  const started: StageRecord = {
    ...previous,
    status: 'RUNNING',
    runId,
    attempts,
    startedAt: now(),
    endedAt: null,
    fingerprint: prepared.fingerprint,
    inputs: prepared.inputs,
    params: prepared.params,
    tool: prepared.tool,
    output: null,
    report: null,
    exitCode: null,
    code: null,
    message: null
  };
  job.stages[id] = started;
  saveJob(jobDir, job);
  let outcome: Outcome;
  try {
    outcome = execute(context, id, prepared, runDir);
  } catch (error) {
    outcome = {
      ok: false,
      code: error instanceof FactoryError ? error.code : 'E_INTERNAL',
      message: safeText(error instanceof Error ? error.message : error, 600),
      exitCode: null,
      toolReport: null,
      ambiguous: !(error instanceof FactoryError)
    };
  }
  let output: StageRecord['output'] = null;
  if (outcome.ok) {
    try {
      const digest = digestDirectory(join(runDir, 'out'));
      output = { dir: `${relative}/out`, digest: digest.digest, files: digest.files };
    } catch (error) {
      outcome = {
        ok: false,
        code: error instanceof FactoryError ? error.code : 'E_INTERNAL',
        message: `The output cannot be read: ${safeText(error instanceof Error ? error.message : error)}`,
        exitCode: outcome.exitCode,
        toolReport: outcome.toolReport
      };
    }
  }
  const status: StageRecord['status'] = outcome.ok ? 'PASS' : outcome.ambiguous === true ? 'ERROR' : 'FAIL';
  const finished: StageRecord = { ...started, status, endedAt: now(), output, report: `${relative}/report.json`, exitCode: outcome.exitCode, code: outcome.code, message: outcome.message };
  writeNewFile(
    join(runDir, 'report.json'),
    `${JSON.stringify({ format: stageReportFormat, jobId: job.jobId, stage: id, kind: stageKinds[id], ...finished, toolReport: summary(outcome.toolReport), logs: stageKinds[id] === 'auto' && id !== 'INPUT' ? { stdout: `${relative}/stdout.json`, stderr: `${relative}/stderr.txt` } : null }, null, 2)}\n`
  );
  // PASS is written only now, after the output digest and the report. A crash before this line leaves RUNNING, never PASS.
  job.stages[id] = finished;
  saveJob(jobDir, job);
  return finished;
}

/** Marks a stage that has no executable as failed (for example a Spine path that does not exist), without a run folder. */
function recordFailure(context: Context, id: StageId, code: string, message: string): void {
  const record = context.job.stages[id];
  if (record.status === 'FAIL' && record.code === code && record.message === message) return;
  context.job.stages[id] = { ...record, status: 'FAIL', fingerprint: null, endedAt: now(), output: null, report: null, exitCode: null, code, message };
  saveJob(context.jobDir, context.job);
}

// ---- Plan, run, status ----

export type RunOptions = { readonly retry?: boolean; readonly execute: boolean };

function refreshInputDigests(job: JobManifest): void {
  const digests: Record<InputName, (path: string) => string> = {
    contract: (path) => readContract(path).sha256,
    concept: (path) => readConcept(path).sha256,
    layers: (path) => readLayerSet(path).digest,
    landmarks: (path) => readLandmarks(path).sha256,
    correspondence: (path) => readCorrespondence(path).sha256
  };
  for (const name of inputNames) {
    const input = job.inputs[name];
    if (input === null) continue;
    try {
      input.sha256 = digests[name](input.path);
    } catch (error) {
      if (!(error instanceof FactoryError)) throw error;
      input.sha256 = null;
    }
  }
}

function overall(views: readonly StageView[]): JobStatus {
  const first = views.find((view) => view.state !== 'DONE' && view.state !== 'APPROVED');
  if (first === undefined) return 'COMPLETE';
  const map: Partial<Record<StageState, JobStatus>> = {
    WAITING_FOR_INPUT: 'WAITING_FOR_INPUT',
    WAITING_FOR_APPROVAL: 'WAITING_FOR_APPROVAL',
    REJECTED: 'REJECTED',
    FAILED: 'FAILED',
    RUNNING: 'RUNNING'
  };
  return map[first.state] ?? 'READY';
}

function walk(jobDir: string, job: JobManifest, options: RunOptions): { views: StageView[]; ran: StageId[]; skipped: StageId[] } {
  const context: Context = { jobDir, job, factoryTool: null, done: new Map() };
  const views: StageView[] = [];
  const ran: StageId[] = [];
  const skipped: StageId[] = [];
  let blocker: StageId | null = null;
  for (const id of stageIds) {
    if (blocker !== null) {
      const record = job.stages[id];
      views.push({ id, kind: stageKinds[id], state: 'BLOCKED', recorded: record.status, reason: `Waits for ${blocker}.`, runId: record.runId, output: record.output?.dir ?? null });
      continue;
    }
    let evaluation = evaluateStage(context, id, options.retry === true);
    if (options.execute && evaluation.view.state === 'FAILED' && evaluation.view.code !== undefined && evaluation.prepared === undefined && !isCheckpoint(id)) {
      recordFailure(context, id, evaluation.view.code, evaluation.view.reason);
    }
    if (options.execute && evaluation.runnable && evaluation.prepared !== undefined) {
      const record = runStage(context, id, evaluation.prepared);
      ran.push(id);
      evaluation = evaluateStage(context, id, false);
      if (evaluation.view.state === 'DONE') evaluation = { ...evaluation, view: { ...evaluation.view, reason: `Ran now: ${record.message ?? 'PASS'}` } };
    } else if (evaluation.view.state === 'DONE') {
      skipped.push(id);
    }
    views.push(evaluation.view);
    if (evaluation.view.state === 'DONE' || evaluation.view.state === 'APPROVED') {
      context.done.set(id, job.stages[id]);
      continue;
    }
    blocker = id;
  }
  return { views, ran, skipped };
}

function report(jobDir: string, job: JobManifest, result: { views: StageView[]; ran: StageId[]; skipped: StageId[] }): JobReport {
  const status = overall(result.views);
  const overridden = job.tools.controlCli !== null || job.tools.viewerCli !== null;
  const valid = new Set(result.views.filter((view) => view.state === 'APPROVED' || view.state === 'REJECTED').map((view) => `${view.id} ${view.digest ?? ''}`));
  return {
    format: jobReportFormat,
    jobId: job.jobId,
    job: jobDir,
    status,
    endToEnd: status !== 'COMPLETE' ? 'NOT_REACHED' : overridden ? 'NOT_APPLICABLE_TOOL_OVERRIDE' : 'PASS',
    testAsset: job.testAsset,
    ran: result.ran,
    skipped: result.skipped,
    stages: result.views,
    next:
      result.views.find((view) => view.next !== undefined && view.state !== 'APPROVED')?.next ??
      (status === 'READY'
        ? guidance(result.views.find((view) => view.state !== 'DONE' && view.state !== 'APPROVED')?.id ?? 'INPUT', 'READY', 'Nothing', 'Not applicable', 'Run the next stages.', command(jobDir, 'run'))
        : null),
    approvals: job.approvals.map((approval) => ({ ...approval, valid: valid.has(`${approval.checkpoint} ${approval.digest}`) && decisionFor(job, approval.checkpoint, approval.digest) === approval }))
  };
}

/** Shows the state and what `run` would do. It writes nothing. A RUNNING stage without a live lock shows as INTERRUPTED. */
export function planJob(jobDir: string, retry = false): JobReport {
  const full = resolve(jobDir);
  checkJobFolder(full);
  const job = readJob(full);
  if (lockOwner(full)?.alive !== true) for (const id of stageIds) if (job.stages[id].status === 'RUNNING') job.stages[id].status = 'INTERRUPTED';
  return report(full, job, walk(full, job, { execute: false, retry }));
}

/** Runs the stages in order until the job is complete or a stage stops it (a checkpoint, a missing input, or a failure). */
export function runJob(jobDir: string, options: { retry?: boolean } = {}): JobReport {
  const full = resolve(jobDir);
  checkJobFolder(full);
  return withLock(full, () => {
    const job = readJob(full);
    // The lock is ours, so a RUNNING stage is from a process that stopped (crash, kill, power loss).
    for (const id of stageIds) {
      const record = job.stages[id];
      if (record.status === 'RUNNING') job.stages[id] = { ...record, status: 'INTERRUPTED', endedAt: now(), message: `The run ${record.runId ?? ''} stopped before its end. Its folder is kept.` };
    }
    refreshInputDigests(job);
    saveJob(full, job);
    return report(full, job, walk(full, job, { execute: true, retry: options.retry === true }));
  });
}

export type Decision = { readonly checkpoint: string; readonly decision: 'approved' | 'rejected'; readonly by: string; readonly digest: string; readonly note?: string };

/**
 * Records a human decision for a checkpoint. The digest must be the current digest of the artifact, so that the decision is for the
 * artifact that the person saw. The command line asks for a confirmation in an interactive terminal before it calls this function.
 */
export function recordDecision(jobDir: string, decision: Decision): ApprovalRecord {
  const full = resolve(jobDir);
  checkJobFolder(full);
  if (!isCheckpoint(decision.checkpoint)) return fail('E_USAGE', 'The checkpoint must be W_APPROVAL, L_REVIEW, or FINAL_APPROVAL.');
  const checkpoint = decision.checkpoint;
  const by = decision.by.trim();
  if (by.length === 0 || by.length > 100 || safeText(by) !== by) fail('E_USAGE', '--by must be the name of the person, at most 100 characters.');
  if (!shaPattern.test(decision.digest)) fail('E_USAGE', '--digest must be the SHA-256 digest that status shows for the checkpoint.');
  const note = (decision.note ?? '').trim();
  if (decision.decision === 'rejected' && note.length === 0) fail('E_USAGE', 'A rejection needs --reason.');
  if (note.length > 2000) fail('E_USAGE', 'The note is too long (at most 2000 characters).');
  return withLock(full, () => {
    const job = readJob(full);
    const result = walk(full, job, { execute: false });
    const view = result.views.find((item) => item.id === checkpoint);
    if (view === undefined || view.digest === undefined) {
      return fail('E_NOT_READY', `${checkpoint} is not ready for a decision: ${view?.reason ?? 'an earlier stage is not done'}`);
    }
    if (view.digest !== decision.digest) fail('E_DIGEST_MISMATCH', `The digest is not the current digest of the ${checkpoint} artifact (${view.digest}). Look at the current artifact again.`);
    const record: ApprovalRecord = {
      checkpoint,
      decision: decision.decision,
      digest: view.digest,
      artifactVersion: view.artifactVersion ?? '',
      by,
      note,
      at: now(),
      tool: `@aigg/factory ${factoryVersion()}`
    };
    job.approvals.push(record);
    saveJob(full, job);
    return record;
  });
}
