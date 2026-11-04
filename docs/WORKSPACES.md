# npm workspaces

The root workspace and the shared configuration exist. The first package is `rig-runtime`. **Draft:** the package list is a proposal, and the package names depend on decision D21.

## Layout

The private root package declares `packages/*` as workspaces.
Each package keeps its own name, version, runtime dependencies, and entry points.
Shared development dependencies belong to the root `package.json`.
One root `package-lock.json` records the complete dependency tree.
All packages are private. Publication to npm needs a separate human decision.

| Shared configuration          | Package configuration                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `configs/eslint.config.mjs`   | Root discovery supplies the shared rules. A package needs no duplicate file.                           |
| `configs/prettier.config.mjs` | Root discovery supplies formatting. Package commands use the root ignore file.                         |
| `configs/tsconfig.base.json`  | Package `tsconfig.json` extends the base and sets local paths and inputs.                              |
| `configs/vite.config.mjs`     | Package `vite.config.mjs` calls `nodePackageConfig` with its root, alias namespace, and entry modules. |
| `configs/vitest.config.mjs`   | Package `vitest.config.mjs` calls `nodeTestConfig` with its root and the Vite alias mapping.           |

Path settings remain local because relative paths resolve from their configuration file.
The shared configuration comes from the Toolchain repository with the same tool versions. The root `npm test`, `npm run build`, and `npm run typecheck` use [scripts/workspaces.mjs](../scripts/workspaces.mjs). It runs the script in each package, and it succeeds with a message when `packages/` has no package.
`npm run check:config` checks each package against these rules. See [Enforced rules](ENFORCED_RULES.md#configuration-check).

## Planned packages

**Proposed.** The list follows the pipeline stages in [the architecture](ARCHITECTURE.md). Add a package only when a stage needs code.

| Directory   | Kind    | Stage      | Purpose                                                                                   |
| ----------- | ------- | ---------- | ----------------------------------------------------------------------------------------- |
| `contract`  | library | S0, S9     | JSON Schemas, TypeScript types, and loaders for `rig.contract.json` and `character.json`. |
| `validator` | cli     | S9         | Schema checks, cross rules, comparison with the Spine export, and pixel checks.           |
| `psd`       | cli     | S8         | `to-psd` and `from-psd` between canonical parts and the editable PSD.                     |
| `assembler` | cli     | S7         | Map decomposition layers and base body masks to contract slots.                           |
| `control`   | cli     | S4         | Make control images (pose, depth, line art, zone masks) from the contract and mannequin.  |
| `measure`   | cli     | S4         | Measure production art against the mannequin: joint error, segment length, zone IoU.      |
| `comfy`     | library | S2, S4, S6 | Narrow client for a user-specified ComfyUI server. Records provenance.                    |
| `pack`      | cli     | S10        | Atlas export through Spine CLI with fixed attachment rectangles.                          |
| `preview`   | cli     | S11        | Contact sheet and video from the Spine web runtime through Playwright.                    |
| `factory`   | cli     | S1–S12     | Orchestration of the stages and human review steps for one character.                     |

## Existing packages

| Directory     | Kind          | Stage   | Purpose                                                                                                                                                                                                  |
| ------------- | ------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rig-runtime` | library + cli | S9, S11 | Shared runtime skeleton, character skins from `character.json` without blank placeholder regions, part modules (draft), atlas cache, and asset manifests with the macOS metadata policy. See its README. |

Packages that decode or write images will need an image library with native binaries, such as `sharp`. That dependency needs a human decision.

## Commands

Run these commands from the repository root:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run typecheck
npm run format
npm run lint
```

Select one package when necessary:

```sh
npm run build --workspace @aigg/validator
npm test --workspace @aigg/validator
```

npm runs workspace scripts in the package directory.
The root package has no release command and cannot be published.

## Add a package

Use the [new-package](../.agents/skills/new-package/SKILL.md) workflow. In Claude Code, use `/new-package`.

Do not create a package lockfile.
Do not add another package's source as a TypeScript alias. Use declared workspace dependencies and package exports.
A successful TypeScript check must precede any use of compiled output.

## References

- [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces/).
