# GitHub Actions

The repository has four GitHub Actions workflows and a Dependabot configuration. They come from the Toolchain repository.
The Toolchain Build and Release workflows are not copied, because all packages are private. Publication needs a separate human decision.

| Workflow                                      | Start                                                          | Result                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Tests](../.github/workflows/test.yml)        | Pull request, push to `master`, manual start.                  | Formatting, lint, configuration and workflow checks, and package type checks and tests on macOS and Linux. |
| [PR rules](../.github/workflows/pr-rules.yml) | Pull request, also after a change to the title or description. | Branch name, description, commit messages, versions, and lockfile changes.                                 |
| [Secrets](../.github/workflows/secrets.yml)   | Pull request, push to `master`, manual start.                  | Lefthook validation, hook integration tests, and Gitleaks scans of the history and the working files.      |
| [CodeQL](../.github/workflows/codeql.yml)     | Pull request, push to `master`, weekly, manual start.          | Static security analysis of JavaScript, TypeScript, and the workflows.                                     |

See [Enforced rules](ENFORCED_RULES.md) for the rules that the jobs check. See [Git hooks and secret checks](GIT_HOOKS.md) for the Secrets workflow.

## Tests

### Manual start

1. Open the repository on GitHub.
2. Open **Actions** and select **Tests**.
3. Click **Run workflow** and select the branch.
4. Select the package in `package`. Select `all` for all packages.
5. Set `dry_run`. A dry run shows the selected packages only. It does not install dependencies or run tests.
6. Click **Run workflow**.

The `plan` job checks the input again with [scripts/ci/packages.mjs](../scripts/ci/packages.mjs).
It accepts only `all` or the exact directory name. It does not accept a package name or a path.

### Tests on pull requests

The `plan` job compares the pull request head with the merge base and selects the packages to test:

| Changed files                                                                                         | Tested packages      |
| ----------------------------------------------------------------------------------------------------- | -------------------- |
| Only files in `packages/<directory>/`.                                                                | Only these packages. |
| `package-lock.json`, if only `packages/<directory>` or `packages/<directory>/node_modules/…` changed. | Only these packages. |
| Any other file, for example in `configs/`, `scripts/`, `.github/`, `docs/`, or root files.            | All packages.        |

The test matrix always contains all packages, so each `test (<package>, <os>, Node.js <version>)` check reports a result.
A job for a package that the pull request does not change skips its steps and succeeds. It uses a Linux runner, also when its check name contains `macos-latest`.
Before the first package exists, the matrix is empty and the `test` job is skipped. The `repository` job still runs.

The matrix uses macOS first, because macOS is the first supported platform. Linux is the second platform. Windows is not in the matrix.
Tests use Node.js 26, the latest patch version. CI does not check the minimum engine version from `.nvmrc`.

## Security controls

| Control              | Implementation                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token permissions    | The default is `contents: read`. Only the CodeQL `analyze` job has `security-events: write`. `npm run check:config` rejects write access in top-level permissions and `write-all`. |
| Checkout credentials | All jobs use `persist-credentials: false`.                                                                                                                                         |
| Actions              | Each action is pinned to a full commit SHA with the version in a comment.                                                                                                          |
| Trigger events       | No `pull_request_target`, `workflow_run`, `issue_comment`, pull request review, or discussion events. `npm run check:config` rejects them.                                         |
| Input handling       | Inputs go to scripts through environment variables, not through `${{ }}` in shell text.                                                                                            |
| Dependency scripts   | `npm ci` uses `--ignore-scripts`, and `.npmrc` sets `ignore-scripts=true`. No dependency cache is used.                                                                            |
| Pipeline assets      | No workflow downloads model weights, calls a paid API, or uploads character assets.                                                                                                |

Limits:

- Pull requests from forks run Tests with a read-only token and no secrets. They run the code from the pull request.
- GitHub-hosted runners, the pinned actions, and the locked development dependencies are trusted. The `min-release-age` setting in `.npmrc` delays new dependency versions.

### Manual version pins

Dependabot updates only the actions in `uses:` and the npm packages. Update these pins manually:

| Pin                         | Location                                                        | Check                   |
| --------------------------- | --------------------------------------------------------------- | ----------------------- |
| Node.js for the CI jobs     | `.nvmrc` and `engines.node` in the root `package.json`          | Exact version `X.Y.Z`.  |
| Gitleaks                    | Download URL in [secrets.yml](../.github/workflows/secrets.yml) | SHA-256 of the archive. |
| Node.js for the test matrix | `node` in [test.yml](../.github/workflows/test.yml)             | Major version.          |

Select a Node.js version that is at least 7 days old, as `min-release-age` in `.npmrc` requires for npm packages. A security release can be used earlier.

## CodeQL

The CodeQL workflow analyzes TypeScript, JavaScript, and the GitHub Actions workflows with the `security-extended` query suite and the [configuration file](../.github/codeql/codeql-config.yml).
Generated output, dependencies, and vendored skills are outside the analysis. The workflow does not install dependencies. It uses `build-mode: none`.

The repository is public, so code scanning is available without a paid plan. Do these steps one time in the repository settings:

1. Open **Settings → Advanced Security** (the section can also be named **Code security**).
2. Find **CodeQL analysis**. Make sure that **default setup** is not enabled. GitHub rejects workflow results when default setup is enabled.
3. Merge the workflow to `master`. The first push run makes the baseline.
4. Open **Security → Code scanning** and examine the alerts.

A human decides how to handle each alert. Do not dismiss an alert without a recorded reason.
CodeQL does not replace the separate security review in AGENTS.md.

## Dependabot

The [Dependabot configuration](../.github/dependabot.yml) makes version update pull requests one time each week, on Monday.

| Ecosystem        | Directory | Settings                                                                                                       |
| ---------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `npm`            | `/`       | The root `package.json` and `package-lock.json` for all workspaces. Exact versions. Minor and patch in one PR. |
| `github-actions` | `/`       | The workflows in `.github/workflows/`. Full commit SHAs with a version comment. All updates in one PR.         |

- A new version must be 7 days old before Dependabot proposes it. A major npm version must be 14 days old.
- Security updates do not wait. Enable them in **Settings → Advanced Security → Dependabot security updates**.
- Commit messages start with `chore(deps)` or `chore(deps-dev)`.

Dependabot cannot change its `dependabot/` branch prefix or use the pull request template.
For this reason, `pr-rules` does not check the branch name and the description when the author is `dependabot[bot]` and the branch name starts with `dependabot/`.
The commit, version, lockfile, and `npm audit` checks apply to Dependabot too.
A human examines each Dependabot pull request and merges it.

## Add, remove, or rename a package

**CAUTION: Update the `package` list in [test.yml](../.github/workflows/test.yml) when you change the package directories in `packages/`.**

The list under `workflow_dispatch.inputs.package.options` starts with `all`. The package directory names follow in code point order, as `ls` with `LC_ALL=C` shows them.
GitHub does not let a workflow make choice values automatically.

Run this command after the change:

```sh
npm run check:workflows
```

The command compares the list with `packages/` and runs the tests for the workflow scripts.
The `plan` job does the same comparison and stops on a difference. `npm run check` also runs this command.
