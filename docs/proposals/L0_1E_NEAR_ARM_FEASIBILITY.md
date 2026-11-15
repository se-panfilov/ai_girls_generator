# L0-1e: near arm cutting and rotation feasibility

**Draft. Research step.** Status: complete. Result: the cut is **PASS**, the source pose is **PASS**, rotation without new pixels is **PARTIAL** (section 6).
This report does not approve a joint, a pivot, a cut, a part, or a package. The parts are not Spine attachments. The test angles are diagnostic values, not animation limits. The study does not change the C0.5 template, the rig contract, the bone ids, the weapon slots, the manual marks, or the art.

## tl;dr

We cut the image-left (near) arm of the test concept into an upper arm, a forearm, and a hand. The cut lines go through the shoulder, elbow, and wrist points that the owner marked in L0-1d. The three parts hold every source pixel exactly once, and they put the source image back together without a difference of one byte.

Then we turned the elbow and the wrist by 10 to 30 degrees. Every turn opens a small gap at the joint (24 to 166 pixels), because the source art has no pixels under the joint. The C0.5 rule needs about 1,470 pixels of hidden "underlay" in total for the elbow and the wrist. Without new pixels, small turns are usable for a test only. A production limb needs a small repaint of the underlay at each joint. A generative model is not necessary for this arm.

## 1. Scope and rules

- Target: the image-left arm of the handwear layer. This is the near arm under the L0-1c hypothesis (near = image-left), the arm without the sword.
- Parts: `upper_arm`, `forearm`, `hand`. Joints: `shoulder_image_left`, `elbow_image_left`, `wrist_image_left` from the owner's L0-1d file.
- Local Node.js only. No GPU, no Runpod, no model, no network.
- The tool copies source pixels only. It does not paint, fill, extend, blur, or generate a pixel. A rotation uses nearest-neighbor resampling, so each output pixel is a copy of one source pixel.
- Out of scope: the far arm, the legs, the skirt, the weapon slot, Spine export.

## 2. Inputs and provenance (task A)

| Input                                             | SHA-256 (start)                | Note                                                              |
| ------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `handwear.png` (L0-1b See-through run)            | `c6f9523b…`                    | Both arms in one layer. From the owner's run archive `c85fcea7…`. |
| `src_img.png` (See-through input)                 | `a8be1695…`                    | Same image as L0-1c and L0-1d.                                    |
| `concept-mirrored.psd.json` and 17 other layers   | see `inputs-sha256-before.txt` | Used only for the body around the arm in the rotation images.     |
| `landmarks-manual.json` (owner, L0-1d)            | `1417cfc5…7ede6`               | Same file as in the L0-1d phase B.                                |
| `correspondence.json` (L0-1d phase B align-study) | `c23d7d42…`                    | Gives the similarity scale 1.081 (image px to template px).       |
| C0.5 candidate `rig.contract.json`                | `2e5868b5…`                    | Overlap radius 24 template px at `forearm_near` and `hand_near`.  |

- `limb-study` refuses a study file whose recorded manual-file hash or image hash differs from the given files.
- The hashes of all inputs are equal before and after the runs (`inputs-sha256-before.txt` and `inputs-sha256-after.txt` in the project files).
- 24 template px are 24 / 1.081 = **22.2 image px**.

### 2.1 Joint marks

| Joint                 | Point (image px) | Visibility, confidence (owner) | Status in this study                                    |
| --------------------- | ---------------- | ------------------------------ | ------------------------------------------------------- |
| `shoulder_image_left` | 461.8, 271.5     | visible, high                  | Human estimate under the sleeve cap. Not a cut point.   |
| `elbow_image_left`    | 383.7, 454.4     | visible, high                  | Human estimate. The arm is almost straight (bend 0.7°). |
| `wrist_image_left`    | 320.0, 608.6     | visible, medium                | Human estimate at the top of the glove, below the band. |

The marks are human estimates, not confirmed anatomical joints. The study uses them as they are. It does not move them to get a better result. All three have the default method text and no reason per point (see L0-1d).

Picture before the cut: `1-joints-and-cut-lines.png` (axes, cut lines, overlap circles).

## 3. Cut (task B)

### 3.1 Method

