# C2: failure analysis

**Draft report.** This report analyzes the six images of experiment C2 (OpenPose only against OpenPose + depth, seeds 1001 to 1003), see [the C2 preparation](C2_PREPARATION.md).
It is an offline analysis. No new generation ran. No GPU, paid API, or model download was used. The images are not in Git (D15 is open), see [Evidence](#evidence).

Status of each claim: **verified** means checked against files, hashes, or source code in this work. **Observed** means the visual judgment of one assessor (an AI agent), not blind to the condition. **Hypothesis** means a possible cause that no control experiment has tested. No hypothesis in this report is proven.

## Summary

- The run is technically correct and reproducible. All six images agree with `SHA256SUMS`, `result.json`, and `run.log`. The graph in each PNG is the bundle workflow.
- **The orientation gate fails in 6 of 6 images.** The torso is frontal in every image. Only condition B rotated one foot (seeds 1001 and 1002). By the C2 stop criteria (B passes in 0 of 3), C2 does not support the depth control in its current form.
- **Detached hands: condition A 3 of 3, condition B 1 of 3** (by file identity, see [the label difference](#label-difference)). No extra limb is attached to the body.
- ComfyUI 0.35.0 does not use the trained multi-condition fusion of xinsir ControlNet Union ProMax. Each `SetUnionControlNetType` + `ControlNetApplyAdvanced` pair is a separate single-condition pass, and ComfyUI adds the results. The trained fusion is not available through the core nodes.
- Our OpenPose image follows the drawing that xinsir recommends.
- Most probable causes (hypotheses): the 2D OpenPose skeleton at full strength holds a frontal body; a weak torso yaw signal in our depth image, applied outside the trained fusion; and the word `pointing` in the C2 prompt for the detached hands.
- **Recommendation: direction B (template-driven generation), first step offline.** Do not do the native fusion test (direction A) now.

## 1. Provenance (verified)

| Item                               | Result                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Six PNG files against `SHA256SUMS` | All six OK. The hashes also agree with `result.json`, `state.json`, and the `run.saved` events in `run.log`.                                                         |
| Bundle                             | `bundleSha256` `f014ed6c…3796` in `result.json`, `state.json`, and `run.log` is the `bundle.json` of the final C2 bundle (archive `c21e2dd9…92e7`, PR #17).          |
| Models                             | Both approved files, hashes verified after download and before the run (`model.hash` events). Pinned revisions from the manifest.                                    |
| Control images                     | Uploaded `openpose-anatomical.png` `7a1809c8…f280` and `depth-c05.png` `a7381103…d711d`, the bundle files.                                                           |
| Embedded graphs                    | Each PNG has one `tEXt` chunk `prompt`. Its nodes (class and inputs) are equal to the bundle workflow of the same run. A files have 11 nodes, B files have 14 nodes. |
| Cross check                        | The graph in `a-openpose-1001.png` is not equal to `c2-b-1001.api.json`. So the comparison detects a wrong file.                                                     |
| Host                               | ComfyUI 0.35.0, PyTorch 2.10.0+cu128, NVIDIA A40 48 GB (not the A5000 of the plan; this does not change the graph). Each run once, no retry.                         |
| Time per image                     | A 10 s, B 12 s (after the first model load). This agrees with one extra ControlNet pass in the first half of the B steps.                                            |

### Label difference

The task text gives detached hands in "A: 2 of 3, B: 3 of 3". By file identity, it is the opposite: A has detached hands in 3 of 3 and B in 1 of 3.
File identity is verified three ways: the file name in `result.json` with its SHA-256, the node count of the embedded graph (B = 14), and the equality with the workflow of the same run id.
Possible reasons: the four semi-transparent hands in `a-openpose-1001.png` are easy to miss, or the files were viewed in another order. Please check this against the files.

## 2. A/B comparison and orientation gate (observed)

The gate is from [the C2 preparation](C2_PREPARATION.md#orientation-gate-first). An image passes only if O1 to O4 pass. The assessor knew the condition of each image, so this is not the blind judgment that the plan asked for.

| Seed | Run | O1 torso 20° to 60° right | O2 feet point right                                  | O3 head with torso                        | O4 near/far overlaps | Gate | Detached hands                                                   | Other observations                      |
| ---- | --- | ------------------------- | ---------------------------------------------------- | ----------------------------------------- | -------------------- | ---- | ---------------------------------------------------------------- | --------------------------------------- |
| 1001 | A   | Fail, frontal             | Fail, both to the camera                             | Head tilted and turned right, eyes closed | Fail, no overlap     | Fail | 4, semi-transparent, near the head                               | Hair over one eye                       |
| 1001 | B   | Fail, frontal             | Partial: far foot about 30° right, near foot frontal | Head slightly right, eyes closed          | Fail                 | Fail | 0                                                                | Strong color gradient in the background |
| 1002 | A   | Fail, frontal             | Fail                                                 | Head tilted right, eyes closed            | Fail                 | Fail | 2, pointing at the head, forearms from the frame edge            | Shorts with piping                      |
| 1002 | B   | Fail, frontal             | Partial: far foot slightly right                     | Head almost frontal, eyes look right      | Fail                 | Fail | 2, pointing at the head, same places as A                        | Blue shirt tint                         |
| 1003 | A   | Fail, frontal             | Fail                                                 | Head turned right, about 3/4              | Fail                 | Fail | 5 (2 or more pointing, others open), one arm from the frame edge | Small logo on the shirt                 |
| 1003 | B   | Fail, frontal             | Fail                                                 | Head turned right, about 3/4              | Fail                 | Fail | 0                                                                | Cleanest image                          |

Gate result: **A 0 of 3, B 0 of 3.** The joint measurement was not done, because no image passed the gate (the plan measures joints after the gate).

What the overlays show (observed, see `c2-sheet.png` in the evidence): in all six images, the shoulders, elbows, wrists, hips, knees, and ankles are close to the OpenPose joints. The B figures stay inside the depth silhouette.
So the controls hold the 2D joint positions. They do not give the 3D turn. The model drew a frontal body that agrees with the same 2D joints.

What depth changed (observed): different backgrounds and lighting, the far foot partly turned in two seeds, and fewer detached hands. It did not turn the torso, and it did not make the far arm look farther away.

## 3. Anatomical artifacts (observed)

| Class                                       | A (3 images)                               | B (3 images)           |
| ------------------------------------------- | ------------------------------------------ | ---------------------- |
| Detached hands (not connected to the body)  | 3 of 3 images, 11 hands (4 + 2 + 5)        | 1 of 3 images, 2 hands |
| Of these: pointing hands (index finger out) | 2 of 3 images (1002, 1003)                 | 1 of 3 images (1002)   |
| Of these: semi-transparent hands            | 1 of 3 images (1001)                       | 0                      |
| Extra limbs attached to the body            | 0                                          | 0                      |
| Body hands: wrong count or fused fingers    | Not found at this size; fingers are curled | Not found at this size |
| Other: eyes closed                          | 2 of 3 (1001, 1002)                        | 1 of 3 (1001)          |
| Other: frontal torso with a turned head     | 3 of 3                                     | 3 of 3                 |

The detached hands are outside the body, at head height or at the sides, many with a forearm that comes from the frame edge. They are not a wrong drawing of the body hands. Each figure has exactly two arms and two hands.
For seed 1002, A and B have the pointing hands at the same places. The seed and the first steps make the same layout, and depth (active in steps 0 to 14) did not remove them.

## 4. OpenPose input format (verified)

The xinsir ControlNetPlus README (section Inference Scripts) tells users to replace `draw_bodypose` in controlnet_aux with its own version. Our `renderOpenPose` (`packages/control/src/pose.ts`) agrees with it:

| Item                 | xinsir `draw_bodypose`                            | Our image (832 x 1216)                     |
| -------------------- | ------------------------------------------------- | ------------------------------------------ |
| Line ratio           | From max(W, H): 3 for 1000 to 1999                | 3 (`control.json` `lineRatio`)             |
| Limb                 | Ellipse, half-width `4 * ratio` = 12, color x 0.6 | Ellipse, half-width 12, color x 0.6        |
| Joint                | Circle, radius `4 * ratio` = 12, full color       | Radius 12, full color                      |
| Limb list and colors | 17 limbs of BODY_18, standard colors              | The same 17 limbs and colors               |
| Background           | Black                                             | Black                                      |
| Hidden points        | Not drawn                                         | Far ear not drawn (hidden in the 3/4 view) |

Limits of the format (verified from the format, not a defect of our drawing):

- BODY_18 has no foot points (no toe, no heel). OpenPose cannot give the foot direction.
- The C0.5 skeleton in 2D has level shoulders and hips and both arms outside the torso. A frontal body with the same joints is a valid reading. This is C1 problem P1.
- Hand and face points (the 133-point DWPose set) are not used. The README does not require them for body pose.

## 5. Multi-condition fusion (verified from source)

### xinsir (official)

From `models/controlnet_union.py` and the README of xinsir6/ControlNetPlus:

- One forward pass for all conditions. The control types are one multi-hot vector, for example `[1, 1, 0, 0, 0, 0]` for OpenPose + depth. It goes into one control type embedding that is added to the time embedding.
- Each condition image goes through the same condition encoder. One token per condition plus one token of the latent sample go through the condition transformer. The outputs are added to the sample once.
- "Condition fusion is learned during training." The default scale is 1.0 for each condition, the same as in multi-condition training.
- The README says: "depth image contains detail info, it's recommended to use depth for background and use pose skeleton for foreground." Our C2 used depth for the foreground body.

### ComfyUI 0.35.0 (the version that ran)

From the source at tag `v0.35.0` (file hashes in the evidence):

- `SetUnionControlNetType` sets `control_type` to a list with one type (`comfy_extras/nodes_controlnet.py`, line 29).
- `union_controlnet_merge` (`comfy/cldm/cldm.py`, line 358) loops `for idx in range(min(1, len(control_type)))`. So it encodes at most one condition per pass. It also does not add the latent sample token that the xinsir code adds.
- `ControlNetApplyAdvanced` with a second control makes a copy of the ControlNet with `set_previous_controlnet`. In `control_merge` (`comfy/controlnet.py`, lines 226 to 228), the outputs of the two passes are added: `prev_val + o[i]`.

Result: our condition B was two separate single-condition passes (OpenPose 1.0 for all steps, depth 0.5 for steps 0 to 14) with the residuals added. The model was not trained for this sum. **The trained fusion cannot be used through the ComfyUI core nodes in this version.**
It would need a custom node or a diffusers script with the xinsir pipeline. Both are new code paths. A custom node is a human decision under AGENTS.md. This report did not verify any custom node.

## 6. Prompt changes C1 to C2 (hypotheses)

| Change against C1                                                                                | Possible effect                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New: `feet pointing to the right`                                                                | **Detached pointing hands.** `pointing` is a common Danbooru tag for an index-finger gesture. 3 of the 4 images with detached hands have pointing hands.                       |
| New: `arms slightly away from the body`                                                          | More attention on arms and hands. Possibly extra arms from the frame edge.                                                                                                     |
| Unchanged: `empty hands, visible hands`                                                          | In C1 they were present and gave no detached hands (2 images, seed 1001). They are probably not the cause alone, but they can add to the effect of the new hand-related words. |
| New: `body turned to the right, torso turned to the right, head turned the same way as the body` | Animagine XL 4.0 is trained on tags. Long natural-language phrases probably have a weak effect. The torso stayed frontal in all six images.                                    |
| New outfit (`fitted t-shirt, short sleeves, shorts, sneakers`)                                   | Worked as intended: the joints are visible in all six images.                                                                                                                  |
| Removed: `looking to the side`                                                                   | No near-profile head in C2. Heads are tilted or turned about 3/4, with closed eyes in 3 of 6.                                                                                  |
| Negative prompt has no terms against detached limbs                                              | Nothing pushed against the detached hands.                                                                                                                                     |

A near-controlled comparison exists for seed 1001: C1 `pose-1001` and C2 `a-openpose-1001` have the same model, seed, OpenPose image, strength, and sampler. Only the prompt is different. C1 had no detached hands; C2 has four.
So the prompt change is the probable cause for this seed (one pair, not proven). The C1 text-only baseline, with the C1 prompt, gave a body that is turned 3/4. The C1 OpenPose image made it frontal. This agrees with the hypothesis that OpenPose at full strength holds a frontal body.

## 7. Causes: facts and hypotheses

| ID  | Statement                                                                                                                                                                                                              | Status                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| F1  | The run used the approved files and the bundle graphs, once, without error.                                                                                                                                            | Verified                                                           |
| F2  | The ComfyUI chain is two single-condition passes added together, not the trained xinsir fusion.                                                                                                                        | Verified (source at v0.35.0)                                       |
| F3  | Our OpenPose drawing agrees with the xinsir recommendation. BODY_18 has no foot points.                                                                                                                                | Verified                                                           |
| F4  | In our depth image, the torso has a weak yaw signal: at chest height the values go from 165 (near edge) to 119 (far edge), on a silhouette that is almost symmetric. The arms have a strong signal (near 209, far 59). | Verified (pixel values of `depth-c05.png`, row 520)                |
| H1  | OpenPose at strength 1.0 for all steps holds a frontal body, because a frontal body agrees with the 2D joints and the model prefers it.                                                                                | Hypothesis; supported by C1 (baseline 3/4, OpenPose frontal)       |
| H2  | Depth at 0.5 for half of the steps, as a separate pass outside the trained fusion, is too weak or not interpreted as torso yaw.                                                                                        | Hypothesis                                                         |
| H3  | Our rendered depth (flat black background, hard edges, simple volumes) is far from the estimated depth of real images that the model learned.                                                                          | Hypothesis                                                         |
| H4  | The word `pointing` (in `feet pointing to the right`) causes the detached pointing hands.                                                                                                                              | Hypothesis; supported by the seed 1001 pair and by the hand shapes |
| H5  | A black (far) depth background reduces floating objects, so B had fewer detached hands.                                                                                                                                | Hypothesis; 3 images only                                          |
| H6  | Natural-language orientation phrases have little effect on a tag-trained model.                                                                                                                                        | Hypothesis                                                         |

## 8. Options

### A. Diagnostic test of the native OpenPose + depth fusion

| Aspect      | Assessment                                                                                                                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feasibility | Not possible with the ComfyUI core nodes (F2). It needs a custom node (human decision) or a Python diffusers script with the xinsir pipeline code (a new external tool and adapter, human decision). No new weights. |
| Benefit     | Low to medium. It answers H2 only. The xinsir README recommends depth for the background, not for the body pose. A correct fusion can still give a frontal torso (H1, H3).                                           |
| Cost        | GPU below $1 for six images. Preparation 1 to 2 days: review and pin the custom node or the script, a new bundle, tests.                                                                                             |
| Complexity  | Medium to high. A second execution path besides the ComfyUI core.                                                                                                                                                    |
| Risk        | Supply chain (custom node code runs in the GPU host), a result that does not decide the question, and more stages for a feature that the README does not recommend.                                                  |

### B. Template-driven generation

Fixed character geometry, made once and approved by a human: a 3/4 line drawing (or a flat-shaded template) of the C0.5 body with the turn visible in the contours (shoulder and hip lines, foreshortened far side, feet direction).
The generation then controls only appearance: line or canny control (the same approved union weights, type `canny/lineart/anime_lineart/mlsd`) or img2img from the template, with a lower OpenPose weight or none.
Later, the same template gives the part regions for the Spine layers, because the geometry is known.

| Aspect      | Assessment                                                                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feasibility | The approved weights already have a line mode. The template can be rendered from `referenceBody` (TypeScript, no AI) and then corrected by a human. The README recommends thin lines to fix hands and feet.                         |
| Benefit     | High for the project goal. The geometry and the part rectangles are fixed before generation, so the Spine layers and the rig contract fit by construction. It addresses H1 (no reliance on 2D joints alone) and the foot direction. |
| Cost        | Offline template work: 2 to 4 days of agent work plus human review. Later GPU tests below $1 each.                                                                                                                                  |
| Complexity  | Medium. A new artifact (the approved template) and a new control mode. The pipeline stays deterministic.                                                                                                                            |
| Risk        | Strong line control can make all characters look the same or stiff. Clothing and hair that leave the template need a looser control. The template quality depends on human art time.                                                |

## Recommendation: one next step

**Start direction B with an offline step only:** render a template candidate of the C0.5 body (3/4 contour line drawing and part masks) from `referenceBody`, with a preview for the owner. No GPU, no new bundle, no model change.
In the same step, prepare a corrected prompt for any later test: remove `pointing` and the long orientation phrases, and add detached-limb terms to the negative prompt (for example `disembodied limb, extra hands, floating hands`). These prompt changes are hypotheses to test, not fixes.

A later GPU test (owner decision) should then separate the causes with one change at a time, for example: C1 prompt against corrected prompt with OpenPose only, and OpenPose against line control from the template.

Do not do direction A now: it needs a new execution path, it tests only H2, and the official guidance does not support depth for the body pose.

## Limits

- Six images, three seeds, one assessor who knew the conditions. The gate and the artifact counts are visual judgments.
- The xinsir source was read from the `main` branch of xinsir6/ControlNetPlus (file hashes in the evidence), not from a pinned commit. The ComfyUI source is pinned to tag `v0.35.0`.
- The Hugging Face model cards were not reachable from this environment. The README of the GitHub repository was used.
- No control experiment ran. All causes in section 7 marked as hypotheses stay hypotheses.

## Evidence

In the project files, folder `research/c2-analysis/` (not in Git, D15). The archive is the authoritative copy: `SHA256SUMS` lists it, and `SHA256SUMS-inside` in the archive lists every file in it.
The loose PNG previews in the folder are for viewing only. The project file storage can change the bytes of loose PNG files, so use the copies in the archive for checks.

| File in the archive                         | Content                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `run/`                                      | The six PNG files, `result.json`, `state.json`, `run.log`, and `SHA256SUMS`, as received                        |
| `sheets/c2-sheet.png`                       | Per seed: A, A with OpenPose, B, B with OpenPose and the depth outline (half size)                              |
| `sheets/c2-heads.png`, `sheets/c2-feet.png` | Crops of the heads and the feet: A in the top row, B in the bottom row, seeds 1001 to 1003                      |
| `source-read/`                              | The ComfyUI `v0.35.0` files and the xinsir README and `controlnet_union.py` read for section 5                  |
| `analysis-tools/`                           | The small Node.js scripts that made the sheets and read the PNG `tEXt` graphs (analysis aids, not package code) |

Archive SHA-256: `691cf42521b284fd1815353727a242bb081714a1b3ea2c3373fdf25e1acc36b7`.
