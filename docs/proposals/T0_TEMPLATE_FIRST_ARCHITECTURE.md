# T0: template-first character generation (architecture decision record)

**Proposed ADR. Draft.** The owner set the strategic direction (template-first generation, see [Owner direction](#2-owner-direction-and-status)). This document proposes the architecture, the data contracts and the delivery plan. The owner reviews it before any implementation.
This document changes no code, no rig contract, no master rig, no animation, no `character.json` format, no model registry entry, and no decision status.
The schemas and examples in [`t0/`](t0/README.md) are **nonauthoritative proposals**. No package reads them.

Status marks follow [the writing rules](../WRITING.md#status-marks): **Accepted**, **Proposed**, **Assumption**, **Verified**. Section 15 lists the sources of each verified claim.

## Contents

1. [Context and evidence](#1-context-and-evidence)
2. [Owner direction and status](#2-owner-direction-and-status)
3. [Critical review: conflicts and weak points](#3-critical-review-conflicts-and-weak-points)
4. [Architecture](#4-architecture)
5. [Data contracts](#5-data-contracts)
6. [Model capability negotiation](#6-model-capability-negotiation)
7. [Versions and switching of art profiles](#7-versions-and-switching-of-art-profiles)
8. [Spine layers, hidden areas and overlaps](#8-spine-layers-hidden-areas-and-overlaps)
9. [Compatibility map](#9-compatibility-map)
10. [Implemented and planned](#10-implemented-and-planned)
11. [Decisions and dependencies](#11-decisions-and-dependencies)
12. [Long-term risks](#12-long-term-risks)
13. [Delivery plan](#13-delivery-plan)
14. [T1 specification](#14-t1-specification)
15. [Sources and verification](#15-sources-and-verification)
16. [Documents that this change makes stale](#16-documents-that-this-change-makes-stale)

## 1. Context and evidence

Experiment C tested prompt-first generation with pose control from the mannequin (stage S4 of [the architecture](../ARCHITECTURE.md)).

| Run                             | Result (from the reports)                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [C1](C1_GEOMETRY_EVALUATION.md) | OpenPose kept the 2D joint positions. The torso was frontal, not turned 3/4. The text-only baseline was turned 3/4.                                                                                                                  |
| [C2](C2_FAILURE_ANALYSIS.md)    | Six images. Orientation gate: condition A (OpenPose) 0 of 3, condition B (OpenPose + depth) 0 of 3. Detached hands: A 3 of 3 images, B 1 of 3 images, by verified file identity. An earlier classification had the opposite numbers. |
| C2 source analysis (verified)   | The ComfyUI 0.35.0 core chain of two ControlNet applications is two summed single-condition passes. It is not the trained multi-condition fusion of the xinsir model.                                                                |
| C2 causes                       | Not proven. The cause of the detached hands and the effect of line control or img2img are hypotheses (H1 to H6 of the C2 report).                                                                                                    |

**Label note.** The C2 report uses "direction A" (native union fusion) and "direction B" (template path). The owner strategy labels are different: **A** = style reference image, **B** = style LoRA, **D** = template-driven generation. This document uses only the owner labels A, B and D. Direction B of the C2 report is the first step of D.

What the evidence shows: 2D pose control holds joint positions, but not the 3D turn of the body. What it does not show: that any other control works. The template-first direction is a reasoned hypothesis, not a measured result.

## 2. Owner direction and status

The owner gave these directions in the T0 task. The table maps each one to its status in this repository.

| #   | Owner direction                                                                   | Status in this document                                                                                                                                     |
| --- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | Main direction D: generation from an approved geometry template bound to the rig. | **Accepted intent** (strategic). Proposed open decision D27 holds the details.                                                                              |
| O2  | Style reference (A) is the main candidate for art consistency.                    | **Accepted intent** as a candidate. It needs new weights and a custom node or a new adapter (see [R3](#r3-style-reference-needs-new-execution-components)). |
| O3  | Style LoRA (B) is a later pluggable strategy.                                     | **Accepted intent.** The binding format reserves it. No training now.                                                                                       |
| O4  | Declarative switching of models and art profiles without source changes.          | **Accepted intent** with a limit (see [R4](#r4-declarative-switching-is-not-unreviewed-switching)).                                                         |
| O5  | One style for all characters, different personality and appearance.               | **Accepted intent.** Style and identity are separate records.                                                                                               |
| O6  | Later: variants of one character (clothes, hair, details).                        | **Accepted intent.** Planned (V1). Conflict with D23 and D25 boundaries (see [R5](#r5-outfit-variants-cross-module-and-equipment-boundaries)).              |
| O7  | Different specialized models at different stages are permitted.                   | **Accepted intent.** Each model still needs registry approval (D9).                                                                                         |
| O8  | Keep one shared Spine skeleton and animation set, PNG parts + `character.json`.   | **Accepted** (existing owner requirements).                                                                                                                 |
| O9  | Keep `@aigg/control`, `@aigg/rig-runtime`, checks, masks, provenance, bundles.    | **Accepted.** The plan adds narrow parts to them.                                                                                                           |
| O10 | C0.5 is not an approved production rig.                                           | **Accepted** (owner decision on C0.5). Templates from C0.5 have the status `prototype`.                                                                     |

Proposed decision (D27, open until the owner closes it): the production-art stage changes from "prompt with pose control" to "template-guided design, then deterministic partition into rig parts, then targeted completion of hidden areas". Prompt-only generation stays for concept exploration and as a comparison baseline.

## 3. Critical review: conflicts and weak points

The owner asked for a critical check. Each item states the problem, its evidence, and a proposed alternative. No item changes a decision.

### R1. No master rig matches the template view

- **Problem.** A template must come from the master rig. The only real Spine export, the L1 test rig `humanoid_girl_v1` 0.2.0, has near/far joints in the wrong lateral order for a front-visible 3/4 view (C0.5 F1 analysis: near shoulder and near hip on the image right). The C0.5 candidate fixes the order only in a contract file. No Spine project has this geometry.
- **Effect.** Parts cut from a C0.5 template do not fit the L1 skeleton setup pose. The animations of the L1 rig were keyed for L1 geometry. Some C0.5 key poses look doubtful (owner remark on C0.5).
- **Alternative.** Treat "template bound to the rig" as a chain of three owner steps: decide the view (D17), make a new master rig version with the corrected setup pose and checked animations (proposed D32), then register the production template from that export. Until then every template is `prototype`, and a job with a prototype template cannot have purpose `production` (a resolver rule, see [section 6](#6-model-capability-negotiation), step 7).

### R2. A whole-character image has no pixels for hidden areas

- **Problem.** The C2 report said that a template makes the Spine layers fit "by construction". This is true for geometry (rectangles, pivots, masks). It is not true for pixels. Rigid region attachments rotate around their pivots. The animations then show areas that the reference image hides: the far arm behind the torso, the top of the forearm under the upper arm, the thighs under a skirt, the neck under the head, hair behind the head.
- **Alternative.** The template computes, for each part, a **coverage mask**: the part pixels that become visible in at least one sampled pose of the shared animation set, plus the joint overlaps. The difference between the coverage mask and the reference visible mask is the area that a person or a model must paint. Section 8 describes it. This turns "hidden areas" into a measured quantity for each part and each rig version.

### R3. Style reference needs new execution components

- **Verified.** The ComfyUI 0.35.0 core node list has no IP-Adapter node. It has `CLIPVisionEncode` and `StyleModelApply` (style model files, not IP-Adapter).
- **Verified.** The SDXL IP-Adapter weights are in `h94/IP-Adapter` (model card license tag `apache-2.0`). The base SDXL adapter uses the OpenCLIP ViT-bigG-14 image encoder (1844.9 M parameters). The Plus variants use OpenCLIP ViT-H-14. The model card lists `.bin` files. The diffusers guide loads `.safetensors` names for the Plus variants. The file list was not checked.
- **Effect.** Strategy A needs: a custom node (a human decision under AGENTS.md) or a separate diffusers process behind a new adapter (a human decision), an adapter weight file and an image encoder file (registry approvals, D9), and possibly pickle-based `.bin` files (forbidden without a human decision). The image encoder license must be checked separately from the adapter license.
- **Alternative.** Keep A as the main candidate, but put the cheapest measurement first: a prompt-only binding with a fixed style vocabulary on the approved checkpoint (`none` baseline). Animagine XL 4.0 already has a strong anime style. If three different characters already look consistent enough, A is not needed for v1. If not, A goes to the S1 style proof with the components above. This orders the work by cost. It does not remove A.

### R4. Declarative switching is not unreviewed switching

- **Problem.** "Switch models without source changes" can collide with the security rules. A ComfyUI workflow graph names node classes and model files. A new model family (for example from SDXL to a different architecture) usually needs a different graph, other node classes, and a new style check. Graph JSON is executable configuration.
- **Alternative.** Switching is declarative **among reviewed, registered records**: a job selects a style binding, a model profile and a workflow template by id and revision. Adding a record is a reviewed data change (registry approval for models). Adding a new model family or node class is a reviewed change of workflow templates and possibly adapter code. The pipeline never loads a graph from a user file or from a model card.

### R5. Outfit variants cross module and equipment boundaries

- **Problem.** An outfit change in the 3/4 cutout touches the torso, both arms (sleeves on each segment) and the legs (trousers, boots). Under the proposed D23 groups these are four modules. Under D25, removable clothes and armor are **equipment**, not appearance. So "a new outfit of the same character" has no single owner in the current model.
- **Alternative.** Proposed open decision D29: in v1, clothing that is drawn on the body is appearance, and an outfit variant is a new character identity revision with `variantOf`, which produces a complete new package (all modules). Equipment (D25) stays for removable items in v2+. This needs no module change now and keeps the D23 atomic multi-part rule.

### R6. Shared base body (D7) and "different appearance"

- **Problem.** The current architecture proposes one shared painted base body (D7, open). The owner now wants visibly different characters. A shared painted body makes all characters the same under their clothes, and template-guided generation paints skin and clothes together.
- **Alternative.** The template shares **geometry** (pivots, rectangles, joint overlaps, coverage masks), not pixels. D7 gets a new option: "shared template geometry, skin painted per character". Body archetypes are template variants inside the contract tolerances. The schema keeps `variants` empty until the owner decides.

### R7. Per-part fields in `character.json`

- **Verified.** [The package format](../CHARACTER_PACKAGE.md) documents per-part SHA-256 and `origin`. `parseCharacter` in `@aigg/rig-runtime` accepts only `status` and `file` in a part and rejects other fields with `E_CHARACTER_FORMAT`.
- **Effect.** Template-first provenance for each part cannot go into the part entries now.
- **Alternative.** Put part hashes and part origins in `provenance/generation.json` (the build record), keyed by slot. Do not change `character.json` in this direction. Fix the documentation drift in a separate PR (or change the parser, with a version step and the owner's agreement).

### R8. Approved models have an experiment scope

- **Fact.** The two approved files are approved for experiment C only. Template-guided generation (T3) and part completion are new stages.
- **Alternative.** The owner states for T3 whether "experiment C" covers template line control and masked img2img with the same files, or extends the scope. The model profile has `approval.scopes`, and a job is rejected if its purpose scope is not in that list.

### R9. Mirroring and asymmetric identities

- **Problem.** One view with `scaleX` mirroring moves an asymmetric trait (a scar, a hair clip) to the other side when the character faces left. D12 is open. An identity check that compares traits can then fail on mirrored previews.
- **Alternative.** The identity record has an `asymmetry` block. The identity gate compares unmirrored images only. The preview marks mirrored frames.

### R10. Animation list

- **Fact.** The owner list has 6 animations. The L1 export has 9 (`jump` split, `crouch_enter`), D5 is open.
- **Alternative.** The template stress test reads the animation list from the Spine export of the rig, never from a fixed list. The coverage masks then follow D5 automatically.

### R11. Style LoRA on factory output

- **Risk.** A later style LoRA trained on approved factory output can amplify the defects of that output and the identity of the few characters in the set (feedback). Training rights must exist for every image.
- **Alternative.** The style reference set requires `permittedUses: lora_training` per image, at least three different depicted characters, and an evaluation on identities outside the training set. This is a gate for L1 (LoRA) in section 13.

## 4. Architecture

### 4.1 Four separate concerns

| Concern           | Owner of the data                                                         | Who can change it                                 | Never decided by a model                     |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------- |
| Geometry          | Spine master rig, rig contract, template profile derived from both        | The owner, through a new rig or template revision | Bones, slots, draw order, pivots, rectangles |
| Style             | Style profile (model-neutral), style bindings (model-specific)            | The owner promotes revisions                      | The style revision used by a job             |
| Identity          | Character identity record                                                 | The owner approves the concept and each revision  | Which person a new job depicts               |
| Appearance module | Module manifests on the shared rig (D23 accepted principles, groups open) | Package build, owner approval                     | Slot membership of a group                   |

Equipment (D25) stays a separate future concern. It is not in this architecture.

### 4.2 Components

| Component               | Kind                           | Responsibility                                                                                          | Status                                     |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Rig registration        | Data + existing code           | Rig contract, Spine export, `rig.generated.json` check                                                  | Partly implemented (`@aigg/rig-runtime`)   |
| Template builder        | Node.js code (`@aigg/control`) | Derive the template profile, masks, line art, coverage masks, previews from the rig                     | Planned (T1)                               |
| Record registry         | JSON data files                | Template, style, binding, identity, model profile, workflow template records with revisions and digests | Planned (P2)                               |
| Resolver and planner    | Pure Node.js code              | Resolve aliases, pin digests, negotiate capabilities, write a resolved job and a stage plan             | Planned (P3)                               |
| Generator adapters      | Node.js code                   | `mock` for tests, `comfyui` through the existing bundle pattern                                         | Bundle exists for experiment C only        |
| Evidence ingest         | Node.js code                   | Read returned bundle results, check hashes, write the build record                                      | Pattern exists (`runner status`)           |
| Partition               | Node.js code                   | Cut the approved design into part images with template masks                                            | Planned (T4)                               |
| Part completion         | External model through adapter | Fill the coverage-minus-visible area of each part                                                       | Planned, method open (D31)                 |
| Human cleanup           | Image editor + PSD exchange    | Layer cleanup, seam repair                                                                              | Planned (D4, D13 open)                     |
| Assembly and validation | Node.js code                   | Write `parts/*.png`, `character.json`, pixel checks, rig-runtime checks                                 | Partly implemented                         |
| Preview                 | spine-core + browser           | All animations, both facings, contact sheet                                                             | Partly implemented (test bench, D26 spike) |
| Review records          | JSON data                      | Human gate decisions, cleanup time, defects                                                             | Planned                                    |

### 4.3 Data flow

```text
Spine master rig ──export──> skeleton.json ─┐
rig.contract.json ──────────────────────────┼─> [template builder] ─> TemplateProfile (+ masks, line art, coverage masks)
                                            │                               │  human: template approval
StyleProfile ──> StyleBinding (per model family)                            │
CharacterIdentity (text, approved references)                               │
ModelProfile registry (from MODEL_LICENSES.md)                              │
                │                                                           │
                └──────────> GenerationJob ──[resolver: pin + capability check, no fallback]──> ResolvedJob + plan
                                                    │
                     [adapter: mock | comfyui bundle, owner runs it] ──> design image(s) + provenance
                                                    │  human: concept / design selection
                     [partition by template masks] ──> raw part images
                     [part completion, coverage minus visible] ──> complete part images
                                                    │  human: layer cleanup (PSD derived)
                     [assembly] ──> parts/*.png + character.json (canonical) + provenance/generation.json
                     [validation] ──> rig-runtime checks + pixel checks + coverage checks
                     [preview] ──> all shared animations, normal and mirrored
                                                    │  human: final approval
                                                 package
```

### 4.4 Stage mapping

| Current stage (ARCHITECTURE.md) | New stage                               | Change                                                                                    |
| ------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------- |
| S0 Rig contract                 | S0 Rig and template registration        | Adds the template profile derived from the rig. Human approves the template.              |
| S1 Specification                | S1 Character specification              | Writes a character identity record. Style is selected, not written into the identity.     |
| S2 Concepts, S3 selection       | S2 Concept exploration (optional)       | Unchanged in principle. Concepts are never part sources by default.                       |
| S4 Production art (pose)        | S3 Template-guided production design    | Line art or img2img from the template replaces OpenPose as the main control (to measure). |
| S5 Decomposition, S6 fill       | S4 Partition and part completion        | Deterministic masks from the template. Model only for the hidden areas. See section 8.    |
| S7 Assembly, S8 cleanup         | S4 (cleanup) and S5 Assembly            | Unchanged. Pivots and rectangles come from the rig.                                       |
| S9 Validation                   | S5 Validation                           | Adds coverage checks from the template.                                                   |
| S10 Packing, S11 Preview        | S6 Preview and QA                       | Unchanged. All animations, both facings.                                                  |
| S12 Final approval              | S7 Canonical package and final approval | Unchanged. No `spine-ready` label before a real runtime check.                            |

## 5. Data contracts

**Proposed. Nonauthoritative.** JSON Schemas: [`t0/schemas/`](t0/schemas/). Examples: [`t0/examples/`](t0/examples/). Section 15 states how the examples were validated.

### 5.1 Common rules

- Every record has an `id` (`snake_case`), an integer `revision`, and a `status` (`draft`, `prototype`, `candidate`, `approved`, `retired`).
- A revision is immutable after any job used it. A change makes a new revision.
- A reference to a record is `{ id, revision, digest }`. The digest is the SHA-256 of the canonical JSON of the record: keys sorted at every level, no whitespace, UTF-8. Formatting does not change it.
- Capabilities come from one closed list in `common.schema.json`. A profile cannot invent a capability.
- Every input image has a `rights` block (source, rights holder, license, permitted uses, who checked). A missing or doubtful entry blocks its use.
- Content rules are constants in the schemas (`adult: true`, `explicitContent: false`). A profile cannot weaken them.

### 5.2 Records

| Record            | Schema id                     | Main content                                                                                                                                                                                  | Must not contain                                    |
| ----------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| TemplateProfile   | `aigg.template-profile/0.1`   | Rig binding (contract SHA-256, Spine export fingerprint or `null` for prototypes), view, canvas, derivation inputs, orientation, image assets, anchors, parts with visible and coverage masks | New bones, slots, pivots, draw order                |
| StyleProfile      | `aigg.style-profile/0.1`      | Art rules, palette, content rules, style references of different characters with rights, accepted and rejected examples                                                                       | Model files, strengths, LoRA, identity              |
| StyleBinding      | `aigg.style-binding/0.1`      | Style reference, base family, components (`prompt_only`, `reference_image`, `lora`), required capabilities, use cases, evaluations                                                            | A second style, an identity image                   |
| CharacterIdentity | `aigg.character-identity/0.1` | Adult flag, description, traits with `locked`, asymmetry, identity references with rights, approved concept, `variantOf`, `relatedTo`                                                         | Style rules, model data, part images                |
| ModelProfile      | `aigg.model-profile/0.1`      | Exact file (name, SHA-256, size, `safetensors`, repository, commit), license, approval status and scopes, capabilities, compatibility, providers                                              | Approval that is not in `MODEL_LICENSES.md`         |
| GenerationJob     | `aigg.generation-job/0.1`     | Purpose and scope, pinned rig, template, style, binding, identity, one model for each role, resolved aliases, policy (`fallback: forbidden`), stages, output                                  | Mutable channel names without their resolved record |

The build record (`provenance/generation.json`) is the result side of a job. It adds: resolved job digest, provider-native workflow and its SHA-256, tool versions, seeds, output hashes for each stage, part hashes and origins keyed by slot, human gate records, cleanup time, and cost. Its schema is planned for P3.

### 5.3 Example build manifest

[`generation-job.example.json`](t0/examples/generation-job.example.json) is one complete build manifest for the test identity `example_ranger` on the C0.5 prototype template, with the prompt-only binding and the two approved models. It has purpose `experiment`, scope `experiment_c`, `skeletonSha256: null` (prototype), and nine stages with four human gates.
Its record digests are the real canonical digests of the other example files. Its image hashes that start with `dddd` are dummy values.

### 5.4 Relation to existing formats

| Existing format                 | Relation                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `rig.contract.json`             | Read only. The template copies slot, bone, draw order and rectangles for checks, and the builder rejects a difference.           |
| `character.json`                | Unchanged. A job writes it at assembly. Template, style and identity references go into the build record, not into part entries. |
| `aigg.part-module/0.1`          | Unchanged. Module manifests are made from the package after assembly, when D23 is decided.                                       |
| `aigg.exp-c-bundle/0.2`         | The pattern of the `comfyui` adapter: the agent prepares, the owner runs, the agent analyzes.                                    |
| `aigg.pose-marks/0.1`, overlays | Reused for the geometry gate of template-guided images.                                                                          |

## 6. Model capability negotiation

The resolver runs offline, before any download, upload or paid request. It is pure code. It writes one JSON report.

1. Resolve each alias (for example style channel `production`) to `{ id, revision, digest }`. Write the result into `aliases[].resolvedTo`.
2. Read each referenced record. Compare its canonical digest with the reference. A difference stops the job (`E_DIGEST_MISMATCH`).
3. For each model: the file SHA-256 in the job equals the model profile. The approval status is `approved`. The job scope is in `approval.scopes`. The record agrees with `MODEL_LICENSES.md`.
4. For each stage: the required capabilities are the stage `requires`, plus the binding `requires` for generating stages, plus each conditioning capability. The union of the capabilities of the job models for that stage must contain all of them.
5. Check compatibility: the base family of the checkpoint is in the binding base family and in the `baseFamilies` of each adapter. Each `requiresModels` entry is a model of the job.
6. Check the workflow template: its SHA-256 is registered, its node classes are in the reviewed list, and its inputs cover the conditioning.
7. Check the rig binding: a `prototype` template or a `null` skeleton fingerprint forbids purpose `production`.

Any failure stops the job with a list of problems (for example `E_CAPABILITY_MISSING`, `E_SCOPE_NOT_APPROVED`, `E_FAMILY_MISMATCH`, `E_MODEL_NOT_APPROVED`). There is **no fallback**: the resolver never selects another model, binding, node, endpoint or a weaker path. A person writes a new job to try something else. This keeps every result traceable to one decision.

Example: a job that uses a `reference_image` binding with only the two approved files fails at step 4 with `E_CAPABILITY_MISSING: style_reference` and at step 5 with a missing image encoder. Nothing is downloaded.

## 7. Versions and switching of art profiles

| Mechanism        | Rule                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revision         | Immutable after use. A new revision for each change.                                                                                                  |
| Channel (alias)  | `test`, `production`, `experimental`, `other` point to one revision of a template, style or binding. Only the owner moves a channel.                  |
| Job pinning      | A job stores the pinned revision and digest, and the channel that the person used. A later channel move does not change the job or its package.       |
| Style vs binding | A style revision can have bindings for several model families. A model family change needs a new binding and a new style evaluation, not a new style. |
| Re-render        | A package keeps the style revision that made it. A new style revision does not change approved packages. Re-rendering a character is a new job.       |
| Retirement       | `retired` records stay readable for audit. New jobs cannot use them.                                                                                  |
| Storage          | Channel files and records are small JSON files in Git. Reference images and outputs are binary data and wait for D15.                                 |

## 8. Spine layers, hidden areas and overlaps

### 8.1 What the template defines for each part

| Data                 | Source                                     | Use                                                                    |
| -------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| Slot, bone, pivot    | Rig export and contract                    | Placement. Never from model output.                                    |
| Attachment rectangle | Contract                                   | The part must stay inside it.                                          |
| Visible mask         | Template, reference pose, draw order       | Which pixels the design image gives directly.                          |
| Coverage mask        | Template + animation stress test (see 8.2) | Which pixels must be painted so that no gap shows in any sampled pose. |
| Joint overlaps       | Contract (`overlap`, radius)               | Pixels around child pivots that continue the same part.                |
| Hidden area          | Coverage minus visible                     | The area for part completion or manual painting.                       |

### 8.2 Coverage masks (proposed method)

1. Sample each animation of the rig export at its keys and at fixed steps, both facings.
2. For each sample, pose the template part shapes with forward kinematics. Draw them in the rig draw order.
3. For each part, map the visible pixels back into the part setup-pose space.
4. The union over all samples, plus the joint overlap circles, is the coverage mask.

T1 uses the approximate forward kinematics of `@aigg/control` (rotate and translate, linear keys) on the C0.5 prototype. This is an **estimate**. T2 repeats it with spine-core on the real export. The masks are a lower bound for the area to paint: a part shape that differs from the template (for example a wide sleeve) needs a margin. The margin value is an owner decision, not part of the template.

### 8.3 Two production-art paths

| Aspect                    | W: whole design, then partition                                                 | P: rig-part-first painting                                                  |
| ------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Art quality               | One coherent image: light, line weight, palette agree across parts              | Each part made alone. Risk of different light and line weight between parts |
| Identity and style        | Easier to judge and approve on one image                                        | Hard to judge until assembly                                                |
| Hidden areas              | Must be completed for each part (coverage minus visible)                        | Painted with the part                                                       |
| Seams                     | Partition edges follow template masks. Seams at joints need overlap completion. | Seams between separately made parts are likely                              |
| Control                   | Template controls the whole figure, one geometry check                          | Mask controls each part. Small parts give the model little context          |
| Human cleanup             | Concentrated at joints and completed areas                                      | Spread over all parts                                                       |
| Testability               | Geometry gate on one image, coverage gate on parts                              | Coverage gate on parts. No whole-figure gate before assembly                |
| Model calls per character | 1 design + 1 completion per part with a hidden area                             | 1 per part (27 slots in contract 0.2)                                       |

**Recommendation (proposed, not a winner).** Pilot W with targeted completion: approve one whole design, cut it with template masks, and complete only the hidden area of each part. Use P only for parts with a very small visible area (for example the far hand), where completion is effectively painting. Measure both in T3 on one character before any decision (D31).

### 8.4 Cutout rules that the validator must check (planned)

- Each part is one RGBA image, sRGB, straight alpha, inside its attachment rectangle.
- Opaque pixels cover the coverage mask of the part (with a tolerance from the contract, not invented here).
- No background, no cast shadow, no stray alpha islands.
- Clothing is cut at the joint lines of the contract (sleeves for each arm segment, trousers for each leg segment).
- Hair front and back go to their slots. A seam review is a human gate.
- Region sprites do not guarantee invisible seams. Only the animation preview in extreme poses shows them.

## 9. Compatibility map

| Existing item                     | Compatible?    | Notes and required human decisions                                                                                                                                                                                                           |
| --------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rig contract 0.2 (L1 test rig)    | Yes, read only | Wrong lateral order for the template view (R1). Production templates wait for D17 and a new master rig version (D32).                                                                                                                        |
| C0.5 candidate contract 0.3.0     | Prototype only | Owner: preliminary reference for experiment C. Not a production rig.                                                                                                                                                                         |
| `character.json`                  | Yes            | No new part fields (R7). Provenance goes to the build record.                                                                                                                                                                                |
| `@aigg/rig-runtime`               | Yes            | Runtime skins from `character.json`, D22 absent parts, profile check (rigid region attachments only) stay the gate.                                                                                                                          |
| `@aigg/control`                   | Yes            | T1 adds one command (`template`). Existing commands, fixtures and bundles do not change.                                                                                                                                                     |
| D22 absent parts                  | Yes            | An optional part that a design does not have is `absent_by_design`. Its coverage mask is not required.                                                                                                                                       |
| D23 modules (principles accepted) | Yes            | Templates work on slots. Groups are applied after assembly. Proposed groups and migration stay open.                                                                                                                                         |
| D25 equipment (intent)            | Yes            | Weapons and removable items are not drawn into the design (style rule `dont`). Outfit variants: D29.                                                                                                                                         |
| D26 animated parts (intent)       | Partly         | Face slots for blinking do not exist yet. A template for them needs a new rig version. Not in T0–T3.                                                                                                                                         |
| Spine Essential                   | Yes            | Region attachments, bones, slots, rigid layers. **Verified:** Essential cannot save or export projects with Professional features such as meshes or IK. Skin bones are not in Essential. Runtime skins combine attachments by slot and name. |
| Spine CLI, PSD import             | Unknown        | The documentation pages do not state the edition. **Assumption.** Verify on the installed editor before automation. CLI image or video export needs a windowing system and OpenGL.                                                           |

## 10. Implemented and planned

| Capability                                                     | State                                     |
| -------------------------------------------------------------- | ----------------------------------------- |
| Shared skeleton, runtime skins, D22 absent parts, atlas checks | Implemented (`@aigg/rig-runtime`)         |
| Part modules, atomic change, atlas cache                       | Implemented as draft (D23 open)           |
| Control images, overlays, pose marks, C0.5 candidate, depth    | Implemented (`@aigg/control`)             |
| Execution bundle, runner, evidence check                       | Implemented for experiment C only         |
| Template profile, masks, line art, coverage masks              | Planned (T1)                              |
| Records: style, binding, identity, model profile, job          | Proposed (this document), not implemented |
| Resolver, capability negotiation, no-fallback policy           | Planned (P3)                              |
| Partition, part completion, coverage validation                | Planned (T4, D31)                         |
| Style reference strategy (A)                                   | Planned (S1), needs approvals (R3)        |
| Style LoRA (B), second backend                                 | Planned later (L1), no work now           |
| Identity variants, related characters                          | Planned (V1), D29 open                    |

## 11. Decisions and dependencies

### 11.1 Existing open decisions

| Id  | Effect on template-first                                                                                    | Blocks          |
| --- | ----------------------------------------------------------------------------------------------------------- | --------------- |
| D2  | Essential is enough for rigid layers. IK needs Professional (verified). Keep the template free of IK.       | Nothing now     |
| D5  | The coverage masks follow the animation list of the export.                                                 | T2 final masks  |
| D7  | New option: shared template geometry, skin painted per character (R6).                                      | T4              |
| D9  | Every new file (adapter, encoder, inpaint model, LoRA) needs approval. Scope rules (R8).                    | T3, S1, L1      |
| D12 | Asymmetric identities and mirrored previews (R9).                                                           | V1              |
| D14 | Reproducibility = parameters, files and hashes. The build record follows it.                                | Nothing         |
| D15 | Reference images, outputs and edited templates need storage. Derived templates can be made again from code. | S1, T3 storage  |
| D16 | Full canvas or cropped parts. The coverage masks work in both.                                              | T4              |
| D17 | The view of all templates. **Prerequisite** of every production template.                                   | T2, production  |
| D19 | GPU host. Owner runs bundles.                                                                               | T3              |
| D20 | Content rules are constants in the schemas.                                                                 | Nothing         |
| D23 | Group table for modules made after assembly.                                                                | V1              |
| D24 | Atlas budget for many characters.                                                                           | Scale           |
| D25 | Clothing vs equipment boundary (R5).                                                                        | V1              |
| D26 | Face slots for blinking need a new rig version.                                                             | Later templates |

### 11.2 Proposed new open decisions

These are added to [the decision log](../DECISIONS.md) with the status **Open**. Only the owner closes them.

| Id  | Decision                                    | Options                                                                                       | Recommendation                                                         |
| --- | ------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| D27 | Production-art strategy                     | Template-first (D) / prompt with pose control / hybrid                                        | Template-first, details after T1–T3. Strategic intent is the owner's.  |
| D28 | Style application strategy and lifecycle    | Prompt-only baseline / reference image (A) / LoRA (B), channels and revisions as in section 7 | Measure the baseline first, then A in S1. B later.                     |
| D29 | Outfit variants                             | New identity revision and full package / cross-module outfit sets / equipment (D25)           | New identity revision with `variantOf` in v1                           |
| D30 | Machine-readable model registry             | JSON records checked against `MODEL_LICENSES.md` / JSON as the only source / Markdown only    | JSON records with a consistency check, Markdown stays the human source |
| D31 | Layer authoring path                        | W (whole design, partition, completion) / P (part-first) / mixed                              | Pilot W with targeted completion, P for tiny parts, decide after T3    |
| D32 | Master rig version for production templates | Migrate the setup pose to the D17 view and review animations / keep L1 geometry               | Migrate after D17, with an owner Spine session and an animation review |

### 11.3 Owner approval points in the plan

Template approval (T1 review sheet), master rig migration (T2), GPU spend and model scope (T3), new weights and custom nodes (S1), style promotion to `production` (S1), identity approval and final package approval (every character), LoRA training rights and cost (L1).

## 12. Long-term risks

| Risk                   | Failure chain                                                                      | Mitigation in this design                                                                               | Residual risk                                       |
| ---------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Model dependency       | A model or node is removed or changes license → old jobs cannot run again          | Exact file hashes, pinned commits, approval scopes, workflow template hashes                            | Weights that are deleted upstream cannot be fetched |
| Style change           | New style revision → old and new characters look different in one game             | Packages keep their style revision. Re-render is an explicit job. Style gate on a mixed set.            | Re-render cost grows with the character count       |
| Model family change    | New family → bindings and workflows do not transfer                                | Style is model-neutral. A new binding and a new style evaluation are required.                          | The look can drift even with the same rules         |
| Rig migration          | New rig version → templates, coverage masks and all packages need checks or rework | Templates and packages pin the rig fingerprint. A rig change makes new template revisions.              | Old packages may need manual repainting             |
| Template sameness      | Strong line control → all characters have the same body and pose look              | Line control only for the body, looser control for hair and clothes. Diversity check in the style gate. | Not measured yet                                    |
| Hidden-area quality    | Completion paints wrong content behind occlusions → visible defects in animation   | Coverage masks, preview in extreme poses, human cleanup gate                                            | Main cost driver. Not measured yet                  |
| Licenses               | Reference images or LoRA data without rights → package cannot ship                 | `rights` block required, `permittedUses`, human check                                                   | Legal review is not done                            |
| Security               | Custom nodes, pickle files or user graphs run code on the GPU host                 | Reviewed workflow templates only, `safetensors` only, no user graph, owner runs bundles                 | The GPU host image itself is trusted                |
| Cost                   | More stages and more attempts per character                                        | `maxAttemptsPerStage`, no auto loop, cost in the build record                                           | Budgets are not set                                 |
| Quality measurement    | Visual judgments by one assessor                                                   | Blind review where feasible, recorded human judgments, metrics only for triage                          | Style and identity similarity stay judgments        |
| Character count growth | Many characters → atlas memory, review time, registry size                         | D24 cache, small JSON records, per-character packages                                                   | Review time scales with characters                  |
| Reproducibility        | GPU differences → different pixels                                                 | D14 definition: same parameters, files and hashes                                                       | Pixel-exact repeats are not promised                |

## 13. Delivery plan

Each PR is small and independent. No PR runs a model, buys a tool, or downloads weights unless the owner approves that step.

| PR  | Scope                                                                                                                          | Depends on                 | Acceptance criteria                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| T0  | This ADR, proposed schemas, examples, decision log rows                                                                        | —                          | Owner audit. No code or contract change. Examples validate.                                                   |
| T1  | `aigg-control template` on the C0.5 prototype: line art, region map, masks, coverage estimate, review sheet, mock part package | T0 review                  | Section 14                                                                                                    |
| P1  | Fix the documentation drift of `character.json` part fields (R7)                                                               | Owner choice               | `CHARACTER_PACKAGE.md` and `parseCharacter` agree. Tests unchanged or extended.                               |
| P2  | Record schemas in a package (`contract` or `control`), with runtime validation and tests                                       | T0 approval of formats     | Each schema has positive and negative tests. Digest function has property tests.                              |
| P3  | Resolver: alias pinning, digest check, capability negotiation, mock adapter, build record schema                               | P2                         | Every failure code has a test. No network access in the code path. Dry run is the default.                    |
| T2  | Master rig and template on a real export: spine-core coverage masks, one hand-made part set, all animations                    | D17, D32, owner Spine work | Real runtime preview of all animations in both facings. If the editor is not available, INCOMPLETE.           |
| T3  | GPU comparison: template line control and/or img2img against pose-only, one variable at a time                                 | T1, owner GPU approval, R8 | Bundle as in experiment C. Geometry gate, artifact counts, cleanup estimate. No claim before the measurement. |
| T4  | Partition and coverage validation on T3 output, completion experiment                                                          | T3, D31 pilot choice       | Parts pass coverage and alpha checks or a clear report of the gaps. Cleanup time recorded.                    |
| S1  | Style profile proof: baseline against reference image on three different characters                                            | T3, D28, approvals of R3   | Style gate and clone check by a human, blind where feasible.                                                  |
| V1  | Identity variants                                                                                                              | S1, D29, D23               | Identity gate on one variant.                                                                                 |
| L1  | Optional style LoRA, optional second backend                                                                                   | S1, training rights, cost  | Evaluation on identities outside the training set. Capability rejection tests.                                |

## 14. T1 specification

**Proposed scope for the next PR, after the owner reviews T0.** Offline only. No GPU, no model, no network, no change of the master rig, the contracts, or existing fixtures.

### 14.1 Inputs

- `packages/control/test/fixtures/c05-candidate/rig.contract.json` (SHA-256 `17e73069…675e`) as a **prototype** fixture.
- `referenceBody` in `packages/control/src/mannequin.ts`.
- The L1 test export `packages/rig-runtime/test/fixtures/l1-owner/editor-out/skeleton.json` only for the animation list and key values (approximate FK). The template states that its geometry does not match this export (R1).

### 14.2 Deliverables

| #   | Deliverable                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | New command `aigg-control template --contract <file> [--skeleton <file>] --out <dir> [--size WxH] [--dry-run] [--force]`.                                                                                        |
| 2   | `template-profile.json` in format `aigg.template-profile/0.1` with status `prototype`, `spineExport: null`, and a draft schema in the package.                                                                   |
| 3   | `contour-lineart.png`: 3/4 contour line art of the reference body at the generation size (black lines on white, no fill). Visible turn: shoulder and hip lines, foreshortened far side, feet to the image right. |
| 4   | `region-map.png` and one visible mask for each slot (`masks/<slot>.visible.png`).                                                                                                                                |
| 5   | `masks/<slot>.coverage.png`: coverage estimate from all animations of the given export, both facings, with approximate FK.                                                                                       |
| 6   | `overlay-sheet.png`: line art, region map, joints and pivots, attachment rectangles, joint overlap circles, near/far order, a top view of the yaw.                                                               |
| 7   | `visibility-sheet.png`: for each part, visible mask, coverage mask, and the hidden area in a third color.                                                                                                        |
| 8   | `mock-package/`: a flat-color RGBA part for each required slot, cut from the region map and extended to its coverage mask, with `character.json` that `parseCharacter` accepts.                                  |
| 9   | `review.md` for the owner: what to check, and the explicit list of items that must change or be checked on a real master rig.                                                                                    |
| 10  | README and SECURITY sections for the command. Version step of `@aigg/control` (minor).                                                                                                                           |

### 14.3 Tests (Vitest, synthetic data, temporary directories)

| Id    | Test                                                                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| T1-01 | Determinism: two runs give byte-equal files and an equal profile digest.                                                                       |
| T1-02 | Exact ids: the slot, bone and draw order lists equal the contract. Unknown or missing slots fail.                                              |
| T1-03 | Each visible mask is inside the attachment rectangle of its slot. Each coverage mask contains the visible mask and the joint overlap circles.  |
| T1-04 | Near/far geometry: near shoulder and near hip are on the image left. The face direction and the feet point to the image right.                 |
| T1-05 | Alpha semantics: masks are binary. Mock parts are straight alpha, sRGB, RGBA 8 bit. No pixel outside the coverage mask.                        |
| T1-06 | Mock package: `parseCharacter` of `@aigg/rig-runtime` accepts it. Optional slots are `absent_by_design` (D22).                                 |
| T1-07 | No input change: the hashes of the contract, the skeleton and all fixtures are the same after the run.                                         |
| T1-08 | File safety: the output directory is not followed through a symbolic link. An existing output needs `--force`. `--dry-run` writes nothing.     |
| T1-09 | Rejection: a contract with another view or side naming stops with `E_VIEW_UNSUPPORTED`. A skeleton with mesh or IK data is reported, not used. |
| T1-10 | The profile validates against its schema and refuses status `approved` while `spineExport` is `null`.                                          |

### 14.4 Acceptance

- All tests pass. Format, lint, typecheck, build and `check:config` pass.
- The review sheet and `review.md` go to the project files, not to Git (D15). The PR contains code, the schema and tests only.
- A preview that looks correct is not a proof of animation compatibility. The report says this.
- The owner decides after T1 whether to start T2 (real master rig) or T3 (GPU comparison) first.

### 14.5 Not in T1

Any model run, any template image edited by hand, any change to `character.json`, the rig contract, the master rig, D-statuses, or existing package behaviour.

## 15. Sources and verification

| Claim                                                                 | Source                                                                                                      | Checked             |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------- |
| C1 and C2 numbers, F2 fusion finding                                  | [C1 report](C1_GEOMETRY_EVALUATION.md), [C2 report](C2_FAILURE_ANALYSIS.md)                                 | Read 2026-11-08     |
| No IP-Adapter node in ComfyUI 0.35.0 core                             | `nodes.py` of tag `v0.35.0` and its built-in extra node list, from the C2 evidence archive (`source-read/`) | Searched 2026-11-08 |
| L1 lateral order, C0.5 geometry                                       | [C0.5 report](C05_REFERENCE_MANNEQUIN.md), fixture files                                                    | Read 2026-11-08     |
| `parseCharacter` part fields                                          | `packages/rig-runtime/src/character.ts`                                                                     | Read 2026-11-08     |
| Essential cannot save or export projects with meshes or IK            | [Spine purchase page](https://esotericsoftware.com/spine-purchase)                                          | Fetched 2026-11-08  |
| Skin bones not in Essential, skin placeholders                        | [Spine skins](https://esotericsoftware.com/spine-skins)                                                     | Fetched 2026-11-08  |
| Runtime skin: map of slot and name, `addSkin`, one skin plus default  | [Spine runtime skins](https://esotericsoftware.com/spine-runtime-skins)                                     | Fetched 2026-11-08  |
| PSD import tags `[slot]`, `[skin]`, `[bone]`, edition not stated      | [Spine PSD import](https://esotericsoftware.com/spine-import-psd)                                           | Fetched 2026-11-08  |
| CLI commands, edition not stated, image export needs OpenGL           | [Spine CLI](https://esotericsoftware.com/spine-command-line-interface)                                      | Fetched 2026-11-08  |
| IP-Adapter encoders, style-only block scale, masks, multiple adapters | [Diffusers IP-Adapter guide](https://huggingface.co/docs/diffusers/en/using-diffusers/ip_adapter)           | Fetched 2026-11-08  |
| `h94/IP-Adapter` license tag `apache-2.0`, `.bin` file names          | [Model card](https://huggingface.co/h94/IP-Adapter). The Files tab was not read.                            | Fetched 2026-11-08  |

The Spine purchase page feature table lost its marks in the text extraction. Only the prose statements above are used.
The examples in `t0/examples/` were validated against the schemas with Ajv 8 (JSON Schema 2020-12, strict mode) and the record digests in the job example were recomputed. This was a local check, not a repository test.
LoRA claims in this document are design rules, not tool claims. No LoRA source was needed.

## 16. Documents that this change makes stale

These documents describe the prompt-first pipeline. This PR adds a pointer to this ADR in each of them. The full update waits for the owner decision on D27.

| Document                                                                                                | What becomes stale                                                            | Planned update after acceptance                            |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [ARCHITECTURE.md](../ARCHITECTURE.md)                                                                   | Stages S4–S6, principle 3 (shared base body), candidate tool table            | New stage table (section 4.4), template principle, records |
| [ROADMAP.md](../ROADMAP.md)                                                                             | Experiment C hypothesis (pose, depth, line from the mannequin), phase 5 and 6 | T1–T4, S1, V1, L1 phases                                   |
| [GLOSSARY.md](../GLOSSARY.md)                                                                           | Missing terms                                                                 | Terms added as proposals in this PR                        |
| [CHARACTER_PACKAGE.md](../CHARACTER_PACKAGE.md)                                                         | Per-part SHA-256 and `origin` (R7), `source/decomposed.psd`                   | P1                                                         |
| [WORKSPACES.md](../WORKSPACES.md)                                                                       | Planned `measure`, `assembler` purposes                                       | After P2 and T4                                            |
| [C0 report](C0_RIG_GUIDED_GENERATION.md), [C1](C1_GEOMETRY_EVALUATION.md), [C2](C2_FAILURE_ANALYSIS.md) | Nothing. They stay as evidence.                                               | None                                                       |
