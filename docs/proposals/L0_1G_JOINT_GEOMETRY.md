# L0-1g: joint geometry and neutral pose validation

**Draft. Research step.** Status: complete. Result: **PARTIAL**. A limb-width underlay region closes almost all joint gaps and is robust to small mark errors. A bit-exact neutral pose and full gap closure at the outer joint corner are not possible together with the current art (section 4). The region alternatives B and C are research results, not a change of the C0.5 overlap rule.
This report does not approve a joint, a pivot, a region, a part, or a package. The parts are not Spine attachments and are not ready for Spine. The study does not change the C0.5 template, the rig contract, the manual marks, the source art, or the rig runtime.

## tl;dr

L0-1f filled the hidden area under the elbow and the wrist only inside the C0.5 overlap circle. Gaps stayed on the wide side of each joint, and the source pose changed in about 30 pixels. L0-1g looks at why.

A region that has the width of the limb ("tube") closes almost all gaps (198 to 29 gap pixels on the L0-1e angles) and stays good when the joint marks move by 2–4 px. The source pose changes because the art has soft, partly transparent edges: an underlay pixel under such an edge always shows. If we fill only under fully opaque child pixels, the source pose is bit-exact, but the outer joint corner then stays open (gap 169). An artist or a contract decision must solve that corner. The `limb-study` exit code 1 was a defect in the command-line contract, not a failed study; this PR fixes it.

## 1. Scope and rules

- Target: the image-left (near) arm, the same cut and parts as L0-1e and L0-1f. Elbow (parent `upper_arm`, child `forearm`) and wrist (parent `forearm`, child `hand`) are measured separately.
- Local Node.js only. No GPU, no Runpod, no model, no network, no random values. No Spine.
- The L0-1e renderer and metrics and the L0-1f fill methods are used without change. Fill method B (directional) is used for the images. The metrics have both methods.
- New command `geometry-study` (`packages/control/src/jointgeometry.ts`). It runs in about 9 minutes on the real inputs.
- Out of scope: other limbs, Spine export, new inference, L0-2.

## 2. Exit code audit (task A)

**Cause.** The CLI takes the exit status from `report.status`: `PASS` gives 0, `INCOMPLETE` gives 3, any other value gives 1. `limb-study` wrote an object there (`{ "cut": "PASS", "sourcePose": "PASS" }`). An object is not `PASS`, so the command always gave exit 1. A run on the real inputs with `--dry-run` confirmed it: exit 1 with both parts `PASS`. The `CommandResult` type allowed any report, so the compiler did not find the defect.

| Class                   | Example                                               | Exit status                 |
| ----------------------- | ----------------------------------------------------- | --------------------------- |
| Execution failure       | bad input, unreadable file, wrong contract            | 2 (`ERROR`, `ControlError`) |
| Technical invariant     | partition not exact, recomposed source pose not equal | 1 (`FAIL`)                  |
| Research result PARTIAL | cut islands, gaps after rotation, unresolved underlay | 0, in other report fields   |
| Art suitability         | seams, wrong shapes, need for repaint                 | not measured by the tool    |

**Fix (in this PR).**

- `CommandResult.report.status` now has the type `'PASS' | 'FAIL' | 'INCOMPLETE'`. The compiler refuses a command that writes another value. Three other commands needed only a type annotation; their values did not change.
- `limb-study`: `status` is `PASS` when the arm partition, the handwear layer partition, and the recomposed source pose are exact; else `FAIL`. The study result moves to `study` (`{ cut, sourcePose }`). `metrics.json` keeps its old `status` object, so the L0-1e metrics stay the same.
- No error is suppressed: an input error is still exit 2, a broken invariant is exit 1.
- Tests: `limb-study` reports `PASS` and keeps the study result apart; `underlay-study` and `geometry-study` report `PASS` only when their invariants hold.

## 3. Diagnostic regions (task C)

