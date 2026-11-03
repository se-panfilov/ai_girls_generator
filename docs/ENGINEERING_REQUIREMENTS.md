# Engineering requirements

**Draft.** This document holds the rules for languages, command-line tools, runtime, portability, security, and build.
Tools check part of these rules. See [Enforced rules](ENFORCED_RULES.md).
It does not define asset formats. The [rig contract](RIG_CONTRACT.md) and the [package format](CHARACTER_PACKAGE.md) define them.
The owner set the rules in sections 1–3. See [the known owner requirements](DECISIONS.md#known-owner-requirements).

## Scope of the documents

Keep each rule in one of three documents. Do not copy a rule into another document.

| Document                                     | Contents                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| Rig Interchange Contract (`RIG_CONTRACT.md`) | Bones, slots, attachments, coordinates, atlases, package formats, compatibility |
| Engineering requirements (this document)     | Languages, command-line tools, runtime, portability, security, build            |
| AI factory workflow (`ARCHITECTURE.md`)      | Models, generation, layer decomposition, human approval, cost                   |

## 1. Language and runtime

1. Write new custom code of the factory in TypeScript. Run it in Node.js.
   This rule applies to command-line tools, hashing, manifests, archives, file operations, validation, asset build, orchestration, and calls to external tools.
2. Use the Node.js version in [`.nvmrc`](../.nvmrc) as the target version. Do not lower the target version to the version of an earlier test run.
3. Declare the supported Node.js range in the `engines` field of each package. Record each tested version in the compatibility matrix of the package.
4. Use the standard Node.js modules first: `node:fs`, `node:path`, `node:crypto`, `node:child_process`, `node:process`.
5. Add an npm dependency only with a reason. Pin its exact version. Keep the lockfile in Git.
6. Run TypeScript with a pinned local tool (for example `tsx`) or compile it to JavaScript. Do not require a global transpiler.
7. Do not rewrite existing JavaScript (`.mjs`) only to change the file extension. It already runs in Node.js.

## 2. Shell, Python, and other runtimes

1. Use shell scripts only as thin wrappers: bootstrap, Python virtual environment, start of an external program, or one operating-system-specific step.
2. Do not put business logic or file processing in a new shell script.
3. Run external AI tools that need Python (for example See-through or model inference) as isolated processes or services. Control them from Node.js. Do not port them to TypeScript.
4. For each new dependency on Bash, Python, or another runtime, record three items: the reason, the alternatives, and the effect on the supported operating systems.
   Convenience for the author is not a reason.

## 3. Portability

1. Supported operating systems for the current gates: macOS and Linux. Windows is not tested. Do not claim Windows support.
2. Do not use GNU-only commands: for example `sha256sum`, `realpath -m`, `xargs -d`, `readlink -f`, `sed -i` without a suffix, or `stat -c`.
   Use Node.js APIs for these operations.
3. macOS has Bash 3.2 at `/bin/bash`. A remaining shell wrapper must run in Bash 3.2 or in POSIX `sh`.
4. Do not use Homebrew-only commands or other non-standard system packages unless the documentation names them as prerequisites.
5. Pass command arguments as arrays. Do not use `shell: true` to build a command from paths or arguments.
6. Test paths with spaces and non-ASCII characters where a user can choose the path, for example an unpacked archive or a kit folder.

## 4. Security and evidence

1. Do not write licenses, activation codes, tokens, cookies, or other secrets to Git, logs, evidence, or reports.
2. Do not write environment variables to logs. Remove device identifiers (serial number, hardware UUID) from machine descriptions.
3. An evidence archive has a SHA-256 manifest. The manifest does not list itself. Verify the manifest before and after packing.
4. Scan evidence text files for credentials before packing. A finding stops the packing.
5. A test runner must not report PASS when a dependency is missing or one command fails. Report such a run as FAIL or INCOMPLETE.

## 5. Package manager

npm 11 (Node.js 26 ships npm 11) runs dependency install scripts by default. npm 12 runs only the install scripts that the `allowScripts` field of `package.json` approves.
The repository `.npmrc` sets `ignore-scripts=true`, so that a plain `npm install` or `npm ci` does not run them either. Explicit `npm run` and `npm test` commands still run their own script, but not `pre` or `post` scripts.
If a dependency needs an install script, list it in `allowScripts` with a pinned version after a human review.
Use `npm ci --ignore-scripts` for the repository. A package that needs an install script needs a human review (see [Enforced rules](ENFORCED_RULES.md#pull-request-rules)).
Electron 40 and later have no install script. The `electron` package downloads its binary on the first `require('electron')`.
**Verified** in the gate test bench (outside this repository): `electron@44.10.0` installs a complete binary on Node.js 26.12.1 and 22.23.4.
`electron@38.4.0` leaves an incomplete binary on Node.js 26.12.1 (0 of 3 tries), but not on Node.js 22.23.4 (3 of 3 tries).

## Exceptions in force

| Exception                                     | Reason                                                                    | Alternative                                | Operating systems                   |
| --------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------- |
| PSD check in Python (`psd-tools`, test bench) | Existing verification tool. `psd-tools` reads PSD files written by Krita. | Port to Node.js with `ag-psd` after M1     | macOS, Linux (Python 3.12 or later) |
| `xvfb-run` for Electron tests                 | Linux without a display has no window server.                             | None. Not necessary on macOS or a desktop. | Linux only                          |
| Shell wrappers for L1/M1 kits                 | Thin wrappers. File and hash work runs in Node.js.                        | Port to TypeScript if the wrappers grow.   | macOS (Bash 3.2), Linux             |
