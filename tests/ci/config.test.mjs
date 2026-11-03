import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  adapterProblems,
  aliasProblems,
  baseTsconfigProblems,
  configProblems,
  enginesProblems,
  exactVersionProblems,
  frontmatter,
  languageProblems,
  lockfileProblems,
  manifestProblems,
  nvmrcProblems,
  packageTsconfigProblems,
  requiredCompilerOptions,
  skillProblems,
  structureProblems,
  workflowRuleProblems
} from '../../scripts/ci/config.mjs';
import { root } from '../../scripts/ci/lib.mjs';

function temporary(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const rootManifest = { engines: { node: '>=26.12.1' } };
const goodManifest = {
  name: '@scope/demo',
  version: '0.1.0',
  description: 'Demo',
  private: true,
  license: 'MIT',
  type: 'module',
  engines: { node: '>=26.12.1' },
  bin: { 'demo-cli': 'dist/src/cli.js' },
  exports: { '.': './dist/src/index.js' },
  scripts: {
    build: 'vite build',
    typecheck: 'tsc --noEmit',
    test: 'npm run build && vitest run',
    lint: 'eslint .',
    'format:check': 'prettier --check .',
    start: 'npm run build && node dist/src/cli.js'
  }
};
const exists = (path, prefix) => ['README.md', 'src/cli.ts'].includes(path) && (prefix === undefined || path === 'src/cli.ts');
const goodTsconfig = {
  extends: '../../configs/tsconfig.base.json',
  compilerOptions: { rootDir: '.', outDir: 'dist', paths: { '@demo/*': ['./src/*.ts'] } },
  include: ['src/**/*.ts', 'test/**/*.ts'],
  exclude: ['dist', 'node_modules']
};
// Build Cyrillic text at run time, so that this source file stays in English.
const cyrillicWord = String.fromCodePoint(0x0442, 0x0435, 0x043a, 0x0441, 0x0442);

test('the current repository passes the configuration check', async () => {
  assert.deepEqual(await configProblems(), []);
});

test('the base tsconfig keeps every required compiler option', () => {
  assert.deepEqual(baseTsconfigProblems({ compilerOptions: requiredCompilerOptions }), []);
  const problems = baseTsconfigProblems({ compilerOptions: { ...requiredCompilerOptions, strict: false, moduleResolution: 'Node' } });
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /strict/);
  assert.match(problems.join('\n'), /moduleResolution/);
  assert.equal(baseTsconfigProblems({}).length, Object.keys(requiredCompilerOptions).length);
});

test('a package tsconfig sets only local paths and its own alias', () => {
  assert.deepEqual(packageTsconfigProblems('demo', goodTsconfig), []);
  const bad = {
    extends: './other.json',
    compilerOptions: { rootDir: 'src', outDir: 'lib', strict: false, paths: { '@/*': ['./src/*'], '@other/*': ['../other/src/*.ts'] } },
    include: ['test/**/*.ts'],
    exclude: ['dist']
  };
  const problems = packageTsconfigProblems('demo', bad).join('\n');
  for (const pattern of [/extends/, /strict/, /rootDir/, /outDir/, /@\/\*/, /@other/, /alias @demo\/\* is missing/, /include/, /node_modules/]) assert.match(problems, pattern);
});

test('Vite and Vitest aliases must point to the package source', () => {
  const packageRoot = resolve('/repo/packages/demo');
  const alias = { '@demo': join(packageRoot, 'src') };
  assert.deepEqual(aliasProblems('demo', packageRoot, alias, alias), []);
  assert.equal(aliasProblems('demo', packageRoot, { '@demo': join(packageRoot, 'lib') }, undefined).length, 2);
  assert.equal(aliasProblems('demo', packageRoot, alias, { ...alias, '@': join(packageRoot, 'src') }).length, 1);
});

