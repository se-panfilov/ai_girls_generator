# WebStorm setup

**Draft.** The project IDE is JetBrains WebStorm. This document gives the WebStorm settings for this repository.
The repository does not keep IDE configuration in Git. Each developer sets these values once for each clone.

**Assumption:** the menu paths are for current WebStorm versions. They were not verified in a running IDE. If a path is different in your version, search for the setting name with Find Action (`Cmd+Shift+A`).

## Why `.idea/` is not in Git

WebStorm keeps project settings in `.idea/`. The `.gitignore` file ignores `.idea/` and `*.iml`.
Some `.idea/` files can run commands: run configurations, file watchers, external tools, and startup tasks. A pull request that adds these files can run a command on the computer of the person who opens the project.
Shared settings come from the tool configuration files in the repository root and in `configs/`. WebStorm reads these files.

| Tool         | Configuration file                            | WebStorm reads it through   |
| ------------ | --------------------------------------------- | --------------------------- |
| EditorConfig | `.editorconfig`                               | EditorConfig support        |
| Prettier     | `prettier.config.mjs`, `.prettierignore`      | Prettier integration        |
| ESLint       | `eslint.config.mjs` (flat configuration)      | ESLint integration          |
| TypeScript   | `packages/<directory-name>/tsconfig.json`     | TypeScript language service |
| Vitest       | `packages/<directory-name>/vitest.config.mjs` | Vitest run configurations   |

## Before you open the project

1. Install the Node.js version from `.nvmrc`.
2. Install the dependencies from the repository root: `npm ci --ignore-scripts`.
3. Open the repository root folder in WebStorm. When WebStorm asks about trust, select Trust Project only for a clone and branch that you examined. For an unknown branch, select Preview in Safe Mode.

The ESLint, Prettier, and TypeScript integrations run code from `node_modules`. Install the dependencies only with the root lockfile.

## Settings

Open Settings (`Cmd+,`) and set these values.

| Setting                                                           | Value                                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Languages & Frameworks > Node.js > Node interpreter               | The Node.js version from `.nvmrc`.                                                                   |
| Languages & Frameworks > Node.js > Package manager                | `npm` from the same Node.js installation.                                                            |
| Languages & Frameworks > TypeScript > TypeScript                  | `node_modules/typescript` of the project, not the bundled version.                                   |
| Languages & Frameworks > JavaScript > Code Quality Tools > ESLint | Automatic ESLint configuration. Optional: Run eslint --fix on save.                                  |
| Languages & Frameworks > JavaScript > Prettier                    | Automatic Prettier configuration. Run on save. Add `md,json,yml,yaml,mjs,cjs` to the file pattern.   |
| Editor > Code Style > Enable EditorConfig support                 | On.                                                                                                  |
| Tools > Actions on Save                                           | Reformat code: off. Optimize imports: off. Prettier and ESLint format the code and sort the imports. |
| Editor > General > Appearance > Show hard wrap and visual guides  | Optional. EditorConfig sets `max_line_length = 200`.                                                 |

The WebStorm code formatter and import optimizer do not use the Prettier and ESLint rules. If you use them, `npm run format:check` and `npm run lint` can fail.

## Excluded folders

Mark these folders as excluded: right-click the folder, then select Mark Directory as > Excluded.

- `dist/` in each package. It is compiled output. Edit source, not generated output.
- `coverage/` and `reports/`, if they exist.

Excluded folders are not indexed and do not show in search results.

## Tests

WebStorm finds Vitest in `node_modules`. To run the tests of one package, create a Vitest run configuration:

- Working directory: `packages/<directory-name>`.
- Configuration file: `packages/<directory-name>/vitest.config.mjs`.

A Vitest run configuration does not build the package first. The `test` script of a package runs `npm run build` before Vitest. Before delivery, run the full checks from the repository root in the terminal:

```sh
npm run typecheck
npm run build
npm test
npm run check
```

Run configurations are personal and stay in `.idea/`. Do not commit them.

## Git

Use the Git hooks from [Git hooks](GIT_HOOKS.md). The WebStorm commit dialog runs the installed Git hooks.
Do not enable the WebStorm commit options that reformat code or optimize imports. The `pre-commit` hook checks the formatting with Prettier.
