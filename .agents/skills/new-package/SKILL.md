---
name: new-package
description: Add a new pipeline package to packages/ in this repository. Use when the user asks to create, scaffold, or start a new pipeline tool, library, or workspace package.
---

# Add a pipeline package

Read [AGENTS.md](../../../AGENTS.md) and [the workspace layout](../../../docs/WORKSPACES.md) before you start.
Use [the asset-factory workflow](../asset-factory/SKILL.md) for the implementation and security review after the scaffold.
This skill makes the empty package structure. It does not authorize publication, a release, or a push to `master`.

## Collect the inputs

Get these values from the user or from the task before you write files:

| Input          | Rule                                                                                            | Example                        |
| -------------- | ----------------------------------------------------------------------------------------------- | ------------------------------ |
| Directory name | Matches `^[a-z][a-z0-9-]{0,63}$`. Use kebab case.                                               | `validator`                    |
| Package name   | `@aigg/` followed by the directory name. Proposed: decision D21 is open, so confirm the scope. | `@aigg/validator`              |
| Kind           | `library` (imported by other packages) or `cli` (has one bin entry).                            | `cli`                          |
| CLI command    | Only for `cli`: `aigg-` followed by the directory name.                                         | `aigg-validator`               |
| Alias          | `@<directory-name>/*`.                                                                          | `@validator/*`                 |
| Stage          | The pipeline stage from [the architecture](../../../docs/ARCHITECTURE.md).                      | S9 Validation                  |
| Description    | One English sentence about the result for the user.                                             | `Validate a character package` |
| Runtime data   | The files, images, models, subprocesses, and network targets that the package reads or changes. | Character package directory    |

Stop and ask when the directory name, the stage, or the purpose is not clear.
Do not invent author data, service URLs, model names, or a public API.
Check that no other directory in `packages/` has the same name.

## Make the files

Start with the smallest working package: one exported function and one test, or `--help` and one validated argument for a CLI.

| File                | Content                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `package.json`      | Fields from the next section. `version` is `0.1.0`.                                                                 |
| `tsconfig.json`     | Extend `../../configs/tsconfig.base.json`. Set `rootDir: "."`, `outDir: "dist"`, `paths`, `include`, and `exclude`. |
| `vite.config.mjs`   | Call `nodePackageConfig` from `../../configs/vite.config.mjs`. Set `root`, the alias namespace, and the entry modules. |
| `vitest.config.mjs` | Call `nodeTestConfig` from `../../configs/vitest.config.mjs` and pass the Vite alias mapping.                       |
| `src/index.ts`      | The library entry, or `src/cli.ts` with a Node.js shebang and English help text for a CLI.                          |
| `test/*.test.ts`    | English test names. Test one success path and one failure path in a temporary directory with synthetic data.       |
| `README.md`         | Purpose, pipeline stage, inputs, outputs, commands, and limits.                                                     |
| `SECURITY.md`       | Required when the package writes assets, decodes images, starts subprocesses, or uses the network.                  |

The shared configuration in `configs/` and the root scripts already exist. Do not copy them into the package.

Use these `package.json` fields. Replace the placeholders.

```json
{
  "name": "@aigg/<dir>",
  "version": "0.1.0",
  "description": "<description>",
  "private": true,
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=26.12.1" },
  "exports": { ".": "./dist/src/index.js" },
  "scripts": {
    "build": "vite build",
    "typecheck": "tsc --project tsconfig.json --noEmit",
    "test": "npm run build && vitest run",
    "lint": "eslint . --max-warnings=0",
    "format:check": "prettier --ignore-path ../../.prettierignore --check ."
  }
}
```

For a `cli` package, add `"bin": { "aigg-<dir>": "dist/src/cli.js" }` and a `start` script that builds first.
Packages stay private. Publication to npm needs a separate human decision.
Do not add `postinstall`, `prepare`, or other installation hooks.
Do not add a runtime dependency without a reason and a security check of its package.
Declare image libraries with native binaries, such as `sharp` or `canvas`, only after a human decision. Record the reason in the package README.

## Install and check

Run these commands from the repository root:

```sh
npm install --ignore-scripts
npm run format:check
npm run lint
npm run check:config
npm run typecheck
npm test --workspace @aigg/<dir>
```

`npm install` adds the workspace link to the root lockfile. Do not add a package lockfile.
Review the lockfile diff. Only the new workspace entries and the declared dependencies must change.
After that, use `npm ci --ignore-scripts` for later installs.

## Finish

- Do a security review of the scaffold.
- Do not run `npm version` for a new package. Its first version is `0.1.0`.
- Add the package to the table in [the workspace layout](../../../docs/WORKSPACES.md).
- Add the directory name to the `package` options in [test.yml](../../../.github/workflows/test.yml), then run `npm run check:workflows`.
- Report the new files, the checks, and the open questions in English.
