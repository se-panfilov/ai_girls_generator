# C2: preparation of the OpenPose against OpenPose + depth experiment

**Draft. Not run.** This document prepares experiment C2: a minimal, reproducible comparison of OpenPose control only (condition A) against OpenPose + depth control (condition B).
No GPU, paid API, inference, or model download was used to prepare it. **No real ComfyUI or GPU test of the C2 graph was done.**
The owner first examines the depth preview and the execution bundle. Then the owner decides about a paid run. Nothing in this document approves a run, a model, or a contract change.

C2 answers one question from [the C1 report](C1_GEOMETRY_EVALUATION.md): does a depth control from the C0.5 reference body correct the torso and foot orientation that OpenPose alone does not keep (C1 problem P1)?

## Owner decisions for C2

These are the owner's decisions after C1. This preparation applies them and does not extend them.

1. The C0.5 candidate stays the experimental contract (`humanoid_girl_v1_c05_candidate`, contract 0.3.0, SHA-256 `17e73069…7675e`). C0.5 is not changed.
2. The same two approved model files, with the same pinned revisions and SHA-256 values as C1 (see [the model license registry](../MODEL_LICENSES.md)).
3. The depth mode of the approved xinsir ControlNet Union ProMax file is allowed for C2. No new model weights.
4. The prompt has no `looking to the side`. It describes the whole body turned 3/4 to the right, including the torso and the feet.
5. A test outfit that shows the joints: a fitted top, short sleeves, shorts, low shoes.
6. No change to the master skeleton, the approved rig contract, or the game animations.

## Approximate depth image

`aigg-control depth` renders `referenceBody` (`packages/control/src/mannequin.ts`, the C0.5 reference body) as simple volumes. It is TypeScript on Node.js, deterministic, with no AI model and no Python.

**It is a relative depth approximation, not an accurate 3D model.** It has no hair, clothing, fingers, breasts, or face detail except a small nose. Its purpose is to give the diffusion model the
orientation of the torso, the head, and the feet, and the near/far order of the limbs. It does not give the body shape of the character.

### Method

- Camera: the same as C0.5. Orthographic, yaw 40°, body frame (left, up, forward) in head units, 7 heads tall. The camera transform is `x = l·cos(yaw) + f·sin(yaw)`, `z = −l·sin(yaw) + f·cos(yaw)`.
  The near side is the subject's right side (`left` < 0). It is on the image left and nearer to the camera. The face and the toes point to the image right.
- Volumes: one smooth torso volume with elliptic cross-sections (a loft), ellipsoids for the head and the nose, capsules for the neck, the upper arms, the forearms, the hands, the thighs, the shins, and the feet.
  The limb capsules go between the C0.5 landmarks with the C0.5 radii.
- Each pixel casts 2 x 2 rays along the camera axis. The nearest surface wins, so occlusion is correct by construction: the near leg covers the far leg, and the torso covers part of the far arm.
- Encoding: near is bright, far is dark, the background is black (the MiDaS convention that depth ControlNets use). Linear from 255 (nearest body surface) to 40 (farthest body surface), background 0.
- The image size is the bundle size, 832 x 1216, with the same fit transform as the OpenPose image (scale 0.792, offset x 10.667).

### Assumed parameters

`referenceBody` does not give these values. They are assumptions of the renderer, in head units. They are in `depthAssumptions` (`packages/control/src/depth.ts`) and in `depth.json`. They do not change C0.5.

