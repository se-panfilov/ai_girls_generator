import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { CommandResult } from '@control/commands';
import { json } from '@control/commands';
import { readInput } from '@control/output';
import { decodePng, pixelHash, sha256 } from '@control/png';
import { fail, isRecord, show } from '@control/problems';
import { skeletonFile, variants } from '@control/spinearm';
import { partSlots, referenceSlot } from '@control/spineskeleton';

// `spine-validate` (experiment M0-F0a): runs the owner's licensed Spine executable through its command-line interface. For each variant it
// imports the package skeleton JSON into a new .spine project, exports the project to JSON with a texture atlas, and compares the export
// with the intended skeleton. The command never reads license files, never passes credentials, and runs Spine only with argument arrays.
// CLI_VALIDATED is reported only when a real run of the given executable imported and exported both variants and all checks passed.

export const cliFormat = 'aigg.m0-f0a.spine-cli-validation/0.1';
export const maxSkeletonBytes = 4 * 1024 * 1024;
export const maxLogBytes = 4 * 1024 * 1024;
export const maxExportEntries = 64;
export const defaultTimeoutMs = 10 * 60 * 1000;
/** Tolerances of the export comparison: Spine units (image px), degrees, seconds. */
export const tolerance = { position: 0.01, degrees: 0.01, time: 1e-3 } as const;

export type RunResult = {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly error: string | null;
  readonly durationMs: number;
};
export type Runner = (executable: string, args: readonly string[], timeoutMs: number) => RunResult;

