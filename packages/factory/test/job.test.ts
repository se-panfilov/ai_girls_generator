import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { digestDirectory } from '@factory/files';
import { initJob, type JobReport, lockName, planJob, provideInput, readJob, recordDecision, runJob, type StageView } from '@factory/job';
import type { CheckpointId, StageId } from '@factory/manifest';
import { describe, expect, it } from 'vitest';

import { fakeTools, type InputFiles, manual, sha256, study, temporary, tinyInputs } from './helpers';

const stage = (report: JobReport, id: StageId): StageView => report.stages.find((item) => item.id === id) as StageView;

type Setup = { job: string; inputs: InputFiles; fakes: ReturnType<typeof fakeTools> };

function setup(options: { inputs?: boolean; spine?: boolean } = {}): Setup {
  const root = temporary();
  const inputs = tinyInputs(join(root, 'inputs'));
  const fakes = fakeTools(join(root, 'tools'));
  const job = join(root, 'job one');
  const all = options.inputs !== false;
  initJob({
    jobDir: job,
    jobId: 'test-job',
    inputs: all ? { contract: inputs.contract, concept: inputs.concept, layers: inputs.layers, landmarks: inputs.landmarks, correspondence: inputs.correspondence } : {},
    ...(options.spine === false ? {} : { spine: fakes.spine }),
    controlCli: fakes.control,
    viewerCli: fakes.viewer
  });
  return { job, inputs, fakes };
}

function decide(job: string, checkpoint: CheckpointId, decision: 'approved' | 'rejected' = 'approved', note = ''): void {
  const view = stage(planJob(job), checkpoint);
  expect(view.digest, `${checkpoint} has an artifact`).toMatch(/^[0-9a-f]{64}$/);
  recordDecision(job, { checkpoint, decision, by: 'test person', digest: view.digest as string, note });
}

function complete(job: string): JobReport {
  runJob(job);
  decide(job, 'W_APPROVAL');
  runJob(job);
  decide(job, 'L_REVIEW');
  runJob(job);
  decide(job, 'FINAL_APPROVAL');
  return runJob(job);
}

describe('checkpoints for missing inputs and decisions', () => {
  it('stops a new job without inputs at INPUT with the next action (scenario 1)', () => {
    const { job } = setup({ inputs: false });
    const report = runJob(job);
    expect(report.status).toBe('WAITING_FOR_INPUT');
    expect(stage(report, 'INPUT').state).toBe('WAITING_FOR_INPUT');
    expect(report.next?.continueWith).toContain('provide');
    expect(report.next?.continueWith).toContain('contract');
    expect(stage(report, 'M').state).toBe('BLOCKED');
    expect(report.ran).toEqual([]);
  });

  it('stops at W_APPROVAL without a concept, and waits for a person with a concept', () => {
    const { job, inputs } = setup({ inputs: false });
    provideInput(job, 'contract', inputs.contract);
    let report = runJob(job);
    expect(report.ran).toEqual(['INPUT']);
    expect(stage(report, 'W_APPROVAL').state).toBe('WAITING_FOR_INPUT');
    provideInput(job, 'concept', inputs.concept);
    report = runJob(job);
    expect(report.status).toBe('WAITING_FOR_APPROVAL');
    expect(report.next?.stage).toBe('W_APPROVAL');
    expect(report.next?.continueWith).toContain(`--digest ${sha256(readFileSync(inputs.concept))}`);
    // No decision is recorded by run.
    expect(readJob(job).approvals).toEqual([]);
  });

  it('stops at L when the concept is approved and the layers are missing (scenario 2)', () => {
    const { job, inputs } = setup({ inputs: false });
    provideInput(job, 'contract', inputs.contract);
    provideInput(job, 'concept', inputs.concept);
    runJob(job);
    decide(job, 'W_APPROVAL');
    const report = runJob(job);
    expect(stage(report, 'W_APPROVAL').state).toBe('APPROVED');
    expect(stage(report, 'L').state).toBe('WAITING_FOR_INPUT');
    expect(report.next?.missing).toContain('does not run See-through');
    expect(report.next?.format).toContain('.psd.json');
    expect(report.next?.continueWith).toContain('provide');
  });

  it('stops at LANDMARKS when the layers are reviewed and the marks are missing (scenario 3)', () => {
    const { job, inputs } = setup({ inputs: false });
    for (const name of ['contract', 'concept', 'layers'] as const) provideInput(job, name, inputs[name]);
    runJob(job);
    decide(job, 'W_APPROVAL');
    let report = runJob(job);
    expect(report.ran).toEqual(['L']);
    expect(stage(report, 'L_REVIEW').state).toBe('WAITING_FOR_APPROVAL');
    decide(job, 'L_REVIEW');
    report = runJob(job);
    expect(report.status).toBe('WAITING_FOR_INPUT');
    expect(stage(report, 'LANDMARKS').state).toBe('WAITING_FOR_INPUT');
    expect(report.next?.action).toContain('annotate-page');
    expect(report.next?.action).toContain('align-study');
    expect(report.next?.continueWith).toContain('provide');
  });

  it('does not advance after a rejection (scenario 9)', () => {
    const { job, fakes } = setup();
    runJob(job);
    decide(job, 'W_APPROVAL', 'rejected', 'Not the selected concept.');
    const report = runJob(job);
    expect(report.status).toBe('REJECTED');
    expect(stage(report, 'W_APPROVAL').state).toBe('REJECTED');
    expect(stage(report, 'L').state).toBe('BLOCKED');
    expect(report.ran).toEqual([]);
    expect(fakes.calls()).toEqual([]);
  });
});

