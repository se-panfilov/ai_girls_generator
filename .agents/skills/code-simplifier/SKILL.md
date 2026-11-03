---
name: code-simplifier
description: Simplify asset pipeline code for readability while preserving behavior, determinism, and security. Use for requested refactoring or cleanup of recently changed code.
license: Apache-2.0
metadata:
  upstream-source: getsentry/skills
  upstream-revision: d12f250460ffd961f549dbebf7eeb0cf4afd4c2e
---

<!--
Adapted for AI Girls Generator from Sentry's code-simplifier skill:
https://github.com/getsentry/skills/blob/d12f250460ffd961f549dbebf7eeb0cf4afd4c2e/skills/code-simplifier/SKILL.md
The upstream skill is based on Anthropic's code-simplifier agent:
https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-simplifier/agents/code-simplifier.md
Local changes remove React advice and blanket exception-handling preferences.
They add pipeline safety and determinism invariants, explicit scope, and verification requirements.
-->

# Simplify asset pipeline code

Read [AGENTS.md](../../../AGENTS.md) and the affected package documentation first.
Use the [asset-factory workflow](../asset-factory/SKILL.md) for the required security reviews.
This skill grants no additional permission to change assets, Git history, or external services.

## Scope

Simplify the files selected by the user or the code changed for the current task.
Do not expand a cleanup into a repository-wide refactor.
Do not modify unrelated user changes, generated build output, or character assets.

## Preserve behavior

Keep public APIs, return values, exit codes, file contents, and ordering intact.
Keep JSON key order, number formatting, and file names that tests or hashes depend on.
Keep prompts, help, errors, and confirmation defaults intact unless the task requests a text change.
Keep the compiled package compatible with the supported Node.js versions.
Preserve explicit runtime import extensions and the `dist/` build output.

Preserve these properties when present:

- Schema validation, contract cross-checks, and rejection of ambiguous states.
- Deterministic output: stable sort order, fixed seeds, explicit color space and alpha mode.
- Image size limits before decoding and explicit resampling filters.
- Provenance records: model hashes, seeds, workflow files, and tool versions.
- Subprocess argument arrays and environment isolation for Python tools and Spine CLI.
- Path checks, link checks, and overwrite protection for character packages.
- Dry-run behavior, atomic writes, and partial-failure diagnostics.
- Explicit authorization for network access, model downloads, and paid API calls.

Do not remove try/catch/finally blocks merely to reduce nesting.
Keep error propagation, cancellation, cleanup, and recovery semantics intact.
Keep comments that explain a contract rule, a security invariant, or a non-obvious tool constraint.
Write new code comments in English.

## Improve readability

Prefer explicit control flow to nested ternaries and dense expressions.
Use the terms from [the glossary](../../../docs/GLOSSARY.md) for names: bone, slot, attachment, part, package.
Remove redundant abstractions only when their removal improves understanding.
Keep validation, planning, writes, and verification distinct when this separation protects assets.
Use early returns only when they preserve cleanup and error behavior.
Do not introduce a dependency, framework, or new build step for cosmetic simplification.
Choose clarity over fewer lines or fewer tokens.

## Verify the change

1. Identify the behavior, determinism, and safety properties affected by the refactor.
2. Make the smallest useful change.
3. Read the complete diff, including failure and cleanup paths.
4. Run the relevant existing checks in isolated fixtures with synthetic images.
5. Compare output hashes before and after the change when the code writes assets.
6. Add a regression check if the change exposes a defect or missing behavioral coverage.
7. Perform the separate security review required by AGENTS.md.
8. Report the result, executed checks, and remaining limits in English.

Do not run generation, downloads, or paid services to validate a cleanup.