/** Runs a program without a shell. Output beyond the limit is cut by Node.js and reported as an error. */
export const spawnRunner: Runner = (executable, args, timeoutMs) => {
  const start = Date.now();
  const result = spawnSync(executable, [...args], { shell: false, timeout: timeoutMs, maxBuffer: maxLogBytes, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
    error: result.error ? result.error.message : null,
    durationMs: Date.now() - start
  };
};

export type SpineValidateOptions = {
  readonly spine: string;
  readonly packageDir: string;
  readonly out: string;
  readonly spineVersion?: string;
  readonly dryRun: boolean;
  readonly toolVersion: string;
  readonly timeoutMs?: number;
  readonly runner?: Runner;
};

export type Difference = { readonly path: string; readonly intended: unknown; readonly exported: unknown };

const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const angleDelta = (a: number, b: number): number => Math.abs(((((a - b) % 360) + 540) % 360) - 180);
const lower = (value: unknown, fallback: string): string => (typeof value === 'string' ? value.toLowerCase() : fallback);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const object = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/**
 * Compares an exported skeleton JSON with the intended one. Missing fields take the Spine defaults (0, scale 1, color ffffffff, time 0,
 * linear curve), because the Spine export omits default values. Rotation is compared modulo 360 degrees.
 */
export function compareSkeletons(intended: unknown, exported: unknown): Difference[] {
  const out: Difference[] = [];
  const differ = (path: string, a: unknown, b: unknown): void => {
    if (out.length < 200) out.push({ path, intended: a, exported: b });
  };
  const near = (path: string, a: unknown, b: unknown, fallback: number, limit: number, angle = false): void => {
    const x = num(a, fallback);
    const y = num(b, fallback);
    if ((angle ? angleDelta(x, y) : Math.abs(x - y)) > limit) differ(path, a ?? fallback, b ?? fallback);
  };
  const i = object(intended);
  const e = object(exported);
  // Bones.
  const intendedBones = list(i.bones).map(object);
  const exportedBones = new Map(
    list(e.bones)
      .map(object)
      .map((bone) => [bone.name, bone])
  );
  if (list(e.bones).length !== intendedBones.length) differ('bones.length', intendedBones.length, list(e.bones).length);
  for (const bone of intendedBones) {
    const name = String(bone.name);
    const other = exportedBones.get(name);
    if (!other) {
      differ(`bones.${name}`, 'present', 'missing');
      continue;
    }
    if (other.parent !== bone.parent) differ(`bones.${name}.parent`, bone.parent, other.parent);
    near(`bones.${name}.x`, bone.x, other.x, 0, tolerance.position);
    near(`bones.${name}.y`, bone.y, other.y, 0, tolerance.position);
    near(`bones.${name}.length`, bone.length, other.length, 0, tolerance.position);
    near(`bones.${name}.rotation`, bone.rotation, other.rotation, 0, tolerance.degrees, true);
    for (const key of ['scaleX', 'scaleY']) near(`bones.${name}.${key}`, bone[key], other[key], 1, 1e-4);
    for (const key of ['shearX', 'shearY']) near(`bones.${name}.${key}`, bone[key], other[key], 0, 1e-4);
    if ((other.inherit ?? other.transform ?? 'normal') !== 'normal') differ(`bones.${name}.inherit`, 'normal', other.inherit ?? other.transform);
  }
  // Slots and draw order.
  const intendedSlots = list(i.slots).map(object);
  const exportedSlots = list(e.slots).map(object);
  const names = (slots: Record<string, unknown>[]): string => slots.map((slot) => String(slot.name)).join(',');
  if (names(intendedSlots) !== names(exportedSlots)) differ('slots.order', names(intendedSlots), names(exportedSlots));
  for (const slot of intendedSlots) {
    const other = exportedSlots.find((item) => item.name === slot.name);
    if (!other) continue;
    if (other.bone !== slot.bone) differ(`slots.${String(slot.name)}.bone`, slot.bone, other.bone);
    if (other.attachment !== slot.attachment) differ(`slots.${String(slot.name)}.attachment`, slot.attachment, other.attachment);
    if (lower(other.color, 'ffffffff') !== lower(slot.color, 'ffffffff')) differ(`slots.${String(slot.name)}.color`, slot.color, other.color);
    if ((other.blend ?? 'normal') !== 'normal') differ(`slots.${String(slot.name)}.blend`, 'normal', other.blend);
  }
  // Region attachments of the default skin.
  const skinOf = (value: Record<string, unknown>): Record<string, unknown> =>
    object(
      list(value.skins)
        .map(object)
        .find((skin) => skin.name === 'default')?.attachments
    );
  const intendedSkin = skinOf(i);
  const exportedSkin = skinOf(e);
  if (list(e.skins).length !== 1) differ('skins.length', 1, list(e.skins).length);
  for (const [slot, entries] of Object.entries(intendedSkin)) {
    for (const [name, region] of Object.entries(object(entries))) {
      const a = object(region);
      const b = object(object(exportedSkin[slot])[name]);
      const path = `skins.default.${slot}.${name}`;
      if (Object.keys(b).length === 0) {
        differ(path, 'present', 'missing');
        continue;
      }
      if ((b.type ?? 'region') !== 'region') differ(`${path}.type`, 'region', b.type);
      if ((b.path ?? name) !== (a.path ?? name)) differ(`${path}.path`, a.path ?? name, b.path);
      near(`${path}.x`, a.x, b.x, 0, tolerance.position);
      near(`${path}.y`, a.y, b.y, 0, tolerance.position);
      near(`${path}.rotation`, a.rotation, b.rotation, 0, tolerance.degrees, true);
      near(`${path}.width`, a.width, b.width, 0, tolerance.position);
      near(`${path}.height`, a.height, b.height, 0, tolerance.position);
      near(`${path}.scaleX`, a.scaleX, b.scaleX, 1, 1e-4);
      near(`${path}.scaleY`, a.scaleY, b.scaleY, 1, 1e-4);
    }
  }
  for (const [slot, entries] of Object.entries(exportedSkin))
    for (const name of Object.keys(object(entries))) if (object(intendedSkin[slot])[name] === undefined) differ(`skins.default.${slot}.${name}`, 'absent', 'present');
  // Animations: rotate keys only.
  const intendedAnimations = object(i.animations);
  const exportedAnimations = object(e.animations);
  if (Object.keys(intendedAnimations).sort().join(',') !== Object.keys(exportedAnimations).sort().join(','))
    differ('animations', Object.keys(intendedAnimations).sort().join(','), Object.keys(exportedAnimations).sort().join(','));
  for (const [name, animation] of Object.entries(intendedAnimations)) {
    const other = object(exportedAnimations[name]);
    const extra = Object.keys(other).filter((key) => key !== 'bones');
    if (extra.length > 0) differ(`animations.${name}`, 'bones only', extra.join(','));
    const intendedTimelines = object(object(animation).bones);
    const exportedTimelines = object(other.bones);
    if (Object.keys(intendedTimelines).sort().join(',') !== Object.keys(exportedTimelines).sort().join(','))
      differ(`animations.${name}.bones`, Object.keys(intendedTimelines).sort().join(','), Object.keys(exportedTimelines).sort().join(','));
    for (const [bone, timeline] of Object.entries(intendedTimelines)) {
      const otherTimeline = object(exportedTimelines[bone]);
      const extraTimelines = Object.keys(otherTimeline).filter((key) => key !== 'rotate');
      if (extraTimelines.length > 0) differ(`animations.${name}.bones.${bone}`, 'rotate only', extraTimelines.join(','));
      const keys = list(object(timeline).rotate).map(object);
      const otherKeys = list(otherTimeline.rotate).map(object);
      if (keys.length !== otherKeys.length) {
        differ(`animations.${name}.bones.${bone}.rotate.length`, keys.length, otherKeys.length);
        continue;
      }
      keys.forEach((key, index) => {
        const otherKey = otherKeys[index] ?? {};
        const path = `animations.${name}.bones.${bone}.rotate[${index}]`;
        near(`${path}.time`, key.time, otherKey.time, 0, tolerance.time);
        near(`${path}.value`, key.value, otherKey.value, 0, tolerance.degrees);
        if (otherKey.curve !== undefined && otherKey.curve !== key.curve) differ(`${path}.curve`, key.curve ?? 'linear', otherKey.curve);
      });
    }
  }
  return out;
}

/** Region names of a Spine 4 text atlas: lines with no colon that are not page image names. */
export function atlasRegions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.includes(':') && !/\.(png|jpg|jpeg|webp)$/i.test(line));
}

