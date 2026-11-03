# AI Girls Generator

A reproducible asset factory for layered cutout anime-girl characters.
Each character is a package of PNG parts and a JSON sidecar. All characters fit one shared Spine skeleton and one shared animation set.

**Status: draft.** The repository contains agent rules and draft design documents. No pipeline code exists yet.

## Documents

| Document                                         | Content                                                       |
| ------------------------------------------------ | ------------------------------------------------------------- |
| [Architecture](docs/ARCHITECTURE.md)             | Goal, scope, pipeline stages, and candidate tools.            |
| [Rig contract](docs/RIG_CONTRACT.md)             | Bones, slots, coordinate spaces, names, overlaps, tolerances. |
| [Character package](docs/CHARACTER_PACKAGE.md)   | Package layout, image rules, sidecar, and provenance.         |
| [Decision log](docs/DECISIONS.md)                | Owner requirements and open decisions.                        |
| [Model license registry](docs/MODEL_LICENSES.md) | Candidate models and tools with their licenses.               |
| [Roadmap](docs/ROADMAP.md)                       | Phases, gates, and experiments.                               |
| [Workspaces](docs/WORKSPACES.md)                 | Planned npm workspaces layout and packages.                   |
| [Glossary](docs/GLOSSARY.md)                     | Terms for code, data, and documentation.                      |

## AI agents

[AGENTS.md](AGENTS.md) contains the rules for AI agents and people.
[The agent setup guide](docs/AI_AGENTS.md) describes the host adapters and the project skills.
[Installed skills](docs/INSTALLED_SKILLS.md) lists the third-party skills, their sources, and the local changes.

## Requirements

Node.js version from [.nvmrc](.nvmrc).

## License

[MIT](LICENSE). Third-party skills in `.agents/skills/` keep their own licenses.
