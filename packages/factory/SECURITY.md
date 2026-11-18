# @aigg/factory security notes

**Draft.** Scope: the `aigg-factory` command and its job folder.

## Inputs and trust

| Input                                                   | Trust                                                          | Controls                                                                                                                                                                                                                      |
| ------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command arguments (job folder, input paths, Spine path) | The local user.                                                | `init` accepts only a new or empty real folder. Input paths are resolved to real paths once, at `init` or `provide`. The Spine path must be absolute.                                                                         |
| Input files (contract, concept, layers, marks)          | Untrusted data from the user's computer.                       | Opened with `O_NOFOLLOW` and `O_NONBLOCK`; type and size checks on the open descriptor; size limits before a read. PNG size from the header only, no decoding. Layer names are plain names (no folder parts, no leading dot). |
| `job.json`                                              | Written by the factory, but a person or a program can edit it. | Validated at each read (`parseManifest`): unknown or missing fields are errors, and output folders must match `stages/<STAGE>/runs/<id>/out`.                                                                                 |
| Output of the commands (stdout, files)                  | Output of the repository tools and of Spine.                   | stdout is parsed as JSON with a size limit. Output folders are hashed; a symbolic link or a special file in an output is an error.                                                                                            |

## Subprocesses

- The factory starts `node <cli.js> <arguments>` with an argument array and `shell: false`. No user text goes into a shell command.
- The commands are the built `@aigg/control` and `@aigg/viewer` entries of this repository. `--control-cli` and `--viewer-cli` (at `init`, for tests) select other files; such a job never reports an end-to-end PASS.
- The child environment has only `HOME`, `USER`, `LOGNAME`, `PATH`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, `SystemRoot`, and `NO_COLOR=1`. `NODE_OPTIONS` and other variables that can load code do not pass.
- Each command has a time limit (`M` 20 min, `SPINE` 60 min, `PREVIEW` 2 min). A time-out or a signal is recorded as `ERROR` and is not retried automatically.
- The Spine executable is started only by `aigg-control spine-validate`, with the path that the user gives. The factory checks that the file exists and is executable before it starts the stage. It never searches for Spine.

## Writes

- The factory writes only in the job folder: `job.json` (temporary file, fsync, rename), `job.lock` (created with `O_EXCL`), and new run folders.
- A run folder is created with a new random name and is never replaced or deleted. Output files are created with `O_EXCL` and `O_NOFOLLOW`.
- `PASS` is written to `job.json` only after the output digest and the stage report exist. A crash leaves `RUNNING`, which the next run shows as `INTERRUPTED`.
- Input files are never changed, moved, or copied. An approved artifact is never overwritten: a new run makes a new folder, and the changed digest makes the old decision invalid.
- The lock holds the process ID. A lock of a process that does not run any more is removed by the next command. Process ID reuse can, rarely, keep a stale lock; remove `job.lock` by hand only when no factory command runs.

## Human decisions

- `approve` and `reject` need an interactive terminal and a typed confirmation. Without a terminal they stop with `E_TTY`. The factory never records a decision itself.
- A decision names the digest of the artifact. A changed artifact makes the decision invalid.

## Secrets and network

- The factory uses no network and no service. It does not download models, tools, or packages.
- `job.json` holds paths, digests, versions, and decisions. It holds no environment variables, tokens, or credentials. Do not put secrets in input paths or notes.

## Licensed test assets

A job for the Akane test character reads licensed test files and writes derived files into the job folder. Keep such job folders outside the repository. Do not commit them, the outputs, or screenshots. Mark such jobs with `--test-asset`.

## Residual risks

- A user who can write the job folder can change `job.json` or the outputs. The digests show the change at the next command, but they do not stop the person.
- Input files are checked when a stage starts and again after `M`. A change between these checks and the read by the command is detected only for `M`.
- The Spine digest does not cover the content of the executable.
- `job.json` names the commands to start (`tools.controlCli`, `tools.viewerCli`) and the Spine path. A person who can edit `job.json` can make the factory start another program as the same user. The job folder must be writable only by its owner.
- Two commands that find the same stale lock at the same moment can both continue. The factory is for one person and one job at a time; do not start two commands on one job.
- The commands of `@aigg/control`, `@aigg/viewer`, and Spine have their own risks. See their security notes.