describe('a complete job with fake commands', () => {
  it('runs all stages, records the provenance, and reports no end-to-end PASS for fake commands', () => {
    const { job, fakes } = setup();
    const report = complete(job);
    expect(report.status).toBe('COMPLETE');
    expect(report.endToEnd).toBe('NOT_APPLICABLE_TOOL_OVERRIDE');
    expect(fakes.calls()).toEqual(['assemble-body', 'spine-validate', 'viewer-check']);
    const manifest = readJob(job);
    for (const id of ['INPUT', 'L', 'LANDMARKS', 'M', 'SPINE', 'PREVIEW'] as const) {
      const record = manifest.stages[id];
      expect(record.status, id).toBe('PASS');
      expect(record.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(record.output?.digest).toBe(digestDirectory(join(job, record.output?.dir ?? '')).digest);
      const stageReport = JSON.parse(readFileSync(join(job, record.report ?? ''), 'utf8')) as { format: string; status: string };
      expect(stageReport).toMatchObject({ format: 'aigg.factory.stage-report/0.1', status: 'PASS' });
    }
    expect(manifest.stages.M.tool?.path).toBe(fakes.control);
    expect(Object.values(manifest.inputs).every((input) => input?.sha256 !== null)).toBe(true);
    const launch = JSON.parse(readFileSync(join(job, manifest.stages.PREVIEW.output?.dir ?? '', 'launch.json'), 'utf8')) as { command: string[] };
    expect(launch.command.slice(0, 5)).toEqual(['npm', 'start', '--workspace', '@aigg/viewer', '--']);
    expect(manifest.approvals.map((approval) => approval.checkpoint)).toEqual(['W_APPROVAL', 'L_REVIEW', 'FINAL_APPROVAL']);
  });

  it('skips the completed stages when nothing changed (scenario 6)', () => {
    const { job, fakes } = setup();
    complete(job);
    const before = readFileSync(join(job, 'job.json'), 'utf8');
    const calls = fakes.calls().length;
    const report = runJob(job);
    expect(report.status).toBe('COMPLETE');
    expect(report.ran).toEqual([]);
    expect(report.skipped).toEqual(['INPUT', 'L', 'LANDMARKS', 'M', 'SPINE', 'PREVIEW']);
    expect(fakes.calls()).toHaveLength(calls);
    const after = readJob(job);
    expect(after.stages).toEqual((JSON.parse(before) as { stages: unknown }).stages);
  });

  it('makes the dependent stages stale after an input change, keeps the old outputs, and needs a new final approval (scenario 7)', () => {
    const { job, inputs } = setup();
    complete(job);
    const old = readJob(job);
    const oldM = old.stages.M.output;
    // New marks: a new landmark file and a matching correspondence file.
    const image = readFileSync(join(inputs.layersDir, 'src_img.png'));
    const marks = manual({ neck_base: { x: 5, y: 2 } });
    writeFileSync(inputs.landmarks, marks);
    writeFileSync(inputs.correspondence, study(marks, sha256(image)));
    const plan = planJob(job);
    expect(stage(plan, 'L').state).toBe('DONE');
    expect(stage(plan, 'LANDMARKS').state).toBe('STALE');
    expect(stage(plan, 'LANDMARKS').reason).toContain('landmarks');
    const report = runJob(job);
    expect(report.ran).toEqual(['LANDMARKS', 'M', 'SPINE', 'PREVIEW']);
    expect(report.skipped).toEqual(['INPUT', 'L']);
    expect(report.status).toBe('WAITING_FOR_APPROVAL');
    expect(stage(report, 'FINAL_APPROVAL').reason).toContain('not valid');
    expect(report.approvals.find((approval) => approval.checkpoint === 'FINAL_APPROVAL')?.valid).toBe(false);
    expect(report.approvals.find((approval) => approval.checkpoint === 'L_REVIEW')?.valid).toBe(true);
    // The old output is kept unchanged in its run folder.
    expect(oldM).not.toBeNull();
    expect(digestDirectory(join(job, oldM?.dir ?? '')).digest).toBe(oldM?.digest);
    expect(readJob(job).stages.M.output?.dir).not.toBe(oldM?.dir);
  });

  it('invalidates an approval when the approved artifact changes (scenario 10)', () => {
    const { job, inputs } = setup();
    runJob(job);
    decide(job, 'W_APPROVAL');
    runJob(job);
    decide(job, 'L_REVIEW');
    expect(stage(runJob(job), 'L_REVIEW').state).toBe('APPROVED');
    writeFileSync(join(inputs.layersDir, 'face.png'), readFileSync(join(inputs.layersDir, 'body.png')));
    expect(stage(planJob(job), 'L').state).toBe('STALE');
    const report = runJob(job);
    expect(report.ran).toEqual(['L']);
    expect(report.status).toBe('WAITING_FOR_APPROVAL');
    expect(stage(report, 'L_REVIEW').state).toBe('WAITING_FOR_APPROVAL');
    expect(stage(report, 'L_REVIEW').reason).toContain('not valid');
    expect(stage(report, 'M').state).toBe('BLOCKED');
    expect(report.approvals.find((approval) => approval.checkpoint === 'L_REVIEW')?.valid).toBe(false);
  });

  it('invalidates the concept approval when the concept file changes', () => {
    const { job, inputs } = setup();
    runJob(job);
    decide(job, 'W_APPROVAL');
    writeFileSync(inputs.concept, readFileSync(join(inputs.layersDir, 'face.png')));
    const report = runJob(job);
    expect(stage(report, 'W_APPROVAL').state).toBe('WAITING_FOR_APPROVAL');
    expect(stage(report, 'L').state).toBe('BLOCKED');
  });

  it('runs a stage again when its output is missing or changed', () => {
    const { job, fakes } = setup();
    complete(job);
    const output = readJob(job).stages.SPINE.output?.dir ?? '';
    writeFileSync(join(job, output, 'body', 'export', 'skeleton.json'), '{}');
    expect(stage(planJob(job), 'SPINE').state).toBe('INVALID');
    const report = runJob(job);
    expect(report.ran[0]).toBe('SPINE');
    expect(fakes.calls().filter((call) => call === 'spine-validate')).toHaveLength(2);
    // The changed old run folder is kept as it is; the new run has a new folder.
    expect(existsSync(join(job, output))).toBe(true);
  });
});

describe('failures', () => {
  it('fails clearly and changes nothing when the Spine executable does not exist (scenario 5)', () => {
    const { job, fakes } = setup({ spine: false });
    runJob(job);
    decide(job, 'W_APPROVAL');
    runJob(job);
    decide(job, 'L_REVIEW');
    let report = runJob(job);
    expect(stage(report, 'M').state).toBe('DONE');
    expect(stage(report, 'SPINE').state).toBe('WAITING_FOR_INPUT');
    expect(report.next?.continueWith).toContain('provide');
    const m = readJob(job).stages.M.output;
    provideInput(job, 'spine', join(fakes.folder, 'no such Spine'));
    report = runJob(job);
    expect(report.status).toBe('FAILED');
    expect(stage(report, 'SPINE').state).toBe('FAILED');
    expect(stage(report, 'SPINE').code).toBe('E_SPINE_NOT_FOUND');
    expect(report.next?.continueWith).toContain('provide');
    expect(fakes.calls()).toEqual(['assemble-body']);
    expect(existsSync(join(job, 'stages', 'SPINE'))).toBe(false);
    const after = readJob(job);
    expect(after.stages.M.output).toEqual(m);
    expect(digestDirectory(join(job, m?.dir ?? '')).digest).toBe(m?.digest);
    expect(after.stages.SPINE).toMatchObject({ status: 'FAIL', code: 'E_SPINE_NOT_FOUND' });
    // The correct path continues the job.
    provideInput(job, 'spine', fakes.spine);
    report = runJob(job);
    expect(report.ran).toEqual(['SPINE', 'PREVIEW']);
    expect(report.status).toBe('WAITING_FOR_APPROVAL');
  });

  it('does not retry a failed stage automatically', () => {
    const { job, fakes } = setup();
    fakes.setMode({ assemble: 'fail' });
    runJob(job);
    decide(job, 'W_APPROVAL');
    runJob(job);
    decide(job, 'L_REVIEW');
    let report = runJob(job);
    expect(report.status).toBe('FAILED');
    expect(stage(report, 'M').reason).toContain('The fake assembly failed.');
    expect(readJob(job).stages.M.status).toBe('FAIL');
    report = runJob(job);
    expect(report.ran).toEqual([]);
    expect(fakes.calls()).toEqual(['assemble-body']);
    fakes.setMode({});
    report = runJob(job, { retry: true });
    expect(report.ran).toEqual(['M', 'SPINE', 'PREVIEW']);
  });

  it('fails LANDMARKS when the correspondence was made for another image', () => {
    const { job, inputs } = setup();
    writeFileSync(inputs.correspondence, study(readFileSync(inputs.landmarks), sha256('another image')));
    runJob(job);
    decide(job, 'W_APPROVAL');
    runJob(job);
    decide(job, 'L_REVIEW');
    const report = runJob(job);
    expect(stage(report, 'LANDMARKS').state).toBe('FAILED');
    expect(stage(report, 'LANDMARKS').code).toBe('E_LANDMARKS_IMAGE');
  });

  it('leaves no PASS after an interrupted stage and continues safely (scenario 8)', async () => {
    const { job, fakes } = setup();
    runJob(job);
    decide(job, 'W_APPROVAL');
    runJob(job);
    decide(job, 'L_REVIEW');
    fakes.setMode({ assemble: 'sleep' });
    const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'run', job], { stdio: 'ignore' });
    const started = join(fakes.folder, 'started.json');
    for (let wait = 0; wait < 200 && !existsSync(started); wait += 1) await new Promise((done) => setTimeout(done, 50));
    expect(existsSync(started)).toBe(true);
    child.kill('SIGKILL');
    await new Promise((done) => child.once('exit', done));
    process.kill((JSON.parse(readFileSync(started, 'utf8')) as { pid: number }).pid, 'SIGKILL');
    const crashed = readJob(job);
    expect(crashed.stages.M.status).toBe('RUNNING');
    expect(crashed.stages.M.output).toBeNull();
    expect(existsSync(join(job, lockName))).toBe(true);
    const interruptedRun = crashed.stages.M.runId;
    expect(stage(planJob(job), 'M').state).toBe('INTERRUPTED');
    fakes.setMode({});
    const report = runJob(job);
    expect(report.ran).toEqual(['M', 'SPINE', 'PREVIEW']);
    const after = readJob(job);
    expect(after.stages.M.status).toBe('PASS');
    expect(after.stages.M.runId).not.toBe(interruptedRun);
    expect(after.stages.M.attempts).toBe(2);
    expect(existsSync(join(job, 'stages', 'M', 'runs', interruptedRun ?? ''))).toBe(true);
    expect(existsSync(join(job, lockName))).toBe(false);
  });
});

