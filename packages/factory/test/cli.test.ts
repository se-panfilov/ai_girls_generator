import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { fakeTools, temporary, tinyInputs } from './helpers';

const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));

function factory(...args: string[]): { code: number | null; json: Record<string, unknown>; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { code: result.status, json, stderr: result.stderr };
}

function newJob(): { job: string; root: string } {
  const root = temporary();
  const inputs = tinyInputs(join(root, 'in'));
  const fakes = fakeTools(join(root, 'tools'));
  const job = join(root, 'job');
  const result = factory('init', job, '--id', 'cli-job', '--contract', inputs.contract, '--concept', inputs.concept, '--control-cli', fakes.control, '--viewer-cli', fakes.viewer);
  expect(result.code, result.stderr).toBe(0);
  return { job, root };
}

describe('aigg-factory command line', () => {
  it('prints the help and refuses unknown commands and options', () => {
    expect(factory('--help').code).toBe(0);
    expect(factory('build', 'x').code).toBe(2);
    expect(factory('status', 'x', '--by', 'me').code).toBe(2);
    expect(factory('status').code).toBe(2);
  });

  it('makes a job, plans without writes (dry run), and stops at the first checkpoint with exit status 3', () => {
    const { job } = newJob();
    const before = readFileSync(join(job, 'job.json'));
    const dry = factory('run', job, '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.json).toMatchObject({ format: 'aigg.factory.job-report/0.1', status: 'READY' });
    expect(readFileSync(join(job, 'job.json')).equals(before)).toBe(true);
    expect(readdirSync(join(job, 'stages'))).toEqual([]);
    const run = factory('run', job);
    expect(run.code).toBe(3);
    expect(run.json.status).toBe('WAITING_FOR_APPROVAL');
    expect(run.stderr).toContain('Next: W_APPROVAL');
    expect(run.stderr).toContain('Continue: node packages/factory/dist/src/cli.js approve');
    const status = factory('status', job);
    expect(status.code).toBe(0);
    expect(status.json.status).toBe('WAITING_FOR_APPROVAL');
  });

  it('does not record a decision without an interactive terminal', () => {
    const { job } = newJob();
    factory('run', job);
    const digest = (factory('status', job).json.stages as { id: string; digest?: string }[]).find((stage) => stage.id === 'W_APPROVAL')?.digest ?? '';
    const result = factory('approve', job, 'W_APPROVAL', '--by', 'agent', '--digest', digest);
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ status: 'ERROR', code: 'E_TTY' });
    expect((JSON.parse(readFileSync(join(job, 'job.json'), 'utf8')) as { approvals: unknown[] }).approvals).toEqual([]);
  });

  it('refuses an existing job folder and reports errors as JSON', () => {
    const { job } = newJob();
    const again = factory('init', job);
    expect(again.code).toBe(2);
    expect(again.json).toMatchObject({ status: 'ERROR', code: 'E_JOB_EXISTS' });
    const missing = factory('status', join(job, 'nothing'));
    expect(missing.json).toMatchObject({ code: 'E_JOB_MISSING' });
    expect(existsSync(join(job, 'nothing'))).toBe(false);
  });
});
