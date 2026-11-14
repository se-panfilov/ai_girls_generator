# L0-1d: human-in-the-loop landmark calibration

**Draft. Research step.** Status: `WAITING_FOR_HUMAN_ANNOTATION`. Phase A (the tool) is complete. Phase B (manual marks and the alignment rerun) has not started, because it needs marks from a person.
This report does not approve a joint, a pivot, a cut, or a package. It does not change the C0.5 template, the rig contract, the bone ids, the weapon slots, or the art.

## tl;dr

L0-1c found 10 of the 19 template-related landmarks of the test concept with medium or high confidence. Clothing, hair, and the torso hide the hips, the knees, the near elbow, and the shoulders.
L0-1d asks if a small manual pass gives a reliable joint map for this character. Phase A adds a local page for manual marks. It is one HTML file that opens from the disk, with no server and no network. It exports the same manual format that `align-study --landmarks` already reads. Phase B starts when the owner sends the exported file.

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

## 4. Phase B plan (after the manual file arrives)

1. Validate the file with the reference parser. Record the marking time and counters from `session`.
2. Run `align-study --landmarks` with the file, with the same inputs as L0-1c. Keep the L0-1c result as the baseline.
3. Compare: automatic and manual landmarks, the number of high and medium points, global fit residuals (uniform, similarity, affine), per-joint errors, segment length ratios, unknown joints, confidence, and provenance.
4. Pose-aware bone mapping (research hypothesis): compare segment lengths only (rotation free), to separate pose from proportion. Do not move a joint to make the fit smaller.
5. If a manual mark makes the global fit worse, keep it. Find out if the cause is a real pose difference or a marking error.
6. Make the images in the project shared folder only: before and after overlay, before and after alignment, per-joint error vectors, the uncertainty map after review, the unresolved joint table, and a preliminary list of cut lines (no cut).

## 5. Open points

- The weapon in the far hand is a separate architecture question. It does not block the marks.
- A transition to a trial cut of one limb needs a new owner review after Phase B.