describe('decisions', () => {
  it('refuses a decision for another digest or before the artifact exists', () => {
    const { job } = setup();
    expect(() => recordDecision(job, { checkpoint: 'L_REVIEW', decision: 'approved', by: 'test person', digest: '0'.repeat(64) })).toThrow(/not ready/);
    runJob(job);
    expect(() => recordDecision(job, { checkpoint: 'W_APPROVAL', decision: 'approved', by: 'test person', digest: '0'.repeat(64) })).toThrow(/not the current digest/);
    expect(() => recordDecision(job, { checkpoint: 'W_APPROVAL', decision: 'rejected', by: 'test person', digest: stage(planJob(job), 'W_APPROVAL').digest ?? '' })).toThrow(/--reason/);
    expect(() => recordDecision(job, { checkpoint: 'M', decision: 'approved', by: 'test person', digest: '0'.repeat(64) })).toThrow(/checkpoint/);
    expect(readJob(job).approvals).toEqual([]);
  });

  it('uses the last decision for the same artifact', () => {
    const { job } = setup();
    runJob(job);
    decide(job, 'W_APPROVAL', 'rejected', 'Wrong file.');
    expect(runJob(job).status).toBe('REJECTED');
    decide(job, 'W_APPROVAL');
    expect(stage(runJob(job), 'W_APPROVAL').state).toBe('APPROVED');
    expect(readJob(job).approvals).toHaveLength(2);
  });
});