1. The L0-1b method (`splitLayer`) separates the two arms of the handwear layer. The arm with the smaller mean x is the image-left arm.
2. Each cut line goes through a joint mark. The line normal is the mean of the two unit limb directions (the joint bisector): shoulder to elbow and elbow to wrist for the elbow, elbow to wrist and wrist to hand for the wrist. The hand direction goes from the wrist mark to the centroid of the arm pixels past the wrist. So the lines follow the limb axes. They are not image rows.
3. Pixel classes:
   - **Core**: in one part, farther than 1.5 px from a cut line.
   - **Boundary**: in one part, at most 1.5 px from its cut line. The pixel stays in its part, and it is flagged.
   - **Residual** (not in a part): fragments that are not connected to the main arm before the cut, pixels between crossed cut lines, and pixels that the cut separates from their part.
   - **See-through completed**: a part pixel (alpha ≥ 128) that differs from the input image by more than 32 in a channel. L0-1b made these pixels, not this study. They are counted, not removed.
   - **Needs pixels for rotation**: see section 4.

### 3.2 Result

| Value                        | Upper arm | Forearm | Hand  | Residual |
| ---------------------------- | --------- | ------- | ----- | -------- |
| Pixels (alpha > 0)           | 15,513    | 8,506   | 3,985 | 313      |
| Opaque pixels (alpha ≥ 128)  | 13,971    | 7,614   | 3,549 | –        |
| Boundary pixels              | 76        | 155     | 78    | –        |
| See-through completed pixels | 509       | 638     | 687   | –        |

- The upper arm includes the white sleeve. The forearm includes the wrist band. The wrist line goes through the top of the glove, because the wrist mark is there.
- Residual: all 313 px are small fragments of the arm layer that are not connected to the main arm (thin low-alpha bits at the outline). Crossed-line pixels: 0. Pixels that the cut separates from their part: 0.
- RGBA conservation: exact. 28,317 arm pixels in, 28,317 out, 0 lost, 0 duplicated, 0 changed, the alpha sum is equal (6,422,142). The whole handwear layer (with the far arm) is also an exact partition (50,431 px).
- Cut lines: elbow width 42.5 px, wrist width 52 px. The elbow mark is 4 px from the middle of the cut line, the wrist mark 4.8 px. Both marks are inside the arm.
- Images: `2-parts.png` (classes and the three parts moved apart), `parts/*.png` (each part and the residual in the full frame, source RGBA).

## 4. Joint overlap (task C)

C0.5 rule: the parent attachment covers a circle of 24 template px (22.2 image px) around the child pivot. The count uses alpha ≥ 128.

| Joint (parent → child)  | Circle px | Circle px inside the arm | Parent px in circle | Parent coverage (arm part) | Missing parent px (inside the arm) | Missing (whole circle) | See-through completed px in circle |
| ----------------------- | --------- | ------------------------ | ------------------- | -------------------------- | ---------------------------------- | ---------------------- | ---------------------------------- |
| Elbow (upper → forearm) | 1,551     | 1,417                    | 707                 | 49.9 %                     | 710                                | 844                    | 50                                 |
| Wrist (forearm → hand)  | 1,544     | 1,507                    | 745                 | 49.4 %                     | 762                                | 799                    | 303                                |

- The source has **no** parent pixel past a cut line (margin 0 px). The cut is an exact partition, so the child side of each circle belongs to the child only.
- The missing pixels are the half circle under the child. They do not exist in the source art. To copy child pixels into the parent would make a false overlap, so the study does not do it.
- At the wrist, 20 % of the circle pixels inside the arm are See-through completion (L0-1b), not drawn art.
- Picture: `6-missing-geometry.png` (blue = parent pixels in the circle, red = missing parent pixels, grey = circle outside the arm, magenta = opened gaps in the rotation tests).

## 5. Rotation tests (task D)

### 5.1 Renderer and measurements

- The renderer draws the layers below handwear, the far arm and other handwear pixels, the residual (not moved), then the upper arm, the forearm, and the hand (C0.5 draw order 22, 23, 25), then the layers above handwear.
- The forearm turns about the elbow mark. The hand turns about the wrist mark and moves with the forearm. Positive angles turn clockwise on the screen. For the elbow, positive moves the forearm out to image-left, away from the torso.
- **Gap**: pixels in the wedge between the moved parent cut line and the moved child cut line, not farther from the pivot than the source cut line, that no arm pixel covers (alpha > 0). The source pose has 0 by definition. This is an upper bound: at the wrist the cut line is wider than the hand.
- **Protrusion**: moved child pixels more than 1 px on the parent side of the parent cut line (in 2 x the overlap radius), where the parent has no pixel. The cut corner of the child shows outside the parent outline.
- **Unwanted overlap**: pixels that the parent and the child both cover outside the overlap circle. Overlap inside the circle is expected and is counted separately.
- **Seam**: each child pixel next to its cut line is compared with the final image 2 px across the moved cut line. Visible: the largest RGB difference is above 48. Exposed: no arm pixel there.

