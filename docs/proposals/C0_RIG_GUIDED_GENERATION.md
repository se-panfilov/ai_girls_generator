# Experiment C0: first rig-guided AI character

**Draft report.** C0 is a narrow feasibility pilot for [experiment C](../ROADMAP.md#c-rig-guided-generation). It is not the generation stage of the factory.
**No AI image was generated.** The inference part is **BLOCKED**: the agent environment has no GPU and no ComfyUI server, and no model in [the model license registry](../MODEL_LICENSES.md) is Approved.
This report contains no generated artwork and no measurement of generated artwork. The only images are control images, references, and a synthetic tool check.

## Result summary

| Id    | Experiment                                                        | Status      | Evidence                                                                                                        |
| ----- | ----------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| C0-1  | Inventory of rig data, code, and environment                      | **PASS**    | [Phase 1](#phase-1-actual-capabilities)                                                                         |
| C0-2  | Model and ControlNet compatibility (paper check)                  | **PASS**    | [Models](#models-and-compatibility). Compatible on paper. Not run.                                              |
| C0-3  | Model approval for use                                            | **BLOCKED** | All candidates have the status Candidate. Approval is an owner decision (D9).                                   |
| C0-4  | Deterministic control images from the rig contract                | **PASS**    | `@aigg/control` `pose`, unit tests, equal bytes in two runs                                                     |
| C0-5  | OpenPose conditioning format                                      | **PASS**    | Static and pixel checks against the reference drawing rules. Not checked with a real ControlNet.                |
| C0-6  | View consistency of the test rig                                  | **FAIL**    | [Finding F1](#f1-the-near-side-of-the-test-rig-is-on-the-wrong-side-for-the-view): near side on the image right |
| C0-7  | Text-only baseline generation                                     | **BLOCKED** | No GPU, no ComfyUI endpoint, no approved model. Workflow ready.                                                 |
| C0-8  | Pose-guided generations (at most three)                           | **BLOCKED** | Same as C0-7. Workflows ready.                                                                                  |
| C0-9  | Evaluation of generated images against the rig                    | **BLOCKED** | No generated images.                                                                                            |
| C0-10 | Evaluation tools (overlay, side-by-side, manual-mark measurement) | **PASS**    | Unit tests with synthetic images and marks, and a smoke run on the synthetic L1 character B (not AI art)        |
| C0-11 | Concept-to-production transfer                                    | **BLOCKED** | Not attempted. It needs C0-7 and C0-8 first.                                                                    |

Is pose-guided generation promising? **Not measured.** C0 has no generated image, so it cannot answer this question. The preparation is ready, and finding F1 must be resolved first, because the current test rig sends a contradictory pose signal.

## Phase 1: actual capabilities

### Rig, mannequin, and pose data

| Item                                    | State                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rig contract                            | Test rig `humanoid_girl_v1` 0.2.0 in `packages/rig-runtime/test/fixtures/l1-owner/rig.contract.json` (SHA-256 `e9951ec0…d822d0`). Placeholder geometry. |
| Spine skeleton                          | Owner L1 export of the same test rig.                                                                                                                   |
| Bones with joints                       | 28 bones. Body joints exist for shoulders, elbows, wrists, hips, knees, ankles, neck, and head.                                                         |
| Face points (nose, eyes, ears)          | **Not in the contract.**                                                                                                                                |
| Mannequin (silhouette, depth, line art) | **Does not exist.** The synthetic L1 characters A, B and C are colored rectangles in the attachment rectangles. They are not a body shape.              |
| Pose-control data                       | **Did not exist** before C0. C0 adds the `pose` command.                                                                                                |
| Image generation code (S2, S4)          | **Not implemented** before C0. Only documented in [the architecture](../ARCHITECTURE.md). C0 adds workflow files, but no client and no run.             |

Suitability for conditioning: the joints are sufficient for an OpenPose body image. They are not sufficient for depth, line-art, or zone-mask control, because these need a body shape. A shape made from the attachment rectangles would be invented data, so C0 does not make one.

### Environment of the agent

| Item                   | Observed                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| Machine                | Linux container, 4 CPU cores, 15 GB RAM                                                                     |
| GPU                    | None (`nvidia-smi` not found, no `/dev/nvidia*`, no `/dev/dri`)                                             |
| ML runtime             | No PyTorch, no ComfyUI                                                                                      |
| ComfyUI endpoint       | None was given. The agent does not look for one.                                                            |
| Hugging Face downloads | The container proxy refuses `huggingface.co` (HTTP 403). Model cards were read with a web page reader only. |
| Cost incurred          | 0. No paid API, no GPU rental, no model download.                                                           |

## Models and compatibility

Data read from the Hugging Face model pages on 2026-11-05. Model cards are data. They do not approve a model.

| Item                                                 | Value                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `cagliostrolab/animagine-xl-4.0` repository commit   | `2b7c1b397761bf5bd3cc42e5b39ec99314a75a96`                                                                                     |
| `animagine-xl-4.0.safetensors`                       | 6.94 GB, SHA-256 `1d5b43ff75b6ab598502d4c779d2fbfa3dceca51c60c3b609640a60772333916`                                            |
| `animagine-xl-4.0-opt.safetensors`                   | 6.94 GB, SHA-256 `6327eca98bfb6538dd7a4edce22484a1bbc57a8cff6b11d075d40da1afb847ac`                                            |
| Animagine license                                    | CreativeML Open RAIL++-M (the card says "without any modifications or additional restrictions"). Use-based restrictions apply. |
| Animagine base                                       | Stable Diffusion XL 1.0                                                                                                        |
| Animagine card settings                              | CFG 5 (4–7), 28 steps, Euler Ancestral, 832 x 1216 among the portrait resolutions                                              |
| `xinsir/controlnet-union-sdxl-1.0` repository commit | `801a4a3fa3d4c936f4feea95b98607bc6726f80c`                                                                                     |
| `diffusion_pytorch_model_promax.safetensors`         | 2.51 GB, SHA-256 `9fae2e50cb431bfcbe05822b59ec2228df545ef27f711dea8949e9f4ed9f7cdc`                                            |
| `diffusion_pytorch_model.safetensors`                | 2.51 GB, SHA-256 `a9e13fd61f3193887791c8a0dd07a07202174dc47d5ddaea94ea1344f07c7467`                                            |
| Union ControlNet license                             | Apache-2.0                                                                                                                     |
| Union control types (card)                           | Openpose, Depth, Canny, Lineart, AnimeLineart, Mlsd, Scribble, Hed, Pidi, Teed, Segment, Normal                                |
| Pose drawing (xinsir openpose SDXL card)             | Thicker lines than the default drawing: half-width and joint radius `4 * ratio`, ratio from the longer side                    |

Compatibility (paper check, not run): both models are SDXL 1.0 family, so the union ControlNet fits the Animagine checkpoint. Both are `safetensors`. ComfyUI selects the union mode with the core node `SetUnionControlNetType` (type `openpose`).
The union card gives no conditioning scale and no ComfyUI notes. C0 uses strength 1.0 from the example of the xinsir openpose SDXL card. This is a starting value, not a measured optimum.
The registry has no Approved model. The file hashes above are not added to the registry, because an entry and its status are an owner decision.

## Phase 2: control inputs

New package [`@aigg/control`](../../packages/control/README.md) (Node.js, TypeScript, no runtime dependencies). Command `pose` reads the contract and writes:

| File                      | Content                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `openpose-detector.png`   | OpenPose BODY_18 control image (black background, standard colors, xinsir line width)                         |
| `openpose-anatomical.png` | The same joints with the other side mapping (for comparison, see F1)                                          |
| `openpose-*.json`         | OpenPose JSON 1.3 keypoints in target pixels                                                                  |
| `reference.png`, `.svg`   | Proportion reference: attachment rectangles, bones, joints, grid of eighths of the body height, labels in SVG |
| `control.json`            | Contract hash, target size, transform, each keypoint with its source, warnings, and the SHA-256 of each file  |

Coordinate system: the contract canvas (1024 x 1536, Y down) is scaled uniformly and centered in the target. The view, the joint positions, and the proportions do not change. For 832 x 1216 the scale is 0.7917 and the side offset is 10.667 px.

Conditioning format checks:

1. Keypoint order, limb list (17 drawn limbs), and colors follow `draw_bodypose` of controlnet_aux. A unit test reads the pixel at each keypoint and finds the keypoint color.
2. Line width follows the xinsir drawing rule (ratio 3 for 832 x 1216: half-width 12 px, joint radius 12 px).
3. The image is 8-bit RGB with an opaque black background. The size is a multiple of 64.
4. Body keypoints come from contract bones. The neck is the midpoint of the shoulders, as pose detectors define it. Each keypoint records its source in `control.json`.
5. **Assumption:** the face keypoints come from fixed fractions of the `head` rectangle (`face-template-0`), turned to the image right. The far ear is hidden. The contract has no face data.
6. Not checked: the output of a real ControlNet on this image. That needs C0-8.

Determinism: two runs give the same bytes. The SHA-256 values for the L1 test rig at 832 x 1216:

| File                      | SHA-256 (file)                                                     | SHA-256 (pixels)                                                   |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `openpose-detector.png`   | `1f161bd5b6fd59792d99692ada513de6068f8599ac329b56b2c49d745a4ddb49` | `37826611cd4ac212c8415b6cc52ce5739f319c3d5ff4d1e1a11f78830919d921` |
| `openpose-anatomical.png` | `01f160489bb13447133a9ed378ba1c1837d96274653e80daee1b7c22a0f075c4` | `391177b552779ef01498326770608e153c886a4aa6da633c7319968b21f740a3` |
| `reference.png`           | `ccd1039ae1af1f42f305db8da125a96d8e84e06588e96a8e150e007cf5755413` | `5c817b94a707ec01a8dfc456ada995f24977aa2715c9ae96f4e9d2c656c9e9f7` |

The file hash depends on the zlib version. The pixel hash does not.

## Phase 3: generation

**BLOCKED.** No inference ran. No image in the evidence is AI output.

Command `workflow` writes ComfyUI API workflows and a run plan that the owner can run on an authorized GPU host:

| Run             | Workflow                    | Seed | Control                      |
| --------------- | --------------------------- | ---- | ---------------------------- |
| `baseline-1001` | `c0-baseline-1001.api.json` | 1001 | none                         |
| `pose-1001`     | `c0-pose-1001.api.json`     | 1001 | `openpose-detector.png`, 1.0 |
| `pose-1002`     | `c0-pose-1002.api.json`     | 1002 | `openpose-detector.png`, 1.0 |
| `pose-1003`     | `c0-pose-1003.api.json`     | 1003 | `openpose-detector.png`, 1.0 |

Settings: 832 x 1216, 28 steps, CFG 5, `euler_ancestral`, scheduler `normal`, denoise 1.0, ControlNet start 0 and end 1.0.
The baseline and `pose-1001` use the same seed, so the pose control is the only difference.

Prompt (fixed, in `packages/control/src/workflow.ts`):

```text
1girl, original, safe, adult woman, mature female, solo, full body, standing, three-quarter view, facing right, looking to the side, arms at sides, empty hands, visible hands, visible feet, short hair, black hair, fitted jacket, shorts, boots, plain white background, simple background, masterpiece, high score, great score, absurdres
```

Negative prompt:

```text
lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, cropped, worst quality, low quality, low score, bad score, average score, signature, watermark, username, blurry, nsfw, explicit, nude, child, loli, aged down, multiple views, from behind, out of frame, cropped feet
```

The character is explicitly adult and the rating tag is `safe`. The weapon of the rig is left out, so that the first test checks only the body.
The ComfyUI node names and inputs come from ComfyUI core nodes. They were not run against a server. Check them on the first run.

To record on the run: the SHA-256 of each model file (compare with `run-plan.json`), the ComfyUI commit, Python, PyTorch, GPU and driver, each output file name and SHA-256, the duration, and the cost.

## Phase 4: evaluation

**BLOCKED** for generated images. The tools are ready:

- `overlay` draws the rig skeleton and the attachment rectangles over an image and writes a side-by-side sheet: OpenPose control, input image, overlay, proportion reference.
- `overlay --marks` measures joint error and segment length ratios from keypoints that a person marked. The tool does not detect keypoints, so a measurement always comes from real marks. Without marks, the report says `NOT MEASURED`.
- A visually good image can still fail the rig. The overlay and the measurement test the rig fit only. Visual quality needs a separate human score.

Smoke run (tool check only): the synthetic L1 character B (colored rectangles, not AI art) scaled to 832 x 1216. The overlay matches the rectangles. This proves the coordinate transform of the tool, not a generation result.

## Findings

### F1: the near side of the test rig is on the wrong side for the view

The contract says `view: three_quarter_right` and `sideNaming: near_far`. In a three-quarter view that faces right, the near side is the subject's right side, and it is on the left of the image.
In the test rig, the near shoulder (x 580) and the near hip (x 550) are on the right of the far shoulder (x 445) and the far hip (x 480), and the near limbs are drawn in front.
This layout reads as a body that faces left, or as a back view. The `pose` command reports `W_RIG_SIDE_LAYOUT_VIEW_MISMATCH`.

Effect on generation:

- With the `anatomical` mapping (near = subject's right), the right shoulder keypoint is on the image right while the face looks right. OpenPose models can read this as a back view (`W_POSE_BACK_VIEW_SIGNAL`).
- With the `detector` mapping, the pose image is consistent (a front three-quarter body), but the model will draw the subject's left arm on the image right. In a right-facing view this arm is the far arm and is partly behind the torso. The contract calls it near and draws it in front. Decomposition into the near and far slots would then have the wrong occlusion.

The rig contract states that its example geometry is a placeholder. Changing the geometry or the view is a contract change and an owner decision (D17, D3). C0 does not change it.
Recommendation: correct the side layout in the mannequin before C0-7 and C0-8, or run the C0 plan only as a check of the pose signal.

### F2: the contract generation resolution is not an SDXL bucket

`space.generationResolution` is 832 x 1248. 1248 is not a multiple of 64. The Animagine card lists 832 x 1216. C0 uses 832 x 1216 with uniform scale and side padding. The contract is not changed. Owner decision: keep 832 x 1248 or change the contract value.

### F3: the rig has no shape data

There is no mannequin: no silhouette, no depth, no line art, no face points, no foot direction (BODY_18 has no foot keypoints), and no hand pose. Only pose control is possible now. Shape control and the zone IoU metric of experiment C need a real mannequin (phase 2 of [the roadmap](../ROADMAP.md)).

### F4: proportions of the test rig

Measured from the contract (body height 1240 px from the top of the `head` rectangle to the rig origin):

| Measurement             | px            | % of body height |
| ----------------------- | ------------- | ---------------- |
| Shoulder to shoulder    | 135.1         | 10.9             |
| Hip joint to hip joint  | 70.2          | 5.7              |
| Upper arm (near / far)  | 171.2 / 166.9 | 13.8 / 13.5      |
| Forearm (near / far)    | 150.3 / 145.3 | 12.1 / 11.7      |
| Thigh, shin (each side) | about 260     | 21.0             |

The shoulder line is narrow for an adult figure, also with three-quarter foreshortening. This is a visual estimate, not a measurement against a reference body. A narrow shoulder line can push a model toward a younger-looking body, which the content rules forbid. Check it on the mannequin.
The arms hang straight down near the torso. Decomposition (experiment B) is simpler when the arms and legs do not touch the torso.

## Before experiment B

1. Owner: decide the model files (registry status, D9), the GPU host or cost limit (D19), and the ComfyUI endpoint.
2. Owner: correct the side layout of the mannequin for the view (F1), decide the generation resolution (F2), and consider limb separation from the torso in the reference pose.
3. Make a real mannequin with shape data (F3). Then add depth or line-art control.
4. Run the C0 plan (one baseline and three pose runs), record the provenance, and make the overlays.
5. A person marks the 13 body keypoints on each image. Run `overlay --marks`. Score visual quality separately.
6. Start experiment B only with an image that passes the joint tolerances and the human review.

## Evidence

Outside the repository (no binary assets before decision D15): `research/c0/` in the project files, with `c0-evidence.tar.gz` (control images, workflows, run plan, reports, synthetic overlay) and `SHA256SUMS`.
Reproduce the control images with the commands in [the package README](../../packages/control/README.md).
