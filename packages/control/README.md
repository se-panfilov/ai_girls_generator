# @aigg/control

**Draft.** Stage S4 (production art) helper for experiment C0 and the C0.5 view calibration. See [the C0 report](../../docs/proposals/C0_RIG_GUIDED_GENERATION.md) and [the C0.5 report](../../docs/proposals/C05_REFERENCE_MANNEQUIN.md).

The package makes control and reference images from the rig contract, ComfyUI workflow files for a small generation run, and rig overlays of generated images.
It does not run a model, does not contact a server, and does not detect keypoints.

## Commands

Build first: `npm run build --workspace @aigg/control`. Then run `node packages/control/dist/src/cli.js <command>` from the root.

| Command             | Input                                                                                                                     | Output                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pose`              | `rig.contract.json`, optional `--size WxH`                                                                                | `openpose-<mapping>.png` and `.json`, `reference.png`, `reference.svg`, `control.json`                                                                    |
| `workflow`          | An OpenPose image, model file names, seeds                                                                                | `c0-baseline-<seed>.api.json`, `c0-pose-<seed>.api.json` (ComfyUI API format), `run-plan.json`                                                            |
| `overlay`           | `rig.contract.json`, a PNG, optional marks                                                                                | `overlay.png`, `side-by-side.png` (control, image, overlay, reference), `overlay.json`, with marks also `aligned-diagnostic.png`                          |
| `candidate`         | A base `rig.contract.json`, optional `--yaw`                                                                              | `rig.contract.json`: the C0.5 candidate geometry (experimental, see below)                                                                                |
| `calibrate`         | Two contracts, optional Spine `skeleton.json`                                                                             | Before and after mannequins, joint and slot overlays, OpenPose images, `comparison.png`, `animation-key-poses.png`, `calibration.json`                    |
| `depth`             | The C0.5 candidate `rig.contract.json`                                                                                    | `depth-c05.png` (approximate depth), `depth-parts.png`, `depth-top-view.png`, `depth-preview.png`, `depth.json` (assumptions, checks)                     |
| `bundle`            | The C0.5 candidate `rig.contract.json`                                                                                    | The experiment C execution bundle, `--experiment c1` (default) or `c2` (see below)                                                                        |
| `split-layers`      | See-through layer PNGs and `<stem>.psd.json`                                                                              | L0-1b prototype: `parts/`, `residual/`, `analysis/`, `compose/`, `motion/`, `contact-sheet.png`, `l0-1b.json` (see below)                                 |
| `align-study`       | C0.5 contract, See-through layers, the input                                                                              | L0-1c prototype: `landmarks.json`, `correspondence.json`, a manual landmark template, five diagnostic images (see below)                                  |
| `annotate-page`     | The input image, `align-study` `landmarks.json`                                                                           | L0-1d prototype: `annotate.html`, one self-contained page for manual landmark marks (see below)                                                           |
| `compare-landmarks` | The input image, two `align-study` runs (`landmarks.json`, `correspondence.json`)                                         | L0-1d prototype: before and after images and `comparison.json` (see below)                                                                                |
| `limb-study`        | The C0.5 contract, the See-through layers, the input image, the manual landmarks, the `align-study` `correspondence.json` | L0-1e prototype: the near arm cut into three parts, overlap and rotation measurements, and review images (see below)                                      |
| `underlay-study`    | The same inputs as `limb-study`                                                                                           | L0-1f prototype: deterministic joint underlay (nearest edge, directional) at the elbow and the wrist, compared with the `limb-study` baseline (see below) |
| `geometry-study`    | The same inputs as `limb-study`                                                                                           | L0-1g prototype: three diagnostic underlay regions with and without the occlusion-safe rule, wider diagnostic angles, and shifted joint marks (see below) |
| `spine-arm`         | The same inputs as `limb-study`                                                                                           | M0-F0a prototype: an import-ready Spine 4.3 skeleton JSON and cropped region PNGs of the near arm (tube and baseline), checks, previews (see below)       |
| `assemble-body`     | The same inputs as `limb-study`                                                                                           | MVP-A prototype: the full-body test character on the C0.5 bones and slots, Spine 4.3 JSON, region PNGs, `idle` and `wave`, evidence, previews (see below) |
| `spine-validate`    | The licensed Spine executable, a `spine-arm` or `assemble-body` output directory                                          | Spine CLI import and export of each skeleton, comparison with the intended skeleton, `cli-validation.json`, and logs (see below)                          |
| `template`          | The C0.5 candidate `rig.contract.json`                                                                                    | The T1a static template (prototype): `template.json`, line art, region map, masks, `overlay-sheet.png`, `review.md`, `mock-package/`                      |
| `sheet-fixture`     | The C0.5 candidate `rig.contract.json`                                                                                    | V2-1 prototype: the synthetic modular sheet, its layout descriptor, and its check (see below)                                                             |
| `sheet-check`       | A rig contract, a modular sheet PNG, its layout descriptor                                                                | V2-1 prototype: `sheet-check.json` with the descriptor and pixel checks (see below)                                                                       |

Each command prints one JSON report. Exit status: 0 PASS, 1 FAIL, 2 usage or input error, 3 INCOMPLETE. All commands accept `--dry-run` and `--force`.

Example (the L1 test rig, the 832 x 1216 SDXL bucket):

```sh
node packages/control/dist/src/cli.js pose --contract packages/rig-runtime/test/fixtures/l1-owner/rig.contract.json --size 832x1216 --out /tmp/c0/control
node packages/control/dist/src/cli.js workflow --pose-image /tmp/c0/control/openpose-detector.png --out /tmp/c0/workflows \
  --checkpoint animagine-xl-4.0.safetensors --controlnet diffusion_pytorch_model_promax.safetensors --seeds 1001,1002,1003
