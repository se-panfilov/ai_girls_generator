---
name: asset-factory
description: Develop and audit the character asset pipeline. Use for pipeline packages, contract and schema changes, character package checks, and security reviews in this repository.
---

# Develop and audit the asset pipeline

Read [AGENTS.md](../../../AGENTS.md) before using this workflow.
That file contains the project requirements and authorization limits.
This skill does not grant permission to download models, call paid services, publish, push, or change approved assets.

## Establish the change

1. Read the affected package source, README, and root and workspace package scripts.
2. Read [the architecture](../../../docs/ARCHITECTURE.md) and identify the affected pipeline stage.
3. Read [the rig contract](../../../docs/RIG_CONTRACT.md) and [the package format](../../../docs/CHARACTER_PACKAGE.md) when the change reads or writes contract or package data.
4. Identify inputs, outputs, writes, subprocesses, models, and network effects.
5. Check [the decision log](../../../docs/DECISIONS.md). Do not implement an open decision as if it were accepted.
6. Resolve material ambiguities before dependent work. Continue independent authorized work.
7. Select checks that can show both the result and the relevant safety properties.

For a new package, use [the new-package workflow](../new-package/SKILL.md).
Use the root lockfile and shared development tools. Do not add per-package lockfiles.
Keep common settings in `configs/` and package wrappers limited to paths, aliases, and entry points.

## Keep the contract fixed

The shared skeleton, slots, draw order, pivots, and animations belong to the rig contract.
A character package supplies only images and sidecar data for that contract.

- Do not change the contract to make one character pass validation. Fix the package or report the defect.
- A contract change needs a human decision and a new contract version.
- Read bone, slot, and animation data from the contract or the Spine export. Do not copy them into package code.
- Keep the canonical data as PNG parts and the JSON sidecar. Treat PSD, ORA, and atlas files as derived output.
- Keep the side names from the contract. Do not mix `near`/`far` and `l`/`r` in one data set.

## Implement in stages

Separate input validation, plan construction, writes, and result checks.
Keep reusable logic independent of terminal prompts and of a specific AI service.
Put external tools behind a narrow adapter: ComfyUI, See-through, Spine CLI, and image editors.

After each stage, examine its security and determinism impact before you continue.
Check the applicable boundaries:

| Boundary      | Questions to resolve                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Input         | Can a malformed prompt, JSON file, or image select another target or become executable text?          |
| Image decode  | Are dimensions, pixel count, and file size limited before decoding? Are color space and alpha explicit? |
| Contract      | Does the change keep one skeleton and one animation set for all characters?                            |
| Subprocess    | Can inherited environment, config, or shell parsing change a Python tool or Spine CLI call?           |
| File system   | Can links, existing paths, or concurrent runs overwrite an approved package?                           |
| Models        | Is each model file in the license registry with an approved status and a recorded SHA-256 value?      |
| Network       | Is the destination authorized? Does the call cost money? What happens after a partial success?        |
| Provenance    | Can another person repeat the run from the recorded parameters and hashes?                             |
| Content       | Do the prompts and checks keep characters explicitly adult and inside the content rules?              |
| Recovery      | Can failure leave a partial package? Can the user restore the previous state?                         |

For inapplicable boundaries, record why they do not apply instead of adding unnecessary mechanisms.

## Review the completed change

Perform a separate security pass after implementation.
Read the final code and diff, including errors and cleanup paths.
Trace input through validation to each write, subprocess call, and network call.
Try relevant malformed inputs and failure cases in isolated fixtures with synthetic images.
Check that the dry-run plan, the validation report, and the final result agree.
Compare output hashes of deterministic stages between two runs.

Fix confirmed defects within the task scope.
Add meaningful regression checks for confirmed defects.
Repeat affected checks after each fix.
Report unresolved findings with impact, conditions, evidence, and a recommended action.
A human makes the final decision on each security finding that is not fixed. Do not accept or postpone a risk yourself.

For a documentation-only change, examine instruction accuracy and unsafe example commands.
Check references, open decisions, and authorization boundaries.

## Generation and external services

Do not start generation, decomposition, or GPU work unless the task explicitly requests that run.
Use only endpoints that the user specifies. Do not discover or guess service addresses.
Do not download model weights, custom nodes, or tools without an explicit request for each item.
Do not call a paid API or rent a GPU without explicit authorization that names the service and the limit.
Record the model hash, seed, workflow file, and tool version for each generated result.
Keep generated images out of Git unless [the decision log](../../../docs/DECISIONS.md) defines the storage.

## Deliver

Bump the version of each changed package once per iteration. Use `npm version` from the root with `--workspace <name> --no-git-tag-version --ignore-scripts`.
Run Prettier on changed maintained files with the existing configuration.
Run the root format check, ESLint, type check, and the affected workspace tests. Fix errors before completion.
Keep generated output and vendored skills outside formatting changes.
Update the package README and the affected docs when behavior or data formats change.
Report the result, executed checks, fixed defects, and remaining limits in English.
Never merge the pull request. A human reviews and merges it.
Do not present static review as a test on real hardware or a formal security certificate.
