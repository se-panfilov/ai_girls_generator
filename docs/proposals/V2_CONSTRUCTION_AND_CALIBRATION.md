# Pipeline v2: part construction rules and human calibration

**Draft. Proposed.** Design research only. No code, no contract change, no GPU, no generative repair.
Owner direction (this task): Pipeline v2 moves to contract-driven generation with human-in-the-loop calibration.
Human review and correction are a product capability, not a temporary failure mode.

Evidence: two real modular sheets from an external image service, assembled with the existing commands
(`sheet-check`, `sheet-extract`, `sheet-assemble`, `@aigg/viewer`):

- **R1/R2**: character 1, prompt v2.5. R1 = first assembly with draft joints. R2 = joint calibration spike.
- **R4**: character 2, prompt v3.0. Assembled with the R2 method.

The sheets are owner test data. They are not in the repository. All values below are measured on the sheets with
1 sheet px = 1 contract px (no resampling), against the C0.5 candidate contract (`rigId` `humanoid_girl_v1_c05_candidate`, 0.3.0).
H = the contract head unit, 177 px.

## 1. Recurring defects

| #   | Defect                                                           | R1/R2                                             | R4                                              | Class       |
| --- | ---------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------- | ----------- |
| 1   | Draft joints from the attachment-rectangle proportions are wrong | gaps 44–80 px                                     | gaps 26–55 px                                   | Annotation  |
| 2   | Head too large against the limbs                                 | anatomical head 1.37 H                            | 1.29 H                                          | Scale       |
| 3   | Shins too short (art knee → ankle vs bone 293 px)                | 0.86                                              | 0.82                                            | Scale       |
| 4   | Upper arm length (art shoulder → elbow vs bone)                  | 1.20–1.22                                         | 0.91–0.94                                       | Scale       |
| 5   | Limb axis off the bone                                           | forearm_near −16.4°                               | upper_arm_far −9.1°                             | Orientation |
| 6   | Limbs wider than the attachment rectangle                        | thigh, shin, forearm 1.4–1.9×                     | 1.0–1.3×                                        | Scale       |
| 7   | Open cut ends (visible inside or cut surface)                    | upper-arm sleeve end                              | forearm ends, thigh and shin tops, hips top rim | Artwork     |
| 8   | Costume ownership duplicated across parts                        | white cuff on hand and sleeve                     | sleeve caps on torso and upper arms             | Artwork     |
| 9   | Long hidden overlap that becomes visible                         | shin art has about 120 px of thigh above the knee | —                                               | Artwork     |
| 10  | Background haze, alpha 16–63 outside the parts                   | 0.5 %                                             | 6.6 % (blocks P5)                               | Alpha       |
| 11  | Feet separate from shins, low shoes                              | OK                                                | OK                                              | —           |

Observations:

- Defects 1–6 are geometry. Placement (offset, one rotation) hid them in R2 and R4. The art landmarks did not change.
- Defect 7 cannot be hidden by placement where the contract draw order puts the part on top:
  `hips` (11) over `torso` (10), `forearm_far` (4) over `hand_far` (3), `upper_arm_far` (5) over `forearm_far` (4).
- Prompts give dimensions in head units. The service draws a larger head, so all H-based sizes drift. The limbs were near contract px
  size; the head was not.

## 2. Part construction rules

Proposed rules for the 18 required slots. "Length" is the distance between the two art landmarks (joint centers).
"End finish" says how the end of the part must look where another part can show it.
Targets come from the contract bones and attachment rectangles. Tolerances are proposals for the lint in section 3.

### Priority parts