node packages/control/dist/src/cli.js overlay --contract packages/rig-runtime/test/fixtures/l1-owner/rig.contract.json --image generated.png --out /tmp/c0/overlay
```

## Coordinates

The contract canvas is scaled uniformly into the target size and centered. The proportions do not change.
`control.json` and `overlay.json` record the scale and the offsets. Keypoints are given in contract pixels and in target pixels.

## OpenPose image

- BODY_18 keypoints in COCO order, the limb list and the colors of `draw_bodypose` in controlnet_aux. Black background, limbs at 60 % color, joints at full color.
- Line width as in the drawing function of the xinsir/controlnet-openpose-sdxl-1.0 model card: half-width and joint radius `4 * ratio`, with ratio 3 for a longer side from 1000 to 1999 pixels.
- Not bit-exact to OpenCV output. Edges can differ by one pixel.
- Body keypoints come from contract bones: shoulder `upper_arm_*`, elbow `forearm_*`, wrist `hand_*`, hip `thigh_*`, knee `shin_*`, ankle `foot_*`. The neck is the midpoint of the shoulders.
- **Assumption:** the face keypoints (nose, eyes, near ear) are not in the contract. Fixed fractions of the `head` rectangle place them (`faceTemplate`). The far ear is hidden.
- Side mapping: `detector` gives the subject's right to the side whose shoulder is on the left of the image (as a pose detector does for a front view). `anatomical` gives it to `_near`. For a layout with the near side on the left, both are the same.

## Reference mannequin and view checks (C0.5)

- `candidate` projects a simple 3D reference body (`referenceBody`: 7 head heights, yaw 40 degrees, arms slightly away from the torso) into the canvas of a base contract.
  It keeps all ids, parents, slots, draw order and animations, and replaces joints, rectangles and points. The result is a **proposal**, not an accepted contract.
- `calibrate` draws a flat mannequin from contract joints only (the same generic widths for both contracts), in slot draw order, with face marks.
  It runs the consistency checks V1 to V11 (side order, front/back cues, face direction, BODY_18 labels, draw order, rectangles, proportion proxy, arm separation) and writes the migration table.
  With `--skeleton`, it poses both contracts at the most extreme key of each animation (forward kinematics, linear keys, rotate and translate only).
- Face keypoints come from contract points `face_nose`, `face_eye_<side>` and `face_ear_<side>` when they exist. Otherwise the face template is used.

## Static template (T1a)

**Prototype.** `template` makes a static template of the C0.5 candidate geometry in the setup pose. See [the T0 ADR, section 16](../../docs/proposals/T0_TEMPLATE_FIRST_ARCHITECTURE.md#16-t1a-specification).

```sh
node packages/control/dist/src/cli.js template --contract packages/control/test/fixtures/c05-candidate/rig.contract.json --out ./t1a-output
```

- Geometry source: the volumes of the `depth` command (C0.5 reference body). One ray goes through the center of each pixel.
  A slot owns a pixel when its volume is hit and no hit slot has a higher draw order, as Spine draws the setup pose. `drawOrderConflicts` in `template.json` lists pixels where another slot is nearer in 3D.
- The torso volume is split between `torso` and `hips` at the spine joint height. Hair, ears, tail, skirt, accessory, weapon and `hand_near_front` have no volume and no mask.
- `mock-package/` has one flat-color PNG for each required slot (the visible area plus the joint overlap circles of the contract), with the size of the attachment rectangle, and `character.json` with optional slots `absent_by_design` (D22).
  Required slots without a volume (`hair_back`, `hair_front`) get a hatched placeholder frame, not a shape.
- Checks: G1 (contract matches the reference body), N1 to N3 (near/far order, face and feet direction), M1 to M3 (masks and overlap circles inside the attachment rectangles, no empty mask). A failed check gives status FAIL; the files are still written for review.
- `template.json` has the status `prototype` and marks motion coverage and Spine compatibility as `not_validated`. Parser acceptance of the mock package is a structural check only.
- The images are review and reference material. Do not commit them while decision D15 is open.

## Experiment C execution bundle

The owner runs experiment C on a rented GPU host. The agent prepares the bundle, the owner runs it, and the agent analyzes the images.

```sh
npm run build --workspace @aigg/control
node packages/control/dist/src/cli.js bundle --contract packages/control/test/fixtures/c05-candidate/rig.contract.json --out /tmp/exp-c-bundle
```

The bundle is a flat directory: `run.sh` (thin wrapper), `runner.mjs` (compiled from `src/runner.ts`, Node.js built-ins only), `bundle.json` (model manifest, runs, file hashes),
the OpenPose image, one baseline and one pose-guided workflow (seed 1001), `run-plan.json`, `README.md` (the steps on the Pod), and `SHA256SUMS`. The build is deterministic.

On the Pod, `sh run.sh --models-dir <ComfyUI models folder>` checks the bundle and ComfyUI at `127.0.0.1:8188`, downloads only the two approved model files from pinned revisions with a SHA-256 check,
runs the two workflows once, and writes the images, `SHA256SUMS`, `result.json`, and `run.log`. `sh run.sh status` reads the results directory. See [SECURITY.md](SECURITY.md) for the controls.
The runner needs Node.js 22.12 or later on the GPU host (the development version is in `.nvmrc`). It refuses any other model list, other runs, or a second submission of a recorded prompt. Before any download it checks every node input and the union types against the live ComfyUI (`/object_info`).

## Approximate depth image (C2)

`depth` renders the C0.5 reference body (`referenceBody` in `src/mannequin.ts`) as simple volumes: one smooth torso with elliptic sections, ellipsoids for the head and the nose, capsules for the neck, limbs, hands and feet.
Each pixel casts 2 x 2 orthographic rays at the reference yaw (40 degrees). The nearest surface wins, so near limbs cover far limbs. Near is bright, far is dark, the background is black.
It is a **relative depth approximation, not a physical 3D model**: no hair, no clothing, no fingers, no breasts, no face detail except a small nose. The values that `referenceBody` does not give are in `depthAssumptions` (`src/depth.ts`) and in `depth.json`.

Checks: D1 joints and D2 face points of the volumes project onto the contract within 1 px (the C0.5 candidate is not changed); D3 the face and D4 the feet turn to the image right and to the camera;
D5 the near limbs are nearer than the far limbs; D6 the near limbs cover more pixels; D7 every part is visible. The preview sheet shows the depth, the OpenPose image, both together, the shaded volumes, the C0.5 flat mannequin, and a top view.

```sh
node packages/control/dist/src/cli.js depth --contract packages/control/test/fixtures/c05-candidate/rig.contract.json --out /tmp/c2-depth
node packages/control/dist/src/cli.js bundle --experiment c2 --contract packages/control/test/fixtures/c05-candidate/rig.contract.json --out /tmp/exp-c2-bundle
```

The C2 bundle (format `aigg.exp-c-bundle/0.2`) has six runs: condition A (OpenPose) and condition B (OpenPose + depth) for the seeds 1001, 1002 and 1003, both control images, and its own README with the Runpod steps.
The runner accepts only these six runs (fixed seeds, run ids, and workflow files). Other seeds give `E_BUNDLE_RUNS` before any request to ComfyUI. The runner does not stop or terminate the GPU host; the spend limit and the teardown are owner actions.
The runner refuses a C2 bundle in which A and B of a seed differ in more than the depth nodes. See [the C2 preparation report](../../docs/proposals/C2_PREPARATION.md).

## Layer split (L0-1b)

**Prototype.** `split-layers` analyzes the See-through layers `handwear`, `legwear`, `footwear`, `topwear`, and `bottomwear`, and tries to split arms, legs, and shoes into image-left and image-right parts. See [the L0-1b report](../../docs/proposals/L0_1B_SPLIT_FEASIBILITY.md).

```sh
node packages/control/dist/src/cli.js split-layers --layers <run>/output/concept-mirrored --metadata <run>/output/concept-mirrored.psd.json --out ./l0-1b-output
```

- Input: one full-canvas 8-bit RGBA PNG for each tag in the metadata (`<dir>/<tag>.png`, at most 2048 x 2048). Missing files of other layers are listed. The five analyzed layers are required.
- Draw order: `depth_median` from far to near (See-through writes the PSD layers in this order).
- Split without a cut line: connected components, then higher alpha thresholds, then erosion, and for legs the scan rows that background separates. Pixels that need a guess stay in a residual file (`merged`, `contact`, `isolated`, `unsplit`).
- Each part PNG has the full canvas and the source RGBA values. The RGB values of alpha-0 source pixels are not kept.
- Checks: S1 exact partition (no lost, duplicated, changed, or extra pixel), S2 the reference pose from the parts equals the reference pose from the source layers, S3 the required layers exist. A layer that does not split is a valid result. It does not fail the command.
- Trial motion turns the parts about a pivot hypothesis (top 20 rows of the part). The pivots, the side names, and the bounds are not rig data. The output is not a Spine package.
- The output images are derivatives of the input art. Do not commit them.

## Alignment study (L0-1c)

**Prototype.** `align-study` measures anatomical landmarks on the See-through layers and compares them with the C0.5 template joints. It does not cut or warp the art. See [the L0-1c report](../../docs/proposals/L0_1C_ALIGNMENT_FEASIBILITY.md).

```sh
node packages/control/dist/src/cli.js align-study --contract packages/control/test/fixtures/c05-candidate/rig.contract.json \
  --layers <run>/output/concept-mirrored --metadata <run>/output/concept-mirrored.psd.json \
  --image <run>/output/concept-mirrored/src_img.png --out ./l0-1c-output [--landmarks manual.json]
