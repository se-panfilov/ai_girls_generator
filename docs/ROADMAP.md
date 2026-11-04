# Roadmap and experiments

**Draft.** Each phase starts only after the previous gate passes, except phases marked as parallel. The durations are estimates, not commitments.

## Phases

| Phase | Content                                                                                                 | Gate                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 0     | The owner closes the decisions in [the decision log](DECISIONS.md).                                     | Decisions recorded.                                                                 |
| 1     | Runtime: experiment A on a real GPU and in Electron.                                                    | Experiment A passes.                                                                |
| 2     | Reference: mannequin, base body, reference pose, one character by hand, master rig with all animations. | The character plays all animations in both directions in the web runtime.           |
| 3     | Contract 0.2 (parallel with phase 2): contract file, JSON Schemas, check against the Spine export.      | Schemas and checks pass on the reference character.                                 |
| 4     | Interchange: experiment D.                                                                              | Experiment D passes. A third character does not change shared files.                |
| 5     | Generation: experiment C.                                                                               | Experiment C passes, or a fallback method is selected.                              |
| 6     | Decomposition: experiment B.                                                                            | A method is selected. Cleanup time is measured.                                     |
| 7     | MVP pipeline: text to approved package.                                                                 | Three characters pass the pipeline. The time of each step is measured.              |
| 8     | Freeze version 1: contract 1.0 and documentation.                                                       | A new character needs no contract change. Equipment extensibility is checked (D25). |

Automate a step only after it was done the same way by hand at least three times.

Owner decision: full GPU and performance tests wait until realistic game assets and mass-render scenarios exist. They are not a gate for decision D22 or for the design of D23. The performance question of D24 stays open.

## Future Equipment System (v2+)

**Owner-approved strategic intent. Not a version 1 task.** The implementation details below are not approved. Decision D25 holds the open questions.

The factory will support equipment that does not depend on the character appearance:

1. Appearance and equipment are different entities. Weapons and removable armor are not drawn permanently into the source images of the body.
2. Items in the hands change at run time without a change of the shared skeleton and without a restart of the animation.
3. Named mount points on the rig and local item points, for example `grip`, `muzzle`, `tip`, and others when necessary.
4. Removable clothes and armor: helmets, body armor, shoulder guards, bracers, footwear, and similar items.
5. Future operations overlay, replace, and hide/override. Their exact API is not approved yet.
6. A multi-part item changes atomically.
7. The design considers rig compatibility, draw order, and independent resource management (see D23 and D24).
8. Before the rig contract freeze, estimate the additional slots and mount points that equipment needs. Do not add hypothetical slots now without a reason.
9. Two-handed weapons, complex grips, and the limits of Spine Essential are separate questions for version 2 or later (see D6).
10. Full GPU and performance tests stay deferred until realistic game assets exist.

Gate for phase 8 (contract 1.0 freeze): an equipment extensibility check of the rig contract (D25).

## Experiments

### A. Runtime feasibility

| Field      | Content                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| Hypothesis | Spine Web Components in Vue 3 show many characters with one skeleton, different atlases, and shared animations.        |
| Status     | Partly done. A local test with Spine example assets passed in headless Chromium with software WebGL.                   |
| Remaining  | Real GPU and Electron, a test skeleton of our size, shared skeleton data, 10/30/60 characters, memory over 10 minutes. |
| Pass       | 60 FPS or more with 30 characters and 8 atlases on the target laptop. Memory growth below 5 % in 10 minutes.           |
| Fail       | Below 30 FPS with 30 characters, or a memory leak.                                                                     |

### B. Layer decomposition

| Field      | Content                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Hypothesis | Base body plus decomposition only for hair, headwear, ears, tail, and weapon needs less cleanup than decomposition of the full image. |
| Input      | 12 production art images in the reference pose: skirts, tails and animal ears, long hair, all with firearms.                          |
| Metrics    | Cleanup minutes for each character, validator errors before cleanup, preview defects, artist score 1–5, GPU time.                     |
| Pass       | The selected method needs 60 minutes of cleanup or less, has no critical defects after cleanup, and scores 4 or more.                 |
| Fail       | Both methods need more than 120 minutes of cleanup.                                                                                   |

### C. Rig-guided generation

| Field      | Content                                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hypothesis | Pose, depth, and line control from the mannequin keep the joint error at 2.5 % of body height or less in 70 % of results. Two-step generation keeps the concept design. |
| Input      | 20 text descriptions. Control images made by script from the mannequin.                                                                                                 |
| Metrics    | Joint error, segment length, zone IoU, share inside tolerance, design similarity, human approval share, GPU seconds.                                                    |
| Pass       | 70 % or more inside tolerance with three attempts or fewer. Design kept in 70 % or more by human score.                                                                 |
| Fail       | Below 40 % inside tolerance.                                                                                                                                            |

### D. Asset interchange

| Field      | Content                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hypothesis | PNG and JSON to PSD, image editor, PSD back to PNG and JSON, Spine atlas, and web preview lose no data. One `skeleton.json` serves two characters without changes. |
| Status     | Script part done in research: PNG to PSD and back, PNG to ORA and back. The image editor and Spine are not tested.                                                 |
| Metrics    | Pixel difference after the round trip (0 outside the changed layer), position offset (0 px), name match, hashes of shared files after a third character is added.  |
| Pass       | All metrics pass. The third character is added without changes to shared files.                                                                                    |
| Fail       | The editor changes alpha or color, or Spine imports with an offset.                                                                                                |
| Cost       | Needs a Spine license. This needs the owner's approval (decision D10).                                                                                             |

## Research sources

The research reports and the contract 0.2 proposal are in the project files, outside this repository:

- `research/layered-character-pipeline-report.md`
- `research/ai-character-factory-audit.md`
- `research/contract-v0.2-proposal/`

Move the JSON Schemas and the validator prototype into the `contract` and `validator` packages in phase 3.
