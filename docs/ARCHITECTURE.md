# Pipeline architecture

**Draft.** This document describes the proposed pipeline for version 1. Many choices are open. See [the decision log](DECISIONS.md).

## Goal

The factory turns a text description into one character package.
The package fits one shared skeleton and one shared animation set.
A new character adds only new images and a new sidecar. It does not change the skeleton, the animations, or other characters.

Version 1 is the pipeline only. A game, a game engine, and a runtime are out of scope.
A web preview exists only to check packages.

## Scope of version 1

| In scope                                             | Out of scope                                 |
| ---------------------------------------------------- | -------------------------------------------- |
| One shared skeleton for all characters               | A skeleton for each character                |
| One shared animation set                             | Animations for each character                |
| One view. The other facing direction uses mirroring. | Many views (front, back, side) per character |
| Parts, sidecar, and atlas for each character         | Frame-by-frame sprite sheets                 |
| Validation of a package against the rig contract     | Game logic, combat, or physics               |
| Preview of a package on the shared skeleton          | Soft parts (meshes, physics), unless decided |

## Main principles

1. **Generate in the reference pose.** Do not cut a character out of an arbitrary image. Generate the design again in the pose and proportions of the mannequin. Then the cut, the pivots, and the checks become simple.
2. **The contract is fixed.** Bones, slots, draw order, pivots, and attachment rectangles come from the contract. A generator never selects them.
3. **The base body is shared (proposed).** The skin parts are drawn and cut once. AI generates clothes, hair, face, accessories, and weapons. This removes most hidden-anatomy errors. See decision D7.
4. **Canonical data is PNG plus JSON.** PSD, ORA, atlas, and preview files are derived output.
5. **A human approves.** In version 1, a human selects the concept, cleans the layers, and approves the final package.
6. **Measure, do not trust.** Pose control does not guarantee geometry. Each production art image is measured against the mannequin before decomposition.

## Stages

| #   | Stage               | Input                            | Output                                                       | Who                     |
| --- | ------------------- | -------------------------------- | ------------------------------------------------------------ | ----------------------- |
| S0  | Rig contract (once) | Skeleton decisions               | Master rig, `skeleton.json`, `rig.contract.json`, mannequin  | Human (once)            |
| S1  | Specification       | Text description                 | `character.spec.json` with options from the contract         | AI (LLM)                |
| S2  | Concepts            | Specification                    | 4–8 free-pose concept images and generation records          | AI                      |
| S3  | Concept selection   | Concepts                         | One approved concept                                         | **Human**               |
| S4  | Production art      | Approved concept, control images | Image in the reference pose, measured against the mannequin  | AI, repeated until pass |
| S5  | Decomposition       | Production art                   | Semantic layers and masks                                    | AI                      |
| S6  | Hidden area fill    | Layers                           | Layers with filled hidden areas (clothes and hair only)      | AI                      |
| S7  | Assembly            | Layers, base body, contract      | `parts/*.png` and `character.json`                           | Script                  |
| S8  | Cleanup             | Parts as derived PSD             | Corrected parts                                              | **Human**               |
| S9  | Validation          | Parts, sidecar, contract         | `validation-report.json`                                     | Script                  |
| S10 | Packing             | Parts                            | Atlas and pages for this character                           | Script                  |
| S11 | Preview             | Atlas, shared skeleton           | Contact sheet and video of all animations in both directions | Script                  |
| S12 | Final approval      | Preview, validation report       | Package accepted, or returned to S8                          | **Human**               |

Stages S4 and S7 are the most important. If S4 gives an image in the reference pose, S7 becomes alignment to the mannequin.

## Data flow

```text
text -> S1 specification -> S2 concepts -> S3 human selects one
     -> S4 production art (pose control from the mannequin, measured, repeated)
     -> S5/S6 decomposition and fill
          limbs and torso: base body masks, clothes filled per zone
          hair, headwear, ears, tail, weapon: decomposition tool
     -> S7 assembly -> parts/*.png + character.json   (canonical)
     -> to-psd -> S8 human cleanup in an image editor -> from-psd
     -> S9 validation (rig.contract.json + data from the Spine export)
     -> S10 atlas (fixed attachment rectangles)
     -> S11 preview -> S12 human approves

master rig (one Spine project) -> skeleton.json (shared) -> rig.generated.json -> check against rig.contract.json
```

## Candidate tools

**Proposed.** No tool is accepted. Licenses must pass [the model license registry](MODEL_LICENSES.md) before use.

| Stage       | Candidate                                                    | License label                            |
| ----------- | ------------------------------------------------------------ | ---------------------------------------- |
| S2, S4      | ComfyUI through its HTTP API, with JSON workflows            | open source (GPL-3.0)                    |
| S2, S4      | Animagine XL 4.0 as the style model                          | open weights (CreativeML Open RAIL++-M)  |
| S4          | `xinsir/controlnet-union-sdxl-1.0` for pose, depth, line art | open weights (Apache-2.0)                |
| S4, S6      | Qwen-Image-Edit-2511, FLUX.2 [klein] 4B for design transfer  | open weights (Apache-2.0)                |
| S5, S6      | See-through for anime layer decomposition                    | code Apache-2.0, weights OpenRAIL++      |
| S5          | SAM 2 or SAM 3 for mask correction                           | Apache-2.0 / SAM License                 |
| S8          | Krita or Photoshop                                           | open source (GPL-3.0) / proprietary paid |
| S0, S10     | Spine 4.3 editor and CLI                                     | proprietary paid                         |
| S7, S9, S10 | Node.js packages in this repository (PSD, PNG, JSON Schema)  | MIT                                      |
| S11         | Spine Web Components runtime with Playwright                 | Spine Runtimes License / Apache-2.0      |

The research found these tools unsuitable for a commercial product without a legal review: NoobAI XL (no commercial use of generated products) and FLUX.1 Fill [dev] (non-commercial weights).

## Repository role

The repository holds the Node.js side of the pipeline: schemas, validation, assembly, PSD exchange, packing, preview, and orchestration of external tools.
Python tools and GPU services stay outside the repository. Packages call them through narrow adapters.
See [the workspace layout](WORKSPACES.md) for the planned packages.

## Related documents

- [Rig contract](RIG_CONTRACT.md)
- [Character package format](CHARACTER_PACKAGE.md)
- [Decision log](DECISIONS.md)
- [Model license registry](MODEL_LICENSES.md)
- [Roadmap and experiments](ROADMAP.md)
