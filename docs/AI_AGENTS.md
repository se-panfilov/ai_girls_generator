# Agent instruction setup

[AGENTS.md](../AGENTS.md) contains repository requirements. The [shared skill](../.agents/skills/asset-factory/SKILL.md) defines the development and security review workflow for the pipeline.
These files are instructions, not permission controls or a sandbox.
Behavior depends on the host, version, trust settings, and higher-priority instructions.

The setup is adapted from the owner's Toolchain repository. The rule structure, host adapters, and third-party skills are the same.
The project rules, the shared workflow, and the local skill adaptations are specific to the asset pipeline.

## Files and discovery

Use uppercase `AGENTS.md` and `SKILL.md`. Do not add lowercase or duplicate rule files.
The project adapters are regular text files, without symbolic-link or Windows Developer Mode requirements.
They do not run commands, install packages, change permissions, or modify global vendor settings.

| Host           | Repository integration                                                                                                                                                                         | Explicit activation and references                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex          | Reads root AGENTS.md. Discovers skills in `.agents/skills/`.                                                                                                                                   | Use `$asset-factory` when necessary. Discovery does not guarantee activation. [Instructions](https://developers.openai.com/codex/guides/agents-md), [skills](https://developers.openai.com/codex/skills). |
| Claude Code    | [CLAUDE.md](../CLAUDE.md) imports AGENTS.md, including in sessions without direct AGENTS.md support. [Skill adapter](../.claude/skills/asset-factory/SKILL.md) references the shared workflow. | Use `/asset-factory` when necessary. [Imports](https://code.claude.com/docs/en/memory), [skills](https://code.claude.com/docs/en/skills).                                                                 |
| Cursor         | Reads root AGENTS.md, which references the shared workflow. No separate Cursor rule file is necessary.                                                                                         | [Rules](https://cursor.com/docs/rules).                                                                                                                                                                   |
| GitHub Copilot | [Repository instructions](../.github/copilot-instructions.md) reference AGENTS.md and the shared workflow. Some agents also read AGENTS.md directly.                                           | Check the active chat, agent, or review feature before relying on referenced files. [Instructions](https://docs.github.com/en/copilot/customizing-copilot/adding-custom-instructions-for-github-copilot). |
| Gemini CLI     | [GEMINI.md](../GEMINI.md) imports AGENTS.md. The workflow is linked from AGENTS.md, without a separate Gemini skill adapter.                                                                   | [Context and imports](https://geminicli.com/docs/cli/gemini-md/).                                                                                                                                         |

[Installed third-party skills](INSTALLED_SKILLS.md) use the skills CLI layout and relative Claude directory links.
That guide records Windows link requirements, pinned revisions, local adaptations, and security checks.
See [WRITING.md](WRITING.md) for English documentation rules based on ASD-STE100 Issue 9.

## Project skills

| Skill                                                     | Purpose                                                                 | Claude adapter                                             |
| --------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| [asset-factory](../.agents/skills/asset-factory/SKILL.md) | Pipeline development, contract and schema changes, and security review. | [/asset-factory](../.claude/skills/asset-factory/SKILL.md) |
| [new-package](../.agents/skills/new-package/SKILL.md)     | Steps to add a workspace package to `packages/`.                        | [/new-package](../.claude/skills/new-package/SKILL.md)     |

The Claude [security-reviewer](../.claude/agents/security-reviewer.md) subagent performs the separate security review in its own context.
It has no edit tools. Its instructions forbid repository writes, Git history changes, publication, model downloads, generation, and network use.
These instructions are not a sandbox. Bash can still run commands permitted by the session.
Ask Claude to use it after an implementation stage, for example: "use the security-reviewer subagent for this diff".
It reports findings. A human decides how to handle each finding.

## Enforcement status

ESLint rules, a configuration check, Git hooks, and CI jobs enforce part of the rules. They are the same for each person and each agent, because they use only repository files, Git, and GitHub Actions. See [Enforced rules](ENFORCED_RULES.md).
`npm run check:config` compares each third-party skill file with the hash in [docs/skill-provenance.json](skill-provenance.json). See [Installed third-party skills](INSTALLED_SKILLS.md#manual-hash-check) for the manual command.
Cloud agents work in a new clone without local Git hooks. CI repeats each hook check for this reason.

## Verify the active session

1. Start a new session in this repository.
2. Inspect loaded instructions and available skills.
3. Ask the agent to list instruction files without changing files.
4. Confirm Git limits, human decisions, security review requirements, language rules, and pipeline rules.
5. Confirm that an available skill resolves to the shared workflow.

Claude provides `/context`. Gemini provides `/memory show`.
Host settings can disable instruction loading or skill discovery.
If automatic loading is unavailable, attach AGENTS.md and the shared skill explicitly.
Do not start another agent with repository write access only to test discovery.
Static checks do not prove that every vendor session follows instructions.

## Maintenance

- Change requirements in AGENTS.md and workflow instructions in the shared skill.
- Keep each Claude skill description equal to the shared description.
- Keep adapters small. Check relative paths after directory changes.
- Read package documentation before moving a package rule to repository scope.
- Never add global permissions, automatic hooks, publication credentials, or network actions to adapters.
- Do not add host settings files, such as `.claude/settings.json` or `.mcp.json`, without a human decision. `npm run check:config` rejects them. See [Enforced rules](ENFORCED_RULES.md#configuration-check).