| Parameter                  | Value                                                                                                         | Reason                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Torso sections (up: w x d) | 3.3: 0.62 x 0.44, 3.6: 0.80 x 0.52, 4.3: 0.58 x 0.41, 4.95: 0.78 x 0.50, 5.35: 0.76 x 0.45, 5.55: 0.60 x 0.36 | Pelvis (3.6), waist (4.3), and chest (4.95) half widths and depths are from `referenceBody.radii`. The bottom, shoulder, and top sections are assumed so that the volume closes smoothly. |
| Torso end caps             | bottom 0.15, top 0.20                                                                                         | Rounded ends instead of flat cuts. An earlier version with stacked ellipsoids gave visible ribs; the loft replaced it.                                                                    |
| Head center height         | 6.5                                                                                                           | `head_top.up − radii.head.h`. The forward offset is from `landmarks.head`.                                                                                                                |
| Neck                       | from 5.35 to 6.15                                                                                             | From inside the shoulders to inside the head, so the neck has no visible ends. Radius from `radii.neck`.                                                                                  |
| Nose                       | sphere, radius 0.08, inset 0.05                                                                               | At `landmarks.face_nose`. It shows the face direction in the depth image. It is the only face detail.                                                                                     |
| Hand                       | capsule 0.5 long from the wrist down                                                                          | A closed hand. No fingers. Radius from `radii.hand`.                                                                                                                                      |
| Foot                       | capsule from `landmarks.foot` to `landmarks.toe`                                                              | Radius from `radii.foot`. Surfaces below the ground are cut.                                                                                                                              |
| Depth encoding             | near 255, far 40, background 0                                                                                | Body surfaces stay well above the background value, so the silhouette is clear.                                                                                                           |
| Samples                    | 4 per pixel                                                                                                   | Smooth edges, deterministic.                                                                                                                                                              |

### Self-checks D1 to D7

`depth` and `bundle --experiment c2` stop when a check fails (`E_DEPTH_CHECK`). Current result for the C0.5 candidate: **all PASS**.

| Check | Rule                                                        | Result                                             |
| ----- | ----------------------------------------------------------- | -------------------------------------------------- |
| D1    | Projected joints agree with the contract joints within 1 px | Largest difference 0.567 contract px (`shin_near`) |
| D2    | Projected face points agree with the contract within 1 px   | Largest difference 0.626 px                        |
| D3    | The nose points to the image right and toward the camera    | 0.321 head units right, 0.383 toward the camera    |
| D4    | Both toes point to the image right and toward the camera    | Near 0.467 / 0.587, far 0.497 / 0.562              |
| D5    | The near limbs are nearer than the far limbs                | Mean joint depth near 0.546, far −0.521 head units |
| D6    | The near limbs have more visible pixels than the far limbs  | Arm 76282 / 71375, leg 139797 / 131127 samples     |
| D7    | Every part is visible                                       | PASS                                               |

### Preview for approval

