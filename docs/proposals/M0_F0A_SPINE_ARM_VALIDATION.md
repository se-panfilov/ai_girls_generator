# M0-F0a: first near arm package for real Spine

**Draft. Research step.** Status: **WAITING_FOR_SPINE_VALIDATION** (second owner run). Levels: `JSON_GENERATED` **PASS**, `CLI_VALIDATED` **FAIL** in the first owner run (one curve difference, see section 7.1; a run with the corrected comparison is not done yet), `VISUALLY_VALIDATED` **NOT RUN**.
This report does not approve a joint, a pivot, a region, a part, an animation, or a package. It does not change the C0.5 candidate contract, the rig runtime, the master rig, or the source art. The test angles are diagnostic values, not animation limits.

## tl;dr

We made the first Spine package of one arm: the near (image-left) arm of the L0 test concept, cut in L0-1e, with the L0-1g "tube" underlay. A new command writes a Spine 4.3 skeleton JSON with three bones (upper arm, forearm, hand), three cropped images, and four short test animations. A second new command lets the owner run the licensed Spine on the owner's computer from the command line: it imports the JSON into a `.spine` project, exports it again, and compares the result with what we intended.

All offline checks pass, and the official Spine runtime library (spine-core 4.3.13) reads the JSON and puts the joints within 0.0002 px of the manual marks. But no real Spine editor has read the package yet. Only the owner's run of `spine-validate` can give `CLI_VALIDATED`, and only a look by the owner in the editor can give `VISUALLY_VALIDATED`.

## 1. Scope and rules

- Target: the image-left (near) arm, without the sword. Parts and joints are the L0-1e cut at the L0-1d manual marks (shoulder 461.8, 271.5; elbow 383.7, 454.4; wrist 320.0, 608.6). No mark was moved.
- Skeleton: `root > upper_arm_near > forearm_near > hand_near`. No far arm, legs, skirt, or weapon.
- Only Spine Essential features: bones, parent-child hierarchy, slots, region attachments, draw order, rotate keys. No mesh, weighted mesh, deform, IK, transform, path, or physics constraint, and no clipping.
- Local Node.js only. No model, no GPU, no network. The agent did not run Spine and has no access to the owner's Spine installation.
- Out of scope: the full Akane rig, M1, L0-2, weapon slot migration, mesh animation.

## 2. Inputs and provenance

| Input                                             | SHA-256            | Note                                                      |
| ------------------------------------------------- | ------------------ | --------------------------------------------------------- |
| L0-1 results archive (`l0-1-results-v2-…tar.gz`)  | `c85fcea7…218951`  | Read only from the owner's computer. Same as L0-1b to 1g. |
| `handwear.png`                                    | `c6f9523b…5a7e`    | Both arms in one See-through layer.                       |
| `src_img.png`                                     | `a8be1695…7686`    | The See-through input image (1280 x 1280).                |
| `landmarks-manual.json` (owner, L0-1d)            | `1417cfc5…7ede6`   | Shoulder, elbow, and wrist marks.                         |
| `correspondence.json` (L0-1d phase B align-study) | `c23d7d42…a663`    | Similarity scale 1.081.                                   |
| C0.5 candidate `rig.contract.json` (test fixture) | see `inputs-*.txt` | Bone and slot names, draw order, overlap radius.          |

- The input hashes are the same before and after the runs (`agent-checks/inputs-before.txt`, `inputs-after.txt` in the project files).
- The tube variant uses the L0-1g region C with fill method B (`tube_B`), the full region (not occlusion-safe): 926 new pixels at the elbow, 1,151 at the wrist, each tagged `generated_by_deterministic_extension`. No manual repaint.
- The 313 L0-1e residual pixels (fragments not connected to the arm) are in no attachment.

## 3. Spine format basis

- Data version `4.3.26`: the editor version in the C0.5 contract and in the owner's own Spine 4.3.26 export in the repository (`packages/rig-runtime/test/fixtures/l1-owner/editor-out/skeleton.json`).
- The field shapes follow that export and the official spine-core 4.3.13 `SkeletonJson` reader: `skins` is an array, rotate keys use `time` and `value`, a missing value is 0, a missing curve is linear. The public JSON format page still shows a 3.8 example (`angle`), so we did not use it for key names.
- Spine CLI (official page): `Spine -i <json> -o <project.spine> -r [name]` imports skeleton data into a project (created if it does not exist); `Spine -i <project> -o <dir> -e json+pack` exports JSON and packs an atlas; a failed command returns a non-zero exit code. On macOS the executable is `/Applications/Spine.app/Contents/MacOS/Spine`.
- **Assumptions, not verified:** that the Essential edition accepts the CLI import and export, that the import takes the `images` path (`./images/`) relative to the JSON file, and that the export of a project made by a CLI import packs the images from that path. `spine-validate` tests all three.

