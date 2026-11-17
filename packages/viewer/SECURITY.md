# @aigg/viewer security notes

**Draft.** Scope: the `aigg-viewer` command, its local HTTP server, and the viewer page.

## Inputs and trust

| Input                           | Trust                                                            | Controls                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Export folder path (argument)   | The local user.                                                  | Resolved with `realpath`. Only the folder entries are listed; no recursion.                                                                                                                                                                                                                           |
| Skeleton JSON, atlas, PNG pages | Spine output on the owner's computer. Treated as untrusted data. | Plain file names only (no folder parts, no leading dot). Each file is opened first with `O_NOFOLLOW` and `O_NONBLOCK`; all checks (regular file, size limit) use the open descriptor, so no link or other file can take its place between check and read. PNG size from the header, without decoding. |
| HTTP requests                   | Any local process or web page in the user's browser.             | See [Server](#server).                                                                                                                                                                                                                                                                                |

## Server

- Listens on `127.0.0.1` only. The address is fixed in the code.
- Answers only `GET` and `HEAD`. Other methods get 405.
- Accepts only the Host header `127.0.0.1:<port>` or `localhost:<port>`. Other hosts get 421. This blocks DNS rebinding from a remote web page.
- A request path is a key in a fixed table, made at start from the built page and the checked export files. It is never joined to a file path, so a request cannot read another file. Percent-encoded and parent paths get 404.
- The file bytes are read once at start. A later change of the folder has no effect until a restart.
- Headers on each answer: a strict Content Security Policy (scripts only from the server, no frames, no forms, no `base`), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, and `X-Frame-Options: DENY`.
- Inline styles are allowed (`style-src 'unsafe-inline'`), because the web component sets styles at run time. Inline scripts are not allowed.
- Request and header timeouts limit slow clients.

## Writes and external effects

- The command writes nothing to disk. It prints one JSON report to stdout and messages to stderr.
- No network access other than the local server. The page loads no external URL. The Spine runtime is bundled into the page at build time.
- No subprocess.

## Licensed test assets

The Akane test export contains licensed test art. The viewer reads it from the owner's folder and serves it only on `127.0.0.1`. Do not commit the export, screenshots, or the smoke test output.

## Residual risks

- Any local process of the same user can read the served files while the server runs. The files are the user's own export.
- The Spine runtime parses the JSON, the atlas, and the images in the browser. A malformed file can stop the page. It cannot reach other files through the server.
- The browser decodes the PNG pages. Size limits apply before the files are served, but the image decoder of the browser is outside this package.
- The build uses the exact versions in the root lockfile. A future update of the Spine runtime needs a new dependency review.
