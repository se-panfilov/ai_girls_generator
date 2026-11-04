# L1 remediation and modular spike: evidence (Agent Task v5)

**Draft.** This report gives the evidence for the L1 remediation (P0–P2), the mix-and-match spike (P3), and the contract proposal (P4).
It does not change the status of the original L1 run. The original L1 result stays **4 PASS / 3 FAIL**.
The contract proposal is in [the v5 contract patch](proposals/RIG_CONTRACT_V5_PATCH.md). It is not accepted.

## Owner summary

- The original L1 run on macOS is **FAIL, 4/7**. This report does not relabel it.
- The cause of the 3 failures is in the gate harness, not in the editor export. The game files did not change.
  - L1-02 A and C: the v4 harness required a real region for absent parts. The packer writes a 1×1 region for an empty image.
  - L1-04: the manifest included the macOS file `.DS_Store`. The five game files were byte-identical.
- The new v5 checks use the **unchanged owner files**. All 11 steps and 53 inner checks pass (Linux, software WebGL).
- Absent parts now come from `character.json` (`absent_by_design`). The runtime attaches nothing for them. It does not need a transparent 1×1 image.
- Mix-and-match works with spine-webcomponents 4.3.13 and spine-core 4.3.13: head A + legs B + arm C, and an arm swap during `run` with no mixed frame.
- **Owner actions: none** until review. No new manual Spine test is necessary.

## Input verification (P0)

| Item                                     | Value                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Owner archive `l1-owner-evidence.tar.gz` | SHA-256 `d2544fd22fa8e4c4d1edc0d8e635571eea683aefdeb91491feedb23344b15a81`: agrees with the owner `.sha256` file |
| Owner input files                        | 80 files hashed before the work. The same 80 hashes after all runs (`INPUT-UNCHANGED`: PASS)                     |
| Real `skeleton.json`                     | 7448 bytes, SHA-256 `1cd5bf8c886f09f4fd629cd504020616a105ce310cd7f46031898e0883943eb5`                           |
| Content                                  | 28 bones, 27 slots, 1 skin (`default`), 9 animations, `skeleton.spine` = `4.3.26`                                |
| Page images                              | `a.png` `b2bfd12c…82f9`, `b.png` `3d738f05…0e0e`, `c.png` `4e6a2d5f…ee22`                                        |

The extracted archive was used as read-only data. Derived output went to a separate folder.

## Triage table (P0)

FACT: read directly from a file. TEST: reproduced by a run. INFERENCE: a conclusion from facts. ASSUMPTION: not proven.