## 4. Coordinates and geometry (task B)

| Item                       | Value                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Image origin and axes      | Top-left corner of the 1280 x 1280 canvas, x right, y down, 1 unit = 1 px. Pixel (i, j) covers [i, i+1) x [j, j+1).                        |
| Spine origin and axes      | Root bone at the bottom center of the canvas (640, 1280), x right, y up. Spine x = image x − 640, Spine y = 1280 − image y.                |
| Scale                      | 1 Spine unit = 1 image px. No bone scale.                                                                                                  |
| Rotation                   | Spine degrees, counterclockwise. Test angles are screen degrees (clockwise, L0-1e convention). Spine rotate value = −(screen degrees).     |
| Bones                      | Start at the marks, point along the limb; a child sits at (parent length, 0). Values have 4 decimals.                                      |
| Hand bone                  | Direction and length from the wrist to the centroid of the hand part (311.03, 640.44). The pivot is the wrist mark.                        |
| Attachments                | Region x, y = image-box center in the bone frame; region rotation = −(bone world rotation), so each image stays upright in the setup pose. |
| Crops                      | Union of the alpha bounds of both variants plus 2 transparent px. Same box in both variants, so both use the same JSON bytes.              |
| Draw order (back to front) | `reference_source_pose` (hidden), `upper_arm_near`, `forearm_near`, `hand_near` (C0.5 order 22, 23, 25).                                   |

| Bone             | Parent           | x        | y      | rotation  | length   | World origin (image px) |
| ---------------- | ---------------- | -------- | ------ | --------- | -------- | ----------------------- |
| `upper_arm_near` | `root`           | −178.2   | 1008.5 | −113.1229 | 198.8769 | 461.8, 271.5 (shoulder) |
| `forearm_near`   | `upper_arm_near` | 198.8769 | 0      | 0.6774    | 166.8392 | 383.7, 454.4 (elbow)    |
| `hand_near`      | `forearm_near`   | 166.8392 | 0      | 6.7046    | 33.0785  | 320.0, 608.6 (wrist)    |

| Slot / attachment       | Image box (left, top, w x h) | Region x, y, rotation      |
| ----------------------- | ---------------------------- | -------------------------- |
| `reference_source_pose` | 247, 221, 276 x 491          | −255, 813.5, 0 (on `root`) |
| `upper_arm_near`        | 357, 245, 142 x 241          | 99.7219, 5.8296, 113.1229  |
| `forearm_near`          | 289, 442, 120 x 199          | 93.7502, 1.1838, 112.4455  |
| `hand_near`             | 271, 600, 90 x 88            | 35.1576, 5.7534, 105.7409  |

The reference slot has no setup attachment. It holds the source pose (all See-through layers, cropped around the arm) at half opacity for a manual comparison in the editor.

## 5. Test animations (task D)

All keys are linear. Times in seconds. Values: screen degrees (Spine value in brackets).

| Animation       | Keys                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `neutral`       | 0 s: all three bones 0 (one key per bone).                                                                        |
| `elbow_test`    | forearm: 0 s 0, 0.5 s −15 (+15), 1 s 0, 1.5 s +15 (−15), 2 s +30 (−30), 2.5 s 0.                                  |
| `wrist_test`    | hand: 0 s 0, 0.5 s −15 (+15), 1 s 0, 1.5 s +15 (−15), 2 s 0.                                                      |
| `combined_test` | forearm / hand: 0 s 0 / 0, 0.5 s +10 / +10, 1 s −10 / −10, 1.5 s +10 / −10, 2 s 0 / 0 (the L0-1e combined tests). |

Bone lengths and pivots do not change between animations. Only rotate keys are used.

## 6. Offline validation (task E)