| Slot                       | Length target                                                                                    | Axis target        | Width limit                 | Ends and overlap                                                                                                                                                                              | Clothing ownership                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `hips`                     | waist landmark → hip landmarks: 0.55 H to the spine joint, hip joints 26 px below the hips joint | upright            | ≤ 2.0 H wide, ≤ 1.71 H high | Top edge is drawn over the torso: it must be a finished garment edge (belt, waistband). No visible inside, no skin ellipse. Thigh openings are hidden under the thighs or have finished hems. | Waistband, belt, pelvic clothing. Not the upper tunic. |
| `upper_arm_near`           | 220 px (1.24 H) ±10 %                                                                            | −15° ±6°           | ≤ 0.76 H                    | Proximal: finished rounded shoulder cap (drawn over the torso). Distal: rounded end, covered by the forearm; no open sleeve hole.                                                             | Upper sleeve only.                                     |
| `upper_arm_far`            | 218 px (1.23 H) ±10 %                                                                            | +13.5° ±6°         | ≤ 0.73 H                    | Proximal: hidden under the torso. Distal: **drawn over the forearm**: finished closed end.                                                                                                    | Upper sleeve only.                                     |
| `forearm_near`             | 187 px (1.05 H) ±10 %                                                                            | −4.6° ±6°          | ≤ 0.46 H                    | Proximal: rounded, drawn over the upper arm. Distal: covered by the hand cuff; closed end.                                                                                                    | Lower sleeve, bracer, wrist wrap.                      |
| `forearm_far`              | 193 px (1.09 H) ±10 %                                                                            | +15.9° ±6°         | ≤ 0.67 H                    | Distal: **drawn over the hand**: finished closed end, no visible tube opening.                                                                                                                | Lower sleeve, bracer, wrist wrap.                      |
| `thigh_near` / `thigh_far` | 292 px (1.65 H) ±10 %                                                                            | +1.2° ±6°          | ≤ 0.73 H (rect)             | Near proximal: finished contour over the hips. Distal: rounded end over the shin. Far proximal: hidden under the hips.                                                                        | Upper trousers.                                        |
| `shin_near` / `shin_far`   | 293 px (1.66 H) ±10 %                                                                            | −2° / −0.4° ±6°    | ≤ 0.55 H                    | Proximal: hidden under the thigh; the art above the knee landmark ≤ 0.35 H. Distal: finished hem over the shoe.                                                                               | Lower trousers and hem.                                |
| `foot_near` / `foot_far`   | ankle landmark → sole ≈ 0.46 H                                                                   | toe to image right | ≤ 0.92 H × 0.67 H           | Top: hidden under the hem; no boot shaft.                                                                                                                                                     | Shoes only.                                            |

### Other parts

| Slot                      | Rule                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `head`                    | Anatomical head (cranium top → chin) = 1.00 H ±8 %. This is the main scale reference of the sheet. Face toward image right. No neck.                      |
| `hair_back`, `hair_front` | Same skull as `head`: crown width = skull width ±10 %. Connected, one component each. Ends at the shoulders.                                              |
| `neck`                    | Neck base → head joint ≈ 54 px (0.30 H), axis near vertical (±10°). Lower contour finished (drawn over the torso).                                        |
| `torso`                   | Neck base → hips joint ≈ 355 px (2.0 H). Shoulder width ≈ distance of the shoulder joints (231 px) ± the cap radius. No sleeves beyond the shoulder line. |
| `hand_near`, `hand_far`   | Wrist landmark → fingertips ≈ 0.77 H. Glove or cuff only; no sleeve material.                                                                             |

### Sheet-level rules

- Exactly 18 components at alpha ≥ 16; alpha 1–63 outside the parts ≤ 1 % of the canvas.
- The head unit H on the sheet sets the scale. All length targets above are in contract px at that scale.
- Rule 1 for the prompt: give all sizes as ratios to the **torso height or the thigh length**, not only to the head. Evidence: defect 2.

## 3. Deterministic rules and visual rules

| Rule                                                     | Check type                                               | Data                            |
| -------------------------------------------------------- | -------------------------------------------------------- | ------------------------------- |
| Component count, box overlap, content outside boxes      | Deterministic (exists: `sheet-check` P1–P5)              | descriptor                      |
| Background haze share (alpha 1–63 outside boxes)         | Deterministic (new lint)                                 | alpha                           |
| One connected component per part                         | Deterministic (exists in extraction report)              | alpha                           |
| Landmark inside the part foreground                      | Deterministic                                            | landmarks                       |
| Segment length ratio, axis angle difference, width limit | Deterministic, after landmarks exist                     | landmarks, contract             |
| Head unit ratio                                          | Deterministic, needs the skull top and chin landmarks    | landmarks                       |
| Gap at each joint over the animation (as in R2)          | Deterministic                                            | landmarks, transforms, skeleton |
| Finished ends, no visible inside                         | **Visual** (a color heuristic is possible, not reliable) | crops                           |
| Clothing ownership, no duplicated material               | **Visual**                                               | crops                           |
| Style, light, face direction, near/far handedness        | **Visual**                                               | sheet                           |

## 4. Smallest data contract

Keep three things separate:

1. **Art landmarks**: points on the artwork, in sheet px. They describe the drawing. They never move to fix placement.
2. **Skeleton joints**: from the contract. Never changed for a character (D-S5).
3. **Attachment transforms**: per part placement correction. Offset and rotation. Scale only when the owner accepts it.

Proposal (**Proposed**, not accepted):

- `descriptor.regions[].joints` keeps its current shape and gets one meaning: art landmarks.
  The R2/R4 practice of a "joint" that is really a placement anchor stops.
- A new small file per character, `calibration.json`, format `aigg.part-calibration/0.1`:

```json
{
  "format": "aigg.part-calibration/0.1",
  "descriptorSha256": "<sha256 of the descriptor>",
  "parts": {
    "upper_arm_near": { "offset": { "x": 6, "y": 24 }, "rotationDeg": 0, "source": "proposal:split-0.5" },
    "forearm_near": { "offset": { "x": 0, "y": 0 }, "rotationDeg": -16.36, "source": "manual" },
    "hand_near": { "offset": { "x": 0, "y": 0 }, "rotationDeg": 0, "source": "proposal:none" }
  }
}
```

