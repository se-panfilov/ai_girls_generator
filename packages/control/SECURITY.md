# Security notes: @aigg/control

**Draft.** Trust assumptions, controls and residual risks of this package.

## Inputs

| Input                  | Trust     | Controls                                                                                                                                                                                                                              |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rig.contract.json`    | Untrusted | Size limit 1 MiB. Run-time checks of all used fields (ids, numbers, parents, rectangles, tolerances) with stable `E_CONTRACT_*` codes. The contract is not changed.                                                                   |
| Images (PNG)           | Untrusted | Size limit 64 MiB on disk. Width, height and pixel count are checked from IHDR before the pixel data is inflated. Inflate output is limited to the exact size. CRC of each chunk is checked. Only 8-bit RGB and RGBA, not interlaced. |
| Spine `skeleton.json`  | Untrusted | Size limit 16 MiB. Only rotate and translate bone timelines are read. Each key value must be a finite number. Other timelines are listed and ignored.                                                                                 |
| Manual marks JSON      | Untrusted | Size limit 1 MiB. Format id, known keypoint names, finite numbers, image size, and the optional image SHA-256 are checked.                                                                                                            |
| Command-line arguments | Operator  | `node:util` `parseArgs` in strict mode. Options that a command does not use are refused. Model and image names in workflows must be plain file names.                                                                                 |

Color space: pixel values are used as stored and are assumed to be sRGB. ICC profile and gamma chunks are ignored and are listed in the report. PNG alpha is straight alpha.

## Writes

Each command writes into one output directory. The directory must be new, or empty, or `--force` must be given. A symbolic link as the output directory is refused.
Each file is written to a new temporary name with the exclusive flag and then renamed. The rename replaces a link at the target name, so a write never follows a link.
File names come from the code, not from input. `--dry-run` prints the report and writes nothing.

## External effects

No network access, no subprocess, no shell, and no environment variables. The `workflow` command writes ComfyUI API JSON files. It does not send them to a server and does not load or download a model.
The prompts in the workflows ask for an explicitly adult character with a safe rating. The negative prompt excludes explicit content and minors.

## Residual risks

- A whole input file is read into memory (at most 64 MiB for an image).
- An image at the pixel limit (4096 x 4096) needs about 64 MiB of RGBA memory, and the side-by-side sheet needs four times that.
- The workflow JSON was not run against a live ComfyUI server. A node name or input can be wrong for the server version. Check it on the first run.
- Model files are executable input for the generation host. This package does not check them. Check the SHA-256 against `run-plan.json` before a run.
