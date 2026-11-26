#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { alignStudyCommand, maxLandmarkBytes } from '@control/alignstudy';
import { annotatePageCommand } from '@control/annotatepage';
import { assembleBodyCommand } from '@control/bodyassembly';
import { bundleCommand } from '@control/bundle';
import { calibrateCommand, candidateCommand, type CommandResult, depthCommand, maxContractBytes, overlayCommand, poseCommand, workflowCommand } from '@control/commands';
import { geometryStudyCommand } from '@control/jointgeometry';
import { compareLandmarksCommand } from '@control/landmarkcompare';
import { layerPngLimits, maxMetadataBytes, parseSeeThroughMetadata, splitLayersCommand } from '@control/layersplit';
import { limbStudyCommand, maxStudyBytes } from '@control/limbstudy';
import { maxDescriptorBytes, sheetCheckCommand, sheetLimits, syntheticSheetCommand } from '@control/modularsheet';
import { checkOutputDirectory, publishDirectory, readInput, writeFiles } from '@control/output';
import { defaultPngLimits } from '@control/png';
import { type SideMapping, sideMappings } from '@control/pose';
import { ControlError, fail, isRecord } from '@control/problems';
import { maxManifestBytes, parseExtraction, sheetAssembleCommand } from '@control/sheetassembly';
import { sheetExtractCommand } from '@control/sheetextract';
import { spineArmCommand } from '@control/spinearm';
import { spineValidateCommand } from '@control/spinecli';
import { templateCommand } from '@control/template';
import { underlayStudyCommand } from '@control/underlay';

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

  sheet-fixture --contract <C0.5 candidate rig.contract.json> --out <dir>
      Pipeline v2, V2-1 (prototype): write the synthetic modular sheet from the T1a mock parts (synthetic-sheet.png),
      its layout descriptor (synthetic-sheet.json), and the sheet check (synthetic-sheet.check.json). Flat colors, no art, no model.

  sheet-check --contract <rig.contract.json> --descriptor <sheet.json> --sheet <sheet.png> --out <dir>
      Pipeline v2, V2-1 (prototype): validate a modular sheet layout descriptor against the rig contract, and check the sheet
      PNG against it (file hash, size, alpha, empty parts, content outside the regions). Writes sheet-check.json. It does not
      extract parts and does not check semantic rules (which art is which slot).

  sheet-extract --contract <rig.contract.json> --descriptor <sheet.json> --sheet <sheet.png> --out <new dir>
      Pipeline v2, V2-2 (prototype): run the sheet-check rules, then copy the RGBA pixels of each part region without a change
      to parts/<slot>.png. Writes extraction.json (manifest), extraction-report.json, SUMMARY.md, and SHA256SUMS.
      The slot of each part comes from the descriptor only. No --force: the result is published as one new directory.

  sheet-assemble --contract <C0.5 candidate rig.contract.json> --extraction <sheet-extract output dir> --out <dir>
      Pipeline v2, V2-3 spike (prototype): put the extracted parts on the contract skeleton (contract joints; a descriptor joint
      places its part). Writes spine/skeleton.json (Spine 4.3, MVP-A idle and wave), spine/images/<slot>.png (unchanged bytes),
      character.json, evidence/assembly.json, previews (local renderer, not Spine), SHA256SUMS, and PIXEL-SHA256SUMS.

  split-layers --layers <dir> --metadata <stem.psd.json> --out <dir>
      Experiment L0-1b (prototype): analyze the See-through layers handwear, legwear, footwear, topwear and bottomwear,
      and try to split arms, legs and feet into image-left and image-right parts without a cut line. Reads <dir>/<tag>.png
      for each tag in the metadata. Writes the parts, the residual pixels, component maps, compositions, trial motion
      diagnostics, contact-sheet.png, and l0-1b.json. The inputs are not changed. The output is not a Spine-ready package.

  align-study --contract <C0.5 candidate rig.contract.json> --layers <dir> --metadata <stem.psd.json> --image <src.png> --out <dir>
              [--landmarks <manual landmarks.json>]
      Experiment L0-1c (prototype): measure anatomical landmarks on the See-through layers, align them with the C0.5
      template joints under both near/far hypotheses (uniform, similarity, affine, per bone, per triangle), and propose
      cut lines without a cut. --image is the See-through input at the layer frame size. Manual landmarks replace the
      automatic entries with the same id. Writes landmarks.json, correspondence.json, landmarks-manual.template.json,
      a-anatomy-overlay.png, b-skeleton-comparison.png, c-alignment-diagnostics.png, d-segmentation-map.png,
      e-uncertainty-map.png, and contact-sheet.png. The inputs are not changed. The art is not warped.

  annotate-page --image <src.png> --landmarks <align-study landmarks.json> --out <dir> [--manual <manual landmarks.json>]
      Experiment L0-1d (prototype): write annotate.html, one self-contained page for manual landmark marks. Open it in a
      browser from the disk. It needs no server and no network. It shows the image, the automatic landmarks and their ranges,
      and exports landmarks-manual.json in the format that align-study --landmarks reads. --manual loads earlier marks.

  compare-landmarks --image <src.png> --before-landmarks <a/landmarks.json> --before-study <a/correspondence.json>
                    --after-landmarks <b/landmarks.json> --after-study <b/correspondence.json> --out <dir>
      Experiment L0-1d (prototype): compare two align-study runs (for example automatic and manual landmarks). Writes
      comparison.json, before-after-landmarks.png, alignment-before-after.png, error-vectors.png, and contact-sheet.png.

  limb-study --contract <C0.5 candidate rig.contract.json> --layers <dir> --metadata <stem.psd.json> --image <src.png>
             --landmarks <landmarks-manual.json> --study <align-study correspondence.json> --out <dir>
      Experiment L0-1e (prototype): cut the image-left (near) arm into upper arm, forearm, and hand at the manual joint
      marks, measure the C0.5 joint overlap, and rotate the parts for diagnostics. Copies source pixels only; paints nothing.
      Writes metrics.json, the parts, rotation results, gap and overlap maps, and review images.

  underlay-study --contract <C0.5 candidate rig.contract.json> --layers <dir> --metadata <stem.psd.json> --image <src.png>
                 --landmarks <landmarks-manual.json> --study <align-study correspondence.json> --out <dir>
      Experiment L0-1f (prototype): make the missing parent underlay at the elbow and the wrist of the near arm with two
      deterministic raster methods (nearest edge, directional), then repeat the limb-study rotation tests and metrics.
      New pixels only inside the underlay regions, tagged generated_by_deterministic_extension. No model.

  geometry-study --contract <C0.5 candidate rig.contract.json> --layers <dir> --metadata <stem.psd.json> --image <src.png>
                 --landmarks <landmarks-manual.json> --study <align-study correspondence.json> --out <dir>
      Experiment L0-1g (prototype): compare three diagnostic underlay regions (C0.5 circle, wide circle, tube) with and
      without the occlusion-safe rule, on the L0-1e angles, wider diagnostic angles, and shifted joint marks. No model.

  spine-arm --contract <C0.5 candidate rig.contract.json> --layers <dir> --metadata <stem.psd.json> --image <src.png>
            --landmarks <landmarks-manual.json> --study <align-study correspondence.json> --out <dir>
      Experiment M0-F0a (prototype): make a Spine 4.3 skeleton JSON and cropped region PNGs for the image-left (near) arm
      (root > upper_arm_near > forearm_near > hand_near) in two variants (tube underlay, baseline), with test animations,
      geometry.json, offline checks, previews, and hash manifests. Does not run Spine: the result is JSON_GENERATED only.

  assemble-body --contract <C0.5 candidate rig.contract.json> --layers <dir> --metadata <stem.psd.json> --image <src.png>
                --landmarks <landmarks-manual.json> --study <align-study correspondence.json> --out <dir>
      MVP-A (prototype): assemble the full-body test character from the See-through layers on the C0.5 candidate bones and slots.
      Writes a Spine 4.3 skeleton JSON (spine/skeleton.json), region PNGs, character.json, the demonstration animations idle and
      wave, evidence (assembly, validation, provenance), previews, and hash manifests. Does not run Spine: JSON_GENERATED only.

  spine-validate --spine <absolute path of the Spine executable> --package <spine-arm or assemble-body output dir> --out <new dir>
                 [--spine-version 4.3.26]
      Experiment M0-F0a: run the licensed Spine CLI. Import each skeleton JSON into a new .spine project, export it to JSON
      with a texture atlas, compare the export with the intended skeleton, and write cli-validation.json and all logs.
      macOS: --spine /Applications/Spine.app/Contents/MacOS/Spine. --dry-run checks the package and prints the commands.

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
  layers: { type: 'string' },
  metadata: { type: 'string' },
  landmarks: { type: 'string' },
  manual: { type: 'string' },
  'before-landmarks': { type: 'string' },
  'before-study': { type: 'string' },
  'after-landmarks': { type: 'string' },
  'after-study': { type: 'string' },
  study: { type: 'string' },
  spine: { type: 'string' },
  package: { type: 'string' },
  'spine-version': { type: 'string' },
  descriptor: { type: 'string' },
  sheet: { type: 'string' },
  extraction: { type: 'string' },
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
  template: ['contract', 'out', 'size'],
  'sheet-fixture': ['contract', 'out'],
  'sheet-check': ['contract', 'descriptor', 'sheet', 'out'],
  'sheet-extract': ['contract', 'descriptor', 'sheet', 'out'],
  'sheet-assemble': ['contract', 'extraction', 'out'],
  'split-layers': ['layers', 'metadata', 'out'],
  'align-study': ['contract', 'layers', 'metadata', 'image', 'landmarks', 'out'],
  'annotate-page': ['image', 'landmarks', 'manual', 'out'],
  'compare-landmarks': ['image', 'before-landmarks', 'before-study', 'after-landmarks', 'after-study', 'out'],
  'limb-study': ['contract', 'layers', 'metadata', 'image', 'landmarks', 'study', 'out'],
  'underlay-study': ['contract', 'layers', 'metadata', 'image', 'landmarks', 'study', 'out'],
  'geometry-study': ['contract', 'layers', 'metadata', 'image', 'landmarks', 'study', 'out'],
  'spine-arm': ['contract', 'layers', 'metadata', 'image', 'landmarks', 'study', 'out'],
  'assemble-body': ['contract', 'layers', 'metadata', 'image', 'landmarks', 'study', 'out'],
  'spine-validate': ['spine', 'package', 'spine-version', 'out']
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

