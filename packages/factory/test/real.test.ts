import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { digestDirectory } from '@factory/files';
import { initJob, planJob, provideInput, readJob, recordDecision, runJob } from '@factory/job';
import type { CheckpointId } from '@factory/manifest';
import { describeTool } from '@factory/tools';
import { describe, expect, it } from 'vitest';

import { syntheticBody, temporary } from './helpers';

// Scenario 4 with the real assemble-body command of @aigg/control (built by the test script) on a synthetic body.
// No Spine executable is available here, so the job stops at SPINE. The decisions are made by this test in the role of a person.

function decide(job: string, checkpoint: CheckpointId): void {
  const digest = planJob(job).stages.find((stage) => stage.id === checkpoint)?.digest ?? '';
  recordDecision(job, { checkpoint, decision: 'approved', by: 'test person', digest });
}

describe('complete inputs with the real assemble-body command (scenario 4)', () => {
  it('assembles the synthetic body, stops at SPINE, and skips M on the next run', () => {
    const root = temporary();
    const inputs = syntheticBody(join(root, 'see-through result'));
    const job = join(root, 'job');
    initJob({
      jobDir: job,
      jobId: 'synthetic-body',
      inputs: { contract: inputs.contract, concept: inputs.concept, layers: inputs.layers, landmarks: inputs.landmarks, correspondence: inputs.correspondence }
    });
    runJob(job);
    decide(job, 'W_APPROVAL');
    runJob(job);
    decide(job, 'L_REVIEW');
    const report = runJob(job);
    expect(report.ran).toEqual(['LANDMARKS', 'M']);
    const m = report.stages.find((stage) => stage.id === 'M');
    expect(m?.state, m?.reason).toBe('DONE');
    expect(report.status).toBe('WAITING_FOR_INPUT');
    expect(report.next?.stage).toBe('SPINE');
    expect(report.endToEnd).toBe('NOT_REACHED');
    const record = readJob(job).stages.M;
    expect(record.tool).toMatchObject({ name: '@aigg/control', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) as string });
    const out = join(job, record.output?.dir ?? '');
    for (const file of ['spine/skeleton.json', 'character.json', 'SHA256SUMS', 'evidence/validation.json']) expect(existsSync(join(out, file)), file).toBe(true);
    const validation = JSON.parse(readFileSync(join(out, 'evidence', 'validation.json'), 'utf8')) as { overall: string };
    expect(validation.overall).toBe('WAITING_FOR_SPINE_CLI_VALIDATION');
    const stdout = JSON.parse(readFileSync(join(job, 'stages', 'M', 'runs', record.runId ?? '', 'stdout.json'), 'utf8')) as { status: string };
    expect(stdout.status).toBe('PASS');
    // The next run does not assemble again.
    const again = runJob(job);
    expect(again.ran).toEqual([]);
    expect(again.skipped).toContain('M');
    expect(digestDirectory(out).digest).toBe(record.output?.digest);
    // A Spine path that does not exist: a clear failure, and the package stays as it is.
    provideInput(job, 'spine', join(root, 'Spine.app', 'Contents', 'MacOS', 'Spine'));
    const failed = runJob(job);
    expect(failed.status).toBe('FAILED');
    expect(failed.stages.find((stage) => stage.id === 'SPINE')?.code).toBe('E_SPINE_NOT_FOUND');
    expect(digestDirectory(out).digest).toBe(record.output?.digest);
  });

  it('describes the built control command with its version and code digest', () => {
    const tool = describeTool('@aigg/control', null);
    expect(tool.path.endsWith(join('control', 'dist', 'src', 'cli.js'))).toBe(true);
    expect(tool.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
