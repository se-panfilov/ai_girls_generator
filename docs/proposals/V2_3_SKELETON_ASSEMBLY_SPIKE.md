# V2-3 spike: extracted parts on the C0.5 skeleton

**Status: HACK-FIRST spike (prototype, draft).** Step 3 of [the Pipeline v2 MVP core](../ROADMAP.md#pipeline-v2--mvp-core), with a first look at step 4. The owner has not approved this step, its output format, or the C0.5 candidate as production geometry.

The command `aigg-control sheet-assemble` puts the 18 parts of one [V2-2 extraction](V2_2_SHEET_EXTRACTION.md) on the C0.5 candidate skeleton and writes a Spine 4.3 skeleton JSON with the MVP-A demonstration animations `idle` and `wave`. It reuses the MVP-A builder (`buildBodySkeleton`), the local renderer (`renderPose`), and `demoAnimations` from [MVP-A](MVP_A_FULL_BODY_ASSEMBLY.md). It adds no bone, slot, or animation.

## Contents

- [1. Command](#1-command)
- [2. Joint policy and coordinates](#2-joint-policy-and-coordinates)
- [3. Output](#3-output)
- [4. Results on the synthetic sheet](#4-results-on-the-synthetic-sheet)
- [5. Known defects and limitations](#5-known-defects-and-limitations)
- [6. Status of V2-3 and V2-4](#6-status-of-v2-3-and-v2-4)

## 1. Command

```sh
C=packages/control/test/fixtures/c05-candidate/rig.contract.json
node packages/control/dist/src/cli.js sheet-fixture --contract $C --out ./v2-sheet
node packages/control/dist/src/cli.js sheet-extract --contract $C --descriptor ./v2-sheet/synthetic-sheet.json --sheet ./v2-sheet/synthetic-sheet.png --out ./v2-parts
node packages/control/dist/src/cli.js sheet-assemble --contract $C --extraction ./v2-parts --out ./v2-assembly
```

The 18 PNG files come from the real V2-2 extractor, not from the T1a mock package. `sheet-assemble` checks that the manifest names the same contract (rig id, version, SHA-256), that each contract slot is a part or absent by design, and that each part file has the file and pixel SHA-256 of the manifest. Part files are read as `parts/<slot>.png`, with the slot id from the manifest (snake_case only).

## 2. Joint policy and coordinates

Owner decision for this spike:

- The skeleton uses the contract joints. All 28 bones are at their C0.5 contract joints. The skeleton is not changed for a character.
- A descriptor joint of the slot bone places the part: `part box corner = contract joint − local joint`, rounded to whole pixels. The rounding is recorded.
- Without such a joint, the part goes to its contract attachment rectangle.
- Other descriptor joints of the part (overlap child joints) are compared with their contract joints after the placement (`jointResiduals`). The check fails above the contract tolerance (2.5 % of the canvas height, 38.4 px).
- The part size is compared with the attachment rectangle (`scale`). There is no resampling. A size difference fails the `scale` check.

| Frame  | Units and origin                                                                            |
| ------ | ------------------------------------------------------------------------------------------- |
| Sheet  | V2-2 source sheet px, y down (`sourceBox` in `extraction.json`).                            |
| Part   | px of the extracted PNG, origin at its top-left corner (local joints in `extraction.json`). |
| Canvas | Contract canvas px (1024 × 1536), y down. The box of each part is in this frame.            |
| Spine  | Spine units, y up, origin at the contract `rigOrigin` (512, 1490), 1 unit = 1 canvas px.    |

## 3. Output

The layout is the MVP-A layout, so `spine-validate` can read it: `spine/skeleton.json`, `spine/images/<slot>.png` (the extracted bytes, unchanged), `character.json` (the existing D22 sidecar, `absent_by_design` for the 9 optional slots), `evidence/assembly.json` (placements, joint policy, frames, checks), `previews/setup.png`, `previews/wave.png`, `previews/idle.png` (local renderer, not Spine), `SHA256SUMS`, and `PIXEL-SHA256SUMS`.

## 4. Results on the synthetic sheet

Agent run in the container (Node.js 22, @aigg/control 0.17.0). Tests: [`packages/control/test/sheetassembly.test.ts`](../../packages/control/test/sheetassembly.test.ts). The images are not in Git. They are in the project files (`research/v2-3-spike/`).

| Check                                                            | Kind                                   | Result                                                                                  |
| ---------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------- |
| 18 parts with region attachments, 9 empty optional slots         | Offline                                | PASS                                                                                    |
| 28 bones with the contract parents, 27 slots in contract order   | Offline                                | PASS                                                                                    |
| Bones on the contract joints                                     | Offline                                | PASS (largest error 6.3e-5 px)                                                          |
| Descriptor joint placement against the attachment rectangles     | Offline                                | 0 px offset, 0 px joint residual, scale 1 for all 18 parts                              |
| Spine Essential subset, region attachments, animations           | Offline (MVP-A checks)                 | PASS                                                                                    |
| Setup pose render equals the placed parts in draw order          | Local renderer                         | PASS (0 different pixels)                                                               |
| `wave` at t = 1 s moves the near arm                             | Local renderer                         | PASS: the near wrist moves 637.9 px, hips and legs 0 px, 108,480 pixels change          |
| Near shoulder, elbow, wrist have art in setup and wave           | Local renderer                         | PASS                                                                                    |
| spine-core 4.3 reads the JSON; wave joints equal the local model | Real runtime, stand-in atlas (test)    | PASS (difference below 1e-3)                                                            |
| Browser playback in `@aigg/viewer`                               | Real Spine web runtime, stand-in atlas | Page status `Ready: 28 bones, 27 slots, 2 animations`; idle and wave play (screenshots) |
| Spine Editor CLI import and export (`spine-validate`)            | Not done                               | Needs the owner's licensed Spine                                                        |

The browser run used headless Chromium (SwiftShader WebGL) in the agent container and a stand-in atlas: one atlas page for each region PNG, no packing, no resampling. This atlas is a scratch file outside the repository. It is not a Spine export. The run shows that the skeleton JSON and the parts play in the Spine web runtime. It does not replace the Spine CLI export.

## 5. Known defects and limitations

- **Synthetic art.** The parts are the flat T1a mock parts at contract scale. The hair parts are hatched rectangles. A real sheet is not tested.
- **Shoulder seam.** In the wave pose, the near upper arm turns about the shoulder joint on top of the torso. The mock parts have the contract overlap circles, so no gap shows at the elbow and the wrist. The shoulder looks acceptable for flat art; a real sheet can show a seam.
- **Far arm moves a little.** `wave` turns `chest` by 2°, so the far arm and the head move a little. This is the MVP-A animation, unchanged.
- **Leaf bones.** Bones without children (hands, feet, head, ears) have no direction (local rotation 0, length 0). It does not change the art, only the bone display in Spine.
- **Scale.** `extraction.json` does not carry `scale.sheetPxPerContractPx`. The spike compares the part size with the attachment rectangle. A real sheet at another scale fails the `scale` check; a scale step (Spine region scale or recorded resampling) is a separate decision.
- **Placement only by translation.** No rotation and no per-part fit. A real part drawn at another angle needs regeneration or a recorded correction (contract G2).
- **Animations.** `idle` and `wave` are the MVP-A demonstration animations, not the version 1 animation set (D5).

## 6. Status of V2-3 and V2-4

- **V2-3 (mapping and geometry): spike works on the synthetic sheet.** It is not ready as a production step. Open: a real sheet that passes `sheet-check`, the scale rule, and the owner review of the joint policy above (D-S5 stays open in the decision log).
- **V2-4 (Spine package): preliminary evidence only.** The JSON reads in spine-core and plays in the web viewer with a stand-in atlas. The real check is an owner run: `spine-validate --package <assembly dir>` on the Mac, then `aigg-viewer` on its export folder. That is the smallest remaining action for web playback from a Spine export.