`depth-preview.png` is a 3 x 2 sheet. Top: the depth image, the OpenPose image, the depth with the OpenPose skeleton on it. Bottom: the volumes colored by part (near blue, far orange),
the C0.5 flat mannequin, and a top view (the red line is the face direction, the black line is the camera direction).
The preview is in the project files (D15 is open), see [Evidence](#evidence).

What the owner examines: the torso turns about 40° to the image right, the toes point right, the face points right, the near arm and leg are brighter and in front, and the volumes stay on the OpenPose joints.

## Prompt changes

The prompt is the same for A and B. Changes against C0 and C1 (`c2Prompt` in `packages/control/src/workflow.ts`):

- Removed `looking to the side` (C1 problem P2: the head turned to near profile).
- Added `body turned to the right, torso turned to the right, feet pointing to the right, head turned the same way as the body, arms slightly away from the body`.
- Outfit: `fitted t-shirt, short sleeves, shorts, bare knees, sneakers` instead of `fitted jacket, shorts, boots`.
- Negative prompt adds `profile, looking back, oversized clothes, jacket, long sleeves, boots, high heels`.
- Unchanged: `1girl, original, safe, adult woman, mature female`, and the negative terms that exclude explicit content and minors.

## Workflows

Six ComfyUI API workflows: A and B for the seeds 1001, 1002, 1003. Within one seed, A and B are identical except for the depth nodes. The runner checks this (`E_WORKFLOW_PAIR`) before it contacts ComfyUI.

| Setting                | A and B                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| Checkpoint             | `animagine-xl-4.0.safetensors`                                           |
| ControlNet             | `diffusion_pytorch_model_promax.safetensors` (one loader for both types) |
| Size                   | 832 x 1216                                                               |
| Sampler                | `euler_ancestral`, `normal`, 28 steps, CFG 5, denoise 1                  |
| OpenPose control       | union type `openpose`, strength 1.0, active 0 to 1 (the same as C1)      |
| Depth control (B only) | union type `depth`, strength 0.5, active 0 to 0.5 of the steps           |

Graph of B: nodes 1 to 11 are the A graph. Node 12 loads `depth-c05.png`. Node 13 is a second `SetUnionControlNetType` (type `depth`) on the same `ControlNetLoader` (node 9).
Node 14 is a second `ControlNetApplyAdvanced`. Its conditioning inputs are the outputs of the OpenPose application (node 11). The sampler uses the outputs of node 14.

Reason for the depth settings: the torso and foot orientation is set in the early steps. Depth that stops at half of the steps leaves the late steps free for the clothing and the hair,
so the result does not follow the bare volumes too closely (a body-tight or naked-looking surface). Strength 0.5 is below the OpenPose strength so that the joint positions stay with OpenPose.
These values are a reasoned first choice, not a measured optimum. C2 does not tune them; one setting gives one clear comparison.

### Verified and not verified

| Item                                                     | Status                                                                                                                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A graph (OpenPose only)                                  | **Run once in C1** on ComfyUI 0.35.0 with the same model files.                                                                                                |
| Union type name `depth`                                  | **Not verified on a server.** The runner compares it with the choices of `SetUnionControlNetType` in `/object_info` before any download (`E_COMFYUI_CHOICE`).  |
| Two chained `ControlNetApplyAdvanced` on one union model | **Not verified.** ComfyUI applies each control as a separate pass and adds the results. The xinsir multi-condition path uses one pass. The results can differ. |
| Node inputs of all six graphs                            | Checked at run time against `/object_info` (`E_COMFYUI_INPUT`) before any download. Unit tests use a fake ComfyUI only.                                        |
| Depth image as the model expects it                      | Not verified. The image follows the MiDaS convention (near bright). The model was trained with estimated depth of real images, not with rendered volumes.      |

If the `check` step gives any `E_COMFYUI_*` error, the owner stops and terminates the Pod. The agent then changes the graph; the owner decides about a new run.

## Execution

The C2 bundle uses the architecture of the C1 bundle: the agent prepares it, the owner runs it on the GPU host, the agent analyzes the images.
Details are in the bundle `README.md` and in [the package README](../../packages/control/README.md).

- Node.js only on the host (`runner.mjs`, built-ins). `run.sh` only checks `SHA256SUMS` and Node.js.
- Only the two approved files, from pinned revisions, with SHA-256 checks after download.
- Only the local ComfyUI API (`127.0.0.1:8188`). No public HTTP port. No credentials in the bundle.
- `check` before the download compares every node input, the union types, and the sampler choices with the live ComfyUI.
- Each submission is recorded before it is sent. A lost answer gives `E_SUBMISSION_AMBIGUOUS`. A completed run is never generated again. No automatic retry or extra generation.
- The agent has no access to the owner's computer, the Pod, or SSH keys.

### Cost

| Item  | Estimate                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------- |
| GPU   | Runpod RTX A5000 24 GB On-Demand, about $0.27 per hour (an estimate; check the current price before the run)  |
| Time  | Pod start and ComfyUI 5 to 10 min, model download 5 to 15 min, six images 2 to 5 min, copy and teardown 5 min |
| Total | 20 to 40 min, **below $1** including disk. The budget limit is $5. The stop limit for C2 is $3.               |

## Evaluation

The agent analyzes the six images after the owner copies the results. The C1 agent marks are not ground truth and are not used.

### Orientation gate (first)

Each image passes the gate only if all four items pass. The assessor judges the images without the condition label (file names hidden, random order), then the labels are opened.

| Item | Rule                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| O1   | The torso is turned to the image right, about 40° (accepted 20° to 60°), from the shoulder line, the chest, and the hip line. |
| O2   | Both feet point to the image right (toward the camera side), not to the camera and not to the image left.                     |
| O3   | The head turns the same way as the torso, within about 30°. Not near profile, not frontal while the torso is turned.          |
| O4   | The near/far overlaps are correct: the near arm and leg (image left) are in front; the far arm is partly behind the torso.    |

### Joint measurement (second)

- Mark only joints that are reliably visible. A hidden or uncertain joint is marked unmeasurable, not guessed.
- Report the coverage: measured joints out of 13 (the OpenPose body joints without the face). An image with coverage below 9/13 is reported but not used for the joint criteria.
- Error is the distance to the C0.5 contract joint, in percent of body height, with the same transform as C1.

### Success criteria

C2 supports depth control when all of these are true:

1. B passes the orientation gate in 2 or more of 3 images.
2. In the B images that pass the gate, the measured joints have a maximum error of 2.5 % or less and a mean of 1.5 % or less.
3. The mean joint error of B is not worse than that of A by more than 0.5 percentage points.

If B passes the gate but A also passes in the same number of images, depth is not shown to be necessary; the prompt change alone can be the cause. This is a result, not a failure.

### Stop criteria

Stop and report to the owner, with no new generation, when:

- `check` gives any `E_COMFYUI_*` error.
- Any generation error, `E_SUBMISSION_AMBIGUOUS`, or `E_PROMPT_LOST`.
- Any image breaks the content rules (explicit content, a character that does not look adult).
- B passes the gate in 0 of 3 images.
- The joints of B conflict with OpenPose (for example, the depth silhouette pulls a limb away from its OpenPose position by more than the 2.5 % limit).
- The spend for C2 goes above $3.

## Limits

- Three seeds and one setting are a small sample. C2 can show a direction; it does not decide experiment C (see [the roadmap](../ROADMAP.md)).
- The depth volumes are approximate. The model can copy their shape (a thick neck, a tubular body) into the image. The depth stop at 0.5 reduces this risk but does not remove it.
- The depth image has no hair or clothing. Loose clothing or hair can conflict with the silhouette.
- The union type name and the chained application are not verified on a server (see [Verified and not verified](#verified-and-not-verified)).
- The C1 bundle built from this version has different `runner.mjs` bytes from the C1 bundle that ran, because the runner now also validates node inputs. The C1 bundle that ran is not changed.
- The images are not in Git (D15 is open).

## Reproduction

From the repository root, after `npm ci --ignore-scripts` and `npm run build --workspace @aigg/control`:

```sh
node packages/control/dist/src/cli.js depth --contract packages/control/test/fixtures/c05-candidate/rig.contract.json --out /tmp/c2-depth
node packages/control/dist/src/cli.js bundle --experiment c2 --contract packages/control/test/fixtures/c05-candidate/rig.contract.json --out /tmp/exp-c2-bundle
```

Both commands are deterministic. The same source gives the same bytes.

## Evidence

In the project files, folder `research/c2-prep/` (not in Git, D15). Authoritative copies are the archives; `SHA256SUMS` lists them.

| File                      | Content                                                                                     | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `exp-c2-bundle.tar.gz`    | The execution bundle (six workflows, both control images, runner, README, `SHA256SUMS`)     | see `SHA256SUMS`                                                   |
| `c2-depth-preview.tar.gz` | `depth-c05.png`, `depth-parts.png`, `depth-top-view.png`, `depth-preview.png`, `depth.json` | see `SHA256SUMS`                                                   |
| `depth-c05.png` in bundle | The depth control image                                                                     | `a73811035975ffaca1369a958357819993eb3d9c32b36506db34ca97966c711d` |
| `openpose-anatomical.png` | The OpenPose control image, the same file as in C1                                          | `7a1809c838d2433e99efe06a6a314c332b625edf88a0e25ae8f8852c3120f280` |
