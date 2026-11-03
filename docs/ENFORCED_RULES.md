# Enforced rules

Tools check part of the rules in [AGENTS.md](../AGENTS.md) and the documents in `docs/`.
The checks are the same for each person and each AI agent, because they use only repository files, Git, and GitHub Actions.
They do not use vendor-specific agent hooks.

Cloud agents work in a new clone. Local Git hooks are not installed there, because `npm ci --ignore-scripts` does not install them.
For this reason, CI repeats each hook check. Branch protection on GitHub is the last control.

The checks come from the Toolchain repository. The package rules are changed for the pipeline packages in `packages/`. See [the workspace layout](WORKSPACES.md).

## ESLint

The shared [configuration](../configs/eslint.config.mjs) has these project rules in addition to the recommended JavaScript and TypeScript rules.

| Rule                                                                                                 | Source                         |
| ---------------------------------------------------------------------------------------------------- | ------------------------------ |
| No `exec` or `execSync` import, and no `shell` option except `false`.                                | AGENTS.md, Security            |
| Node.js built-in modules use the `node:` prefix.                                                     | AGENTS.md, Implementation      |
| Strings, template literals, test names, and code comments have no Cyrillic text.                     | AGENTS.md, Documentation       |
| A package imports only its own `@<directory>/*` alias. Source modules do not use relative imports.   | AGENTS.md, Implementation      |
| A package does not import the source of another package. It uses a workspace dependency and exports. | WORKSPACES.md                  |
| No property setters, no `arguments`, and at most two `Object.assign` arguments.                      | Toolchain code style           |
| Sorted imports and exports. Type-only imports use type markers. Functions have return types.         | Toolchain code style           |
| Type-aware `recommendedTypeChecked` rules for package TypeScript, `strictTypeChecked` for `src/`.    | Toolchain code style, Security |

The configuration reads `packages/` and makes the alias rules for each package directory. A new package gets these rules without a configuration change.
The self-import rule reads the package name from `package.json`, because the name scope is an open decision (D21).
The selectors check direct static code. They do not follow aliases, dynamic property names, or `require` calls. They do not establish an execution boundary.

## Configuration check

`npm run check:config` runs [scripts/ci/config.mjs](../scripts/ci/config.mjs). The `repository` job in Tests runs it too.

| Area             | Check                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base tsconfig    | The required compiler options are present with the documented values.                                                                                                                                                                                                                                                                                                 |
| Package tsconfig | It extends the base. It sets only `rootDir: "."`, `outDir: "dist"`, and `paths`. The only alias is `@<directory>/*` → `./src/*.ts`.                                                                                                                                                                                                                                   |
| Aliases          | Vite and Vitest resolve `@<directory>` to the package `src/` directory.                                                                                                                                                                                                                                                                                               |
| Package metadata | `private: true`, `description`, `license`, `type: "module"`, `engines` equal to the root, `exports`, `README.md`, and the `build`, `typecheck`, `test`, `lint`, and `format:check` scripts. A CLI has one bin entry, a `start` script with the same entry, and a shebang.                                                                                             |
| Dependencies     | Runtime dependencies are in `runtimeDependencyAllowlist`. Packages have no devDependencies. Root devDependencies use exact versions. No installation hooks.                                                                                                                                                                                                           |
| Lockfile         | The package version agrees with `package-lock.json`.                                                                                                                                                                                                                                                                                                                  |
| Structure        | Uppercase rule file names, rule files only in the root, no tracked `dist/`, one lockfile, no shell scripts outside `shellScriptAllowlist`, equal skill adapter descriptions, no tracked images, editor files, archives, or model weights outside `binaryAssetAllowlist`, and no agent host settings or override instruction files outside `hostConfigAllowlist`.      |
| Language         | Tracked text files have no Cyrillic text. Vendored skills, skill patches, provenance data, and lockfiles are not checked.                                                                                                                                                                                                                                             |
| Workflows        | Read-only top-level `permissions`, no `write-all`, actions pinned to full SHAs with a version comment, `persist-credentials: false` for checkout, no `${{ }}` in `run`, and no `pull_request_target`, `workflow_run`, `issue_comment`, `pull_request_review`, `pull_request_review_comment`, `discussion`, or `discussion_comment` event, in key, list, or flow form. |
| Skills           | Each third-party skill file in `.agents/skills` has the SHA-256 value from `docs/skill-provenance.json`. `allowed-tools` contains only tools from `skillToolAllowlist`. SKILL.md has no `hooks` field and no pre-prompt command. Links in `.claude/skills` point to `.agents/skills`.                                                                                 |
| Node.js version  | `.nvmrc` contains an exact version `X.Y.Z`. The root `engines.node` is `>=` the same version.                                                                                                                                                                                                                                                                         |

The workflow check reads the line structure of the workflow files. It is not a complete YAML parser.
Agent host settings and override instruction files are `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, `.gemini/settings.json`, `.codex/config.toml`, `.cursor/`, `.vscode/tasks.json`, `.vscode/settings.json`, `.vscode/mcp.json`, `AGENTS.override.md`, `CLAUDE.local.md`, `GEMINI.local.md`, `.cursorrules`, `.windsurfrules`, and `.clinerules`.
These files can run commands, grant tool permissions, start MCP servers, or replace the rules in AGENTS.md. A pull request can add them, and an agent can load them before a human reads them.
The structure and language checks read the files that Git tracks. Stage new files before you run the check.

## Git hooks

Install the hooks with `npm run hooks:install`. See [Git hooks and secret checks](GIT_HOOKS.md).

| Hook       | Check                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| pre-commit | No commit on `master` or `main`. Staged files are formatted. No secrets in the staged changes.        |
| commit-msg | No link to an AI agent thread, chat, session, or task. No session trailer, such as `Claude-Session:`. |
| pre-push   | No push to `master` or `main`.                                                                        |

[scripts/ci/rules.mjs](../scripts/ci/rules.mjs) contains the shared list of host names and path prefixes. The list covers known services. It cannot find every possible link.

## Pull request rules

The `pr-rules` job in the [PR rules workflow](../.github/workflows/pr-rules.yml) runs [scripts/ci/pr-rules.mjs](../scripts/ci/pr-rules.mjs) on each pull request.
It runs again when the title or description changes. Tests do not run again for that change.

1. The branch name is `<type>/<short_description>`. The type is `feature`, `bugfix`, `docs`, `refactor`, `test`, or `chore`. The description has lowercase letters and digits, with `_` between words.
2. The description starts with `## tl;dr`. HTML comments and one italic attribution line can come before it. The `## Changes` and `## Verification` sections are present.
3. The title, the description, and each commit message have no AI agent session links or session trailers.
4. A change to files in `packages/<directory>/` outside `test/` requires one version step: patch, minor, or major. A skipped or reduced version is an error.
5. New or changed packages in `package-lock.json` come from `https://registry.npmjs.org/` with a `sha512` integrity value. A new install script requires a human review. The job lists the changed packages and runs `npm audit --package-lock-only --audit-level=high`.

Dependabot pull requests skip rules 1 and 2 only. See [Dependabot](GITHUB_ACTIONS.md#dependabot).

## Limits

These checks do not replace a review. They find known patterns and structure problems.
They do not check the content rules, the rig contract, model licenses, or provenance records. Those rules need a human review until a validator package exists.
A person or an agent can bypass local hooks. Required status checks and branch rules on GitHub prevent a merge without the CI checks. The repository owner configures them.