```

- Required layers: `face`, `front hair`, `neck`, `topwear`, `handwear`, `legwear`, `footwear`, `bottomwear`. The face feature layers `nose`, `mouth`, and `irides` are optional: See-through can omit a tag (for example the nose of a head in profile). A missing feature layer gives unknown landmarks (method `layer missing`).
- `--image` is the See-through input at the layer frame size. The tool compares each layer pixel with it: a pixel that does not match is a See-through completion under another part, not drawn evidence.
- Landmarks have image side names (`_image_left`, `_image_right`), a visibility (`visible`, `occluded`, `inferred`, `unknown`), a confidence, the method, the source layers, and a note. An `unknown` landmark has no point, only a range. The color and shape rules are data-specific assumptions and are listed in `landmarks.json`.
- Fits: uniform scale, similarity, and affine, with residuals in percent of the template body height, for two hypotheses (`near_is_image_left`, `near_is_image_right`) and two landmark sets (confidence medium or more, low or more). Also per segment length ratios and angle differences, triangle maps (anisotropy, reflection), near and far cues, and cut-line candidates.
- Manual landmarks: `landmarks-manual.template.json` (format `aigg.l0-1c.landmarks/0.1`) lists all ids as unknown. A person adds `x` and `y` only for points that they can see or derive from visible geometry. A manual entry replaces the automatic entry with the same id.
- Images: `a-anatomy-overlay.png`, `b-skeleton-comparison.png`, `c-alignment-diagnostics.png`, `d-segmentation-map.png`, `e-uncertainty-map.png`, and `contact-sheet.png`. They are derivatives of the input art. Do not commit them.

## Manual landmark page (L0-1d)

**Prototype.** `annotate-page` writes `annotate.html`: one HTML file with the image, the automatic L0-1c landmarks, and the page code. Open it from the disk in a browser. It needs no server, no network, and no account. See [the L0-1d report](../../docs/proposals/L0_1D_LANDMARK_CALIBRATION.md).

```sh
node packages/control/dist/src/cli.js annotate-page --image <run>/output/concept-mirrored/src_img.png \
  --landmarks <align-study output>/landmarks.json --out ./l0-1d-page [--manual landmarks-manual.json]
