# Security notes: @aigg/seethrough-bundle

**Draft.** Threat model, controls, and residual risks of the L0-1 See-through bundle. Do not read this as a claim of absolute safety.

## Assets and trust boundaries

| Asset or party                 | Trust                    | Notes                                                                                                         |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| This repository and the bundle | Trusted after review     | The owner checks `SHA256SUMS` of the bundle against the value in the pull request before the copy.            |
| See-through code (Apache-2.0)  | Untrusted, pinned        | Third-party Python. It runs with the rights of the process. Pinned by Git commit and by SHA-256 of each file. |
| Model files (Hugging Face)     | Untrusted, pinned        | Executable input. Only safetensors weights. Pinned by revision, size, and SHA-256 or Git blob id.             |
| Python wheels (PyPI)           | Untrusted, pinned        | Third-party code, also native code. Pinned by file name, URL, size, and SHA-256. No source builds.            |
| `concept-mirrored.png`         | Confidential input       | Derived from a paid asset. Only this file goes to the Pod. Pinned by SHA-256.                                 |
| The GPU host (Runpod Pod)      | Owner-controlled, rented | The owner starts and terminates it. No credentials of the owner or of services go to the Pod.                 |
| Outputs (PSD, PNG, logs)       | Untrusted data           | Written by third-party code. The runner checks paths and sizes. They are not committed to Git.                |

## Threats and controls

| Threat                                             | Control                                                                                                                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A changed bundle file                              | `run.sh` checks `SHA256SUMS`. The runner checks `manifest.json` against the pins in its source, and each listed bundle file against `manifest.json`.                                    |
| A changed or extra See-through file                | Every file in `common/` and `inference/scripts/` must have its pinned SHA-256. Extra files, links, special files, and `__pycache__` are errors.                                         |
| A changed model or wheel download                  | Pinned size and hash. A download goes to a `.part` file and gets its name only after the check. An existing file with other content stops the runner. Nothing is replaced.              |
| A download from another host                       | HTTPS only, no user name, no port. Allowed hosts: `huggingface.co`, `*.hf.co`, `*.huggingface.co`, `files.pythonhosted.org`. Each redirect is checked. At most 5 redirects.             |
| Pickle-based model files (SAM `.pt`, LaMa `.ckpt`) | The manifest refuses `.bin`, `.pt`, `.pth`, `.ckpt`, `.pkl`. `--tblr_split` (the only path to LaMa) is forbidden in the runner and in the guard. The guard denies pickle class lookups. |
| Automatic downloads at run time                    | `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, a run-local `HF_HOME` with only pinned files, and the guard denies all network calls.                                                     |
| Silent fallback in See-through                     | The runner requires that the LayerDiff3D `scheduler/scheduler_config.json` and both `model_index.json` files were read from the pinned cache. A read of another cache file is an error. |
| Source builds and floating dependencies            | pip runs with `--no-index`, `--require-hashes`, `--only-binary :all:`, `--no-deps`, `--isolated`, and only the local checked wheels. The venv must contain exactly the pinned packages. |
| Secrets in the environment                         | Each subprocess gets a new environment: `PATH`, run-local `HOME` and `TMPDIR`, locale, and fixed settings. No value from the caller's environment except `PATH` is passed.              |
| Git configuration that runs programs               | `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `core.hooksPath=/dev/null`, `protocol.allow=never` with HTTPS only, no terminal prompt.                                         |
| Writes outside the run directories                 | The guard denies writes, renames, deletions, links, and mode changes outside `output/` and `run/` (and `/dev/null`).                                                                    |
| New processes from See-through                     | The guard denies `subprocess`, `os.system`, `exec`, `spawn`, and `fork`.                                                                                                                |
| Links in the work directory                        | The work directory must be a real directory with mode 700. Directories and files are checked without following links. Files are opened with `O_NOFOLLOW`.                               |
| Another input image                                | The runner accepts only the PNG with the pinned SHA-256 (size limit 256 MiB).                                                                                                           |
| A large or strange output                          | At most 2000 files and 4 GiB. Links and special files in `output/` are errors. The run stops after 3600 s.                                                                              |
| Repeated runs                                      | One run per work directory. `result.json` or an existing `output/` stops a second run.                                                                                                  |
| Hidden model execution during preparation or tests | `preflight` and `gpu` do not start Python. `prepare` starts only `git`, `python3.12 -m venv`, and pip. Tests and CI use synthetic files and never download or run a model.              |

The guard denials are recorded in `evidence/guard.jsonl`. A denial makes the result FAIL, also when the See-through code catches the exception.

## Python in this package

`assets/guard.py` is Python because the controls must act inside the See-through Python process (PEP 578 audit hooks). Node.js cannot do that.
The runner starts it with `python -I -B` (isolated mode, no bytecode files). The guard refuses to start without these flags or with another Python version than 3.12.

## Residual risks

- Native code is not controlled. The guard does not see C, C++, or Rust code in wheels (for example PyTorch, safetensors, tokenizers, hf-xet), CUDA drivers, or `ctypes` calls. A malicious wheel or a weakness in a parser can do network or file operations that the guard does not see.
- The Pod network is not closed at the system level. Runpod gives no simple egress firewall for a Pod. The controls are the offline settings, the guard, and no secrets on the Pod.
- Configuration and tokenizer files are checked by Git blob id (SHA-1) at a pinned revision. SHA-1 is weaker than SHA-256. Their SHA-256 values are recorded at the first download.
- 59 of 79 wheels are transitive dependencies (for example of `huggingface-hub`, `torch`, and `matplotlib`). They are pinned but were not reviewed one by one.
- The static analysis of the See-through run path covers the import closure of `inference_psd.py` and the files, network, and deserialization calls in 17 files. The model logic was not reviewed line by line. The diffusers, transformers, and huggingface_hub code was read for the offline cache path only.
- bf16 inference on a GPU is not bit-exact. The run records the seed, the hashes, the versions, and the logs instead.
- The work directory is on a rented host. Terminate the Pod (not only Stop) after the copy of the evidence.
