#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { FactoryError, safeText } from '@factory/files';
import { factoryCommand, initJob, type JobReport, planJob, provideInput, recordDecision, runJob } from '@factory/job';
import { type InputName, inputNames } from '@factory/manifest';

const help = `Usage: aigg-factory <command> <job-folder> [options]

Run the existing pipeline stages of one character as one local job: INPUT, W_APPROVAL, L (import of a See-through result),
L_REVIEW, LANDMARKS (manual marks), M (assemble-body), SPINE (spine-validate with the licensed Spine), PREVIEW (aigg-viewer --check),
FINAL_APPROVAL. The job folder holds job.json and one folder for each stage run. Input files are read, never changed.

Commands:
  init <job-folder> [--id <id>] [--test-asset] [--contract <file>] [--concept <png>] [--layers <stem.psd.json>]
       [--landmarks <file>] [--correspondence <file>] [--spine <absolute path>] [--spine-version <v>]
                     make a new job in a new or empty folder
  provide <job-folder> <input> <path> [--spine-version <v>]
                     give or replace one input: ${[...inputNames, 'spine'].join(', ')}
  plan <job-folder> [--retry]
                     show what run would do; write nothing
  status <job-folder>
                     show the state of each stage, the decisions, and the next action; write nothing
  run <job-folder> [--retry] [--dry-run]
                     run the stages until the job is complete or a stage stops it
  resume <job-folder> [--retry]
                     the same as run (continue after an input, a decision, or an interruption)
  approve <job-folder> <checkpoint> --by <name> --digest <sha256> [--note <text>]
  reject <job-folder> <checkpoint> --by <name> --digest <sha256> --reason <text>
                     record a human decision for W_APPROVAL, L_REVIEW, or FINAL_APPROVAL (interactive terminal only)

Options:
  --retry            run a failed stage again with the same inputs (failed stages are not retried automatically)
  --dry-run          with run: the same as plan
  --control-cli, --viewer-cli <file>
                     with init, for tests only: use another command. Such a job never reports an end-to-end PASS.
  --help             show this help

Output: one JSON report on stdout. A short summary for people on stderr.
Exit status: 0 complete (or plan, status, provide, decision done), 1 failed or rejected, 2 usage or other error,
3 the job waits for an input or a human decision.`;

const options = {
  id: { type: 'string' },
  'test-asset': { type: 'boolean' },
  contract: { type: 'string' },
  concept: { type: 'string' },
  layers: { type: 'string' },
  landmarks: { type: 'string' },
  correspondence: { type: 'string' },
  spine: { type: 'string' },
  'spine-version': { type: 'string' },
  'control-cli': { type: 'string' },
  'viewer-cli': { type: 'string' },
  retry: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  by: { type: 'string' },
  digest: { type: 'string' },
  note: { type: 'string' },
  reason: { type: 'string' },
  help: { type: 'boolean' }
} as const;

const allowed: Record<string, readonly string[]> = {
  init: ['id', 'test-asset', ...inputNames, 'spine', 'spine-version', 'control-cli', 'viewer-cli'],
  provide: ['spine-version'],
  plan: ['retry'],
  status: [],
  run: ['retry', 'dry-run'],
  resume: ['retry'],
  approve: ['by', 'digest', 'note'],
  reject: ['by', 'digest', 'reason']
};

const positionalCount: Record<string, number> = { init: 1, provide: 3, plan: 1, status: 1, run: 1, resume: 1, approve: 2, reject: 2 };

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};
const say = (text: string): void => {
  process.stderr.write(`${text}\n`);
};

function describe(report: JobReport): void {
  say(`Job ${safeText(report.jobId, 64)}: ${report.status}${report.testAsset ? ' (licensed test character)' : ''}`);
  for (const stage of report.stages) say(`  ${stage.id.padEnd(15)} ${stage.state.padEnd(21)} ${safeText(stage.reason, 200)}`);
  if (report.ran.length > 0) say(`Ran: ${report.ran.join(', ')}.`);
  if (report.skipped.length > 0) say(`Unchanged (skipped): ${report.skipped.join(', ')}.`);
  const next = report.next;
  if (next !== null) {
    say(`\nNext: ${next.stage} (${next.status})`);
    say(`  Missing:  ${safeText(next.missing, 400)}`);
    say(`  Format:   ${safeText(next.format, 400)}`);
    say(`  Action:   ${safeText(next.action, 1200)}`);
    say(`  Continue: ${safeText(next.continueWith, 600)}`);
  }
}