```

- Select a landmark, click the image to put a point, drag to correct it, or draw a range and set it to unknown. Wheel zoom, drag pan, undo. Coordinates stay in the image frame at all zoom levels.
- A new point starts as `inferred` with `low` confidence. The person must raise it on purpose.
- "Export JSON" downloads `landmarks-manual.json` in the L0-1c manual format (`aigg.l0-1c.landmarks/0.1`). The page refuses export while an entry breaks a parser rule. Only reviewed landmarks are written; the others keep the automatic value. An unknown entry has no `x` and `y`.
- The file also has `session`: active seconds (gaps between actions, each at most 60 s) and counters (placements, re-placements, moves, ranges, unknowns, undos). `parseManualLandmarks` ignores these fields.
- Use the file with `align-study --landmarks`. `--manual` loads it into a new page to continue.
- The browser keeps unsaved work in local storage for the same image. The page is a derivative of the input art. Do not commit it.

### Before and after comparison

**Prototype.** `compare-landmarks` compares two `align-study` runs, for example the automatic landmarks (before) and a run with `--landmarks landmarks-manual.json` (after). It does not run a new alignment. The similarity fit uses the pairs of each run with the `align-study` rule (medium or more, near = image-left).

```sh
node packages/control/dist/src/cli.js compare-landmarks --image <run>/output/concept-mirrored/src_img.png \
  --before-landmarks <before>/landmarks.json --before-study <before>/correspondence.json \
  --after-landmarks <after>/landmarks.json --after-study <after>/correspondence.json --out ./l0-1d-compare