function packageVersion(): string {
  const packageJson: unknown = JSON.parse(readInput(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 64 * 1024, 'The package metadata').toString('utf8'));
  if (!isRecord(packageJson) || typeof packageJson.version !== 'string') fail('E_INPUT', 'The package metadata has no version.');
  return packageJson.version;
}

type RunResult = { result: CommandResult | null; dryRun: boolean; out: string | null; force: boolean; prepared?: boolean; atomic?: boolean };

function run(argv: readonly string[]): RunResult {
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
  if (command === 'spine-validate') {
    // Spine writes into the output directory, so it must be new or empty before the run. No --force: an earlier result is never replaced.
    if (force) fail('E_USAGE', 'spine-validate does not accept --force. Give a new output directory.');
    const create = checkOutputDirectory(out, false);
    if (!dryRun && create) mkdirSync(out);
    const result = spineValidateCommand({
      spine: required(values.spine, 'spine'),
      packageDir: required(values.package, 'package'),
      out,
      dryRun,
      toolVersion: packageVersion(),
      ...(values['spine-version'] === undefined ? {} : { spineVersion: values['spine-version'] })
    });
    return { result, dryRun, out, force, prepared: true };
  }
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
    return { result: templateCommand({ contractBytes, toolVersion: packageVersion(), ...(values.size === undefined ? {} : { size: values.size }) }), dryRun, out, force };
  }
  if (command === 'sheet-fixture') {
    const contractBytes = readInput(required(values.contract, 'contract'), maxContractBytes, 'The contract file');
    return { result: syntheticSheetCommand({ contractBytes, toolVersion: packageVersion() }), dryRun, out, force };
  }
  if (command === 'sheet-check') {
    const contractBytes = readInput(required(values.contract, 'contract'), maxContractBytes, 'The contract file');
    const descriptorBytes = readInput(required(values.descriptor, 'descriptor'), maxDescriptorBytes, 'The descriptor');
    const sheetBytes = readInput(required(values.sheet, 'sheet'), sheetLimits.maxBytes, 'The sheet image');
    return { result: sheetCheckCommand({ contractBytes, descriptorBytes, sheetBytes }), dryRun, out, force };
  }
  if (command === 'sheet-extract') {
    // The result is published as one new directory, so an earlier result is never replaced or mixed with new files.
    if (force) fail('E_USAGE', 'sheet-extract does not accept --force. Give a new output directory.');
    checkOutputDirectory(out, false);
    const contractBytes = readInput(required(values.contract, 'contract'), maxContractBytes, 'The contract file');
    const descriptorBytes = readInput(required(values.descriptor, 'descriptor'), maxDescriptorBytes, 'The descriptor');
    const sheetBytes = readInput(required(values.sheet, 'sheet'), sheetLimits.maxBytes, 'The sheet image');
    return { result: sheetExtractCommand({ contractBytes, descriptorBytes, sheetBytes, toolVersion: packageVersion() }), dryRun, out, force, atomic: true };
  }
  if (command === 'sheet-assemble') {
    const contractBytes = readInput(required(values.contract, 'contract'), maxContractBytes, 'The contract file');
    const directory = required(values.extraction, 'extraction');
    const manifestBytes = readInput(join(directory, 'extraction.json'), maxManifestBytes, 'extraction.json');
    // File names come from the validated slot ids, not from the manifest text.
    const partFiles = new Map<string, Buffer>();
    for (const part of parseExtraction(manifestBytes).parts) {
      const path = join(directory, 'parts', `${part.slot}.png`);
      if (existsSync(path)) partFiles.set(part.slot, readInput(path, sheetLimits.maxBytes, `The part ${part.slot}.png`));
    }
    return { result: sheetAssembleCommand({ contractBytes, manifestBytes, partFiles, toolVersion: packageVersion() }), dryRun, out, force };
  }
  if (command === 'compare-landmarks') {
    const read = (name: 'before-landmarks' | 'before-study' | 'after-landmarks' | 'after-study'): Buffer => readInput(required(values[name], name), 1024 * 1024, `The --${name} file`);
    const imageBytes = readInput(required(values.image, 'image'), layerPngLimits.maxBytes, 'The image');
    return {
      result: compareLandmarksCommand({
        imageBytes,
        before: { landmarks: read('before-landmarks'), correspondence: read('before-study') },
        after: { landmarks: read('after-landmarks'), correspondence: read('after-study') },
        toolVersion: packageVersion()
      }),
      dryRun,
      out,
      force
    };
  }
  if (command === 'annotate-page') {
    const imagePath = required(values.image, 'image');
    const imageBytes = readInput(imagePath, layerPngLimits.maxBytes, 'The image');
    const landmarkBytes = readInput(required(values.landmarks, 'landmarks'), maxLandmarkBytes, 'The automatic landmark file');
    const manualBytes = values.manual === undefined ? undefined : readInput(values.manual, maxLandmarkBytes, 'The manual landmark file');
    const pageCode = readInput(join(dirname(fileURLToPath(import.meta.url)), 'annotator.js'), 1024 * 1024, 'The compiled page code');
    return {
      result: annotatePageCommand({ imageBytes, imageName: basename(imagePath), landmarkBytes, pageCode, toolVersion: packageVersion(), ...(manualBytes ? { manualBytes } : {}) }),
      dryRun,
      out,
      force
    };
  }
  if (
    command === 'split-layers' ||
    command === 'align-study' ||
    command === 'limb-study' ||
    command === 'underlay-study' ||
    command === 'geometry-study' ||
    command === 'spine-arm' ||
    command === 'assemble-body'
  ) {
    const metadataPath = required(values.metadata, 'metadata');
    const metadataBytes = readInput(metadataPath, maxMetadataBytes, 'The See-through metadata');
    const directory = required(values.layers, 'layers');
    const layerFiles = new Map<string, { name: string; bytes: Buffer }>();
    for (const layer of parseSeeThroughMetadata(metadataBytes).layers) {
      const name = `${layer.tag}.png`;
      const path = join(directory, name);
      if (!existsSync(path)) continue;
      layerFiles.set(layer.tag, { name, bytes: readInput(path, layerPngLimits.maxBytes, `The layer file ${name}`) });
    }
    if (command === 'limb-study' || command === 'underlay-study' || command === 'geometry-study' || command === 'spine-arm' || command === 'assemble-body') {
      const imagePath = required(values.image, 'image');
      const studies = {
        'limb-study': limbStudyCommand,
        'underlay-study': underlayStudyCommand,
        'geometry-study': geometryStudyCommand,
        'spine-arm': spineArmCommand,
        'assemble-body': assembleBodyCommand
      };
      const study = studies[command];
      return {
        result: study({
          contractBytes: readInput(required(values.contract, 'contract'), maxContractBytes, 'The contract file'),
          metadataBytes,
          metadataName: basename(metadataPath),
          layerFiles,
          imageBytes: readInput(imagePath, layerPngLimits.maxBytes, 'The image'),
          landmarkBytes: readInput(required(values.landmarks, 'landmarks'), maxLandmarkBytes, 'The manual landmark file'),
          studyBytes: readInput(required(values.study, 'study'), maxStudyBytes, 'The study file'),
          toolVersion: packageVersion()
        }),
        dryRun,
        out,
        force
      };
    }
    if (command === 'split-layers') return { result: splitLayersCommand({ metadataBytes, metadataName: basename(metadataPath), layerFiles, toolVersion: packageVersion() }), dryRun, out, force };
    const contractBytes = readInput(required(values.contract, 'contract'), maxContractBytes, 'The contract file');
    const imagePath = required(values.image, 'image');
    const imageBytes = readInput(imagePath, layerPngLimits.maxBytes, 'The image');
    const manualBytes = values.landmarks === undefined ? undefined : readInput(values.landmarks, maxLandmarkBytes, 'The landmark file');
    return {
      result: alignStudyCommand({
        contractBytes,
        metadataBytes,
        metadataName: basename(metadataPath),
        imageBytes,
        imageName: basename(imagePath),
        layerFiles,
        toolVersion: packageVersion(),
        ...(manualBytes ? { manualBytes } : {})
      }),
      dryRun,
      out,
      force
    };
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
    const { result, dryRun, out, force, prepared, atomic } = run(process.argv.slice(2));
    if (!result || out === null) return 0;
    let written = false;
    if (atomic === true) {
      // Publish only a PASS result, as one directory. A FAIL result has no files and writes nothing.
      if (!dryRun && result.report.status === 'PASS' && result.files.length > 0) {
        publishDirectory(out, result.files);
        written = true;
      }
    } else {
      const create = prepared === true ? false : checkOutputDirectory(out, force);
      if (!dryRun) writeFiles(out, result.files, create);
      written = !dryRun;
    }
    process.stdout.write(`${JSON.stringify({ ...result.report, dryRun, written }, null, 2)}\n`);
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
