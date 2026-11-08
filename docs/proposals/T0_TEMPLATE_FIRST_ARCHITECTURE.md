# T0: template-first character generation (architecture decision record)

**Proposed ADR. Draft.** This document aligns the architecture with the owner-approved three-phase product strategy (section 2). It proposes the pipeline, the data contracts, the acceptance framework and the delivery plan. The owner reviews it before any implementation.
This document changes no code, no rig contract, no master rig, no animation, no `character.json` format, no model registry entry, and no decision status.
The schemas and examples in [`t0/`](t0/README.md) are an **unapproved design**. No package reads them, and their implementation is deferred (section 9).

Status marks follow [the writing rules](../WRITING.md#status-marks): **Accepted**, **Proposed**, **Assumption**, **Verified**, **Open**. Section 18 lists the sources of each verified claim.

Revision history of this proposal: first version (template-first architecture), owner audit corrections (appearance variants, T1a/T1b split, gates, deferred schemas), and this revision (three-phase strategy and the independent audit findings F01–F14, see section 17). The independent audit report itself was not available to the author. This revision uses the finding list in the owner's task text.

## Contents

1. [Context and evidence](#1-context-and-evidence)
2. [Owner direction and status](#2-owner-direction-and-status)
3. [Product architecture: W → L → M and three phases](#3-product-architecture-w--l--m-and-three-phases)
4. [Phase 1 pipeline](#4-phase-1-pipeline)
5. [Rig-aware authoring in Phase 1](#5-rig-aware-authoring-in-phase-1)
6. [Critical review: conflicts and weak points](#6-critical-review-conflicts-and-weak-points)
7. [Acceptance framework](#7-acceptance-framework)
8. [Economics and effort](#8-economics-and-effort)
9. [Data contracts (unapproved, deferred)](#9-data-contracts-unapproved-deferred)
10. [Model selection without fallback](#10-model-selection-without-fallback)
11. [Spine: capabilities, coverage and motion QA](#11-spine-capabilities-coverage-and-motion-qa)
12. [Compatibility map](#12-compatibility-map)
13. [Implemented and planned](#13-implemented-and-planned)
14. [Decisions and dependency gates](#14-decisions-and-dependency-gates)
15. [Roadmap](#15-roadmap)
16. [T1a specification](#16-t1a-specification)
17. [Audit disposition](#17-audit-disposition)
18. [Sources and verification](#18-sources-and-verification)
19. [Long-term risks](#19-long-term-risks)
20. [Documentation drift](#20-documentation-drift)

## 1. Context and evidence

Experiment C tested prompt-first generation with pose control from the mannequin (stage S4 of [the architecture](../ARCHITECTURE.md)).

| Run                             | Result (from the reports)                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [C1](C1_GEOMETRY_EVALUATION.md) | OpenPose kept the 2D joint positions. The torso was frontal, not turned 3/4. The text-only baseline was turned 3/4.                                                                                                                  |
| [C2](C2_FAILURE_ANALYSIS.md)    | Six images. Orientation gate: condition A (OpenPose) 0 of 3, condition B (OpenPose + depth) 0 of 3. Detached hands: A 3 of 3 images, B 1 of 3 images, by verified file identity. An earlier classification had the opposite numbers. |
| C2 source analysis (verified)   | The ComfyUI 0.35.0 core chain of two ControlNet applications is two summed single-condition passes. It is not the trained multi-condition fusion of the xinsir model.                                                                |
| C2 causes                       | Not proven. The cause of the detached hands and the effect of line control or img2img are hypotheses (H1 to H6 of the C2 report).                                                                                                    |

**Label note.** The C2 report uses "direction A" (native union fusion) and "direction B" (template path). The owner strategy labels are different: **A** = style reference image, **B** = style LoRA, **D** = template-driven generation. This document uses only the owner labels. **W**, **L** and **M** are the representations of the three-phase strategy (section 3), not strategy labels.

What the evidence shows: 2D pose control holds joint positions, but not the 3D turn of the body. What it does not show: that any other control works. Template guidance is a reasoned hypothesis, not a measured result. No experiment in this repository has made a layered character from a generated image.

## 2. Owner direction and status

### 2.1 Three-phase product strategy (accepted by the owner)

The owner approved a three-phase product roadmap. It supersedes the sequencing of the earlier versions of this ADR.

| Phase | Name                 | Goal                                                                                                                                                                                 |
| ----- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | Art Generation MVP   | Consistent, editable, layered, modular 2D anime-style adult female characters from a text prompt, an image reference, or both. Output is good enough for manual Spine authoring.     |
| 2     | Spine Automation     | Automatic conversion of Phase 1 assets into characters on one approved shared skeleton with shared animations, skins and module composition, preview and validation in both facings. |
| 3     | Production Readiness | Reliability, automated QA, performance and atlas optimization, batch orchestration where justified, storage, lifecycle, cost, reproducibility, maintenance.                          |

Cross-cutting from the first day (not postponed to Phase 3): security, basic correctness, provenance, rights, content rules, and usable output quality.

The Phase 1 conceptual pipeline is `Input → W → human approval → L → M → editable asset package`. W, L and M are **sequential representations**, not competing architectures (section 3).

### 2.2 Earlier owner directions

| #   | Owner direction                                                                        | Status                                                                                                    |
| --- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| O1  | Main direction D: generation guided by an approved geometry template bound to the rig. | **Accepted intent.** In the three-phase strategy, the template constrains L and M. D27 holds the details. |
| O2  | Style reference (A) is the main candidate for art consistency.                         | **Accepted intent** as a priority candidate for Phase 1. Needs separately approved components (R3).       |
| O3  | Style LoRA (B) is a later pluggable strategy.                                          | **Accepted intent.** Not an MVP prerequisite.                                                             |
| O4  | Declarative switching of models and art profiles without source changes.               | **Accepted intent** with a limit (R4). Implementation deferred.                                           |
| O5  | One style for all characters, different personality and appearance.                    | **Accepted.** Now a Phase 1 acceptance gate (section 7).                                                  |
| O6  | Variants of one character (clothes, hair, details).                                    | **Accepted intent.** Appearance variants of one identity (R5). Identity preservation is a Phase 1 gate.   |
| O7  | Different specialized models at different stages are permitted.                        | **Accepted intent.** Each model, extension and scope needs approval (D9).                                 |
| O8  | Keep one shared Spine skeleton and animation set, PNG parts + `character.json`.        | **Accepted** (existing owner requirements).                                                               |
| O9  | Keep `@aigg/control`, `@aigg/rig-runtime`, checks, masks, provenance, bundles.         | **Accepted.**                                                                                             |
| O10 | C0.5 is not an approved production rig.                                                | **Accepted.** Templates from C0.5 have the status `prototype`.                                            |

## 3. Product architecture: W → L → M and three phases

### 3.1 Representations

| Representation            | What it is                                                                                                                                     | What it is not                                                                          | Human gate               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------ |
| **W** whole-image concept | One coherent image of the character in the selected art direction and with the intended identity. Free pose is permitted.                      | Not necessarily the reference pose. Not a source for direct deterministic partitioning. | Concept approval         |
| **L** layered character   | The approved concept converted into a full set of layers in the reference pose and view, with visible boundaries, hidden content and overlaps. | Not a fixed-mask cut of W. The technique is not predetermined (section 4.3).            | Layer review and cleanup |
| **M** modular character   | The canonical package: parts with stable slot ids, defined geometry, appearance modules, metadata and provenance.                              | Not a set of arbitrary transparent PNG files. Not a generation strategy.                | Final approval           |

W → L → M is the order of representations for every character. The question "which technique makes L" is open and is decided by evidence (D31). A library of verified layers and modules is one possible tool inside L. It does not replace the concept stage.

### 3.2 Rig-aware authoring (Phase 1) and rig automation (Phase 2)

| Rig-aware authoring (Phase 1)                                       | Rig automation (Phase 2)                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Canonical part ids (slot ids of the contract), side names           | Automated Spine assembly or import                                       |
| Pivots, attachment rectangles, coordinate conventions               | Runtime skin and module composition on the shared skeleton               |
| Near/far rules, draw order owned by the rig                         | Application of all shared animations                                     |
| Permissible shape envelope and future body archetypes (section 5.2) | Full motion validation in both facings, mirroring and asymmetry handling |
| Overlap expectations at joints, hidden content                      | Automated attachment and atlas workflows                                 |
| Semantic part ownership, optional parts and D22                     | Stress poses, transitions, combined tracks                               |
| Mapping to the intended shared rig, checked by manual Spine work    |                                                                          |

Two mistakes to avoid: requiring Phase 2 automation for the MVP, and producing Phase 1 art that needs a new rig for each character.

### 3.3 Output maturity levels

| Level                         | Meaning                                                                                                    | Evidence required                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Prototype layered output      | Layers and parts on a prototype geometry (for example C0.5). Structural checks pass.                       | Parser and pixel checks. **Not** evidence of animation compatibility.                  |
| Manually rig-validated output | A person imported the parts into a Spine rig that matches the template and reviewed the shared animations. | Recorded human review on the real editor or runtime, rig fingerprint, list of defects. |
| Automated Spine-ready output  | Phase 2 tooling assembled and validated the character on the approved shared rig.                          | Automated runtime preview of all animations in both facings, plus human approval.      |

A parser PASS or a static mock never moves an output to a higher level. The label `spine-ready` is used only for the third level.

## 4. Phase 1 pipeline

### 4.1 Stages

| Stage                    | Input                                                             | Output                                                        | Gate                                  |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------- |
| Specification            | Text, reference image, or both                                    | Identity record (traits, locked traits, rights of references) | Owner approves creative intent        |
| W concept                | Specification, style direction                                    | Concept candidates                                            | **Concept approval** (human)          |
| L layered                | Approved concept, template, verified references or reusable parts | Layers in the reference pose and view                         | **Layer review and cleanup** (human)  |
| M modular                | Layers, rig contract                                              | `parts/*.png`, `character.json`, editable source, provenance  | Structural, pixel and geometry checks |
| Spine feasibility review | M package, matching Spine rig                                     | Review record                                                 | **Manual rig review** (human)         |
| Final approval           | All of the above                                                  | Approved Phase 1 package                                      | **Final approval** (human)            |

### 4.2 W: whole-image concept

- Purpose: art direction and identity on one coherent image. The person approves this image before any layer work.
- Inputs: text, an image reference, or both. Every reference image has a recorded rights entry before use.
- Style: a style reference mechanism (A) is a priority candidate. A prompt-only baseline on an approved checkpoint is the comparison. Style LoRA (B) is not an MVP prerequisite.
- The concept can be in a free pose. A concept in the reference pose and view is preferred when it helps L, but it is not assumed (C1, C2: pose control did not give the 3/4 body turn).

### 4.3 L: layered character

L must solve: correct visible boundaries between parts, content hidden behind other parts, overlap at joints, consistent linework, lighting and palette between layers, and the reference pose and view of the rig.

Candidate techniques (any combination, selected by evidence, D31):

| Technique                                                         | Use                                                                      | Needs                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| Template-guided redraw of the concept in the reference pose       | Bring a free-pose concept into the rig pose and view                     | Approved models and workflow (D9), GPU run (D19)     |
| Local AI image editing, context-aware editing of one module       | Change or complete one region while keeping its neighbours               | Approved models, reviewed workflow                   |
| Controlled segmentation with correction                           | Assign visible pixels to parts. Template masks are priors, not truth.    | A reviewed segmentation tool, or manual masking      |
| Generation or reconstruction of single parts                      | Hidden content, far limbs, joint overlaps                                | Approved models                                      |
| Reuse of approved parts or a verified layered reference character | Keep parts that need no change, give the model a correct layered example | A verified layered reference (section 15)            |
| Manual review and cleanup in a layered editor                     | Seams, ownership errors, hidden areas                                    | Krita or another editor, PSD exchange (D4, D13 open) |

**Correction of the earlier version.** The earlier text proposed "cut the whole design with fixed template masks, then complete hidden areas". This is not sufficient in general. A geometry mask does not know where a sleeve, a strand of hair or a held object really is in a generated image. Masks constrain where a part may be and give a prior. Correct semantic separation needs segmentation, context-aware editing or repainting, and a human review.

### 4.4 M: modular character

M is the canonical package of [the package format](../CHARACTER_PACKAGE.md): `parts/*.png` (RGBA, sRGB, straight alpha), `character.json`, provenance, plus an editable layered source (format open, D4 and D13). Distinctions that M keeps:

| Concept             | Meaning                                                                                                  | Decision  |
| ------------------- | -------------------------------------------------------------------------------------------------------- | --------- |
| Rig part            | One part on one slot, moved by one bone                                                                  | Contract  |
| Appearance module   | A group of parts replaced as one unit (for example a hairstyle, a complete arm). Can cover several slots | D23       |
| Character identity  | The person: locked traits                                                                                | D27       |
| Appearance variant  | The same identity with other drawn-on clothes, hair or expression                                        | D29       |
| Removable equipment | Items put on or taken off at run time. Never drawn into the parts                                        | D25 (v2+) |

A full outfit change can need an atomic replacement of several modules. Not every combination of modules is valid. Module compatibility is a contract (D23), not an assumption.

### 4.5 Phase 1 deliverable

For each approved character: an editable layered source, canonical PNG parts, `character.json`, provenance (inputs, rights, models, workflows, seeds, human steps), a validation report, a visual review sheet, and a manual Spine feasibility record when the matching rig exists. The deliverable must be useful for manual Spine work even if Phase 2 never happens.

## 5. Rig-aware authoring in Phase 1

### 5.1 The geometry contract that Phase 1 follows

Phase 1 uses the slot ids, side names, coordinate spaces, attachment rectangles, joint overlaps, draw order and D22 rules of [the rig contract](../RIG_CONTRACT.md). It does not invent per-character bones, slots or pivots.
The template (TemplateProfile) is derived from the rig contract and, for production, from a matching Spine export. It gives line art, region maps and part masks as **constraints and priors**.

### 5.2 Shape envelope and body archetypes

One skeleton fixes joint positions and segment lengths. Characters can differ in face, hair, clothing silhouette inside the attachment rectangles, palette, accessories, and within the contract tolerances (segment length 0.95–1.05 in the proposed contract). This is a **limited** diversity.
Characters with clearly different proportions (much taller, child-like proportions are forbidden anyway, very heavy or very slim builds) need body archetypes: either template variants inside the tolerances, or separate rig versions. Both are owner decisions (D7, D32). This ADR does not promise unlimited body diversity on one skeleton.

### 5.3 Rig feasibility dependency

| Fact                                                                                                   | Consequence                                                                                          |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| The C0.5 contract is a prototype. No Spine project has its geometry.                                   | C0.5 templates and outputs are `prototype`.                                                          |
| The L1 export has the near/far joints in the wrong lateral order for the C0.5 view (C0.5 F1 analysis). | Parts authored for C0.5 do not fit the L1 setup pose. L1 animations are not evidence for C0.5 parts. |
| D17 (view) and D32 (master rig version) are open.                                                      | No production template and no claim of Spine compatibility before they close.                        |

So the roadmap has an **early rig feasibility gate** (F0, section 15): a narrowly scoped manual check that complete parts on the proposed geometry give acceptable motion on a real, matching Spine rig. It uses manual Spine work and the existing runtime. It is not Phase 2 automation.

## 6. Critical review: conflicts and weak points

### R1. No master rig matches the template view

The L1 export has the near/far joints in the wrong lateral order for a front-visible 3/4 view. Production templates wait for D17 and D32. Until then every template is `prototype`. The early F0 gate checks feasibility on a candidate rig that matches the template (section 15). Related finding: F01.

### R2. Fixed masks are not segmentation, and coverage is diagnostic

Two errors of the earlier version are corrected: fixed masks do not extract correct part pixels from an arbitrary design (section 4.3), and coverage masks from sampled poses do not prove the absence of gaps (section 11.3). Related findings: F03, F04.

### R3. Style reference needs new, separately approved components

- **Verified.** The ComfyUI 0.35.0 core node list has no IP-Adapter node. It has `CLIPVisionEncode` and `StyleModelApply` (style model files, not IP-Adapter).
- **Verified.** The SDXL IP-Adapter weights are in `h94/IP-Adapter` (model card license tag `apache-2.0`). The base SDXL adapter uses the OpenCLIP ViT-bigG-14 image encoder (1844.9 M parameters). The Plus variants use OpenCLIP ViT-H-14.
- **Not verified.** The model card text names `.bin` files. The diffusers guide loads `.safetensors` names for the Plus variants. So `safetensors` variants can exist. Maintained ComfyUI custom nodes for IP-Adapter can also exist. None was reviewed.
- **Rule.** Pickle-based `.bin` files are not unavoidable. The first choice is `safetensors`. Each new weight file, image encoder, custom node or other extension needs a separate owner approval and a registry entry (D9). The encoder license is checked separately. This document approves nothing.

### R4. Declarative switching is not unreviewed switching

A ComfyUI graph names node classes and model files. It is executable configuration. Switching is declarative only among reviewed, registered records. A capability flag on a model does not prove that a complete workflow works (F08). A working **recipe** is: exact verified files, the exact workflow and runtime versions, compatible encoders and adapters, and a recorded run that produced the expected output. The pipeline never loads a graph from a user file or a model card.

### R5. Identity, appearance variants and equipment

| Concept             | Meaning                                                                                      | Recorded in                                                                        | Result                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Identity change     | A locked trait changes, or a different person is made                                        | New identity revision, or a new `characterId`                                      | Variants are made again or checked again                                        |
| Appearance variant  | The same person with other drawn-on clothes, hair or expression. Only unlocked traits change | A separate small variant record that refers to one identity revision (section 9.3) | One normal character package for each variant. `character.json` does not change |
| Removable equipment | An item put on or taken off at run time                                                      | Not in the identity, not in a variant. D25 (v2+)                                   | Never drawn into the parts                                                      |

Variant management stays minimal: no service, no database. Related findings: F13.

### R6. Shared base body (D7)

A shared painted body makes characters the same under their clothes. The template shares geometry, not pixels. D7 gets the option "shared template geometry, skin painted per character". Body archetypes stay open (section 5.2).

### R7. Parser scope and part fields

`parseCharacter` in `@aigg/rig-runtime` checks structure only: slot ids, statuses, safe `.png` paths, required parts, D22. It does not check geometry, pixels, provenance or animation. It also rejects per-part `sha256` and `origin`, which [the package format](../CHARACTER_PACKAGE.md) documents. That drift is a separate issue (P1). Until it is fixed, part hashes and origins go to the provenance record. Related finding: F06.

### R8. Approval scopes do not extend silently

The two approved model files are approved for experiment C only. A new workflow, a new stage (for example L editing), or production use needs an explicit owner decision. The owner-run bundle boundary stays: the agent prepares, the owner runs, the agent analyzes. Related finding: F11.

### R9. Mirroring swaps anatomical sides

With `scaleX` mirroring, a detail on the near side (a scar, a hair clip) appears on the other anatomical side when the character faces left. D12 stays open. Identity checks use unmirrored images. Mirrored previews are marked. Related finding: F12.

### R10. Animation list

The template and motion QA read the animation list from the Spine export, never from a fixed list. D5 stays open.

### R11. Style LoRA on factory output

A LoRA trained on factory output can amplify its defects and the identities of the few characters in the set. Training needs rights for every image (`permittedUses: lora_training`), several different identities, and an evaluation on identities outside the training set.

## 7. Acceptance framework

**Proposed. All gates and numbers are OPEN for owner approval.** No value below is an accepted requirement. Visual judgments are recorded human judgments, blind where feasible. Automated metrics are for triage only.

| Gate                    | What it checks                                                                                                            | Proposed method                                                                                               | Proposed pass rule (OPEN)                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Style consistency       | Same drawing language across different characters: linework, shading, palette, lighting, detail density, proportions      | Side-by-side sheet of all characters. Two reviewers, labels hidden where feasible. Checklist per style rule.  | Every character passes every style rule, or the deviation is recorded and accepted |
| Character diversity     | Recognizably different identities, not copies of one face or body                                                         | Face and silhouette sheet. Reviewer matches characters to their descriptions without labels.                  | No two characters confused by the reviewer                                         |
| Identity preservation   | A variant keeps the locked traits and changes only the declared traits                                                    | Base and variant side by side, trait checklist from the identity record                                       | All locked traits kept, all declared changes present                               |
| Layer quality           | Correct part ownership, transparent background, meaningful hidden pixels, overlap at joints, no cropped unrelated objects | Pixel checks (alpha, bounds, rectangles), overlap circles, plus a human layer review in the editor            | No ownership error and no hole in a joint overlap after cleanup                    |
| Module interoperability | Parts and modules follow the compatibility contract. Multi-part changes are atomic                                        | Swap the approved modules of the demonstration set in `@aigg/rig-runtime` (draft module format)               | Declared compatible combinations load. Undeclared ones are refused                 |
| Spine feasibility       | Manual rigging on the intended shared rig works without character-specific restructuring                                  | Person imports the parts into the matching rig, plays every shared animation in both facings, records defects | No new bone, slot or animation needed. Defects listed and fixable in the parts     |
| Provenance and rights   | Every input, model, workflow, seed and human step is traceable                                                            | Provenance record review                                                                                      | Complete record. No input without rights                                           |
| Effort                  | Active human time and rejected attempts (section 8)                                                                       | Time log per stage                                                                                            | Recorded. Target value OPEN                                                        |

Proposed MVP demonstration set (OPEN): three different identities in one style, and one appearance variant of at least one of them, each taken to an approved M package and reviewed on the F0 rig. This shows feasibility. It is not proof of the economics of 100 characters.

## 8. Economics and effort

The Phase 1 metric is **cost and active human time per accepted, usable modular character**, not the cost of one image.

| Record per character                      | Why                                                             |
| ----------------------------------------- | --------------------------------------------------------------- |
| GPU time and money for all attempts       | Failed attempts cost the same as successful ones                |
| Number of rejected concepts and layers    | Shows the real yield of each technique                          |
| Active human time per stage               | Concept review, layer cleanup, hidden-area painting, QA, rework |
| Rework after the Spine feasibility review | Defects that appear only in motion                              |

Phase 2 measures the additional rigging and animation effort per character. A cheap inference call does not establish a cheap approved character.

## 9. Data contracts (unapproved, deferred)

**Unapproved design. Implementation deferred.** JSON Schemas: [`t0/schemas/`](t0/schemas/). Examples: [`t0/examples/`](t0/examples/).
The schemas and the general resolver are not required before the first working template-first character. Phase 1 experiments write only the small manifests that they need, and the existing provenance rules of [the package format](../CHARACTER_PACKAGE.md#generation-record) apply. Implementation (P2, P3) starts only for an observed need, for example a second style, a second model family, or many characters (Phase 3).

### 9.1 Common rules

- Every record has an `id`, an integer `revision`, and a `status` (`draft`, `prototype`, `candidate`, `approved`, `retired`).
- A revision is immutable after any job used it. A change makes a new revision.
- A reference is `{ id, revision, digest }`. The digest is the SHA-256 of the canonical JSON: keys sorted at every level, no whitespace, UTF-8.
- Every input image has a `rights` block. A missing or doubtful entry blocks its use.
- Content rules are constants (`adult: true`, `explicitContent: false`).

### 9.2 Records

| Record            | Schema id                     | Main content                                                                                                                                                   |
| ----------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TemplateProfile   | `aigg.template-profile/0.1`   | Rig binding (contract SHA-256, Spine export fingerprint or `null` for prototypes), view, canvas, assets, anchors, part masks (priors), optional coverage masks |
| StyleProfile      | `aigg.style-profile/0.1`      | Model-neutral art rules, palette, content rules, style references of different characters with rights                                                          |
| StyleBinding      | `aigg.style-binding/0.1`      | How one style revision is applied with one model family: `prompt_only`, `reference_image`, `lora`                                                              |
| CharacterIdentity | `aigg.character-identity/0.1` | Adult flag, description, traits with `locked`, asymmetry, identity references with rights, approved concept, `relatedTo`                                       |
| AppearanceVariant | `aigg.appearance-variant/0.1` | Reference to one identity revision, `variantId`, label, status, changed unlocked traits                                                                        |
| ModelProfile      | `aigg.model-profile/0.1`      | Exact file, license, approval status and scopes, capabilities (informative only, see R4), providers                                                            |
| GenerationJob     | `aigg.generation-job/0.1`     | Pinned rig, template, style, binding, identity, appearance variant, one model for each role, `fallback: forbidden`, stages, output                             |

### 9.3 Identity revisions and variants (F13)

The earlier draft kept the variant list inside the identity record. Then adding a variant changed the identity digest although the person did not change. This revision removes the contradiction with the smallest change: each appearance variant is its own small record that refers to one identity revision. Adding or changing a variant makes a new variant revision. The identity digest changes only when the identity itself changes. Every identity has a `base` variant record. No variant service or database is proposed.

### 9.4 Relation to existing formats

| Existing format         | Relation                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `rig.contract.json`     | Read only. The template copies slot, bone, draw order and rectangles for checks.                           |
| `character.json`        | Unchanged. Identity, variant, style and template references go into the provenance record, not into parts. |
| `aigg.part-module/0.1`  | Unchanged. Module manifests are made after M, when D23 is decided.                                         |
| `aigg.exp-c-bundle/0.2` | The pattern for any GPU step: the agent prepares, the owner runs, the agent analyzes.                      |

## 10. Model selection without fallback

**Unapproved design for the general resolver. Implementation deferred.** The rules that apply now are the existing bundle rules: a bundle names its approved files, runs and workflows, and the runner refuses any other list.

When a resolver is built (P3), it follows these rules: pin every record by digest, check approval status and scope, check that the stage needs are covered, refuse any automatic fallback to another model, binding, node, endpoint or weaker path. Capability flags are only a pre-check. A stage is runnable only with a recipe that has recorded execution evidence (R4).

Example of a correct refusal: a job with a `reference_image` binding and only the two approved files is refused (no style reference component, no image encoder). Nothing is downloaded.

## 11. Spine: capabilities, coverage and motion QA

### 11.1 Spine Essential 4.3 (corrected)

| Feature                                       | What the official sources say                                                                                                                                                                                                                                                                               | Status in this ADR                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Meshes, weights, deformation                  | Purchase page: Essential "Meshes and other advanced features are not included."                                                                                                                                                                                                                             | Outside Essential. Not used.                                                  |
| IK constraints                                | Changelog 4.3.78-beta: "Allow ESS to use IK constraints and skin bones/constraints." Changelog 4.3.27 (unreleased at the check): "Fixed IK constraints for ESS". The IK user guide page still says "not available in Spine Essential". The purchase page footnote still names IK as a Professional feature. | **Sources conflict.** The changelog is newer. Verify on the installed editor. |
| Skin bones and skin constraints               | Same changelog line. The skins user guide page still says "Skin bones are not available in Spine Essential."                                                                                                                                                                                                | **Sources conflict.** Verify on the installed editor.                         |
| Physics, transform, path, clipping, sequences | No Essential statement found on the pages read.                                                                                                                                                                                                                                                             | Unknown. Not used.                                                            |

The earlier version of this ADR said that IK and skin bones are not in Essential. That statement is withdrawn as outdated. The correct statement is: the 4.3 changelog says they were allowed for Essential in the 4.3 beta series, and some guide pages were not updated.
**Rule.** The project does not add IK, skin bones or skin constraints to the master rig because the edition may support them. Any such change is a rig contract decision. Editor version, exported data and runtime version (spine-core 4.3.13 in this repository) are verified together for the exact versions in use.

### 11.2 Runtime facts used by the project (verified earlier)

Runtime skins map slot and attachment name to an attachment, and skins can be combined with `addSkin`. `@aigg/rig-runtime` builds skins at run time from `character.json`, accepts only rigid region attachments, and applies D22.

### 11.3 Coverage is diagnostic

A coverage mask (the part pixels that become visible in sampled poses of the shared animations, posed by spine-core on a matching export) is a useful **diagnostic** for where to paint. It is not proof of no gaps. Motion QA must also look at:

- transitions and mixing between animations;
- combined tracks (primary and secondary animations, D26);
- draw order changes during animations;
- attachment changes;
- clothing silhouettes that differ from the template;
- poses that the sampling did not hit.

The final check is a human review of the real motion on the real rig. A complete automated coverage engine is not a prerequisite for the first manually validated character.

### 11.4 D26 limits stay explicit

Native Spine sequence attachments worked in the D26 spike with spine-core 4.3.13, but the production loader (`loadSharedRig`) rejects them, and the module format has no frame bindings. Face slots for blinking do not exist. Phase 1 makes no promise of secondary animation. Related finding: F09.

## 12. Compatibility map

| Existing item                     | Compatible?      | Notes                                                                                                         |
| --------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| Rig contract 0.2 (L1 test rig)    | Read only        | Wrong lateral order for the template view (R1).                                                               |
| C0.5 candidate contract 0.3.0     | Prototype only   | Preliminary reference for experiment C. Not a production rig.                                                 |
| `character.json`                  | Yes              | No new part fields (R7).                                                                                      |
| `@aigg/rig-runtime`               | Yes              | Structural checks, runtime skins, D22, rigid region attachments only. Not a geometry or pixel validator.      |
| `@aigg/control`                   | Yes              | T1a would add one command. Existing commands, fixtures and bundles do not change.                             |
| D22 absent parts                  | Yes              | Unchanged.                                                                                                    |
| D23 modules (principles accepted) | Yes              | M uses slots. Groups are applied after M. Proposed groups and migration stay open.                            |
| D25 equipment (intent)            | Yes              | Not drawn into parts.                                                                                         |
| D26 animated parts (intent)       | Partly           | Section 11.4. Not in Phase 1.                                                                                 |
| Spine Essential                   | Yes, with checks | Section 11.1.                                                                                                 |
| Spine CLI, PSD import             | Unknown          | The documentation pages do not state the edition. Verify on the installed editor before automation (Phase 2). |

## 13. Implemented and planned

| Capability                                                     | State                                                |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| Shared skeleton, runtime skins, D22 absent parts, atlas checks | Implemented (`@aigg/rig-runtime`), structural only   |
| Part modules, atomic change, atlas cache                       | Implemented as draft (D23 open)                      |
| Control images, overlays, pose marks, C0.5 candidate, depth    | Implemented (`@aigg/control`)                        |
| Execution bundle, runner, evidence check                       | Implemented for experiment C only                    |
| Static template (T1a)                                          | Implemented as a prototype (`aigg-control template`) |
| Coverage tool on spine-core (T1b)                              | Optional research, not started                       |
| W concept, L layering, M assembly with real art                | Planned (Phase 1 experiments), not started           |
| Records and resolver                                           | Unapproved design, implementation deferred           |
| Spine automation                                               | Phase 2, not started                                 |

## 14. Decisions and dependency gates

### 14.1 Gates

| Gate        | Blocks                                                                                                     | Does not block                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| D17 and D32 | A production template, any production claim of Spine compatibility, Phase 2 on the master rig              | T1a, the F0 feasibility check on a candidate rig         |
| D9          | Every new model, adapter, encoder, LoRA, custom node, extension, and any scope extension of approved files | T1a, F0 (no model runs)                                  |
| D19         | GPU runs                                                                                                   | T1a, F0                                                  |
| D15         | Permanent storage of references, generated art, edited templates and package images                        | T1a, F0, experiments that keep evidence in project files |
| D7          | The base body strategy and body archetypes                                                                 | T1a, F0 on one body                                      |
| D4, D13     | The format of the editable layered source in the deliverable                                               | Experiments (they can use PSD as derived output)         |
| D31         | The selected L technique for production                                                                    | L experiments (they produce the evidence)                |
| D28         | The selected style mechanism                                                                               | W experiments (they produce the evidence)                |
| D29         | Variant production                                                                                         | Everything before the first variant                      |

### 14.2 Proposed decisions D27–D32 (all Open)

| Id  | Decision                                    | Recommendation (not accepted)                                                                                                 |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| D27 | Production-art strategy                     | W → L → M with template constraints from Phase 1. Details after the Phase 1 experiments. The strategic intent is the owner's. |
| D28 | Style application strategy and lifecycle    | Compare prompt-only baseline and style reference (A) in Phase 1. B later.                                                     |
| D29 | Appearance variants                         | Separate variant records that refer to one identity revision. One package for each variant. Not equipment.                    |
| D30 | Machine-readable model registry             | JSON records checked against the Markdown registry, when P2 starts. Markdown stays the human source.                          |
| D31 | L technique                                 | Hybrid, selected by evidence from the Phase 1 L experiments. No technique is assumed sufficient.                              |
| D32 | Master rig version for production templates | Migrate the setup pose to the D17 view after the F0 check, with an owner Spine session and an animation review.               |

Older open decisions that matter most: D2 (Spine edition, recommendation text needs the 4.3 correction), D4 and D13 (editable format), D5 (animation list), D7 (base body), D9 (models), D12 (asymmetry), D15 (storage), D16 (part canvas), D17 (view), D19 (GPU), D23 (modules), D25 (equipment), D26 (animated parts). D22 stays **Accepted** and unchanged.

## 15. Roadmap

### 15.1 Dependency graph

```text
T0 (this ADR, docs only)
 │
 ├─> T1a static C0.5 template + flat mock parts            [offline, no decisions]
 │      │
 │      └─> F0 rig feasibility: candidate Spine rig with the C0.5 setup pose,
 │             flat mock parts, then one layered reference character,
 │             all shared animations, both facings, human review  [real rig, Spine Editor access, no GPU]
 │                 │
 │                 └─> informs D17 and D32 ──> master rig migration (owner) ──> production template
 │
 ├─> P1-W concept experiments (prompt-only baseline, then style reference A)   [GPU + D9 scope + D19]
 │      │
 │      └─> P1-L layered experiments on one approved concept (hybrid techniques, cleanup timed) [GPU + D9, editor]
 │             │
 │             └─> P1-M assembly into a canonical package + checks         [offline]
 │                    │
 │                    └─> manual Spine review on the F0 rig                 [real rig]
 │                           │
 │                           └─> MVP demonstration set (3 identities + 1 variant)  ──> Phase 1 exit
 │
 ├─> T1b coverage tool on spine-core, synthetic rig      [optional, offline]
 │
 └─> Phase 2 (automation on the approved master rig) ──> Phase 3 (only for observed needs)
```

### 15.2 Steps and minimum evidence to progress

| Step    | Scope                                                                                                                                                 | Needs                                                                                                     | Minimum evidence to progress                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| T0      | This document                                                                                                                                         | Owner and external audit                                                                                  | Owner review. No code change.                                                                         |
| T1a     | Static C0.5 template, region map, visible masks, overlay sheet, flat mock parts that the parser accepts (section 16)                                  | Offline                                                                                                   | Tests pass. Owner reviews the static sheets. No motion claim.                                         |
| F0a     | Owner makes a candidate rig: a copy of the test rig with the C0.5 setup pose, imports the T1a flat parts, plays all shared animations in both facings | Access to a compatible Spine Editor (purchase and installation not confirmed) and a candidate rig, no GPU | Recorded review: joint gaps, overlaps, draw order, poses that look wrong. Input for D17 and D32.      |
| F0b     | One layered reference character (hand-made or cleaned by a person) on the same candidate rig                                                          | Owner or artist time, no GPU                                                                              | Recorded review that complete art parts move acceptably. This becomes the verified layered reference. |
| P1-W    | Concepts for three identities: prompt-only baseline, then style reference when approved                                                               | GPU, D9 scope decision, D19, owner-run bundle                                                             | Style and diversity gates on concepts (section 7). Rejected attempts recorded.                        |
| P1-L    | L from one approved concept with hybrid techniques, compared on cost and quality                                                                      | GPU and D9 for any model step, layered editor                                                             | Layer quality gate. Active human time recorded. D31 evidence.                                         |
| P1-M    | Canonical package, structural and pixel checks, review sheet                                                                                          | Offline                                                                                                   | Parser PASS plus pixel checks plus human layer review.                                                |
| P1-R    | Manual Spine review of the P1 character on the F0 rig                                                                                                 | Owner Spine session                                                                                       | Spine feasibility gate.                                                                               |
| P1-V    | One appearance variant of an approved identity                                                                                                        | GPU and D9 for model steps                                                                                | Identity preservation gate.                                                                           |
| P1 exit | MVP demonstration set                                                                                                                                 | Owner approval                                                                                            | All Phase 1 gates on the set. Effort per accepted character recorded.                                 |
| T1b     | Coverage tool on spine-core, checked on a synthetic rig only                                                                                          | Offline                                                                                                   | Optional. Diagnostic only. Deferred unless F0 shows a need.                                           |
| P2      | Automated assembly on the approved master rig, all animations, both facings, stress poses, mirroring                                                  | D17, D32, Phase 1 assets                                                                                  | Runtime evidence per character. No change of the shared skeleton or animations.                       |
| P3      | Infrastructure for observed needs only (records, resolver, storage, batch, QA automation)                                                             | Observed need, D15                                                                                        | A measured problem that the infrastructure solves.                                                    |

### 15.3 Ordering and the next smallest proof

**Proposed low-cost geometry feasibility route: T1a followed by F0a.** This is a proposal, not an owner-approved mandatory next implementation. Before work starts, the owner compares this route with a narrowly scoped Phase 1 L-feasibility experiment, by cost, dependencies, evidence produced and risks. Neither route is implemented in this PR.
T1a is cheap, offline and needs no decision. Its flat parts let F0a test the proposed geometry, joints and overlaps in real Spine motion before any art or GPU money is spent. F0b then adds real art detail. Together they answer R1 early and give the evidence for D17 and D32.
**Assumption corrected.** The owner approved the purchase of Spine Essential in principle. The purchase and installation are not confirmed. F0a and F0b need access to a compatible Spine Editor and a candidate rig. Without editor access, research and prototype W → L → M outputs can continue, but they stay at the prototype level (section 3.3) and must not claim validated animation compatibility.
T1b is not on the critical path. A real layered character in F0b gives more useful evidence than synthetic coverage tooling. T1b stays as optional research. It is not implemented.

What needs what:

| Activity         | Real rig                                                    | Model or GPU approval | Offline      |
| ---------------- | ----------------------------------------------------------- | --------------------- | ------------ |
| T1a, P1-M, T1b   | No                                                          | No                    | Yes          |
| F0a, F0b, P1-R   | Yes (candidate rig, manual, compatible Spine Editor access) | No                    | Yes (no GPU) |
| P1-W, P1-L, P1-V | No (uses the template)                                      | Yes                   | No           |
| Phase 2          | Yes (approved master rig)                                   | Only for new art      | Mostly       |

## 16. T1a specification

**Implemented** in `@aigg/control` 0.6.0 as `aigg-control template` (prototype). Section 16.7 lists the implementation notes and deviations. Minimal, static, offline. No GPU, no model, no network, no animation, no coverage masks, no change of the master rig, contracts, existing commands or fixtures.

### 16.1 Purpose

Make a static 3/4 template of the C0.5 prototype geometry and flat mock parts for the F0a rig feasibility check. The output is prototype layered output (section 3.3). It is not evidence of animation compatibility.

### 16.2 Inputs

- `packages/control/test/fixtures/c05-candidate/rig.contract.json` (SHA-256 `17e73069…675e`) as a **prototype** fixture.
- `referenceBody` in `packages/control/src/mannequin.ts`.
- No Spine export. No animation data.

### 16.3 Deliverables

| #   | Deliverable                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Command `aigg-control template --contract <file> --out <dir> [--size WxH] [--dry-run] [--force]`.                                                                                      |
| 2   | `template.json`: status `prototype`, input hashes, tool version, each output with its SHA-256. It is not a format commitment.                                                          |
| 3   | `contour-lineart.png`: 3/4 contour line art at the generation size. Visible turn: shoulder and hip lines, foreshortened far side, feet to the image right.                             |
| 4   | `region-map.png` and one visible mask for each slot in the setup pose. These are geometry priors, not segmentation.                                                                    |
| 5   | `overlay-sheet.png`: line art, region map, joints, pivots, attachment rectangles, joint overlap circles, near/far order, top view of the yaw.                                          |
| 6   | `mock-package/`: a flat-color RGBA part for each required slot (visible mask plus the contract overlap circles), with a `character.json` that `parseCharacter` accepts. Input for F0a. |
| 7   | `review.md`: what to check, and what F0a must check in Spine.                                                                                                                          |
| 8   | README and SECURITY sections. Version step of `@aigg/control` (minor).                                                                                                                 |

### 16.4 Tests (Vitest, synthetic data, temporary directories)

| Id     | Test                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| T1a-01 | Determinism: two runs give byte-equal files and an equal manifest.                                                                 |
| T1a-02 | Exact ids: slot, bone and draw order lists equal the contract. Unknown or missing slots fail.                                      |
| T1a-03 | Each visible mask is inside the attachment rectangle of its slot. One region id at most for each pixel.                            |
| T1a-04 | Near/far geometry: near shoulder and near hip on the image left. Face and feet to the image right.                                 |
| T1a-05 | Alpha: masks are binary. Mock parts are straight alpha, sRGB, RGBA 8 bit. No mock pixel outside visible mask plus overlap circles. |
| T1a-06 | `parseCharacter` accepts the mock package. Optional slots are `absent_by_design` (D22). The test name says "structural".           |
| T1a-07 | No input change: contract and fixture hashes are the same after the run.                                                           |
| T1a-08 | File safety: no output through a symbolic link, existing output needs `--force`, `--dry-run` writes nothing.                       |
| T1a-09 | Rejection: another view or side naming stops with `E_VIEW_UNSUPPORTED`. The manifest status is always `prototype`.                 |

### 16.5 Acceptance

Tests, format, lint, typecheck, build and `check:config` pass. Pictures and `review.md` go to the project files, not Git (D15). The report states that a static template is not proof of motion or coverage.

### 16.6 Not in T1a

Coverage masks, animation sampling, forward kinematics, Spine exports, the record schemas, the resolver, model runs, hand-edited template images, and any change to `character.json`, the rig contract, the master rig, D statuses or existing package behaviour.

### 16.7 Implementation notes and deviations

- The geometry source is the volume set of the `depth` command (the C0.5 reference body). Visibility follows the slot draw order, as Spine draws the setup pose.
- The reference body has no volume for hair, ears, tail, skirt, accessory, weapon and `hand_near_front`. These slots have no mask. The required `hair_back` and `hair_front` get a hatched placeholder frame in the mock package, not a shape.
- The C0.5 data does not meet "each visible mask is inside the attachment rectangle" for two slots: the `hips` volume goes below the hips rectangle, and the `neck` volume (drawn over the torso) goes below the neck rectangle. The command reports this as check M1 (FAIL) and does not clip the masks. A correction changes the candidate rectangles or the volume assumptions, and needs an owner decision.
- T1a-06 runs the real `parseCharacter` source of `@aigg/rig-runtime` in a child Node.js process, because `@aigg/control` has no dependency on `@aigg/rig-runtime`.

## 17. Audit disposition

The independent audit report was not available to the author. The finding titles and requested corrections come from the owner's task text. The auditor's preferred architecture (a modular part library plus local editing as the production architecture) is **not** adopted as exclusive: the owner set W → L → M, and a part library is one candidate tool inside L.

| Finding | Topic                            | Disposition     | Rationale and reference                                                                                                                                             |
| ------- | -------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01     | Rig, template and art mismatch   | FIXED           | C0.5 stays `prototype`. D17 and D32 gate production. Early F0 feasibility gate added. Sections 5.3, 6 R1, 15.                                                       |
| F02     | Fixed rig limits proportions     | DOCUMENTED      | Shape envelope and body archetypes described. No promise of unlimited diversity. Decision stays with D7 and D32. Section 5.2.                                       |
| F03     | Fixed masks are not segmentation | FIXED           | Fixed-mask partition removed as an assumption. Masks are priors. Segmentation, context-aware editing and repainting are candidate L techniques. Sections 4.3, 6 R2. |
| F04     | Coverage is diagnostic           | FIXED           | Coverage marked diagnostic. Motion QA includes transitions, combined tracks, draw order, attachments, silhouettes, unsampled poses. Section 11.3.                   |
| F05     | Spine Essential 4.3 capabilities | FIXED           | Outdated statement withdrawn. Conflicting official sources documented. No IK or rig change because of it. Section 11.1, D2 note in the decision log.                |
| F06     | Parser limitations               | FIXED           | Parser scope stated as structural only. R7 drift kept as a separate issue (P1). Sections 6 R7, 3.3, 12.                                                             |
| F07     | Style and identity               | FIXED           | Style consistency, diversity and identity preservation are Phase 1 gates. Section 7.                                                                                |
| F08     | Executable recipes               | FIXED           | Capability flags are only a pre-check. A recipe needs exact files, versions and execution evidence. Resolver stays deferred. Sections 6 R4, 10.                     |
| F09     | D26 secondary animation          | DOCUMENTED      | Loader and module limits stated. No secondary animation in Phase 1. Section 11.4.                                                                                   |
| F10     | Total economics                  | FIXED           | Metric is cost and active time per accepted modular character, with failed attempts and rework. Section 8.                                                          |
| F11     | Model approvals and security     | FIXED           | No silent scope extension. Owner-run bundle boundary kept. Sections 6 R8, 14.1.                                                                                     |
| F12     | Asymmetry                        | DOCUMENTED      | D12 open. Mirroring swaps anatomical sides. Section 6 R9.                                                                                                           |
| F13     | Identity revisions and variants  | FIXED           | Variants moved to separate small records, so a new variant does not change the identity digest. Schemas and examples updated. Section 9.3.                          |
| F14     | Documentation drift              | FIXED (minimal) | Status lines in `AGENTS.md` and `README.md` corrected. Other drift listed. Section 20.                                                                              |

## 18. Sources and verification

| Claim                                                                                               | Source                                                                                                                        | Checked             |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| C1 and C2 numbers, F2 fusion finding                                                                | [C1 report](C1_GEOMETRY_EVALUATION.md), [C2 report](C2_FAILURE_ANALYSIS.md)                                                   | 2026-11-08          |
| No IP-Adapter node in ComfyUI 0.35.0 core                                                           | `nodes.py` of tag `v0.35.0` and its built-in extra node list, from the C2 evidence archive                                    | Searched 2026-11-08 |
| L1 lateral order, C0.5 geometry                                                                     | [C0.5 report](C05_REFERENCE_MANNEQUIN.md), fixture files                                                                      | 2026-11-08          |
| `parseCharacter` scope and part fields                                                              | `packages/rig-runtime/src/character.ts`                                                                                       | 2026-11-08          |
| D26 loader limits                                                                                   | [D26 spike report](D26_ANIMATED_PARTS_SPIKE.md)                                                                               | 2026-11-08          |
| Essential excludes meshes; footnote names meshes and IK as Professional                             | [Spine purchase page](https://esotericsoftware.com/spine-purchase)                                                            | Fetched 2026-11-08  |
| 4.3.78-beta: "Allow ESS to use IK constraints and skin bones/constraints." 4.3.27: IK fixes for ESS | [Spine changelog](https://esotericsoftware.com/spine-changelog)                                                               | Fetched 2026-11-08  |
| IK page "not available in Spine Essential"                                                          | [Spine IK constraints](https://esotericsoftware.com/spine-ik-constraints)                                                     | Fetched 2026-11-08  |
| Skins page "Skin bones are not available in Spine Essential"                                        | [Spine skins](https://esotericsoftware.com/spine-skins)                                                                       | Fetched 2026-11-08  |
| 4.3 release post has no Essential statement                                                         | [Spine 4.3 released](https://esotericsoftware.com/blog/Spine-4.3-released)                                                    | Fetched 2026-11-08  |
| Runtime skin map, `addSkin`                                                                         | [Spine runtime skins](https://esotericsoftware.com/spine-runtime-skins)                                                       | Fetched 2026-11-08  |
| PSD import tags, CLI commands, editions not stated                                                  | [PSD import](https://esotericsoftware.com/spine-import-psd), [CLI](https://esotericsoftware.com/spine-command-line-interface) | Fetched 2026-11-08  |
| IP-Adapter encoders, style-only block scale, masks                                                  | [Diffusers IP-Adapter guide](https://huggingface.co/docs/diffusers/en/using-diffusers/ip_adapter)                             | Fetched 2026-11-08  |
| `h94/IP-Adapter` license tag, file names in the card text                                           | [Model card](https://huggingface.co/h94/IP-Adapter). Files tab not read.                                                      | Fetched 2026-11-08  |

The Spine pages were read through an automated text extraction. The purchase page feature table lost its marks, so only prose and footnotes are used.
The examples in `t0/examples/` were validated against the schemas with Ajv 8 (JSON Schema 2020-12, strict mode), and the record digests in the job example were recomputed. This was a local script, not a repository test.

## 19. Long-term risks

| Risk                   | Failure chain                                                              | Mitigation                                                                                                | Residual risk                                |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| L quality and cost     | Layers need much manual work → the cost per accepted character is too high | Measure active time per stage from the first experiment. Hybrid L techniques. Verified layered reference. | Main unknown of Phase 1                      |
| Rig migration          | A new rig version → templates and packages need checks or rework           | Early F0 gate. Packages pin the rig fingerprint.                                                          | Old packages may need repainting             |
| Limited body diversity | One skeleton → similar bodies                                              | Shape envelope, archetypes as an owner decision                                                           | Strong variety needs more rigs               |
| Template sameness      | Strong geometry guidance → stiff, identical poses                          | Diversity gate. Looser guidance for hair and clothes.                                                     | Not measured                                 |
| Style drift            | New style revision or model family → characters do not match               | Packages keep their style revision. New binding and style check for a new family.                         | Re-render cost grows with the count          |
| Model dependency       | A model or node is removed or changes license                              | Exact hashes, pinned commits, approval scopes                                                             | Deleted upstream weights cannot be fetched   |
| Licenses               | References or training data without rights                                 | `rights` block, human check                                                                               | No legal review done                         |
| Security               | Custom nodes, pickle files or user graphs run code on the GPU host         | Reviewed workflows only, `safetensors` first, owner-run bundles                                           | The GPU host image is trusted                |
| Spine edition drift    | Conflicting official statements about Essential                            | Verify editor, export and runtime versions together                                                       | Edition terms can change                     |
| Quality measurement    | Judgments by few reviewers                                                 | Recorded judgments, blind where feasible                                                                  | Style and identity similarity stay judgments |
| Reproducibility        | GPU differences                                                            | D14 definition: parameters, files and hashes                                                              | Pixel-exact repeats are not promised         |

## 20. Documentation drift

| Location                                                    | Stale claim                                                                   | Action in this PR                                                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `AGENTS.md`, Project status                                 | "No pipeline package exists yet." Two packages exist.                         | Corrected (one sentence).                                                                 |
| `README.md`, Status                                         | Same claim                                                                    | Corrected (one sentence).                                                                 |
| `docs/DECISIONS.md`, D2                                     | "Professional if meshes or IK are necessary"                                  | Note added that the 4.3 changelog allows IK in Essential (sources conflict). Status Open. |
| `docs/proposals/D23_D26_MODULES_AND_ANIMATED_PARTS.md`, 5.4 | "Spine physics constraints need Spine Professional" (assumption)              | Not changed. It is marked as an assumption. Verify with the editor.                       |
| `docs/CHARACTER_PACKAGE.md`                                 | Per-part `sha256` and `origin` that the parser rejects (R7)                   | Not changed. Separate issue P1.                                                           |
| `docs/ARCHITECTURE.md`                                      | Stages S4–S6, principle 3, candidate tools describe the prompt-first pipeline | Pointer to this ADR updated. Full update after D27.                                       |
| `docs/ROADMAP.md`                                           | Phases 0–8 and experiment C hypothesis                                        | Pointer to the three-phase roadmap. Full update after D27.                                |
| Package `SECURITY.md` files                                 | No stale claim found for this change                                          | None                                                                                      |
