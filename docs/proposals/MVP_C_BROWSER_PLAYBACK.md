# MVP-C: browser playback of the full-body test character

**Validation harness.** This report describes MVP-C of the MVP vertical slice (decision D33, [the roadmap](../ROADMAP.md#near-term-priority-mvp-vertical-slice)).
The viewer is not a game runtime and not a production user interface. It closes no decision. It does not close D1 (animation runtime).

## Status

| Item                   | Result                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Viewer implementation  | PASS: package `@aigg/viewer` 0.1.0, command `aigg-viewer`, one documented start command.                                        |
| Runtime initialization | PASS (agent, headless Chromium with software WebGL): `spine-webcomponents` 4.3.13 loads the skeleton, the atlas, and the pages. |
| Real MVP-B export      | NOT TESTED by the agent. The export is on the owner's computer. Owner command below.                                            |
| Animation playback     | PASS (agent, synthetic export and MVP-A test atlas): `idle` plays in a loop, `wave` and `idle` switch on the same skeleton.     |
| Visual check           | PASS (agent, MVP-A test atlas, three screenshots). On the real MVP-B export: NOT TESTED.                                        |
| Overall                | `WAITING_FOR_OWNER_VALIDATION`                                                                                                  |

## Path under test

`Spine export (JSON + atlas + PNG) → aigg-viewer (checks, 127.0.0.1) → spine-webcomponents 4.3.13 → animated character`

The page does not animate anything itself and does not use the MVP-A preview images. The runtime reads the bones, slots, attachments, and animation keys from the exported JSON.

## Implementation

- `aigg-viewer <export-folder>` reads one skeleton JSON, one text atlas, and the PNG pages that the atlas names. It checks names, links, sizes, the Spine version (4.3), the animations `idle` and `wave`, and that each region attachment has an atlas region. See the [package README](../../packages/viewer/README.md#checks).
- The local server listens on `127.0.0.1` only and answers a fixed table of paths. The export folder is not changed. See the [security notes](../../packages/viewer/SECURITY.md).
- The page uses relative URLs (`viewer.json`, `export/<file>`). It has the buttons `Idle`, `Wave`, `Pause`/`Resume`, and `Restart`, a status line, and the name of the current animation.
- An animation change calls `AnimationState.setAnimation` on track 0 of the same skeleton with a 0.2 s mix. The view fits the bounds of all frames of both animations.
- Load errors show `Error: …` in the status line. On `pagehide` the page calls the runtime `dispose()`.

### Dependency

`@esotericsoftware/spine-webcomponents` 4.3.13 is an exact root development dependency (with `spine-webgl` 4.3.13; `spine-core` 4.3.13 was already a root development dependency). Vite bundles it into the built page.

- Version: the same 4.3 generation as the Spine 4.3.26 editor export, and the same version that the L1 v5 evidence used.
- License: Spine Runtimes License. Each user needs a Spine Editor license. The owner has Spine Essential. The built page keeps the license notices.
- Install scripts: none. Packages from `registry.npmjs.org` with `sha512` integrity.
- The package type declarations do not pass `exactOptionalPropertyTypes`, so the page loads the runtime from a JavaScript module and uses small local types.

### License review

`@esotericsoftware/spine-webcomponents` 4.3.13 and `@esotericsoftware/spine-webgl` 4.3.13 declare `LicenseRef-LICENSE`: the Spine Runtimes License Agreement (Esoteric Software LLC). It permits integration of the runtimes when each user of the product has a Spine Editor license, and a redistribution must include the license and copyright notice.

- The owner has a Spine Essential license. The viewer is a local validation harness for the owner and is not redistributed. The built page (`dist/`, not in Git) keeps the license notices.
- The packages are root development dependencies, the same as `spine-core` 4.3.13 before this change. No package of the repository declares them as a runtime dependency, and `runtimeDependencyAllowlist` is not changed.
- A product that ships the runtime to other users needs a new license review and an owner decision (D1).

### Dependency audit

The `pr-rules` job runs `npm audit --package-lock-only --audit-level=high` when the lockfile changes. This PR changes the lockfile, because it adds the two Spine packages.

| Lockfile                 | Result                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Base (`master` 5b2cba0)  | 15 (9 moderate, 6 high). The same 15 packages.                                                                        |
| PR #39                   | 15 (9 moderate, 6 high). The two Spine packages have no advisory.                                                     |
| Base + minor tool update | 11 high, 0 moderate (simulation: `eslint` 10.15.0, `typescript-eslint` 8.73.0, `ajv` 8.20.0). The high findings stay. |

All high findings come from one advisory: `picomatch` ReDoS GHSA-fc5q-39xc-vjpf (`<=4.0.7`). `picomatch` 4.0.7 is the latest release, so no patched version exists. `vite`, `vitest`, `tinyglobby`, `fdir`, and `typescript-eslint` are listed because they depend on it. npm offers only a major downgrade of `vite` and `vitest`.
These are development tools. They read glob patterns from the repository configuration, not from character data. To accept the finding, to wait for a patch, or to change the audit rule is an owner decision. This PR does not change the audit rule. **Owner decision:** the owner accepted this existing `picomatch` finding for PR #39. The `pr-rules` audit step stays red for this PR. Follow-up: update when a patched `picomatch` release exists.

### Temporary exception: no `@aigg/rig-runtime`

The viewer loads the export directly through the official runtime. The MVP-B export is a normal editor export with the attachments in the skeleton JSON. The `rig-runtime` functions (shared rig templates, skin from `character.json`, atlas cache, part modules) are for the shared rig flow and add nothing to the playback of one export.
Use of another workspace package needs a declared runtime dependency, which needs an owner approval (`runtimeDependencyAllowlist`). No such change was made.
This exception is for MVP-C only. It does not change `@aigg/rig-runtime`, the rig contract, or the production runtime plan.

## Agent tests

Environment: Linux x64 container, Node.js 22.23.4 (local; CI uses Node.js 26), Chromium 153.0.8010.12 headless, Playwright 1.63, software WebGL (SwiftShader). No GPU.

| Test                             | Data                                                               | Result                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit and command tests (25)      | Synthetic export in temporary folders                              | PASS: export checks and error codes, request rules (Host, methods, unknown paths), headers, page configuration, `--check`, serve and SIGTERM.   |
| Browser smoke test (opt-in)      | Synthetic export (body and one arm)                                | PASS: ready, track time advances, bone rotation changes, wave on the same skeleton, pause and resume, back to idle, dispose, no console errors. |
| Browser error test (opt-in)      | Synthetic export without the atlas, a page image, or `viewer.json` | PASS: the status line shows `Error: …` with `role="alert"` in each case.                                                                        |
| Browser test with Akane (opt-in) | MVP-A package with an agent-made test atlas (see below)            | PASS: 28 bones, 27 slots, 2 animations; three screenshots are different; the character is inside the view in each; no console errors.           |

The MVP-A test atlas: the agent copied the MVP-A skeleton JSON and the 19 region images into a temporary folder and wrote an atlas with one page for each image. This is not the Spine export: the packing, the atlas, and possible curve normalizations of MVP-B are different. It shows that the runtime path and the Akane images work. It does not replace the owner check of the real export.

Screenshots (900 × 1000 px view, local only, not in Git):

| Screenshot              | Animation, time | Character pixels | Bounding box (left, top, right, bottom) |
| ----------------------- | --------------- | ---------------- | --------------------------------------- |
| `1-idle.png`            | `idle`, 0.50 s  | 155,273          | 87, 76, 852, 890                        |
| `2-wave-arm-raised.png` | `wave`, 0.62 s  | 156,531          | 89, 67, 849, 890                        |
| `3-wave-later.png`      | `wave`, 1.00 s  | 156,583          | 93, 41, 849, 890                        |

The full character is visible in all three, with the head, the shoes, the raised near arm, and the sword.

## Owner validation

On the owner's Mac, from the repository root, with the export from MVP-B:

```sh
npm ci --ignore-scripts
npm start --workspace @aigg/viewer -- ~/aigg/mvp-a-cli/body/export
```

Open `http://127.0.0.1:5180/` and check: the status is `Ready`, Akane is fully visible, `idle` moves, `Wave` raises the near arm, `Idle` returns, `Pause` stops the motion.
If Playwright is installed, the smoke test can also take the screenshots: see the [package README](../../packages/viewer/README.md#tests).

## Known limitations

- The real MVP-B export was not played by the agent.
- Software WebGL only. Safari, other browsers, and real GPUs were not tested by the agent.
- Art defects of MVP-A stay (joint seams, far arm order, static hair and skirt). They are not MVP-C blockers.
- One skeleton and one atlas for each run; no `.skel` binary files.

## Not in scope

Joint quality, meshes, physics, the Equipment System, many characters, a game runtime, and MVP-D orchestration.