| Kind       | Statement                                                                                                                                                                                              | Reference                                                                                           | Confidence | Impact                                             | Proposed change                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| FACT       | The owner `l1-summary.json` is `{"pass":4,"fail":3,"result":"FAIL"}`.                                                                                                                                  | `gates/l1-results/l1-summary.json`                                                                  | High       | Original status is FAIL                            | Keep it. Do not relabel.                                              |
| TEST       | The unchanged v4 harness on the owner files gives 4 PASS / 3 FAIL again. The failing checks and the error lists are the same.                                                                          | `bench-v4orig/l1-results/`                                                                          | High       | The failure is reproducible                        | None                                                                  |
| FACT       | Atlas A has 8 regions with `bounds:2,49,1,1` and `orig` 1×1: `acc_head`, `ear_far`, `ear_near`, `hair_tail`, `hand_near_front`, `skirt_back`, `skirt_front`, `tail`. Atlas C has 4.                    | `editor-out/a/a.atlas`, `editor-out/c/c.atlas`; owner logs `L1-02-atlas-a.log`, `L1-02-atlas-c.log` | High       | L1-02 A and C fail                                 | Absence from `character.json`, no region needed (P2)                  |
| FACT       | All 8 (A) and 4 (C) such parts are `absent_by_design` in `characters/a.json` and `characters/c.json`.                                                                                                  | v4 kit `characters/*.json`                                                                          | High       | The 1×1 regions are packer output for empty images | Ignore them with a warning (`W_ABSENT_PART_REGION_IGNORED`)           |
| TEST       | With "Ignore blank images: on", atlas A has no region for absent parts. The v4 path fails with `Region not found in atlas: acc_head`. The v5 path assembles A and renders like the 1×1 atlas.          | `editor-out-blank/a/a.atlas`; v5 checks `R5-a-blank-*`                                              | High       | Both packer settings are supported                 | Do not depend on transparent images (P4)                              |
| FACT       | The v4 manifest `before-c.sha256` has 6 entries. One is `./.DS_Store`. The log says `./.DS_Store: FAILED`.                                                                                             | `gates/l1-results/before-c.sha256`, `L1-04-hash-invariance.log`                                     | High       | L1-04 fails                                        | Skip macOS metadata by name (P1)                                      |
| TEST       | The 5 game files (`skeleton.json`, `a/a.png`, `a/a.atlas`, `b/b.png`, `b/b.atlas`) in `editor-out/before-c/` and `editor-out/` are byte-identical.                                                     | v5 check `L1-04-v5`                                                                                 | High       | L1-04 is a harness false negative                  | None for the assets                                                   |
| FACT       | On Linux, the archive extracts `._.DS_Store` as a normal file. The v4 harness then sees 7 files, not 6.                                                                                                | Extracted `editor-out/before-c/`                                                                    | High       | AppleDouble files must also be skipped             | Skip `._*` (P1)                                                       |
| FACT       | The editor JSON has `skeleton.spine` = `4.3.26`. The owner reports that the editor version 4.3.08 was selected. The v4 contract already records `editorVersion` 4.3.26.                                | `editor-out/skeleton.json`, `rig.contract.json`                                                     | High       | Version records can differ from the launcher       | Record both values. No reinstall.                                     |
| INFERENCE  | The editor writes the version of the running editor build into `skeleton.spine`, not the launcher selection.                                                                                           | —                                                                                                   | Low        | None for the runtime 4.3.13 (it reads the JSON)    | Investigate only if a later export fails                              |
| TEST       | spine-core 4.3.13 and spine-webcomponents 4.3.13 load the 4.3.26 JSON and render A/B/C like the owner renders (max channel difference 1–2, mismatch 0).                                                | v5 checks `R5-*-vs-owner`                                                                           | High       | Runtime compatibility confirmed for this file      | None                                                                  |
| TEST       | `AssetManagerBase.disposeAsset` was suspected to dispose a shared atlas without reference counting. A browser test with two widgets on one atlas did **not** show it: the second texture stayed valid. | v5 file `mix/finding-assetmanager-dispose.json`                                                     | Medium     | No defect proven                                   | The spike keeps module atlases out of the widget asset manager anyway |
| ASSUMPTION | The owner renders were made on macOS with a real GPU. The v5 renders are software WebGL (SwiftShader). Small channel differences come from the renderers.                                              | —                                                                                                   | Medium     | Pixel tolerances                                   | A later GPU check only if rendering changes                           |

## Before and after

Counts are real results of the named runs.

| Check                         | Original (owner, macOS)      | v4 reproduction (Linux) | v5 (Linux, owner files)                                          |
| ----------------------------- | ---------------------------- | ----------------------- | ---------------------------------------------------------------- |
| L1-00 profile                 | PASS                         | PASS                    | PASS (unchanged v4 check)                                        |
| L1-01 parity                  | PASS                         | PASS                    | PASS (unchanged v4 check)                                        |
| L1-02 A                       | FAIL (8 × orig 1×1)          | FAIL (same 8)           | PASS: 19 attached, 8 absent, 8 regions ignored with a warning    |
| L1-02 B                       | PASS                         | PASS                    | PASS: 27 attached                                                |
| L1-02 C                       | FAIL (4 × orig 1×1)          | FAIL (same 4)           | PASS: 23 attached, 4 absent                                      |
| L1-02 A, blank-dropping atlas | expected FAIL (not in the 7) | FAIL (v4 path throws)   | PASS                                                             |
| L1-03 render                  | PASS (12 inner)              | PASS (12 inner)         | PASS (37 inner render checks, A/B/C and A blank)                 |
| L1-04 hash invariance         | FAIL (`.DS_Store`)           | FAIL (`.DS_Store`)      | PASS, and 8 negative or metadata variants PASS                   |
| **Total**                     | **4 PASS / 3 FAIL**          | **4 PASS / 3 FAIL**     | **11/11 steps, 53/53 inner checks PASS** (other v5 checks below) |
| MIX (P3)                      | NOT RUN                      | NOT RUN                 | 7 browser checks PASS, unit tests PASS                           |
| macOS, real GPU               | —                            | NOT RUN                 | NOT RUN                                                          |