```

- `comparison.json` (format `aigg.l0-1d.compare-landmarks/0.1`): the shift of each landmark, the fits before, after, and after on the landmark set of the first run, residuals per landmark, and counts.
- Images: `before-after-landmarks.png`, `alignment-before-after.png`, `error-vectors.png` (vectors times 3), and `contact-sheet.png`. They are derivatives of the input art. Do not commit them.

## Near arm cut and rotation (L0-1e)

**Prototype.** `limb-study` cuts the image-left (near) arm of the handwear layer into an upper arm, a forearm, and a hand at the manual shoulder, elbow, and wrist marks. It measures the C0.5 joint overlap and turns the elbow and the wrist for diagnostics. It copies source pixels only: it does not paint, fill, or generate pixels. See [the L0-1e report](../../docs/proposals/L0_1E_NEAR_ARM_FEASIBILITY.md).

```sh
node packages/control/dist/src/cli.js limb-study --contract <C0.5 rig.contract.json> --layers <run>/output/concept-mirrored \
  --metadata <run>/output/concept-mirrored.psd.json --image <run>/output/concept-mirrored/src_img.png \
  --landmarks landmarks-manual.json --study <align-study with these landmarks>/correspondence.json --out ./l0-1e
```

- Each cut line goes through a joint mark. Its normal is the mean of the two limb directions. Pixels that the cut cannot give to one part go to `parts/residual.png`. The parts and the residual are an exact partition of the arm.
- `--study` gives the similarity scale from image px to template px. The command refuses a study that was made with another manual file or image.
- Tests: source pose, elbow ±15 and ±30, wrist ±15, and three combined turns. Positive is clockwise on the screen. The angles are not animation limits.
- `metrics.json` (format `aigg.l0-1e.limb-study/0.1`): the pixel classes, conservation, overlap per joint, and per test the opened gap, protrusion, overlap, and seam counts.
- Images: `1-joints-and-cut-lines.png`, `2-parts.png`, `3-rotation-contact-sheet.png`, `4-gap-overlap-heatmap.png`, `5-source-vs-recomposed.png`, `6-missing-geometry.png`, and `rotations/<test>/{result,holes,overlaps}.png`. They are derivatives of the input art. Do not commit them.

## Joint underlay (L0-1f)

**Prototype.** `underlay-study` uses the `limb-study` cut without change and adds parent pixels under the elbow and the wrist with two deterministic raster methods. Then it runs the same rotation tests and metrics for the baseline and both methods. See [the L0-1f report](../../docs/proposals/L0_1F_UNDERLAY_FEASIBILITY.md).

```sh
node packages/control/dist/src/cli.js underlay-study --contract <C0.5 rig.contract.json> --layers <run>/output/concept-mirrored \
  --metadata <run>/output/concept-mirrored.psd.json --image <run>/output/concept-mirrored/src_img.png \
  --landmarks landmarks-manual.json --study <align-study with these landmarks>/correspondence.json --out ./l0-1f