| Check                             | Result | Detail                                                                                                                                                                                    |
| --------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Essential subset                  | PASS   | Only known fields. A mesh, IK entry, or translate timeline fails the check (tests).                                                                                                       |
| Bone hierarchy                    | PASS   | Expected chain, parents first, no cycle.                                                                                                                                                  |
| Joint positions                   | PASS   | Largest error 1.6e-4 px (4-decimal values).                                                                                                                                               |
| Slots and draw order              | PASS   | As in section 4.                                                                                                                                                                          |
| Region attachments                | PASS   | Each region covers its image box; largest corner error 3.3e-5 px.                                                                                                                         |
| Keyframes                         | PASS   | As in section 5.                                                                                                                                                                          |
| Crop preservation (both)          | PASS   | Each decoded PNG put back at its box equals the full-canvas part (pixel hash). Soft edges are kept.                                                                                       |
| Setup pose (both)                 | PASS   | Region maps are the identity (3e-5); 0 different pixels against the direct composite.                                                                                                     |
| Key poses (both)                  | PASS   | The JSON values reproduce the L0-1e screen rotations; at most 1 different pixel per pose (nearest-neighbor tie).                                                                          |
| Shared skeleton                   | PASS   | Tube and baseline JSON have the same bytes.                                                                                                                                               |
| Source pose on the body, baseline | PASS   | 0 different pixels.                                                                                                                                                                       |
| Source pose on the body, tube     | PASS   | 62 pixels, largest difference 106: the same frame as L0-1g `tube_B` (underlay under soft child edges).                                                                                    |
| spine-core 4.3.13 read            | PASS   | `SkeletonJson` reads both files. Setup joints 1.3e-4 px, region corners 6e-5 px, wrist pivot in 17 key poses 1.4e-4 px from the screen-rotation result (`agent-checks/spinecore-*.json`). |
| Determinism                       | PASS   | Two runs give identical output trees (`diff -r`).                                                                                                                                         |

These checks use a local model of the Spine data and the Spine runtime library. They are not a Spine editor import. Status: `SPINE_IMPORT_UNVERIFIED`.

Previews (`evidence/preview-neutral.png`, `preview-tube.png`, `preview-baseline.png`) use the local nearest-neighbor renderer. Spine uses linear filtering, so its edges are softer. The gaps, seams, and corner protrusions are the same as in L0-1g at these angles (tube: small outline breaks at the outer elbow corner at +30; baseline: open joints).

## 7. Spine CLI validation (owner run)

`spine-validate` is the CLI-first path. It needs no GUI step:

1. Checks the package against `SHA256SUMS` (JSON bytes) and `PIXEL-SHA256SUMS` (PNG pixels; the project storage can re-encode PNG files).
2. Per variant: `Spine --input spine/<v>/arm-spine.json --output <out>/<v>/arm-near-<v>.spine --import arm_near_<v>`.
3. Per variant: `Spine --input <project> --output <out>/<v>/export --export json+pack`.
4. Compares the export with the intended JSON (bones, parents, x, y, rotation modulo 360, length, slots, draw order, colors, region attachments, rotate key times, values, and curves; tolerance 0.01 px or degree, 0.001 s) and checks that the atlas has a region for each image.
5. Writes `cli-validation.json` (format `aigg.m0-f0a.spine-cli-validation/0.2`; 0.3 adds the MVP-A full-body layout) with the executable path and SHA-256, every argument list, exit code, duration, stdout and stderr logs, the exported editor version, all differences, and the accepted curve normalizations.

Curve rule (report format 0.2). In Spine the curve of key k sets the interpolation from key k to key k + 1. The comparison accepts `linear` (or an omitted curve) against `stepped` only when the start and end values of that interval are equal within 0.01 degree in the intended file and in the export. Then both curves give the same rotation at all times. The values are compared as numbers, not modulo 360, because Spine interpolates 10 to 370 degrees through a full turn. The last key starts no interval, so a curve change on it is a difference. A curve change on an interval where the angle changes, and any Bezier curve change, is a difference. Each accepted case is in `normalizations` with the times and values of the interval. The 0.1 comparison also let an intended `stepped` key pass against an omitted (linear) export curve; the new rule closes this gap.

`CLI_VALIDATED: PASS` needs exit code 0 for all four Spine runs, zero differences, and all images in both atlases. Tests run the command against a fake Spine program (success, failed import, changed rotation, missing image). They test the command logic, not Spine.

The design stays batch-ready: one non-interactive command per package, argument arrays, JSON report, logs per step.

### 7.1 First owner run (Spine Essential 4.3.26)

- The owner ran `spine-validate` with the package `689dbc74…`. All four Spine runs (import and export of `baseline` and `tube`) exited with 0. Both atlases have all four images.
- Result: **FAIL** in both variants with one difference: `animations.combined_test.bones.hand_near.rotate[2].curve`, intended `linear`, exported `stepped`.
- Analysis: the intended `hand_near` keys of `combined_test` are (0 s, 0), (0.5 s, −10), (1 s, 10), (1.5 s, 10), (2 s, 0) in Spine degrees. Key 2 starts the only interval of the animation with equal start and end values (10 to 10 from 1 s to 1.5 s). On this interval linear and stepped give the same rotation, so the export changed the text of the curve but not the motion. No other key changed, also not the keys of `forearm_near` at 1 s (value 10 to −10). This agrees with the hypothesis that Spine writes a constant interval as `stepped`. The agent did not see the exported JSON; the times and values of the exported keys 2 and 3 are in the owner's export folder.
- Fix: the curve rule above. The rig, the images, the C0.5 contract, and the animation angles did not change. The package `689dbc74…` stays valid.
- Evidence: the owner keeps the first report (`cli-validation.json` of the first `--out` folder) unchanged. The second run uses a new `--out` folder, so nothing overwrites it.
- `CLI_VALIDATED` stays not passed until the owner runs `spine-validate` again with the corrected command.

