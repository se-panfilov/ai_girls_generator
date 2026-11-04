# Proposed contract patch after L1 v5

**Proposal, partly accepted.** Section 1 (absent parts, D22) is accepted and is now in [the rig contract](../RIG_CONTRACT.md). The other sections are not accepted. Only the owner accepts them. The patch does not freeze contract version 1.0.
Evidence: [L1 v5 evidence](../L1_V5_EVIDENCE.md). Related open decisions: D22, D23, D24 in [the decision log](../DECISIONS.md).

## Scope

The patch changes only statements that the L1 owner export and the v5 tests support. It keeps all bone, slot, and attachment names and the draw order.
The diffs below show the proposed text. Only section 1 was applied to the [rig contract](../RIG_CONTRACT.md).

## 1. Absent parts (D22, accepted)

Evidence: L1-02 A and C, and the blank-dropping atlas of A. Both "Ignore blank images" settings work when absence comes from `character.json`.

```diff
 Rules:

 1. An empty optional slot has the status `absent_by_design` in the sidecar.
+   The runtime attaches nothing to this slot. The package has no image and needs no atlas region for it.
+   If the atlas has a region for an absent part, the check ignores it and reports `W_ABSENT_PART_REGION_IGNORED`.
 2. An empty required slot is a validation error.
+3. A present part must have an atlas region with `orig` equal to the attachment rectangle.
+   A 1×1 `orig` for a present part is `E_PRESENT_PART_BLANK`. The check never accepts a transparent placeholder image.
```

### Spine Editor packer setting "Ignore blank images"

| Setting | Observed output for a fully transparent part image (L1)            | Effect with this patch                         |
| ------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| Off     | A 1×1 region, `bounds` 1×1, `orig` 1×1. The original size is lost. | Ignored with a warning, if the part is absent. |
| On      | No region.                                                         | Correct, if the part is absent.                |

Neither setting keeps the geometry of a blank image. The package must not use a transparent image to mark absence.
Recommendation: "Ignore blank images: on" for new exports, because the atlas is smaller. Both settings stay valid.

## 2. Layers of data

| Layer                      | Content                                                                                                                                 | Owner of change   | Changes per character |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------- |
| Editor master              | The Spine project of the shared rig                                                                                                     | Rig author        | No                    |
| Shared runtime skeleton    | Exported `skeleton.json`: bones, slots, draw order, animations. Its region attachments are templates (position, rotation, scale, size). | Rig author        | No                    |
| Rig contract               | `rig.contract.json`: rectangles, tolerances, required slots                                                                             | Owner decision    | No                    |
| Character manifest         | `character.json`: part status, files, SHA-256                                                                                           | Factory           | Yes                   |
| Module manifest (draft)    | `aigg.part-module/0.1`: one group of slots, its atlas, tags, provenance                                                                 | Factory           | Yes                   |
| Atlases                    | Atlas text and page images, made by the packer                                                                                          | Factory (derived) | Yes                   |
| Derived editable files     | PSD, ORA, Krita files                                                                                                                   | Factory (derived) | Yes                   |
| Runtime assembly and cache | Character skins and the atlas cache in memory                                                                                           | Runtime           | Not stored            |

```diff
 ## Sources of truth
 ...
 | Character parts and their status | `character.json` in the package | Direct read, validated by JSON Schema |
+| Part modules (draft)             | Module manifest `aigg.part-module/0.1` | Direct read, validated by JSON Schema |
+
+The shared runtime skeleton is the editor export without change. One `SkeletonData` serves all characters.
+The runtime makes one skin for each character from the region templates of the default skin and the character atlas.
+Atlases, PSD, ORA and preview files are derived output.
```

## 3. Part modules (D23, draft)

A module supplies one group of slots from one atlas. The draft groups for `humanoid_girl_v1`: `head`, `head_accessory`, `torso`, `arm_near`, `arm_far`, `legs`, `weapon`.
Each contract slot is in exactly one group. A module must give a status for each slot of its group.
A module fits the rig when the `rigId` is the same and the contract major and minor versions are the same.
Compatibility rules compare tags, for example the skin tone of `head`, `torso`, and the arms. They do not prove that parts look good together.
Composition with a seed is deterministic, complete (it finds a compatible selection when one exists), bounded, and does not depend on the catalog order. A module id identifies one module content in a catalog.

## 4. Texture ownership (D24)

The runtime loads each module atlas once and counts its owners. The cache identity is the atlas text hash, the alpha mode, and the hash of each page image. Same atlas text with other page images is a different atlas. An atlas without owners stays in a bounded list and is unloaded after that.
A part change loads and checks everything first and then changes the skin in one synchronous step. A failure keeps the old character.
Open questions: the size of the unused list on real devices, and the GPU budget for each character.
The owner deferred full GPU and performance tests until realistic game assets and mass-render scenarios exist. These tests are not a gate for D22 or for the design of D23. This question of D24 stays open.

## Migration and versions

- The patch is additive. Existing names, the draw order, and the rectangles do not change. Proposed version: contract 0.3.0 (minor).
- Old character packages A, B, C stay valid. Their 1×1 regions for absent parts give a warning, not an error.
- A package that has no region for an absent part (blank-dropping export) becomes valid. Under v4 it failed.
- Rollback: return to contract 0.2. The v4 check then fails A and C again, as in the original L1 run. No file changes.

## Risks

- GPU memory and performance with many atlases: measured only with software WebGL. Full tests are deferred by the owner (see D24).
- Visual seams between modules of different characters: an art issue.
- Atlas lifetime when a page also uses the widget asset manager for the same atlas.
- Animations with attachment keys need the attachment names in each module.
- The group table can be too coarse or too fine for later rigs.