- Placement: the part landmark of the slot bone goes on the contract joint, then the offset is added (sheet px), then the part
  turns by `rotationDeg` about that landmark (screen degrees, clockwise positive). `scale` is not in 0.1.
- A missing part entry = zero transform. `source` records `proposal:<rule>` or `manual`. The file has no free text that a tool executes.
- Why a separate file: the descriptor describes the sheet, the calibration describes a decision. Save, restore, and compare
  do not change the descriptor hash.
- `sheet-assemble` would read the file, write the transform into the Spine region (`x`, `y`, `rotation`), and report the joint gaps
  with the art landmarks. R2 shows that a Spine region rotation works in the runtime.

Smallest missing capabilities (from R2): per-part offset separate from the landmark, per-part rotation, landmark outside the box.

## 5. Minimal human calibration

A page in `@aigg/viewer` style. **Not a universal animation editor.** No bone editing, no keyframes.

| Element          | Behavior                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| View             | Assembled character, setup pose, Spine web runtime.                                                                                                        |
| Markers          | Contract joints (fixed, not draggable). Art landmarks of the selected part (fixed). Gap line between the parent and child landmarks, with the value in px. |
| Select           | Click a part or pick a slot from a list.                                                                                                                   |
| Drag             | Move the selected part (offset). Shift + drag turns the part about its landmark (rotation). Arrow keys: 1 px.                                              |
| Preview          | Buttons: setup, `idle`, `wave`, pause, time slider. The gap values update for the current frame.                                                           |
| Proposal         | "Reset to proposal" per part (the deterministic rule: split or follow), "Reset to zero".                                                                   |
| Save and restore | Download `calibration.json`; load a file. One undo level per drag.                                                                                         |
| Approval         | Owner presses "Approve calibration". The page writes only the file; package assembly is a separate command.                                                |

Acceptance for a first version: the R2 near-arm correction (one rotation, three offsets) can be made in under 5 minutes,
and the saved file reproduces the same package bytes.

## 6. Next bounded experiment: E1 stricter prompt and a geometry reference

Blocker addressed: defects 2–8 come from the generation and cost manual work or stay visible.
Why the evidence is insufficient: two sheets, two prompt versions; no controlled comparison.

- **Arms:** (a) prompt v3.1 = v3.0 with the section 2 rules (sizes against the torso and thigh, axis words, end finish per part,
  clothing ownership, "no visible inside"). (b) v3.1 + one geometry reference image: the existing `sheet-fixture` layout
  (18 flat silhouettes at attachment-rectangle size and C0.5 orientation). The owner runs both on the same service; agents do not send images.
- **Size:** 3 sheets per arm, same character text as R4.
- **Measurement:** the R4 scripts (components, landmarks by the rounded-end rule, gaps), plus the visual rule list.
- **Acceptance (per arm, ≥ 2 of 3 sheets):** `sheet-check` PASS without preprocessing; head 1.00 H ±10 %; all limb lengths 0.9–1.1 of the bone;
  axis difference ≤ 6°; at most one end-finish defect on a part drawn on top; playback with ≤ 10 manual values.
- **Stop:** if (b) is not better than (a) on head ratio and lengths, drop the geometry reference for now.
- No GPU, no model download, no ComfyUI.

## 7. Next milestones

| Milestone | Content                                                                                                | Acceptance                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| V2-M1     | Construction rules (section 2) in the sheet contract doc and prompt v3.1; experiment E1                | E1 criteria above                                                                           |
| V2-M2     | `calibration.json` 0.1 + `sheet-assemble` reads it; deterministic proposal (split, follow); gap report | R2 C2 and R4 packages rebuilt with true landmarks; same visual result; no fabricated joints |
| V2-M3     | Sheet lint for the deterministic rules in section 3                                                    | R1 and R4 lint results match the manual findings in section 1                               |
| V2-M4     | Minimal calibration page (section 5)                                                                   | Section 5 acceptance                                                                        |

## Open questions

1. Is a separate `calibration.json` correct, or must the transforms live in the descriptor?
2. Is a per-part uniform scale allowed (upper arm 1.20 in R1)? It changes the pixels on screen.
3. The C0.5 draw order puts `forearm_far` over `hand_far` and `hips` over `torso`. Keep it (rule: finished ends), or review the draw order (contract change)?
4. Feet float 40–106 px above the contract ankles after the leg follow chain. Is a ground constraint necessary for the MVP?
5. Head unit: keep 1 H = 177 px and push the prompt, or accept a larger head in the contract (contract change)?
6. May the owner send the `sheet-fixture` layout image to the image service for E1?
