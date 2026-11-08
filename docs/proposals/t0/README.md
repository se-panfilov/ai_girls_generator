# T0 proposed records (nonauthoritative)

**Proposal. Not accepted.** These files belong to [the T0 ADR](../T0_TEMPLATE_FIRST_ARCHITECTURE.md). No package reads them. They do not change any accepted format.

| Folder      | Content                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas/`  | JSON Schemas (draft 2020-12) for the template profile, style profile, style binding, character identity, model profile and generation job, plus shared definitions. |
| `examples/` | One example of each record. `generation-job.example.json` is the complete example build manifest.                                                                   |

## Rules for the examples

- Image hashes that start with `dddd` are dummy values. No image exists for them.
- The model profiles copy the values of the two files that are approved for experiment C in [the model license registry](../../MODEL_LICENSES.md). They do not approve anything.
- The record digests in the job example are the canonical digests of the other example files: SHA-256 of the JSON with keys sorted at every level, no whitespace, UTF-8.
- The template example is abbreviated: it lists 3 of the 27 slots of the C0.5 candidate contract.
- The identity, style and references are test data. They describe no real person and no real image.

## Cross-record rules

JSON Schema checks the shape of one record. The rules between records (digests, approval scopes, capability negotiation, prototype templates and production jobs) are in [section 6 of the ADR](../T0_TEMPLATE_FIRST_ARCHITECTURE.md#6-model-capability-negotiation).
