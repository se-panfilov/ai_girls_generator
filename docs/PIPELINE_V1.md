# Pipeline v1: concept decomposition

**Deprecated (D35, accepted).** Pipeline v1 gets no new features by default. It stays intact and reproducible. The removal of Pipeline v1 is not authorized.
The primary workflow is now Pipeline v2. See [the Pipeline v2 ADR](proposals/PIPELINE_V2_ADR.md).

"Pipeline v1" is a workflow generation. It is not the product scope "version 1", not a rig contract version, and not a package version. See [Versioning semantics](proposals/PIPELINE_V2_ADR.md#7-versioning-semantics-and-pipeline-provenance).

## Workflow

```text
concept image (licensed test asset, 3/4 view facing image-right)
  -> L    See-through decomposition on an owner-run GPU host   (seethrough-bundle)
  -> L    human review of the layers
  -> LM   manual landmarks on the concept                      (align-study, annotate-page)
  -> M    modular assembly on the C0.5 candidate rig           (assemble-body)
  -> SPINE Spine CLI import and export on the owner's computer (spine-validate)
  -> WEB  playback in the official Spine web runtime           (aigg-viewer)
  -> human final review
```

`@aigg/factory` runs this flow as one resumable job: `INPUT`, `W_APPROVAL`, `L` (import), `L_REVIEW`, `LANDMARKS` (import), `M`, `SPINE`, `PREVIEW`, `FINAL_APPROVAL`. See [the factory README](../packages/factory/README.md).

## Inputs and outputs

| Item                       | Format                                                                                                                       | Kept where                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Concept image              | One PNG, pinned by file name and SHA-256 in the See-through bundle                                                           | Project files, outside Git (licensed asset) |
| See-through result         | `<stem>.psd.json` and `<stem>/<tag>.png` for each semantic layer, `<stem>/src_img.png`                                       | Project files, outside Git                  |
| Manual landmarks           | `landmarks-manual.json` (`aigg.l0-1c.landmarks/0.1`)                                                                         | Project files, outside Git                  |
| Alignment study            | `correspondence.json` of `align-study` with the same landmarks and image                                                     | Project files, outside Git                  |
| Rig contract               | The C0.5 candidate `packages/control/test/fixtures/c05-candidate/rig.contract.json`                                          | Git                                         |
| Assembled package (output) | `character.json`, `spine/skeleton.json` (Spine 4.3 JSON, layout `mvp-a-body`), region PNGs, evidence, previews, `SHA256SUMS` | Project files, outside Git (derivatives)    |
| Spine CLI result (output)  | `cli-validation.json`, logs, the Spine export                                                                                | Owner's computer                            |
| Web playback (output)      | Local page on `127.0.0.1`, `idle` and `wave`                                                                                 | Owner's computer                            |

## Stages and manual checkpoints

| Stage             | Tool                                                              | Automatic or manual                                                     |
| ----------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Concept selection | —                                                                 | **Manual.** The owner supplies and approves a licensed concept.         |
| Decomposition     | `@aigg/seethrough-bundle` (owner-run bundle on a rented GPU host) | Automatic run, started by a person. Each run needs an owner permission. |
| Layer review      | Contact sheets, layer evaluation                                  | **Manual.**                                                             |
| Landmarks         | `aigg-control align-study`, `annotate-page`                       | **Manual** marks (about 20 for each character), checked by a tool.      |
| Assembly          | `aigg-control assemble-body`                                      | Automatic.                                                              |
| Spine validation  | `aigg-control spine-validate` with the licensed Spine executable  | Automatic run on the owner's computer.                                  |
| Web playback      | `aigg-viewer`                                                     | Automatic check, visual review by a person.                             |
| Final review      | `aigg-factory approve` or `reject`                                | **Manual.** Interactive terminal only. Agents never record a decision.  |

## Dependencies and models

| Dependency                                    | License label             | Status                                                                                                                                     |
| --------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| See-through code (pinned commit)              | open source (Apache-2.0)  | Candidate in [the model license registry](MODEL_LICENSES.md). Used under separate owner permissions for L0-1 (Akane) and MVP-E (Jun) only. |
| See-through LayerDiff3D and Marigold weights  | open weights (OpenRAIL++) | Same as above. Pins: `packages/seethrough-bundle/data/`.                                                                                   |
| Python 3.12, PyTorch, pinned wheels           | various                   | On the GPU host only, through the bundle. Not in this repository's dependencies.                                                           |
| Rented GPU host (Runpod)                      | paid service              | The owner rents and pays. Agents do not.                                                                                                   |
| Spine Editor 4.3 (Essential)                  | proprietary paid          | The owner's license and computer.                                                                                                          |
| `spine-webcomponents` and `spine-core` 4.3.13 | Spine Runtimes License    | Root development dependencies. Shared with Pipeline v2.                                                                                    |

## Reproducibility requirements

- **Pins.** The See-through bundle pins the code commit, the model revisions and file hashes, the Python wheels, and the input image. See [the bundle README](../packages/seethrough-bundle/README.md#pinned-data).
- **Definition.** Same parameters, same files, and a log with result hashes. Not the same pixels on another GPU (D14 recommendation).
- **Offline steps.** `align-study`, `assemble-body`, and the factory are deterministic for the same inputs and the same tool version. The MVP-D report shows the same `SHA256SUMS` for a direct run and a factory run.
- **Evidence.** The result archives and their SHA-256 lists are in the project files, outside Git. Keep them. Do not change them.
- **Tools.** Keep the commands in the [component inventory](COMPONENT_INVENTORY.md) that Pipeline v1 needs. A tool version in an evidence file names the code that made it.

## Experiments and results

The results are component results. Pipeline v1 **did not** reach production pipeline acceptance or a final character package. Both characters are licensed test assets, not product characters, and not approved character packages.

### Character A: Akane (licensed test asset)

| Step                        | Result                                                                                                                  | Report                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| L0-1 See-through run        | Done once by the owner on a rented GPU host                                                                             | [Bundle README](../packages/seethrough-bundle/README.md)                                     |
| L0-1b layer split           | Arms and shoes split. Upper thighs merged.                                                                              | [L0-1b](proposals/L0_1B_SPLIT_FEASIBILITY.md)                                                |
| L0-1c alignment to C0.5     | PARTIAL                                                                                                                 | [L0-1c](proposals/L0_1C_ALIGNMENT_FEASIBILITY.md)                                            |
| L0-1d manual landmarks      | PARTIAL, with owner marks                                                                                               | [L0-1d](proposals/L0_1D_LANDMARK_CALIBRATION.md)                                             |
| L0-1e near arm cut          | Cut PASS, rotation without new pixels PARTIAL                                                                           | [L0-1e](proposals/L0_1E_NEAR_ARM_FEASIBILITY.md)                                             |
| L0-1f, L0-1g joint underlay | PARTIAL. The tube region is best. Full gap closure and a bit-exact neutral pose are not possible together.              | [L0-1f](proposals/L0_1F_UNDERLAY_FEASIBILITY.md), [L0-1g](proposals/L0_1G_JOINT_GEOMETRY.md) |
| M0-F0a near arm in Spine    | `JSON_GENERATED` PASS. The first owner CLI run failed on one curve difference. The second owner run is not recorded.    | [M0-F0a](proposals/M0_F0A_SPINE_ARM_VALIDATION.md)                                           |
| MVP-A full-body assembly    | 13 offline checks PASS, `JSON_GENERATED`                                                                                | [MVP-A](proposals/MVP_A_FULL_BODY_ASSEMBLY.md)                                               |
| MVP-B Spine CLI             | The owner validated the MVP-A package once with `spine-validate`. One run, not three.                                   | [MVP-D, three-run status](proposals/MVP_D_PIPELINE_ORCHESTRATION.md#three-run-status-d33)    |
| MVP-C web playback          | PASS by the agent on a synthetic export and an agent-made atlas. The owner playback of the real export is not recorded. | [MVP-C](proposals/MVP_C_BROWSER_PLAYBACK.md)                                                 |
| MVP-D factory               | Agent part PASS: the real job stops at `W_APPROVAL`. A complete owner run of the job is not recorded.                   | [MVP-D](proposals/MVP_D_PIPELINE_ORCHESTRATION.md)                                           |

### Character B: Jun (licensed test asset, MVP-E)

| Step                       | Result                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input                      | An idle sprite frame, about 224 × 337 px, upscaled ×4. No high-resolution full-body image exists in the asset.                                              |
| See-through run            | Done once with bundle 0.3.2. Layer evaluation: proceed with limitations.                                                                                    |
| Landmarks and alignment    | Agent proposal, approved by the owner without change. `align-study` PASS (mean 3.08 %, max 5.20 % of body height).                                          |
| Assembly                   | `assemble-body` 12 of 12 offline checks PASS, `JSON_GENERATED`. Two general code fixes were necessary (optional face feature layers, generated PNG limits). |
| Spine CLI and web playback | Not run. Owner steps.                                                                                                                                       |
| MVP-E status               | `PASS_WITH_LIMITATIONS` is recommended. The owner has not closed MVP-E.                                                                                     |

The MVP-E closeout report and the evidence are in the project files (`research/mvp-e/closeout/`), outside Git, because they contain derivatives of a licensed asset.

## Known limitations

- **Reconstruction of hidden parts.** See-through completes hidden content (for example about 79 % of the back hair of Jun). The quality is not controlled.
- **Merged limbs.** The legwear layer merges the upper thighs of both characters. The split is approximate.
- **Joint gaps.** Joint overlaps do not exist in the concept. The underlay methods close most gaps, not all.
- **Manual landmarks.** About 20 manual marks for each character.
- **Character-specific rules in `assemble-body`.** `characterId` is `akane_test` for every character. The `objects` layer always goes to `hand_far`. The `bottomwear` rule assumes a skirt. The `knownLimitations` text is fixed Akane text. See [the component inventory](COMPONENT_INVENTORY.md#control-assembly-and-spine).
- **Per-character setup geometry.** Bones start at the landmarks of each character. The bone ids are shared, the setup positions are not.
- **Demonstration animations only.** `idle` and `wave`. Not the shared animation set.
- **Low-resolution input (Jun).** The asset has no high-resolution full-body image.
- **GPU cost and access.** Each decomposition needs an owner permission, a rented GPU host, and an owner run.

## Reusable components

Most back-end components do not depend on the decomposition. The classification of each component is in [the component inventory](COMPONENT_INVENTORY.md). In short:

- **Shared:** the rig contract, the package format, the Spine skeleton builder and checks, `spine-validate`, `@aigg/viewer`, `@aigg/rig-runtime`, the factory job model.
- **Pipeline v1 only:** `@aigg/seethrough-bundle`, the See-through layer rules, the L0-1 study commands.

## Deprecation and compatibility policy

**Accepted by the owner (D35).**

1. Pipeline v1 is deprecated, not removed.
2. Existing CLI commands continue to work with the same options, output, and exit status.
3. Existing validated artifacts stay readable by the tools that read them now.
4. No automatic migration of Pipeline v1 packages to Pipeline v2 is implied.
5. Pipeline v1 gets no new features by default. A new feature needs an owner request.
6. Critical correctness, reproducibility, or security defects of Pipeline v1 can still be fixed.
7. Components shared with Pipeline v2 stay actively maintained. A change to a shared component must keep the Pipeline v1 behavior, or the change needs an owner decision.
8. A removal needs a separate owner-approved decision and a separate pull request. See [the deferred cleanup plan](COMPONENT_INVENTORY.md#deferred-cleanup-plan).
9. Do not delete licensed asset records or the provenance evidence that Pipeline v1 results need.

Implementation rules for the policy:

- Do not add language-level deprecation markers (for example `@deprecated`) to shared APIs.
- Do not add warnings, failing tests, or exit status changes only because Pipeline v1 is deprecated.
- Documentation can mark a command as "Pipeline v1". That is the only required mark.
