# @aigg/factory

**Provisional MVP orchestration (MVP-D, decision D33).** This package connects the existing pipeline commands into one resumable local job. It is not production automation, not a queue, not a server, and not a generator. See [the MVP-D report](../../docs/proposals/MVP_D_PIPELINE_ORCHESTRATION.md).

Command: `aigg-factory` (compiled entry `dist/src/cli.js`). Pipeline stages: S1 to S11 of [the architecture](../../docs/ARCHITECTURE.md), for one test character at a time.

## What it does

One job is one folder with one manifest, `job.json`. The stages run in a fixed order:

| Stage            | Kind       | What the factory does                                                                                                                           |
| ---------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `INPUT`          | automatic  | Reads the rig contract (or candidate rig contract) and records its digest.                                                                      |
| `W_APPROVAL`     | checkpoint | Waits for a concept image and a human decision on it.                                                                                           |
| `L`              | import     | Imports a See-through result that was made outside the factory (`<stem>.psd.json`, `<stem>/<tag>.png`, `<stem>/src_img.png`). It runs no model. |
| `L_REVIEW`       | checkpoint | Waits for a human review of the layers.                                                                                                         |
| `LANDMARKS`      | import     | Imports the manual marks (`landmarks-manual.json`) and the `align-study` `correspondence.json`. Checks that they belong to the same image.      |
| `M`              | automatic  | Runs the existing `aigg-control assemble-body`.                                                                                                 |
| `SPINE`          | automatic  | Runs the existing `aigg-control spine-validate` with the licensed Spine executable that the user gives.                                         |
| `PREVIEW`        | automatic  | Runs the existing `aigg-viewer --check` on the Spine export and writes the exact viewer start command.                                          |
| `FINAL_APPROVAL` | checkpoint | Waits for a human decision on the result.                                                                                                       |

The factory calls the commands of `@aigg/control` and `@aigg/viewer` as Node.js subprocesses with argument arrays. It does not import or copy their code.

## Commands

Run the commands from the repository root after `npm ci --ignore-scripts` and `npm run build`:

```sh
node packages/factory/dist/src/cli.js init <job-folder> --id <id> [--test-asset] [--contract <file>] [--concept <png>] \
  [--layers <stem.psd.json>] [--landmarks <file>] [--correspondence <file>] [--spine <absolute path>] [--spine-version 4.3.26]
node packages/factory/dist/src/cli.js provide <job-folder> <contract|concept|layers|landmarks|correspondence|spine> <path>
node packages/factory/dist/src/cli.js plan <job-folder>
node packages/factory/dist/src/cli.js status <job-folder>
node packages/factory/dist/src/cli.js run <job-folder> [--retry] [--dry-run]
node packages/factory/dist/src/cli.js resume <job-folder> [--retry]
node packages/factory/dist/src/cli.js approve <job-folder> <W_APPROVAL|L_REVIEW|FINAL_APPROVAL> --by <name> --digest <sha256> [--note <text>]
node packages/factory/dist/src/cli.js reject <job-folder> <W_APPROVAL|L_REVIEW|FINAL_APPROVAL> --by <name> --digest <sha256> --reason <text>
```

`npm start --workspace @aigg/factory -- <command> ...` builds the package first and gives the same command, but npm runs it in `packages/factory`, so give absolute paths.

Each command prints one JSON report on stdout and a short summary on stderr. Exit status:

| Status | Meaning                                                                        |
| ------ | ------------------------------------------------------------------------------ |
| 0      | `run`: the job is complete. Other commands: done.                              |
| 1      | `run`: a stage failed, or a checkpoint is rejected.                            |
| 2      | Usage error or another error. The JSON report has `code` and `message`.        |
| 3      | `run`: the job waits for an input or a human decision. See `next` in the JSON. |

When a job stops, the report and the summary give the stage, its state, the missing data or decision, the expected format, the next action, and the command to continue.

## Human checkpoints

`approve` and `reject` work only in an interactive terminal: the person types the checkpoint name to confirm. Without a terminal the command stops with `E_TTY` and records nothing. The factory never records a decision itself.

A decision names the SHA-256 digest of the artifact that the person saw (`status` shows it). A decision is valid only while the artifact has this digest:

