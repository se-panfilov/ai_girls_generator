# @aigg/control

**Draft.** Stage S4 (production art) helper for experiment C0 and the C0.5 view calibration. See [the C0 report](../../docs/proposals/C0_RIG_GUIDED_GENERATION.md) and [the C0.5 report](../../docs/proposals/C05_REFERENCE_MANNEQUIN.md).

The package makes control and reference images from the rig contract, ComfyUI workflow files for a small generation run, and rig overlays of generated images.
It does not run a model, does not contact a server, and does not detect keypoints.

## Commands

Build first: `npm run build --workspace @aigg/control`. Then run `node packages/control/dist/src/cli.js <command>` from the root.

| Command     | Input                                         | Output                                                                                                                                 |
| ----------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `pose`      | `rig.contract.json`, optional `--size WxH`    | `openpose-<mapping>.png` and `.json`, `reference.png`, `reference.svg`, `control.json`                                                 |
| `workflow`  | An OpenPose image, model file names, seeds    | `c0-baseline-<seed>.api.json`, `c0-pose-<seed>.api.json` (ComfyUI API format), `run-plan.json`                                         |
| `overlay`   | `rig.contract.json`, a PNG, optional marks    | `overlay.png`, `side-by-side.png` (control, image, overlay, reference), `overlay.json`, with marks also `aligned-diagnostic.png`       |
| `candidate` | A base `rig.contract.json`, optional `--yaw`  | `rig.contract.json`: the C0.5 candidate geometry (experimental, see below)                                                             |
| `calibrate` | Two contracts, optional Spine `skeleton.json` | Before and after mannequins, joint and slot overlays, OpenPose images, `comparison.png`, `animation-key-poses.png`, `calibration.json` |
| `depth`     | The C0.5 candidate `rig.contract.json`        | `depth-c05.png` (approximate depth), `depth-parts.png`, `depth-top-view.png`, `depth-preview.png`, `depth.json` (assumptions, checks)  |
| `bundle`    | The C0.5 candidate `rig.contract.json`        | The experiment C execution bundle, `--experiment c1` (default) or `c2` (see below)                                                     |

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

No runtime dependencies. PNG files are written and read with `node:zlib`, because only 8-bit RGB and RGBA control images are necessary. The experiment C runner uses only Node.js built-ins (`fetch`, `node:fs`, `node:crypto`). See [SECURITY.md](SECURITY.md).
Supported view: `three_quarter_right` with `near_far` side names. Other views stop with `E_VIEW_UNSUPPORTED`.