/** Reads `SHA256SUMS` and `PIXEL-SHA256SUMS` and checks the skeleton JSON bytes and the PNG pixels of each variant. */
export function verifyPackage(packageDir: string): { problems: string[]; files: number } {
  const problems: string[] = [];
  const parse = (name: string): Map<string, string> => {
    const map = new Map<string, string>();
    for (const line of readInput(join(packageDir, name), 1024 * 1024, `The package file ${name}`)
      .toString('utf8')
      .split('\n')) {
      const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9_./-]{1,200})$/.exec(line);
      if (match && !match[2]?.split('/').includes('..')) map.set(match[2] as string, match[1] as string);
    }
    return map;
  };
  const bytes = parse('SHA256SUMS');
  const pixels = parse('PIXEL-SHA256SUMS');
  if (bytes.size === 0 || bytes.size > 256) problems.push('SHA256SUMS has no valid lines or too many lines.');
  let files = 0;
  for (const variant of variants) {
    const jsonName = `spine/${variant}/${skeletonFile}`;
    const data = readInput(join(packageDir, jsonName), maxSkeletonBytes, `The skeleton ${jsonName}`);
    files += 1;
    if (bytes.get(jsonName) !== sha256(data)) problems.push(`${jsonName}: SHA-256 does not match SHA256SUMS.`);
    for (const slot of [referenceSlot, ...partSlots]) {
      const name = `spine/${variant}/images/${slot}.png`;
      const raster = decodePng(readInput(join(packageDir, name), 16 * 1024 * 1024, `The image ${name}`)).raster;
      files += 1;
      if (pixels.get(name) !== pixelHash(raster)) problems.push(`${name}: pixel SHA-256 does not match PIXEL-SHA256SUMS.`);
    }
  }
  return { problems, files };
}