| Checkpoint       | Artifact digest                                                    |
| ---------------- | ------------------------------------------------------------------ |
| `W_APPROVAL`     | SHA-256 of the concept PNG file.                                   |
| `L_REVIEW`       | Digest of the `L` output (the layer files and the concept digest). |
| `FINAL_APPROVAL` | Digest of the `M`, `SPINE`, and `PREVIEW` output digests.          |

A changed artifact makes the earlier decision invalid. The job then waits for a new decision. A rejection stops the job until the artifact changes or the person records another decision. Agents must not run `approve` or `reject`.

`--test-asset` marks a licensed test character. A decision on such a job accepts technical test data only. It does not make a product character.

## Resume and invalidation

- Each automatic or import stage has a fingerprint: the SHA-256 of the input digests, the parameters, and the tool (name, version, and digest of the files of its `dist/src` folder).
- `run` skips a stage when the fingerprint is unchanged and the output folder still has the recorded digest.
- A changed input changes the fingerprint (`STALE`). The stage runs again, and the stages after it get new inputs.
- A missing or changed output (`INVALID`) runs the stage again.
- A failed stage (`FAIL`, `ERROR`) does not run again with the same inputs. Use `--retry` after the cause is corrected. A time-out or a signal is `ERROR`: an ambiguous result, never retried automatically.
- A stage that was interrupted (a crash or a kill) stays `RUNNING` in `job.json`, never `PASS`. The next `run` marks it `INTERRUPTED` and runs it again into a new folder. This is safe because each stage reads its inputs and writes only into its own new run folder.

## Job folder

```text
<job-folder>/
  job.json                         the manifest (schemas/job.schema.json); written atomically
  job.lock                         only while a command changes the job
  stages/<STAGE>/runs/<run-id>/
    out/                           the stage output (for example the assemble-body package or the Spine export)
    report.json                    the machine-readable stage report (aigg.factory.stage-report/0.1)
    stdout.json, stderr.txt        the output of the command (subprocess stages)
```

The factory never deletes or replaces a run folder. A new run makes a new folder, so earlier outputs stay. Input files are read and never changed or copied.
See [examples/job.example.json](examples/job.example.json) for a job that waits for the final approval (made with test commands; the paths are examples).

## Inputs

| Input            | Format                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `contract`       | `rig.contract.json` (JSON object). For the MVP: the C0.5 candidate contract.                                     |
| `concept`        | PNG file, at most 8192 px on each side and 64 MiB.                                                               |
| `layers`         | `<stem>.psd.json` of a See-through result. The folder `<stem>/` has `<tag>.png` for each part and `src_img.png`. |
| `landmarks`      | `landmarks-manual.json` (`aigg.l0-1c.landmarks/0.1`) from `aigg-control annotate-page`.                          |
| `correspondence` | `correspondence.json` from `aigg-control align-study --landmarks`, made with the same marks and image.           |
| `spine`          | Absolute path of the Spine executable. macOS: `/Applications/Spine.app/Contents/MacOS/Spine`.                    |

`init` and `provide` store the real path of each file. `provide` keeps the earlier path in `inputHistory`.

## Tests

```sh
npm test --workspace @aigg/factory
```

The test script builds this package and `@aigg/control`. The tests use synthetic files in temporary folders:

- Orchestration tests with fake commands (`--control-cli`, `--viewer-cli` at `init`): checkpoints, rejection, resume, invalidation, interruption, a missing Spine executable, and decisions.
- One test runs the real `assemble-body` on a synthetic body and stops at `SPINE`.
- A job made with fake commands never reports `endToEnd: PASS`.

## Limits

- One job, one computer, one process at a time. No queue, no parallel stages.
- See-through, the manual marks, and Spine run outside the factory or are given by the user. The factory does not download, install, or start a model.
- The Spine digest uses the path, the size, and the change time of the executable, not its content.
- The input files are not copied. A change of an input file after a run makes the dependent stages stale. A change during the `M` run makes the run fail with `E_INPUT_CHANGED`.
- Run folders are never removed. Remove old jobs by hand when you no longer need them.
- Steps that were not done three times by hand (D33) are listed in the MVP-D report.