| Region          | Rule                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| A `circle`      | The L0-1f region: child side of the cut, distance to the joint mark at most the C0.5 radius (24 / 1.081 = 22.20 image px).  |
| B `wide_circle` | The same rule with the radius equal to the largest cross-section extent from the joint mark (elbow 25.5 px, wrist 31.0 px). |
| C `tube`        | The parent cross-section swept along the parent axis past the cut line, to a depth of 22.20 px along the cut normal.        |
| `_safe` variant | Only the region pixels where the child is fully opaque (alpha 255) in the source pose.                                      |

All regions contain only pixels where the parent has no pixel. The cross-section of the arm along the cut is 25.5 px and 17.5 px on the two sides of the elbow mark (the mark is 4.0 px off center), and 31.0 px and 21.5 px at the wrist (4.8 px off center).

| Joint | A circle | B wide circle | C tube | A safe | B safe | C safe |
| ----- | -------- | ------------- | ------ | ------ | ------ | ------ |
| Elbow | 732      | 920           | 926    | 690    | 859    | 863    |
| Wrist | 769      | 1,363         | 1,151  | 754    | 1,316  | 1,112  |

`1-regions.png` shows the regions. The pixels that the occlusion-safe rule removes (red) are at the outer corner of each cut, where the child outline is soft or where the region is outside the child.

## 4. Neutral pose (task B)

**Compositing is correct.** `Raster.blend` is source-over with straight alpha: `out = (c·a + d·b·(1−a)) / (a + b·(1−a))`, rounded to 8 bits. A test checks the formula. The layer composite and the part composite use the same function, and the parts are a partition, so the baseline source pose is bit-exact.

**Why the underlay shows.** With source-over, a child pixel with alpha `a < 255` lets `1 − a/255` of the pixel below through. The new underlay pixel replaces the body under the child, so the frame changes. Under a child pixel with alpha 255, the frame does not change. Thus a bit-exact source pose is possible only if no new pixel is under a child pixel with alpha below 255 (or with no child pixel). Premultiplied alpha does not change this: it is the same operation in another number format.

**Results.**

| Variant (method B) | Source pose: different pixels | Largest channel difference |
| ------------------ | ----------------------------- | -------------------------- |
| Baseline           | 0                             | 0                          |
| A circle           | 30                            | 106                        |
| B wide circle      | 66                            | 203                        |
| C tube             | 62                            | 106                        |
| All `_safe`        | 0                             | 0                          |

The `_safe` variants give a bit-exact source pose without a change of any source pixel and without a frame substitution. All other invariants stay zero.

**Cost of the safe rule.** The removed pixels are exactly at the outer corner where the joint opens. On the L0-1e angles, the gap is:

| Region        | Full region gap (elbow + wrist) | `_safe` gap (elbow + wrist) |
| ------------- | ------------------------------- | --------------------------- |
| A circle      | 98 + 100 = 198                  | 149 + 127 = 276             |
| B wide circle | 20 + 9 = 29                     | 117 + 52 = 169              |
| C tube        | 20 + 9 = 29                     | 117 + 52 = 169              |

Thus, with this art, a bit-exact source pose and a closed outer corner exclude each other. The smallest source-pose difference with a closed corner is the full tube: 62 pixels, largest difference 106 (one outline pixel at the wrist; method A gives 71 pixels with a largest difference of 38).

**Reference state.** A separate reference state (show the underlay only when the joint turns) gives a bit-exact source pose with the full region. The switch makes a visible jump: at ±2 degrees the full tube changes 65–69 frame pixels against the baseline, the safe tube 8–21. In Spine, this needs an extra attachment or slot per joint and animation keys for the switch. This is a rig contract change and is not done here.

## 5. Rotation results (tasks C and D)

Sums per joint over the tests where that joint turns. Group L0-1e: the L0-1e angles. Group extended: ±2, ±45, ±60 degrees at the elbow and ±2, ±30, ±45 degrees at the wrist. The extended angles are diagnostic values, not animation limits.

