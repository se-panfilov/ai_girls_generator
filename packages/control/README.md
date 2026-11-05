# @aigg/control

**Draft.** Stage S4 (production art) helper for experiment C0. See [the C0 report](../../docs/proposals/C0_RIG_GUIDED_GENERATION.md).

The package makes control and reference images from the rig contract, ComfyUI workflow files for a small generation run, and rig overlays of generated images.
It does not run a model, does not contact a server, and does not detect keypoints.

## Commands

Build first: `npm run build --workspace @aigg/control`. Then run `node packages/control/dist/src/cli.js <command>` from the root.

| Command    | Input                                      | Output                                                                                         |
| ---------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `pose`     | `rig.contract.json`, optional `--size WxH` | `openpose-<mapping>.png` and `.json`, `reference.png`, `reference.svg`, `control.json`         |
| `workflow` | An OpenPose image, model file names, seeds | `c0-baseline-<seed>.api.json`, `c0-pose-<seed>.api.json` (ComfyUI API format), `run-plan.json` |
| `overlay`  | `rig.contract.json`, a PNG, optional marks | `overlay.png`, `side-by-side.png` (control, image, overlay, reference), `overlay.json`         |

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

## Measurement

`overlay --marks marks.json` compares keypoints that a person marked on the image with the rig. The tool does not find keypoints itself.

```json
{ "format": "aigg.pose-marks/0.1", "image": { "width": 832, "height": 1216, "sha256": "<optional>" }, "markedBy": "name", "points": { "r_shoulder": { "x": 380, "y": 470 } } }
```

The error is the distance in contract pixels divided by the body height (from the top of the `head` rectangle to the rig origin). The thresholds come from `tolerances` in the contract.
Only the 13 body keypoints are scored. Missing keypoints give INCOMPLETE.

## Dependencies and limits

No runtime dependencies. PNG files are written and read with `node:zlib`, because only 8-bit RGB and RGBA control images are necessary. See [SECURITY.md](SECURITY.md).
Supported view: `three_quarter_right` with `near_far` side names. Other views stop with `E_VIEW_UNSUPPORTED`.