describe('job folder', () => {
  it('never replaces an existing job and refuses a second process', () => {
    const { job, inputs } = setup();
    expect(() => initJob({ jobDir: job })).toThrow(/not empty/);
    writeFileSync(join(job, lockName), JSON.stringify({ pid: process.pid }));
    expect(() => runJob(job)).toThrow(/Another process/);
    expect(() => provideInput(job, 'concept', inputs.concept)).toThrow(/Another process/);
    rmSync(join(job, lockName));
    writeFileSync(join(job, lockName), JSON.stringify({ pid: 2 ** 22 + 12345 }));
    expect(runJob(job).ran).toEqual(['INPUT']);
  });

  it('keeps earlier input paths in the history', () => {
    const { job, inputs } = setup();
    provideInput(job, 'concept', inputs.concept);
    expect(readJob(job).inputHistory).toEqual([expect.objectContaining({ name: 'concept', path: inputs.concept })]);
    expect(() => provideInput(job, 'concept', join(inputs.layersDir, 'missing.png'))).toThrow(/does not exist/);
    expect(() => provideInput(job, 'layers', inputs.concept)).toThrow(/psd\.json/);
    expect(() => provideInput(job, 'spine', 'relative/Spine')).toThrow(/absolute/);
  });

  it('rejects a job.json with an unknown field', () => {
    const { job } = setup();
    const manifest = JSON.parse(readFileSync(join(job, 'job.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(job, 'job.json'), JSON.stringify({ ...manifest, extra: true }));
    expect(() => planJob(job)).toThrow(/not a known field/);
  });
});
