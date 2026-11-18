# MVP-D: end-to-end pipeline orchestration

**Provisional MVP orchestration.** This report describes MVP-D of the MVP vertical slice (decision D33, [the roadmap](../ROADMAP.md#near-term-priority-mvp-vertical-slice)). It uses the D33 exception for steps that were not done three times by hand. It is not production automation. It closes no decision and does not change the rig contract, the security rules, or the model license registry.

## Status

| Item                                     | Result                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator                             | PASS: package `@aigg/factory` 0.1.0, command `aigg-factory` (`init`, `provide`, `plan`, `status`, `run`, `resume`, `approve`, `reject`).                                      |
| Required test scenarios (1 to 10)        | PASS (agent, synthetic data). 33 tests. See [Tests](#tests).                                                                                                                  |
| Real `assemble-body` through the factory | PASS (agent, synthetic body).                                                                                                                                                 |
| Real Akane job                           | PARTIAL (agent): the job reads all real inputs and stops at `W_APPROVAL`, the first human checkpoint. The agent does not record human decisions. The owner continues the job. |
| Spine CLI and viewer through the factory | NOT TESTED by the agent. No Spine executable is in the agent environment. Owner run below.                                                                                    |
| End-to-end result                        | `WAITING_FOR_OWNER_RUN`. Not `END_TO_END_PASS`.                                                                                                                               |

## Flow

```text
INPUT → W_APPROVAL → L (import) → L_REVIEW → LANDMARKS (import) → M (assemble-body) → SPINE (spine-validate) → PREVIEW (aigg-viewer --check) → FINAL_APPROVAL
```

| Stage            | Kind       | Implementation                                                                                                                                     |
| ---------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INPUT`          | automatic  | Reads the contract (JSON object) and records its digest.                                                                                           |
| `W_APPROVAL`     | checkpoint | Human decision on the concept PNG (digest of the file).                                                                                            |
| `L`              | import     | Reads a See-through result that was made outside the factory. It runs no model and needs no GPU. The stage report says "import", not "generation". |
| `L_REVIEW`       | checkpoint | Human decision on the imported layers.                                                                                                             |
| `LANDMARKS`      | import     | Reads the manual marks and the `align-study` correspondence. Checks that the correspondence names the same image and the same marks.               |
| `M`              | automatic  | Existing `aigg-control assemble-body` (MVP-A).                                                                                                     |
| `SPINE`          | automatic  | Existing `aigg-control spine-validate` (M0-F0a, MVP-B) with the Spine executable that the user gives. Separate from the offline result of `M`.     |
| `PREVIEW`        | automatic  | Existing `aigg-viewer --check` (MVP-C) on `body/export`. Writes `launch.json` with the exact start command of the viewer.                          |
| `FINAL_APPROVAL` | checkpoint | Human decision on the digests of the `M`, `SPINE`, and `PREVIEW` outputs.                                                                          |

The factory calls the built commands of `@aigg/control` and `@aigg/viewer` as subprocesses with argument arrays. It adds no generation, no layer method, and no rig change. It uses no workspace runtime dependency, so `runtimeDependencyAllowlist` is not changed.

## Job manifest

`job.json` (schema [packages/factory/schemas/job.schema.json](../../packages/factory/schemas/job.schema.json), example [packages/factory/examples/job.example.json](../../packages/factory/examples/job.example.json)) records:

- the job ID and the factory version;
- each input path (real path) and its digest, and earlier paths in `inputHistory`;
- the contract reference (`inputs.contract`);
- for each stage: the status, the run ID, the attempt count, the start and end times, the input digests, the parameters, the tool (name, version, path, digest of its `dist/src` files), the fingerprint, the output folder and its digest, the report path, the exit status, the error code, and the message;
- the Spine path and version;
- each human decision: checkpoint, decision, artifact digest, artifact version, person, note, time, and tool version.

It holds no environment variables, no secrets, and no names or paths in the code. All paths come from the user.

## Resume rules

| Situation                               | Behavior                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Same fingerprint, output digest correct | `DONE`, skipped.                                                                                       |
| Changed input, parameter, or tool       | `STALE`. The stage runs again. The later stages get new input digests.                                 |
| Output missing or changed               | `INVALID`. The stage runs again.                                                                       |
| `FAIL` or `ERROR` with the same inputs  | Not run again. `run --retry` after a correction.                                                       |
| Time-out, signal, start error           | `ERROR` (ambiguous). Never retried automatically.                                                      |
| Process stopped during a stage          | `job.json` keeps `RUNNING`, never `PASS`. The next `run` marks `INTERRUPTED` and runs the stage again. |
| Changed approved artifact               | The old decision is not valid. The checkpoint waits again.                                             |
| Rejection                               | The job stops at the checkpoint until the artifact changes or the person records another decision.     |

Each run writes into a new folder `stages/<STAGE>/runs/<run-id>/`. The factory never deletes or replaces a run folder, never changes an input file, and writes `job.json` atomically. A lock file allows one process for each job. Each stage can run again safely, because it only reads its inputs and writes into its own new folder.

## Human checkpoints

The concept approval, the layer review, the manual marks, and the final approval stay manual. `approve` and `reject` work only in an interactive terminal with a typed confirmation, and they name the digest of the artifact. Without a terminal they stop with `E_TTY`. The tests check this.
Each stop gives the stage, its state, the missing data or decision, the expected format, the next action, and the exact command to continue (`next` in the JSON report and `Next:` on stderr).

## Three-run status (D33)

| Step                        | Done before by hand                            | Status in MVP-D                                    |
| --------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| See-through decomposition   | Once (L0-1, owner on Runpod).                  | Manual, outside the factory. Imported.             |
| Manual marks, `align-study` | Once (L0-1d, owner marks).                     | Manual, outside the factory. Imported and checked. |
| `assemble-body`             | Once by the agent (MVP-A), twice in this work. | Automatic. Fewer than three owner runs.            |
| `spine-validate`            | Once (MVP-B, owner).                           | Automatic. Fewer than three runs.                  |
| Viewer check                | Agent tests only (MVP-C).                      | Automatic. Fewer than three runs.                  |

These steps do not meet the three-run rule. They are provisional.

## Tests

Environment: Linux x64 container, Node.js 22 (local; CI uses Node.js 26). Vitest. Synthetic data in temporary folders with spaces in the paths.

| Scenario                              | Test                                                                                     | Result |
| ------------------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| 1. New job without inputs             | Stops at `INPUT` (`WAITING_FOR_INPUT`), next action `provide contract`.                  | PASS   |
| 2. Approved concept, no layers        | Stops at `L`, says that the factory does not run See-through.                            | PASS   |
| 3. Layers, no marks                   | Stops at `LANDMARKS` with the `annotate-page` and `align-study` commands.                | PASS   |
| 4. Complete inputs                    | The real `assemble-body` on a synthetic body: `M` PASS, then `SPINE` waits for Spine.    | PASS   |
| 5. Missing Spine executable           | `SPINE` FAIL `E_SPINE_NOT_FOUND`, no subprocess, the `M` output digest is unchanged.     | PASS   |
| 6. Completed stages, unchanged hashes | Second `run`: no stage runs, no command is called, `job.json` stages are equal.          | PASS   |
| 7. Changed input                      | New marks: `LANDMARKS`, `M`, `SPINE`, `PREVIEW` run again; `INPUT` and `L` are skipped.  | PASS   |
| 8. Interrupted stage                  | The factory process is killed during `M`: `RUNNING`, no PASS; next run continues safely. | PASS   |
| 9. Rejected checkpoint                | `REJECTED`, later stages blocked, no command is called.                                  | PASS   |
| 10. Changed approved artifact         | A changed layer file: the `L_REVIEW` decision is not valid; the job waits again.         | PASS   |
| Outputs are not lost on a rerun       | The old run folders keep their recorded digests after a rerun.                           | PASS   |
| Dry run                               | `run --dry-run` writes nothing (`job.json` bytes equal, no run folder).                  | PASS   |
| Other                                 | No decision without a terminal; wrong digest; lock; manifest schema; corrupt output.     | PASS   |

The orchestration tests use fake commands. A job with fake commands reports `endToEnd: NOT_APPLICABLE_TOOL_OVERRIDE`, never `PASS`.

## Real Akane job (agent part)

Inputs (local only, not in Git): the L0 concept (`concept-mirrored.png`), the L0-1 See-through result (18 layers, 1280 × 1280), the L0-1d manual marks (25 landmarks), and their `align-study` correspondence. The agent packed them for the owner in the project files (`research/mvp-d/akane-inputs.tar.gz`, with `SHA256SUMS`).

| Check                                                                | Result                                                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `init` with all inputs, `--test-asset`                               | PASS                                                                                                          |
| `run`                                                                | `INPUT` PASS, then stop at `W_APPROVAL` (exit status 3), concept digest `175b3292…eae8b`.                     |
| Second `run`                                                         | `INPUT` skipped, no change.                                                                                   |
| Input checks (the functions of `L` and `LANDMARKS`)                  | 18 layers, none missing; the correspondence names the same image and the same marks.                          |
| The exact `M` command on the same files (direct call, outside a job) | `assemble-body` PASS. `SHA256SUMS` is equal to the MVP-A package, which the owner validated in Spine (MVP-B). |

The agent did not record the concept approval or the layer review. These are human decisions. The agent did not run Spine or the viewer on the real export.

## Owner run

On the Mac, from the repository root, on the branch of this change:

```sh
npm ci --ignore-scripts
npm run build
mkdir -p ~/aigg/mvp-d && tar xzf ~/Downloads/akane-inputs.tar.gz -C ~/aigg/mvp-d
A=~/aigg/mvp-d/akane-inputs
node packages/factory/dist/src/cli.js init ~/aigg/mvp-d/job --id akane-mvp-d --test-asset \
  --contract packages/control/test/fixtures/c05-candidate/rig.contract.json \
  --concept "$A/concept-mirrored.png" --layers "$A/see-through/concept-mirrored.psd.json" \
  --landmarks "$A/marks/landmarks-manual.json" --correspondence "$A/marks/correspondence.json" \
  --spine /Applications/Spine.app/Contents/MacOS/Spine --spine-version 4.3.26
node packages/factory/dist/src/cli.js run ~/aigg/mvp-d/job
```

Then follow `Next:` after each stop: `approve … W_APPROVAL`, `run`, `approve … L_REVIEW`, `run` (M, SPINE, PREVIEW), play the export with the command in `launch.json`, then `approve … FINAL_APPROVAL` (or `reject`) and `run`. A final `run` must report `COMPLETE` and `endToEnd: PASS`, and one more `run` must skip all stages. The Russian step list is in the project files (`research/mvp-d/OWNER_STEPS_RU.md`).

## Dependency audit

This change adds only the two workspace link entries of `@aigg/factory` to the lockfile. Because the lockfile changes, the `pr-rules` job runs `npm audit`. The result is the same as on `master`: 15 findings (9 moderate, 6 high). All high findings come from `picomatch` GHSA-fc5q-39xc-vjpf, which has no patched release. **Owner decision:** the owner accepted this existing finding for this PR. The `pr-rules` audit step stays red. The audit rule is not changed.

## Known limitations

- See-through and the manual marks are manual steps outside the factory. The factory imports and checks their files.
- One job, one process, one computer. No queue, server, or parallel stages.
- Input files are not copied into the job. The digests detect a change at the next command and during `M`.
- The Spine digest uses the path, size, and change time of the executable.
- Run folders accumulate. Old jobs are removed by hand.
- The art defects of MVP-A stay (joint seams, far arm order, static hair and skirt). They are not MVP-D blockers.
- The contract is the C0.5 candidate contract (provisional), not a frozen production contract.

## Not in scope

New generation, pose models, layer improvement, joint underlays, Spine Professional, meshes, a dashboard, an agent framework, a database or a queue, distributed GPU work, mass generation, rig standardization, and MVP-E.