## 8. Owner steps

1. Download `research/m0-f0a/m0-f0a-package.tar.gz` from the project files and unpack it, for example to `~/aigg/m0-f0a`.
2. In the repository, on the PR branch: `npm ci --ignore-scripts` and `npm run build --workspace @aigg/control`.
3. Run `node packages/control/dist/src/cli.js spine-validate --spine /Applications/Spine.app/Contents/MacOS/Spine --package ~/aigg/m0-f0a --out ~/aigg/m0-f0a-cli-2` (a new folder for each run; the second run must not use the folder of the first run). Add `--spine-version 4.3.26` to pin the editor version. Exit 0 = `CLI_VALIDATED`, exit 1 = a check failed, exit 2 = an input error.
4. Send `~/aigg/m0-f0a-cli/cli-validation.json` and the `*/logs/` folder.
5. Optional visual check: open `~/aigg/m0-f0a-cli/tube/arm-near-tube.spine` in the Spine editor (or Import Data with `spine/tube/arm-spine.json`, New project). Check the setup pose, play each animation, save, close, and open the project again. Make screenshots or a short video of the setup pose and of `elbow_test` at +30 and `wrist_test` at ±15 for both variants, and of the Images node path.

Manual acceptance questions: all images found; segments aligned; elbow and wrist pivots at the expected places; hand follows the forearm; no hand separation at the elbow turn; remaining holes and seams; difference between baseline and tube; no jumps or shifts; save and reopen in Essential.

## 9. Answers so far

1. **Import without manual positioning?** Prepared: all positions come from the JSON. Not proven until `spine-validate` or Import Data runs.
2. **Source pose equal to the local composite?** Offline yes: baseline bit-exact, tube the known 62-pixel L0-1g difference. Not seen in Spine.
3. **Hierarchy and rotations?** Offline yes, also in spine-core 4.3.13. Not seen in the editor.
4. **Spine artifacts against the L0-1g renderer?** Unknown until the owner's screenshots: Spine filters linearly, so outline steps are softer; gaps and protrusions should be the same.
5. **What a Spine-ready result needs:** a real CLI and editor pass of this package; the owner decisions from L0-1g (overlap shape, neutral-pose policy, child end or angle limit); an artist fix of the outer elbow corner; a decision on the Spine origin and units for full characters (here: canvas bottom center, 1 unit = 1 source px); and the residual fragments.

## 10. Limits

- One concept, one arm, two joints, test use only. The concept is not approved as a product character and its age is not confirmed; the explicitly-adult rule for product characters stays.
- No real Spine run by the agent. The essential-edition compatibility is UNVERIFIED.
- The hand bone direction comes from the hand part centroid, not from a mark.
- Images and packages are derivatives of the licensed test concept. They are only in the project files (`research/m0-f0a/`), not in Git.

## 11. Verification

- `npm run check` passes (format, lint, configuration, workflows, type check, build, tests).
- 25 new tests in `packages/control/test/spinearm.test.ts`: coordinate round trip, sign of the angles, structural checks and their failures, regions on image boxes, a spine-core 4.3.13 read with an animated wrist pivot, crops with soft edges, the full `spine-arm` command on the synthetic arm (checks, file references, byte-equal reruns, manifests), and `spine-validate` with a fake Spine program and through the CLI. The curve tests cover stepped on a constant interval (accepted and recorded, both directions), stepped on changing intervals (fail), a change on the last key (fail), a Bezier curve (fail), full-turn values 10 to 370 and −350 to 10 (fail), an exported end value that changed (fail), and value noise below and above the tolerance.
- Command:

```sh
node packages/control/dist/src/cli.js spine-arm --contract packages/control/test/fixtures/c05-candidate/rig.contract.json \
  --layers <run>/output/concept-mirrored --metadata <run>/output/concept-mirrored.psd.json \
  --image <run>/output/concept-mirrored/src_img.png --landmarks landmarks-manual.json \
  --study <l0-1d phase B align-study>/correspondence.json --out ./m0-f0a
```