| Variant            | Gap L0-1e (e + w) | Worst gap e / w | Seam L0-1e (e + w) | Gap extended (e + w) | Protrusion extended (e + w) |
| ------------------ | ----------------- | --------------- | ------------------ | -------------------- | --------------------------- |
| Baseline           | 500 + 331         | 166 / 123       | 160 + 161          | 873 + 933            | 606 + 389                   |
| A circle, method A | 90 + 100          | 41 / 61         | 56 + 104           | 142 + 317            | 606 + 389                   |
| A circle           | 98 + 100          | 41 / 61         | 50 + 102           | 148 + 317            | 606 + 389                   |
| B wide circle      | 20 + 9            | 3 / 5           | 50 + 87            | 13 + 11              | 606 + 389                   |
| C tube             | 20 + 9            | 3 / 5           | 50 + 87            | 13 + 11              | 606 + 389                   |
| A circle safe      | 149 + 127         | 42 / 61         | 53 + 102           | 203 + 341            | 606 + 389                   |
| C tube safe        | 117 + 52          | 29 / 13         | 53 + 87            | 101 + 68             | 606 + 389                   |

Unwanted overlap (the L0-1e metric: parent and child both opaque outside the C0.5 circle), L0-1e group, elbow + wrist:

| Baseline | A circle | B wide circle | C tube        |
| -------- | -------- | ------------- | ------------- |
| 35 + 90  | 35 + 146 | 1,394 + 4,899 | 1,308 + 2,729 |

The large values for B and C are by construction: these regions are outside the C0.5 circle, and the child covers them. They are under the child in the draw order, so they show only through partly transparent child pixels or after a turn. The L0-1f increase of the wrist overlap in elbow-only tests is now explained: all 55 added pixels of the A circle are within 1.5 px outside the circle (`unwantedOverlapNearCirclePixels`), so they come from nearest-neighbor resampling at the circle edge.

**Protrusion does not change.** At 45–60 degrees, the cut corner of the child shows outside the parent outline (606 and 389 pixels). A parent underlay cannot fix this. It needs a shaped child end (art) or a smaller angle range.

**Invariants.** For all 13 variants: changed source pixels 0, new pixels outside the region 0, frame changes outside the moved new pixels 0. Status `invariants: PASS`.

## 6. Sensitivity to the joint marks (task D)

The elbow and wrist marks were moved together by ±2 and ±4 px in x and y. The scale and the other inputs are the same. A move gives a new cut: 68–398 arm pixels change their part. Gap on the L0-1e angles, elbow + wrist, method B:

| Shift | Baseline  | A circle  | C tube  | C tube safe | C tube: source pose pixels |
| ----- | --------- | --------- | ------- | ----------- | -------------------------- |
| none  | 500 + 331 | 98 + 100  | 20 + 9  | 117 + 52    | 62                         |
| x −4  | 706 + 347 | 229 + 152 | 18 + 13 | 253 + 53    | 228                        |
| x −2  | 511 + 337 | 143 + 126 | 4 + 11  | 99 + 50     | 56                         |
| x +2  | 687 + 336 | 217 + 101 | 34 + 19 | 324 + 64    | 223                        |
| x +4  | 441 + 336 | 12 + 96   | 12 + 9  | 90 + 62     | 68                         |
| y −4  | 502 + 342 | 116 + 132 | 8 + 2   | 101 + 89    | 116                        |
| y −2  | 475 + 334 | 90 + 112  | 12 + 10 | 85 + 72     | 79                         |
| y +2  | 487 + 354 | 68 + 119  | 9 + 7   | 100 + 44    | 61                         |
| y +4  | 665 + 397 | 195 + 164 | 34 + 24 | 272 + 61    | 202                        |

- The C0.5 circle is sensitive: the elbow gap goes from 12 to 229. A mark move changes the cross-section on each side of the mark (elbow width 41–52 px), and the circle does not follow it.
- The tube stays at 4–34 gap pixels per joint for all shifts. Its source-pose difference grows to 202–228 pixels for some shifts.
- The safe tube is sensitive at the elbow (85–324). The outer elbow corner is soft in the art, and the cut moves along it.
- B wide circle gives almost the same gaps as the tube with more overlap (see `metrics.json`).

## 7. Visual assessment (human judgment, not a measurement)

Images: `2-sheet-{body,transparent,magenta}.png`, `3-zoom-{elbow,wrist}-{body,transparent,magenta}.png`, `4-problem-heatmaps.png`, `5-source-pose-difference.png`.

