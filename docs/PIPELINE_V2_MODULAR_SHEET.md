# Pipeline v2: Modular Sheet Contract v0.1

**Status: proposed (draft).** Step V2-1 of [the Pipeline v2 MVP core](ROADMAP.md#pipeline-v2--mvp-core). The owner has not approved this contract. It does not change [the rig contract](RIG_CONTRACT.md), the master skeleton, the animation set, [the character package](CHARACTER_PACKAGE.md), or the factory stage list. The decision for the pipeline generations is D35 ([the ADR](proposals/PIPELINE_V2_ADR.md)). This document does not reopen it.

The contract tells which prepared character sheet the pipeline can convert into separate part images for the existing skeleton. The extraction (V2-2) is in [V2-2 sheet extraction](proposals/V2_2_SHEET_EXTRACTION.md). This contract does not define the mapping and geometry checks (V2-3), the skeleton attachment, the Spine export, or the web playback.

## Contents

- [1. Terms](#1-terms)
- [2. Image requirements](#2-image-requirements)
- [3. Parts](#3-parts)
- [4. Geometry](#4-geometry)
- [5. Layout descriptor](#5-layout-descriptor)
- [6. Pixel checks and semantic checks](#6-pixel-checks-and-semantic-checks)
- [7. Synthetic test sheet](#7-synthetic-test-sheet)
- [8. Real AI-generated sheet: compatibility assessment](#8-real-ai-generated-sheet-compatibility-assessment)
- [9. Recommended V2-2 approach](#9-recommended-v2-2-approach)
- [10. Open decisions that affect V2-2](#10-open-decisions-that-affect-v2-2)
- [11. Limits and residual risks](#11-limits-and-residual-risks)

## 1. Terms

- **Modular sheet.** One PNG image that shows each character part separately, as in [the ADR, section 4](proposals/PIPELINE_V2_ADR.md#4-modular-character-sheet).
- **Region.** One axis-aligned rectangle on the sheet. A region has one role: `part` (art for one rig slot), `reference` (art that the pipeline never imports, for example an assembled preview), or `ignore` (other content, for example labels or color swatches).
- **Layout descriptor.** A small JSON file (`aigg.modular-sheet/0.1`) that lists the regions of one sheet. See [section 5](#5-layout-descriptor).
- **Target contract.** The rig contract that the sheet is made for. In v0.1 this is the C0.5 candidate contract (`humanoid_girl_v1_c05_candidate` 0.3.0, prototype geometry). It is not a production contract.

## 2. Image requirements

Coordinates are sheet pixels. The origin is the top-left corner of the image. X goes right and Y goes down, as in the rig contract (`yAxis: down`). A box `{x, y, w, h}` contains the pixels from `x` to `x + w - 1` and from `y` to `y + h - 1`.

| ID  | Requirement                                                                                                                                                                                                                                                             | Check                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| I1  | Format: PNG, 8 bits for each channel, color type RGBA (6). No interlace. Other chunks are ignored. Color type RGB (2) is not compatible (see I3). Palette, grayscale, and 16-bit images are not supported: a recorded conversion to 8-bit RGBA is simple preprocessing. | Pixels (P3)                               |
| I2  | Size: each side from 256 to 8192 pixels, at most 32 Mpx, at most 128 MiB. The tool checks the header before it inflates the pixel data.                                                                                                                                 | Pixels (decoder limits)                   |
| I3  | Background: transparent (alpha 0). An opaque background (for example white or a checker pattern drawn into the pixels) is **correctable by preprocessing** only: a separate, recorded step removes it before the check. The check does not remove a background.         | Pixels (P3, P5)                           |
| I4  | Color: sRGB is assumed. The tool does not read or apply ICC, gAMA, or cHRM chunks. Alpha is straight (not premultiplied).                                                                                                                                               | Assumption                                |
| I5  | Foreground: a pixel with alpha ≥ 16 is foreground. A pixel with alpha 1 to 15 is weak alpha. Weak alpha is counted and reported, but it is not part content and it is permitted outside the regions.                                                                    | Pixels (P4, P5)                           |
| I6  | Margins: each region box has at least 1 transparent pixel between the art and the box edge, and each two boxes do not overlap. **Recommended:** at least 16 pixels of transparent space between the art of two parts.                                                   | Pixels (box overlap), recommended spacing |
| I7  | Touching components: two parts must not touch or overlap on the sheet. If they touch, no box can separate them, and the descriptor is not valid (E_SHEET_BOX_OVERLAP) or a box takes pixels of the other part. Such a sheet **requires regeneration** or manual edit.   | Pixels (box overlap), human               |
| I8  | Shadows, glow, and effects: no cast shadow, ground shadow, or glow outside the part silhouette. Effects inside a part are part of the art. A drop shadow that connects to the part goes into the part.                                                                  | Human                                     |
| I9  | Decorative assembled preview: permitted. It must be in its own `reference` region and must not touch a part. It is never imported and never satisfies a slot.                                                                                                           | Descriptor (role), pixels (P5)            |
| I10 | Text, labels, and swatches: permitted only inside an `ignore` region. Any foreground pixel outside all regions fails the check (P5).                                                                                                                                    | Pixels (P5)                               |

## 3. Parts

The parts come from the slots of the target contract. Each slot has one region or none. The descriptor names the slot of each part region.

### 3.1 Required parts (18)

`hair_back`, `head`, `hair_front`, `neck`, `torso`, `hips`, and the near and far limb segments `upper_arm_*`, `forearm_*`, `hand_*`, `thigh_*`, `shin_*`, `foot_*`.

Each required limb segment is a separate part. A full arm or a full leg in one region is not compatible, because the skeleton needs one image for each bone. Near and far limbs are separate parts, also when they look the same. A sheet can supply one far limb as a copy of the near limb only through a recorded manual step (see [section 4](#4-geometry)).

### 3.2 Optional parts (9)

`tail`, `ear_far`, `ear_near`, `skirt_back`, `skirt_front`, `hair_tail`, `acc_head`, `weapon`, `hand_near_front`.

Each optional slot is either mapped to one part region or listed in `absentSlots`. A slot in `absentSlots` becomes `absent_by_design` in `character.json` (D22). The descriptor must declare every optional slot. A missing declaration is an error (E_SHEET_SLOT_UNDECLARED), because "not found" and "absent by design" must not look the same.

### 3.3 Visual decorations

A decoration that moves with one body part (a bracelet, a belt, a hair clip, a shoulder pad) is part of the art of that part. It goes into the same region. It does not get a slot. A decoration that needs its own motion needs a slot in the rig contract. That is a rig contract decision, not a sheet decision.

### 3.4 Equipment and held objects

A held object (sword, staff, gun) is the `weapon` part or it is absent. It is drawn without the hand. The `hand_near_front` part (fingers in front of a grip) is optional. The mount points of [the future Equipment System](ROADMAP.md#future-equipment-system-v2) (`grip`, `muzzle`, `fx_hit`) are contract points. They are not sheet content in v0.1. If a sheet shows an object in the hand, the object and the hand are one region, and the sheet **requires regeneration** or manual separation.

### 3.5 Reference-only elements

An assembled preview, a turnaround, a face close-up, a color palette, or text is reference content. It goes into a `reference` or `ignore` region. The pipeline never imports it. The reference preview is useful for the human check of scale and proportion, but a tool must not take art from it.

## 4. Geometry

| ID  | Requirement                                                                                                                                                                                                                                                                                                                      | Check                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| G1  | Scale: all parts use one scale. The optional `scale.sheetPxPerContractPx` records it. For the synthetic sheet it is 1. A real sheet can use another scale. The scale of each part is checked in V2-3 against the attachment rectangle of its slot.                                                                               | V2-3 (geometry), human          |
| G2  | Orientation: each part is drawn in the rest pose of the target contract (`three_quarter_right`, near side on the image left), upright, not mirrored, not rotated. A part drawn in another angle **requires regeneration** or a recorded manual rotation.                                                                         | Human                           |
| G3  | Joint overlap: a parent limb segment has extra art past its child joint (the overlap circle of the contract, 24 px at contract scale). The child part covers the joint. Without overlap, a gap shows when the joint turns. The L0-1e to L0-1g studies show the effect.                                                           | V2-3 (geometry), human          |
| G4  | Hidden geometry: each part is complete, also where another part covers it in the assembled pose (for example the upper end of the thigh under the hips). Art that the source image cuts off must not be cut off on the sheet.                                                                                                    | Human                           |
| G5  | Near and far: the slot name decides the side. The sheet does not have to put near parts on the left. The descriptor gives the side through the slot id. The position of a region on the sheet has no meaning.                                                                                                                    | Descriptor, human               |
| G6  | Sheet to skeleton: the rig contract gives the bone joints and the attachment rectangles. The optional `joints` of a region give the sheet position of the slot bone joint and of the overlap child joints. If they are absent, V2-3 derives them from the attachment rectangle (an assumption).                                  | Descriptor, V2-3                |
| G7  | Deviations and manual corrections: a correction is a change to the descriptor (box, slot, joints) with `origin: "manual"` and an optional `note`. A change to the pixels (cleanup, copy, rotation) is a separate, recorded preprocessing step that makes a new sheet file with a new SHA-256. The descriptor binds to that file. | Descriptor (sha256), provenance |

## 5. Layout descriptor

Schema: [`packages/control/schemas/modular-sheet.schema.json`](../packages/control/schemas/modular-sheet.schema.json) (draft 2020-12). Run-time check: `parseSheetDescriptor` (structure) and `parseModularSheet` (structure and target contract) in `@aigg/control`. A test keeps the schema and the parser in agreement.

```json
{
  "format": "aigg.modular-sheet/0.1",
  "sheet": { "file": "synthetic-sheet.png", "sha256": "<64 hex>", "width": 1600, "height": 1717 },
  "rig": { "rigId": "humanoid_girl_v1_c05_candidate", "contractVersion": "0.3.0" },
  "scale": { "sheetPxPerContractPx": 1 },
  "regions": [
    {
      "id": "part_forearm_near",
      "role": "part",
      "box": { "x": 811, "y": 948, "w": 81, "h": 252 },
      "slot": "forearm_near",
      "joints": { "forearm_near": { "x": 859, "y": 981 }, "hand_near": { "x": 844, "y": 1167 } },
      "origin": "tool"
    },
    { "id": "reference_preview", "role": "reference", "box": { "x": 32, "y": 1301, "w": 256, "h": 384 }, "origin": "tool", "note": "Assembled preview. Never imported." }
  ],
  "absentSlots": ["tail", "ear_far", "skirt_back", "skirt_front", "ear_near", "hair_tail", "acc_head", "weapon", "hand_near_front"]
}
```

### 5.1 Fields and their reason

| Field                                 | Reason                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `format`                              | Schema version. An unknown `aigg.modular-sheet/*` version fails with E_SHEET_VERSION, not with a guess.                      |
| `sheet.file`, `sheet.sha256`          | Source identity. The descriptor is valid only for these exact bytes. A cleaned or changed sheet needs a new descriptor.      |
| `sheet.width`, `sheet.height`         | Canvas size. The parser checks that each box is inside the canvas before it reads the image.                                 |
| `rig.rigId`, `rig.contractVersion`    | Target contract. A mismatch fails (E_SHEET_RIG_MISMATCH).                                                                    |
| `scale` (optional)                    | The scale of the sheet relative to the contract canvas, for the V2-3 checks. Not used in V2-1.                               |
| `regions[].id`                        | A unique, stable name for reports and corrections.                                                                           |
| `regions[].role`                      | `part`, `reference`, or `ignore`. Only a part has a slot or joints. This keeps reference art out of the import.              |
| `regions[].box`                       | The bounding rectangle in integer sheet pixels. Boxes must not overlap, so each sheet pixel belongs to at most one region.   |
| `regions[].slot`                      | The slot mapping. Required for a part.                                                                                       |
| `regions[].joints` (optional)         | Sheet positions of the slot bone joint and of the overlap child joints. Each joint is inside the box.                        |
| `regions[].origin`, `note` (optional) | Who made the entry (`manual` or `tool`) and a short comment. They record manual work, so that it is not shown as automation. |
| `absentSlots`                         | The optional slots that are absent by design.                                                                                |

The descriptor has no confidence field. In v0.1 every entry is either made by a tool from known geometry (the synthetic sheet) or written by a human. A confidence value would suggest an automatic classifier that does not exist. A later classifier can add one in a new format version.

The descriptor has no polygon masks, no per-part rotation, and no pivot other than joints. Boxes and the transparent background are sufficient to separate parts on a compatible sheet. If a real sheet needs more, that is an open decision for V2-2 (see [section 10](#10-open-decisions-that-affect-v2-2)).

### 5.2 Contract rules that the schema cannot express

`parseModularSheet` adds these checks. Each one has its own error code. The parser reports all problems at once.

| Code                       | Rule                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| `E_SHEET_REGION_DUPLICATE` | Region ids are unique.                                                                             |
| `E_SHEET_BOX_OUTSIDE`      | Each box is inside the canvas.                                                                     |
| `E_SHEET_BOX_OVERLAP`      | No two boxes overlap. Boxes that only touch are permitted.                                         |
| `E_SHEET_RIG_MISMATCH`     | `rig` names the target contract.                                                                   |
| `E_SHEET_SLOT_UNKNOWN`     | Each slot id exists in the contract.                                                               |
| `E_SHEET_SLOT_DUPLICATE`   | Each slot has at most one region.                                                                  |
| `E_SHEET_REQUIRED_MISSING` | Each required slot has a part region.                                                              |
| `E_SHEET_ABSENT`           | An absent slot is known, optional, not mapped, and listed once.                                    |
| `E_SHEET_SLOT_UNDECLARED`  | Each optional slot is mapped or absent.                                                            |
| `E_SHEET_JOINT`            | A joint names the slot bone or an overlap child bone of the slot, and it is inside the region box. |
| `E_SHEET_ROLE`             | A part has a slot. A reference or ignore region has no slot and no joints.                         |

### 5.3 Is the descriptor required?

Two different statements:

- **Architecture: optional.** A sheet is a valid input to the pipeline without a descriptor. A future tool can propose regions and a mapping from the pixels. Without a descriptor, the pipeline knows only the connected foreground components. It does not know which component is which slot, which side it is, or which content is reference art.
- **Execution mode of the MVP: required.** The deterministic MVP extraction (V2-2) runs only with a descriptor. The descriptor carries all the semantic decisions (slot, side, role, absent). The tools check what the pixels can show. No step guesses a slot from a shape.

An absent descriptor must never mean "the classification is reliable". A tool that proposes a descriptor writes `origin: "tool"` entries, and a human checks them before extraction.

## 6. Pixel checks and semantic checks

The command `aigg-control sheet-check` runs the descriptor parser and the pixel checks. It writes `sheet-check.json`. Exit status 0 means PASS, 1 means FAIL, 2 means a usage or input error.

**Verifiable from pixels and the descriptor (automatic):**

| ID  | Check                                                                        |
| --- | ---------------------------------------------------------------------------- |
| P1  | The file SHA-256 is the `sheet.sha256` of the descriptor.                    |
| P2  | The image size is the size of the descriptor.                                |
| P3  | The PNG has an alpha channel.                                                |
| P4  | Each part region has at least 64 foreground pixels.                          |
| P5  | No foreground pixel is outside all region boxes. Weak alpha is only counted. |

The report also gives, for each region, the foreground and weak-alpha pixel counts, the tight bounds of the foreground, and the number of 8-connected components. More than one component is permitted (for example strands of hair, or the overlap circle of a mock part) and is only reported.

**Needs semantic or human validation (not automatic in v0.1):**

- The art in a region is the slot that the descriptor names (a forearm is not a shin).
- Near and far are correct.
- The view and the rest pose match the contract (G2).
- Hidden geometry and joint overlap are present (G3, G4).
- No shadow or effect is outside the silhouette (I8).
- A region does not contain two parts, or a part and a held object.
- The content rules of [AGENTS.md](../AGENTS.md#content-rules) are kept.

V2-3 adds geometric checks (scale against the attachment rectangle, joint positions against the contract). They are numeric, but they cannot prove that the art is correct.

## 7. Synthetic test sheet

The command `aigg-control sheet-fixture --contract <C0.5 candidate> --out <dir>` makes the synthetic sheet. Tests make it at test time. The PNG is not committed (the repository rejects tracked images). The committed fixture is the descriptor and the expected values in [`packages/control/test/fixtures/modular-sheet/`](../packages/control/test/fixtures/modular-sheet/).

Construction (deterministic, no art, no model, no network):

1. Run the T1a `template` command on the C0.5 candidate contract. Take the 18 required mock parts (`mock-package/parts/<slot>.png`). Each part has the size of its attachment rectangle, at contract scale 1.
2. Put the parts on shelves in contract draw order. Width 1600, margin 32, gap 32.
3. Make a reference preview: composite the mock parts at their attachment rectangles in draw order on the 1024 × 1536 contract canvas, and reduce it by 4 (nearest pixel) to 256 × 384.
4. Write the descriptor. Each part region is the full part image box. Joints are the contract joints of the slot bone and of the overlap child bones, moved to the sheet, if they are inside the box. All 9 optional slots are in `absentSlots`.
5. Run the pixel checks.

Results (Node.js 22 in the agent container, @aigg/control 0.15.0):

| Value                  | Result                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Sheet size             | 1600 × 1717                                                                                                          |
| Regions                | 19: 18 parts (9 near and far limb pairs and 6 center parts), 1 reference preview                                     |
| Absent optional slots  | 9 (`tail`, `ear_far`, `skirt_back`, `skirt_front`, `ear_near`, `hair_tail`, `acc_head`, `weapon`, `hand_near_front`) |
| Pixel hash (RGBA data) | `424e678b9e98e345f96c6090e70c978c6324c2af811a16b27841bd7a8c5f1aba`                                                   |
| File SHA-256           | `cd99e82af557e1f5bf29de83a925d6f0836f5f1089079fc8cc0a7e470ff73669` (depends on the zlib version)                     |
| Checks P1 to P5        | PASS                                                                                                                 |
| Weak alpha             | 0 in all regions and outside                                                                                         |
| Components             | 1 in each region, except `forearm_near` with 3 (the mock overlap circle is separate from the tube)                   |

`expected.json` records the tight bounds and the foreground count of each region. Tests compare the pixel hash, not the file hash, because the PNG compressor output can change with the zlib version of Node.js.

**Limit.** The synthetic sheet shows that the contract, the schema, the parser, and the pixel checks agree. It does not show that an AI-generated sheet is compatible. Its parts are flat colors with perfect alpha, perfect separation, and exact contract geometry.

## 8. Real AI-generated sheet: compatibility assessment

**Status: done for one sheet.** The owner supplied one real AI-generated sheet (a silver-haired anime chibi fantasy adventurer, about 3.5 heads tall, with a small assembled preview) and its prompt. The result is in [the real sheet assessment](proposals/V2_1_REAL_SHEET_ASSESSMENT.md). In summary: transparency and separation are correctable by a recorded alpha step. The fused feet, the separate face features, and the chibi proportions block this sheet for the C0.5 contract. This sample does not change the requirements of this contract.

The assessment uses this table. Each problem gets one class: **Contract-compatible**, **Correctable by simple preprocessing**, **Requires human metadata**, **Requires regeneration**, or **Cannot be determined from one sheet**.

| #   | Point                                     | How to assess                                                                                                                |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Format and dimensions                     | PNG header: color type, bit depth, size (I1, I2).                                                                            |
| 2   | Alpha                                     | Alpha histogram: share of alpha 0, weak alpha, and 255 (I3, I5).                                                             |
| 3   | Background contamination                  | Opaque or checker background, halo colors at the edges (I3, I8).                                                             |
| 4   | Part candidates                           | Connected components at alpha ≥ 16, and their sizes (I5).                                                                    |
| 5   | Touching and overlap                      | Components that hold two parts, or a part and a held object (I7, section 3.4).                                               |
| 6   | Scale consistency                         | Part sizes against each other and against the preview (G1). A chibi body is expected to fail the C0.5 proportions (7 heads). |
| 7   | Differences from the required attachments | Missing segments (for example one full arm instead of three parts), missing far limbs (3.1).                                 |
| 8   | Reference-only art                        | The preview and any text (I9, I10).                                                                                          |
| 9   | Automatic bounding-box extraction         | Do the component bounds give one box for each part, with no overlap?                                                         |
| 10  | Manual descriptor                         | Can a human-written descriptor resolve the remaining ambiguities, or does the sheet need regeneration?                       |

The image and its derivatives are owner test data. They are not repository fixtures without explicit owner authorization.

## 9. Recommended V2-2 approach

**Implemented as a prototype** by `aigg-control sheet-extract`. See [V2-2 sheet extraction](proposals/V2_2_SHEET_EXTRACTION.md). The approach below was the proposal:

1. Input: one sheet PNG and one descriptor that passes `sheet-check`. No descriptor, no extraction.
2. For each part region, copy the pixels inside the box to a new PNG of the box size. Copy only, no resampling, no color change. A pixel belongs to the unique box that contains it (boxes do not overlap). Weak alpha stays as it is in v0.1 (open decision D-S3).
3. Write a region report: for each part, the source box, the output size, the pixel hash, and the joint positions in part coordinates.
4. Acceptance on the synthetic sheet: an exact partition. The union of the extracted parts and the reference region is equal to the foreground of the sheet. No pixel is lost, duplicated, or changed. A broken descriptor fails before any write.
5. Reuse `png.ts`, `raster.ts`, and `output.ts` (safe output directory, dry run). No new package, no new dependency.
6. Then V2-3 places each part at its attachment rectangle with the joints, and V2-4 reuses the existing skeleton builder of MVP-A.

This approach does not classify regions, segment art, or fix touching parts. Those stay human steps until a sheet shows that they are the blocker.

## 10. Open decisions that affect V2-2

These are open. Only the owner closes them.

| ID   | Question                                                                                                                               | Recommendation                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| D-S1 | Is the descriptor required for the MVP extraction (section 5.3)?                                                                       | Yes, required in the MVP. Optional in the architecture.                                 |
| D-S2 | Boxes only, or also polygon masks for parts that cannot be separated by boxes?                                                         | Boxes only in v0.1. Decide after the real sheet assessment.                             |
| D-S3 | Weak alpha (1 to 15): keep, set to 0, or report only?                                                                                  | Keep in the extracted part, report the count. Do not change pixels in V2-2.             |
| D-S4 | Opaque background: does V2-2 accept a recorded background-removal step, or must the sheet be transparent?                              | The sheet must be transparent. A removal step is a separate recorded tool (later).      |
| D-S5 | Joint positions: from the contract (attachment rectangle) or from the sheet (descriptor joints)? Same as ADR open question 3.          | Contract by default. Descriptor joints override when present.                           |
| D-S6 | Target geometry for the first real sheet: the C0.5 candidate (7 heads) or another proportion (for example a chibi sheet at 3.5 heads)? | C0.5 for V2-2 to V2-5. A chibi body needs its own rig contract decision (not in scope). |
| D-S7 | Source and rights of the first real sheet (ADR open question 1).                                                                       | Owner decision. Keep it out of Git until authorized.                                    |

## 11. Limits and residual risks

- **Trust.** The descriptor and the sheet are untrusted input. The parser rejects unknown fields, bounds every number, limits the number of regions to 256 and the file to 1 MiB, and checks the PNG header before it inflates the pixels. A large valid sheet (32 Mpx) still needs about 128 MiB of memory for the raster plus one byte for each pixel for the region map.
- **Not checked.** The semantic rules in [section 6](#6-pixel-checks-and-semantic-checks). A descriptor can name a wrong slot and still pass.
- **Prototype geometry.** The target is the C0.5 candidate contract. It is not production geometry. Animations are not declared compatible until verified on the real Spine runtime.
- **One real sheet.** Only one real AI sheet is assessed (section 8). The compatibility of AI sheets in general is not known.
