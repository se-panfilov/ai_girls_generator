# @aigg/seethrough-bundle

**Draft, L0-1 only.** This package builds the owner-run bundle for the L0-1 experiment: one standalone See-through layer decomposition of one pinned concept image (`concept-mirrored.png`).
See [the T0 ADR](../../docs/proposals/T0_TEMPLATE_FIRST_ARCHITECTURE.md) for the W → L → M strategy. The package does not change the production pipeline, the rig contract, or the T1a template.

**Status of the models.** The owner gave a preliminary agreement for LayerDiff3D and Marigold See-through, for L0-1 only, at the pinned revisions. The final permission to download and use them comes after an independent audit of this bundle. They are not in [the model license registry](../../docs/MODEL_LICENSES.md) as approved models.

The package itself uses no network, starts no process, and runs no model. Its tests use synthetic files only.

## Command

Build first: `npm run build --workspace @aigg/seethrough-bundle`. Then run from the root:

```sh
node packages/seethrough-bundle/dist/src/cli.js bundle --out <dir> [--dry-run] [--force]
```

The bundle has `run.sh`, `runner.mjs`, `guard.py`, `qualify.py`, `manifest.json`, `requirements.lock`, `README.md`, and `SHA256SUMS`. The build is deterministic.
The owner copies the bundle to the GPU host and follows [the owner instructions](docs/OWNER_RUN.md).

Output files may have one ASCII space between name characters, as in `back hair.png`. The runner still refuses unsafe paths, links, special files, other file types, and output above its limits.

## Runner commands on the GPU host

The runner starts as root. It starts every third-party Python process as the unprivileged run user `aigg-l0`. See [SECURITY.md](SECURITY.md).

| Command     | Network                          | Processes and user                                                 | Third-party code                      |
| ----------- | -------------------------------- | ------------------------------------------------------------------ | ------------------------------------- |
| `preflight` | No                               | None                                                               | Not imported                          |
| `prepare`   | Yes, pinned URLs only            | root: `git`. Run user: `python3.12 -m venv`, pip from pinned wheel | Wheels installed, See-through not run |
| `gpu`       | No                               | root: `nvidia-smi`                                                 | No                                    |
| `isolation` | No                               | Run user: `unshare`, `cat`                                         | No                                    |
| `qualify`   | No (network namespace and guard) | Run user: one guarded Python process                               | Imports, one CUDA operation, no model |
| `run`       | No (network namespace and guard) | Run user: one guarded Python process                               | See-through run once                  |
| `collect`   | No                               | None                                                               | No                                    |
| `status`    | No                               | None                                                               | No                                    |

`qualify` and `run` are BLOCKED when the Pod does not allow a new network namespace, unless the owner gives `--accept-guard-only-network`.

## Pinned data

| File                         | Content                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `data/seethrough-files.json` | Every file in `common/` and `inference/scripts/` of See-through commit `df019de5129d6c4b406587a14c3501669441a783`, with SHA-256 |
| `data/model-files.json`      | The files of the two model repositories at the pinned revisions: size, Git blob id, and SHA-256 of each weight file             |
| `data/wheels.json`           | One wheel per Python package (79), with URL, size, SHA-256, and upload time                                                     |
| `data/requirements.in`       | The direct requirements that the lock was resolved from                                                                         |
| `assets/guard.py`            | The guard that starts See-through or `qualify.py` with audit hooks                                                              |
| `assets/qualify.py`          | The environment qualification: imports, installed versions, one CUDA operation                                                  |

See [the manifest notes](docs/MANIFEST.md) for how the data was made and for each component.

## Limits

- Linux x86_64 GPU host only, glibc 2.28 or later. The NVIDIA GPU must have 16384 MiB or more and driver 570 or later. Offload and quantized modes are not allowed.
- The tests do not install the wheels or import them. The static tag check of each wheel and the synthetic tests do not prove a working installation. `qualify` on the GPU host is the qualification, and it is an owner gate.
- Configuration and tokenizer files of the models have no published SHA-256. The runner checks their Git blob id (SHA-1) at the pinned revision and records their SHA-256 in the evidence.
- The guard is a detection and containment layer for Python code. It does not see native code. See [SECURITY.md](SECURITY.md).
- The bundle writes no generated image, model, or concept file into Git. The results stay on the owner's computer and in the project files.
