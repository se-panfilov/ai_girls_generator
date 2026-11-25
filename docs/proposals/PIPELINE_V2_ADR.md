# Pipeline v2: direct modular generation (architecture decision record)

**Status.** The pipeline generation decision in section 2 is accepted by the owner (D35 in [the decision log](../DECISIONS.md#d35-pipeline-generations)). All other sections are **proposed**. They are not accepted implementation decisions. No v2 code exists.

Related documents:

- [Pipeline v1 and its deprecation policy](../PIPELINE_V1.md)
- [Component inventory and deferred cleanup plan](../COMPONENT_INVENTORY.md)
- [Roadmap](../ROADMAP.md#pipeline-generations-d35)

## Contents

1. [Context](#1-context)
2. [Decision](#2-decision)
3. [Pipeline v2 architecture](#3-pipeline-v2-architecture)
4. [Modular character sheet](#4-modular-character-sheet)
5. [Reuse of existing contracts and tools](#5-reuse-of-existing-contracts-and-tools)
6. [Manual correction of pivots and landmarks](#6-manual-correction-of-pivots-and-landmarks)
7. [Versioning semantics and pipeline provenance](#7-versioning-semantics-and-pipeline-provenance)
8. [Pipeline v2 MVP implementation sequence](#8-pipeline-v2-mvp-implementation-sequence)
9. [Earlier proposals: superseded and still relevant](#9-earlier-proposals-superseded-and-still-relevant)
10. [Risks](#10-risks)
11. [Open questions](#11-open-questions)

## 1. Context

The MVP vertical slice (D33) used one workflow for two licensed test characters: a concept image, See-through decomposition, manual landmarks, and modular assembly. This document calls it **Pipeline v1**. Its description and evidence are in [Pipeline v1](../PIPELINE_V1.md).

The v1 evidence shows a common cause for most defects: the decomposition must reconstruct body parts that the concept image does not show.

| Recorded defect                            | Evidence                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Merged upper thighs                        | L0-1b (Akane) and MVP-E (Jun). The legwear layer has one region for both thighs.                                       |
| Joint gaps after rotation                  | L0-1e to L0-1g. A deterministic underlay closes most gaps, but not all, and not with a bit-exact neutral pose.         |
| Hidden shoulder and far limbs              | MVP-A. The far shoulder joint is an estimate with high uncertainty.                                                    |
| Invented or hidden face and hair content   | MVP-E. About 79 % of the back hair is a See-through completion. The eye layers are under the face.                     |
| Character-specific rules in a general step | MVP-E. The rules "held object goes to the far hand" and "bottomwear is a skirt" come from Akane and are wrong for Jun. |
| Manual landmarks for each character        | L0-1d and MVP-E. A person marks about 20 landmarks before the assembly.                                                |

The project goal does not change: one shared skeleton, one shared animation set, and canonical PNG parts plus `character.json` for each character.

## 2. Decision

**Accepted by the owner (D35).**

The project distinguishes two pipeline generations.

| Pipeline generation | Name                      | Workflow                                                                                                       | Status                                                                                    |
| ------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Pipeline v1         | Concept decomposition     | Concept image → See-through decomposition → layered assets → manual landmarks → modular assembly → Spine → web | **Deprecated** for future development. It stays intact and reproducible.                  |
| Pipeline v2         | Direct modular generation | Modular character sheet → extraction and validation → skeleton attachment → Spine export → web playback        | **Primary.** The immediate MVP starts with a modular character sheet that already exists. |
| Pipeline v2 (later) | Generation extension      | Text description (or reference image) → AI-generated modular character sheet → the same Pipeline v2            | Future extension.                                                                         |

The primary goal of Pipeline v2 is less reconstruction of hidden body parts. The input supplies the parts directly.

Also accepted:

- The removal of Pipeline v1 is not authorized. A removal needs a separate owner decision and a separate pull request.
- The deprecation and compatibility rules are in [the Pipeline v1 policy](../PIPELINE_V1.md#deprecation-and-compatibility-policy).

Not changed by D35:

- The rig contract, the shared skeleton, the animation set, the package format, the security rules, the model license registry, and the content rules.
- The other entries in the decision log. D35 closes no other decision. D27 and D31 stay open (see [section 9](#9-earlier-proposals-superseded-and-still-relevant)).
- The phase gates and the acceptance levels in the roadmap.
- No permission to spend money, rent a GPU, call a paid API, or add a model.

## 3. Pipeline v2 architecture

**Proposed.**

```text
modular character sheet (PNG + optional layout descriptor)
  -> 1 sheet authoring        (MVP: prepared outside the factory. Later: generation extension)
  -> 2 extraction             (separate image regions -> one image per extracted region)
  -> 3 semantic classification (region -> contract slot, or "not used")
  -> 4 geometry and pivots    (scale, orientation, joint points, overlaps, checks against the contract)
  -> 5 skeleton attachment    (region attachments on the shared bones and slots, setup pose check)
  -> 6 Spine export           (Spine 4.3 JSON + images -> Spine CLI import and export -> atlas)
  -> 7 runtime validation     (web playback of the shared animations)
  -> canonical package: parts/*.png + character.json (+ derived Spine export)

generation extension (later):
text prompt or reference image -> modular character sheet -> step 2
```

The seven steps are different responsibilities. A tool can do more than one step, but its report must name the result of each step separately.

| #   | Step                    | Input                                             | Output                                                            | Main failure that this step must detect                                                  |
| --- | ----------------------- | ------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Image generation        | MVP: none (prepared sheet). Later: text or image. | Sheet PNG, provenance                                             | Missing parts, wrong view, inconsistent design between parts.                            |
| 2   | Segmentation/extraction | Sheet PNG, optional layout descriptor             | One PNG for each region, region list with boxes and pixel counts  | Touching parts, stray pixels, labels or guides in the image, color fringes.              |
| 3   | Semantic classification | Regions, layout descriptor or a mapping file      | Mapping region → slot id (near/far names of the contract)         | Wrong side (near/far), wrong segment, a part that has no slot.                           |
| 4   | Geometry and pivots     | Mapped parts, contract                            | Joint points for each part, scale, rotation, overlap measurements | Scale differences between parts, missing joint overlap, part outside its rectangle.      |
| 5   | Skeleton attachment     | Parts with geometry, shared skeleton              | Region attachment transforms, setup pose render                   | Gaps or overlaps in the setup pose, wrong draw order.                                    |
| 6   | Spine export            | Spine JSON and images                             | Spine CLI import and export result, atlas                         | Data that Spine changes or refuses (for example a curve or a feature outside Essential). |
| 7   | Runtime validation      | Spine export                                      | Playback of the shared animations in the web runtime              | Visible joint gaps in motion, missing regions, wrong facing.                             |

A modular character sheet is **not** Spine-ready only because it shows separated parts. Steps 3 to 7 are necessary for each sheet. Each step records its result at one of the output maturity levels of [the T0 ADR, section 3.3](T0_TEMPLATE_FIRST_ARCHITECTURE.md#33-output-maturity-levels).

## 4. Modular character sheet

**Proposed.** Step 1 of the v2 MVP core writes the "Modular Sheet Contract v0.1". This section lists only the questions that the contract must answer, and the recommended answers. It is not the contract.

| Topic             | Recommended answer (proposal)                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image             | One PNG, RGBA, 8 bits per channel, sRGB, straight alpha. Same rules as [the package format](../CHARACTER_PACKAGE.md#image-rules). Size limits before decoding.                                                       |
| Part separation   | Each part is one region with a transparent margin to all other regions. A part never touches another part.                                                                                                           |
| Layout descriptor | An optional JSON file: for each region a box, a slot id, and optional joint points in sheet pixels. With a descriptor, extraction does not guess. Without it, extraction gives regions only, and a person maps them. |
| Part set          | The slots of the rig contract. Required slots must have a part. Optional slots without a part are `absent_by_design` (D22).                                                                                          |
| Segments          | Separate images for the upper arm, forearm, and hand, and for the thigh, shin, and foot, as the contract slots need (D23 principles).                                                                                |
| Joint overlap     | Each parent segment continues under the child segment past the joint, at least to the overlap radius of the contract. This is the main difference from v1, which must invent these pixels.                           |
| Hidden content    | Each part is complete, also where another part covers it in the reference pose (for example the torso under the near arm).                                                                                           |
| View and sides    | The contract view and the near/far side names. One view only. The other facing direction uses mirroring.                                                                                                             |
| Scale             | One scale for all parts of one sheet, declared in the descriptor (sheet pixels for each contract pixel).                                                                                                             |
| Held items        | A weapon or a held item is a separate part, never drawn into a hand. This agrees with the equipment intent (D25).                                                                                                    |
| Face              | One head part in the MVP. The current contract has no face feature slots.                                                                                                                                            |
| Provenance        | The sheet source (artist, tool, or model), its license, and its SHA-256. A licensed test sheet stays outside Git.                                                                                                    |

## 5. Reuse of existing contracts and tools

**Proposed.** Pipeline v2 reuses the existing canonical data and the existing back-end tools. It does not need a new rig contract.

| Existing item                                                        | Use in Pipeline v2                                                                                                                                        |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Rig contract](../RIG_CONTRACT.md) and the C0.5 candidate contract   | Slot ids, draw order, joints, attachment rectangles, overlap radius. The MVP uses the C0.5 candidate as v1 did. It is not a production rig (D32 is open). |
| [Character package](../CHARACTER_PACKAGE.md)                         | The same canonical output: `parts/*.png` and `character.json`. A v2 package must be readable by the existing readers.                                     |
| Spine skeleton builder and checks (`bodyrig.ts`, `spineskeleton.ts`) | Step 5 and the offline part of step 6. They take bones, slots, and image boxes, not See-through data.                                                     |
| `spine-validate`                                                     | Step 6, if the v2 package uses the `mvp-a-body` layout, or after a new layout is added to the command.                                                    |
| `@aigg/viewer`                                                       | Step 7 without change. It reads a Spine export, not the pipeline input.                                                                                   |
| `@aigg/rig-runtime`                                                  | Skin from `character.json`, atlas checks, manifests, part modules (D23).                                                                                  |
| `@aigg/factory` job model                                            | Checkpoints bound to digests, fingerprints, and resume. The stage list must change for v2 (see [the inventory](../COMPONENT_INVENTORY.md)).               |
| T1a template (`template`)                                            | Masks and overlap circles of each slot on the C0.5 geometry. A source for sheet templates, synthetic test sheets, and geometry checks.                    |

**When a new rig contract is justified.** Only with evidence that a v2 sheet cannot fit the existing slots, joints, or overlaps, for example face feature slots for expressions (MVP-E backlog B6). Each contract change needs a human decision (see [Human decisions](../../AGENTS.md#human-decisions)).

**Shared skeleton (assumption to verify).** The v1 tool `assemble-body` places the bones at the manual landmarks of each character. The bone ids are shared, but the setup geometry changes with each character. In v2, the sheet supplies parts with known joint points. This can let all characters use the contract joint positions, which is nearer to the shared-skeleton requirement. Verify with the first v2 package: compare its bone positions with the contract joints.

## 6. Manual correction of pivots and landmarks

**Proposed.** Automatic joint points can be wrong. A person can correct them. The correction is an input file, never an edit of a generated file.

- **Input file.** A correction file names each part, its joint points in part or sheet pixels, and the SHA-256 of the sheet that it refers to. A tool refuses a correction file for another sheet.
- **Tool.** The v1 manual landmark page (`annotate-page`) shows that a self-contained local HTML page works for this task. A v2 page can reuse its interaction model (point, drag, unknown range, undo, export with validation) for part joint points.
- **Checkpoint.** A factory checkpoint (for example `PIVOT_REVIEW`) records a human decision bound to the digest of the correction file and the extraction output, as `L_REVIEW` does now. Agents never record this decision.
- **Provenance.** The provenance names the correction file and its SHA-256. The report says which joint points are automatic and which are manual. Manual work is not presented as automation.

## 7. Versioning semantics and pipeline provenance

### 7.1 Version axes

"Pipeline v1" and "Pipeline v2" name workflow generations only. They are independent of all other version numbers in the project.

| Axis                              | Example                           | Where it is set                                     | Relation to the pipeline generation                                                       |
| --------------------------------- | --------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Pipeline generation               | Pipeline v1, Pipeline v2          | D35, this document                                  | —                                                                                         |
| Product scope "version 1"         | "Version 1 is the pipeline"       | [AGENTS.md](../../AGENTS.md), architecture          | None. Both pipeline generations are inside product version 1.                             |
| Equipment System "v2+"            | Future Equipment System (v2+)     | [Roadmap](../ROADMAP.md#future-equipment-system-v2) | None. It is a later product version, not Pipeline v2.                                     |
| Rig contract version              | `contractVersion` 0.x, freeze 1.0 | `rig.contract.json`                                 | None. Both generations target the same contract.                                          |
| Character package schema version  | `schemaVersion` `0.2.0`           | `character.json`                                    | None.                                                                                     |
| Spine editor and runtime versions | 4.3.26 editor, 4.3.13 runtime     | Spine export, `package.json`                        | None.                                                                                     |
| npm package versions              | `@aigg/control` 0.14.2            | `package.json` (SemVer)                             | None. A package can contain v1 and v2 commands.                                           |
| Tool data formats                 | `aigg.mvp-a.spine-body/0.1`       | Report and evidence files                           | A format can be specific to one generation, but its version does not name the generation. |

Rules:

- Do not rename an existing versioned artifact to match the pipeline numbering.
- In documentation, write "Pipeline v1" and "Pipeline v2" in full. Do not write "v1" or "v2" alone where it can mean the product version or the Equipment System.

### 7.2 Pipeline provenance (proposal)

A package must show which pipeline generation made it. The proposal adds the information to the generation record, not to `character.json`.

- **Where.** `provenance/generation.json` (see [the package format](../CHARACTER_PACKAGE.md#generation-record)), and in a later factory job schema.
- **Field (proposed).** `pipeline.generation` with the values `concept_decomposition` (Pipeline v1) or `modular_sheet` (Pipeline v2). Descriptive values avoid a conflict with the other "v1" and "v2" axes.
- **Existing packages.** A missing field means "not recorded". A reader must not fail on it. A tool can report the inferred generation from the evidence (for example a See-through `<stem>.psd.json` input means Pipeline v1), but it must not write the field into an existing package.
- **Existing factory jobs.** Every current `job.json` comes from the v1 stage list. A future job schema version can record the generation. The current job files stay readable.
- **Approval.** Each schema change needs a separate owner approval. This document changes no schema.

## 8. Pipeline v2 MVP implementation sequence

**Proposed.** The roadmap holds the step list ([Pipeline v2 — MVP core](../ROADMAP.md#pipeline-v2--mvp-core)). This section gives the minimum scope and the evidence of each step.

| Step | Scope                                                                                                                                                           | Minimum evidence                                                                                                       | Needs                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| V2-1 | Modular Sheet Contract v0.1: the document, a draft JSON Schema of the layout descriptor, and a synthetic test sheet that a script makes from the T1a mock parts | The schema accepts the synthetic sheet and rejects broken examples. Tests with synthetic data only.                    | Owner review of the contract. No GPU, no art.                |
| V2-2 | Extraction: one command, sheet → one PNG for each region and a region report                                                                                    | Exact pixel partition on the synthetic sheet (no lost, duplicated, or changed pixel). Clear errors for touching parts. | Offline                                                      |
| V2-3 | Mapping and geometry: regions → contract slots, joint points, scale, overlap and rectangle checks, optional manual correction file                              | All required slots mapped on the synthetic sheet. Each check fails on a broken example.                                | Offline                                                      |
| V2-4 | Skeleton attachment and Spine package: the existing skeleton builder, the `mvp-a-body` package layout, `character.json`                                         | Offline checks PASS. Then the owner runs `spine-validate` (CLI import and export without differences).                 | Owner Spine session for the CLI step                         |
| V2-5 | Web playback with `@aigg/viewer`                                                                                                                                | `idle` and `wave` play without critical defects.                                                                       | Owner run on the real export                                 |
| V2-R | The same steps on one real prepared modular sheet                                                                                                               | Recorded defects and manual time, as in MVP-E.                                                                         | An owner-supplied sheet with a rights record (open question) |

The factory gets a v2 stage list only after the manual v2 path works once (D33 exception conditions apply).

## 9. Earlier proposals: superseded and still relevant

**Proposed reading.** Only the owner changes the status of a decision log entry.

| Earlier item                                                                      | Status after D35                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MVP sequence MVP-A to MVP-E                                                       | Done or waiting for owner steps (see [Pipeline v1](../PIPELINE_V1.md#experiments-and-results)). It is the v1 vertical slice. Its evidence stays.                                                           |
| MVP-F (improve the v1 slice by the recorded defects)                              | **Superseded as the next priority** by the v2 MVP core. Generic items that also help v2 stay relevant: MVP-E backlog B2 (alpha threshold), B3 (report text from data), B8 and B9 (owner validation steps). |
| MVP-E backlog B1, B4, B5, B7 (weapon hand, trousers rule, underlays, thigh split) | v1-specific. Deferred. Not done by default under the v1 policy.                                                                                                                                            |
| MVP-E backlog B6 (face feature slots)                                             | Still relevant to both generations. It needs a rig contract decision.                                                                                                                                      |
| T0 ADR: W → L → M as the main production-art route (D27)                          | The L step through decomposition is now Pipeline v1. The W step and the M representation stay relevant. D27 stays open. The owner decides if D27 changes.                                                  |
| D31 (L technique)                                                                 | Applies to Pipeline v1 only. Stays open. Low priority.                                                                                                                                                     |
| T1a static template, F0 rig feasibility, D17, D32                                 | Still relevant to both generations. A v2 sheet needs the same geometry and the same master rig decision.                                                                                                   |
| Experiment B (layer decomposition)                                                | Pipeline v1 research. Deprioritized.                                                                                                                                                                       |
| Experiment C (rig-guided generation, C0 to C2)                                    | Relevant to the generation extension (skeleton-aware image guidance). Not on the v2 MVP core path.                                                                                                         |
| L0-1b to L0-1g studies                                                            | Pipeline v1 evidence. The underlay knowledge is relevant if a v2 sheet has no joint overlap.                                                                                                               |
| M0-F0a, MVP-B (Spine CLI validation), MVP-C (viewer), MVP-D (factory)             | Shared. Still relevant.                                                                                                                                                                                    |
| D22, D23, D25, D26 (absent parts, modules, equipment, animated parts)             | Shared. Still relevant. A modular sheet makes D23 and D25 easier, because parts and held items arrive separated.                                                                                           |
| Phase gates 0 to 8                                                                | Kept. The roadmap shows the relation of each phase to the pipeline generations.                                                                                                                            |

## 10. Risks

| Risk                                                                             | Effect                                                     | Mitigation (proposed)                                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A sheet looks modular, but the parts have no joint overlap or no hidden content. | The same gaps as v1, now without a decomposition to blame. | Overlap and completeness checks in step 4. A sheet that fails is returned, not repaired silently. |
| Parts of one sheet have different scales or perspectives.                        | Joints do not meet on the skeleton.                        | One declared scale, per-part checks against the contract segment lengths.                         |
| An AI-generated sheet (later) is inconsistent between parts or between sheets.   | Identity changes across parts.                             | Generation extension step 8: sheet quality validation with bounded retry.                         |
| The C0.5 candidate geometry is not the production rig.                           | v2 packages must move to the final rig later.              | Keep D32 open. Treat v2 MVP packages as prototype output.                                         |
| v1 tools are removed too early.                                                  | Archived v1 evidence cannot be reproduced.                 | The deferred cleanup plan. Removal only by a separate owner decision.                             |
| No real prepared modular sheet exists in the project files.                      | V2-R cannot start.                                         | Open question 1.                                                                                  |

## 11. Open questions

These questions are for the owner. None is decided in this document.

1. **First real sheet.** Which prepared modular sheet does V2-R use: an artist sheet, a sheet made by hand from the artist layers of a licensed test asset (for example the sliced layers in the Akane package), or a new licensed asset? A licensed test asset stays outside Git.
2. **Layout descriptor.** Is the descriptor required in the MVP (recommended: yes, so that extraction does not guess), or optional?
3. **Joint positions.** Do v2 packages place the bones at the contract joints (shared setup geometry), or at the joint points of each sheet, as `assemble-body` does?
4. **Code location.** New v2 commands in `@aigg/control` (recommended for the MVP: no new workspace dependency, direct reuse of the modules), or a new package. A new package that imports `@aigg/control` needs an owner decision on workspace dependencies.
5. **D27 wording.** Does the owner update D27 to name the modular sheet as the main input of the M representation?
6. **Generation extension models.** The generation extension needs models with an approved scope. The current approvals cover experiment C and the two See-through runs only.
