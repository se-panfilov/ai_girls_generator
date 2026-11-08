# C1: geometry evaluation of the first experiment C images

**Draft report.** This report examines the first real generation of experiment C: one baseline image and one OpenPose-guided image, seed 1001, against the C0.5 candidate rig.
It does not decide experiment C. The pass criteria in [the roadmap](../ROADMAP.md) need 20 text descriptions and up to three attempts each. This report has one seed and one pair of images.
No new generation ran. No GPU, paid API, or model download was used. The generated images are not in Git (D15 is open). They are in the project files, see [Evidence](#evidence).

## Summary

| Question                                                          | Answer                                                                                                                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Did ControlNet improve the geometry against the baseline?      | **Yes, by a large amount.** Mean joint error 1.3 % of body height (pose) against 13.3 % (baseline). The baseline figure is 14 % too large and 13 % too high. The pose figure fits in place.     |
| 2. Where are the largest deviations?                              | Pose: **body orientation**, not joint position. The torso and the feet are frontal, and the head is near profile. Baseline: scale, vertical position, and arms (no arm separation).             |
| 3. Is there a problem in the C0.5 contract or the OpenPose image? | **Yes, one structural limit.** A 2D OpenPose skeleton of the C0.5 view is symmetric around the neck and the pelvis. It cannot encode torso yaw. See [P1](#p1-openpose-cannot-encode-torso-yaw). |
| 4. Is OpenPose sufficient to control the view?                    | **No** for torso and foot orientation. **Yes** for 2D joint positions, scale, and placement in this one sample.                                                                                 |
| 5. Add depth or lineart, change ControlNet settings, or prompt?   | Add a depth (or lineart) control from the mannequin, and remove `looking to the side` from the prompt. Change strength only after that. See [Recommendations](#recommendations).                |
| 6. What to test in the next minimal GPU experiment?               | OpenPose + depth against OpenPose only, with the prompt fix, three seeds. See [Next experiment](#proposed-next-minimal-experiment-c2).                                                          |
| 7. Go to experiment B (layer decomposition) now?                  | **Not yet.** Joint positions are good, but a frontal torso with a 3/4 head does not fit the 3/4 part rectangles. Fix the orientation first, or B measures the wrong problem.                    |

Status of each claim: **confirmed** means checked against files or hashes in this work. **Measured (agent marks)** means computed by `@aigg/control overlay` from marks that an AI agent placed by eye. **Visual judgment** means a description without a number.

## 1. Evidence and provenance

### Hash checks (confirmed)

All 11 files of the evidence archive agree with its `SHA256SUMS.txt`.

| Item                            | Value or result                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline-1001.png`             | `bfea13b7…130d`, 679716 bytes, 832 x 1216. Agrees with `result.json` and the `run.saved` event of `run.log`.                                                                     |
| `pose-1001.png`                 | `cbe36875…0cc9`, 857951 bytes, 832 x 1216. Agrees with `result.json` and `run.log`.                                                                                              |
| Checkpoint                      | `animagine-xl-4.0.safetensors`, `1d5b43ff…3916`, verified twice (download and before the run). Agrees with the registry.                                                         |
| ControlNet                      | `diffusion_pytorch_model_promax.safetensors`, `9fae2e50…7cdc`, verified twice. Agrees with the registry.                                                                         |
| Control image uploaded          | `openpose-anatomical.png`, `7a1809c8…f280` (`control.uploaded` event). Agrees with the evidence copy, the run plan, and the final bundle.                                        |
| `result.json` against `run.log` | Same bundle hash, prompt ids, seeds, files, and hashes. Start 13:37:57.9, finish 13:38:32.2. Baseline 16.0 s, pose 18.2 s from submission to save.                               |
| Executed workflows              | ComfyUI writes the executed prompt graph into each PNG (`tEXt` chunk `prompt`). Both graphs are equal, node by node, to `c0-baseline-1001.api.json` and `c0-pose-1001.api.json`. |
| Host                            | RTX A6000 48 GB, ComfyUI 0.35.0, PyTorch 2.10.0+cu128, Node.js 24.22.0 (from `result.json`, self-reported by the runner). The plan named A5000 or 3090. This is not a defect.    |

### The two `bundle.json` hashes (confirmed)

- The run reports `bundleSha256` `5ff3c71a…6951`. The evidence archive has a `bundle.json` with `7c438a3c…40a9`.
- The two files differ in **one line only**: the SHA-256 of `runner.mjs` (`5cce2774…2ee7` in the archived copy, `7e003cb0…3131` in the executed one). All other entries are equal, including the control image, both workflows, `run-plan.json`, `run.sh`, and `README.md`.
- `aigg-control bundle` on `master` (commit `bfe12f9`, the merge of PR #15) makes `bundle.json` `5ff3c71a…6951` and `runner.mjs` `7e003cb0…3131` byte for byte. The final archive `exp-c-bundle.tar.gz` (`3cd8afe8…447c`) has the same files.
- Conclusion: the archived `bundle.json` comes from an earlier build in PR #15, before the last runner fixes. The executed bundle is the final, merged build. The difference has no effect on the control image or the workflows.
- The runner checks the SHA-256 of each listed file against `bundle.json` before a run (`E_BUNDLE_INTEGRITY`). With the PNG `prompt` chunks, this confirms the executed workflows two ways.

### Control image against the C0.5 rig (confirmed)

- The C0.5 candidate contract `packages/control/test/fixtures/c05-candidate/rig.contract.json` has SHA-256 `17e73069…675e`, as in `bundle.json`.
- The bundle build from that contract reproduces the control image `7a1809c8…f280`. The overlay keypoints (`overlay.json`) and the control image have the same positions.

### Not confirmed

- That the runner on the Pod was the unchanged `runner.mjs`. The hashes in `result.json` and `run.log` are written by the runner itself. The PNG `prompt` chunks are independent of the runner and agree.
- Bit reproducibility of the images on another GPU. Not tested (no GPU).
- The GPU cost and the Pod lifetime. Not in the evidence.

## 2. Visual comparison

Materials are in the project files, `research/c1-geometry/` (see [Evidence](#evidence)). They are made by `@aigg/control` 0.4.0 `overlay --mapping anatomical`. No image is scaled, moved, or changed.

- `preview-control-baseline-pose.png`: the OpenPose control, the baseline with the rig overlay, and the pose-guided image with the rig overlay.
- `preview-aligned-diagnostic.png`: **diagnostic only**. The rig skeleton is moved and scaled by a least-squares fit to the marks, over the unchanged images. It shows the error that remains when position and size are ignored.
- In the overlays, the rig skeleton uses the OpenPose colors. Each mark is a cross: white inside tolerance, red outside tolerance, yellow for a low-confidence mark outside tolerance. A red line joins the mark to its rig joint.
- The archive also has the per-image `side-by-side.png` (control, image, overlay, proportion reference) and overlays without marks.

## 3. Measurements

### Method

- Marks format `aigg.pose-marks/0.1`: [baseline](c1/baseline-1001.marks.json), [pose](c1/pose-1001.marks.json). Results: [measurements.json](c1/measurements.json).
- Error = distance between the mark and the rig joint in contract pixels, divided by the rig body height (1240 contract px, from `head_top` to the rig origin; 982 px in the image). Tolerances from the contract: joint 2.5 %, mean 1.5 %, segment ratio 0.95 to 1.05.
- **The marks are a visual estimate by an AI agent** on 2x crops with a 20 px grid. The owner did not confirm them. No detector was used.
- Each mark has a confidence. `high`: the landmark is visible (eye, ear). `medium`: the joint is visible or its edge is clear (wrist at the cuff, bare knee). `low`: clothing hides the joint, and the position is estimated from the outline (shoulders and elbows in jackets, hips, ankles in boots).
  The agent's estimate of the mark uncertainty: about 4 px for high, 8 px for medium, 20 px (2 % of body height) for low.
- **Anchoring risk:** the agent saw the rig overlay before it marked the hidden joints. Low-confidence marks can be biased toward the rig, and this favors the pose image. For a reliable result, the owner marks the points blind, see [Owner marking](#owner-marking-instructions).
- The far eye and the far ear are `unmeasurable` in both images (hidden). The neck is the midpoint of the two shoulder marks, as the rig defines it.

### Joints (% of body height)

"Fit" is the diagnostic error after the best uniform scale and translation. It is not a pass value.

| Joint      | Baseline conf. | Baseline | Baseline fit | Pose conf. | Pose    | Pose fit |
| ---------- | -------------- | -------- | ------------ | ---------- | ------- | -------- |
| neck       | low            | 14.7     | 1.8          | low        | 0.6     | 0.7      |
| r_shoulder | low            | 15.1     | 1.6          | low        | 1.8     | 1.6      |
| r_elbow    | low            | 15.2     | 3.3          | low        | 1.6     | 1.3      |
| r_wrist    | medium         | 16.8     | 6.5          | medium     | 1.8     | 1.5      |
| l_shoulder | low            | 14.3     | 2.1          | low        | 1.4     | 1.6      |
| l_elbow    | low            | 16.4     | 2.1          | low        | 2.2     | 2.2      |
| l_wrist    | medium         | 20.6     | 8.5          | medium     | 1.2     | 1.1      |
| r_hip      | low            | 14.0     | 1.5          | low        | 1.4     | 1.4      |
| r_knee     | low            | 9.2      | 1.5          | medium     | 1.0     | 1.1      |
| r_ankle    | low            | 4.2      | 3.8          | low        | 0.6     | 0.5      |
| l_hip      | low            | 13.9     | 1.1          | low        | 1.5     | 1.6      |
| l_knee     | low            | 10.0     | 2.7          | medium     | 1.0     | 1.2      |
| l_ankle    | low            | 8.4      | 3.8          | low        | 0.5     | 0.2      |
| **Mean**   |                | **13.3** | 3.1          |            | **1.3** | 1.2      |
| **Max**    |                | **20.6** | 8.5          |            | **2.2** | 2.2      |

`r_` is the near side (image left) and `l_` is the far side, as in the anatomical mapping of the bundle.

- Pose: 13 of 13 joints are at 2.5 % or less, mean 1.3 % (limit 1.5 %). With high and medium marks only (wrists, knees): 4 of 4, max 1.8 %.
  The margin is small: a low-confidence mark has an uncertainty of about 2 %. So "all joints inside tolerance" is **probable but not proven** for the hidden joints.
- Baseline: 0 of 13 joints inside tolerance. Most of the error is position and scale. After the fit, the arms remain wrong (wrists 6.5 % and 8.5 %), because the baseline arms hang against the body and the rig arms are away from the body.

### Segment length ratios (marked / rig)

"Scale-free" divides by the fitted figure scale (baseline 1.115, pose 1.009).

| Segment               | Baseline | Baseline scale-free | Pose | Pose scale-free |
| --------------------- | -------- | ------------------- | ---- | --------------- |
| r_shoulder to r_elbow | 0.95     | 0.85                | 0.99 | 0.98            |
| r_elbow to r_wrist    | 0.90     | 0.81                | 1.06 | 1.05            |
| l_shoulder to l_elbow | 0.88     | 0.79                | 0.99 | 0.98            |
| l_elbow to l_wrist    | 0.77     | 0.69                | 1.02 | 1.01            |
| r_hip to r_knee       | 1.21     | 1.09                | 1.02 | 1.02            |
| r_knee to r_ankle     | 1.21     | 1.08                | 1.06 | 1.05            |
| l_hip to l_knee       | 1.22     | 1.09                | 1.02 | 1.01            |
| l_knee to l_ankle     | 1.12     | 1.01                | 1.06 | 1.05            |

- Pose: 5 of 8 inside 0.95 to 1.05. The three outside (1.06) all use a low-confidence elbow or ankle mark, inside the mark uncertainty. The tool status is FAIL only because of these three ratios.
- Baseline: arms short and legs long relative to the rig, also after scale. The baseline body has longer legs than the 7-head C0.5 mannequin.

### Head, neck, and face

| Item                             | Baseline        | Pose                                |
| -------------------------------- | --------------- | ----------------------------------- |
| Near eye error (high)            | 15.1 %          | **0.1 %**                           |
| Near ear error (high)            | 13.5 %          | **0.4 %**                           |
| Nose error                       | 15.7 % (medium) | 1.1 % (low)                         |
| Far eye                          | hidden          | hidden (the rig shows it)           |
| Head turn (visual judgment)      | near profile    | near profile, more than the rig 40° |
| Neck (midpoint of the shoulders) | 14.7 %          | 0.6 %                               |

In the pose image, the ear-to-eye distance is 76 contract px and the eye-to-nose distance is about 43 px. In the rig they are 70 px and 56 px. A shorter eye-to-nose distance and a hidden far eye agree with a head turn larger than 40°.

### Orientation and near/far consistency (visual judgment)

| Item                     | Rig (C0.5)                  | Baseline                                                     | Pose                                                                     |
| ------------------------ | --------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Face direction           | 3/4 to image right, yaw 40° | To image right, near profile                                 | To image right, near profile                                             |
| Torso                    | 3/4 to image right          | Approximately 3/4 to image right (jacket opening off center) | **Frontal**: symmetric jacket, zipper and shoulders centered on the neck |
| Feet                     | 3/4, toes to image right    | Toes to image right, near foot forward                       | **Frontal**, toes to the viewer                                          |
| Near side on image left  | Yes                         | Yes                                                          | Yes, but a frontal body has no near and far side                         |
| Arms away from the torso | Yes                         | No, hands against the thighs                                 | Yes                                                                      |

The baseline has the better body orientation. The pose image has the better joint positions. Neither has both.

### Composition, scale, and offset (measured, agent marks)

| Item                                         | Baseline       | Pose          |
| -------------------------------------------- | -------------- | ------------- |
| Marked height (head top with hair to ground) | 1120 px        | 1042 px       |
| Rig height (`head_top` to origin)            | 982 px         | 982 px        |
| Height ratio                                 | 1.14           | 1.06          |
| Head top offset (y, % of height)             | −14.9 (higher) | −4.1 (higher) |
| Ground offset (y, % of height)               | −0.8           | +2.1 (lower)  |
| Fitted figure scale (joints)                 | 1.115          | 1.009         |
| Fitted figure offset (x, y), image px        | −25, −126      | −2, +1        |

The pose height ratio 1.06 comes from hair volume above the skull and the boot soles. The joints fit at scale 1.01. Hair above `head_top` is normal and is not a joint error.

## 4. Experiment C criteria

- Roadmap hypothesis: joint error 2.5 % of body height or less in 70 % of results, over 20 descriptions, three attempts or fewer.
- This sample: the pose image has no joint over 2.5 % with agent marks. The baseline has 13 of 13 joints over 2.5 %.
- **This does not pass or fail experiment C.** It is one description, one seed, one image per condition. It is also a single unconfirmed marker.
- The roadmap metrics zone IoU, design similarity, and human approval share were not measured. Zone IoU needs a segmentation, which is out of scope here.
- Joint error alone does not see the orientation defect in [P1](#p1-openpose-cannot-encode-torso-yaw). A frontal body with the correct 2D joints passes the joint threshold. Experiment C needs an orientation check in addition, for example a human yes/no on "torso and feet are 3/4".

## 5. Problems

### P1: OpenPose cannot encode torso yaw

Confirmed from the contract numbers. In the C0.5 candidate, the near and far shoulders are 115.5 contract px from the neck on each side, and the near and far hips are 61 px from the pelvis center on each side.
The C0.5 mannequin is an orthographic projection, and the OpenPose neck is the midpoint of the shoulders by definition. So the 2D skeleton of a body turned 40° is the same as the skeleton of a frontal body with narrower shoulders and hips.
OpenPose has no depth and no surface, so the model chose the frontal reading. Only the face keypoints show a turn, and the model turned the head only. This is a limit of the control type, not a defect of the C0.5 geometry.

### P2: the face keypoints read as near profile

Visual judgment with a contract number. In the control image, the far eye is 7 contract px (about 6 image px) from the nose, and the far ear is hidden. In the image, the far eye is hidden and the head turns more than 40°.
The prompt tag `looking to the side` probably adds to this, because the baseline (no control) also has a near-profile head. One sample cannot separate the two causes.

### P3: the baseline does not follow the frame

Measured. Without control, the figure is 14 % larger and 13 % higher than the rig, and the arms touch the body. This was expected. It confirms that prompt-only generation does not give rig geometry.

### P4: hidden joints limit the measurement

Measured. 9 of 13 joints in the pose image and 11 of 13 in the baseline are low confidence, because a puffer jacket, loose shorts, rolled trousers, and boots hide them.
The prompt asks for `fitted jacket, shorts, boots`. A test outfit with visible joints (fitted top, short sleeves or fitted sleeves, bare knees, low shoes) makes the measurement more reliable. This is a test-prompt change, not a content-rule change.

### P5: the measurement tool lacked confidence and diagnostics

Fixed in this change. `@aigg/control` 0.4.0 adds per-point confidence and notes, `unmeasurable` keypoints, the head-top and ground extent, a diagnostic scale-and-translation fit, scale-free segment ratios, face errors, and `aligned-diagnostic.png`.
The marks format id stays `aigg.pose-marks/0.1`. All new fields are optional, and old marks files give the same status as before when no scored keypoint is `unmeasurable`.

## Recommendations

Ranked by expected value against cost and complexity. All are proposals for the owner.

| Rank | Recommendation                                                                                                                                         | Value                                                                                             | Cost                                         | Complexity |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------- |
| 1    | Owner confirms or corrects the marks of the pose image (blind, see below)                                                                              | Turns "probable" into a confirmed measurement                                                     | 15 min, no GPU                               | Low        |
| 2    | Remove `looking to the side` from the prompt; add `body turned to the right` or a similar tag. Test outfit with visible joints                         | Attacks P2 and P4 directly                                                                        | No new tool                                  | Low        |
| 3    | Add a depth control image, rendered by script from the C0.5 reference body (`referenceBody`), to the OpenPose control (union ControlNet, two controls) | Only listed option that gives torso and foot yaw (P1). The roadmap hypothesis already names depth | One new TS render command, no new model file | Medium     |
| 4    | Add an orientation check to the experiment C score: human yes/no for torso 3/4 and feet 3/4                                                            | Joint error cannot see P1                                                                         | No GPU                                       | Low        |
| 5    | Lineart or canny control of the mannequin outline instead of depth                                                                                     | Also gives yaw cues, but also draws the mannequin shape, which can fight the clothing             | Same as 3                                    | Medium     |
| 6    | Change ControlNet strength or end percent                                                                                                              | Not needed for joint positions now. Lower strength can lose them. Test only after 3               | GPU time                                     | Low        |

The union ProMax file is already approved for experiment C, and the union model has depth and lineart modes. The owner decides if depth use is inside the approved scope. No new model file is needed. A separate depth estimator model is **not** needed, because the depth comes from the script mannequin.

## Proposed next minimal experiment (C2)

Not started. It needs the owner's approval, the same Pod procedure, and a new bundle.

- Conditions, same prompt with recommendation 2, same seeds:
  - A: OpenPose only (as now, prompt fixed).
  - B: OpenPose + depth from the mannequin.
- Seeds: 1001, 1002, 1003. Total 6 images (no new baseline, the baseline answer is clear).
- Before the run, offline: a `depth` render in `@aigg/control` from the C0.5 reference body, with tests and a review; the bundle with two conditions; the owner's confirmed marks from C1.
- GPU estimate: about 20 s for each image on an A6000, so 2 to 3 min of generation. With Pod start, model download (about 2 min, as in C1), and checks, 30 to 45 min of Pod time. At the A5000 rate in the project notes ($0.27/h) this is under $0.50; on an A6000, about $0.50 to $1. Storage is small. This is an estimate, not a quote.
- Success criteria for C2 (proposal):
  - Orientation: in 3 of 3 images of condition B, the owner judges torso and feet as 3/4 to image right.
  - Joints: in condition B, each joint with high or medium confidence is at 2.5 % or less, and the mean is 1.5 % or less, in 2 of 3 images.
  - No regression: condition B joint error is not worse than condition A by more than 0.5 % mean.
  - If B fails orientation in 2 or more images, try lineart (recommendation 5) before experiment B.

## Owner marking instructions

The agent marks are not a confirmed measurement. To confirm them, mark the pose image without the overlay.

1. Open `pose-1001.png` in an image editor that shows pixel coordinates (for example, Preview with the inspector, Photoshop, GIMP, or Krita). Do not open the overlay first.
2. Note the x and y pixel position (origin top left) of these points. Use the anatomical joint center, not the clothing edge:
   - near eye (iris center), near ear (center of the ear shell), nose tip;
   - near shoulder and far shoulder (the top of the arm bone, under the jacket);
   - near and far elbow, near and far wrist (where the hand starts);
   - near and far hip (hip joint, about one third of the way in from the side of the pelvis, at the crotch level or a little above);
   - near and far knee (center of the kneecap), near and far ankle (the ankle bone, inside the boot);
   - head top (top of the hair) and ground (bottom of the soles).
     "Near" is the side on the image left.
3. For each point, write `high`, `medium`, or `low` confidence. If a point cannot be placed, write "unmeasurable" and a reason.
4. Send the list. The agent puts it in the marks format and runs `overlay` again. Or edit [the marks file](c1/pose-1001.marks.json) directly: change `markedBy` and `origin`, and the `x`, `y`, `confidence` of each point.

## Reproduction

```sh
npm ci --ignore-scripts
npm run build --workspace @aigg/control
node packages/control/dist/src/cli.js overlay --contract packages/control/test/fixtures/c05-candidate/rig.contract.json \
  --mapping anatomical --image <path>/pose-1001.png --marks docs/proposals/c1/pose-1001.marks.json --out /tmp/c1/pose-1001
```

Do the same for `baseline-1001.png` with `baseline-1001.marks.json`. The marks files contain the image SHA-256, so the tool refuses a different image. Exit status 1 (FAIL) is expected for both images.

## Evidence

Not in Git (D15). In the project files, `research/c1-geometry/`:

- `c1-geometry-evidence.tar.gz`: the authoritative copy. It has `SHA256SUMS`, both overlays with and without marks, `side-by-side.png`, `aligned-diagnostic.png`, `overlay.json`, and the two comparison sheets. The hash of the archive is in `SHA256SUMS`.
- `preview-control-baseline-pose.png` and `preview-aligned-diagnostic.png`: preview copies. The project-files storage changes the bytes of PNG files that are not in an archive, so use the archive for hashes.
- The input evidence (`experiment-c-first-run-evidence.zip`) is the owner's upload in this task.

## Limits

- One seed, one description, one image per condition. No statistic is possible.
- One marker, an AI agent, with the anchoring risk above. No inter-marker check.
- The face keypoints and the head turn are compared with the C0.5 face template, which is itself an assumption.
- Orientation is a visual judgment. No metric for torso yaw exists yet.
- The rig contract, the master rig, and the C0.5 candidate are not changed.
