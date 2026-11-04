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

## Open decisions

| Id  | Decision                                      | Options                                                                                           | Recommendation                                                                                                                  | Status       |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| D1  | Animation runtime                             | Spine Web Components / Rive / DOM animation                                                       | Spine Web Components 4.3 (works in Vue in a local test)                                                                         | Open         |
| D2  | Spine edition                                 | Essential / Professional                                                                          | Essential for rigid parts. Professional if meshes or IK are necessary.                                                          | Open         |
| D3  | Side names                                    | `_near`/`_far` / `_l`/`_r` with a fixed rule                                                      | `_near`/`_far`                                                                                                                  | Open         |
| D4  | Editable source format                        | PSD / ORA / both                                                                                  | PSD required, ORA optional and derived                                                                                          | Open         |
| D5  | Animation list                                | 6 from the owner's list / 9 with split jump and crouch entry                                      | 9, if game physics controls the jump                                                                                            | Open         |
| D6  | Weapon grip                                   | Near hand / two hands                                                                             | Near hand in version 1                                                                                                          | Open         |
| D7  | Shared base body                              | One body / 2–3 body types / no shared body                                                        | One body in version 1                                                                                                           | Open         |
| D8  | Soft parts (meshes) in version 1              | Yes / no                                                                                          | No                                                                                                                              | Open         |
| D9  | Generation models                             | Only with verified commercial license / any for prototypes                                        | Only verified, with a hash registry                                                                                             | Open         |
| D10 | Spine license for experiment D                | Buy / do not buy                                                                                  | Buy after experiment A passes                                                                                                   | Open         |
| D11 | Two-step generation                           | Free concept then posed art / strict pose at once                                                 | Two steps, review after experiment C                                                                                            | Open         |
| D12 | Asymmetric designs                            | Allow with a flag / forbid in version 1                                                           | Allow with a flag, accept the side change when mirrored                                                                         | Open         |
| D13 | Editable file in the package                  | `.ora` / `.psd` / both                                                                            | PSD required, ORA optional                                                                                                      | Open         |
| D14 | Reproducibility definition                    | Same pixels / same parameters, log, and result hashes                                             | Same parameters, log, and result hashes                                                                                         | Open         |
| D15 | Binary asset storage                          | Git LFS / object storage / local only                                                             | Not evaluated yet                                                                                                               | Open         |
| D16 | Part canvas                                   | Full contract canvas for each part / cropped part with offset                                     | Full canvas in `parts/`, crop only at atlas export                                                                              | Open         |
| D17 | View                                          | Three-quarter facing right / profile / front                                                      | Three-quarter facing right                                                                                                      | Open         |
| D18 | On-screen character height                    | Value in pixels and target screens                                                                | Not evaluated yet. It sets the source resolution.                                                                               | Open         |
| D19 | GPU                                           | Own GPU with 16 GB or more / rented cloud GPU                                                     | Not evaluated yet                                                                                                               | Open         |
| D20 | Content rules                                 | Age, explicitness, store disclosure rules                                                         | Explicitly adult characters, no explicit content, human approval                                                                | Open         |
| D21 | Package names in the monorepo                 | `@aigg/<dir>` scope and `aigg-<dir>` commands / other                                             | `@aigg/<dir>`, private packages                                                                                                 | Open         |
| D22 | Absent part representation                    | `absent_by_design` in `character.json`, no region / transparent placeholder image                 | Status in `character.json`, no region. See the v5 contract patch.                                                               | **Accepted** |
| D23 | Part modules for mix-and-match                | Module manifest with fixed slot groups / whole characters only                                    | Draft module manifest and groups, after more test characters                                                                    | Open         |
| D24 | Texture ownership at run time                 | Shared atlas cache with owner counts / one atlas set for each character                           | Shared cache with owner counts; set the budget after a GPU check (deferred, see the owner requirements)                         | Open         |
| D25 | Equipment System implementation details (v2+) | Item mounting, slots and mount points, layer composition, equipment manifests, API, complex grips | Not evaluated yet. Check the slots and mount points that equipment needs before the rig contract freeze. Related: D6, D23, D24. | Open         |

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

## Open decision notes

### D25: Equipment System implementation details (v2+)

Accepted by the owner (strategic intent, not part of this open decision): appearance and equipment are different entities. Removable equipment does not depend on the character appearance and is not drawn into the body art. The 10 points of the intent are in [Future Equipment System](ROADMAP.md#future-equipment-system-v2).
Open (implementation details only): how items are mounted, the necessary slots and mount points, layer composition, equipment manifests, the API (including overlay, replace and hide/override), two-handed weapons and complex grips, and the limits of Spine Essential.
Related decisions: D6 (weapon grip), D23 (part modules: atomic change of multi-part items), D24 (texture ownership: resources of items).
Before the final freeze of the rig contract, check that the contract can be extended for equipment. Do not add hypothetical slots or mount points without a reason.

## How to record a decision

1. Change the status to **Accepted** and write the selected option.
2. Write the reason in one or two sentences.
3. List the documents and contract fields that the decision changes.
4. Update those documents in the same pull request.
