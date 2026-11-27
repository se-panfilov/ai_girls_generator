# V2-M1 experiment E1: prompt v3.1 with and without a geometry reference

**Draft. Proposed.** Experiment plan only. No code change, no GPU, no generator call by an agent.
Source: [V2 construction and calibration](V2_CONSTRUCTION_AND_CALIBRATION.md), sections 2, 3, and 6, and the owner decisions in that document.

## Question

Does the synthetic geometry reference improve the source geometry of a generated modular sheet, compared with prompt v3.1 alone,
without a loss of character identity, clothing fidelity, or artistic consistency?

E1 compares two conditions that use the same prompt. It does not compare v3.0 with v3.1. The R4 sheet (v3.0) is context only.

## Inputs

### Prompt v3.1

File: [`prompts/modular-character-sheet/v3.1.md`](../../prompts/modular-character-sheet/v3.1.md).

- The first line and **SECTION B** are byte-identical to the owner's v3.0 prompt of the second character (R4).
  The artistic brief does not change.
- **SECTION A** is the fixed, character-independent part. v3.1 changes only SECTION A, with the construction rules of PR #56:

| Section A | Change from v3.0                                                                                              | Evidence (PR #56 defect)                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1         | The head is at body scale; no stylized enlargement                                                            | Big head (2)                                                                     |
| 2         | The neck moves from row 1 to row 3                                                                            | Row 1 at contract size (369 + 247 + 301 + 114 px) is wider than a 1024 px canvas |
| 3         | Sizes are joint-to-joint lengths relative to the thigh length T (contract bones), not envelopes in head units | Big head (2), short shins (3), upper arm length (4)                              |
| 4         | New: rest orientation of each part, from the contract bone directions                                         | Limb axis off the bone (5)                                                       |
| 5         | Closed ends, no visible inside, finished edges of the parts drawn on top; shin overlap above the knee ≤ 0.2 T | Open ends (7), long overlap (9)                                                  |
| 7         | Each clothing item on exactly one part; no sleeve caps on the torso; no repeated cuff                         | Costume ownership (8)                                                            |
| 8         | Canvas 1024 × 1536 preferred; every pixel outside the parts fully transparent                                 | Background haze (10)                                                             |

The lengths in section A.3 come from the C0.5 contract joints (T = 292 px): shin 293, upper arm 220, forearm 187–193,
hand 136, head 177, neck 53, torso to waist 257, waist to hip joints 124, ankle to ground 44, figure 1240 px.

### Geometry reference (condition B only)

The synthetic `sheet-fixture` output, re-packed into the v3.1 row layout. No new shapes, no resampling.

1. `aigg-control sheet-fixture --contract packages/control/test/fixtures/c05-candidate/rig.contract.json --out <dir>`
   (`@aigg/control` 0.17.0). Fixture pixel SHA-256 `424e678b…1aba`.
2. Research script `research/v2-m1-e1/scripts/make-reference.mjs` (project files, not in the repository): copies the 18 part boxes
   exactly to a 1024 × 1536 canvas in the v3.1 rows, near item first; drops the fixture's assembled preview region.
3. `sheet-check` on the result with the written descriptor: PASS (P1–P5).

| Item                | Value                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1 reference file   | `e1-geometry-reference.png` as stored in the project files and attached in the owner conversation. **Use this file.**                            |
| File SHA-256        | `67ccf2797ec0736d785c45ac961e13aa0020d847c0567126e493b45f1c5ca096`                                                                               |
| Raw RGBA SHA-256    | `708e96878fba92a339e8b25e42d875311e21b72d0504628128f6d1ff8b43cc71` (SHA-256 of the decoded 8-bit RGBA bytes only)                                |
| Tool pixel hash     | `58d1189945d15957af79697f8737e82d1da3371f2d564d08fa5e1bb8eaded0fb` (`pixelHash` of `@aigg/control`: SHA-256 of `1024x1536:rgba8\n` + RGBA bytes) |
| Script output bytes | `e1-geometry-reference.png.gz`, file SHA-256 after gunzip `15bcd269b70068128afa4ee83be73941761333d03b33c7c5d5ed57623676beaf`                     |
| Contract            | `humanoid_girl_v1_c05_candidate` 0.3.0, file SHA-256 `2e5868b5…5d6f`                                                                             |
| Scale               | 1 px = 1 contract px; vertical gap 17 px                                                                                                         |

Verification against the current C0.5 contract (script report): all 18 box sizes equal the attachment rectangles, and all
joints equal the contract joints relative to the rectangle origin. The parts are flat-color shapes drawn by code. The script output has no
artwork, no text, no metadata chunks, and no secrets.
Hash check: the script wrote `15bcd269…beaf`. The project-file store then added one C2PA content-credential chunk
(`caBX`, generic Anthropic metadata, no project data) to the stored copy, which gives file SHA-256 `67ccf279…a096`.
Both files decode to the same 1024 × 1536 RGBA pixels: raw RGBA SHA-256 `708e9687…cc71` for both, tool pixel hash `58d11899…d0fb` for both.
The two pixel values differ only because the tool hash adds a size prefix. It is the same image; no other image was supplied.
For E1, use the stored file `67ccf279…a096`. Record its file SHA-256 and raw RGBA SHA-256 with each condition B sheet.

Known limits of the reference:

- The mock shapes have concave notches at some joint ends (hands, feet, shin tops, far thigh top, hips leg opening, neck top).
  These are not construction targets. The condition B addendum tells the generator not to copy them.
- `hair_back` and `hair_front` are hatched rectangles: size limits only, no shape.
- The head is a plain ellipse with no face direction.

## Conditions

Both conditions use the same service, the same model choice in the service, the same prompt file, a new conversation for each
sheet, and 3 sheets each.

| Condition               | Input                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **A: text only**        | The full text of `v3.1.md`. No image.                                                                              |
| **B: text + reference** | The full text of `v3.1.md`, then the addendum below, and `e1-geometry-reference.png` attached in the same message. |

Addendum for condition B (paste after the prompt text, unchanged):

```text
# GEOMETRY REFERENCE

The attached image is a geometry reference. It shows 18 flat placeholder shapes in the same rows and order as Section A.2.

Use it only for the relative size, the rest orientation and the position of each part on the canvas. Match the length and direction of each limb shape.

The hatched rectangles show only the maximum size of the rear hair and the front hair.

Do not copy the flat colors, the hatching, the concave notches or the simplified shapes. Every part follows Section A and Section B.
```

## Generation instructions for the owner

1. Use the same service as before (ChatGPT image generation). Write down the model name that the service shows.
2. Order: A1, B1, A2, B2, A3, B3. Start a new conversation for each sheet. If the service keeps memory between conversations,
   write down whether it is on.
3. Paste the prompt text in full. For B, add the addendum and attach the reference image in the same message.
4. Take the first image of each conversation. Do not regenerate, select, or edit. If the service returns no image or a refusal,
   repeat once in a new conversation and write down the failure.
5. Download the original PNG (not a screenshot). Name it `e1-A1.png` … `e1-B3.png` and upload it to the project.
6. Fill one line per sheet: id, condition, model name, memory on/off, failures, and anything unusual the service said.

Do not upload other project assets. Do not install software.

## Measurement protocol

Agents run this on the uploaded sheets. Each sheet stays unchanged; a cleaned copy, if needed, is a recorded derivative.

1. **Provenance:** file SHA-256, size, the owner's line from step 6.
2. **Alpha and extraction:** share of alpha 1–15 and 16–63 outside the parts; component count at alpha ≥ 16 and ≥ 64;
   `sheet-check` (P1–P5) with a draft descriptor (boxes = components + 3 px) **without** preprocessing.
   If it fails, apply the recorded R4 step (alpha < 64 → 0) to a copy for the next steps only.
3. **Landmarks:** limb joint centers by the rounded-end rule (R4 `pivots.mjs`), checked by eye at 2×; head top, chin, neck base,
   waist, and ankle-to-sole by hand. Each value is recorded as `tool` or `manual`.
4. **Sheet scale:** `s` = mean art thigh length / 292. Report `s`. The strict 1:1 values (art length / bone length) are reported
   too, in the strict rig compatibility class.
5. **Source geometry** (relative to `s`):
   - limb length ratio = art length / (`s` × bone length), for 6 limbs: upper arms, forearms, shins;
   - head ratio = `H_art` / (`s` × 177);
   - axis difference = art segment angle − contract bone angle, for 8 limbs;
   - width ratio = art width / (`s` × rectangle width);
   - shin overlap above the art knee, in units of `s` × 292.
     `s` uses only the thighs, so the head and the other limbs are not measured against themselves.
6. **Visual construction defects** at 2× crops, counted per part: open or hollow end, visible inside, skin cross-section,
   duplicated clothing, part not separate.
7. **Optional:** for the best sheet of each condition, assemble with the R2 method and record the joint gaps (setup, `idle`, `wave`).
   These are not part of the acceptance.

Context values from earlier sheets (same method): R1 `s` = 1.02, head ratio 1.35, shin ratio 0.85; R4 `s` = 0.83,
head ratio 1.57, shin ratio 0.99.

## Human visual review

The owner reviews each sheet against SECTION B and the R4 sheet. Score each item 0, 1, or 2.

| Item                 | 2                                                                                  | 1                                   | 0                                          |
| -------------------- | ---------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------ |
| Character identity   | Same character as R4: hair shape and color, crimson glasses, amber eyes, face type | Recognizable with clear differences | Another character                          |
| Clothing fidelity    | All SECTION B items on the correct parts                                           | One item missing or on a wrong part | Several items missing or changed           |
| Artistic consistency | One style, line weight, and light across all 18 parts                              | Small differences between parts     | Parts look like different images or styles |

A sheet passes the review when no item is 0 and the total is 4 or more.

For each condition B sheet, the review also records, per part, whether the generated art reproduces a reference artifact:
hatched hair rectangles (or a hatch pattern), concave end notches, flat placeholder colors, or the plain placeholder shapes.
Record yes or no for each artifact type and name the parts. A reproduced artifact counts as a visual construction defect in step 6.
For condition A sheets, record the same items as a control (expected: no).

## Success and decision rules

Thresholds are experimental (PR #56, decision 2 and correction A).

A sheet meets the geometry target when all of these are true:

- `sheet-check` PASS without preprocessing;
- head ratio 0.9–1.1;
- all 6 limb length ratios 0.9–1.1;
- all 8 axis differences ≤ 6°;
- at most one visual construction defect on a part that is drawn on top (`hips` top, `forearm_far` wrist, `upper_arm_far` elbow,
  near limbs, neck).

A condition succeeds when at least 2 of 3 sheets meet the geometry target **and** pass the human review.

Decision rule:

- If B is not better than A on the head ratio and the limb length ratios (median over 3 sheets), or B loses the human review,
  do not use the geometry reference now.
- If neither condition succeeds, record the measured values and stop. Do not change the prompt further inside E1.
- Per-part generation stays an open option. E1 gives no evidence for or against it.

## Limitations

- The service does not expose seeds or exact model settings. Service behavior can change between sheets.
  The result is indicative, not a controlled experiment.
- Three sheets per condition can show a large difference only.
- The reference mock shapes are simplified and have notches; condition B can copy them despite the addendum.
- The landmark rule is semi-automatic; hand values have an error of a few pixels.
- Setup, `idle`, and `wave` do not test knees, ankles, or feet under locomotion.