```

- Region of each joint: the child side of the cut line, inside the C0.5 overlap circle (24 template px divided by the similarity scale, not rounded), inside the source cross-section along the cut line, and only where the parent has no pixel.
- Method A (`nearest_edge`): a copy of the nearest parent pixel within 3 px before the cut line.
- Method B (`directional`): back along the limb axis to 1 px inside the parent. A gradient from two opaque samples 6 px apart when their RGB step is at most 64, limited to that step. Else a copy of the first sample. No sample gives an unresolved pixel (inside the child) or no pixel (outside the contour).
- Every new pixel has the provenance `generated_by_deterministic_extension` with its source pixel and rule in `provenance.json`.
- `metrics.json` (format `aigg.l0-1f.underlay-study/0.1`): the regions, the fill counts, the invariant checks, the neutral pose difference, and per test the L0-1e metrics of each variant. The exit status is 0 when the invariants hold. It does not measure art quality.
- Images: `1-new-pixel-masks.png`, `2-comparison-on-body.png`, `3-comparison-on-magenta.png`, `4-problem-heatmaps.png`, `5-zoom-elbow.png`, `5-zoom-wrist.png`, `6-source-pose.png`, and `<method>/{parts,rotations}/...`. They are derivatives of the input art. Do not commit them.

## Joint geometry (L0-1g)

**Prototype.** `geometry-study` compares three diagnostic underlay regions at the elbow and the wrist, each with and without the occlusion-safe rule, with the two L0-1f fill methods. The regions B and C are research alternatives, not a change of the C0.5 overlap rule. See [the L0-1g report](../../docs/proposals/L0_1G_JOINT_GEOMETRY.md).

```sh
node packages/control/dist/src/cli.js geometry-study --contract <C0.5 rig.contract.json> --layers <run>/output/concept-mirrored \
  --metadata <run>/output/concept-mirrored.psd.json --image <run>/output/concept-mirrored/src_img.png \
  --landmarks landmarks-manual.json --study <align-study with these landmarks>/correspondence.json --out ./l0-1g
```

- Region A `circle`: the L0-1f region. Region B `wide_circle`: the same rule with the largest cross-section extent as radius (not smaller than the C0.5 radius). Region C `tube`: the parent cross-section swept along the parent axis past the cut line, to the C0.5 radius in depth.
- Occlusion-safe rule (`_safe` variants): only region pixels where the child is fully opaque in the source pose. Then the source pose stays bit-exact.
- Angles: the L0-1e angles and a group of wider diagnostic angles (±2, ±45, ±60 at the elbow; ±2, ±30, ±45 at the wrist). They are not animation limits.
- Sensitivity: the elbow and wrist marks shifted by ±2 and ±4 px in x and y, with the L0-1e angles.
- `metrics.json` (format `aigg.l0-1g.geometry-study/0.1`). Images: `1-regions.png`, `2-sheet-{body,transparent,magenta}.png`, `3-zoom-{elbow,wrist}-{body,transparent,magenta}.png`, `4-problem-heatmaps.png`, `5-source-pose-difference.png`, and `transparent/<variant>/<test>.png`. They are derivatives of the input art. Do not commit them.
- The run takes several minutes.

## Spine arm package (M0-F0a)

**Prototype.** `spine-arm` makes a minimal Spine skeleton for the image-left (near) arm: `root > upper_arm_near > forearm_near > hand_near`, one slot and one region attachment per part, the draw order of the C0.5 candidate, and four test animations with linear rotate keys (`neutral`, `elbow_test`, `wrist_test`, `combined_test`). It uses only Spine Essential features: no mesh, no constraint, no clipping, no physics. See [the M0-F0a report](../../docs/proposals/M0_F0A_SPINE_ARM_VALIDATION.md).

```sh
node packages/control/dist/src/cli.js spine-arm --contract <C0.5 rig.contract.json> --layers <run>/output/concept-mirrored \
  --metadata <run>/output/concept-mirrored.psd.json --image <run>/output/concept-mirrored/src_img.png \
  --landmarks landmarks-manual.json --study <align-study with these landmarks>/correspondence.json --out ./m0-f0a
