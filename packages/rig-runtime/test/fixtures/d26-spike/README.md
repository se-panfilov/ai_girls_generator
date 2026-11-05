# D26 spike fixture (experiment, not production)

These files are derived by code from a copy of the L1 owner export in `../l1-owner/`. The L1 files do not change.
They are test data for the D26 animated parts spike. They are not a production rig and not a production contract.

| File                | Content                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `skeleton.json`     | L1 skeleton + slot `eyes` (3-frame sequence attachment), `tail_1` keys moved from `run` and `jump_air` to `tail_run` and `tail_jump`, new `tail_idle` and `blink`. |
| `rig.contract.json` | L1 test contract + slot `eyes`, new draw order indexes, rig id `humanoid_girl_v1_d26_spike`, version 0.3.0, `animationOwners`, `companions`. |

The derivation is `../../d26/fixture.ts`. The test `d26-fixture.test.ts` compares these files byte for byte with its output.
To write them again: `AIGG_D26_WRITE_FIXTURE=1 npx vitest run test/d26-fixture.test.ts` in `packages/rig-runtime`.
Prettier does not format this folder (see `.prettierignore`), because formatting changes the bytes.
Images are made at run time by `../../d26/assets.ts`. No image is in the repository.
Report: [D26 spike](../../../../../docs/proposals/D26_ANIMATED_PARTS_SPIKE.md).