### 5.2 Results

| Test                 | Elbow gap | Elbow protrusion | Elbow unwanted overlap | Elbow visible seam | Wrist gap | Wrist protrusion | Wrist unwanted overlap | Wrist visible seam | Problem px (sum) |
| -------------------- | --------- | ---------------- | ---------------------- | ------------------ | --------- | ---------------- | ---------------------- | ------------------ | ---------------- |
| source               | 0         | 0                | 0                      | 2                  | 0         | 0                | 0                      | 6                  | 8                |
| elbow −15            | 38        | 3                | 9                      | 16                 | 0         | 0                | 0                      | 5                  | 71               |
| elbow +15            | 83        | 2                | 0                      | 26                 | 0         | 0                | 0                      | 6                  | 117              |
| elbow −30            | 81        | 26               | 20                     | 24                 | 0         | 0                | 0                      | 6                  | 157              |
| elbow +30            | 166       | 13               | 0                      | 31                 | 0         | 0                | 0                      | 4                  | 214              |
| wrist −15            | 0         | 0                | 0                      | 2                  | 57        | 20               | 40                     | 32                 | 151              |
| wrist +15            | 0         | 0                | 0                      | 2                  | 123       | 5                | 0                      | 22                 | 152              |
| elbow +10, wrist +10 | 54        | 1                | 0                      | 23                 | 79        | 3                | 0                      | 22                 | 182              |
| elbow −10, wrist −10 | 24        | 2                | 6                      | 13                 | 34        | 9                | 26                     | 32                 | 146              |
| elbow +10, wrist −10 | 54        | 1                | 0                      | 23                 | 38        | 7                | 24                     | 32                 | 179              |

- Source pose: the three parts give the same image as the layers, byte for byte (0 different bytes).
- The 2 and 6 "visible seam" pixels of the source pose are art lines that cross the cut. They are not artifacts. The mean RGB difference across the cut is 7.1 (elbow) and 16.7 (wrist) in the source pose, and 23 to 89 after a turn.
- When the arm moves, it shows pixels of other layers behind it (for example 960 px of hair and skirt at elbow −15). These pixels are See-through completions from L0-1b, not pixels from this study.
- Union of all gap pixels of the elbow-only tests: 247 px. Wrist-only tests: 180 px.
- Images: `rotations/<test>/result.png`, `holes.png`, `overlaps.png`, `3-rotation-contact-sheet.png`, `4-gap-overlap-heatmap.png`.

### 5.3 Visual assessment (human judgment, not a measurement)

This is the author's view of the images. The owner must make the art decision.

- Elbow ±10 to ±15: the arm reads as a bent arm. A short notch and a straight line in the semi-transparent dark sleeve show the cut on close view.
- Elbow ±30: the wedge gap and the straight cut edge are clearly visible. Not acceptable without underlay.
- Wrist ±15: the gap is next to the band edge and the glove. The band hides part of it. The cut corner of the glove shows at −15.
- The source pose has no visible change.

## 6. Metrics per joint (task E)

| Metric                                | Elbow                                                                                                  | Wrist                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Cut feasibility (math)                | PASS: 0 crossed-line px, 0 separated px                                                                | PASS: same                                                                                                        |
| RGBA conservation (math)              | Exact                                                                                                  | Exact                                                                                                             |
| Residual area (math)                  | 313 px for the whole arm, all pre-existing fragments                                                   | (same residual)                                                                                                   |
| Overlap coverage (math)               | 49.9 % of the circle inside the arm, 45.6 % of the whole circle                                        | 49.4 %, 48.3 %                                                                                                    |
| Uncovered px after rotation (math)    | 38 (−15), 83 (+15), 81 (−30), 166 (+30)                                                                | 57 (−15), 123 (+15)                                                                                               |
| Visible seam px (math)                | 16 to 31                                                                                               | 22 to 32                                                                                                          |
| Pixels that need repaint (math)       | 710 underlay px for the C0.5 rule; 247 px seen open in the tests                                       | 762 underlay px; 180 px seen open                                                                                 |
| Rotation result                       | **PARTIAL**: ±10 to ±15 usable for a test, not for production                                          | **PARTIAL**: same, plus the protrusion of the glove corner at −15                                                 |
| Confidence                            | Medium: the owner marked it high, but the arm is straight, so the position along the arm is a judgment | Medium: owner confidence medium; the cut goes through the glove top; 20 % of the circle is See-through completion |
| Human correction needed (qualitative) | Small: half-circle underlay in an even skin and sleeve area with two outline lines                     | Medium: band edge, glove, thumb, and completed pixels near the cut                                                |

