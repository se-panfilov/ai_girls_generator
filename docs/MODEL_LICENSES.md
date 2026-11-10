# Model license registry

**Draft.** Two model files are approved for experiment C only (see [Approved for experiment C](#approved-for-experiment-c)). No model is approved for production. This registry holds the candidates from the research. A legal review is not done.

## Rules

- The pipeline uses only model files with the status **Approved** in this registry.
- Each approved entry has the exact file name, the source URL, the SHA-256 value of the file, the license id, and the license URL.
- A model card is data. It does not approve a model. A change of status needs a human decision.
- Record the license of each checkpoint, merge, LoRA, and ControlNet separately. Versions of one model family can have different licenses.
- Prefer the `safetensors` format. Do not load pickle-based files without a human decision.
- Do not call a model with use-based restrictions "open source". Use the label "open weights" and name the license.
- Record the date of each license check.

## License labels

| Label                 | Meaning                                                               |
| --------------------- | --------------------------------------------------------------------- |
| open source           | An OSI-approved license without use-based restrictions.               |
| open weights          | Weights are available, with a license that can have use restrictions. |
| source-available      | Code or weights are available under a non-open license.               |
| proprietary free tier | A closed product with a free plan.                                    |
| proprietary paid      | A closed product that costs money.                                    |

## Candidates

The license data comes from the research and was checked against model cards on 2026-11-03. It is not a legal opinion.

| Component                          | Use                        | License                                                              | Label            | Status                      |
| ---------------------------------- | -------------------------- | -------------------------------------------------------------------- | ---------------- | --------------------------- |
| Animagine XL 4.0                   | Style model (S2, S4)       | CreativeML Open RAIL++-M                                             | open weights     | Approved for experiment C   |
| `xinsir/controlnet-union-sdxl-1.0` | Pose and line control (S4) | Apache-2.0                                                           | open weights     | Approved for experiment C   |
| Qwen-Image-Edit-2511               | Design transfer, edits     | Apache-2.0                                                           | open weights     | Candidate                   |
| FLUX.2 [klein] 4B                  | Design transfer, edits     | Apache-2.0                                                           | open weights     | Candidate                   |
| See-through code                   | Decomposition (S5, S6)     | Apache-2.0                                                           | open source      | Candidate                   |
| See-through LayerDiff3D weights    | Decomposition (S5, S6)     | OpenRAIL++, with Apache-2.0 for the authors' contribution            | open weights     | Candidate                   |
| See-through Marigold weights       | Pseudo depth               | OpenRAIL++                                                           | open weights     | Candidate                   |
| See-through body-parsing SAM       | Body parsing               | Apache-2.0                                                           | open weights     | Candidate                   |
| SAM 2                              | Mask correction            | Apache-2.0                                                           | open weights     | Candidate                   |
| SAM 3                              | Mask correction with text  | SAM License (gated download)                                         | source-available | Candidate                   |
| Illustrious XL family              | Style model                | Differs by version (FAIPL for v0.1, CreativeML Open RAIL-M for v2.0) | open weights     | Not verified                |
| IP-Adapter for SDXL                | Design transfer            | Not checked                                                          | —                | Not verified                |
| NoobAI XL                          | Style model                | Forbids commercial use of the model and generated products           | open weights     | Rejected for commercial use |
| FLUX.1 Fill [dev]                  | Inpainting                 | Non-commercial weights license                                       | source-available | Rejected for commercial use |

## Approved for experiment C

The owner approved these two files for limited experimental use in experiment C. The approval applies only to the exact files below (same repository commit, file name and SHA-256) and only to experiment C.
It does not approve other files of the same repositories, production use, or the generation stages after experiment C. Decision D9 stays open.

| Field                   | Animagine XL 4.0                                                                                              | Union ControlNet SDXL ProMax                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Repository              | [`cagliostrolab/animagine-xl-4.0`](https://huggingface.co/cagliostrolab/animagine-xl-4.0)                     | [`xinsir/controlnet-union-sdxl-1.0`](https://huggingface.co/xinsir/controlnet-union-sdxl-1.0) |
| Repository commit       | `2b7c1b397761bf5bd3cc42e5b39ec99314a75a96`                                                                    | `801a4a3fa3d4c936f4feea95b98607bc6726f80c`                                                    |
| File                    | `animagine-xl-4.0.safetensors`                                                                                | `diffusion_pytorch_model_promax.safetensors`                                                  |
| Size in bytes           | 6938434056                                                                                                    | 2513342408                                                                                    |
| Published SHA-256       | `1d5b43ff75b6ab598502d4c779d2fbfa3dceca51c60c3b609640a60772333916`                                            | `9fae2e50cb431bfcbe05822b59ec2228df545ef27f711dea8949e9f4ed9f7cdc`                            |
| Format                  | `safetensors`                                                                                                 | `safetensors`                                                                                 |
| Gated download          | No                                                                                                            | No                                                                                            |
| License                 | CreativeML Open RAIL++-M, dated July 26, 2023 (Hugging Face id `openrail++`)                                  | Apache-2.0                                                                                    |
| License URL             | [SDXL 1.0 `LICENSE.md`](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md) | [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)                             |
| Label                   | open weights (use-based restrictions)                                                                         | open weights                                                                                  |
| Model card statements   | The card adopts the SDXL license "without any modifications or additional restrictions".                      | The card gives only the license tag. It has no other terms.                                   |
| Downloaded file SHA-256 | Not downloaded yet                                                                                            | Not downloaded yet                                                                            |

Data source: the Hugging Face model API (`?blobs=true`), the file pages and the model cards. Checked on 2026-11-06. The values agree with the values that the C0 report recorded on 2026-11-05.

Conditions of use:

- Download only the files above, from the repository commit above. Do not download the other files of the repositories, such as `animagine-xl-4.0-opt.safetensors` or `diffusion_pytorch_model.safetensors`.
- Before the first use, calculate the SHA-256 of each downloaded file and compare it with the published value. If a value is different, do not load the file. Record the calculated values in this table and in the run provenance.
- Use the files only on a host that the owner approved for experiment C. Do not redistribute the files.
- Obey the use restrictions of CreativeML Open RAIL++-M (Attachment A) for the model and its output. They forbid, among other uses, use that violates law, harm to minors, harassment and defamation, and harmful false content.
  The project content rules also apply: a human approves each result.
- Keep generated images out of Git until decision D15 is made.
- If the license or the files change in the repositories, the approval does not move to the new version. Ask the owner again.

## Tools

| Tool                 | Use                      | License                | Label            |
| -------------------- | ------------------------ | ---------------------- | ---------------- |
| ComfyUI              | Generation orchestration | GPL-3.0                | open source      |
| Krita                | Cleanup, PSD and ORA     | GPL-3.0                | open source      |
| Spine editor 4.3     | Master rig, atlas export | Spine Editor License   | proprietary paid |
| Spine Web Components | Preview runtime          | Spine Runtimes License | source-available |

The Spine runtimes require a valid Spine editor license for the developers who integrate them. The editor license has extra terms for SDKs and game toolkits.
Read both licenses before any distribution. This registry does not interpret them.