### Render evidence (P2)

| Comparison                                                         | Result                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| v5 assembled skin vs v4 path, A/B/C × setup, `shoot_crouch`, `run` | 9 of 9 identical: 0 differing pixels                                  |
| v5 vs owner macOS renders, A/B/C × setup, `shoot_crouch`           | 6 of 6: max channel difference 1 (C `shoot_crouch`: 2), mismatch 0    |
| Facing left vs mirror of facing right                              | 4 of 4 PASS (A, B, C, A blank), mismatch 0                            |
| A blank-dropping atlas vs A 1×1 atlas                              | 3 of 3: 38–204 differing pixels, max channel difference 1, mismatch 0 |

### L1-04 evidence (P1)

The policy skips only the basenames `.DS_Store` and `._*`, at snapshot time and at verification time. All other files, also other hidden files, are hashed.
The real owner snapshot passes. The original v4 manifest with the `.DS_Store` entry passes, and the report lists the entry as skipped.
A 1-byte change of each of the 5 real game files after the snapshot gives FAIL with `E_CHECKSUM` and the file name. A deleted file gives `E_MISSING`.
Symbolic links and special files stop the run (`E_SYMLINK`, `E_SPECIAL_FILE`). `--strict` reports new files (`E_UNEXPECTED_FILE`).

### Mix-and-match evidence (P3)

Go: multi-atlas mix-and-match works under spine-webcomponents with the Essential feature set (rigid regions, one shared `SkeletonData`).

| Check   | Result                                                                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIX-01  | Head A + legs B + near arm C in one widget, from three atlases. Three textures added. One shared `SkeletonData`.                                                           |
| MIX-02  | Arm C → B during `run`: 60 frames recorded, 0 mixed frames, 0 time drops, same skeleton and track entry. Head and legs did not change.                                     |
| MIX-02b | Paused swap B → C: 31144 changed pixels inside the near-arm screen box, 0 outside.                                                                                         |
| MIX-03  | Head accessory and ears: no attachment → module B → no attachment. No 1×1 region was attached.                                                                             |
| MIX-04  | 120 swaps and 12 create and dispose cycles: at most 3 live WebGL textures, 0 after dispose and trim. Software WebGL, not a GPU measurement.                                |
| MIX-NEG | Missing page image (`E_TEXTURE_MISSING`) and incompatible module (`E_MODULE_INCOMPATIBLE`): the character does not change, 0 leaked textures. 12 more negative unit tests. |
| MIX-DET | Same seed gives the same selection and hash, also with a different catalog order. Snapshot of seed 20261104. CLI test on a path with spaces and `ü`.                       |

The atomic swap: all checks and atlas loads finish first. Then one synchronous step changes the skin. No frame can show a partial change.
`Skeleton.setSkin` alone keeps an old attachment when the new skin has no entry for the slot. `applySkin` sets each changed slot explicitly.

## Commands

From the repository root (Node.js 26.12.1, see `.nvmrc`):

```sh
npm ci --ignore-scripts
npm run check
npm test --workspace @aigg/rig-runtime
```

The browser bench is outside the repository, because it needs the owner page images (see the storage decision D15).
It is in the project files as `research/gates-v5/` (source archive, patch against v4, evidence archive, `SHA256SUMS`). Command:

```sh
node v5/run-v5.mjs <repository> <owner-archive-root> <v4-kit> <output-dir>
```

## Environment

