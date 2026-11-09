# L0-1 manifest notes

**Draft.** This document tells how the pinned data of the bundle was made and what each component is. It does not approve a model. The owner gave a preliminary agreement for the two models, for L0-1 only. The final permission comes after the audit of the bundle.

## See-through code

| Item         | Value                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| Repository   | `https://github.com/shitagaki-lab/see-through.git`                                                     |
| Commit       | `df019de5129d6c4b406587a14c3501669441a783` (`main` at the time of the review)                          |
| License      | Apache-2.0 (`LICENSE` at the commit)                                                                   |
| Entry point  | `inference/scripts/inference_psd.py`                                                                   |
| Pinned files | 174: every Git file in `common/` and `inference/scripts/`, and `LICENSE`, with size, mode, and SHA-256 |

The run path was read at the pinned commit. The import closure of `inference_psd.py` (static analysis, no execution) has 17 repository files: the 15 files in [the bundle test](../test/bundle.test.ts) and `annotators/lama_inpainter/__init__.py` with `ffc.py`.
The LaMa files are imported only inside `cluster_inpaint_part`, which only `--tblr_split` calls. They are not pinned and not checked out for use: the runner checks only `common/` and `inference/scripts/`, and `--tblr_split` is forbidden.

Facts from the code at the pinned commit:

| Code                                                                          | Fact                                                                                                                                                                                         | Effect on the bundle                                                                                                 |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `apply_layerdiff`                                                             | Loads `TransparentVAE`, `UNetFrameConditionModel`, and `KDiffusionStableDiffusionXLPipeline` with `from_pretrained` from the LayerDiff3D repository.                                         | The full repository at the pinned revision is in the cache.                                                          |
| `KDiffusionStableDiffusionXLPipeline.__init__`                                | With `scheduler=None`, reads `scheduler/` of the LayerDiff3D repository with `local_files_only=True`, then tries `frankjoshua/juggernautXL_version6Rundiffusion`, then uses built-in values. | The runner requires the read of the LayerDiff3D `scheduler/scheduler_config.json`. Any other cache read is an error. |
| `apply_marigold`                                                              | Loads `UNetFrameConditionModel` and `MarigoldDepthPipeline` from the Marigold repository. The text encoder comes from the same repository.                                                   | `encode_empty_text()` with `prs-eth/marigold-depth-v1-1` is never called. Not downloaded.                            |
| `further_extr(..., tblr_split=False)`                                         | No LaMa, no clustering inpaint.                                                                                                                                                              | `--tblr_split` is forbidden.                                                                                         |
| `cluster_inpaint_part` (only with `--tblr_split`)                             | `torch.hub.load_state_dict_from_url("https://huggingface.co/dreMaz/AnimeMangaInpainting/resolve/main/lama_large_512px.ckpt")`: an automatic download and a pickle load.                      | BLOCKED and excluded.                                                                                                |
| `center_square_pad_resize`                                                    | The input is padded to a square and resized to 1280 x 1280. The output frame is 1280 x 1280.                                                                                                 | The comparison with the reference PSD must use the same padding and scale (5503 x 5503, factor about 4.30).          |
| `inference_psd_quantized.py`, `inference_psd_blockswap.py`, `--group_offload` | Other weights (NF4) or offload modes.                                                                                                                                                        | Not used.                                                                                                            |

The Hugging Face offline path was read in `huggingface_hub` 1.7.2 (`snapshot_download` and `try_to_load_from_cache`) and in `diffusers` 0.37.0 (`DiffusionPipeline.from_pretrained` sets `local_files_only` when `HF_HUB_OFFLINE` is set).
With `refs/main` that holds the exact revision (no newline) and real files in `snapshots/<revision>/`, the cache lookup does not need the network. The runner writes this layout. It writes no `blobs/` directory and no links.

## Model files

| Key           | Repository                                  | Revision                                   | License (model card)                                                 |
| ------------- | ------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `layerdiff3d` | `layerdifforg/seethroughv0.0.2_layerdiff3d` | `4477e6ce529bc6a141732e1a55a4932176db3b89` | `openrail++`: Apache-2.0, CreativeML Open RAIL++-M, Open RAIL-M, MIT |
| `marigold`    | `24yearsold/seethroughv0.0.1_marigold`      | `4f4ffc46050b6feb764b628859968a26e76e6b6a` | `openrail++`: Apache-2.0, Open RAIL++-M, CreativeML Open RAIL++-M    |

