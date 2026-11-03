# Model license registry

**Draft.** No model is approved yet. This registry holds the candidates from the research. A legal review is not done.

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
| Animagine XL 4.0                   | Style model (S2, S4)       | CreativeML Open RAIL++-M                                             | open weights     | Candidate                   |
| `xinsir/controlnet-union-sdxl-1.0` | Pose and line control (S4) | Apache-2.0                                                           | open weights     | Candidate                   |
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

## Tools

| Tool                 | Use                      | License                | Label            |
| -------------------- | ------------------------ | ---------------------- | ---------------- |
| ComfyUI              | Generation orchestration | GPL-3.0                | open source      |
| Krita                | Cleanup, PSD and ORA     | GPL-3.0                | open source      |
| Spine editor 4.3     | Master rig, atlas export | Spine Editor License   | proprietary paid |
| Spine Web Components | Preview runtime          | Spine Runtimes License | source-available |

The Spine runtimes require a valid Spine editor license for the developers who integrate them. The editor license has extra terms for SDKs and game toolkits.
Read both licenses before any distribution. This registry does not interpret them.
