# AIGG Studio: one Vue 3 application for interactive user tools (architecture decision record)

**Status.** The decision in section 2 is accepted by the owner (D36 in [the decision log](../DECISIONS.md#d36-aigg-studio-user-tools-application)).
It is a product and frontend technology direction. It does **not** authorize implementation. No Studio code, package, or dependency exists.
Each Studio page needs a separate design and implementation task.

Related documents:

- [Pipeline v2 ADR](PIPELINE_V2_ADR.md) (D35)
- Pipeline v2 part construction rules and human calibration: pull request #56, `docs/proposals/V2_CONSTRUCTION_AND_CALIBRATION.md` (**Proposed**, not merged). This document calls it "the calibration proposal". It defines `calibration.json` and the outline of the calibration page.
- [MVP-C browser playback](MVP_C_BROWSER_PLAYBACK.md) and [the `@aigg/viewer` README](../../packages/viewer/README.md)
- [Component inventory](../COMPONENT_INVENTORY.md#aiggviewer)

## Contents

1. [Context and motivation](#1-context-and-motivation)
2. [Decision](#2-decision)
3. [Relation to the human-in-the-loop workflow](#3-relation-to-the-human-in-the-loop-workflow)
4. [Pages](#4-pages)
5. [Architecture principles](#5-architecture-principles)
6. [Reuse of `@aigg/viewer`](#6-reuse-of-aiggviewer)
7. [Deferred choices](#7-deferred-choices)
8. [Consequences and trade-offs](#8-consequences-and-trade-offs)

## 1. Context and motivation

The owner accepted a revised direction for Pipeline v2:

```text
automatic generation and joint proposals -> interactive preview -> optional user corrections
  -> approval -> assembly -> Spine export -> web playback
```

Full autonomy is not a requirement. Human review and correction are product capabilities, not a temporary failure mode.

This direction needs more than one interactive tool: rig calibration first, then sheet review and build inspection.
Separate web applications for each tool would repeat the same loading, rendering, and character context, and would give an inconsistent user experience.
The game that uses the packages is also built with Vue 3 and TypeScript ([known owner requirements](../DECISIONS.md#known-owner-requirements)), so one frontend stack is sufficient.

## 2. Decision

**Accepted by the owner (D36).**

Future interactive user-facing tools are pages of **one** application. Working name: **AIGG Studio**.

| Item              | Choice                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| Framework         | Vue 3, Composition API, Single File Components                         |
| Language          | TypeScript (strict, as in [AGENTS.md](../../AGENTS.md#implementation)) |
| Build             | Vite, with a separate `tsc --noEmit` type check (the repository rule)  |
| Routing           | Vue Router, only when the application has more than one route          |
| Not added for D36 | UI framework, component library, state management library              |

Use established, plain conventions. Add a library only when an implementation task shows an actual requirement, and record the reason.

Not authorized by D36: a scaffold, a new package, a dependency, a calibration UI, a backend endpoint, or a change to `@aigg/viewer`.

## 3. Relation to the human-in-the-loop workflow

Studio is the user interface of the human steps. It does not add a pipeline stage and does not replace a CLI step.

| Workflow step                      | Done by                                            | Studio role                                       |
| ---------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| Generation, extraction, proposals  | CLI and core modules                               | None. Studio shows the results.                   |
| Interactive preview                | Spine web runtime                                  | Shows the character, the skeleton, animations.    |
| Optional user corrections          | The user                                           | Edits draft values (for example calibration).     |
| Approval                           | The user, explicitly                               | Records an explicit approval action.              |
| Assembly, Spine export, validation | CLI and core modules (`sheet-assemble` and others) | Shows status and reports. Does not own the logic. |

Calibration values have three states. Studio must keep them separate and visible:

1. **Proposed**: values from an automatic rule.
2. **Draft**: values that the user changed and saved, not approved.
3. **Approved**: values that the user explicitly approved.

An edit never silently overwrites a source image or an original generation artifact. A saved result is a new, versioned, reproducible file.
The CLI can rebuild the same package from the same inputs and the saved file.

## 4. Pages

These are examples, not a committed backlog. Add a page only when a real AIGG workflow needs it.

### 4.1 Rig Calibration (first planned page)

The first interactive tool. The exact MVP scope is a separate design and implementation task. Possible capabilities:

- Show an assembled character with the skeleton bones, the joints, and the attachment boundaries.
- Play the existing animations.
- Select art landmarks, bones, or attachments.
- Change attachment transforms: offset, rotation, and optional uniform scale (see below). See below for the joint rule.
- Show the result immediately.
- Undo and reset (to the proposal or to zero).
- Save a calibration draft. Validate the saved data against its JSON Schema.
- Approve the final calibration explicitly.

Consistency with the calibration proposal (**Proposed**, sections 4 and 5):

- That proposal defines the data (`calibration.json`) and the first page behavior (milestone V2-M4). D36 does not change it. D36 only says that this page is the Rig Calibration page of AIGG Studio, not a part of the `@aigg/viewer` page.
- Owner decisions in the review of the calibration proposal: `calibration.json` is a separate file, bound to the exact source descriptor and the rig contract version. An optional uniform scale for each part is allowed; no nonuniform scale in the initial scope; scale limits are experimental. The page must show both values: the original source geometry and the calibrated visual alignment. A calibrated scale never turns a source geometry failure into a PASS.
- The page never makes art landmarks to hide a placement error. A placement error is corrected with an attachment transform.
- Skeleton joints come from the rig contract and are never changed for one character (owner decision D-S5, see [V2-3](V2_3_SKELETON_ASSEMBLY_SPIKE.md), and [the pipeline rules](../../AGENTS.md#pipeline-rules)). A user correction changes an attachment transform, not the shared skeleton.

### 4.2 Sheet Review (future)

Review generated modular character sheets before acceptance: the full sheet, single regions, extraction bounds and alpha, automatic check results, accept or reject, and user feedback or correction requests.

### 4.3 Build and Validation (future)

Inspect assembly and export results: validation status and errors, assembled preview, export files, and reports.

## 5. Architecture principles

**A. One application, many pages.** Simple route-based feature folders. Do not build microfrontends, a plugin platform, dynamic module loading, a separate SPA for each tool, or a framework for tools that do not exist.

**B. Keep the existing viewer.** See [section 6](#6-reuse-of-aiggviewer).

**C. UI is separate from pipeline logic.** These capabilities stay in the CLI and core modules, and are available without Studio:

- geometry calculations;
- rig validation;
- image extraction;
- package assembly;
- Spine export;
- file integrity checks (hashes, manifests).

Studio calls or reads these results. It does not contain the only implementation of any of them. A Studio page can show a check result, but the check runs in shared code that the CLI also uses.

**D. Shared character and artifact context.** All pages use the same character and job identities and the same versioned files. Do not make a page-specific representation of a character that is incompatible with the package format or with another page.
Keep three concepts separate in data and in the UI (as in the calibration proposal):

| Concept               | Source                         | Can a user change it?                                                           |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| Art landmarks         | Points on the artwork          | Only as an annotation of the artwork. Never to fix placement.                   |
| Skeleton joints       | Rig contract (shared skeleton) | No, not for one character.                                                      |
| Attachment transforms | Calibration of one character   | Yes (offset, rotation, optional uniform scale), as draft values, then approval. |

**E. Human review is an explicit gate.** Proposed, draft, and approved values stay distinct (section 3). The UI never records an approval that the user did not give. Undo and reset are basic requirements. Saved data is validated.

**F. Lightweight.** Prefer existing packages, tools, and conventions. No database, authentication system, job scheduler, WebSocket server, or general-purpose backend for this decision.
A future write API or remote access needs its own design with security boundaries (see [security requirements](../../AGENTS.md#security-requirements)).

## 6. Reuse of `@aigg/viewer`

`@aigg/viewer` works: it checks a Spine 4.3 export and plays it in `spine-webcomponents` 4.3.13 on `127.0.0.1` (MVP-C). It is a validation harness and is used by the factory `PREVIEW` stage.

- Do not rewrite `@aigg/viewer` only to use Vue.
- Do not keep two independent rendering engines. Studio uses the same Spine web runtime and the same export checks.
- Extract or share rendering code (for example the export checks in `exportbundle.ts` or the runtime loading in `src/page/`) only when an implementation task shows the need. That task decides the form: a shared module, an export of `@aigg/viewer`, or a new small package.
- Until then, `@aigg/viewer` and its CLI stay as they are. The factory keeps its current preview stage.

## 7. Deferred choices

These choices are **open**. Each needs a decision in the implementation task that needs it, or an owner decision where the [Human decisions](../../AGENTS.md#human-decisions) list applies.

| Choice                                   | Notes                                                                                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package name and location                | For example `packages/studio` (`@aigg/studio`). Follows D21. Not created now.                                                                                                                       |
| Vue and Vue Router dependencies          | Need the dependency review (license, native binaries, install scripts) and, for runtime dependencies, the owner allowlist in `scripts/ci/config.mjs`.                                               |
| How Studio reuses viewer rendering       | Section 6. Decided by the first implementation task.                                                                                                                                                |
| How saved data reaches the disk          | Browser download and load of a file (no write API), or a local write endpoint on `127.0.0.1`. A write endpoint needs a security design (paths, symbolic links, overwrite rules, approved packages). |
| Character and job identity model         | Relation to the `@aigg/factory` job model and to the generation job proposal (D27).                                                                                                                 |
| Calibration data contract                | Defined by the calibration proposal (separate `calibration.json`, optional uniform scale). Its schema and implementation are a separate task.                                                       |
| Rig Calibration MVP scope                | Separate design task (calibration proposal, section 5).                                                                                                                                             |
| UI, component, or state library          | None until an actual requirement exists.                                                                                                                                                            |
| Component and browser test approach      | Vitest is the repository test tool. A browser test approach for pages is not decided.                                                                                                               |
| Desktop packaging (for example Electron) | Not planned. The Studio runs as a local web page.                                                                                                                                                   |
| Remote access, more than one user        | Not planned. Needs a separate design with security boundaries.                                                                                                                                      |

D36 does not close D1 (animation runtime), D21 (package names), D27 (generation job), or any other open entry.

## 8. Consequences and trade-offs

Benefits:

- One frontend stack, one look, one character context for all human steps.
- The same stack as the game that uses the packages.
- The human-in-the-loop direction gets a clear place for corrections and approvals, while the pipeline stays usable from the CLI.

Costs and risks:

| Item                                                         | Mitigation                                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| New dependencies (Vue, later Vue Router)                     | Add them only in an implementation task, with the dependency review. Vue is MIT-licensed (**Assumption**: verify at that time). |
| Two web surfaces for a time (`@aigg/viewer` page and Studio) | Share the runtime and the checks (section 6). Decide later if the viewer page stays a standalone harness.                       |
| Logic moves into the UI over time                            | Principle C. Review each Studio change for logic that belongs in the CLI or core modules.                                       |
| A local write path is a new trust boundary                   | No write API until a separate security design exists. A file download needs no server write.                                    |
| One application can grow into a framework                    | Principle A. Add a route only for a real workflow.                                                                              |
| Approval semantics in a UI                                   | Principle E. Approval is an explicit user action. It is never inferred from a save.                                             |
