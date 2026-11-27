# Roadmap and experiments

**Draft.** The durations are estimates, not commitments.

**Current development priority: [Pipeline v2 — MVP core](#pipeline-v2--mvp-core) (steps 1 to 5).** The MVP-A to MVP-F sequence in [the historical section](#historical-pipeline-v1-mvp-vertical-slice-mvp-a-to-mvp-f) is completed or superseded Pipeline v1 work. It is not the current priority.

## Pipeline generations (D35)

**Accepted by the owner (D35):** Pipeline v1 (concept decomposition) is deprecated and retained. Pipeline v2 (direct modular generation) is the primary workflow. See [the Pipeline v2 ADR](proposals/PIPELINE_V2_ADR.md).
The step lists below are **proposed**. The owner approves the start of each step that needs a decision or spends money.

### Existing Pipeline v1

Deprecated. Retained for reproducibility and reference. No new features by default. See [Pipeline v1](PIPELINE_V1.md) and [the deprecation policy](PIPELINE_V1.md#deprecation-and-compatibility-policy).

### Pipeline v2 — MVP core

**Current priority.** The MVP-first rules of D33 apply to this sequence: a complete vertical slice first, then improvements.
The MVP starts with a modular character sheet that already exists. Details and the minimum evidence of each step: [the Pipeline v2 ADR, section 8](proposals/PIPELINE_V2_ADR.md#8-pipeline-v2-mvp-implementation-sequence). Step 1 (proposed, not approved): [Modular Sheet Contract v0.1](PIPELINE_V2_MODULAR_SHEET.md).

| Step | Content                                                      | Result                                                                                                                                                        |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Modular Sheet Contract v0.1                                  | Document, draft layout descriptor schema, synthetic test sheet.                                                                                               |
| 2    | Extract the separated assets                                 | One image for each region, exact pixel partition, region report. Prototype: [V2-2](proposals/V2_2_SHEET_EXTRACTION.md), synthetic sheet only.                 |
| 3    | Map the parts to the existing canonical package and skeleton | Slot mapping, joint points, geometry checks, optional manual correction file. Spike: [V2-3](proposals/V2_3_SKELETON_ASSEMBLY_SPIKE.md), synthetic sheet only. |
| 4    | Produce an animatable Spine package                          | Offline checks PASS, then an owner Spine CLI import and export without differences.                                                                           |
| 5    | Validate web playback                                        | The demonstration animations play in `@aigg/viewer` without critical defects.                                                                                 |

### Pipeline v2 — generation extension

| Step | Content                                                  | Result                                                                     |
| ---- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| 6    | Text-to-modular-sheet generation                         | A sheet that passes steps 2 to 5. Needs approved models and GPU decisions. |
| 7    | Optional skeleton-aware image guidance                   | Uses the experiment C control tools. Measured against the contract.        |
| 8    | Sheet quality validation and bounded correction or retry | A fixed retry limit, recorded rejections, no unbounded loops.              |

#### G-Research-1: alternative modular sheet generators

**Draft. Desk research (Phase 1) done, no inference.** Input to step 6. The research compares template-guided open-weights workflows with the ChatGPT baseline (Prompt v2.5) for initial sheet generation and masked repair. Ranked for a possible Phase 2 run: Qwen-Image-Edit-2511, then FLUX.2 [klein] 4B, both Apache-2.0 in ComfyUI. Phase 2 needs owner approval for models, GPU, and images. See [G-Research-1](proposals/G_RESEARCH_1_MODULAR_GENERATORS.md).

### AIGG Studio (D36)

**Accepted direction, no implementation authorized.** Interactive user tools are pages of one Vue 3 + TypeScript + Vite application. See [the AIGG Studio ADR](proposals/AIGG_STUDIO_ADR.md).

| Page               | Status                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| Rig Calibration    | First planned page. Scope and data come from the calibration proposal (pull request #56, milestone V2-M4). |
| Sheet Review       | Future example.                                                                                            |
| Build & Validation | Future example.                                                                                            |

Each page starts only with a separate design and implementation task.

### Later work

- Quality improvements.
- Automation of the remaining manual steps.
- Support for arbitrary concept images, with Pipeline v1 techniques where useful.
- Production readiness and scalability.

### Relation to the earlier plan

The historical Pipeline v1 MVP vertical slice (MVP-A to MVP-F), the phases, and the experiments below stay in this document as a record. They are not removed. The [Pipeline v2 ADR, section 9](proposals/PIPELINE_V2_ADR.md#9-earlier-proposals-superseded-and-still-relevant) lists which earlier proposals are superseded by the new priority and which stay relevant.
The three acceptance levels below apply to Pipeline v2 too. The phase gates 7 and 8 are still the gates for production pipeline acceptance and the version 1 contract freeze.

<a id="near-term-priority-mvp-vertical-slice"></a>

## Historical: Pipeline v1 MVP vertical slice (MVP-A to MVP-F)

**Historical record. Not the current priority.** The current priority is [Pipeline v2 — MVP core](#pipeline-v2--mvp-core). This section keeps the D33 sequence, its limits, and its results. The MVP-first rules (D33) and the acceptance levels below still apply, now to Pipeline v2.

**Owner-accepted prioritization (D33), as decided before D35.** The near-term priority was one end-to-end MVP vertical slice: the smallest complete path from character input to an animated, exportable character package. The rules are in [MVP-first development](../AGENTS.md#mvp-first-development).
This was a prioritization change. It does not remove the version 1 requirements, the phase gates below, or the long-term goal of one shared rig and one shared animation set.

**Status after D35.** MVP-A to MVP-E used Pipeline v1. Their results stay valid as Pipeline v1 component results. They are not end-to-end production acceptance. The status of each step is in the table below. Details: [Pipeline v1](PIPELINE_V1.md#experiments-and-results).

### Sequence (Pipeline v1, historical)

| Step  | Content                                                                                                                          | Result                                                                                                  | Status after D35                                                                                                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MVP-A | Assemble one complete test character from the existing W, L, and M artifacts (L0-1, M0-F0a, T1a, C0.5) with pragmatic fallbacks. | A full-body package on a candidate rig. Manual steps and defects are listed.                            | Done. 13 offline checks PASS (`JSON_GENERATED`). See [MVP-A](proposals/MVP_A_FULL_BODY_ASSEMBLY.md).                                                                                               |
| MVP-B | Validate its Spine CLI import and export.                                                                                        | A `spine-validate` report from a real Spine run.                                                        | Done once by the owner on the MVP-A package. See [MVP-D](proposals/MVP_D_PIPELINE_ORCHESTRATION.md#three-run-status-d33).                                                                          |
| MVP-C | Verify animation playback in a minimal runtime test harness.                                                                     | Playback evidence of the demonstration animations.                                                      | Agent PASS on a synthetic export. Owner playback of the real export not recorded. See [MVP-C](proposals/MVP_C_BROWSER_PLAYBACK.md).                                                                |
| MVP-D | Connect the existing steps through a resumable, observable Node.js orchestration flow.                                           | One command flow with logs, restart points, and explicit human steps.                                   | Agent part PASS. A complete owner run not recorded. See [MVP-D](proposals/MVP_D_PIPELINE_ORCHESTRATION.md).                                                                                        |
| MVP-E | Test the same process on another character.                                                                                      | The second character goes through the same flow without changes to shared files, or the gaps are known. | Jun package `JSON_GENERATED`, 12 of 12 offline checks PASS. `PASS_WITH_LIMITATIONS` recommended, owner decision open. See [Pipeline v1](PIPELINE_V1.md#character-b-jun-licensed-test-asset-mvp-e). |
| MVP-F | Improve automation, artistic quality, generality, and production readiness.                                                      | Follow-up work, ordered by the recorded defects.                                                        | Superseded as the next priority by the Pipeline v2 MVP core (D35). Not started.                                                                                                                    |

The step names are labels for planning. Only the owner approves the start of a step that needs a decision from [the decision log](DECISIONS.md) or spends money.

### Limits of the vertical slice

- **Runtime harness.** The runtime viewer is only a validation harness. It is not a new game engine and does not change the scope of version 1. It uses the existing runtime libraries (`@aigg/rig-runtime`, spine-core). It does not close D1.
- **Animations.** Minimal demonstration animations may be used. They do not replace the full required animation set (`idle`, `run`, `jump`, `shoot_stand`, `shoot_crouch`, `hit`, both facings) and do not change D5.
- **Rig.** The slice may use a candidate rig and the prototype C0.5 geometry. This is not a rig contract version, not a master rig migration (D32), and not a view decision (D17).
- **Test assets.** The L0 test concept is a licensed test asset. It stays local and outside Git. It is not a product character, and its age is not confirmed. All characters follow [the content rules](../AGENTS.md#content-rules).
- **Spending and models.** The slice adds no permission to buy Spine Professional, call paid models or APIs, rent a GPU, or add a model. Each of these needs a separate owner decision.
- **Phase 2 automation.** The slice may use manual Spine work and the existing `spine-validate` command. It does not make Phase 2 automation a requirement for the Phase 1 exit (see [the T0 ADR](proposals/T0_TEMPLATE_FIRST_ARCHITECTURE.md)).

### Acceptance levels

These levels apply to the current Pipeline v2 MVP core in the same way.

| Level                           | Meaning                                                                                                                                     | Evidence                                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MVP vertical-slice acceptance   | One test character goes from input to an animated, exportable package. Known noncritical defects and manual steps are permitted and listed. | Proposed, the owner agrees the exact criteria at the start of MVP-A: a real Spine CLI import and export without differences, playback of the demonstration animations in the harness without critical defects, the list of manual steps and defects. |
| Production pipeline acceptance  | The pipeline makes approved packages for new characters reliably.                                                                           | The phase 7 gate: three characters pass, the time of each step is measured. Each automated step meets the three-run rule below. The required animation set plays in both facings.                                                                    |
| Final version 1 contract freeze | Contract 1.0 and the shared rig are frozen.                                                                                                 | The phase 8 gate: a new character needs no contract change, the equipment extensibility check (D25), the animated parts spike (D23, D26).                                                                                                            |

The MVP vertical-slice acceptance does not pass a phase gate and does not approve a character package.

## Phases

The phases are the plan for production pipeline acceptance and the version 1 freeze. Each phase gate must pass before its acceptance level, except phases marked as parallel. The MVP vertical slice can use partial results of several phases before their gates pass. It does not skip or remove a gate.

| Phase | Content                                                                                                 | Gate                                                                                                                            | Relation to pipeline generations (proposed)           |
| ----- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 0     | The owner closes the decisions in [the decision log](DECISIONS.md).                                     | Decisions recorded.                                                                                                             | Both generations.                                     |
| 1     | Runtime: experiment A on a real GPU and in Electron.                                                    | Experiment A passes.                                                                                                            | Both generations (runtime).                           |
| 2     | Reference: mannequin, base body, reference pose, one character by hand, master rig with all animations. | The character plays all animations in both directions in the web runtime.                                                       | Both generations (master rig, D32).                   |
| 3     | Contract 0.2 (parallel with phase 2): contract file, JSON Schemas, check against the Spine export.      | Schemas and checks pass on the reference character.                                                                             | Both generations.                                     |
| 4     | Interchange: experiment D.                                                                              | Experiment D passes. A third character does not change shared files.                                                            | Both generations.                                     |
| 5     | Generation: experiment C.                                                                               | Experiment C passes, or a fallback method is selected.                                                                          | Pipeline v2 generation extension (steps 6 and 7).     |
| 6     | Decomposition: experiment B.                                                                            | A method is selected. Cleanup time is measured.                                                                                 | Pipeline v1 research. Deprioritized.                  |
| 7     | MVP pipeline: text to approved package.                                                                 | Three characters pass the pipeline. The time of each step is measured.                                                          | Pipeline v2 with the generation extension (proposed). |
| 8     | Freeze version 1: contract 1.0 and documentation.                                                       | A new character needs no contract change. Equipment extensibility is checked (D25). The animated parts spike passes (D23, D26). | Both generations.                                     |

Automate a step only after it was done the same way by hand at least three times. This rule is a production-readiness criterion.

**Owner-approved exception for provisional MVP orchestration (D33).** MVP-D may connect and run steps that were demonstrated at least once before they were done three times by hand. Conditions:

- The flow is observable: each step writes a log and a machine-readable report.
- The flow is reversible or safely restartable: it does not overwrite an approved package or an earlier result, and a failed step can run again from a known state.
- The limitations, the manual steps, and the steps that were not repeated three times are documented.
- Human review steps stay manual (see [Pipeline rules](../AGENTS.md#pipeline-rules)).

The provisional orchestration is not production automation. Before production pipeline acceptance, each automated step meets the three-run rule.

Owner decision: full GPU and performance tests wait until realistic game assets and mass-render scenarios exist. They are not a gate for decision D22 or for the design of D23. The performance question of D24 stays open.

## Future Equipment System (v2+)

**Owner-approved strategic intent. Not a version 1 task.** The implementation details below are not approved. Decision D25 holds the open questions.

The factory will support equipment that does not depend on the character appearance:

1. Appearance and equipment are different entities. Weapons and removable armor are not drawn permanently into the source images of the body.
2. Items in the hands change at run time without a change of the shared skeleton and without a restart of the animation.
3. Named mount points on the rig and local item points, for example `grip`, `muzzle`, `tip`, and others when necessary.
4. Removable clothes and armor: helmets, body armor, shoulder guards, bracers, footwear, and similar items.
5. Future operations overlay, replace, and hide/override. Their exact API is not approved yet.
6. A multi-part item changes atomically.
7. The design considers rig compatibility, draw order, and independent resource management (see D23 and D24).
8. Before the rig contract freeze, estimate the additional slots and mount points that equipment needs. Do not add hypothetical slots now without a reason.
9. Two-handed weapons, complex grips, and the limits of Spine Essential are separate questions for version 2 or later (see D6).
10. Full GPU and performance tests stay deferred until realistic game assets exist.

Gate for phase 8 (contract 1.0 freeze): an equipment extensibility check of the rig contract (D25).

## Animated parts and secondary animation (D26)

**Owner-approved strategic intent.** The implementation is not approved. Decisions D23 and D26 hold the open questions. Details: [appearance modules and animated parts](proposals/D23_D26_MODULES_AND_ANIMATED_PARTS.md).

- Individual visual parts can have their own animations at the same time as the primary animation, without character-specific skeletons. Examples: periodic blinking, facial expressions, independently animated eyes, breathing, tail and hair movement, glowing or pulsing accessories, small looping effects.
- Conceptual behaviours: `static`, `frame_sequence` (image frames at their own rate), `bone_animated` (movement through the shared rig). These are not final enum values or API names.
- GIF-like behaviour is desired, not GIF playback. A later Node.js/TypeScript build step can convert GIF, APNG, animated WebP or image sequences into normalised frames and atlases.
- Prefer Spine Essential capabilities. The initial feature set must not need Spine Professional.
- Later playback policies: loop, one-shot, ping-pong, periodic activation. Secondary animations do not disturb primary animations, and a priority strategy defines the owner of each property.
- All frames keep alignment, logical size and attachment geometry. Playback is deterministic (seeded) where requested.
- Appearance modules (D23): hairstyles and tails are replaceable independently of the head and the torso.

### Pre-freeze validation spike (future task)

Before the rig contract 1.0 freeze, a small automated spike shows one shared skeleton, the primary `run` animation, independent blinking with a short frame sequence, independent tail movement, and a hairstyle change without a reset of the active animations.
Acceptance: deterministic playback, no attachment conflicts, no conflicting timelines (no bone or slot keyed by both a primary and a secondary animation), no visible alignment jumps, and the runtime state kept during the module change.
Known conflict: the current `run` and `jump_air` key bone `tail_1`. The proposal recommends to move this tail movement to secondary animations, which changes the shared animation set version (not done).
The spike does not include GPU or performance benchmarks. They stay deferred by owner decision.
Status: a first spike ran on an isolated test fixture. See [the D26 spike report](proposals/D26_ANIMATED_PARTS_SPIKE.md). The rig contract and the master rig did not change.

## Experiments

### A. Runtime feasibility

| Field      | Content                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| Hypothesis | Spine Web Components in Vue 3 show many characters with one skeleton, different atlases, and shared animations.        |
| Status     | Partly done. A local test with Spine example assets passed in headless Chromium with software WebGL.                   |
| Remaining  | Real GPU and Electron, a test skeleton of our size, shared skeleton data, 10/30/60 characters, memory over 10 minutes. |
| Pass       | 60 FPS or more with 30 characters and 8 atlases on the target laptop. Memory growth below 5 % in 10 minutes.           |
| Fail       | Below 30 FPS with 30 characters, or a memory leak.                                                                     |

### B. Layer decomposition

**Pipeline v1 research (D35).** Deprioritized. Not on the Pipeline v2 path.

| Field      | Content                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Hypothesis | Base body plus decomposition only for hair, headwear, ears, tail, and weapon needs less cleanup than decomposition of the full image. |
| Input      | 12 production art images in the reference pose: skirts, tails and animal ears, long hair, all with firearms.                          |
| Metrics    | Cleanup minutes for each character, validator errors before cleanup, preview defects, artist score 1–5, GPU time.                     |
| Pass       | The selected method needs 60 minutes of cleanup or less, has no critical defects after cleanup, and scores 4 or more.                 |
| Fail       | Both methods need more than 120 minutes of cleanup.                                                                                   |

### C. Rig-guided generation

**Relation to D35.** Relevant to the Pipeline v2 generation extension (skeleton-aware guidance). Not on the Pipeline v2 MVP core path.

| Field      | Content                                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hypothesis | Pose, depth, and line control from the mannequin keep the joint error at 2.5 % of body height or less in 70 % of results. Two-step generation keeps the concept design. |
| Input      | 20 text descriptions. Control images made by script from the mannequin.                                                                                                 |
| Metrics    | Joint error, segment length, zone IoU, share inside tolerance, design similarity, human approval share, GPU seconds.                                                    |
| Pass       | 70 % or more inside tolerance with three attempts or fewer. Design kept in 70 % or more by human score.                                                                 |
| Fail       | Below 40 % inside tolerance.                                                                                                                                            |

Status: pilot C0 prepared the pose control images, ComfyUI workflows, and overlay tools. Inference is blocked (no GPU, no approved model). See [the C0 report](proposals/C0_RIG_GUIDED_GENERATION.md).
C0.5 proposes a corrected reference geometry for the view. The owner accepted it as a preliminary reference for experiment C only. See [the C0.5 report](proposals/C05_REFERENCE_MANNEQUIN.md).
The first generation uses an execution bundle (`aigg-control bundle`): the agent prepares it, the owner runs it on the GPU host, and the agent analyzes the images. See [the package README](../packages/control/README.md).
C1 evaluated the first baseline and pose-guided pair (one seed). OpenPose kept the joint positions, but not the torso and foot orientation. This does not decide experiment C. See [the C1 report](proposals/C1_GEOMETRY_EVALUATION.md).
C2 prepares OpenPose only against OpenPose + depth (three seeds) with an approximate depth image of the C0.5 reference body. Run once. See [the C2 preparation](proposals/C2_PREPARATION.md).
C2 ran (six images). The orientation gate failed in all six images. Detached hands were in 3 of 3 A images and 1 of 3 B images. See [the C2 failure analysis](proposals/C2_FAILURE_ANALYSIS.md).
The owner approved a three-phase product strategy (Phase 1 Art Generation MVP, Phase 2 Spine Automation, Phase 3 Production Readiness) with template constraints (D27). The proposed roadmap, the early rig feasibility gate F0 and the proposed offline step T1a are in [the T0 ADR](proposals/T0_TEMPLATE_FIRST_ARCHITECTURE.md#15-roadmap). The phase table is updated after the owner decides D27.

### D. Asset interchange

| Field      | Content                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hypothesis | PNG and JSON to PSD, image editor, PSD back to PNG and JSON, Spine atlas, and web preview lose no data. One `skeleton.json` serves two characters without changes. |
| Status     | Script part done in research: PNG to PSD and back, PNG to ORA and back. The image editor and Spine are not tested.                                                 |
| Metrics    | Pixel difference after the round trip (0 outside the changed layer), position offset (0 px), name match, hashes of shared files after a third character is added.  |
| Pass       | All metrics pass. The third character is added without changes to shared files.                                                                                    |
| Fail       | The editor changes alpha or color, or Spine imports with an offset.                                                                                                |
| Cost       | Needs a Spine license. This needs the owner's approval (decision D10).                                                                                             |

## Research sources

The research reports and the contract 0.2 proposal are in the project files, outside this repository:

- `research/layered-character-pipeline-report.md`
- `research/ai-character-factory-audit.md`
- `research/contract-v0.2-proposal/`

Move the JSON Schemas and the validator prototype into the `contract` and `validator` packages in phase 3.
