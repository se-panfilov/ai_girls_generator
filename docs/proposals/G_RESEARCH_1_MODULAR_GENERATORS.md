# G-Research-1: alternative modular sheet generators (Phase 1, desk research)

**Status: Draft. Desk research only.** No inference ran. No model was downloaded. No GPU, paid API, or external service was used.
This document does not change [the model license registry](../MODEL_LICENSES.md), the rig contract, or decision D9. The owner decides whether and when Phase 2 starts.

## 1. Question

Can a specialized image-generation workflow make better C0.5-compatible [modular character sheets](../PIPELINE_V2_MODULAR_SHEET.md) than the current baseline?
The research looks at two capabilities:

1. **Initial generation.** A new sheet with all 18 required parts, each with the size and the axis of its C0.5 attachment rectangle.
2. **Reference-guided repair.** A change of one part (for example one forearm) from a reference, with no change to the other artwork.

## 2. Baseline

| Item                | Value                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generator           | ChatGPT image generation (external service). Prompt: AIGG Modular Character Sheet Generation Prompt v2.5.                                                                                                   |
| Result (V2-R1)      | 18 of 18 parts, clean alpha, `sheet-check` PASS, `sheet-extract` PASS. `idle` and `wave` play in `@aigg/viewer`.                                                                                            |
| Defects (V2-R1)     | Lengths near contract scale (0.72–1.27), widths not (0.74–1.91). `forearm_near` about 14° off the bone axis. Largest joint residual 57.1 px (tolerance 38.4 px). Step at the knees, seam at the near wrist. |
| Reproducibility     | Not reproducible. The service does not give the model version, a seed, or a model hash.                                                                                                                     |
| Local baseline (C2) | Animagine XL 4.0 + xinsir ControlNet Union ProMax (approved for experiment C only). C2 failed the orientation gate in 6 of 6 images. See [the C2 failure analysis](C2_FAILURE_ANALYSIS.md).                 |

The V2-R1 defects are geometric. A prompt gives sizes as text, and the generator does not measure them. The research therefore looks for workflows that take the layout as an **image input** and that can change one area under a **mask**.

## 3. Common design idea for the local candidates

**Proposed.** Both ranked candidates use the same two inputs and one deterministic post-step:

- **Layout template.** A sheet image made by script from the C0.5 contract: one gray silhouette for each of the 18 attachment rectangles, at the exact size, axis, and overlap. The existing `sheet-fixture` code makes this type of synthetic sheet. The template also gives the layout descriptor, so no joint needs a manual mark.
- **Character reference.** One design image (style, colors, costume). For a repair, the reference is the current sheet.
- **Mask composite.** After a masked repair, a script copies only the masked pixels from the result into the original sheet. Pixels outside the mask stay bit-exact, whatever the model does. This step does not depend on the model.

## 4. Candidate configurations

