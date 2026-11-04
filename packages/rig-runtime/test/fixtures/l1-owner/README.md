# L1 owner fixtures (text files only)

These files are byte-exact copies of text files from the owner's L1 evidence archive `l1-owner-evidence.tar.gz`
(SHA-256 `d2544fd22fa8e4c4d1edc0d8e635571eea683aefdeb91491feedb23344b15a81`). The owner made them on macOS with Spine Essential.
They are test data for the shared test rig `humanoid_girl_v1`. They are not production game assets.

| File                        | Source in the archive                                       | Notes                                                                     |
| --------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| `rig.contract.json`         | `l1-kit/rig/rig.contract.json`                              | Test rig contract v0.2.0 from the v4 L1 kit.                              |
| `editor-out/skeleton.json`  | `l1-kit/editor-out/skeleton.json`                           | JSON export of the master project. `skeleton.spine` is `4.3.26`.          |
| `editor-out/{a,b,c}/*.atlas` | `l1-kit/editor-out/{a,b,c}/*.atlas`                         | Texture Packer output, "Ignore blank images" off (1x1 regions in A and C). |
| `editor-out-blank/a/a.atlas` | `l1-kit/editor-out-blank/a/a.atlas`                         | Texture Packer output for A, "Ignore blank images" on (no blank regions). |
| `characters/{a,b,c}.json`   | `characters/{a,b,c}/character.json` of `l1-kit-v4.tar.gz`   | Part status of the synthetic test characters. Not in the owner archive.   |

The page images (`*.png`) are not in the repository (no binary assets before the storage decision).
Tests that need pixels run in the gate test bench outside the repository.

`SHA256SUMS` lists the hashes. A test compares the files with it, so a changed fixture stops the tests.
Prettier does not format this folder (see `.prettierignore`), because formatting changes the bytes.