const exitFor = (report: JobReport): number => (report.status === 'COMPLETE' ? 0 : report.status === 'FAILED' || report.status === 'REJECTED' ? 1 : 3);

/** Asks the person to type the checkpoint name. Without an interactive terminal it stops: a decision is never recorded for a person. */
async function confirm(checkpoint: string, decision: string, digest: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new FactoryError('E_TTY', 'A decision needs an interactive terminal: a person must type the confirmation. It is not recorded.');
  }
  say(`You ${decision === 'approved' ? 'approve' : 'reject'} ${checkpoint} for the artifact ${digest}.`);
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await lines.question(`Type ${checkpoint} to confirm: `);
    return answer.trim() === checkpoint;
  } finally {
    lines.close();
  }
}

async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
  } catch (error) {
    say(`${safeText(error instanceof Error ? error.message : error)}\n\n${help}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [commandName, ...rest] = positionals;
  if (values.help === true || commandName === undefined) {
    process.stdout.write(`${help}\n`);
    return values.help === true ? 0 : 2;
  }
  const accepted = allowed[commandName];
  if (accepted === undefined) {
    say(`Unknown command ${JSON.stringify(safeText(commandName, 40))}. Run aigg-factory --help.`);
    return 2;
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && key !== 'help' && !accepted.includes(key)) {
      say(`The option --${key} is not valid for ${commandName}.`);
      return 2;
    }
  }
  if (rest.length !== positionalCount[commandName]) {
    say(`${commandName} needs ${positionalCount[commandName] ?? 0} argument(s). Run aigg-factory --help.`);
    return 2;
  }
  const jobDir = rest[0] as string;
  try {
    switch (commandName) {
      case 'init': {
        const inputs: Partial<Record<InputName, string>> = {};
        for (const name of inputNames) if (values[name] !== undefined) inputs[name] = values[name];
        initJob({
          jobDir,
          inputs,
          testAsset: values['test-asset'] === true,
          ...(values.id === undefined ? {} : { jobId: values.id }),
          ...(values.spine === undefined ? {} : { spine: values.spine }),
          ...(values['spine-version'] === undefined ? {} : { spineVersion: values['spine-version'] }),
          ...(values['control-cli'] === undefined ? {} : { controlCli: values['control-cli'] }),
          ...(values['viewer-cli'] === undefined ? {} : { viewerCli: values['viewer-cli'] })
        });
        const report = planJob(jobDir);
        print(report);
        say(`Created the job in ${safeText(report.job)}.`);
        describe(report);
        return 0;
      }
      case 'provide': {
        provideInput(jobDir, rest[1] as string, rest[2] as string, values['spine-version']);
        const report = planJob(jobDir);
        print(report);
        say(`Registered ${safeText(rest[1], 40)}.`);
        describe(report);
        return 0;
      }
      case 'plan':
      case 'status': {
        const report = planJob(jobDir, values.retry === true);
        print(report);
        describe(report);
        return 0;
      }
      case 'run':
      case 'resume': {
        if (values['dry-run'] === true) {
          const report = planJob(jobDir, values.retry === true);
          print(report);
          describe(report);
          return 0;
        }
        const report = runJob(jobDir, { retry: values.retry === true });
        print(report);
        describe(report);
        return exitFor(report);
      }
      default: {
        const checkpoint = rest[1] as string;
        const decision = commandName === 'approve' ? 'approved' : 'rejected';
        if (values.by === undefined || values.digest === undefined) throw new FactoryError('E_USAGE', `${commandName} needs --by and --digest.`);
        const note = commandName === 'approve' ? values.note : values.reason;
        if (!(await confirm(checkpoint, decision, values.digest))) {
          say('The confirmation does not match. Nothing is recorded.');
          return 2;
        }
        const record = recordDecision(jobDir, { checkpoint, decision, by: values.by, digest: values.digest, ...(note === undefined ? {} : { note }) });
        print({ format: 'aigg.factory.decision/0.1', status: 'RECORDED', decision: record });
        say(`Recorded: ${checkpoint} ${decision} by ${safeText(record.by, 100)}. Continue with: ${factoryCommand} run ${safeText(jobDir)}`);
        return 0;
      }
    }
  } catch (error) {
    const code = error instanceof FactoryError ? error.code : 'E_INTERNAL';
    const message = safeText(error instanceof Error ? error.message : error, 1000);
    print({ format: 'aigg.factory.error/0.1', status: 'ERROR', code, message });
    say(`Error ${code}: ${message}`);
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