## 7. Answers

| Question                                                | Answer                                                                                                                                                                                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can the near arm be cut into three parts?               | **Yes.** Exact partition, 0 ambiguous pixels from the cut, 313 px of earlier fragments kept as residual. It depends on the human marks.                                                                                                                              |
| Does the source pose stay the same?                     | **Yes.** Byte-equal to the layer composite.                                                                                                                                                                                                                          |
| Which turns work acceptably?                            | No turn is free of gaps. Elbow ±10 to ±15 and the small combined turns look acceptable for a diagnostic test (24 to 83 gap px per joint). Not for production.                                                                                                        |
| Which turns open holes?                                 | All. The largest: elbow +30 (166 px), wrist +15 (123 px), elbow +15 (83 px), elbow −30 (81 px). Outward turns open more at the elbow.                                                                                                                                |
| How much more geometry is necessary?                    | For the C0.5 overlap rule: 710 px (elbow) and 762 px (wrist) of parent underlay, a half circle of 22 px radius at each joint. The tests show 247 px and 180 px open at the tested angles.                                                                            |
| Can a normal raster algorithm solve it?                 | Not tested, because all such methods make new pixels and the task did not permit them. In even areas (skin, dark sleeve), a deterministic edge extension can probably fill the underlay. At the outlines, the band, and the glove, it probably makes visible faults. |
| Is a manual repaint or generative completion necessary? | Some new pixels are necessary. A small manual repaint (two half circles) is probably enough. A generative model is not necessary for this arm, but this is a judgment and is not tested.                                                                             |
| Smallest next action                                    | See section 8.                                                                                                                                                                                                                                                       |

## 8. Recommendation (not started)

1. Owner review of the cut lines and the joint marks, especially the wrist line at the glove top and the elbow position on a straight arm.
2. If the owner permits new pixels, make one controlled underlay test on this arm only:
   - (a) A person paints the two half-circle underlays (elbow and wrist) in Krita, with a time log.
   - (b) A deterministic, non-generative edge extension makes the same underlays. The output marks them as new pixels.
   - Rerun `limb-study` with the same angles and compare (a) and (b).
3. Do not start L0-2, Spine export, or automatic completion without a new owner decision.

## 9. Limits

- The joint marks are human estimates. A different elbow point changes the cut and the gaps.
- The gap metric is an upper bound at the wrist, because the wrist cut line is wider than the hand.
- The visible seam threshold (48) and the boundary band (1.5 px) are diagnostic choices, not standards.
- Nearest-neighbor rotation makes small stair steps at the outlines. Spine uses bilinear filtering, so the real result is softer.
- The tests use 2D rotation in the image plane. The C0.5 view is a 3/4 view, so a real elbow bend can also shorten the forearm. This is not tested.
- The study uses one character and one arm.

## 10. Verification

- `npm run check` passes. 7 new tests in `limbstudy.test.ts` with synthetic shapes: exact partition, overlap of a straight limb, zero gap in the source pose, gap growth with the angle, byte-equal reruns, refusal of mismatched inputs, cut normals of a bent limb, and nearest-neighbor copies only.
- Two runs on the real arm give byte-equal files (about 15 s each).
- The input hashes are equal before and after.
- `--dry-run` writes nothing.
- Command:

```sh
node packages/control/dist/src/cli.js limb-study --contract packages/control/test/fixtures/c05-candidate/rig.contract.json \
  --layers <run>/output/concept-mirrored --metadata <run>/output/concept-mirrored.psd.json \
  --image <run>/output/concept-mirrored/src_img.png --landmarks landmarks-manual.json \
  --study <l0-1d phase B align-study>/correspondence.json --out ./l0-1e
```

The images and parts are derivatives of the licensed test concept. They are only in the project files (`research/l0-1e/`), not in Git.
