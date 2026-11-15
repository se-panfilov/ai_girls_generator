# L0-1d: human-in-the-loop landmark calibration

**Draft. Research step.** Status: Phase A complete, Phase B complete with the owner's manual marks. Result: **PARTIAL** (section 6).
This report does not approve a joint, a pivot, a cut, or a package. It does not change the C0.5 template, the rig contract, the bone ids, the weapon slots, or the art.

## tl;dr

L0-1c found 10 of the 19 template-related landmarks of the test concept with medium or high confidence. Clothing, hair, and the torso hide the hips, the knees, the near elbow, and the shoulders.
L0-1d added a local page for manual marks (phase A). The owner then marked 25 landmarks in about 16 minutes of active work (phase B). After the marks, 18 of the 19 template-related landmarks have a point. Only the far shoulder stays unknown.

The global fit did not become better: the mean error is 3.25 % of the body height (L0-1c: 2.68 %), because the new joints show real pose and proportion differences from the template. The near arm and the near thigh have template proportions (length ratios 0.97 to 1.03). The shins are shorter (0.82 to 0.84), which depends on where the ankle is in a boot. A trial cut of one limb is possible for the near arm only.

## 1. Phase A: the annotation page

- Command: `aigg-control annotate-page --image <src.png> --landmarks <align-study landmarks.json> --out <dir> [--manual <earlier export>]`. See [the package README](../../packages/control/README.md#manual-landmark-page-l0-1d).
- Output: `annotate.html` (about 0.9 MB for the 1280 x 1280 image). The page holds the image as a data URL, the automatic L0-1c landmarks and ranges, and the page code. It is deterministic.
- Page actions: select a landmark, click to put a point, drag to correct, set visibility and confidence, write the reason (`method`) and a note, draw a range, set unknown, return to "not reviewed", undo, zoom and pan, export JSON, import JSON.
- The page shows the automatic points (circles) with their confidence, the unknown ranges (dashed boxes), the merged thigh and skirt regions, and the manual marks (squares). Blue is image-left, orange is image-right.
- Coordinates are always in the 1280 x 1280 image frame. The tests check that zoom and pan do not change the image coordinates.

### 1.1 Data rules

- Format: `aigg.l0-1c.landmarks/0.1`, read by `parseManualLandmarks()` in `alignstudy.ts`. The schema is not changed.
- Only reviewed landmarks are written. A landmark that the person does not review keeps the automatic value. The automatic `landmarks.json` is not changed.
- A new point starts as `inferred` with `low` confidence. The person must raise visibility and confidence on purpose.
- An `unknown` entry has no `x` and `y`, and `confidence` is `none`. A range is permitted with any visibility.
- Each entry has `origin: "manual"`, `visibility`, `confidence`, `method` (reason), and `note`. The parser sets `origin` to `manual` itself and ignores the field in the file.
- The page refuses export while an entry breaks a parser rule, and lists the problems. A randomized test (300 action sequences) checks that every export that the page accepts also passes `parseManualLandmarks`.
- The file records `image` (name and SHA-256), `automaticLandmarksSha256`, and `session`.

### 1.2 Time measurement

- `session.activeSeconds`: the sum of the gaps between page actions, each gap at most 60 s. A long pause does not count. The time before the first action does not count.
- `session.counters`: placements (first point), re-placements (a new click on a landmark with a point), moves (drags), ranges, unknowns, clears, attribute edits, undos.
- The tool time does not include the time to build or open the page. If the person works in two sessions, the browser storage keeps the action times, so the count continues.
- Limit: the page cannot know if the person looks at the image without an action. Thinking time without actions over 60 s is not counted.

### 1.3 Limits of the format (documented, not changed)

1. The parser does not compare `image.sha256` in the manual file with the image of the run. A file for another image passes if the ids and coordinates are valid. **Proposal (not implemented):** `align-study` checks `image.sha256` when the field exists. This is an additive and compatible change.
2. The parser keeps one range for each landmark. A person cannot give two ranges (for example, two hip hypotheses).
3. `session` and `automaticLandmarksSha256` are not copied into `correspondence.json`. The rerun report will record them separately.
4. Manual entries get `sourceLayers: ["image"]`. The page does not record which layer the person looked at.

## 2. Phase A verification

- `npm test --workspace @aigg/control`: 148 tests pass. New: `annotator.test.ts` (state rules, undo, counters, zoom and pan invariants, export validation against the reference parser) and `annotatepage.test.ts` (input validation, determinism, no external references, script escaping, CLI without input change).
- Browser check in headless Chromium with the real page: point by click at fit zoom and at 263 % zoom (error below 1 image px), drag correction, range and unknown, undo, export. The page made no network request and logged no error. The exported file passed `align-study --landmarks --dry-run`.
- Two builds of the page are byte-equal. The SHA-256 of the input image and the automatic `landmarks.json` are equal before and after.
- Not checked: Safari and Firefox by hand.

## 3. Owner checkpoint (Phase B input)

The person marks the image. The tool does not make marks for the person.

Priority landmarks:

| Landmark                              | L0-1c state                      | What to do                                                                               |
| ------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| `shoulder_image_left`                 | inferred, low (sleeve cap)       | Mark the joint if the sleeve shape shows it, else keep low confidence or set a range.    |
| `shoulder_image_right`                | inferred, low (visible cap only) | The torso hides most of it. A range is acceptable.                                       |
| `elbow_image_left`                    | unknown (straight arm)           | Mark it if the arm shading shows the elbow. Else a range.                                |
| `hip_image_left`, `hip_image_right`   | unknown (skirt)                  | Under the skirt. Do not make a high-confidence point. A range or a low `inferred` point. |
| `knee_image_left`, `knee_image_right` | unknown and low                  | Mark only if the stocking shape shows the knee.                                          |
| `head_top`                            | unknown (hair)                   | A range or a low `inferred` point.                                                       |

Check again: `elbow_image_right`, `wrist_image_left`, `wrist_image_right`, `ankle_image_left`, `ankle_image_right`, `neck_base`.

## 4. Phase B method

1. The owner's file (`landmarks-manual.json`, SHA-256 `1417cfc5…7ede6`) passed `parseManualLandmarks`. Its `image.sha256` and `automaticLandmarksSha256` agree with the L0-1c inputs.
2. `align-study --landmarks` ran with the same inputs as L0-1c. The L0-1c run is the baseline.
3. `compare-landmarks` (new in this PR) compares the two runs: landmark shifts, the similarity fit (medium or more, near = image-left), residuals, and images. It does not run a different alignment. It uses the pairs that `align-study` wrote.
4. No manual mark was changed, moved, or removed. Where a mark makes the fit worse, section 5.4 gives the probable cause.
5. Two runs of both commands give byte-equal files. The input hashes (layers, metadata, contract, both landmark files) are equal before and after.

## 5. Phase B results

### 5.1 Human effort

| Measure                                        | Value                                                      |
| ---------------------------------------------- | ---------------------------------------------------------- |
| Active marking time                            | 976 s (16.3 min), gaps over 60 s not counted               |
| Landmarks reviewed                             | 25 of 25 (all priority and check-again ids, and 11 others) |
| With a point / unknown                         | 24 / 1 (`shoulder_image_right`, range only)                |
| First placements / re-placements               | 26 / 17                                                    |
| Drags / ranges / undos                         | 1 / 3 / 13                                                 |
| Attribute edits (visibility, confidence, text) | 100                                                        |

The counters include the work on non-priority landmarks. The page does not split the time by landmark.

### 5.2 Provenance and confidence

- Visibility after review: 22 visible, 2 occluded (both hips), 1 unknown. Confidence: 18 high, 6 medium, 1 none.
- All 25 entries have the same method (`manual mark on the image`, the default) and the same note (`L0-1c: position correction`). The file does not say why each point is where it is, so we cannot separate a seen point from a judged point beyond the visibility field.
- Several joints that the art covers are marked `visible` with `high` confidence: `neck_base` (collar), both wrists (wrist bands), both ankles (shoe collars), both knees (black stockings), and `elbow_image_left` (no outline bend). This report treats them as human judgments, not as ground truth. The hips are `occluded` with `medium` confidence and a range, which agrees with the data rules.

### 5.3 Automatic and manual landmarks

| Landmark                                                      | Shift from L0-1c (px) | Reading                                                                                                |
| ------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------ |
| eyes, nose, mouth, `ankle_image_*`                            | 0.7 to 3.2            | The automatic method agrees with the person.                                                           |
| `sleeve_end_image_right`, `foot_anchor_image_left`            | 5.3, 9.7              | Agrees.                                                                                                |
| `shoulder_image_left`, `wrist_image_left`                     | 2.4, 4.2              | Agrees.                                                                                                |
| chin, `wrist_image_right`, `elbow_image_right`, `head_center` | 7.5 to 10.8           | Small corrections.                                                                                     |
| `head_top`, `elbow_image_left`, hips, `knee_image_left`       | no L0-1c point        | New points. `head_top` is outside the L0-1c range; the others are inside their L0-1c ranges.           |
| `neck_base`, `torso_front_mark`, `sleeve_end_image_left`      | 15.4 to 22.8          | Different definitions (collar line, tie knot, sleeve hem).                                             |
| `foot_anchor_image_right`                                     | 38.1                  | The person marked the toe side of the sole, the tool the sole centroid.                                |
| `knee_image_right`                                            | 103.1                 | The L0-1c point was the calf, as L0-1c suspected.                                                      |
| `shoulder_image_right`                                        | no point              | The person's range (x 542–600, y 255–301) is far from the L0-1c proxy (638, 353). The proxy was wrong. |

### 5.4 Global alignment (near = image-left, similarity, medium or more)

| Run                             | Landmarks in the fit | Mean % | Max % | Scale                                               |
| ------------------------------- | -------------------- | ------ | ----- | --------------------------------------------------- |
| L0-1c automatic                 | 10                   | 2.68   | 5.34  | 1.097                                               |
| L0-1d manual, same 10 landmarks | 10                   | 2.75   | 5.82  | –                                                   |
| L0-1d manual, all               | 17                   | 3.25   | 5.74  | 1.081                                               |
| L0-1d manual, all, affine       | 17                   | 3.08   | 4.88  | anisotropy 1.15                                     |
| L0-1d, near = image-right       | 17                   | 14.00  | 34.68 | 0.914 (affine: 3.22 / 7.53, only with a reflection) |

Template tolerances: mean 1.5 %, max 2.5 %. The manual marks do not make the fit pass. On the same 10 landmarks the error stays almost equal (2.68 % to 2.75 %), so the manual corrections did not find a marking error in the automatic points. The higher mean of the full set comes from the new joints, and their errors have a pattern, not noise (`error-vectors.png`): the template knees and ankles are closer to the center line (the character stands wider), the template wrists are lower and farther out (the character holds the arms nearer to the body), and the template head top is higher.

Per joint after review (%): eye left 0.8, chin 1.1, eye right 2.2, elbow left 2.4, nose 2.4, neck base 2.5, ankle right 2.7, knee right 3.2, hip left 3.4, shoulder left 3.4, hip right 3.7, knee left 3.8, elbow right 4.0, wrist left 4.2, head top 4.8, ankle left 5.0, wrist right 5.7.

### 5.5 Pose-aware check: segment lengths and angles

The similarity scale removes the global size. A length ratio is then free of the segment rotation, so it separates proportion from pose. An angle difference is pose. (A 2D length also includes foreshortening; the C0.5 template has its own 40° yaw.)

| Segment        | Length ratio | Angle difference | In 0.95–1.05 | Reading                                                                     |
| -------------- | ------------ | ---------------- | ------------ | --------------------------------------------------------------------------- |
| upper arm near | 0.98         | +6.9°            | yes          | Template proportion. Small pose difference.                                 |
| forearm near   | 0.97         | +16.7°           | yes          | Template proportion. The forearm is turned in: pose.                        |
| forearm far    | 1.11         | −23.7°           | no           | The sword arm swings out: pose. The length is near the limit.               |
| upper arm far  | –            | –                | –            | Not computable: far shoulder unknown.                                       |
| thigh near     | 1.03         | +10.4°           | yes          | Template proportion, if the hip judgment is right.                          |
| thigh far      | 1.09         | +4.2°            | no           | Longer, under the skirt. Depends on the hip judgment.                       |
| shin near      | 0.84         | +7.8°            | no           | Shorter. See the ankle definition below.                                    |
| shin far       | 0.82         | −0.8°            | no           | Shorter. Same cause.                                                        |
| ankle line     | 1.66         | −2.1°            | no           | Wider stance: pose.                                                         |
| neck to chin   | 1.27         | +40.6°           | no           | Head tilt and turn: pose. The longer distance may be the larger anime head. |

**Ankle definition.** The person and the tool put the ankle at the shoe collar, 119 image px above the sole. The C0.5 foot joint is 44 template px (about 41 image px) above the ground. If the anatomical ankle is lower in the boot, the shin becomes longer and the ratio moves toward 1. The shin result depends on this definition, which is a human decision.

**Head top definition.** The manual `head_top` (y 99.9) is below the top of the face layer (y 88) and outside the L0-1c range (y 60–88). It is probably the visible hairline, not the skull top that the template uses. This explains much of its 4.8 % error.

## 6. Phase B answers

| Question                                                | Answer                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is a small manual pass enough for a reliable joint map? | **Partially.** 16 minutes gave a point for 24 of 25 landmarks and a consistent near arm and near thigh. The far shoulder stays unknown. The hips are judgments under the skirt. The ankle and head top need a definition.                   |
| How fast can a person mark the points?                  | 976 s of active work for 25 landmarks (17 re-placements, 13 undos), on a first use of the page.                                                                                                                                             |
| Which landmarks can a person mark with confidence?      | Face points, shoulder near, elbows, wrists, knees, ankles, soles (the person gave high confidence; for covered joints this is a judgment).                                                                                                  |
| Which hidden joints stay uncertain?                     | The far shoulder (unknown), both hips (occluded, medium), and the ankle and head top definitions. The merged thighs (L0-1b) are still one shape in the pixels.                                                                              |
| How does the alignment error change?                    | Same 10 landmarks: 2.68 % to 2.75 %. All 17: 3.25 % mean, 5.74 % max. The fit does not pass the template tolerances. The difference is mostly pose (arms, stance, head), which a rig can rotate, and partly the shin length.                |
| Can we go to a trial cut of one limb?                   | **Yes, for the near arm (image-left) only, after an owner review.** It has a full chain (shoulder, elbow, wrist) with template proportions, no weapon, and only 7 % completed pixels. The far arm, the thighs, and the shins are not ready. |

## 7. Unresolved joints and blockers

| Item                       | State after review                  | Blocks                                    | Needs                                                        |
| -------------------------- | ----------------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| `shoulder_image_right`     | unknown, range only                 | far upper arm, shoulder line, far arm cut | a decision on far shoulder placement, or repaint             |
| `hip_image_left`, `_right` | occluded, medium, inside ranges     | thigh parts                               | thigh completion (L0-2) for pixels; the points are judgments |
| Ankle definition           | shoe collar, 119 px above the sole  | shin length, foot pivot                   | a rule for boots (collar or anatomical joint)                |
| Head top definition        | probably the hairline               | head height check                         | a rule (skull top or visible hair top)                       |
| Weapon hand                | sword in the far hand               | far arm and weapon slot                   | the separate architecture decision                           |
| Point provenance           | one default method and note for all | an audit of which points were seen        | a short reason per point in the next pass                    |

## 8. Preliminary cut lines (not cut)

From `phase-b/align-study/d-segmentation-map.png`. No cut was made and no part was approved.

| Cut                                | Status after review | Notes                                                                                    |
| ---------------------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| Wrist, image-left (near)           | first candidate     | The wrist band is a seam and gives drawn overlap.                                        |
| Elbow, image-left (near)           | first candidate     | The person marked it (visible, high). The inner elbow has no drawn overlap for rotation. |
| Shoulder, image-left (near)        | candidate           | The sleeve covers the joint. Hair covers part of the cap. A rotation opens the sleeve.   |
| Wrist and elbow, image-right (far) | later               | The sword in the hand, 28 % completed pixels in that arm, far shoulder unknown.          |
| Ankles                             | candidate           | The shoe collar is a seam. The pivot depends on the ankle definition.                    |
| Knees                              | later               | Uniform black stocking. No drawn overlap.                                                |
| Hips                               | blocked             | Skirt and merged thighs.                                                                 |

## 9. Recommendation for L0-1e (not started)

1. Owner review of this result and of the two definitions (ankle in a boot, head top).
2. L0-1e minimal study: a trial cut of the near arm (image-left) into upper arm, forearm, and hand at the marked joints, local and without repaint or generation. Measure the drawn overlap at the elbow and wrist against the C0.5 24 px rule, and test small rotations for gaps.
3. Keep the far arm, the legs, and the weapon question out of L0-1e.
4. In a later manual pass, write a short reason for each point. The page already supports it.

## 10. Open points

- The weapon in the far hand is a separate architecture question. It does not block the marks.
- A transition to a trial cut of one limb needs a new owner review after Phase B.
