# Security notes: @aigg/seethrough-bundle

**Draft.** Threat model, controls, and residual risks of the L0-1 See-through bundle. Do not read this as a claim of absolute safety.
The goal is a first L0-1 execution that is safe enough to review, not a general sandbox for Python.

## Assets and trust boundaries

| Asset or party                 | Trust                    | Notes                                                                                                      |
| ------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| This repository and the bundle | Trusted after review     | The owner checks `SHA256SUMS` of the bundle against the value in the pull request before the copy.         |
| The runner (`runner.mjs`)      | Trusted after review     | Node.js built-ins only. It runs as root on the Pod, because only root can start a process as another user. |
| See-through code (Apache-2.0)  | Untrusted, pinned        | Third-party Python. Pinned by Git commit and by SHA-256 of each file. Runs only as the run user.           |
| Model files (Hugging Face)     | Untrusted, pinned        | Executable input. Only safetensors weights. Pinned by revision, size, and SHA-256 or Git blob id.          |
| Python wheels (PyPI)           | Untrusted, pinned        | Third-party code, also native code. Pinned by file name, URL, size, and SHA-256. No source builds.         |
| `concept-mirrored.png`         | Confidential input       | Derived from a paid asset. Only this file goes to the Pod. Pinned by SHA-256.                              |
| The GPU host (Runpod Pod)      | Owner-controlled, rented | The owner starts and terminates it. No credentials of the owner or of services go to the Pod.              |
| Outputs (PSD, PNG, logs)       | Untrusted data           | Written by third-party code. The runner checks paths, types, and sizes. They are not committed to Git.     |

## Identities and permissions

| Identity             | Runs                                                                     | Can write                                                                          |
| -------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| root (the runner)    | `run.sh`, `runner.mjs`, `git`, `nvidia-smi`, downloads (Node.js `fetch`) | Everything. The runner writes `evidence/`, `control/`, the code, wheels, and cache |
| `aigg-l0` (run user) | `python3.12 -m venv`, pip, `qualify.py`, See-through, `unshare`, `cat`   | Only `run/` and `output/` in the work directory (and system temporary directories) |

- The run user must exist, must not have user id or group id 0, and must not be in an administrative group (`root`, `sudo`, `admin`, `wheel`, `docker`, `lxd`, `disk`, `shadow`, `adm`, `kmem`, `sys`, `staff`).
- The child process gets the user id and group id of the run user and no supplementary groups (Node.js `spawn` with `uid` and `gid`).
- The bundle, `control/` (guard configurations), the See-through checkout, the wheelhouse, the model cache, the input, and (after prepare) the venv belong to root and are not writable by group or others. `preflight` checks every entry of these trees.
- The bundle directory, the work directory, and every parent directory must belong to root and must not be writable by group or others (a sticky directory such as `/tmp` is accepted).
- `/root`, `/etc/rp_environment`, and `/etc/sudoers` must not be readable by others before third-party Python runs. Assumption: Runpod can write Pod variables, possibly an API key, to `/etc/rp_environment`. This was not verified on a Pod.
- `run.sh` starts the runner with an empty environment except `PATH`. Every child process gets a new environment with no value from the caller except `PATH`.

## Network

