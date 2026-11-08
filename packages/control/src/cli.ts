#!/usr/bin/env node
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { bundleCommand } from '@control/bundle';
import { calibrateCommand, candidateCommand, type CommandResult, depthCommand, maxContractBytes, overlayCommand, poseCommand, workflowCommand } from '@control/commands';
import { checkOutputDirectory, readInput, writeFiles } from '@control/output';
import { defaultPngLimits } from '@control/png';
import { type SideMapping, sideMappings } from '@control/pose';
import { ControlError, fail, isRecord } from '@control/problems';
import { templateCommand } from '@control/template';

const help = `Usage: aigg-control <command> [options]

Commands:
  pose --contract <rig.contract.json> --out <dir> [--size WxH] [--mapping detector|anatomical|both]
      Write OpenPose control images and keypoints, a proportion reference (PNG and SVG), and control.json.
      The default size is the contract generation resolution. The canvas is scaled uniformly and centered.
  workflow --pose-image <openpose.png> --out <dir> --checkpoint <file.safetensors> --controlnet <file.safetensors>
           [--seeds 1001,1002,1003] [--baseline-seed N] [--checkpoint-sha256 HEX] [--controlnet-sha256 HEX]
      Write ComfyUI API workflows for one text-only baseline and one to three pose-guided runs, and run-plan.json.
      It does not contact a server and does not run a model.
  overlay --contract <rig.contract.json> --image <generated.png> --out <dir> [--mapping detector|anatomical] [--marks <marks.json>]
      Draw the rig over an image and write a side-by-side sheet. With manual marks, measure the joint error.

  candidate --base <rig.contract.json> --out <dir> [--yaw DEGREES]
      Write the C0.5 candidate rig contract (experimental) from a base contract, and check it.
  calibrate --before <rig.contract.json> --after <rig.contract.json> --out <dir> [--skeleton <skeleton.json>] [--size WxH]
      Write before and after mannequins, joint and slot overlays, OpenPose images, a comparison sheet,
      animation key poses (with --skeleton), consistency checks, and the migration table.

  depth --contract <C0.5 candidate rig.contract.json> --out <dir> [--size WxH]
      Write the approximate depth image of the C0.5 reference body (simple volumes), a shaded part view, a top view,
      a preview sheet for review, and depth.json with the assumptions and the checks D1 to D7.

  bundle --contract <C0.5 candidate rig.contract.json> --out <dir> [--experiment c1|c2]
      Write an experiment C execution bundle: run.sh, runner.mjs, bundle.json (model manifest), the control images,
      the workflows, run-plan.json, README.md, and SHA256SUMS. c1 (default): one baseline and one pose-guided run, seed 1001.
      c2: OpenPose only and OpenPose + depth, seeds 1001, 1002, 1003 (six runs).
      The owner copies it to the GPU host and runs it there. This command does not contact a server.

  template --contract <C0.5 candidate rig.contract.json> --out <dir> [--size WxH]
      Write the T1a static template of the C0.5 prototype: template.json, contour-lineart.png, region-map.png,
      masks/<slot>.visible.png, overlay-sheet.png, review.md, and mock-package/ (flat parts and character.json).
      Prototype only: it does not show that the parts animate correctly. The default size is the contract generation resolution.

Common options:
  --dry-run   Print the report and write nothing.
  --force     Replace files with the same names in an existing output directory.
  --help      Print this text.

Each command writes one JSON report to stdout. Exit status: 0 PASS, 1 FAIL, 2 usage or input error, 3 INCOMPLETE.
`;

