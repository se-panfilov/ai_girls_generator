# Character package format

**Draft.** This document describes the proposed package for contract version 0.2. See [the rig contract](RIG_CONTRACT.md).

## Layout

```text
characters/<character_id>/
  character.json              # sidecar, canonical
  parts/
    <slot_id>.png             # one file for each present slot, canonical
  source/
    concept.png               # approved concept
    production.png            # production art in the reference pose
    decomposed.psd            # raw decomposition output, kept for history
    working.psd               # derived from parts/ for human cleanup
  provenance/
    generation.json           # models, hashes, seeds, workflows, tool versions, log
  export/
    <character_id>.atlas      # derived
    <character_id>.png        # derived atlas page (or .webp)
  qa/
    validation-report.json    # derived
    contact-sheet.png         # derived, frames of all animations
    preview.webm              # derived
```

Only `character.json` and `parts/` are canonical. A script makes every other file in `source/`, `export/`, and `qa/` from canonical data, except the concept, the production art, and the raw decomposition output.
Do not edit a derived file and treat it as the source. Edit the parts, or import the edited PSD back to parts with the import script.

Storage of binary files is open. See decision D15.

## Image rules

| Property    | Rule                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| Format      | PNG, RGBA, 8 bits per channel                                                                                |
| Color space | sRGB                                                                                                         |
| Alpha       | Straight (not premultiplied). Premultiplication happens only at atlas export.                                |
| Canvas      | Each part uses the full contract canvas, or a declared offset inside its attachment rectangle (decision D16) |
| Atlas pages | PNG, or lossless WebP. Lossy WebP only after an edge check.                                                  |
| PSD         | Pixel layers only, Normal blend mode, no effects, no masks, no smart objects.                                |

## Sidecar fields

| Field                                           | Content                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`                                 | Sidecar schema version, for example `0.2.0`.                                                                       |
| `characterId`                                   | `snake_case` identifier. It is also the directory name.                                                            |
| `rigId`, `rigContractVersion`, `animationSetId` | The contract that the package targets.                                                                             |
| `source`                                        | Canvas size, color space, alpha mode, pose, view, paths to concept, production art, and the derived editable file. |
| `parts`                                         | One entry for each slot of the contract. `present` with file and SHA-256, or `absent_by_design` with no file.      |
| `design`                                        | `asymmetric` flag and details, body type, skin tone.                                                               |
| `render`                                        | Default facing and whether mirroring is allowed.                                                                   |
| `provenance`                                    | Path to the generation record.                                                                                     |

A part entry with `present` can also give its `origin`: `base_body`, `generated`, `decomposed`, or `manual`.
The sidecar never sets pivots or draw order. The contract sets them.
An `absent_by_design` part has no PNG file and no atlas region (decision D22, accepted). See [Absent parts](RIG_CONTRACT.md#absent-parts-accepted-decision-d22).

## Generation record

`provenance/generation.json` records enough data to repeat or audit each AI step:

- Model and LoRA files with SHA-256 values and license ids from [the model license registry](MODEL_LICENSES.md).
- The workflow file and its SHA-256 value.
- Seeds, prompts, negative prompts, sampler settings, and resolutions.
- Tool names and versions, for example the decomposition tool commit.
- A log of each human step: who approved, and what changed.

Diffusion output can differ between GPUs. Reproducibility means the same parameters, the same files, and a log with hashes of the saved results. It does not mean the same pixels (decision D14).

## Validation result

The validator writes `qa/validation-report.json` with each check, its result, and the affected slot or file.
A package with an error is not approved. A human cannot accept a package with a failed required check without a contract change.
