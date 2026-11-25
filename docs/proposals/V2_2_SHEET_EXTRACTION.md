# V2-2: deterministic modular sheet extraction

**Status: implemented as a prototype (draft).** Step 2 of [the Pipeline v2 MVP core](../ROADMAP.md#pipeline-v2--mvp-core). Input contract: [Modular Sheet Contract v0.1](../PIPELINE_V2_MODULAR_SHEET.md) (proposed). The owner has not approved the contract, the output format, or this step.

The command `aigg-control sheet-extract` converts one validated modular sheet PNG and its layout descriptor into one independent PNG for each part region and a manifest. The output is an intermediate result for V2-3. It is not a character package and does not change `character.json`.

## Contents

- [1. Scope](#1-scope)
- [2. Command](#2-command)
- [3. Behavior](#3-behavior)
- [4. Output](#4-output)
- [5. Failures and file system](#5-failures-and-file-system)
- [6. Evidence on the synthetic sheet](#6-evidence-on-the-synthetic-sheet)
- [7. Real AI-generated sheet](#7-real-ai-generated-sheet)
- [8. Limitations](#8-limitations)
- [9. Recommended next action (V2-3)](#9-recommended-next-action-v2-3)

## 1. Scope

The owner's V2-2 task sets these rules. They apply to this step only. They do not close the open decisions D-S1 to D-S6 in [the contract, section 10](../PIPELINE_V2_MODULAR_SHEET.md#10-open-decisions-that-affect-v2-2). Only the owner closes them.

| Rule                                                                                   | Related open decision |
| -------------------------------------------------------------------------------------- | --------------------- |
| The descriptor is required. It is the only source of the slot mapping.                 | D-S1                  |
| Rectangular boxes only. Boxes must not overlap.                                        | D-S2                  |
| RGBA values are copied without a change. Weak alpha is counted, not changed.           | D-S3                  |
| The sheet must have an alpha channel. No background removal in this step.              | D-S4                  |
| Descriptor joints are copied and moved to part coordinates. No joint is made from art. | D-S5                  |
| Target: the C0.5 candidate contract (`humanoid_girl_v1_c05_candidate` 0.3.0) in tests. | D-S6                  |

Not in scope: skeleton binding, pivots, attachment offsets, Spine JSON, web playback, automatic part identification, image cleanup, polygon masks, rotation, resizing, a new rig contract, a new package, and factory changes.

## 2. Command

```sh
node packages/control/dist/src/cli.js sheet-extract --contract packages/control/test/fixtures/c05-candidate/rig.contract.json \
  --descriptor ./v2-sheet/synthetic-sheet.json --sheet ./v2-sheet/synthetic-sheet.png --out ./v2-parts
```

`--dry-run` runs all checks and the extraction in memory, prints the report, and writes nothing. `--force` is refused (see [section 5](#5-failures-and-file-system)). Exit status: 0 PASS, 1 FAIL (the sheet or an extraction check fails, nothing is written), 2 usage or input error (nothing is written).

## 3. Behavior

1. Parse the descriptor with `parseModularSheet` (V2-1): schema rules, unique ids, boxes inside the canvas, no overlap, rig id and version, known slots, each required slot mapped, each optional slot mapped or absent, joints of the slot bone or its overlap child bones, joints inside the box.
2. Run the V2-1 pixel checks P1 to P5 with `checkSheetImage`: file SHA-256, size, alpha channel, non-empty parts, no foreground outside the region boxes. A FAIL stops the command. No file is planned.
3. For each contract slot, in contract order: if a part region maps to it, copy the RGBA bytes of the box to a new raster of the box size and encode it as `parts/<slot>.png`. Otherwise record the slot as `absent_by_design`.
4. Decode each encoded part again and compare the RGBA bytes with the source box (X3).
5. Copy each descriptor joint and compute its part coordinates: `local = sheet - box origin`. The joint coordinates are continuous. A joint can be on the box edge (`local.x = w`). The difference of a double and an integer below 2^52 is exact, and the command checks that `local + origin = sheet` (X5).
6. Count the sheet foreground (alpha >= 16) and check the partition (X4): sheet foreground = part foreground + reference and ignore foreground, no pixel in two boxes, no foreground outside the boxes.

Reference and ignore regions are never parts. The file name of a part comes from the contract slot id, not from the region id or any other descriptor text.

## 4. Output

| File                     | Content                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `parts/<slot>.png`       | 8-bit RGBA PNG of the exact box pixels. One file for each part region.                                                      |
| `extraction.json`        | Manifest, format `aigg.modular-sheet-extraction/0.1` (below).                                                               |
| `extraction-report.json` | Validation report, format `aigg.modular-sheet-extraction-report/0.1`: checks X1 to X5, the full sheet check, the partition. |
| `SUMMARY.md`             | Short human-readable summary. It does not copy descriptor notes.                                                            |
| `SHA256SUMS`             | SHA-256 of each other file (`shasum -a 256 -c SHA256SUMS` on macOS).                                                        |

Manifest fields:

| Field               | Content                                                                                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool`              | `@aigg/control`, command, package version.                                                                                                                                                                                                                 |
| `source.sheet`      | The declared file name (descriptor data only, never used as a path), file SHA-256, pixel SHA-256, size, color type, ignored PNG chunks.                                                                                                                    |
| `source.descriptor` | Format and SHA-256 of the descriptor bytes.                                                                                                                                                                                                                |
| `rig`               | Rig id, contract version, contract SHA-256.                                                                                                                                                                                                                |
| `pixelPolicy`       | `copy: exact`, straight alpha, the foreground threshold (16).                                                                                                                                                                                              |
| `counts`            | Contract slots, required, extracted, absent by design, excluded regions.                                                                                                                                                                                   |
| `parts[]`           | Slot, slot bone, region id, origin, file, source box, output size, file SHA-256, pixel SHA-256, alpha counts (0, 1–15, 16–254, 255), foreground pixels, local foreground bounds, components, joints (`supplied` with sheet and local points, or `absent`). |
| `absentSlots[]`     | Slot, slot bone, `absent_by_design`.                                                                                                                                                                                                                       |
| `excludedRegions[]` | Reference and ignore regions: id, role, box, foreground and weak-alpha counts.                                                                                                                                                                             |

The manifest has no time stamps and no input paths, so the same inputs and tool version give the same bytes. The pixel SHA-256 does not depend on the PNG compressor. The file SHA-256 can change with the zlib version of Node.js.

## 5. Failures and file system

- All inputs are validated before the first write. A descriptor error gives `ERROR` (exit 2) with all problems. A sheet check FAIL gives `FAIL` (exit 1) with the check report. In both cases nothing is written, and the output directory is not made.
- The result is published as one directory: the files are written to a new hidden temporary directory next to the target, and the directory is renamed. The target has all files or none.
- The target must not exist, or must be an empty real directory. A non-empty directory gives `E_OUTPUT_EXISTS`. A symbolic link is refused. `--force` is refused, so an earlier result is never replaced or mixed with new files.
- Size limits: the V2-1 sheet limits (8192 px each side, 32 Mpx, 128 MiB) are checked from IHDR before the pixel data is inflated. The descriptor is at most 1 MiB.
- Memory: the sheet is decoded twice (check and extraction), one raster at a time, plus two bytes for each sheet pixel for the partition maps.

## 6. Evidence on the synthetic sheet

Agent run in the container (Node.js 22, @aigg/control 0.16.0), on the V2-1 synthetic sheet (1600 × 1717, pixel SHA-256 `424e678b…1aba`). Tests: [`packages/control/test/sheetextract.test.ts`](../../packages/control/test/sheetextract.test.ts).

| Test                                                                                                   | Result |
| ------------------------------------------------------------------------------------------------------ | ------ |
| 18 required parts extracted, 9 optional slots `absent_by_design`, 27 of 27 slots accounted             | PASS   |
| Slot identity: the pixels of each part equal the T1a mock part of the same slot                        | PASS   |
| Pixel fidelity: each decoded part equals its source box, pixel by pixel                                | PASS   |
| Partition: each pixel with alpha > 0 is in at most one part; all non-reference foreground is in a part | PASS   |
| The reference preview is not a part and has no file                                                    | PASS   |
| Boxes and output sizes equal the descriptor boxes                                                      | PASS   |
| Joints: local = sheet − origin; 2000 seeded random fractional points round-trip exactly; edge joints   | PASS   |
| Weak alpha (5), alpha 254, and the color of an alpha 0 pixel are kept; weak alpha is counted           | PASS   |
| Determinism: two runs give byte-identical files (API and CLI); no time stamps or input paths           | PASS   |
| Wrong SHA-256, foreground outside regions, missing slot, overlap, malformed JSON, path-like names fail | PASS   |
| CLI: nothing is written on a failure; non-empty output and `--force` refused; dry run writes nothing   | PASS   |

Sheet foreground: 345,051 pixels = 325,378 in parts + 19,673 in the reference preview. Lost: 0. In two boxes: 0.

**Limit.** This shows that the extractor is exact and deterministic on a sheet with flat colors, perfect alpha, and contract geometry. It does not show that an AI-generated sheet is compatible.

## 7. Real AI-generated sheet

Not tested in this step. The Prompt v2.2 sheet is not available yet. The earlier chibi sheet ([assessment](V2_1_REAL_SHEET_ASSESSMENT.md)) is known to fail the v0.1 contract (overlapping tight boxes, fused feet). It stays outside Git. With the same descriptor, `sheet-extract` stops at the descriptor check (`E_SHEET_BOX_OVERLAP`) or the sheet check, as `sheet-check` does. Real-art compatibility is pending.

## 8. Limitations

- The slot mapping comes from the descriptor only. A descriptor can name a wrong slot and still pass.
- Boxes only. A part that cannot be separated by a non-overlapping box needs a new sheet or a later contract version.
- Weak alpha and color fringes stay in the parts. A cleanup step, if needed, is a separate recorded tool that makes a new sheet with a new SHA-256.
- A part PNG has the size of its box. Transparent margins are kept. Trimming, if needed, belongs to V2-3 and must keep the joint transform.
- No check of scale, joint positions against the contract, or joint overlap (V2-3).
- The C0.5 candidate is prototype geometry, not a production contract.

## 9. Recommended next action (V2-3)

**Proposed.** Map the extracted parts to the skeleton with `extraction.json` as the only input besides the contract:

1. For each part, compute the scale against the attachment rectangle of its slot, and check it against `scale.sheetPxPerContractPx` (G1).
2. Place each part with its local joints where present, or from the attachment rectangle where absent (D-S5 recommendation), and report the joint error.
3. Write the part placement in the existing canonical form (attachment rectangles and pivots) for V2-4, which reuses the MVP-A skeleton builder.

Blockers for V2-3: the owner decision on D-S5 (joint source), and one real sheet that passes `sheet-check`, so that V2-3 is not built on synthetic data only.