const options = {
  contract: { type: 'string' },
  out: { type: 'string' },
  size: { type: 'string' },
  mapping: { type: 'string' },
  'pose-image': { type: 'string' },
  checkpoint: { type: 'string' },
  controlnet: { type: 'string' },
  'checkpoint-sha256': { type: 'string' },
  'controlnet-sha256': { type: 'string' },
  seeds: { type: 'string' },
  'baseline-seed': { type: 'string' },
  image: { type: 'string' },
  base: { type: 'string' },
  yaw: { type: 'string' },
  before: { type: 'string' },
  after: { type: 'string' },
  skeleton: { type: 'string' },
  marks: { type: 'string' },
  experiment: { type: 'string' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  help: { type: 'boolean' }
} as const;

const allowed: Record<string, readonly string[]> = {
  pose: ['contract', 'out', 'size', 'mapping'],
  workflow: ['pose-image', 'out', 'checkpoint', 'controlnet', 'checkpoint-sha256', 'controlnet-sha256', 'seeds', 'baseline-seed'],
  overlay: ['contract', 'image', 'out', 'mapping', 'marks'],
  candidate: ['base', 'out', 'yaw'],
  calibrate: ['before', 'after', 'skeleton', 'size', 'out'],
  depth: ['contract', 'out', 'size'],
  bundle: ['contract', 'out', 'experiment'],
  template: ['contract', 'out', 'size']
};

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === '') fail('E_USAGE', `--${name} is required.`);
  return value;
}

function seed(text: string): number {
  if (!/^\d{1,10}$/.test(text) || Number(text) > 2 ** 32 - 1) fail('E_USAGE', `${JSON.stringify(text.slice(0, 20))} is not a seed from 0 to 4294967295.`);
  return Number(text);
}

function mappingList(text: string | undefined, allowBoth: boolean): SideMapping[] {
  if (text === undefined) return allowBoth ? [...sideMappings] : ['detector'];
  if (allowBoth && text === 'both') return [...sideMappings];
  if (!(sideMappings as readonly string[]).includes(text)) fail('E_USAGE', `--mapping must be ${allowBoth ? 'detector, anatomical, or both' : 'detector or anatomical'}.`);
  return [text as SideMapping];
}