```

- Coordinates: Spine origin at the bottom center of the source canvas, x right, y up, 1 Spine unit = 1 image px. Bones start at the manual shoulder, elbow, and wrist marks and point along the limb. A region attachment is centered on its image box, with `rotation = -(bone world rotation)`.
- Test angles are screen degrees in the L0-1e convention (clockwise positive). The Spine rotate value is the negative value. The angles are diagnostic values, not limits.
- Variants: `spine/tube/` (the L0-1g tube underlay, method B) and `spine/baseline/` (the L0-1e parts). One crop box per part for both variants, so both use the same skeleton JSON bytes. A hidden `reference_source_pose` slot holds the source pose for comparison.
- Offline checks (`evidence/validation.json`): Essential subset, bone hierarchy, joint positions, slots and draw order, region boxes, keyframes, crop preservation, setup pose, key poses against the L0-1e renderer, and the source pose on the body. The result is `JSON_GENERATED` only and `SPINE_IMPORT_UNVERIFIED`.
- Files: `spine/<variant>/arm-spine.json`, `spine/<variant>/images/*.png`, `evidence/geometry.json`, `evidence/validation.json`, `evidence/preview-*.png`, `README.md`, `SHA256SUMS`, `PIXEL-SHA256SUMS`. The PNG files are derivatives of the input art. Do not commit them.

`spine-validate` runs the owner's licensed Spine through its command-line interface. It does not use the GUI.

```sh
node packages/control/dist/src/cli.js spine-validate --spine /Applications/Spine.app/Contents/MacOS/Spine \
  --package ./m0-f0a --out ./m0-f0a-cli [--spine-version 4.3.26]
```

- It checks the package against `SHA256SUMS` (JSON bytes) and `PIXEL-SHA256SUMS` (PNG pixels), then per variant runs `Spine --input <json> --output <dir>/<variant>/arm-near-<variant>.spine --import arm_near_<variant>` and `Spine --input <project> --output <dir>/<variant>/export --export json+pack`.
- It compares the exported JSON with the intended skeleton (bones, parents, positions, rotations, lengths, slots, draw order, region attachments, rotate keys) and checks that the atlas has a region for every image.
- Curves: `linear` and `stepped` are equal only on an interval with the same start and end value (as numbers, not modulo 360) in both files, because both then give the same rotation. Spine 4.3.26 writes such an interval as `stepped`. Each accepted case is in `normalizations`. All other curve changes, and a change on the last key, are differences.
- `cli-validation.json` reports `CLI_VALIDATED: PASS` only when all steps exit with 0 and all checks pass. It keeps stdout, stderr, exit codes, and durations. `--dry-run` checks the package and prints the commands without running Spine.
- The output directory must be new. `--force` is refused.

## Full-body package (MVP-A)

**Prototype.** `assemble-body` assembles one full-body test character from the existing L0 results on the bone and slot ids and the draw order of the C0.5 candidate contract. It uses the M0-F0a coordinate frame and only Spine Essential features. See [the MVP-A report](../../docs/proposals/MVP_A_FULL_BODY_ASSEMBLY.md).

```sh
node packages/control/dist/src/cli.js assemble-body --contract <C0.5 rig.contract.json> --layers <run>/output/concept-mirrored \
  --metadata <run>/output/concept-mirrored.psd.json --image <run>/output/concept-mirrored/src_img.png \
  --landmarks landmarks-manual.json --study <align-study with these landmarks>/correspondence.json --out ./mvp-a
```

- Joints: candidate geometry from the manual marks (L0-1d). The torso and head joints are on the mark lines at the shares of the C0.5 joints. The hidden far shoulder is an estimate. Bones without marks (hair tail, ears, tail, skirt, weapon grip, aim) get the contract joint through a similarity fit. `evidence/assembly.json` gives the source and the uncertainty of each joint.
- Layers to slots: a fixed table (`layerRules`). Arms: the L0-1e cut (near arm with the L0-1g tube underlay), the same rule at the far marks. Legs and shoes: the L0-1b split, then the cut rule at hip, knee, and ankle. Sleeves: the nearest-segment rule. Skirt: above the hip line to `hips`, below it to `skirt_front`. The held object goes into `hand_far`, because the contract `weapon` slot is under the near hand. Residual and merged pixels go to the nearest segment (deterministic breadth-first fill). Hidden pixels move along `transferPairs` so that the contract draw order keeps the source look.
- Each See-through pixel is in exactly one slot image (checked). Optional slots without pixels are `absent_by_design` in `character.json`.
- Animations: `idle` (2 s) and `wave` (2.4 s, near arm). Linear rotate keys. Demonstration only.
- Offline checks (`evidence/validation.json`): Essential subset, hierarchy, joints, slots and draw order, regions, animations, image files, required parts, pixel conservation, setup pose render, and the share of pixels that differ from the source composite. The result is `JSON_GENERATED` only; the overall status is `WAITING_FOR_SPINE_CLI_VALIDATION`.
- Files: `spine/skeleton.json`, `spine/images/<slot>.png`, `character.json`, `evidence/assembly.json`, `evidence/validation.json`, `evidence/provenance.json`, `previews/*.png`, `README.md`, `SHA256SUMS`, `PIXEL-SHA256SUMS`. The PNG files are derivatives of the input art. Do not commit them.
- `spine-validate` finds this layout by `spine/skeleton.json` and runs one import and one export (`<out>/body/`). The atlas must have a region for each attachment of the skeleton.

## Modular sheet (V2-1)

**Prototype.** Pipeline v2 step V2-1. `sheet-fixture` and `sheet-check` implement the proposed [Modular Sheet Contract v0.1](../../docs/PIPELINE_V2_MODULAR_SHEET.md). They do not extract parts and do not write a character package.

```sh
node packages/control/dist/src/cli.js sheet-fixture --contract packages/control/test/fixtures/c05-candidate/rig.contract.json --out ./v2-sheet
node packages/control/dist/src/cli.js sheet-check --contract packages/control/test/fixtures/c05-candidate/rig.contract.json \
  --descriptor ./v2-sheet/synthetic-sheet.json --sheet ./v2-sheet/synthetic-sheet.png --out ./v2-sheet-check
```

- `sheet-fixture` writes `synthetic-sheet.png` (the 18 required T1a mock parts on shelves and a 256 x 384 reference preview), `synthetic-sheet.json` (the layout descriptor), and `synthetic-sheet.check.json`. Flat colors, no art, no model.
- `sheet-check` validates the descriptor against [the schema](schemas/modular-sheet.schema.json) rules and the target contract (slot ids, required and absent slots, joints), then checks the PNG: file SHA-256, size, alpha channel, non-empty parts, and no foreground (alpha >= 16) outside the region boxes. It reports the bounds, the pixel counts, and the component count of each region.
- It cannot check semantic rules: that the art in a region is the named slot, the near and far side, the view, hidden geometry, and joint overlap. A human checks them.

## Exit status

Each command writes `status` in its report: `PASS` (exit 0), `FAIL` (exit 1), or `INCOMPLETE` (exit 3). A usage or input error gives `ERROR` (exit 2). For the study commands, `status` covers only the technical invariants. A PARTIAL research result (for example `study.cut` of `limb-study`) is in other report fields and does not change the exit status.

## Measurement

`overlay --marks marks.json` compares keypoints that a person marked on the image with the rig. The tool does not find keypoints itself.

```json
{ "format": "aigg.pose-marks/0.1", "image": { "width": 832, "height": 1216, "sha256": "<optional>" }, "markedBy": "name", "points": { "r_shoulder": { "x": 380, "y": 470 } } }
```

The error is the distance in contract pixels divided by the body height (from the top of the `head` rectangle to the rig origin). The thresholds come from `tolerances` in the contract.
Only the 13 body keypoints are scored. Missing keypoints give INCOMPLETE.

Optional fields (all in format `aigg.pose-marks/0.1`):

- `origin`: who made the marks and how, for example "visual estimate, not confirmed by the owner".
- `points.<name>.confidence`: `high`, `medium`, or `low`. Use `low` for a joint that clothing or hair hides. A point without it is `unspecified` and counts as confident.
- `points.<name>.note`: a short reason for the position.
- `unmeasurable`: `{ "<name>": "<reason>" }` for keypoints that cannot be marked. They are not "missing". A scored keypoint here gives INCOMPLETE, not PASS.
- `extent`: `{ "headTop": {x, y}, "ground": {x, y} }`, the visible top of the head (hair included) and the ground line, in image pixels. They give the composition check.

The measurement then also has:

- `confident`: the error summary for high and medium marks only.
- `face`: the error of the marked face keypoints. They are not scored, because the face template is an assumption.
- `alignment`: **diagnostic only**. The uniform scale and translation that move the marks nearest to the rig (least squares, no rotation), the error that remains after it, and `segments[].ratioScaleFree`.
  It shows how much of the error is size and position of the whole figure. The result status never uses it. With marks, `overlay` also writes `aligned-diagnostic.png`: the moved rig skeleton over the unchanged image.
- `composition`: the marked body height divided by the rig body height, and the offsets of the head top and the ground line in % of body height.

The overlay draws each mark as a cross: white inside tolerance, red outside tolerance, yellow for a low-confidence mark outside tolerance. The tool never changes the input image.

## Dependencies and limits

No runtime dependencies. PNG files are written and read with `node:zlib`, because only 8-bit RGB and RGBA images are necessary. The experiment C runner uses only Node.js built-ins (`fetch`, `node:fs`, `node:crypto`). See [SECURITY.md](SECURITY.md).
Supported view: `three_quarter_right` with `near_far` side names. Other views stop with `E_VIEW_UNSUPPORTED`.
