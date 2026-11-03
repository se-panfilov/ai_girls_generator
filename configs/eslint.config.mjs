import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const packagesDirectory = new URL('../packages/', import.meta.url);
// Package directories in packages/. Each package gets its own alias rules. An empty list is valid before the first package.
const packages = existsSync(packagesDirectory)
  ? readdirSync(packagesDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
  : [];
const cyrillic = '[\\u0400-\\u04FF]';

// The npm package name of a package directory. The name scope is an open decision (D21), so it is read from package.json.
function packageName(dir) {
  try {
    const name = JSON.parse(readFileSync(new URL(`${dir}/package.json`, packagesDirectory), 'utf8')).name;
    return typeof name === 'string' && name !== '' ? name : undefined;
  } catch {
    return undefined;
  }
}

const syntaxRestrictions = [
  { selector: "MethodDefinition[kind='set']", message: 'Use an explicit method instead of a property setter.' },
  { selector: "Property[kind='set']", message: 'Use an explicit method instead of a property setter.' },
  {
    selector:
      "Identifier[name='arguments']:not(MemberExpression[computed=false] > Identifier.property):not(Property[computed=false] > Identifier.key):not(MethodDefinition[computed=false] > Identifier.key):not(TSPropertySignature > Identifier.key)",
    message: 'Use explicit parameters or rest parameters.'
  },
  {
    selector: "CallExpression[arguments.length>2][callee.type='MemberExpression'][callee.object.name='Object'][callee.property.name='assign'][callee.computed=false]",
    message: 'Use at most two Object.assign arguments. Split the changes into explicit steps.'
  },
  {
    selector: "CallExpression[arguments.length>2][callee.type='MemberExpression'][callee.object.name='Object'][callee.property.value='assign'][callee.computed=true]",
    message: 'Use at most two Object.assign arguments. Split the changes into explicit steps.'
  },
  {
    selector: "Property[key.name='shell']:not([value.value=false])",
    message: 'Do not start subprocesses through a shell. Give the program and an argument array.'
  },
  {
    selector: 'ImportDeclaration[source.value=/^(node:)?child_process$/] > ImportDefaultSpecifier',
    message: 'Import named child_process functions so that the shell-based functions stay blocked.'
  },
  // All repository text is in English: interface strings, messages, prompts, and test names.
  { selector: `Literal[value=/${cyrillic}/]`, message: 'Write strings in English. The repository has no Russian text.' },
  { selector: `TemplateElement[value.raw=/${cyrillic}/]`, message: 'Write strings in English. The repository has no Russian text.' }
];

const builtinPaths = [
  ...builtinModules.filter((name) => !name.startsWith('_') && !name.startsWith('node:')).map((name) => ({ name, message: `Use the node:${name} import.` })),
  ...['node:child_process', 'child_process'].map((name) => ({
    name,
    importNames: ['exec', 'execSync'],
    message: 'These functions start a shell. Use execFile, spawn, or spawnSync with an argument array.'
  }))
];

// One option object for no-restricted-imports, because a later configuration block replaces the rule options.
function restrictedImports({ dir, source = false } = {}) {
  const patterns = [];
  if (dir) {
    const others = packages.filter((name) => name !== dir);
    patterns.push({ group: ['@/*', '@/'], message: `Use the @${dir}/* package alias. A generic @ alias is not permitted.` });
    if (others.length) {
      patterns.push({
        group: others.flatMap((name) => [`@${name}`, `@${name}/*`, `../../${name}/**`, `**/packages/${name}/**`]),
        message: 'Do not import the source of another package. Declare a workspace dependency and use the package exports.'
      });
    }
  }
  if (dir && source) {
    const name = packageName(dir);
    const paths = [...builtinPaths];
    const groups = ['./*', '../*'];
    if (name) {
      paths.push({ name, message: `Use the @${dir}/* package alias.` });
      groups.push(`${name}/*`);
    }
    patterns.push({ group: groups, message: `Use the @${dir}/* package alias for runtime modules.` });
    return ['error', { paths, patterns }];
  }
  return ['error', { paths: builtinPaths, patterns }];
}

// Report Cyrillic text in comments. Comments and documentation are in English.
const englishComments = {
  meta: { type: 'suggestion', schema: [], messages: { english: 'Write code comments in English.' } },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (new RegExp(cyrillic).test(comment.value)) context.report({ loc: comment.loc, messageId: 'english' });
        }
      }
    };
  }
};

export default defineConfig([
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/reports/**', '.agents/**', '.claude/**', '.codex/**', '.gemini/**'] },
  {
    files: ['**/*.{js,mjs,ts}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
    plugins: { 'simple-import-sort': simpleImportSort, project: { rules: { 'english-comments': englishComments } } },
    rules: {
      'consistent-return': 'error',
      'no-useless-computed-key': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'no-restricted-syntax': ['error', ...syntaxRestrictions],
      'no-restricted-imports': restrictedImports(),
      'project/english-comments': 'error'
    }
  },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/naming-convention': ['error', { selector: 'typeAlias', format: ['PascalCase'] }]
    }
  },
  {
    files: ['packages/*/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: repositoryRoot }
    },
    rules: {
      '@typescript-eslint/no-misused-spread': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }]
    }
  },
  {
    files: ['packages/*/src/**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // These rules trust static types over runtime values. Keep runtime checks of untrusted input, platform constants, and TTY state.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      '@typescript-eslint/no-useless-default-assignment': 'off'
    }
  },
  ...packages.flatMap((dir) => [
    { files: [`packages/${dir}/**/*.{js,mjs,ts}`], rules: { 'no-restricted-imports': restrictedImports({ dir }) } },
    { files: [`packages/${dir}/src/**/*.ts`], rules: { 'no-restricted-imports': restrictedImports({ dir, source: true }) } }
  ]),
  prettier
]);
