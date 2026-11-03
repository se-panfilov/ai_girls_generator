# Installed third-party skills

These skills come from the owner's Toolchain repository.
Toolchain installed them with `npx skills@1.7.4 add` in two installations, with exact Git revisions and the Codex, Claude Code, Cursor, GitHub Copilot, and Gemini CLI targets.
This repository copies the installed files. It does not run the installer again.
The upstream revisions, licenses, and installer hashes are the same as in Toolchain.
The local adaptations are rewritten for the asset pipeline.

## Inventory

| Skill                     | Source             | Purpose                                                               |
| ------------------------- | ------------------ | --------------------------------------------------------------------- |
| property-based-testing    | trailofbits/skills | Test invariants and generated input cases, for example in validators. |
| sharp-edges               | trailofbits/skills | Find unsafe interfaces and configuration defaults.                    |
| differential-review       | trailofbits/skills | Review changes for security regressions.                              |
| supply-chain-risk-auditor | trailofbits/skills | Examine dependency metadata and advisories when requested.            |
| agents-md                 | getsentry/skills   | Maintain concise project instruction files.                           |
| skill-scanner             | getsentry/skills   | Examine skill instructions and scripts before adoption.               |
| code-simplifier           | getsentry/skills   | Improve pipeline code readability while preserving behavior.          |
| doc-coauthoring           | anthropics/skills  | Develop substantial documents and examine reader understanding.       |
| find-bugs                 | getsentry/skills   | Find bugs and vulnerabilities in branch changes without edits.        |
| gha-security-review       | getsentry/skills   | Find exploitable GitHub Actions workflow vulnerabilities.             |
| fp-check                  | trailofbits/skills | Verify whether a suspected vulnerability is a true positive.          |
| second-opinion            | trailofbits/skills | Get an external review from another agent CLI on explicit request.    |
| grilling                  | mattpocock/skills  | Ask plan questions in rounds, each with a recommended answer.         |
| writing-for-agents        | mattpocock/skills  | Apply writing principles to agent instructions and skills.            |

