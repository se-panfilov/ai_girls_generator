# Decision log

**Draft.** This log lists the decisions that the owner must make before implementation. The ids D1–D14 come from the technical audit. The other ids are new.
Only the owner closes an entry. An agent can add options and a recommendation, but it cannot change the status to **Accepted**.

## Known owner requirements

These items come from the owner. They are not open.

| Requirement                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The factory makes rig-compatible layered cutout characters for one shared skeleton.                                                                                                                                                   |
| All characters share one animation set. Version 1 has no character-specific skeletons or animations.                                                                                                                                  |
| Version 1 is the pipeline, not a game or an engine.                                                                                                                                                                                   |
| The game that uses the packages is built with Vue 3, TypeScript, and probably Electron, with a DOM UI.                                                                                                                                |
| The game does not use PixiJS, Phaser, or Three.js.                                                                                                                                                                                    |
| Required animations: `idle`, `run`, `jump`, `shoot_stand`, `shoot_crouch`, `hit`, facing left and right.                                                                                                                              |
| The repository is an npm workspaces monorepo. Code runs on Node.js.                                                                                                                                                                   |
| No license purchase or paid API call without the owner's approval.                                                                                                                                                                    |
| Everything in the repository is in English: code, comments, user interface, documentation, and reports.                                                                                                                               |
| New custom tooling is TypeScript on Node.js. Shell is only a thin wrapper. See [engineering requirements](ENGINEERING_REQUIREMENTS.md).                                                                                               |
| Supported operating systems for the current gates: macOS and Linux. Windows is not tested.                                                                                                                                            |
| The purchase of Spine Essential is approved in principle. The owner buys it. Spine Professional is not part of this approval.                                                                                                         |
| Full GPU and performance tests wait until realistic game assets and mass-render scenarios exist. They are not a gate for D22 or for the design of D23. The performance question of D24 stays open.                                    |
| Future intent for version 2 or later: an Equipment System that is independent of the character appearance. See [Future Equipment System](ROADMAP.md#future-equipment-system-v2) and D25. The implementation details are not approved. |
| Development priority: MVP-first. The near-term priority is one end-to-end MVP vertical slice. See D33 and [MVP-first development](../AGENTS.md#mvp-first-development).                                                                |
| Pipeline generations: Pipeline v1 (concept decomposition) is deprecated and retained. Pipeline v2 (direct modular generation) is the primary workflow. See D35.                                                                       |

## Open decisions

| Id  | Decision                                      | Options                                                                                                                                    | Recommendation                                                                                                                                                                                                         | Status       |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| D1  | Animation runtime                             | Spine Web Components / Rive / DOM animation                                                                                                | Spine Web Components 4.3 (works in Vue in a local test)                                                                                                                                                                | Open         |
| D2  | Spine edition                                 | Essential / Professional                                                                                                                   | Essential for rigid parts. Professional if meshes are necessary. The 4.3 changelog allows IK and skin bones in Essential, but some guide pages disagree: verify on the installed editor. See the T0 ADR, section 11.1. | Open         |
| D3  | Side names                                    | `_near`/`_far` / `_l`/`_r` with a fixed rule                                                                                               | `_near`/`_far`                                                                                                                                                                                                         | Open         |
| D4  | Editable source format                        | PSD / ORA / both                                                                                                                           | PSD required, ORA optional and derived                                                                                                                                                                                 | Open         |
| D5  | Animation list                                | 6 from the owner's list / 9 with split jump and crouch entry                                                                               | 9, if game physics controls the jump                                                                                                                                                                                   | Open         |
| D6  | Weapon grip                                   | Near hand / two hands                                                                                                                      | Near hand in version 1                                                                                                                                                                                                 | Open         |
| D7  | Shared base body                              | One body / 2–3 body types / no shared body                                                                                                 | One body in version 1                                                                                                                                                                                                  | Open         |
| D8  | Soft parts (meshes) in version 1              | Yes / no                                                                                                                                   | No                                                                                                                                                                                                                     | Open         |
| D9  | Generation models                             | Only with verified commercial license / any for prototypes                                                                                 | Only verified, with a hash registry                                                                                                                                                                                    | Open         |
| D10 | Spine license for experiment D                | Buy / do not buy                                                                                                                           | Buy after experiment A passes                                                                                                                                                                                          | Open         |
| D11 | Two-step generation                           | Free concept then posed art / strict pose at once                                                                                          | Two steps, review after experiment C                                                                                                                                                                                   | Open         |
| D12 | Asymmetric designs                            | Allow with a flag / forbid in version 1                                                                                                    | Allow with a flag, accept the side change when mirrored                                                                                                                                                                | Open         |
| D13 | Editable file in the package                  | `.ora` / `.psd` / both                                                                                                                     | PSD required, ORA optional                                                                                                                                                                                             | Open         |
| D14 | Reproducibility definition                    | Same pixels / same parameters, log, and result hashes                                                                                      | Same parameters, log, and result hashes                                                                                                                                                                                | Open         |
| D15 | Binary asset storage                          | Git LFS / object storage / local only                                                                                                      | Not evaluated yet                                                                                                                                                                                                      | Open         |
| D16 | Part canvas                                   | Full contract canvas for each part / cropped part with offset                                                                              | Full canvas in `parts/`, crop only at atlas export                                                                                                                                                                     | Open         |
| D17 | View                                          | Three-quarter facing right / profile / front                                                                                               | Three-quarter facing right                                                                                                                                                                                             | Open         |
| D18 | On-screen character height                    | Value in pixels and target screens                                                                                                         | Not evaluated yet. It sets the source resolution.                                                                                                                                                                      | Open         |
| D19 | GPU                                           | Own GPU with 16 GB or more / rented cloud GPU                                                                                              | Not evaluated yet                                                                                                                                                                                                      | Open         |
| D20 | Store disclosure rules                        | Disclosure text and age ratings for each store. Age and sexualization: closed by D34                                                       | Human approval                                                                                                                                                                                                         | Open         |
| D21 | Package names in the monorepo                 | `@aigg/<dir>` scope and `aigg-<dir>` commands / other                                                                                      | `@aigg/<dir>`, private packages                                                                                                                                                                                        | Open         |
| D22 | Absent part representation                    | `absent_by_design` in `character.json`, no region / transparent placeholder image                                                          | Status in `character.json`, no region. See the v5 contract patch.                                                                                                                                                      | **Accepted** |
| D23 | Appearance module boundaries and migration    | Coarse appearance modules (proposed 9 groups) / current 7-group runtime table / whole characters only                                      | Owner-approved principles. Proposed 9 groups and migration in the D23/D26 proposal. Open until the migration design and a minimal validation are reviewed.                                                             | Open         |
| D24 | Texture ownership at run time                 | Shared atlas cache with owner counts / one atlas set for each character                                                                    | Shared cache with owner counts; set the budget after a GPU check (deferred, see the owner requirements)                                                                                                                | Open         |
| D25 | Equipment System implementation details (v2+) | Item mounting, slots and mount points, layer composition, equipment manifests, API, complex grips                                          | Not evaluated yet. Check the slots and mount points that equipment needs before the rig contract freeze. Related: D6, D23, D24.                                                                                        | Open         |
| D26 | Animated parts and secondary animation        | Behaviours `static`, `frame_sequence`, `bone_animated` (conceptual) on the shared rig / no part animation                                  | Owner-approved intent. Spine Essential features, secondary tracks with property ownership. Details open. See the D23/D26 proposal.                                                                                     | Open         |
| D27 | Production-art strategy                       | W → L → M with template constraints / prompt with pose control / part library first                                                        | W → L → M with template constraints from Phase 1. Details after the Phase 1 experiments. See [the T0 ADR](proposals/T0_TEMPLATE_FIRST_ARCHITECTURE.md).                                                                | Open         |
| D28 | Style application strategy and lifecycle      | Prompt-only baseline / reference image (A) / style LoRA (B), with channels and immutable revisions                                         | Compare the prompt-only baseline and A in Phase 1. B later. See the T0 ADR, R3 and section 7.                                                                                                                          | Open         |
| D29 | Outfit variants                               | Appearance variants inside one identity, one package for each variant / new identity revision / cross-module outfit sets / equipment (D25) | Separate variant records that refer to one identity revision, one package for each variant. Identity changes, appearance variants and removable equipment stay different concepts. See the T0 ADR, R5 and section 9.3. | Open         |
| D30 | Machine-readable model registry               | JSON records checked against the Markdown registry / JSON only / Markdown only                                                             | JSON records with a consistency check. The Markdown registry stays the human source.                                                                                                                                   | Open         |
| D31 | L technique (layering)                        | Template-guided redraw / local editing / segmentation with correction / part reuse / hybrid                                                | Hybrid, selected by evidence from the Phase 1 L experiments. Fixed masks alone are not sufficient. See the T0 ADR, section 4.3.                                                                                        | Open         |
| D32 | Master rig version for production templates   | Migrate the setup pose to the D17 view and review the animations / keep the L1 geometry                                                    | Migrate after D17 and the F0 feasibility check, with an owner Spine session and an animation review. See the T0 ADR, R1.                                                                                               | Open         |

## Accepted decisions

### D22: absent part representation

Selected option: an absent optional part has the status `absent_by_design` in `character.json`. It has no PNG file and no atlas region, and the runtime attaches nothing to its slot.
A 1×1 placeholder region of an absent part in an older atlas is ignored with the warning `W_ABSENT_PART_REGION_IGNORED`.
A required part that is absent is an error. A 1×1 blank region for a present part is an error. New Spine exports use "Ignore blank images: on".

Reason: the Spine packer does not keep the size of a fully transparent image ("off" writes a 1×1 region, "on" writes no region).
The original L1 run failed L1-02 A and C only because of these 1×1 regions. With absence from `character.json`, A, B and C and the blank-dropping atlas of A pass and render like the owner renders.
Evidence: [L1 v5 evidence](L1_V5_EVIDENCE.md) (L1-02, L1-03, the blank-dropping atlas checks) and the tests of `@aigg/rig-runtime`.

Changed documents: [the rig contract](RIG_CONTRACT.md) (absent parts rules, attachment rectangles, validator), [the package format](CHARACTER_PACKAGE.md) (`parts`), [the v5 contract patch](proposals/RIG_CONTRACT_V5_PATCH.md) (section 1 is accepted).
No contract field and no bone, slot or attachment name changes. The contract is not frozen.

### D33: MVP-first development

Accepted owner requirement. The primary development priority is a working end-to-end asset-generation pipeline, not perfection of individual stages. The near-term work builds one MVP vertical slice: the smallest complete path from character input to an animated, exportable character package. The rules are in [MVP-first development](../AGENTS.md#mvp-first-development). The sequence (MVP-A to MVP-F) and the acceptance levels are in [the roadmap](ROADMAP.md#near-term-priority-mvp-vertical-slice).

Also accepted: a limited exception to the three-run automation rule. Provisional MVP orchestration may connect and run previously demonstrated steps before three manual repetitions, if the flow is observable, reversible or safely restartable, and its limitations are documented. The three-run rule stays a production-readiness criterion.

Reason: the stage experiments (C, L0-1, M0-F0a) improved single stages, but no complete path from input to an animated package exists yet. A complete path with known defects shows the real blockers earlier than more work on isolated stages.

Not changed by D33:

- Security, licensing, provenance, data integrity, owner approvals, expenditure limits, and repository governance.
- The open decisions in this log. D33 closes no other entry. It does not decide D1 (runtime), D2 (Spine edition), D5 (animation list), D17 (view), D32 (master rig version), or any rig contract version.
- No approval of a new rig contract, a new runtime technology, a Spine Professional purchase, paid models or APIs, or GPU expenditure.
- The phase gates and acceptance requirements in the roadmap. MVP vertical-slice acceptance is separate from production pipeline acceptance and from the final version 1 contract freeze.

Changed documents: [AGENTS.md](../AGENTS.md) (MVP-first development, project status), [the roadmap](ROADMAP.md) (near-term priority, acceptance levels, automation exception), [the glossary](GLOSSARY.md) (MVP vertical slice).

### D34: character age and sexualization

Accepted owner requirement. It closes the age and sexualization part of D20. The store disclosure part of D20 stays open.

- A character can have any age, also a minor age. The rule "all characters are explicitly adult" is removed.
- Sexualized content of a minor character, or of a character that looks like a child, is prohibited. An unstated age counts as a minor age for this rule.
- Sexualized content is: nudity, sexual acts, sexual innuendo, erotic or suggestive poses or expressions, framing or detail that focus on the breasts, the buttocks, or the crotch, and fetish framing. Suggestive content is in this list, not only explicit content.
- Ordinary clothing and poses are not sexualized content, for example a school uniform with a short skirt, sports clothes, swimwear in a non-sexual context, and normal action poses. They do not stop the pipeline.
- For adult characters that do not look like children, the project adds no content limit. The law and the model license terms still apply.

Reason: the factory is a general tool for different games, also games with teenage characters, and the end user is responsible for the use of the output. A tool without an age rule and without a sexualization rule could make sexualized images of minors, so that prohibition stays. The definition names sexual focus, not clothing length, so that ordinary clothing does not block the pipeline.

Not changed by D34: the human approval of each concept and each final package, the model license registry, and the store disclosure rules (D20).
The recorded prompts of experiment C (`@aigg/control`) ask for an adult character. They are the parameters of past runs, so they stay unchanged. They are not a requirement for new characters.

Changed documents: [AGENTS.md](../AGENTS.md) (content rules), [the asset-factory skill](../.agents/skills/asset-factory/SKILL.md) (content check), [the roadmap](ROADMAP.md) (test assets), the T0 proposal and its schemas (`adult` is data, `sexualizedMinors: false` is a constant), the See-through bundle manifest, the M0-F0a report, and the `W_APPROVAL` check text of `@aigg/factory`.

### D35: pipeline generations

Accepted owner decision. The project distinguishes two pipeline generations:

- **Pipeline v1 — concept decomposition (deprecated).** Concept image → See-through decomposition → layered assets → manual landmarks → modular assembly → Spine → web. It is deprecated for future development. It stays intact and reproducible. Its removal is not authorized.
- **Pipeline v2 — direct modular generation (primary).** Modular character sheet → extraction and validation → skeleton attachment → Spine export → web playback. The immediate MVP starts with a modular character sheet that already exists. A later extension generates the sheet from a text description.

Reason: in the Pipeline v1 experiments, most defects came from the reconstruction of hidden body parts (merged thighs, joint gaps, hidden shoulders, completed hair). A modular sheet supplies the parts directly.

Also accepted: the deprecation and compatibility policy in [Pipeline v1](PIPELINE_V1.md#deprecation-and-compatibility-policy). "Pipeline v1" and "Pipeline v2" name workflow generations only, not the product version, the rig contract version, the package schema version, the Spine version, or the npm package versions.

Not changed by D35: the rig contract, the shared skeleton, the animation set, the package format, the security rules, the model license registry, the content rules, and the phase gates. D35 closes no other entry. The v2 architecture details, the Modular Sheet Contract, the pipeline provenance field, and the cleanup plan are proposals.

Changed documents: [the Pipeline v2 ADR](proposals/PIPELINE_V2_ADR.md) (new), [Pipeline v1](PIPELINE_V1.md) (new), [the component inventory](COMPONENT_INVENTORY.md) (new), [the roadmap](ROADMAP.md#pipeline-generations-d35), [the architecture](ARCHITECTURE.md), [the glossary](GLOSSARY.md), [AGENTS.md](../AGENTS.md) (project status), and the README.

## Open decision notes

### D27: production-art strategy

Accepted by the owner (strategic intent, not part of this open decision): the main direction is template-first generation (D) bound to the shared Spine rig. A style reference (A) is the main candidate for art consistency. A style LoRA (B) is a later pluggable strategy. Models and art profiles are switched by data, without source changes. Characters share one style and differ in identity. Later, variants of one character are necessary. Different models at different stages are permitted. The shared skeleton, the animation set, PNG parts plus `character.json`, and the existing packages stay. C0.5 is not a production rig.
Open: the records and their formats, the layer authoring path (D31), the style strategy (D28), outfit variants (D29), the model registry format (D30), and the master rig version (D32).
Details and the critical review: [the T0 ADR](proposals/T0_TEMPLATE_FIRST_ARCHITECTURE.md).
Relation to D35 (proposed reading, D27 stays open): the L step through decomposition is now Pipeline v1. The W step and the M representation stay relevant. The owner decides if D27 changes. See [the Pipeline v2 ADR, section 9](proposals/PIPELINE_V2_ADR.md#9-earlier-proposals-superseded-and-still-relevant).

### D25: Equipment System implementation details (v2+)

Accepted by the owner (strategic intent, not part of this open decision): appearance and equipment are different entities. Removable equipment does not depend on the character appearance and is not drawn into the body art. The 10 points of the intent are in [Future Equipment System](ROADMAP.md#future-equipment-system-v2).
Open (implementation details only): how items are mounted, the necessary slots and mount points, layer composition, equipment manifests, the API (including overlay, replace and hide/override), two-handed weapons and complex grips, and the limits of Spine Essential.
Related decisions: D6 (weapon grip), D23 (part modules: atomic change of multi-part items), D24 (texture ownership: resources of items).
Before the final freeze of the rig contract, check that the contract can be extended for equipment. Do not add hypothetical slots or mount points without a reason.

### D23: appearance module boundaries

Accepted by the owner (design principles): rig parts (sprites moved by bones) and appearance modules (groups of parts replaced together) are different concepts. Arms keep upper-arm, forearm and hand sprites, legs keep thigh, shin and foot sprites, and the torso supports upper and lower articulation. Modules stay reasonably coarse. A hairstyle is replaceable independently of the head and face, and hairstyle-integrated animal ears belong to the hair module. A tail is replaceable independently and can be absent. A module can contain several slots, attachments and animated rig parts, and a multi-part change is atomic. The separation of appearance and equipment (D25) stays possible.
Recommended (not approved): the 9 groups `head`, `hair`, `torso`, `arm_near`, `arm_far`, `legs`, `tail`, `head_accessory`, `weapon` (transitional). The current runtime table has 7 groups. The migration moves hair and ears out of `head` and the tail out of `torso`; this needs no slot change, but it changes the module manifest format.
Open: the final group table, optional groups or empty modules (an empty module needs an atlas reference now; a module without resources needs a schema and runtime change), face and strand slots, the manifest version, and the conversion of the A, B and C module manifests. D23 stays open until the migration design and a minimal validation are reviewed.
Details: [appearance modules and animated parts](proposals/D23_D26_MODULES_AND_ANIMATED_PARTS.md).

### D26: animated parts and secondary animation

Accepted by the owner (strategic intent): individual visual parts can have their own animations (for example blinking, expressions, eyes, breathing, tail and hair movement, pulsing accessories, small loops). They run at the same time as the primary animation and need no character-specific skeleton. Conceptual behaviours: `static`, `frame_sequence`, `bone_animated`. GIF-like behaviour is desired, not GIF playback. The initial feature set must not need Spine Professional. Secondary animations do not disturb primary animations, frames keep the attachment geometry, and playback can be deterministic (seeded).
Known conflict: the current `run` and `jump_air` key bone `tail_1`, but the proposed ownership rule gives the tail chain to secondary animations. The recommended migration (not done) moves these keys to secondary animations and needs a new shared animation set version.
Open: manifest schemas, the Spine attachment and track strategy, the timing and scheduling API, layering priorities, import formats, and implementation and resource budgets.
Related decisions: D22 (blank frame rules), D23 (modules that contain animated parts), D24 (frames in atlases), D25 (equipment layering).
Before the rig contract freeze, a small automated spike must show the primary `run` animation with independent blinking, tail movement and a hairstyle change without an animation reset. See [the roadmap](ROADMAP.md#animated-parts-and-secondary-animation-d26).
Spike evidence (draft, does not close D26): [the D26 spike report](proposals/D26_ANIMATED_PARTS_SPIKE.md). Native Spine sequence attachments work with spine-core 4.3.13; the production loader and the module format need changes.
Details: [appearance modules and animated parts](proposals/D23_D26_MODULES_AND_ANIMATED_PARTS.md).

## How to record a decision

1. Change the status to **Accepted** and write the selected option.
2. Write the reason in one or two sentences.
3. List the documents and contract fields that the decision changes.
4. Update those documents in the same pull request.
