# Writing rules

The reference is [ASD-STE100, Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf), dated 2025-01-15.
Use its writing rules and dictionary for English documentation.
Do not claim full conformance from a sentence counter or an unchecked vocabulary list.

## Language

- Write everything in the repository in English: code, code comments, user interface text, documentation, tests, and reports.
- Write the CLI interface, user-facing task reports, and agent reports in English.
- Keep commands, paths, identifiers, quoted software labels, and license text exact.
- Write test names, test data, and test comments in English. Tests are not user interaction.
- Write identifiers in contract and package data in lowercase ASCII `snake_case`. Use only ASCII characters in file names, slot names, and attachment names.

## Terms

Use the terms in [the glossary](GLOSSARY.md). Use one term for each concept.
Do not use "layer", "part", "slot", and "attachment" as synonyms. Each term has a different meaning.

## Status marks

The project documents contain decisions, proposals, and research results. Mark the status of each statement that is not a plain fact.

| Mark           | Meaning                                                                |
| -------------- | ---------------------------------------------------------------------- |
| **Draft**      | The document or section can change without a decision record.          |
| **Proposed**   | A recommendation. It is not accepted. Link the related decision entry. |
| **Accepted**   | A human accepted it. Link the decision entry.                          |
| **Assumption** | Not verified. State how to verify it.                                  |
| **Verified**   | Confirmed by a test or a primary source. State the test or the source. |

## Procedures and descriptions

1. Use one consistent technical term for each concept.
2. Use dictionary words with their approved meanings and parts of speech.
3. Define necessary technical terms in the glossary or the relevant package documentation.
4. Put one instruction in each procedure sentence.
5. Use the imperative and active voice for procedures.
6. Put necessary conditions before the related instruction.
7. Limit procedure sentences to 20 words.
8. Limit descriptive sentences to 25 words.
9. Limit paragraphs to six sentences.
10. Do not use semicolons in prose.
11. Put data loss cautions before the related actions.
12. Keep instructions consistent with the actual defaults, prompts, and failure behavior.

Use tables for comparisons and mappings.
Explain preconditions, expected results, cancellation, and recovery when the operation needs them.
Distinguish a verified result from a recommendation or an untested assumption.

## Licenses and costs

When a document names a tool or a model, give its license. Use the labels from [the model license registry](MODEL_LICENSES.md).
Do not call a model "open source" when its license has use-based restrictions. Use "open weights" and name the license.
Give prices only with the date of the check.

## Commits and pull requests

Write commit messages and pull request text in English.
Apply ASD-STE100 Issue 9 to commit subjects and bodies.
Apply the same standard to pull request titles and all description text after `tl;dr`.
Keep commands, paths, identifiers, and quoted software labels exact.

Start every pull request description with the heading `## tl;dr`.
Explain the problem and the result in plain language for a reader with little subject knowledge.
Avoid unexplained technical terms in this section.
Keep this section as short as possible, with one or two paragraphs.

Never add links to AI agent threads, chats, or sessions where a feature was discussed.
This rule applies to repository files, commit messages, pull requests, issues, and review comments.
Do not add commit trailers or attribution lines with such links.
These links are often private, and they can expire. Write the necessary context in the text itself.

Use the [pull request template](../.github/pull_request_template.md).
Replace its instructions with the task details.
Describe the final change and the completed checks.
Identify checks that were not run and any remaining limits.
