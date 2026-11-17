# @aigg/viewer

**Draft. Validation harness (MVP-C).** A local page that plays a Spine 4.3 export of one character in the official Spine web runtime.
It is not a game, not a game runtime, and not a production user interface. It does not close decision D1 (animation runtime).
Pipeline stage: S11 (preview). Report: [MVP-C browser playback](../../docs/proposals/MVP_C_BROWSER_PLAYBACK.md).

## What it does

1. `aigg-viewer <export-folder>` reads the Spine export once: one skeleton JSON, one text atlas, and the PNG pages that the atlas names.
2. It checks the files (see [Checks](#checks)) and keeps their bytes in memory. It does not change the folder.
3. It starts a local HTTP server on `127.0.0.1` and writes one JSON report with the URL to stdout.
4. The page loads the export through `spine-webcomponents` 4.3.13 with relative URLs (`export/<file>`), plays `idle` in a loop, and has the buttons `Idle`, `Wave`, `Pause`/`Resume`, and `Restart`.

The page does not animate anything itself. The runtime reads the bones, slots, attachments, and animation keys from the exported JSON.
A button changes the animation on track 0 of the same skeleton with a 0.2 s mix (`AnimationStateData.defaultMix`). No new skeleton is made.
The view fits the bounds of all frames of `idle` and `wave` (`animation-bounds`), so the head, the shoes, the raised arm, and the sword stay visible. The page size follows the browser window.
The status line shows `Loading…`, `Ready: …`, or `Error: …` (with `role="alert"`). On `pagehide` the page calls the runtime `dispose()`, which frees the textures and removes the element.

## Commands

Run from the repository root. Use an absolute path for the export folder.

```sh
npm ci --ignore-scripts
npm start --workspace @aigg/viewer -- ~/aigg/mvp-a-cli/body/export
```

`npm start` builds the package first. Then open the printed address (default `http://127.0.0.1:5180/`). Stop the server with Ctrl+C.

```sh
node packages/viewer/dist/src/cli.js --help
node packages/viewer/dist/src/cli.js <export-folder> [--port <n>] [--skeleton <name>] [--atlas <name>] [--check]
```

| Option              | Effect                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------- |
| `--port <n>`        | Local port. Default `5180`. `0` selects a free port.                                    |
| `--skeleton <name>` | The skeleton JSON file name, when the folder has more than one `.json` file.            |
| `--atlas <name>`    | The atlas file name, when the folder has more than one `.atlas` or `.atlas.txt` file.   |
| `--check`           | Check the folder, write the JSON report (`aigg.mvp-c.viewer/0.1`), and stop. No server. |

Exit status: 0 success, 1 the export is not usable (the report has `status: "FAIL"` and an error code), 2 usage error.

## Checks

| Code                                           | Meaning                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `E_FOLDER_MISSING`                             | The folder does not exist or is not a folder.                                                         |
| `E_FILE_MISSING`                               | No skeleton JSON, no atlas, or a page image that the atlas names is missing.                          |
| `E_AMBIGUOUS`                                  | More than one skeleton JSON or atlas. Select one with `--skeleton` or `--atlas`.                      |
| `E_FILE_NAME`                                  | A name with folder parts, spaces, or a leading dot. Plain names only: letters, digits, `.`, `_`, `-`. |
| `E_FILE_LINK`, `E_FILE_TYPE`, `E_FILE_CHANGED` | A symbolic link, not a regular file, or a file that changed while it was read.                        |
| `E_FILE_SIZE`, `E_FOLDER_SIZE`                 | Above the size limits (`limits` in `src/exportbundle.ts`).                                            |
| `E_SKELETON_JSON`                              | Not a Spine skeleton JSON file.                                                                       |
| `E_SPINE_VERSION`                              | The export is not from Spine 4.3. The runtime generations must be the same.                           |
| `E_ANIMATION_MISSING`                          | No `idle` or no `wave` animation.                                                                     |
| `E_ATLAS_FORMAT`, `E_REGION_MISSING`           | The atlas cannot be read, or a region or mesh attachment has no atlas region.                         |
| `E_PAGE_TYPE`, `E_PAGE_PNG`, `E_PAGE_SIZE`     | A page is not a PNG file, or its size is above 16384 px or differs from the atlas.                    |
| `E_PAGE_BUILD`                                 | The page is not built. Run `npm run build --workspace @aigg/viewer`.                                  |
| `E_PORT`                                       | The port is in use or the server did not start.                                                       |

The page also shows an error when a file does not load (for example, a page image is missing), when `viewer.json` is not valid, or when the runtime does not finish loading in 60 s.

## Spine runtime

The page bundles `@esotericsoftware/spine-webcomponents` 4.3.13 (with `spine-webgl` and `spine-core` 4.3.13). It is an exact root development dependency, because Vite puts it into the built page (`dist/page/`). The Node.js command has no runtime dependency.
The Spine runtimes are under the Spine Runtimes License, not MIT. Each user needs their own Spine Editor license. The built page keeps the license notices.
`src/page/runtime.js` loads the runtime. It is a JavaScript file, because the package type declarations do not pass the strict TypeScript options of the repository (`exactOptionalPropertyTypes`). `main.ts` has small local types for the objects that it uses.

## Temporary exception: `@aigg/rig-runtime` is not used

The viewer loads the Spine export directly through the official runtime. It does not use `@aigg/rig-runtime`. Reasons:

- The MVP-B export is a normal editor export: the attachments are in the skeleton JSON. The `rig-runtime` path (shared rig templates, a skin from `character.json`, atlas cache, part modules) is for the shared rig and is not needed to play one export.
- A package can use another workspace package only as a declared dependency. Runtime dependencies need an owner approval in `runtimeDependencyAllowlist` (`scripts/ci/config.mjs`).

This is a documented MVP exception. It does not change `@aigg/rig-runtime`, the rig contract, or decision D1.

## Tests

```sh
npm test --workspace @aigg/viewer
```

The tests use a synthetic export (a body and one arm) in temporary folders. They check the export rules, the request rules of the server, the page configuration, and the command.
The browser smoke test is opt-in. It needs Playwright with Chromium in the environment (not a repository dependency) and uses software WebGL (SwiftShader):

```sh
cd packages/viewer
AIGG_BROWSER_SMOKE=1 npx vitest run test/browser.test.ts
AIGG_BROWSER_SMOKE=1 AIGG_VIEWER_EXPORT=<export-folder> AIGG_VIEWER_OUT=<new-folder> npx vitest run test/browser.test.ts
```

The second form also plays a real export and writes `1-idle.png`, `2-wave-arm-raised.png`, `3-wave-later.png`, and `summary.json` to `AIGG_VIEWER_OUT`.
Keep that folder outside the repository: the screenshots show licensed test art.

## Limits

- One skeleton and one atlas for each run. Binary `.skel` files are not supported.
- Only plain file names. Page images must be PNG files in the same folder as the atlas.
- The page was tested in headless Chromium with software WebGL. Safari and real GPUs were not tested by the agent.
- The view is for checks only: no zoom, no drag, no frame stepping.
