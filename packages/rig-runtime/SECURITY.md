# Security notes: @aigg/rig-runtime

**Draft.** Trust assumptions, controls and residual risks of this package.

## Inputs

| Input                                       | Trust     | Controls                                                                                                                |
| ------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| Skeleton JSON, atlas text, `character.json` | Untrusted | Parsed as data. Profile, structure and cross checks with stable error codes. Text in messages is cut and escaped.       |
| Part module manifests                       | Untrusted | `parseModule` checks fields, safe relative paths, hashes, group membership and compatibility before any load.           |
| Asset folders (CLI)                         | Untrusted | Symbolic links and special files stop the walk (`E_SYMLINK`, `E_SPECIAL_FILE`). Manifest paths cannot leave the folder. |
| Page images                                 | Untrusted | The package does not decode images. The caller's loader must check the page SHA-256 before decoding.                    |

## Writes

The CLI writes one file: the manifest of `manifest`. It refuses a path inside the described folder, refuses to replace an existing file
without `--overwrite`, and `--dry-run` writes nothing. Other commands only read. The library writes no files.

## External effects

No network access, no subprocess, no shell, no environment variables. The browser loader of the test bench fetches only from its own local server.

## Residual risks

- Manifest hashing reads each file into memory. There is no file size limit. Use it on export folders, not on arbitrary large trees.
- Module atlases and page images are as safe as the loader that the caller gives. The test bench loader checks SHA-256 before it decodes.
- spine-core parses the atlas and skeleton text. A defect in spine-core is outside the control of this package.
- Unloaded textures are released through `TextureAtlas.dispose`. Release of GPU memory was measured with software WebGL only.