- Elbow −30: all fills continue the dark outline into the inner corner as a small dark wedge. It is not a hole, but it is not a clean drawn crease.
- Elbow +30 and +60: the circle leaves a step at the outer corner. The tube and the wide circle close it, but the outline continues as a speckled, slightly angular line, and at +60 a small dark bump shows past the contour.
- Wrist +15 and +45: the circle leaves a notch on the outer glove edge. The tube and the wide circle close it. The glove texture continues plausibly at this scale.
- Source pose: the full tube and the wide circle show a few darker outline pixels at the outer elbow and wrist corners (`5-source-pose-difference.png`). The safe variants show none.
- No color halos on the transparent or magenta backgrounds.
- The best variant cannot be chosen by the number of filled pixels. The tube is the best compromise by the metrics, but the outline at the outer corner still needs an artist.

## 8. Answers

1. **Why did `limb-study` give exit 1?** A CLI contract defect: the report `status` was an object, and the CLI gives exit 1 for every value that is not `PASS` or `INCOMPLETE`. The study itself passed. Fixed with a typed status and tests.
2. **Can the neutral pose stay without pixel changes?** Yes, with the occlusion-safe rule (new pixels only under fully opaque child pixels): 0 different pixels. But then the outer joint corner stays open (gap 169 instead of 29). A bit-exact pose and a closed corner exclude each other with the current soft art edges. Minimum with a closed corner: 62 pixels (tube, method B).
3. **Is a larger circle sufficient?** For the gaps, almost: 198 → 29 on the L0-1e angles, 465 → 24 on the extended angles. But it is the largest region (wrist +77 %), has the most overlap outside the C0.5 circle, and the largest source-pose change (66 pixels, difference up to 203).
4. **Does the contour-aware region give an advantage?** Against the C0.5 circle, yes: the same gap reduction as the wide circle, and stable under mark errors. Against the wide circle, the advantage is economy: a smaller wrist region (1,151 against 1,363 pixels), about half of the overlap at the wrist, and a smaller largest source-pose difference (106 against 203). It does not close more gaps than the wide circle.
5. **How sensitive is the result to landmark errors?** The baseline and the C0.5 circle are sensitive: ±2–4 px change the elbow gap by up to 2.3 times. The tube is robust (4–34 gap pixels per joint). The safe variants and the source-pose difference are sensitive at the elbow.
6. **What does production need?** Owner decisions, not done here: (a) the overlap rule shape: a limb-width (tube) region instead of a circle, or a larger radius per joint — a rig contract change; (b) a neutral-pose policy: accept a small change, or use the safe rule plus an artist fix of the outer corner, or a reference state with an extra attachment per joint (contract change); (c) a shaped child end or an angle limit against protrusion at large angles; (d) a check of the mark accuracy at each joint. The exit status fix is in this PR.
7. **Is a manual repaint still necessary?** Yes, a small one: the outer corner outline at each joint, and the inner elbow crease. The deterministic fill is a good first draft for the rest.

## 9. Limits

- One concept, one arm, two joints. The concept is a technical benchmark only.
- The metrics count pixels. They do not measure art quality.
- Nearest-neighbor resampling only. Spine uses linear filtering and meshes. No Spine check.
- The mark shifts move both marks together, in image axes only.
- The joint marks are human estimates from L0-1d.

## 10. Verification

- `npm run check` passed: format, lint, configuration, workflows, type check, build, and tests.
- Synthetic tests: tube region along a straight and a slanted limb, wide circle contains the circle, occlusion-safe rule, straight-alpha compositing, invariants of all variants, bit-exact source pose of the safe variants (also with a shifted mark), identical output on a second run, `limb-study` exit status.
- Two runs of `geometry-study` on the real inputs gave identical output trees (`diff -r`). The input SHA-256 values before and after are the same.
- `SHA256SUMS` lists the tool output bytes. The project file storage re-encodes PNG files; `PIXEL-SHA256SUMS` lists the decoded pixel hashes, and the stored files give the same pixel hashes.
- The outputs are derivatives of the licensed test concept. They are stored only outside the repository.