function run(argv: readonly string[]): { result: CommandResult | null; dryRun: boolean; out: string | null; force: boolean } {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
  } catch (error) {
    fail('E_USAGE', error instanceof Error ? error.message : 'The arguments are not valid.');
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    process.stdout.write(help);
    return { result: null, dryRun: true, out: null, force: false };
  }
  const [command, ...rest] = positionals;
  if (command === undefined || !(command in allowed)) fail('E_USAGE', 'Unknown command. Run aigg-control --help.');
  if (rest.length > 0) fail('E_USAGE', 'Unexpected positional arguments.');
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || ['dry-run', 'force', 'help'].includes(key)) continue;
    if (!(allowed[command] ?? []).includes(key)) fail('E_USAGE', `The option --${key} is not valid for ${command}.`);
  }
  const out = required(values.out, 'out');
  const dryRun = values['dry-run'] === true;
  const force = values.force === true;
  if (command === 'pose') {
    const bytes = readInput(required(values.contract, 'contract'), maxContractBytes, 'The contract file');
    return { result: poseCommand(bytes, values.size, mappingList(values.mapping, true)), dryRun, out, force };
  }
  if (command === 'workflow') {
    const posePath = required(values['pose-image'], 'pose-image');
    const bytes = readInput(posePath, defaultPngLimits.maxBytes, 'The pose image');
    const seeds = (values.seeds ?? '1001,1002,1003').split(',').map(seed);
    if (new Set(seeds).size !== seeds.length) fail('E_USAGE', 'The seeds must be different.');
    const poseImageName = basename(posePath);
    const result = workflowCommand({
      checkpoint: required(values.checkpoint, 'checkpoint'),
      controlNet: required(values.controlnet, 'controlnet'),
      ...(values['checkpoint-sha256'] === undefined ? {} : { checkpointSha256: values['checkpoint-sha256'] }),
      ...(values['controlnet-sha256'] === undefined ? {} : { controlNetSha256: values['controlnet-sha256'] }),
      ...(values['baseline-seed'] === undefined ? {} : { baselineSeed: seed(values['baseline-seed']) }),
      seeds,
      poseImageName,
      poseImageBytes: bytes
    });
    return { result, dryRun, out, force };
  }
  if (command === 'candidate') {
    const bytes = readInput(required(values.base, 'base'), maxContractBytes, 'The base contract');
    let yaw: number | undefined;
    if (values.yaw !== undefined) {
      if (!/^\d{1,2}(\.\d{1,3})?$/.test(values.yaw)) fail('E_USAGE', '--yaw must be a number of degrees, for example 40.');
      yaw = Number(values.yaw);
    }
    return { result: candidateCommand(bytes, yaw), dryRun, out, force };
  }
  if (command === 'bundle') {
    const contractBytes = readInput(required(values.contract, 'contract'), maxContractBytes, 'The contract file');
    const runnerBytes = readInput(join(dirname(fileURLToPath(import.meta.url)), 'runner.js'), 4 * 1024 * 1024, 'The compiled runner');
    const experiment = values.experiment ?? 'c1';
    if (experiment !== 'c1' && experiment !== 'c2') fail('E_USAGE', '--experiment must be c1 or c2.');
    return { result: bundleCommand({ contractBytes, runnerBytes, experiment }), dryRun, out, force };
  }
  if (command === 'template') {
    const contractBytes = readInput(required(values.contract, 'contract'), maxContractBytes, 'The contract file');
    const packageJson: unknown = JSON.parse(readInput(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 64 * 1024, 'The package metadata').toString('utf8'));
    if (!isRecord(packageJson) || typeof packageJson.version !== 'string') fail('E_INPUT', 'The package metadata has no version.');
    return { result: templateCommand({ contractBytes, toolVersion: packageJson.version, ...(values.size === undefined ? {} : { size: values.size }) }), dryRun, out, force };
  }
  if (command === 'depth') {
    const contractBytes = readInput(required(values.contract, 'contract'), maxContractBytes, 'The contract file');
    return { result: depthCommand(contractBytes, values.size), dryRun, out, force };
  }
  if (command === 'calibrate') {
    const beforeBytes = readInput(required(values.before, 'before'), maxContractBytes, 'The before contract');
    const afterBytes = readInput(required(values.after, 'after'), maxContractBytes, 'The after contract');
    const skeletonBytes = values.skeleton === undefined ? undefined : readInput(values.skeleton, 16 * 1024 * 1024, 'The skeleton file');
    const result = calibrateCommand({ beforeBytes, afterBytes, ...(skeletonBytes === undefined ? {} : { skeletonBytes }), ...(values.size === undefined ? {} : { size: values.size }) });
    return { result, dryRun, out, force };
  }
  const contractBytes = readInput(required(values.contract, 'contract'), maxContractBytes, 'The contract file');
  const imageBytes = readInput(required(values.image, 'image'), defaultPngLimits.maxBytes, 'The image');
  const marksBytes = values.marks === undefined ? undefined : readInput(values.marks, 1024 * 1024, 'The marks file');
  const [mapping] = mappingList(values.mapping, false);
  const result = overlayCommand({ contractBytes, mapping: mapping ?? 'detector', imageBytes, ...(marksBytes === undefined ? {} : { marksBytes }) });
  return { result, dryRun, out, force };
}

function main(): number {
  try {
    const { result, dryRun, out, force } = run(process.argv.slice(2));
    if (!result || out === null) return 0;
    const create = checkOutputDirectory(out, force);
    if (!dryRun) writeFiles(out, result.files, create);
    process.stdout.write(`${JSON.stringify({ ...result.report, dryRun, written: !dryRun }, null, 2)}\n`);
    const status = result.report.status;
    return status === 'PASS' ? 0 : status === 'INCOMPLETE' ? 3 : 1;
  } catch (error) {
    if (error instanceof ControlError) {
      process.stdout.write(`${JSON.stringify({ status: 'ERROR', code: error.code, problems: error.problems }, null, 2)}\n`);
      return 2;
    }
    process.stderr.write(`Unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

process.exitCode = main();