test('package metadata follows the package requirements', () => {
  assert.deepEqual(manifestProblems('demo', goodManifest, rootManifest, exists), []);
  const library = { ...goodManifest, bin: undefined, scripts: { ...goodManifest.scripts, start: undefined } };
  assert.deepEqual(manifestProblems('demo', library, rootManifest, exists), []);
  const bad = {
    ...goodManifest,
    description: '',
    private: false,
    type: 'commonjs',
    engines: { node: '>=20' },
    exports: './dist/src/index.js',
    scripts: { build: 'vite build', start: 'node dist/other.js', postinstall: 'node x.js' },
    dependencies: { sharp: '1.0.0' },
    devDependencies: { vitest: '5.0.0' }
  };
  const problems = manifestProblems('demo', bad, rootManifest, () => false).join('\n');
  for (const pattern of [/description/, /private/, /type/, /engines/, /README/, /exports/, /typecheck/, /lint/, /format:check/, /start/, /postinstall/, /sharp/, /devDependencies/, /src\/cli\.ts/]) {
    assert.match(problems, pattern);
  }
  assert.match(manifestProblems('demo', { ...goodManifest, bin: { a: 'dist/a.js', b: 'dist/b.js' } }, rootManifest, exists).join('\n'), /one entry point/);
  assert.match(manifestProblems('demo', goodManifest, rootManifest, (path, prefix) => prefix === undefined).join('\n'), /#!\/usr\/bin\/env node/);
});

test('development dependencies use exact versions', () => {
  assert.deepEqual(exactVersionProblems('package.json', { devDependencies: { eslint: '10.13.0', next: '1.0.0-rc.1' } }), []);
  assert.equal(exactVersionProblems('package.json', { devDependencies: { eslint: '^10.13.0', prettier: '~3.0.0', vite: 'latest' } }).length, 3);
});

test('the package version agrees with the root lockfile', () => {
  const packages = [{ dir: 'demo', name: '@scope/demo', version: '0.1.1' }];
  assert.deepEqual(lockfileProblems(packages, { packages: { 'packages/demo': { name: '@scope/demo', version: '0.1.1' } } }), []);
  assert.match(lockfileProblems(packages, { packages: { 'packages/demo': { name: '@scope/demo', version: '0.1.0' } } }).join(''), /npm version/);
  assert.match(lockfileProblems(packages, { packages: {} }).join(''), /entry is missing/);
});

test('repository structure rejects lowercase rule files, dist, extra lockfiles, shell scripts, and binary assets', () => {
  assert.deepEqual(
    structureProblems([
      'AGENTS.md',
      'package-lock.json',
      'packages/demo/src/cli.ts',
      '.agents/skills/vendor/run.sh',
      '.agents/skills/vendor/CLAUDE.md',
      '.agents/skills/vendor/assets/mark.png',
      'docs/mark.svg'
    ]),
    []
  );
  const problems = structureProblems([
    'agents.md',
    'docs/AGENTS.md',
    'packages/demo/dist/src/cli.js',
    'packages/demo/package-lock.json',
    'packages/demo/yarn.lock',
    'scripts/run.sh',
    'packages/demo/Skill.md',
    'characters/demo/parts/head.png',
    'characters/demo/demo.psd',
    'models/base.safetensors'
  ]);
  assert.equal(problems.length, 10);
});

test('repository structure rejects agent host settings and override instruction files', () => {
  assert.deepEqual(structureProblems(['.claude/agents/security-reviewer.md', '.claude/skills/demo/SKILL.md', '.github/copilot-instructions.md']), []);
  const files = [
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.mcp.json',
    '.gemini/settings.json',
    '.codex/config.toml',
    '.cursor/rules/demo.mdc',
    '.vscode/tasks.json',
    'AGENTS.override.md',
    'packages/demo/AGENTS.override.md',
    'CLAUDE.local.md',
    '.cursorrules'
  ];
  const problems = structureProblems(files);
  for (const file of files)
    assert.ok(
      problems.some((problem) => problem.startsWith(`${file}: agent host settings`)),
      file
    );
});

test('tracked text files outside vendored content are in English', () => {
  const files = {
    'docs/A.md': `Text ${cyrillicWord}.`,
    'src/a.ts': 'English only.',
    '.agents/skills/vendor/SKILL.md': cyrillicWord,
    'docs/skill-patches/x.patch': cyrillicWord,
    'image.bin': cyrillicWord
  };
  const problems = languageProblems(Object.keys(files), (path) => files[path]);
  assert.deepEqual(problems, ['docs/A.md: contains Cyrillic text. Repository text must be in English.']);
  assert.ok(!problems.join('').includes(cyrillicWord));
});

test('a skill adapter keeps the shared name and description', (t) => {
  const base = temporary(t, 'aigg-config-skills-');
  const write = (path, text) => {
    mkdirSync(join(base, path, '..'), { recursive: true });
    writeFileSync(join(base, path), text);
  };
  write('.agents/skills/demo/SKILL.md', '---\nname: demo\ndescription: Shared text.\n---\nBody\n');
  write('.claude/skills/demo/SKILL.md', '---\nname: demo\ndescription: Shared text.\n---\nAdapter\n');
  assert.deepEqual(adapterProblems(base), []);
  write('.claude/skills/demo/SKILL.md', '---\nname: demo\ndescription: Other text.\n---\nAdapter\n');
  write('.codex/skills/missing/SKILL.md', '---\nname: missing\ndescription: Text.\n---\n');
  assert.equal(adapterProblems(base).length, 2);
  assert.deepEqual(frontmatter('---\nname: x\ndescription: y: z\n---\n'), { name: 'x', description: 'y: z' });
});

const sha = 'a'.repeat(40);
const goodWorkflow = `name: Demo
on:
  pull_request:
permissions:
  contents: read
jobs:
  demo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${sha} # v7.0.1
        with:
          persist-credentials: false
      - name: Setup
        uses: actions/setup-node@${sha} # v7.1.0
      - uses: ./.github/workflows/local.yml
      - name: Run
        env:
          PACKAGE: \${{ inputs.package }}
        run: |
          echo "$PACKAGE"
      - run: npm test
`;

test('workflows pin actions, drop checkout credentials, and keep expressions out of run', () => {
  assert.deepEqual(workflowRuleProblems('demo.yml', goodWorkflow), []);
  const bad = goodWorkflow
    .replace('permissions:\n  contents: read\n', '')
    .replace('  pull_request:\n', '  pull_request_target:\n')
    .replace(`actions/setup-node@${sha} # v7.1.0`, 'actions/setup-node@v7')
    .replace('          persist-credentials: false\n', '          fetch-depth: 0\n')
    .replace('echo "$PACKAGE"', 'echo "${{ inputs.package }}"')
    .replace('- run: npm test', '- run: echo ${{ github.event.pull_request.title }}');
  const problems = workflowRuleProblems('demo.yml', bad).join('\n');
  for (const pattern of [/permissions/, /pull_request_target/, /full commit SHA/, /persist-credentials/, /run/]) assert.match(problems, pattern);
  assert.equal(workflowRuleProblems('demo.yml', bad).filter((problem) => problem.includes('in run.')).length, 2);
  assert.match(workflowRuleProblems('demo.yml', goodWorkflow.replace(' # v7.1.0', '')).join(''), /version comment/);
});

test('workflows reject events that run with secrets for pull request or comment text', () => {
  for (const event of ['workflow_run', 'issue_comment', 'pull_request_review', 'pull_request_review_comment']) {
    assert.match(workflowRuleProblems('demo.yml', goodWorkflow.replace('  pull_request:\n', `  ${event}:\n`)).join('\n'), new RegExp(`the ${event} event is not permitted`));
  }
  assert.match(workflowRuleProblems('demo.yml', goodWorkflow.replace(/^on:\n/m, 'on: [push, workflow_run]\n')).join('\n'), /the workflow_run event is not permitted/);
  // Other YAML forms of the same event: block list, quoted key, quoted `on`, and a flow list on two lines.
  const forms = [
    ['on:\n  - push\n  - pull_request_target\n', 'pull_request_target'],
    ["on:\n  'workflow_run':\n    workflows: [Tests]\n", 'workflow_run'],
    ['"on": [push, issue_comment]\n', 'issue_comment'],
    ['on: [push,\n  discussion_comment]\n', 'discussion_comment']
  ];
  for (const [on, event] of forms) {
    const text = goodWorkflow.replace(/^on:\n(\s+.*\n)+/m, on);
    assert.match(workflowRuleProblems('demo.yml', text).join('\n'), new RegExp(`the ${event} event is not permitted`), on);
  }
});

test('top-level workflow permissions are read-only', () => {
  for (const permissions of ['permissions: write-all\n', 'permissions:\n  contents: write\n', 'permissions: { contents: write }\n']) {
    const text = goodWorkflow.replace('permissions:\n  contents: read\n', permissions);
    assert.match(workflowRuleProblems('demo.yml', text).join('\n'), /top-level permissions must be read-only/, permissions);
  }
  assert.deepEqual(workflowRuleProblems('demo.yml', goodWorkflow.replace('permissions:\n  contents: read\n', 'permissions: read-all\n')), []);
  const jobWrite = goodWorkflow.replace(/(\n {4}runs-on: [^\n]+\n)/, '$1    permissions:\n      security-events: write\n');
  assert.notEqual(jobWrite, goodWorkflow);
  assert.deepEqual(workflowRuleProblems('demo.yml', jobWrite), []);
  assert.match(workflowRuleProblems('demo.yml', goodWorkflow.replace(/(\n {4}runs-on: [^\n]+\n)/, '$1    permissions: write-all\n')).join('\n'), /write-all is not permitted/);
});

test('a third-party skill must match the provenance manifest and the tool allowlist', (t) => {
  const base = temporary(t, 'aigg-config-provenance-');
  const write = (path, text) => {
    mkdirSync(join(base, path, '..'), { recursive: true });
    writeFileSync(join(base, path), text);
  };
  const hash = (text) => createHash('sha256').update(text).digest('hex');
  const skill = '---\nname: vendor\ndescription: Text.\nallowed-tools: Read Grep Glob\n---\nBody\n';
  write('.agents/skills/vendor/SKILL.md', skill);
  write('.agents/skills/local/SKILL.md', '---\nname: local\ndescription: Text.\n---\n');
  write('docs/skill-provenance.json', JSON.stringify({ skills: { vendor: { files: [{ path: 'SKILL.md', sha256: hash(skill) }] } } }));
  mkdirSync(join(base, '.claude', 'skills'), { recursive: true });
  symlinkSync('../../.agents/skills/vendor', join(base, '.claude', 'skills', 'vendor'));
  assert.deepEqual(skillProblems(base), ['.agents/skills/local: the skill is not in docs/skill-provenance.json.']);

  const changed = skill.replace('Read Grep Glob', 'Read Grep Glob Bash').replace('Body', 'Body !`id`');
  write('.agents/skills/vendor/SKILL.md', changed.replace('---\nBody', 'hooks:\n---\nBody'));
  write('.agents/skills/vendor/run.py', 'print(1)\n');
  symlinkSync('../../../outside', join(base, '.claude', 'skills', 'other'));
  const problems = skillProblems(base).join('\n');
  for (const pattern of [/hooks/, /allowed-tools.*Bash/, /!`/, /SHA-256/, /run\.py: the file is not/, /\.claude\/skills\/other/]) assert.match(problems, pattern);
});

test('.nvmrc must contain an exact Node.js version and agree with engines', () => {
  assert.deepEqual(nvmrcProblems('26.12.1\n'), []);
  for (const text of ['26\n', '26.12\n', 'lts/*\n', 'v26.12.1\n', undefined]) assert.equal(nvmrcProblems(text).length, 1);
  assert.deepEqual(enginesProblems({ engines: { node: '>=26.12.1' } }, '26.12.1\n'), []);
  assert.equal(enginesProblems({ engines: { node: '>=24.12.0' } }, '26.12.1\n').length, 1);
  assert.equal(enginesProblems({}, '26.12.1\n').length, 1);
});

test('the configuration check reads a copied repository with a synthetic package', async (t) => {
  // Node.js loads modules from real paths. On macOS the temporary directory is a link to /private.
  const base = realpathSync(temporary(t, 'aigg-config-repo-'));
  for (const path of ['.nvmrc', 'package.json', 'package-lock.json', 'configs', '.github', '.agents', '.claude', 'docs']) {
    cpSync(join(root, path), join(base, path), { recursive: true, verbatimSymlinks: true, filter: (source) => !/[\\/](node_modules|dist)([\\/]|$)/.test(source) });
  }
  // The copied Vite configurations import the installed development dependencies.
  symlinkSync(join(root, 'node_modules'), join(base, 'node_modules'), 'junction');
  const files = ['package.json', 'package-lock.json'];
  assert.deepEqual(await configProblems(base, files), []);

  const demo = join(base, 'packages', 'demo');
  mkdirSync(join(demo, 'src'), { recursive: true });
  writeFileSync(join(demo, 'package.json'), JSON.stringify({ ...goodManifest, bin: undefined, scripts: { ...goodManifest.scripts, start: undefined } }));
  writeFileSync(join(demo, 'tsconfig.json'), JSON.stringify(goodTsconfig));
  writeFileSync(join(demo, 'README.md'), '# Demo\n');
  const configImport = (name) => `import { fileURLToPath } from 'node:url';\nimport { ${name} } from '../../configs/${name === 'nodePackageConfig' ? 'vite' : 'vitest'}.config.mjs';\n`;
  writeFileSync(
    join(demo, 'vite.config.mjs'),
    `${configImport('nodePackageConfig')}export default nodePackageConfig({ root: fileURLToPath(new URL('.', import.meta.url)), namespace: 'demo', modules: ['index'] });\n`
  );
  writeFileSync(
    join(demo, 'vitest.config.mjs'),
    `${configImport('nodeTestConfig')}const root = fileURLToPath(new URL('.', import.meta.url));\nexport default nodeTestConfig({ root, resolve: { alias: { '@demo': root + 'src' } } });\n`
  );
  // The lockfile has no entry for the synthetic package, so only that problem is expected.
  assert.deepEqual(await configProblems(base, files), ['package-lock.json: the packages/demo entry is missing.']);

  const tsconfig = join(base, 'configs', 'tsconfig.base.json');
  writeFileSync(tsconfig, readFileSync(tsconfig, 'utf8').replace('"strict": true', '"strict": false'));
  assert.match((await configProblems(base, files)).join('\n'), /strict/);
});
