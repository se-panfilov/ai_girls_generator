# V2-M1 experiment E2: three reference conditions

**Draft. Proposed.** Run plan only. No agent generates images, runs GPU inference, or installs software.
E2 adds condition C to the E1 plan. Conditions A and B, prompt v3.1, the measurement protocol, and the thresholds come from
[the E1 plan](V2_M1_E1_EXPERIMENT.md) without change. The condition C reference comes from [the Jun anatomy map](V2_M1_E2_JUN_SILHOUETTE.md#owner-map-primary-geometry-reference).

E2 is an exploratory comparison of three conditions with 3 sheets each. It is not a controlled statistical experiment:
the service does not expose seeds or model settings, and 3 sheets per condition can show only a large difference.

## Conditions

All three conditions use the same service, the same model choice in the service, prompt v3.1 without change
(`prompts/modular-character-sheet/v3.1.md`, SECTION B unchanged), a new conversation for each sheet, and 3 sheets each.

| Condition | Input after the full prompt text    | Image                                                                                          |
| --------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| **A**     | Nothing                             | None                                                                                           |
| **B**     | E1 addendum (E1 plan, "Conditions") | Synthetic C0.5 reference, `research/v2-m1-e1/reference/e1-geometry-reference.png`              |
| **C**     | E2 addendum (below)                 | Mirrored Jun-derived reference, `research/v2-m1-e2/user-map/mirrored/generation-reference.png` |

### Condition C reference

| Item                  | Value                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File                  | `research/v2-m1-e2/user-map/mirrored/generation-reference.png` (project files, private, never commit, E2 use only under owner decision D5)                  |
| Approved file SHA-256 | `ef3c483b417ac86256f17d106b571f1d6ff6b8ce4c57f3fa1d547957f8d68168` (`user-map/SHA256SUMS` and `user-map.tar.gz`)                                            |
| Stored copy SHA-256   | `6f083b41b039d73b7a825a9546d6bffcac3cc69cc68bddc8b8cad05551099896` (the file store added a C2PA `caBX` chunk; pixels identical)                             |
| Raw RGBA SHA-256      | `fb90a37523d08de2be62bfb0ec4a0b3e06129d951d36490bf1e696a19a1fd9e5` (both copies)                                                                            |
| Tool pixel hash       | `9abeeab2708527d9686ff05d7db348bc745e99aaf53bea1fe76e0623192f5cbd` (`@aigg/control` `pixelHash`, size prefix)                                               |
| Size and alpha        | 2000 × 2050, fully opaque (black background)                                                                                                                |
| Content               | Flat-color silhouettes, mirrored to face image right: an assembled figure on the left, a detached set of 17 parts on the right. No artwork detail, no text. |

Use either copy. The approved image is the one with the raw RGBA SHA-256 above. Do not upload `assembled-reference.png`,
`parts-inventory.png`, `generation-reference-boxes.png`, the native set, the PSD, or any other Jun file.

### E2 addendum for condition C

Paste after the prompt text, unchanged, and attach the condition C image in the same message.

```text
# GEOMETRY REFERENCE

The attached image is a construction reference made from a different character. It shows flat colored silhouettes on a black background: one assembled figure on the left and a set of detached parts on the right.

Use it only for the rest orientation of each part, the joint positions, the overlap between neighboring parts and the cut lines between parts.

It is not an output layout and not a character design:

- Do not draw an assembled figure. The output contains only the 18 detached assets in the rows of Section A.2.
- The reference has no separate neck; its neck is part of the torso. The output has an independent neck asset, and the torso has no neck, as Section A requires.
- Where a silhouette differs from the proportions in Section A.3, follow Section A.3.
- Do not copy the silhouette shapes, the hairstyle, the flat colors or the black background. The background stays fully transparent. The appearance of the character follows Section B only.
```

The addendum adds no artistic requirement and does not relax a construction rule. Each line repeats a rule of Section A or Section B.

### Known differences between the B and C references (possible confounders)

| Item             | B (synthetic C0.5)                             | C (Jun-derived)                                                                 |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| Assembled figure | None                                           | Present (left side)                                                             |
| Parts            | 18, separate neck                              | 17, neck inside the torso                                                       |
| Layout           | v3.1 rows on 1024 × 1536                       | Different packing on 2000 × 2050                                                |
| Proportions      | C0.5 exact                                     | Shins 1.13–1.14, upper arms 0.77–0.81, head 1.05 relative to C0.5 (thigh-based) |
| Shapes           | Simple mock tubes, notches, hatched hair boxes | Real character silhouettes (Jun hair, torso, hands)                             |
| Background       | Transparent                                    | Opaque black                                                                    |
| Orientation      | C0.5                                           | Mirrored Jun setup pose (more torso yaw, head near profile)                     |

A difference between B and C can come from any of these items, not only from "synthetic vs real-character reference".

## Owner instructions

1. Use ChatGPT image generation, as in E1. Write down the model name that the service shows.
2. Order: **A1, B1, C1, A2, B2, C2, A3, B3, C3**. The A and B order is the E1 order; C runs after each pair.
3. Start a new conversation for each sheet. Write down whether the service memory is on.
4. Paste the full text of `v3.1.md`.
   - A: send it as is.
   - B: add the E1 addendum and attach the condition B image in the same message.
   - C: add the E2 addendum and attach the condition C image in the same message.
5. Take the first image. Do not regenerate, select, or edit. If the service returns no image or a refusal, repeat once in a new
   conversation and write down the failure.
6. Download the original PNG. Name it `e2-A1.png` … `e2-C3.png` and upload it to the project.
7. Fill one line per sheet in the template below.

Do not upload other project assets. Do not install software.

## Measurement and review

Agents measure each sheet with the E1 protocol (steps 1–7) and the owner scores the E1 human review (identity, clothing, style;
0–2 each). The E1 reference-artifact record applies to B sheets. For C sheets, record these items too:

| Item                                                                                                | Record                                        |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Assembled figure copied into the output                                                             | yes / no                                      |
| Independent `neck` missing (neck drawn on the torso)                                                | yes / no                                      |
| Distinctive Jun silhouette shapes copied (hairstyle outline, torso, hands, shin and foot cut lines) | yes / no, parts                               |
| Artistic identity changed toward the reference (hair, outfit, face, palette not as in SECTION B)    | yes / no, notes                               |
| Part count and layout                                                                               | count at alpha ≥ 16; rows as in v3.1 yes / no |
| Black or opaque background copied                                                                   | yes / no                                      |

Record the same items for A and B sheets as a control.

The E1 success rule applies to each condition (at least 2 of 3 sheets meet the geometry target and pass the human review).
Compare the conditions on the median head ratio, the median limb length ratios, the axis differences, the defect counts, and the review
scores. A condition that copies the assembled figure or loses the neck on 2 or more sheets is not usable as is, whatever its geometry.

## Results template

One row per sheet. Agents add the measured values; the owner fills the first columns and the review.

| Id  | Model shown | Memory | Failures / notes | File SHA-256 | `sheet-check` (no preprocessing) | `s` | Head ratio | Limb ratios min–max | Max axis Δ | Defects on top parts | Identity | Clothing | Style | Reference artifacts copied | C: figure / no neck / Jun shapes / identity / layout / background |
| --- | ----------- | ------ | ---------------- | ------------ | -------------------------------- | --- | ---------- | ------------------- | ---------- | -------------------- | -------- | -------- | ----- | -------------------------- | ----------------------------------------------------------------- |
| A1  |             |        |                  |              |                                  |     |            |                     |            |                      |          |          |       | —                          | —                                                                 |
| B1  |             |        |                  |              |                                  |     |            |                     |            |                      |          |          |       |                            | —                                                                 |
| C1  |             |        |                  |              |                                  |     |            |                     |            |                      |          |          |       |                            |                                                                   |
| …   |             |        |                  |              |                                  |     |            |                     |            |                      |          |          |       |                            |                                                                   |

Summary per condition: sheets meeting the geometry target, sheets passing the review, median head ratio, median limb ratios.

## Status

- No image generation, GPU inference, or generator call was done for E1 or E2. The A, B, and C sheets do not exist yet.
- The condition C reference was only hashed and decoded locally to confirm its identity.