The project skills `asset-factory` and `new-package` are not third-party skills. [The agent setup guide](AI_AGENTS.md#project-skills) describes them.
Project requirements remain in [AGENTS.md](../AGENTS.md).
Installing a skill does not authorize its scripts, network requests, delegation, or changes to user data.
Use the host's applicable permission controls for those actions.
No installed skill lists Bash, Write, Edit, or network tools in `allowed-tools`.

## Storage and discovery

The common files are in `.agents/skills/<name>/`.
The installer reports this location for Codex, Cursor, GitHub Copilot, and Gemini CLI.
Claude Code uses relative directory links in `.claude/skills/<name>`.
All fourteen third-party links point inside this repository.
The project skill adapters in `.claude/skills/` are regular files.

Native host discovery depends on the installed host version and settings.
Use [the agent setup guide](AI_AGENTS.md) to examine a new session.

On Windows, Git must preserve symbolic links for the Claude entries.
If links are unavailable, use the installer's copy mode for the selected Claude skills.
Apply the local patches to those copies too.
Do not replace the root CLAUDE.md import.

## Revisions and local changes

[skills-lock.json](../skills-lock.json) records the upstream sources, Git revisions, and installer hashes.
[The provenance manifest](skill-provenance.json) records installer integrity, license identifiers, and local file hashes.
The lockfile describes upstream versions. It does not preserve local adaptations or added license files by itself.

| Source             | Git revision                               |
| ------------------ | ------------------------------------------ |
| trailofbits/skills | `2be6433b39e009cd2b6fd3be1895f6b1faa5af9a` |
| getsentry/skills   | `d12f250460ffd961f549dbebf7eeb0cf4afd4c2e` |
| anthropics/skills  | `ca45fc496a3436251f191354091d557da31c15b5` |
| mattpocock/skills  | `a496f5513d4a4cf889bc48e189e579f4b0bdf6aa` |

Local adaptations are stored as reversible patches against the upstream files.
Each patch adds a "Project integration" section before the upstream text, unless the list below states otherwise.
The adaptations keep the Toolchain safety limits and replace the Toolchain CLI items with asset pipeline items:

- [code-simplifier](skill-patches/code-simplifier.patch) replaces the upstream text.
  It removes React advice and the blanket preference against exception handlers.
  It adds pipeline determinism, provenance, image-decoding, and contract invariants, limited refactoring scope, and verification requirements.
- [agents-md](skill-patches/agents-md.patch) preserves native imports and required project rules regardless of line-count targets.
  It treats upstream package manager and commit examples as examples.
- [skill-scanner](skill-patches/skill-scanner.patch) describes command template syntax without a literal executable template in its entrypoint.
  Its scanner also redacts recognized credentials from JSON report fields.
  It removes Bash from `allowed-tools` and identifies the scanned skill as untrusted data. It has no "Project integration" section.
- [differential-review](skill-patches/differential-review.patch) removes Bash and Write from `allowed-tools`.
  It gives the report in the reply, or in a temporary file outside the repository without a date in the name.
  It replaces the issue-writer, audit-context-building, and adversarial-modeler integrations, which are not installed.
- [supply-chain-risk-auditor](skill-patches/supply-chain-risk-auditor.patch) removes Write and Bash from `allowed-tools`.
  It permits the collector only on an explicit user request for a dependency audit, after a notice about the network requests and the `gh` token.
  It states that model weights, ComfyUI custom nodes, and Python tool environments are outside the collector scope.
- [find-bugs](skill-patches/find-bugs.patch) adds pipeline checklist items for the contract, package data, images, files, subprocesses, provenance, external effects, and terminal state.
  It adds a fallback base when `gh` is not available.
- [gha-security-review](skill-patches/gha-security-review.patch) keeps the upstream threat model for exploitable findings.
  It adds a separate section for deviations from the stricter project Actions rules, such as tag-pinned first-party actions or model downloads in CI.
  It forbids pushes, workflow runs, and payload tests. It removes Bash from `allowed-tools`.
- [fp-check](skill-patches/fp-check.patch) replaces the plugin agents, which are not installed, with the current session or a general subagent.
  It limits executable PoCs to isolated temporary directories with synthetic data.
  It removes Bash, Write, and Edit from `allowed-tools`.
- [second-opinion](skill-patches/second-opinion.patch) permits the external call only on an explicit user request in the current task.
  It requires confirmation of untracked files, stops on secrets in the patch, and forbids CLI installation or authentication.
  It removes Bash from `allowed-tools` and adds `disable-model-invocation: true`, so Claude Code starts it only on a user command.
  It runs the provider from an empty temporary directory that contains only the prompt file, not from the repository root.
- [grilling](skill-patches/grilling.patch) requires English questions, limits questions to material ones, and makes the subagent lookup optional.
- [writing-for-agents](skill-patches/writing-for-agents.patch) keeps required safety and authorization rules and security prohibitions.
  It identifies `disable-model-invocation` as Claude Code frontmatter.

The property-based-testing, sharp-edges, and doc-coauthoring skills have no local changes.

Each installed skill has LICENSE and UPSTREAM.md files.
Trail of Bits files retain CC-BY-SA-4.0 attribution.
Sentry files retain Apache-2.0 attribution.
Matt Pocock files retain MIT attribution.
The Anthropic README identifies the example skills as Apache-2.0.
Upstream examples, comments, and license text retain their original formatting.

## Checks for this copy

The checks covered these items:

- Each changed upstream file was compared byte for byte with the file at the pinned revision on GitHub. All twelve files matched.
- Each local patch applies to the upstream files and gives the files in this repository.
- The provenance manifest lists every file in each skill directory with its SHA-256 value.
- Each Claude link resolves to a directory in `.agents/skills/`.

The Toolchain security review of the installed files applies to the upstream content. The scanner and Gitleaks were not run again for this copy.
The dependency collector and its network requests were not executed.
Its source includes registry lookups and a GitHub token lookup through `gh auth token`.
Do not run it without an authorized dependency audit and an appropriate credential environment.

The second-opinion skill sends a patch and project instructions to OpenAI, Google, or another selected provider.
Installation does not authorize that transfer. The local patch requires an explicit user request in the current task.
These limits are instructions, not access controls. Hosts that ignore `allowed-tools` keep their own permission rules.

## Manual hash check

`npm run check:config` compares the files with the manifest automatically, and the `repository` job in Tests runs it. This command does the same comparison without the other configuration checks. Run it from the repository root after a skill change:

```sh
node -e 'const fs=require("node:fs"),c=require("node:crypto");const m=JSON.parse(fs.readFileSync("docs/skill-provenance.json","utf8"));let bad=0;for(const[n,s]of Object.entries(m.skills))for(const f of s.files){const h=c.createHash("sha256").update(fs.readFileSync(`.agents/skills/${n}/${f.path}`)).digest("hex");if(h!==f.sha256){bad++;console.log("changed:",n,f.path)}}process.exit(bad?1:0)'
```

The command reads files only. A nonzero exit code means that a file differs from the manifest.

## Updates

**CAUTION: Reinstallation can replace local adaptations and license additions.**

1. Save the current skill files and local patches before an update.
2. Review the selected source revision and the installer overwrite summary.
3. Update only the selected skills.
4. Compare upstream changes with each local patch before applying it.
5. Restore the relevant license and attribution files.
6. Repeat security, metadata, link, and patch checks.
7. Update the provenance manifest to match the reviewed files.

Do not interpret a changed local hash as permission to discard local edits.