| Item                | Value                                                      |
| ------------------- | ---------------------------------------------------------- |
| Operating system    | Linux x64 (container). macOS: NOT RUN                      |
| Node.js             | 26.12.1                                                    |
| Browser             | Chromium 153.0.8010.12 headless, SwiftShader (software GL) |
| Playwright          | 1.63.0                                                     |
| spine-core          | 4.3.13                                                     |
| spine-webcomponents | 4.3.13                                                     |
| Editor export       | `skeleton.spine` 4.3.26 (owner reports 4.3.08 selected)    |

## Remediation after the independent PR review (Agent Task v5.1)

An independent review of the first version of this change found three defects in the draft module code. Each defect was reproduced with a failing test before the fix (`test/audit-v51.test.ts`: 3 failed, 1 passed).

| Finding                 | Defect before the fix                                                                                                                                          | Fix                                                                                                                                                                                           | Evidence after the fix                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 atlas cache identity | The cache key was only the atlas text hash. A second reference with the same atlas text and other page images got the first texture set.                       | The key is `atlasIdentity`: atlas text hash, alpha mode, and page image hashes in page order. File paths are not part of it.                                                                  | Two texture sets for different page hashes, independent owners and disposal. One shared texture set, counted owners and one unload for identical content. |
| P1 greedy composition   | `composeModules` chose groups one by one and did not go back. With heads `tone1` and `tone2` and one torso `tone1`, some seeds gave `E_COMPOSE_NO_COMPATIBLE`. | Depth-first backtracking over one seeded shuffle of each group. Limits: `maxModules` (`E_COMPOSE_CATALOG_TOO_LARGE`) and `maxSteps` (`E_COMPOSE_SEARCH_LIMIT`). No partial result at a limit. | 64 of 64 seeds find the only compatible selection. Limit, configuration and no-solution tests pass.                                                       |
| P1 duplicate module ids | Candidates were sorted by `moduleId` only. Two modules with one id and different content gave a result that depended on the catalog order.                     | Catalog identity rule: the same id with different content is `E_CATALOG_DUPLICATE_ID`. Copies with the same content (canonical JSON) are permitted.                                           | A reversed catalog gives the same outcome for 32 seeds, also in the formerly ambiguous case.                                                              |

The seeded selection of seed 20261104 changed with the new algorithm (snapshot updated). The same seed still gives the same selection on each run and for each catalog order.
After the fixes: package tests 77 of 77 PASS, `npm run check` PASS, and the browser bench again gives 11/11 steps and 53/53 inner checks.

A second review found that `selectionText`, the identity text of a selection, held only the module id and the atlas text hash of each module.
Two regression tests failed before the fix: other page image hashes, and other bindings or tags, gave the same identity.
The identity text now holds the canonical JSON (sorted keys) of the full content of each selected module.
`test/audit-v52.test.ts` (4 tests) passes: page hashes, bindings, tags and provenance change the identity; another key order does not; the same data and seed give the same identity.

## Known harness defects (follow-up, not in this task)

| Id    | Defect                                                                                                  | Proposed fix                                                        |
| ----- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| N1 A4 | The macOS mirror screenshot included an HTML control as well as the canvas. This gave a false negative. | Take the screenshot of the canvas element only.                     |
| M1    | `psd-tools` returned a trailing `\0` in layer names of files from Krita.                                | Remove trailing NUL characters in the layer-name step, with a test. |

These do not change the L1 result. They do not need a new manual test.

## Risks and limits

- GPU memory and frame time were measured only with software WebGL. A real GPU check is a later step if the owner wants it.
- Seams between parts of different characters are an art issue. Compatibility rules check tags only.
- Atlas lifetime: the cache unloads through the caller. A page that also gives a module atlas to the widget asset manager can dispose it twice.
- Attachment timelines that name attachments resolve through the character skin. A module must supply each name that the animations use for its slots.
- The module group table and the manifest format are drafts.

## Rollback

The change adds one package (`packages/rig-runtime`), two root development dependencies, documents, and a CI test fixture fix.
To roll back, revert the commit. No data format and no existing file of a character package changes.