/** Checks the Spine executable path: absolute, a regular file after links, executable on POSIX systems. */
export function checkExecutable(path: string): { path: string; realPath: string; sha256: string; bytes: number } {
  if (!isAbsolute(path)) fail('E_USAGE', '--spine must be an absolute path to the Spine executable, for example /Applications/Spine.app/Contents/MacOS/Spine.');
  let real: string;
  try {
    lstatSync(path);
    real = realpathSync(path);
  } catch {
    fail('E_SPINE_NOT_FOUND', `The Spine executable ${show(path)} is not found.`);
  }
  const info = statSync(real);
  if (!info.isFile()) fail('E_SPINE_NOT_FOUND', 'The Spine path is not a regular file. On macOS give .../Spine.app/Contents/MacOS/Spine, not Spine.app.');
  if (process.platform !== 'win32' && (info.mode & 0o111) === 0) fail('E_SPINE_NOT_EXECUTABLE', 'The Spine file is not executable.');
  const data = readInput(real, 512 * 1024 * 1024, 'The Spine executable');
  return { path, realPath: real, sha256: sha256(data), bytes: data.length };
}

const versionPattern = /^(\d{1,2}\.\d{1,2}\.\d{1,3}|latest|lateststable|stable)$/;

/** `spine-validate`: the CLI validation. The caller makes the empty output directory before a run that is not a dry run. */
export function spineValidateCommand(options: SpineValidateOptions): CommandResult {
  if (options.spineVersion !== undefined && !versionPattern.test(options.spineVersion)) fail('E_USAGE', '--spine-version must be a version such as 4.3.26, or latest, lateststable, or stable.');
  const executable = checkExecutable(options.spine);
  const packageDir = resolve(options.packageDir);
  const out = resolve(options.out);
  const integrity = verifyPackage(packageDir);
  if (integrity.problems.length > 0) fail('E_PACKAGE', `The package does not match its manifests: ${integrity.problems.slice(0, 4).join(' ')}`);
  const versionArgs = options.spineVersion === undefined ? [] : ['--update', options.spineVersion];
  const plans = variants.map((variant) => {
    const input = join(packageDir, 'spine', variant, skeletonFile);
    const project = join(out, variant, `arm-near-${variant}.spine`);
    const exportDir = join(out, variant, 'export');
    return {
      variant,
      project,
      exportDir,
      steps: [
        { id: 'import', args: [...versionArgs, '--input', input, '--output', project, '--import', `arm_near_${variant}`] },
        { id: 'export', args: [...versionArgs, '--input', project, '--output', exportDir, '--export', 'json+pack'] }
      ]
    };
  });
  const base = {
    format: cliFormat,
    tool: { name: '@aigg/control', version: options.toolVersion, command: 'spine-validate' },
    spine: { executable: executable.path, realPath: executable.realPath, sha256: executable.sha256, bytes: executable.bytes, requestedVersion: options.spineVersion ?? null },
    package: { directory: packageDir, checkedFiles: integrity.files, manifests: 'PASS' }
  };
  if (options.dryRun) {
    return {
      report: {
        ...base,
        status: 'INCOMPLETE',
        levels: { CLI_VALIDATED: 'NOT_RUN' },
        plannedCommands: plans.flatMap((plan) => plan.steps.map((step) => ({ variant: plan.variant, step: step.id, args: step.args })))
      },
      files: []
    };
  }
  const runner = options.runner ?? spawnRunner;
  const timeout = options.timeoutMs ?? defaultTimeoutMs;
  const files: { name: string; bytes: Buffer }[] = [];
  const intendedOf = (variant: string): unknown => JSON.parse(readInput(join(packageDir, 'spine', variant, skeletonFile), maxSkeletonBytes, 'The skeleton').toString('utf8')) as unknown;
  const results = plans.map((plan) => {
    // A new directory per variant for the project; Spine makes the export directory.
    mkdirSync(join(out, plan.variant));
    const steps: Record<string, unknown>[] = [];
    let ok = true;
    for (const step of plan.steps) {
      if (!ok) {
        steps.push({ id: step.id, args: step.args, skipped: true });
        continue;
      }
      // Run the checked real path, so that a link change after the check does not change the program.
      const run = runner(executable.realPath, step.args, timeout);
      files.push({ name: `${plan.variant}/logs/${step.id}.stdout.log`, bytes: run.stdout }, { name: `${plan.variant}/logs/${step.id}.stderr.log`, bytes: run.stderr });
      const passed = run.status === 0 && run.signal === null && run.error === null;
      steps.push({
        id: step.id,
        args: step.args,
        exitCode: run.status,
        signal: run.signal,
        error: run.error,
        durationMs: run.durationMs,
        stdout: `${plan.variant}/logs/${step.id}.stdout.log`,
        stderr: `${plan.variant}/logs/${step.id}.stderr.log`,
        stderrTail: run.stderr.toString('utf8').slice(-2000)
      });
      ok = passed;
    }
    const problems: string[] = [];
    if (!ok) problems.push('A Spine CLI step failed. See the logs and stderrTail.');
    let projectBytes = 0;
    let exported: { json: string | null; atlas: string | null; entries: string[] } = { json: null, atlas: null, entries: [] };
    let differences: Difference[] = [];
    let regions: string[] = [];
    let editorVersion: unknown = null;
    if (ok) {
      try {
        projectBytes = statSync(plan.project).size;
      } catch {
        problems.push('Spine reported success, but the .spine project is missing.');
      }
      let entries: string[] = [];
      try {
        entries = readdirSync(plan.exportDir).sort();
      } catch {
        problems.push('Spine reported success, but the export directory is missing.');
      }
      if (entries.length > maxExportEntries) problems.push(`The export directory has ${entries.length} entries.`);
      const jsons = entries.filter((name) => name.endsWith('.json'));
      const atlases = entries.filter((name) => name.endsWith('.atlas') || name.endsWith('.atlas.txt'));
      exported = { json: jsons[0] ?? null, atlas: atlases[0] ?? null, entries: entries.slice(0, maxExportEntries) };
      if (jsons.length !== 1) problems.push(`The export has ${jsons.length} JSON files, expected 1.`);
      if (atlases.length !== 1) problems.push(`The export has ${atlases.length} atlas files, expected 1 (json+pack).`);
      if (jsons.length === 1 && jsons[0]) {
        let exportedJson: unknown = null;
        try {
          exportedJson = JSON.parse(readInput(join(plan.exportDir, jsons[0]), maxSkeletonBytes, 'The exported skeleton').toString('utf8')) as unknown;
        } catch (error) {
          problems.push(`The exported JSON cannot be read: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}.`);
        }
        editorVersion = isRecord(exportedJson) && isRecord(exportedJson.skeleton) ? (exportedJson.skeleton.spine ?? null) : null;
        if (exportedJson !== null) differences = compareSkeletons(intendedOf(plan.variant), exportedJson);
        if (differences.length > 0) problems.push(`The exported skeleton differs from the intended skeleton in ${differences.length} values.`);
      }
      if (atlases.length === 1 && atlases[0]) {
        regions = atlasRegions(readInput(join(plan.exportDir, atlases[0]), 1024 * 1024, 'The exported atlas').toString('utf8'));
        const missing = [referenceSlot, ...partSlots].filter((name) => !regions.includes(name));
        if (missing.length > 0) problems.push(`The atlas has no region for ${missing.join(', ')}: Spine did not find these images.`);
      }
    }
    return {
      variant: plan.variant,
      status: problems.length === 0 ? 'PASS' : 'FAIL',
      project: plan.project,
      projectBytes,
      exportDir: plan.exportDir,
      exported,
      exportedEditorVersion: editorVersion,
      atlasRegions: regions,
      steps,
      differences,
      problems
    };
  });
  const status = results.every((result) => result.status === 'PASS') ? 'PASS' : 'FAIL';
  const report = {
    ...base,
    status,
    levels: { CLI_VALIDATED: status, VISUALLY_VALIDATED: 'NOT_RUN' },
    note:
      status === 'PASS'
        ? 'The given Spine executable imported both skeletons into .spine projects and exported them; the exports match the intended skeletons and the atlas has all images. Not a visual check.'
        : 'Not CLI_VALIDATED. Send cli-validation.json and the logs.',
    tolerance,
    variants: results
  };
  files.push({ name: 'cli-validation.json', bytes: json(report) });
  return {
    report: {
      format: cliFormat,
      status,
      levels: report.levels,
      variants: results.map((result) => ({ variant: result.variant, status: result.status, problems: result.problems, exportedEditorVersion: result.exportedEditorVersion }))
    },
    files
  };
}
