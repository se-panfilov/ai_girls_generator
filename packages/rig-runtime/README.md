# @aigg/rig-runtime

**Draft.** Research-grade library and command-line tool for the shared rig. It is not a game runtime and not an animation engine.
Pipeline stages: S9 (validation) and S11 (preview). It came from the L1 remediation and the modular spike (Agent Task v5).
Evidence and the owner-facing summary: [L1 v5 evidence](../../docs/L1_V5_EVIDENCE.md). Contract proposal: [v5 contract patch](../../docs/proposals/RIG_CONTRACT_V5_PATCH.md).

## What it does

| Area                   | Module                  | Summary                                                                                                                      |
| ---------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Shared rig             | `rig.ts`                | Reads the unchanged editor JSON once. Region attachments become templates. `SkeletonData` has bones, slots, animations only. |
| Character skin         | `assemble.ts`           | Makes a runtime `Skin` from `character.json` and an atlas. Absent parts get no attachment. Present parts need a real region. |
| Atlas checks           | `atlas.ts`              | Structure checks on the spine-core `TextureAtlas` parser, with stable error codes.                                           |
| Part modules (draft)   | `modules.ts`            | Module manifest `aigg.part-module/0.1`, the draft group table, compatibility rules, deterministic composition with a seed.   |
| Modular character      | `modular-character.ts`  | One skeleton per character. Module changes are checked and loaded first, then applied in one synchronous step (atomic).      |
| Atlas cache            | `atlas-cache.ts`        | Shared atlases with explicit owners, a bounded set of unused atlases, and unload through the caller's loader.                |
| Asset manifests (Node) | `manifest.ts`, `cli.ts` | SHA-256 manifests of exported files. macOS `.DS_Store` and `._*` files are skipped by name; all other files are hashed.      |

The browser-safe entry is `@aigg/rig-runtime` (`src/index.ts`). The Node.js entry is `@aigg/rig-runtime/node` (`src/node.ts`).

## spine-core

The package has **no runtime dependency**. The caller passes the spine-core classes (`SpineRuntime`).
A page that uses spine-webcomponents passes its `spine` namespace, so that the renderer and this package use the same classes.
`@esotericsoftware/spine-core` 4.3.13 is a root development dependency for the types and the tests. It is under the Spine Runtimes License, not MIT.
The spine-core API path that the tests use: `SkeletonJson` with a custom `AttachmentLoader`, `Skin.setAttachment`, `Skeleton.setSkin`,
`SlotPose.setAttachment`, `RegionAttachment` + `Sequence` + `TextureAtlasRegion`, `TextureAtlasPage.setTexture`, `TextureAtlas.dispose`.
`Skeleton.setSkin` alone is not enough for a change of parts: `Skin.attachAll` keeps the old attachment when the new skin has none for a slot.
`applySkin` sets each changed slot explicitly.

## Command line

```sh
npm run build --workspace @aigg/rig-runtime
node packages/rig-runtime/dist/src/cli.js --help
node packages/rig-runtime/dist/src/cli.js manifest <dir> <out.sha256> [--dry-run] [--overwrite]
node packages/rig-runtime/dist/src/cli.js verify <dir> <manifest.sha256> [--strict]
node packages/rig-runtime/dist/src/cli.js hash-invariance <before-dir-or-manifest> <after-dir>
```

Each command writes one JSON report to stdout. Exit status: 0 PASS, 1 FAIL, 2 usage or input error.

## Tests

```sh
npm test --workspace @aigg/rig-runtime
```

The tests use byte-exact text files of the owner L1 export in `test/fixtures/l1-owner/` (skeleton JSON, atlases) and synthetic files in temporary folders.
Page images are not in the repository. Pixel tests run in the gate test bench outside the repository (see the evidence document).

## Limits

- Rigid region attachments only. Mesh, path, clipping, bounding box and point attachments are rejected (profile check).
- One page image per atlas was tested. Several pages per atlas are supported by the code, but not tested with a real export.
- The group table `humanoidGirlV1Groups` and the module manifest are drafts for the test rig `humanoid_girl_v1`.
- Run-time JSON checks are TypeScript code. The JSON Schema in `schemas/` documents the module format; a test keeps the two in agreement.
- Compatibility rules check equal tag values only. They do not prove that parts of two characters look good together (seams are an art issue).
- The atlas cache measures owners and unloads. GPU memory was measured only with software WebGL (SwiftShader), not on a real GPU.