Sources and check dates are in [section 7](#7-sources). VRAM values are from the sources. They are not measured by this project.

### 4.1 C-A: ComfyUI + Qwen-Image-Edit-2511 (template-guided edit)

| Field                     | Content                                                                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model and workflow        | `Qwen/Qwen-Image-Edit-2511` (20B, MMDiT) with the native ComfyUI workflow: diffusion model, text encoder `qwen_2.5_vl_7b_fp8_scaled.safetensors`, VAE `qwen_image_vae.safetensors`. Image 1 = layout template, image 2 = character reference. Optional 4-step Lightning LoRA.                       |
| Capabilities              | Multi-image edit (the card example uses 2 images, no maximum given). Improved character consistency and less image drift than 2509. Stronger geometric reasoning. Masked inpainting through standard ComfyUI latent mask nodes.                                                                     |
| Limits                    | Not trained for part sheets. It can move or resize silhouettes, merge parts, or add a background. Text encoder VRAM is high. Output size must be a multiple of the latent grid (1024×1536 is a normal bucket, **assumption**).                                                                      |
| License                   | Apache-2.0 (model card). Text encoder: Qwen2.5-VL-7B, Apache-2.0 (**assumption**, verify the card). Lightning LoRA (`lightx2v`): license not checked. Do not use the LoRA before a check.                                                                                                           |
| Commercial use            | Permitted by Apache-2.0. No use-based restriction in the license. The project content rules apply.                                                                                                                                                                                                  |
| VRAM and runtime          | Third-party estimate: FP16 about 45 GB, INT8 about 22 GB, INT4 about 11 GB. On a 24 GB RTX A5000: FP8 or INT8 with CPU offload of the text encoder (**assumption**, verify in Phase 2). Default 40 steps, CFG 4. Runtime on A5000 not published (**assumption:** minutes for each 1024×1536 image). |
| 18-part topology          | **Plausible.** The template fixes the count, the slots, and the boxes. The model only paints inside given shapes. Risk: shape drift. The check is `sheet-check` and the box ratios against the contract.                                                                                            |
| Masks, references, layout | Masks: yes (ComfyUI inpainting). References: yes (multi-image). Controlled layout: yes, through the template image. No ControlNet is necessary.                                                                                                                                                     |
| Integration complexity    | Low to medium. A new workflow JSON for the existing owner-run bundle runner. The runner accepts only the two experiment C files now, so it needs an approved file list change.                                                                                                                      |
| Reproducibility           | Good. Pin the ComfyUI commit, the Hugging Face revisions and SHA-256 values, the seed, and the workflow JSON. Bit-exact output across GPU types is not expected. Record parameters and hashes.                                                                                                      |

### 4.2 C-B: ComfyUI + FLUX.2 [klein] 4B (multi-reference edit, fast)

| Field                     | Content                                                                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model and workflow        | `flux-2-klein-4b-fp8.safetensors` (distilled, 4 steps) or `flux-2-klein-base-4b-fp8.safetensors` (base), text encoder `qwen_3_4b.safetensors`, VAE `flux2-vae.safetensors`. Same inputs as C-A. |
| Capabilities              | Text-to-image and multi-reference edit in one model. Very fast: ComfyUI reports about 1.2 s and 8.4 GB VRAM (distilled) on an RTX 5090.                                                         |
| Limits                    | Small model. Less detail and weaker instruction following than large models (**assumption**, from model size). No reference count given.                                                        |
| License                   | 4B distilled and 4B base: Apache-2.0 (BFL). Text encoder and VAE licenses not checked (**assumption:** Apache-2.0). The 9B variants use the FLUX Non-Commercial License. Do not use 9B.         |
| Commercial use            | Permitted for 4B (Apache-2.0).                                                                                                                                                                  |
| VRAM and runtime          | About 13 GB (BFL), 8.4–9.2 GB at FP8 (ComfyUI). Fits an RTX A5000 24 GB without offload. Seconds for each image.                                                                                |
| 18-part topology          | **Plausible, lower confidence than C-A.** Same template method.                                                                                                                                 |
| Masks, references, layout | Masks: yes (ComfyUI inpainting). References: yes. Layout: through the template image.                                                                                                           |
| Integration complexity    | Low. Same runner change as C-A.                                                                                                                                                                 |
| Reproducibility           | Good. Same pinning as C-A.                                                                                                                                                                      |

### 4.3 C-C: ComfyUI + Qwen-Image-Layered (decomposition of a full-body image)

| Field                  | Content                                                                                                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model and workflow     | `Qwen/Qwen-Image-Layered` (20B), ComfyUI native workflow. Input: one full-body image. Output: N RGBA layers.                                                                                                                                   |
| Capabilities           | Variable layer count, recursive decomposition, hidden-area completion.                                                                                                                                                                         |
| Limits                 | ComfyUI: the prompt "is not designed to control the semantic content of individual layers". Layers are not at joints. A test report found hair stays one layer. Slow: about 75 s at 640 px, about 240 s at 1024 px, about 65 GB VRAM measured. |
| License                | Apache-2.0.                                                                                                                                                                                                                                    |
| VRAM and runtime       | bf16 "requires high VRAM". One report measured about 65 GB on a 96 GB GPU. An fp8 file exists. A 24 GB fit is not shown.                                                                                                                       |
| 18-part topology       | **Not plausible without extra splitting.** This is the Pipeline v1 path (decomposition, then split at joints), which D35 deprecated.                                                                                                           |
| Integration complexity | High.                                                                                                                                                                                                                                          |
| Result                 | **Not ranked.** Kept as a reference for See-through comparison only.                                                                                                                                                                           |

### 4.4 C-D: hosted specialized "parts sheet" tools and research systems

| Tool                                  | What it does                                                                 | Model, license, cost                                                                                                                                                                                           | Result                                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Scenario "2D Animation Rigging Sheet" | Concept image to a parts sheet (limbs, torso, head) for Spine, Live2D, Moho. | Uses "GPT Image 2.5 Sunburst". Proprietary paid. Hosted only.                                                                                                                                                  | Same model family as the baseline. No contract layout input. Adds an external service. **Not ranked.**             |
| Layer "Create Spine Components"       | Same type of tool.                                                           | Model, price, and output terms not stated. Proprietary. Hosted only.                                                                                                                                           | **Not ranked.** Terms unknown.                                                                                     |
| Bunraku (arXiv 2607.27348)            | One illustration to ordered RGBA layers, meshes, and key poses for Live2D.   | Code, weights, and license not found.                                                                                                                                                                          | Live2D, not a fixed 18-part Spine topology. **Watch only.**                                                        |
| FLUX.2 [dev] (32B)                    | Strong multi-reference edit (up to 10 images).                               | FLUX Non-Commercial License: outputs can be used commercially, but the model may not be used "for any commercial or production purposes" without a license. Needs more than 80 GB, or about 18–20 GB at 4-bit. | **Not ranked.** Recommended: no production use (license). Same license class as FLUX.1 Fill [dev] in the registry. |

### 4.5 C-E: ChatGPT and Gemini (comparison baselines)

| Field                     | ChatGPT / OpenAI image API                                                                                                                                      | Gemini 3 Pro Image ("Nano Banana Pro")                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Capabilities              | API edit: up to 16 input images, `mask`, `input_fidelity` (`high` on gpt-image-1.5), transparent background (PNG, WebP), sizes up to 3840×2160 on newer models. | Up to 14 reference images, up to 5 consistent people, "improved localized editing", 2K and 4K output. |
| Masks                     | Mask input exists. Whether the mask is a hard pixel limit is not stated in the reference. The composite step (section 3) makes it exact.                        | No mask parameter found. Localized edit is by instruction. The composite step needs a mask from us.   |
| Layout                    | Template image as input: possible. Not tested.                                                                                                                  | Template image as input: possible. Not tested.                                                        |
| License and cost          | Proprietary paid (API) or subscription (ChatGPT). Service terms apply.                                                                                          | Proprietary. SynthID watermark on all outputs. Visible watermark on free and AI Pro plans.            |
| Reproducibility           | Poor. Model versions change and retire ("GPT Image 1 was shut down on October 23, 2026"). No seed.                                                              | Poor. Preview models change. No seed.                                                                 |
| Integration and data flow | Sends prompts and character images to an external service. Needs an explicit owner request (AGENTS.md).                                                         | Same.                                                                                                 |

Both stay the comparison baselines. A Phase 2 run can give them the same template image, so that the comparison is fair. This needs owner approval for paid use or for upload of the template.

## 5. Ranking (at most two)

| Rank | Candidate                                       | Reason                                                                                                                                                                 |
| ---- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **C-A: Qwen-Image-Edit-2511 + layout template** | Apache-2.0, native ComfyUI, multi-image input, strongest consistency claims among the open candidates. The template attacks the V2-R1 scale and axis defects directly. |
| 2    | **C-B: FLUX.2 [klein] 4B + layout template**    | Apache-2.0, fits 24 GB with margin, seconds for each image. Good for many seeds and for small masked repairs. Lower expected quality.                                  |

Not ranked: C-C (wrong topology), C-D (closed, unknown terms, or non-commercial), C-E (baselines, not candidates).

## 6. Proposed Phase 2 experiment (not approved)

**Proposed.** Owner approval is necessary for each item: model files, GPU rental, the runner file list, and the use of any character image.

| Item                        | Proposal                                                                                                                                                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MVP blocker                 | The V2-R1 sheet fails `scale` and `joint_residuals`, and needs manual joints. A prompt alone does not control geometry.                                                                                                                                                                 |
| Smallest test               | One C0.5 layout template, one character reference, 4 seeds for each ranked candidate (8 images). One masked repair of `forearm_near` on the best image of each candidate. Same template to ChatGPT only if the owner wants it.                                                          |
| Host                        | Owner-run Runpod RTX A5000 24 GB with ComfyUI, as in experiment C. Agent prepares the bundle and analyzes the images.                                                                                                                                                                   |
| Model files                 | C-A: diffusion model (FP8 or INT8 variant), text encoder, VAE. C-B: 4B FP8 diffusion model, text encoder, VAE. Exact files, revisions, and SHA-256 values go to the registry for approval before download.                                                                              |
| Acceptance                  | At least 1 of 4 seeds of a candidate: 18 of 18 parts, `sheet-check` PASS, every part box within ±10 % of its attachment rectangle, axis within 5°, joint residuals within tolerance. Repair: 0 changed pixels outside the mask after composite, part visually consistent (owner score). |
| Why not enough evidence now | No public result shows these models on a fixed part-sheet layout. Only a run on our template can show shape drift.                                                                                                                                                                      |

## 7. Sources

Checked on 2026-11-27. Third-party values are estimates.

- Qwen-Image-Edit-2511 model card: <https://huggingface.co/Qwen/Qwen-Image-Edit-2511>
- ComfyUI Qwen-Image-Edit-2511 guide: <https://docs.comfy.org/tutorials/image/qwen/qwen-image-edit-2511>
- VRAM estimate (third party): <https://www.spheron.network/tools/gpu-recommender/Qwen/Qwen-Image-Edit-2511/>
- Qwen-Image-Layered model card: <https://huggingface.co/Qwen/Qwen-Image-Layered>
- ComfyUI Qwen-Image-Layered guide: <https://docs.comfy.org/tutorials/image/qwen/qwen-image-layered>
- Qwen-Image-Layered test report (third party): <https://lilting.ch/en/articles/qwen-image-layered-live2d-face-parts>
- FLUX.2 [klein] announcement: <https://bfl.ai/blog/flux2-klein-towards-interactive-visual-intelligence>
- ComfyUI FLUX.2 [klein] guide: <https://docs.comfy.org/tutorials/flux/flux-2-klein>
- FLUX.2 [dev] model card: <https://huggingface.co/black-forest-labs/FLUX.2-dev>
- FLUX [dev] Non-Commercial License v2.0: <https://bfl.ai/legal/non-commercial-license-terms>
- FLUX.2 on Hugging Face (VRAM): <https://huggingface.co/blog/flux-2>
- OpenAI image edit API reference: <https://developers.openai.com/api/reference/resources/images/methods/edit>
- Nano Banana Pro announcement: <https://blog.google/technology/ai/nano-banana-pro/>
- Scenario 2D Animation Rigging Sheet: <https://scenario.com/apps/2d-animation-rigging-sheet>
- Layer Create Spine Components: <https://layer.ai/tools/layer--create-spine-components>
- Bunraku: <https://www.alphaxiv.org/abs/2607.27348>

## 8. Limits

- Desk research only. No value in this document is measured by the project.
- License data comes from model cards and vendor pages. It is not a legal review. The registry status of each model does not change.
- Runtime on the RTX A5000 is not published for C-A. The Phase 2 run measures it.