Both repositories are not gated. The use-based restrictions of the Open RAIL licenses (Attachment A) apply to every use.
Source of the data: the Hugging Face API `tree/<revision>?recursive=true` (fields `size`, `oid`, `lfs.oid`). The trees at the pinned revisions and at `main` were the same at the time of the review.
`.gitattributes` is not downloaded. `README.md`, `LICENSE`, and `NOTICE` are downloaded for provenance. See `data/model-files.json` for every file.

Not used and BLOCKED: `24yearsold/l2d_sam_iter2` (`checkpoint-18000.pt`, pickle), `dreMaz/AnimeMangaInpainting` (`lama_large_512px.ckpt`, pickle), the NF4 repositories, `prs-eth/marigold-depth-v1-1`, and `frankjoshua/juggernautXL_version6Rundiffusion`.

## Python wheels

`data/requirements.in` lists the direct requirements: the versions of the See-through `requirements.txt` for the packages that the run path imports, and `pip`.
Not included: `PyQt6`, `timm`, `convnext_perceptual_loss` (Git dependencies), `lpips`, `pandas`, `kornia`, `omegaconf`, `pillow-jxl-plugin`, `torchaudio`, and the annotator, SAM2, mmdet, and DeepSpeed requirement files.

The lock was resolved with this command (uv 0.11.32, metadata only, no installation):

```sh
uv pip compile requirements.in --python-version 3.12 --python-platform x86_64-manylinux_2_28 \
  --only-binary :all: --generate-hashes --index-url https://pypi.org/simple \
  --exclude-newer 2026-10-26T00:00:00Z
```

`--exclude-newer` keeps out every release that was less than two weeks old at the time of the lock.
For each pinned version, one wheel was selected from the PyPI JSON API: the best tag for CPython 3.12 on `manylinux_2_28_x86_64` or older (`cp312`, then `abi3`, then `py3-none-any`). Its SHA-256 is one of the hashes in the uv lock.
`torch` 2.8.0 from PyPI is the CUDA 12.8 build. Its `nvidia-*-cu12` dependencies are in the lock.
The bundle writes `requirements.lock` with exactly one hash per package, so pip accepts only the selected wheel.

## Input

`concept-mirrored.png`, SHA-256 `175b3292437165380dd6cfb07c2b46b05a7dee11f90cd24307ba05326e8eae8b`, from the project file `l0-input-v1.tar.gz`. It is a mirrored copy of a paid asset. It is not in Git.
Akane is a technical benchmark of the decomposition only. The source does not confirm the age of the character. The explicitly adult rule stays for the characters of this project.

## Installation qualification

**Draft.** The qualification has two parts. Only the first part runs in the repository and in CI.

| Part                      | Where                         | What it shows                                                                                                                                                                                                            | What it does not show                                           |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Static wheel check        | Tests, CI, bundle build       | Each wheel file name has tags for CPython 3.12 (`cp312`, `abi3` from `cp3x` up to `cp312`, or `py3`) and a `manylinux` tag up to glibc 2.28 on x86_64. The highest glibc that the wheels need is 2.28.                   | That pip installs them, or that they import                     |
| `qualify` (owner gate G3) | The GPU host, after `prepare` | As the run user, isolated and guarded: every installed distribution has its pinned version and no other distribution is present; each direct requirement imports; PyTorch reports CUDA 12.8 and runs one CUDA operation. | That the models load or that See-through gives a correct result |

Before `qualify`, `prepare` and `preflight` also check, without Python: the venv uses Python 3.12, does not include system site packages, and has exactly the pinned distributions in its `*.dist-info` metadata.
A mocked subprocess in the tests shows only the order of the steps and the arguments. It does not prove a real installation.

Direct requirements that `qualify` imports (distribution, then module): `torch` (`torch`), `torchvision`, `numpy`, `opencv-python` (`cv2`), `pillow` (`PIL.Image`), `scipy`, `scikit-learn` (`sklearn`), `matplotlib`, `einops`, `transformers`, `diffusers`, `huggingface-hub` (`huggingface_hub`), `tokenizers`, `accelerate`, `safetensors`, `pycocotools`, `psd-tools` (`psd_tools`), `tqdm`, `pyyaml` (`yaml`).

To repeat the qualification independently on another Linux x86_64 host with Python 3.12 and an NVIDIA GPU (owner permission necessary, because it downloads and installs):
make the run user, then run `preflight`, `prepare`, `preflight`, `gpu`, `isolation`, and `qualify` as in [the owner instructions](OWNER_RUN.md), and compare `evidence/qualify.json`.