| Stage     | Network need               | Control                                                                                                                                                                                                                                                                                                                                     |
| --------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare` | Pinned downloads (as root) | Wheels only from `files.pythonhosted.org`. Model files from `huggingface.co`, redirects only to names below `hf.co` or `huggingface.co`. HTTPS only, no user name, no port, at most 5 redirects, each target checked. Content-Length, size, and hash checked. TLS certificates checked by Node.js. Git: HTTPS only, isolated configuration. |
| `qualify` | None                       | A new user and network namespace (only `lo`), offline settings, the guard.                                                                                                                                                                                                                                                                  |
| `run`     | None                       | A new user and network namespace (only `lo`), offline settings, the guard.                                                                                                                                                                                                                                                                  |

`isolation` checks, as the run user, that `unshare --user --net --map-current-user` works and that the new namespace has only `lo`. The runner changes no firewall rule and uses no privileged container.
If the Pod does not allow user namespaces (for example a container seccomp profile), `qualify` and `run` are BLOCKED. The owner can accept the weaker guard-only mode with `--accept-guard-only-network`. The choice is written to `qualify.json` and `result.json`.

Guard-only mode limits: the offline settings and the guard stop network calls from Python code, and the run user has no credentials. Native code (C, C++, Rust, CUDA libraries) can still open a network connection. This mode is bounded, not isolated.

## Threats and controls

| Threat                                             | Control                                                                                                                                                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A changed bundle file                              | `run.sh` checks `SHA256SUMS`. The runner checks `manifest.json` against the pins in its source, each listed bundle file against `manifest.json`, and the owner and mode of each file.                |
| Third-party code changes the guard or its config   | `guard.py`, `qualify.py`, and `control/*.json` belong to root and are read-only for the run user.                                                                                                    |
| Third-party code changes code, venv, or models     | These trees belong to root after prepare. The run user can write only in `run/` and `output/`.                                                                                                       |
| Third-party code reads credentials                 | It runs as the run user without a password, sudo, SSH key, or token. Credential paths must not be readable by others. The environment has no secrets.                                                |
| A changed or extra See-through file                | Every file in `common/` and `inference/scripts/` must have its pinned SHA-256. Extra files, links, special files, and `__pycache__` are errors.                                                      |
| A changed model or wheel download                  | Pinned size and hash. A download goes to a `.part` file and gets its name only after the check. An existing file with other content stops the runner. Nothing is replaced.                           |
| A download from another host                       | Per-source host lists (see Network). Each redirect target is checked. A malformed or missing location and more than 5 redirects stop the download.                                                   |
| Another revision or file in the model cache        | `hf/` may hold only `hub/` with the two pinned repository folders, and each only `refs/main` (the pinned revision) and the pinned files in `snapshots/<revision>/`. No token file.                   |
| Pickle-based model files (SAM `.pt`, LaMa `.ckpt`) | The manifest refuses `.bin`, `.pt`, `.pth`, `.ckpt`, `.pkl`. `--tblr_split` (the only path to LaMa) is forbidden in the runner and in the guard. The guard denies pickle class lookups.              |
| Automatic downloads at run time                    | Network namespace, `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, a run-local `HF_HOME` with only pinned files, and the guard denies all network calls.                                               |
| Silent fallback in See-through                     | The runner requires that the LayerDiff3D `scheduler/scheduler_config.json` and both `model_index.json` files were read from the pinned cache. A read of another cache file is an error.              |
| Source builds and floating dependencies            | pip runs with `--no-index`, `--require-hashes`, `--only-binary :all:`, `--no-deps`, `--isolated`, and only the local checked wheels. The venv must contain exactly the pinned packages.              |
| Wheels for another platform                        | The manifest accepts only wheels with tags for CPython 3.12 (or abi3, or py3) and `manylinux` up to glibc 2.28 on x86_64. `preflight` checks the glibc of the host.                                  |
| A broken installation                              | `qualify` (owner gate) imports each direct requirement, compares every installed distribution with the pins, and runs one CUDA operation. `run` needs its PASS for the same bundle.                  |
| New processes from See-through                     | The guard denies `subprocess`, `os.system`, `exec`, `spawn`, and `fork`.                                                                                                                             |
| A process that continues after timeout or cancel   | The process group and every process of the run user are killed, with a bounded wait. A remaining process makes the result FAIL. `collect` kills processes of the run user again. See the guarantees. |
| A large or strange output                          | At most 2000 files and 4 GiB, only `.psd`, `.png`, `.json`. Links and special files are errors. Root takes `output/` before the check. The run stops after 3600 s.                                   |
| Repeated runs                                      | One run per work directory. `result.json`, an existing `output/`, or a guard log of a run stops a second run.                                                                                        |
| Hidden model execution during preparation or tests | `preflight`, `gpu`, `isolation`, `collect`, and `status` start no Python. `prepare` runs no See-through code and loads no model. Tests and CI use synthetic files only.                              |

## Guarantees and best-effort protections

These hold by construction when the runner runs as described (Linux, root, the run user exists):

- No third-party Python runs as root. `prepare`, `qualify`, and `run` refuse to start without root and a valid run user, and they start each Python process with the run user's ids.
- The run user cannot change the bundle, the guard configuration, the code, the venv (after prepare), the wheelhouse, the model cache, or the input. Each start of `qualify` and `run` checks owners and modes first.
- Only pinned bytes are accepted: each downloaded file has its pinned size and hash before it gets its name, and `preflight` checks every file again.
- `run` needs a passed `qualify` for the same `manifest.json`, a READY `preflight`, a PASS GPU check, and the network decision.
- With ISOLATED, the Python process of `qualify` and `run` has no network interface except `lo` (kernel network namespace).
- Stop control (Linux): each process of the run user starts in a new session and process group. On timeout, and when the runner gets SIGINT, SIGTERM, or SIGHUP, the runner kills the process group with SIGKILL. After the end of the direct child, it kills every remaining process of the run user (also a process that left the group with `setsid`) and waits at most 10 s. A remaining process gives `E_ORPHAN_PROCESSES` (killed) or `E_PROCESS_SURVIVED` (still alive), and the result is FAIL. Before the start, a live process of the run user gives `E_RUN_USER_BUSY`. After `qualify` and `run`, the runner waits at most 15 s until `nvidia-smi` shows no compute process, else `E_GPU_PROCESS_REMAINS`.

These are best effort (defense in depth or detection):

- The guard (PEP 578 audit hooks) sees only Python-level events. The process can change its own guard log, because the log is in `run/`.
- Guard-only network mode, when the owner accepts it.
- The credential path list is short. Other files on the image that are readable by others are not checked.
- The run user can write in system temporary directories (`/tmp`, `/dev/shm`) and can see other world-readable files of the image.
- The Python process can start no new process through Python, but native code can. The stop control below kills such processes, but only while the runner is alive.
- `waitGpuFree` uses `nvidia-smi --query-compute-apps`. In a container, this list can be empty although a process uses the GPU. The `/proc` check of the run user is the main control.

## Python in this package

`assets/guard.py` and `assets/qualify.py` are Python because the controls and checks must act inside the Python process that See-through uses (PEP 578 audit hooks, imports). Node.js cannot do that.
The runner starts them with `python -I -B` (isolated mode, no bytecode files). The guard refuses to start without these flags, with another Python version than 3.12, or with a script that is not the pinned See-through script or `qualify.py` next to it.

## Residual risks

- Native code is not controlled by the guard. A malicious wheel or a weakness in a parser can do file operations as the run user, and network operations when the Pod has no network namespace.
- The kernel and the container are shared with the Pod. A kernel weakness can let the run user escape. Runpod controls the container settings.
- Configuration and tokenizer files are checked by Git blob id (SHA-1) at a pinned revision. SHA-1 is weaker than SHA-256. Their SHA-256 values are recorded at the first download.
- 59 of 79 wheels are transitive dependencies (for example of `huggingface-hub`, `torch`, and `matplotlib`). They are pinned but were not reviewed one by one.
- The static analysis of the See-through run path covers the import closure of `inference_psd.py` and the files, network, and deserialization calls in 17 files. The model logic was not reviewed line by line.
- The installation, the imports, and the CUDA runtime are not tested in CI. Only `qualify` on the GPU host shows them. A static tag check of each wheel is not a proof of a working installation.
- bf16 inference on a GPU is not bit-exact. The run records the seed, the hashes, the versions, and the logs instead.
- If the runner itself is killed with SIGKILL (`kill -9`) or the Pod stops, it cannot stop the run user's processes. `collect` kills them later, and `ps -u aigg-l0` is the manual check.
- The work directory is on a rented host. Terminate the Pod (not only Stop) after the copy of the evidence.
