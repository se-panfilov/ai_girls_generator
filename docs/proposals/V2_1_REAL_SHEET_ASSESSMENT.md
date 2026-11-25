# V2-1: compatibility of one real AI-generated modular sheet

**Status: research result.** This report applies the method of [the Modular Sheet Contract v0.1, section 8](../PIPELINE_V2_MODULAR_SHEET.md#8-real-ai-generated-sheet-compatibility-assessment) to one real sheet. It does not change the contract requirements, the rig contract, or any decision. It is one sample. It is not a reference for all future characters. A sheet that does not fit the contract is a valid result.

## Contents

- [1. Input and evidence](#1-input-and-evidence)
- [2. Method](#2-method)
- [3. Measurements](#3-measurements)
- [4. Part inventory](#4-part-inventory)
- [5. Descriptor attempt and sheet-check](#5-descriptor-attempt-and-sheet-check)
- [6. Assessment of the 10 points](#6-assessment-of-the-10-points)
- [7. Problems by source](#7-problems-by-source)
- [8. What preprocessing, the prompt, or a decision can fix](#8-what-preprocessing-the-prompt-or-a-decision-can-fix)
- [9. Recommendations](#9-recommendations)
- [10. Confirmed findings and assumptions](#10-confirmed-findings-and-assumptions)

## 1. Input and evidence

| Item   | Value                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Source | One image that the owner made with a general-purpose image generator from one text prompt. No manual cleanup. Owner test data. |
| Sheet  | PNG, 1536 × 1024, 2 082 860 bytes, SHA-256 `c7a63d15bd047f71a1107f9f15e97e6112e449bb7dc1e5bf0c4c2d661e92f833`                  |
| Prompt | Plain text, 2018 bytes, SHA-256 `d33146a5c7bb5744049353120787bf541c557171c1f0ac4f6a97b00ef729859d`                             |
| Target | The C0.5 candidate contract (`humanoid_girl_v1_c05_candidate` 0.3.0, prototype geometry, 7 heads)                              |

The image, the prompt, and all derived images stay outside Git, in the owner's project files. The original is stored there in a gzip container, because the project file storage adds a C2PA `caBX` chunk to plain PNG files (also under a `.bin` name). That changes the file SHA-256 but not the pixels. All measurements in this report use the original bytes.

Prompt summary (the exact text is in the local evidence): a modular chibi sprite sheet for Spine, an adult character of about 3.5 heads, three-quarter view facing screen right, a list of separate parts (head base, neck, front hair, back hair, side locks, eye whites, irises, lashes, brows, mouth, upper torso, hips, left and right upper arms, forearms, hands, thighs, lower legs, feet, removable accessories), complete hidden geometry, overlap past the joints, rounded joint ends, no overlap of assets, generous spacing, a transparent background, no shadows outside the assets, no text, and a small assembled preview in the upper-left corner.

## 2. Method

All steps are read-only. No step changes the sheet.

1. PNG header and chunk list.
2. Alpha histogram, and the mean color and chroma (max − min of R, G, B) of each alpha band.
3. 8-connected foreground components at alpha thresholds 16, 64, 128, 200, and 240. Components of fewer than 400 pixels are counted separately.
4. The smallest gap between two components (Euclidean, search radius 24 px).
5. A visual identification of each component by the agent, and a manual layout descriptor from the component boxes.
6. `aigg-control sheet-check` on that descriptor, and the pixel checks P1 to P5 alone.
7. Part sizes compared with the C0.5 attachment rectangles.

## 3. Measurements

**Format.** 8-bit RGBA (color type 6), no interlace, chunks `IHDR`, `IDAT`, `IEND` only. Inside the size limits.

**Alpha.**

| Alpha   | Share of pixels |
| ------- | --------------- |
| 0       | 20.15 %         |
| 1–15    | 42.20 %         |
| 16–63   | 1.06 %          |
| 64–127  | 0.65 %          |
| 128–239 | 2.01 %          |
| 240–254 | 33.93 %         |
| 255     | 0 %             |

No pixel has alpha 255. The art is at 240–254.

**Background residue.** The weak-alpha pixels (1–15) are a haze over most of the empty area. Their mean color is light gray (189, 186, 183). 9.3 % of them have a chroma of 128 or more (red, yellow, and cyan fringes). The bands from alpha 16 up have 0 % such pixels. The color fringes are thus only in the weak-alpha band.

**Components.**

| Alpha threshold | Components | ≥ 400 px | Smaller (pixels) |
| --------------- | ---------- | -------- | ---------------- |
| 16              | 63         | 53       | 10 (453)         |
| 64              | 55         | 53       | 2 (314)          |
| 128             | 56         | 52       | 4 (610)          |
| 200             | 56         | 51       | 5 (800)          |
| 240             | 171        | 51       | 120 (1559)       |

The separation is stable from alpha 16 to 200. At 240 the opaque cores break into fragments.

**Gaps.** No two components touch. The smallest gaps at alpha ≥ 16 are 5.7 px (a hair strand to the front hair, the same part), 8.8 px (an extra hand to the sash), and 14.7 px (a thigh to a boot). The contract recommends 16 px.

**Box overlap.** The tight bounding boxes of 5 pairs of different objects overlap, although the objects do not touch: hairpin and pouch, extra hand and sash, boot variant and bow, and the belt with two belt pieces.

## 4. Part inventory

The agent identified the 53 components visually. This is an interpretation, not an owner check.

| Group                    | Components                                                                                                  | Slot in C0.5                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Assembled preview        | 1                                                                                                           | reference                                                               |
| Head                     | 2 head bases without a face (one three-quarter view with an ear, one other view)                            | `head` (one of them)                                                    |
| Hair                     | front hair (plus one separate strand), back hair, 2 side locks                                              | `hair_front`, `hair_back`, `hair_tail` (one lock only)                  |
| Neck                     | 1                                                                                                           | `neck`                                                                  |
| Face features            | 2 eye whites, 2 irises, 2 lash lines, 2 brows, 2 mouths, 2 small mouth lines (fragments)                    | **none** (the contract has no face slots, backlog B6)                   |
| Torso                    | 1 three-quarter front with chest, 1 other view, 1 narrow side piece                                         | `torso` (one of them)                                                   |
| Hips                     | front view, back view                                                                                       | `hips` (front)                                                          |
| Arms                     | 2 sleeved arm pieces, 2 bare arm pieces with frill, 2 gloved forearms drawn at about 35°                    | `upper_arm_*`, `forearm_*` (which pair is the upper arm is not certain) |
| Hands                    | 5 hands in different poses                                                                                  | `hand_near`, `hand_far` (2 of 5)                                        |
| Legs                     | 2 thighs with straps, 2 thighs in stockings, 2 tall lower legs with boots, 2 short lower legs with boots    | `thigh_*`, `shin_*` (variants), **no separate foot**                    |
| Clothing and accessories | 2 cape panels, sash with bow and pendant, bow, hairpin with ribbon, pouch, belt with pendant, 3 belt pieces | `acc_head` (hairpin). The others have no slot.                          |

No part has a near or far label. Most pairs are mirror pairs or near-mirror pairs. The side of each part is a human decision.

## 5. Descriptor attempt and sheet-check

The agent wrote a descriptor with one region for each component. It maps 18 slots: 16 required slots plus `acc_head` and `hair_tail`. The far and near side are a guess. The 34 other components are `ignore` regions. The lower legs with boots go to `shin_*`.

| Attempt                                                                           | Result of `sheet-check`                                                                                                                                  |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: one region for each object                                                     | ERROR: 5 × `E_SHEET_BOX_OVERLAP` (the 5 box pairs of section 3). The parser stops here.                                                                  |
| C: overlapping `ignore` boxes merged, hairpin and pouch merged, `acc_head` absent | ERROR: `E_SHEET_REQUIRED_MISSING` for `foot_near` and `foot_far`.                                                                                        |
| C, pixel checks only (no contract rules)                                          | P1 to P4 PASS. P5 FAIL: 445 foreground pixels outside all boxes (small fragments of brows and mouth lines). 342 652 weak-alpha pixels outside (ignored). |

The pixel checks also show that the haze is inside the part boxes, for example 22 099 weak-alpha pixels in the `hair_back` box. A box copy without an alpha step would carry the haze into the parts.

**Size against C0.5.** The scale that fits each part height to its C0.5 attachment rectangle is from 1.09 (`hair_front`) to 2.84 (`neck`): head 1.33, torso 1.61, hips 2.28, thighs 2.46, upper arms 1.76, forearms 1.58, hands about 2.0. The lower legs include the boot, so their value (1.56) is not comparable. One scale cannot fit the parts to C0.5. This is expected for a chibi body (about 3.5 heads) against a 7-head contract.

**Preview against parts.** The visible face in the preview is 50–66 px wide, and the head base is 140–158 px wide, so the parts are about 2.3 to 3 times the preview size. Hair covers the sides of the face in the preview, so this is an estimate. A stack of the part heights with an assumed 25 % joint overlap gives about 3.5 to 4 head heights, which agrees with the prompt. Exact consistency needs joint positions.

## 6. Assessment of the 10 points

| #   | Point                                     | Finding                                                                                                                                                     | Class                                                                                                                                       |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Format and dimensions                     | 8-bit RGBA, 1536 × 1024, no interlace, no extra chunks.                                                                                                     | Contract-compatible                                                                                                                         |
| 2   | Alpha                                     | 42.2 % weak alpha (1–15). No alpha 255.                                                                                                                     | Correctable by simple preprocessing                                                                                                         |
| 3   | Background contamination                  | Gray haze with color fringes, only at alpha 1–15. No opaque background. No shadow outside the parts.                                                        | Correctable by simple preprocessing                                                                                                         |
| 4   | Part candidates                           | 52–53 stable components at alpha 16–200. Their identity, side, and variant are not in the pixels.                                                           | Requires human metadata                                                                                                                     |
| 5   | Touching and overlap                      | No touching (smallest gap 5.7 px). 5 tight-box overlaps between objects that do not touch.                                                                  | Requires human metadata (with the v0.1 box format, boxes must be merged or dropped)                                                         |
| 6   | Scale consistency                         | Against C0.5: per-part scale 1.09–2.84. Inside the sheet: plausible, but not measurable without joints.                                                     | Against C0.5: requires regeneration for C0.5 proportions, or a rig contract decision. Inside the sheet: cannot be determined from one sheet |
| 7   | Differences from the required attachments | Feet are fused with the lower legs. Face features have no slot, so the head base has no face. Forearms are rotated about 35°. Extra variants and views.     | Feet: requires regeneration. Face: needs an owner decision (face slots or a face composition step). Rotation: requires human metadata       |
| 8   | Reference-only art                        | One preview, separate, upper-left. No text. Back views and extra poses are also not for import.                                                             | Contract-compatible (preview as `reference`). Extras: requires human metadata (`ignore`)                                                    |
| 9   | Automatic bounding-box extraction         | Components at alpha ≥ 16 give one box for each object, but 5 boxes overlap, one part has 2 components (hair strand), and 10 fragments (453 px) have no box. | Correctable by simple preprocessing for detection. Not for slot assignment                                                                  |
| 10  | Manual descriptor                         | It resolves identity, side, variants, and reference content. It cannot add the feet, a face, or C0.5 proportions. It needs box merges for the overlaps.     | Requires human metadata, but the feet and the proportions require regeneration                                                              |

## 7. Problems by source

**Generator errors (the image does not follow the prompt).**

- Feet are not separate. Each lower leg includes a boot.
- Extra views and variants that the prompt did not ask for: 2 head bases, 3 torso pieces, front and back hips, 5 hands, 4 upper-arm-like pieces, 2 thigh variants, 2 lower-leg variants.
- The forearms are drawn at about 35°, not upright.
- The spacing is not generous: the smallest gap between two objects is 8.8 px, and tight boxes overlap.
- The background is not plainly transparent (see below).

**Transparency and cleanup.**

- A weak-alpha haze (alpha 1–15) covers 42.2 % of the image, also inside the part boxes, with color fringes.
- No pixel is fully opaque (maximum alpha 254).
- 10 small fragments (453 px), mostly thin lines of brows and mouths.

**Part recognition.**

- No slot names, no side, no order. Variants make the choice ambiguous (which hand, which thigh, which arm piece).
- One part (front hair) is 2 components. A future importer must allow several components in one region.
- Upper arm and forearm pieces cannot be told apart with certainty from one sheet.

**Incompatibility with the C0.5 rig contract.**

- Chibi proportions (about 3.5 heads) against 7 heads: no uniform scale fits.
- Face features as separate parts, but the contract has no face slots.
- Two side locks against one `hair_tail` slot. Capes, sash, bow, belt, and pouch have no slots.
- The view (three-quarter, facing screen right) agrees with C0.5.

**Content rules.** The prompt states an adult character. The chibi proportions and the torso and back-hips pieces (with a focus on the chest and the buttocks) make the age reading and the body focus a human check under the [content rules](../../AGENTS.md#content-rules). The agent does not decide this. The prompt can remove the ambiguity (see section 9).

## 8. What preprocessing, the prompt, or a decision can fix

| Problem                        | Deterministic preprocessing                            | Prompt change                        | Human metadata                         | Blocks v2 with C0.5  |
| ------------------------------ | ------------------------------------------------------ | ------------------------------------ | -------------------------------------- | -------------------- |
| Weak-alpha haze and fringes    | Yes: alpha < 16 → 0, recorded as a new file            | Helps                                |                                        | No                   |
| Alpha 254 maximum              | Yes: optional rescale, recorded                        | Helps                                |                                        | No                   |
| Small fragments                | Yes: report, then drop or attach to the nearest region |                                      |                                        | No                   |
| Tight-box overlap              | No (format limit of v0.1)                              | Yes: more spacing                    | Yes: merged or component-based regions | No (with merges)     |
| Identity, side, variant choice | No                                                     | Partly (fixed order)                 | Yes                                    | No                   |
| Rotated forearms               | No                                                     | Yes                                  | Yes: angle                             | No                   |
| Feet fused with lower legs     | No                                                     | Yes                                  | Manual cut only (not automation)       | **Yes**              |
| Face features without slots    | No                                                     | Yes: draw the face on the head base  | Or a face composition step             | **Yes** (blank face) |
| Chibi proportions against C0.5 | No                                                     | Yes: target the contract proportions |                                        | **Yes**              |

Conclusion: transparency and separation are not blockers. A recorded alpha step fixes them. The blockers for this sheet are the fused feet, the face, and the proportions. They come from the prompt and the generator, or need an owner decision on the rig contract. The Pipeline v2 direction is not disproved by this sample.

## 9. Recommendations

**Next version of the generation prompt (proposed, not tested).**

1. Give the exact part list with counts, and one asset for each slot: "exactly one of each, no alternative views, no back views, no extra poses".
2. Ask for feet as separate assets, cut at the ankle, with a rounded ankle end, and lower legs without shoes.
3. Ask for all limbs upright and straight, in the rest pose of the target rig.
4. Choose one face approach: either draw the full face on the head base, or keep separate face parts only after face slots exist in the rig contract.
5. Give the target proportions (head-to-body ratio and limb lengths of the rig). For C0.5 this means about 7 heads, not chibi.
6. Ask for spacing of at least 32 px and a grid layout, so that rectangles do not overlap.
7. Ask for a fully transparent background with no haze, alpha 0 outside the art, and alpha 255 inside it.
8. Put the parts in a fixed grid order (for example the contract draw order), so that a human or a tool can map them quickly.
9. Accessories only for existing slots, or in a separate area for reference.
10. State the age and keep the design neutral: no focus on the chest or the buttocks, so that the content check is simple.

**Future importer (V2-2 and later, proposed, not implemented).**

1. Start with a separate, recorded alpha step (alpha < 16 → 0, optional alpha normalization). It writes a new sheet file with its own SHA-256 and provenance. The descriptor binds to that file.
2. Detect components at alpha ≥ 16 and propose regions with `origin: "tool"`. A human confirms the slot, the side, and the variant. The tool never guesses a slot from a shape.
3. Assign pixels by component, not only by box, so that overlapping boxes of separate objects are not an error (open decision D-S2). A region can hold several components.
4. Report fragments under a size limit and do not import them silently.
5. Accept a recorded rotation angle for a part (human metadata), or reject rotated parts.
6. Fail on a missing required slot. Never make a missing foot or face automatically.
7. Check the scale of each part against its attachment rectangle, with a tolerance. Report the spread.

## 10. Confirmed findings and assumptions

**Confirmed by measurement:** the format, the alpha histogram, the color of the weak-alpha band, the component counts, the gaps, the box overlaps, the `sheet-check` results, and the size ratios.

**Agent interpretation (not checked by the owner):** the identity of each component, which arm pieces are upper arms, which variants are alternatives, the near and far sides, and the content-rule note.

**Estimates:** the preview-to-part scale (2.3–3×) and the body height of about 3.5–4 heads.

**Not known from one sheet:** if the generator repeats these errors, if a changed prompt fixes them, and if the joint overlap of the parts is sufficient for rotation.
