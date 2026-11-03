// Check repository settings that the documentation requires: TypeScript, aliases, package metadata,
// dependencies, the lockfile, repository structure, English text, skills, and GitHub Actions workflows.
// Usage: node scripts/ci/config.mjs
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readRegularFile } from './files.mjs';
import { listPackages, main, readJson, root, safe } from './lib.mjs';

// Compiler options that each package inherits from configs/tsconfig.base.json.
export const requiredCompilerOptions = {
  strict: true,
  noEmitOnError: true,
  forceConsistentCasingInFileNames: true,
  module: 'ESNext',
  moduleResolution: 'Bundler',
  verbatimModuleSyntax: true,
  isolatedModules: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  noImplicitOverride: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true
};
// Package tsconfig files set only local paths. Other compiler options come from the shared base.
const localCompilerOptions = new Set(['rootDir', 'outDir', 'paths']);
// Scripts from the new-package skill. A package with a bin entry also needs `start`.
const requiredScripts = ['build', 'typecheck', 'test', 'lint', 'format:check'];
const installHooks = ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare'];
const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];
const exactVersion = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ruleFileNames = new Set(['agents.md', 'skill.md', 'claude.md', 'gemini.md']);
const lockfiles = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock']);
const vendoredSkills = /^\.(agents|claude|codex|gemini)\/skills\//;
const fullSha = /^[^\s@]+@[0-9a-f]{40}$/;
// Generated images, editor files, and model weights stay out of Git until the storage decision is made (AGENTS.md, Pipeline rules).
const binaryAsset = /\.(png|jpe?g|webp|gif|bmp|tiff?|psd|psb|ora|kra|exr|safetensors|ckpt|pt|pth|bin|onnx|gguf|zip|tgz|gz|7z)$/i;
// Repository text is in English. These files are vendored or record upstream bytes, so they are not checked.
const languageExempt = [vendoredSkills, /^docs\/skill-patches\//, /^docs\/skill-provenance\.json$/, /^skills-lock\.json$/, /^package-lock\.json$/];
const textFile = /\.(md|mjs|cjs|js|ts|json|ya?ml|toml|txt)$|(^|\/)\.[a-z]+(rc|ignore|attributes|config)$|(^|\/)(LICENSE|CODEOWNERS)$/;
const cyrillic = /[\u0400-\u04FF]/;
// Events that run with write access or secrets for code or text from pull requests and comments.
export const forbiddenWorkflowEvents = ['pull_request_target', 'workflow_run', 'issue_comment', 'pull_request_review', 'pull_request_review_comment', 'discussion', 'discussion_comment'];
// Shell scripts that are permitted. Use TypeScript or Node.js unless a documented reason requires Bash.
export const shellScriptAllowlist = [];
// Binary files that a human approved for Git. Add an entry only after the storage decision.
export const binaryAssetAllowlist = [];
// Tools that a skill can use without a permission prompt in Claude Code. Bash, Write, Edit, and network tools follow the host permission rules.
export const skillToolAllowlist = ['Read', 'Grep', 'Glob', 'LSP', 'Task', 'AskUserQuestion', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'];
// Skills that this repository maintains. All other skills in .agents/skills must be in docs/skill-provenance.json.
export const localSkills = ['asset-factory', 'new-package'];
// Agent host files that can run commands, grant tool permissions, start MCP servers, or replace AGENTS.md.
// A pull request can add them without a review of the instruction files. Add an entry only after a human decision.
export const hostConfigAllowlist = [];
const hostConfig = [
  /^\.claude\/settings(\.local)?\.json$/,
  /^\.mcp\.json$/,
  /^\.gemini\/settings\.json$/,
  /^\.codex\/config\.toml$/,
  /^\.cursor\//,
  /^\.vscode\/(tasks|settings|mcp)\.json$/,
  /(^|\/)AGENTS\.override\.md$/i,
  /(^|\/)(CLAUDE|GEMINI)\.local\.md$/i,
  /(^|\/)\.(cursorrules|windsurfrules|clinerules)$/
];
// Runtime dependencies that a human approved for each package, by package name. Add an entry only after a dependency review.
export const runtimeDependencyAllowlist = {};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// .nvmrc selects the Node.js and npm versions of the CI jobs. An exact version prevents an unreviewed change of the tools.
export function nvmrcProblems(text) {
  if (text === undefined) return ['.nvmrc: file not found.'];
  return /^\d+\.\d+\.\d+\r?\n?$/.test(text) ? [] : ['.nvmrc: give an exact Node.js version X.Y.Z.'];
}

// The root engines field must allow the .nvmrc version and nothing older.
export function enginesProblems(rootManifest, nvmrc) {
  const expected = `>=${(nvmrc ?? '').trim()}`;
  return rootManifest?.engines?.node === expected ? [] : [`package.json: engines.node must be "${safe(expected)}", the same version as .nvmrc.`];
}

// Base TypeScript configuration: required options must be present with the documented values.
export function baseTsconfigProblems(config) {
  const options = isObject(config?.compilerOptions) ? config.compilerOptions : {};
  return Object.entries(requiredCompilerOptions)
    .filter(([key, value]) => options[key] !== value)
    .map(([key, value]) => `configs/tsconfig.base.json: compilerOptions.${key} must be ${JSON.stringify(value)}.`);
}

// Package TypeScript configuration: local paths only and one package alias.
export function packageTsconfigProblems(dir, config) {
  const file = `packages/${dir}/tsconfig.json`;
  const problems = [];
  const options = isObject(config?.compilerOptions) ? config.compilerOptions : {};
  if (config?.extends !== '../../configs/tsconfig.base.json') problems.push(`${file}: extends must point to ../../configs/tsconfig.base.json.`);
  for (const key of Object.keys(options)) if (!localCompilerOptions.has(key)) problems.push(`${file}: set compilerOptions.${key} only in configs/tsconfig.base.json.`);
  if (options.rootDir !== '.') problems.push(`${file}: rootDir must be ".".`);
  if (options.outDir !== 'dist') problems.push(`${file}: outDir must be "dist".`);
  const paths = isObject(options.paths) ? options.paths : {};
  for (const [key, value] of Object.entries(paths)) {
    if (key === `@${dir}/*`) {
      if (!same(value, ['./src/*.ts'])) problems.push(`${file}: paths["@${dir}/*"] must be ["./src/*.ts"].`);
    } else {
      problems.push(`${file}: the alias ${safe(key)} is not permitted. Use only @${dir}/*. Use workspace dependencies for other packages.`);
    }
  }
  if (!(`@${dir}/*` in paths)) problems.push(`${file}: the alias @${dir}/* is missing.`);
  if (!Array.isArray(config?.include) || !config.include.includes('src/**/*.ts')) problems.push(`${file}: include must contain src/**/*.ts.`);
  for (const excluded of ['dist', 'node_modules']) {
    if (!Array.isArray(config?.exclude) || !config.exclude.includes(excluded)) problems.push(`${file}: exclude must contain ${excluded}.`);
  }
  return problems;
}

// Vite and Vitest must resolve the same package alias to the package source directory.
export function aliasProblems(dir, packageRoot, viteAlias, vitestAlias) {
  const expected = { [`@${dir}`]: resolve(packageRoot, 'src') };
  const problems = [];
  for (const [name, alias] of [
    ['vite.config.mjs', viteAlias],
    ['vitest.config.mjs', vitestAlias]
  ]) {
    if (!same(alias, expected)) problems.push(`packages/${dir}/${name}: resolve.alias must contain only @${dir} → src.`);
  }
  return problems;
}

// Package metadata from the new-package skill and docs/WORKSPACES.md.
export function manifestProblems(dir, manifest, rootManifest, exists = () => true) {
  const file = `packages/${dir}/package.json`;
  const problems = [];
  if (typeof manifest.description !== 'string' || manifest.description.trim() === '') problems.push(`${file}: description is missing.`);
  if (typeof manifest.license !== 'string' || manifest.license.trim() === '') problems.push(`${file}: license is missing.`);
  if (manifest.private !== true) problems.push(`${file}: private must be true. Publication needs a separate human decision.`);
  if (manifest.type !== 'module') problems.push(`${file}: type must be "module".`);
  if (manifest.engines?.node !== rootManifest.engines?.node) problems.push(`${file}: engines.node must be the same as in the root package.json (${safe(rootManifest.engines?.node)}).`);
  if (!exists('README.md')) problems.push(`packages/${dir}: README.md is missing.`);
  if (!isObject(manifest.exports)) problems.push(`${file}: exports must be an object.`);
  const scripts = isObject(manifest.scripts) ? manifest.scripts : {};
  for (const name of requiredScripts) if (typeof scripts[name] !== 'string') problems.push(`${file}: the ${name} script is missing.`);
  for (const name of installHooks) if (name in scripts) problems.push(`${file}: the ${name} script is not permitted. Do not use installation hooks.`);
  const targets = isObject(manifest.bin) ? [...new Set(Object.values(manifest.bin))] : [];
  if (manifest.bin !== undefined && targets.length !== 1) {
    problems.push(`${file}: bin must point to one entry point.`);
  } else if (targets.length === 1) {
    const [target] = targets;
    const start = typeof scripts.start === 'string' ? scripts.start : '';
    if (!start.split('&&').some((part) => part.trim() === `node ${target}`)) problems.push(`${file}: start must run node ${safe(target)}, the same as bin.`);
    const sourceEntry = posix
      .normalize(String(target))
      .replace(/^dist\//, '')
      .replace(/\.js$/, '.ts');
    if (!exists(sourceEntry)) problems.push(`${file}: the source file ${safe(sourceEntry)} for bin is missing.`);
    else if (!exists(sourceEntry, '#!/usr/bin/env node\n')) problems.push(`packages/${dir}/${safe(sourceEntry)}: the entry point must start with #!/usr/bin/env node.`);
  }
  for (const field of dependencyFields) {
    const value = manifest[field];
    if (value === undefined) continue;
    const names = Array.isArray(value) ? value : isObject(value) ? Object.keys(value) : [];
    const allowed = runtimeDependencyAllowlist[manifest.name] ?? [];
    for (const name of names) if (!allowed.includes(name)) problems.push(`${file}: ${field}.${safe(name)} is not in the approved runtime dependencies in scripts/ci/config.mjs.`);
  }
  if (manifest.devDependencies !== undefined) problems.push(`${file}: keep devDependencies in the root package.json.`);
  return problems;
}

// Development dependencies must use exact versions, because save-exact applies only to new installs.
export function exactVersionProblems(file, manifest) {
  return Object.entries(isObject(manifest.devDependencies) ? manifest.devDependencies : {})
    .filter(([, value]) => typeof value !== 'string' || !exactVersion.test(value))
    .map(([name, value]) => `${file}: devDependencies.${safe(name)} must have an exact version, not ${safe(value)}.`);
}

// The package version must agree with the root lockfile. A difference shows a manual version edit.
export function lockfileProblems(packages, lockfile) {
  const problems = [];
  for (const item of packages) {
    const entry = lockfile?.packages?.[`packages/${item.dir}`];
    if (!entry) problems.push(`package-lock.json: the packages/${item.dir} entry is missing.`);
    else if (entry.version !== item.version || entry.name !== item.name) {
      problems.push(`package-lock.json: packages/${item.dir} must be ${safe(item.name)}@${item.version}. Change versions only with npm version.`);
    }
  }
  return problems;
}

// Repository structure: rule file names, generated output, lockfiles, shell scripts, and binary assets. `files` are tracked paths.
export function structureProblems(files) {
  const problems = [];
  for (const path of files) {
    const parts = path.split('/');
    const name = parts.at(-1) ?? '';
    if (ruleFileNames.has(name.toLowerCase()) && name !== name.toUpperCase().replace(/\.MD$/, '.md')) problems.push(`${safe(path)}: use the name ${safe(name.toUpperCase().replace(/\.MD$/, '.md'))}.`);
    if (['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].includes(name) && parts.length > 1 && !vendoredSkills.test(path))
      problems.push(`${safe(path)}: an agent rule file is permitted only in the repository root.`);
    if (parts.includes('dist')) problems.push(`${safe(path)}: generated dist/ output is not kept in Git.`);
    if (lockfiles.has(name) && path !== 'package-lock.json') problems.push(`${safe(path)}: use only the root package-lock.json.`);
    if (/\.(sh|bash|zsh)$/.test(name) && !vendoredSkills.test(path) && !shellScriptAllowlist.includes(path)) {
      problems.push(`${safe(path)}: the Bash script is not in the permitted list. Use Node.js or document the exception.`);
    }
    if (hostConfig.some((pattern) => pattern.test(path)) && !hostConfigAllowlist.includes(path)) {
      problems.push(`${safe(path)}: agent host settings and override instructions can run commands or change permissions. Add the file only after a human decision.`);
    }
    if (binaryAsset.test(name) && !vendoredSkills.test(path) && !binaryAssetAllowlist.includes(path)) {
      problems.push(`${safe(path)}: images, editor files, archives, and model weights stay out of Git until the storage decision. Use synthetic test images made at run time.`);
    }
  }
  return problems;
}

// Repository text is in English (AGENTS.md, Documentation). Report tracked text files with Cyrillic characters. The text itself is not repeated.
export function languageProblems(files, read) {
  const problems = [];
  for (const path of files) {
    if (!textFile.test(path) || languageExempt.some((pattern) => pattern.test(path))) continue;
    let text;
    try {
      text = read(path);
    } catch {
      continue;
    }
    if (typeof text === 'string' && cyrillic.test(text)) problems.push(`${safe(path)}: contains Cyrillic text. Repository text must be in English.`);
  }
  return problems;
}

// Frontmatter value of a SKILL.md file. Only simple one-line values are read.
export function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  const result = {};
  for (const line of (match?.[1] ?? '').split(/\r?\n/)) {
    const field = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (field?.[1] && field[2] !== undefined) result[field[1]] = field[2].trim();
  }
  return result;
}

// A vendor skill adapter must keep the name and description of the shared skill in .agents/skills.
export function adapterProblems(base = root) {
  const problems = [];
  for (const vendor of ['.claude', '.codex', '.gemini']) {
    const directory = join(base, vendor, 'skills');
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const adapter = join(directory, entry.name, 'SKILL.md');
      const shared = join(base, '.agents', 'skills', entry.name, 'SKILL.md');
      const adapterText = readRegularFile(adapter);
      if (adapterText === undefined) continue;
      const sharedText = readRegularFile(shared);
      if (sharedText === undefined) {
        problems.push(`${vendor}/skills/${safe(entry.name)}: the shared skill .agents/skills/${safe(entry.name)}/SKILL.md is missing.`);
        continue;
      }
      const left = frontmatter(adapterText);
      const right = frontmatter(sharedText);
      if (left.name !== right.name || left.description !== right.description) {
        problems.push(`${vendor}/skills/${safe(entry.name)}/SKILL.md: name and description must be the same as in .agents/skills/${safe(entry.name)}/SKILL.md.`);
      }
    }
  }
  return problems;
}

function listFiles(directory, prefix = '') {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...listFiles(join(directory, entry.name), path));
    else result.push(path);
  }
  return result;
}

// Skill files must agree with the reviewed state in docs/skill-provenance.json. Skill frontmatter must not grant
// tools outside skillToolAllowlist or add hooks, and SKILL.md must not contain a pre-prompt command.
export function skillProblems(base = root) {
  const problems = [];
  const directory = join(base, '.agents', 'skills');
  if (!existsSync(directory)) return problems;
  const manifestText = readRegularFile(join(base, 'docs', 'skill-provenance.json'));
  const manifest = manifestText === undefined ? undefined : JSON.parse(manifestText);
  const reviewed = isObject(manifest?.skills) ? manifest.skills : {};
  if (manifestText === undefined) problems.push('docs/skill-provenance.json: file not found.');
  const names = readdirSync(directory, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'));
  for (const entry of names) {
    const name = entry.name;
    const label = `.agents/skills/${safe(name)}`;
    if (!entry.isDirectory()) {
      problems.push(`${label}: expected a skill directory.`);
      continue;
    }
    const skillText = readRegularFile(join(directory, name, 'SKILL.md'));
    if (skillText === undefined) {
      problems.push(`${label}: SKILL.md is missing.`);
      continue;
    }
    const fields = frontmatter(skillText);
    if ('hooks' in fields) problems.push(`${label}/SKILL.md: hooks are not permitted in a skill.`);
    if ('allowed-tools' in fields) {
      const tools = fields['allowed-tools'].split(/[\s,]+/).filter(Boolean);
      const extra = tools.filter((tool) => !skillToolAllowlist.includes(tool));
      if (tools.length === 0 || extra.length > 0) problems.push(`${label}/SKILL.md: allowed-tools contains tools that are not permitted: ${safe(extra.join(' ') || '(empty)')}.`);
    }
    if (skillText.includes('!`')) problems.push(`${label}/SKILL.md: a !\`...\` command runs when the skill loads and is not permitted.`);
    if (localSkills.includes(name)) continue;
    const record = reviewed[name];
    if (!isObject(record) || !Array.isArray(record.files)) {
      problems.push(`${label}: the skill is not in docs/skill-provenance.json.`);
      continue;
    }
    const expected = new Map(record.files.map((file) => [file?.path, file?.sha256]));
    const actual = listFiles(join(directory, name));
    for (const path of actual) {
      const full = join(directory, name, path);
      if (!expected.has(path)) {
        problems.push(`${label}/${safe(path)}: the file is not in docs/skill-provenance.json.`);
        continue;
      }
      // One descriptor opened without following links prevents a change between the check and the read.
      let bytes;
      try {
        bytes = readRegularFile(full, undefined, null);
      } catch {
        problems.push(`${label}/${safe(path)}: expected a regular file, not a link.`);
        continue;
      }
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (hash !== expected.get(path)) problems.push(`${label}/${safe(path)}: SHA-256 does not agree with docs/skill-provenance.json.`);
    }
    for (const path of expected.keys()) if (!actual.includes(path)) problems.push(`${label}/${safe(String(path))}: the file from docs/skill-provenance.json is missing.`);
  }
  for (const name of Object.keys(reviewed)) if (!names.some((entry) => entry.name === name)) problems.push(`docs/skill-provenance.json: the skill ${safe(name)} is missing.`);
  // Claude Code reads third-party skills through relative links. A link must stay inside .agents/skills.
  const claude = join(base, '.claude', 'skills');
  if (existsSync(claude)) {
    for (const entry of readdirSync(claude, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue;
      const target = readlinkSync(join(claude, entry.name));
      if (target !== `../../.agents/skills/${entry.name}`) problems.push(`.claude/skills/${safe(entry.name)}: the link must point to ../../.agents/skills/${safe(entry.name)}.`);
    }
  }
  return problems;
}

const indentOf = (line) => line.length - line.trimStart().length;

// YAML forms of an event name: a key, a block list item, a flow list on the `on` line, or a flow list continuation. Quotes are optional.
function eventPatterns(event) {
  const name = `['"]?${event}['"]?`;
  return [new RegExp(`^\\s*${name}\\s*:`), new RegExp(`^\\s*-\\s*${name}\\s*(#.*)?$`), new RegExp(`^\\s*['"]?on['"]?\\s*:.*[\\s\\[{,'"]${event}\\b`), new RegExp(`^\\s*${name}\\s*[,\\]}]`)];
}

// GitHub Actions rules from AGENTS.md. The parser reads the line structure of the workflow files in this repository.
export function workflowRuleProblems(file, text) {
  const lines = text.split(/\r?\n/);
  const code = lines.filter((line) => !line.trimStart().startsWith('#'));
  const problems = [];
  const top = lines.findIndex((line) => /^['"]?permissions['"]?\s*:/.test(line));
  if (top < 0) problems.push(`${file}: top-level permissions are missing.`);
  else {
    // Top-level permissions are read-only. A job that needs write access sets it in its own permissions block.
    const end = lines.findIndex((line, position) => position > top && line.trim() !== '' && !line.trimStart().startsWith('#') && indentOf(line) === 0);
    const block = [lines[top] ?? '', ...lines.slice(top + 1, end < 0 ? lines.length : end)];
    if (block.some((line) => /:\s*\{?.*\bwrite\b/.test(line.replace(/#.*$/, '')))) problems.push(`${file}: top-level permissions must be read-only. Give write access only to the job that needs it.`);
  }
  if (code.some((line) => /^\s*permissions\s*:\s*['"]?write-all\b/.test(line))) problems.push(`${file}: permissions: write-all is not permitted.`);
  for (const event of forbiddenWorkflowEvents) {
    const patterns = eventPatterns(event);
    if (code.some((line) => patterns.some((pattern) => pattern.test(line)))) problems.push(`${file}: the ${event} event is not permitted.`);
  }
  lines.forEach((line, index) => {
    const number = index + 1;
    const uses = /^(\s*)(- )?uses:\s*(\S+)(\s+#\s*(\S+))?\s*$/.exec(line);
    if (uses) {
      const [, spaces = '', dash, target = '', , comment] = uses;
      if (!target.startsWith('./')) {
        if (!fullSha.test(target)) problems.push(`${file}:${number}: pin the action to a full commit SHA.`);
        else if (!comment || !/^v\d/.test(comment)) problems.push(`${file}:${number}: add a version comment after the SHA, for example # v1.2.3.`);
      }
      if (/^actions\/checkout@/.test(target)) {
        const stepIndent = dash ? spaces.length : findStepIndent(lines, index, spaces.length);
        const end = lines.findIndex((next, position) => position > index && next.trim() !== '' && indentOf(next) <= stepIndent);
        const step = lines.slice(index + 1, end < 0 ? lines.length : end);
        if (!step.some((next) => /^\s*persist-credentials:\s*false\s*$/.test(next))) problems.push(`${file}:${number}: checkout must have persist-credentials: false.`);
      }
    }
    const run = /^(\s*)(- )?run:\s*(.*)$/.exec(line);
    if (run) {
      const [, spaces = '', dash, value = ''] = run;
      const keyIndent = spaces.length + (dash ? 2 : 0);
      let body = [value];
      if (/^[|>]/.test(value)) {
        const end = lines.findIndex((next, position) => position > index && next.trim() !== '' && indentOf(next) <= keyIndent);
        body = lines.slice(index + 1, end < 0 ? lines.length : end);
      }
      if (body.some((part) => part.includes('${{'))) problems.push(`${file}:${number}: do not put \${{ }} expressions in run. Give the value through env.`);
    }
  });
  return problems;
}

function findStepIndent(lines, index, keyIndent) {
  for (let position = index - 1; position >= 0; position--) {
    const line = lines[position] ?? '';
    if (line.trim() === '') continue;
    const step = /^(\s*)- /.exec(line);
    if (step?.[1] !== undefined && step[1].length < keyIndent) return step[1].length;
  }
  return keyIndent;
}

function trackedFiles(base) {
  // Inherited GIT_* variables could select another repository or index.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const result = spawnSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', 'ls-files', '-z'], {
    cwd: base,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000
  });
  if (result.error || result.status !== 0) throw new Error('Cannot get the file list from git ls-files.');
  return result.stdout.split('\0').filter(Boolean);
}

async function configAlias(path) {
  const config = (await import(pathToFileURL(path).href)).default;
  return config?.resolve?.alias;
}

export async function configProblems(base = root, files = trackedFiles(base)) {
  const problems = [];
  problems.push(...baseTsconfigProblems(readJson(join(base, 'configs', 'tsconfig.base.json'))));
  const rootManifest = readJson(join(base, 'package.json'));
  const nvmrc = readRegularFile(join(base, '.nvmrc'));
  problems.push(...exactVersionProblems('package.json', rootManifest));
  problems.push(...nvmrcProblems(nvmrc));
  problems.push(...enginesProblems(rootManifest, nvmrc));
  const packages = listPackages(base);
  for (const item of packages) {
    const packageRoot = join(base, 'packages', item.dir);
    problems.push(...packageTsconfigProblems(item.dir, readJson(join(packageRoot, 'tsconfig.json'))));
    problems.push(...aliasProblems(item.dir, packageRoot, await configAlias(join(packageRoot, 'vite.config.mjs')), await configAlias(join(packageRoot, 'vitest.config.mjs'))));
    const exists = (path, prefix) => {
      const full = join(packageRoot, path);
      let text;
      try {
        text = readRegularFile(full);
      } catch {
        return false;
      }
      return text !== undefined && (prefix === undefined || text.startsWith(prefix));
    };
    problems.push(...manifestProblems(item.dir, readJson(join(packageRoot, 'package.json')), rootManifest, exists));
  }
  problems.push(...lockfileProblems(packages, readJson(join(base, 'package-lock.json'))));
  problems.push(...structureProblems(files));
  problems.push(...languageProblems(files, (path) => readRegularFile(join(base, path))));
  problems.push(...adapterProblems(base));
  problems.push(...skillProblems(base));
  const workflowDirectory = join(base, '.github', 'workflows');
  if (existsSync(workflowDirectory)) {
    for (const name of readdirSync(workflowDirectory)
      .filter((item) => /\.ya?ml$/.test(item))
      .sort()) {
      problems.push(...workflowRuleProblems(`.github/workflows/${name}`, readFileSync(join(workflowDirectory, name), 'utf8')));
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(async () => {
    const problems = await configProblems();
    if (problems.length) throw new Error(`The repository settings do not agree with the documentation:\n${problems.join('\n')}`);
    console.log('The TypeScript, package, structure, language, skill, and GitHub Actions settings agree with the documentation.');
  });
}
