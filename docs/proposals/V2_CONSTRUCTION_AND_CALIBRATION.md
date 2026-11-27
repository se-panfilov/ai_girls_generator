# Pipeline v2: part construction rules and human calibration

**Draft. Proposed.** Design research only. No code, no contract change, no GPU, no generator call, no generative repair.
Owner direction: Pipeline v2 uses contract-driven modular generation with optional human calibration.
Human review and correction are a product capability, not a temporary failure mode.

Evidence: two real modular sheets from an external image service, assembled with the existing commands
(`sheet-check`, `sheet-extract`, `sheet-assemble`, `@aigg/viewer`):

- **R1/R2**: character 1, prompt v2.5. R1 = first assembly with draft joints. R2 = joint calibration spike.
- **R4**: character 2, prompt v3.0. Assembled with the R2 method.

The sheets are owner test data. They are not in the repository. All values are measured on the sheets at
1 sheet px = 1 contract px (no resampling), against the C0.5 candidate contract (`rigId` `humanoid_girl_v1_c05_candidate`, 0.3.0).
Two samples are not a statistic. The values show a direction, not a distribution.

## Reference units

| Symbol       | Meaning                                                                             | Value                    |
| ------------ | ----------------------------------------------------------------------------------- | ------------------------ |
| `H_contract` | Fixed head unit of the rig contract. All rig targets use it.                        | 177 px (C0.5)            |
| `H_art`      | Measured on a generated sheet: cranium top to chin of the `head` part, in sheet px. | R1 ≈ 242 px, R4 ≈ 229 px |

- All targets in this document are in contract px, derived from `H_contract`, the contract bones, and the attachment rectangles.
- `H_art` is a measurement only. It is never used as the unit for other targets, so the head size check compares `H_art` with a fixed
  value and does not validate itself.
- Limb length checks compare art landmark distances in sheet px directly with the contract bone lengths. They do not use `H_art`.

## Owner decisions (PR #56 review)

| #   | Topic               | Decision                                                                                                                                                                                                                                                                                                      |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Calibration storage | A separate `calibration.json`, bound to the exact source descriptor and the rig contract version.                                                                                                                                                                                                             |
| 2   | Scaling             | Optional **uniform** per-part scale is allowed in the planned calibration model. No nonuniform scale in the initial scope. Scale limits are experimental. A calibration never turns a source geometry FAIL into a source PASS; reports keep the source geometry and the calibrated visual alignment separate. |
| 3   | Draw order          | Keep the C0.5 draw order. A change needs separate evidence and owner approval.                                                                                                                                                                                                                                |
| 4   | Ground constraint   | Deferred beyond the `idle`/`wave` prototype. Requirement: reassess before locomotion tests.                                                                                                                                                                                                                   |
| 5   | Head size           | Keep `H_contract` = 177 px. Do not change the rig to compensate for generator errors.                                                                                                                                                                                                                         |
| 6   | Geometry reference  | The synthetic `sheet-fixture` output may be used as an image-generation reference in E1, if it contains no private assets or secrets. No other project assets may be uploaded. No software installation.                                                                                                      |

## 1. Recurring defects

| #   | Defect                                                       | R1/R2                                             | R4                                              | Check class (section 3)   |
| --- | ------------------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------- | ------------------------- |
| 1   | Draft joints from attachment-rectangle proportions are wrong | gaps 44–80 px                                     | gaps 26–55 px                                   | Visual assembly           |
| 2   | Head too large: `H_art` / `H_contract`                       | 1.37                                              | 1.29                                            | Source geometry           |
| 3   | Shins too short (art knee → ankle vs bone 293 px)            | 0.86                                              | 0.82                                            | Source geometry           |
| 4   | Upper arm length (art shoulder → elbow vs bone)              | 1.20–1.22                                         | 0.91–0.94                                       | Source geometry           |
| 5   | Limb axis off the bone                                       | forearm_near −16.4°                               | upper_arm_far −9.1°                             | Source geometry           |
| 6   | Limbs wider than the attachment rectangle                    | thigh, shin, forearm 1.4–1.9×                     | 1.0–1.3×                                        | Source geometry           |
| 7   | Open cut ends (visible inside or cut surface)                | upper-arm sleeve end                              | forearm ends, thigh and shin tops, hips top rim | Visual assembly (artwork) |
| 8   | Costume ownership duplicated across parts                    | white cuff on hand and sleeve                     | sleeve caps on torso and upper arms             | Visual assembly (artwork) |
| 9   | Long hidden overlap that becomes visible                     | shin art has about 120 px of thigh above the knee | —                                               | Visual assembly (artwork) |
| 10  | Background haze, alpha 16–63 outside the parts               | 0.5 %                                             | 6.6 % (blocks P5)                               | Alpha and extraction      |
| 11  | Feet separate from shins, low shoes                          | OK                                                | OK                                              | —                         |

Observations:

- Defects 1–6 are geometry. Placement (offset, one rotation) hid them in R2 and R4. It did not fix them: the `scale` check FAILs and
  `joint_residuals` got worse (R1 57 → 78 px, R4 109 px).
- With the C0.5 draw order kept (decision 3), defect 7 must be fixed in the artwork where a part is drawn on top:
  `hips` (11) over `torso` (10), `forearm_far` (4) over `hand_far` (3), `upper_arm_far` (5) over `forearm_far` (4).
- The prompts gave sizes in head units. The service drew a larger head, so all head-based sizes drift. Limb lengths stayed near the
  contract px values; the head did not.

## 2. Part construction rules

Proposed rules for the 18 required slots. "Length" is the distance between the two art landmarks (joint centers) of a part.
"End finish" says how the end of a part must look where another part can show it.

**Experimental thresholds.** The ±10 % length, ±6° axis, and width values are initial evaluation thresholds for E1.
They are not anatomical rules and not final acceptance limits. E1 and later sheets can change them.

### Priority parts

| Slot                       | Length target (contract px)                             | Axis target        | Width limit        | Ends and overlap                                                                                                                                                               | Clothing ownership                                     |
| -------------------------- | ------------------------------------------------------- | ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `hips`                     | hips joint → hip joints as in the contract (26 px down) | upright            | ≤ 354 × 303 (rect) | Top edge is drawn over the torso: a finished garment edge (belt, waistband). No visible inside, no skin ellipse. Thigh openings hidden under the thighs or with finished hems. | Waistband, belt, pelvic clothing. Not the upper tunic. |
| `upper_arm_near`           | 220 ±10 %                                               | −15° ±6°           | ≤ 135              | Proximal: finished rounded shoulder cap (over the torso). Distal: rounded, covered by the forearm; no open sleeve hole.                                                        | Upper sleeve only.                                     |
| `upper_arm_far`            | 218 ±10 %                                               | +13.5° ±6°         | ≤ 129              | Proximal: hidden under the torso. Distal: **drawn over the forearm**, finished closed end.                                                                                     | Upper sleeve only.                                     |
| `forearm_near`             | 187 ±10 %                                               | −4.6° ±6°          | ≤ 81               | Proximal: rounded, over the upper arm. Distal: covered by the hand cuff; closed end.                                                                                           | Lower sleeve, bracer, wrist wrap.                      |
| `forearm_far`              | 193 ±10 %                                               | +15.9° ±6°         | ≤ 119              | Distal: **drawn over the hand**, finished closed end, no visible tube opening.                                                                                                 | Lower sleeve, bracer, wrist wrap.                      |
| `thigh_near` / `thigh_far` | 292 ±10 %                                               | +1.2° ±6°          | ≤ 130              | Near proximal: finished contour over the hips. Distal: rounded end over the shin. Far proximal: hidden under the hips.                                                         | Upper trousers.                                        |
| `shin_near` / `shin_far`   | 293 ±10 %                                               | −2° / −0.4° ±6°    | ≤ 98 / 90          | Proximal: hidden under the thigh; art above the knee landmark ≤ 62 px (0.35 `H_contract`). Distal: finished hem over the shoe.                                                 | Lower trousers and hem.                                |
| `foot_near` / `foot_far`   | ankle landmark → sole ≈ 81                              | toe to image right | ≤ 157 / 162 × 118  | Top: hidden under the hem; no boot shaft.                                                                                                                                      | Shoes only.                                            |

### Other parts

| Slot                      | Rule                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `head`                    | `H_art` = 177 px ±10 % (experimental). Face toward image right. No neck.                                                                                       |
| `hair_back`, `hair_front` | Same skull as `head` (crown width = skull width ±10 %). One connected component each. Ends at the shoulders.                                                   |
| `neck`                    | Neck base → head joint ≈ 54 px, axis near vertical (±10°). Lower contour finished (drawn over the torso).                                                      |
| `torso`                   | Neck base → hips joint as in the contract. Shoulder width ≈ distance of the shoulder joints (231 px) plus the cap radius. No sleeves beyond the shoulder line. |
| `hand_near`, `hand_far`   | Wrist landmark → fingertips ≈ 136 px. Glove or cuff only; no sleeve material.                                                                                  |

### Sheet-level rules

- Exactly 18 components at alpha ≥ 16; alpha 1–63 outside the parts ≤ 1 % of the canvas.
- Prompt rule: give sizes as px or as ratios to the torso height and the thigh length, not only to the head (evidence: defect 2).
- Per-part prompts (one generation per part) stay an open option. There is no evidence for or against them yet.

## 3. Check classes

Four classes. A result in one class never changes the result in another class.

| Class                         | What it answers                                          | Checks                                                                                                                           | Type                                                                    |
| ----------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Alpha and extraction validity | Can the parts be cut out exactly?                        | Component count, box overlap, content outside boxes (`sheet-check` P1–P5, exists); background haze share; one component per part | Deterministic                                                           |
| Source geometry               | Does the drawing match the construction rules?           | Length ratio, axis difference, width, `H_art` / `H_contract`, landmark inside the foreground; open ends; clothing ownership      | Deterministic after landmarks exist; open ends and ownership are visual |
| Visual assembly quality       | Does the assembled character look connected?             | Joint gaps over setup, `idle`, `wave`; visible seams; style, light, face direction                                               | Gaps deterministic; the rest visual                                     |
| Strict rig compatibility      | Does the package match the contract without calibration? | `sheet-assemble` `scale`, `joint_residuals`, `near_arm_joints_covered`                                                           | Deterministic (exists)                                                  |

**Animation coverage.** Setup, `idle`, and `wave` are first checks only. The legs are not animated in `idle` and `wave`, so
knee and ankle gaps are static values. They do not validate knees, ankles, or feet under locomotion. Locomotion animations
need their own check, together with the ground constraint (decision 4).

## 4. Calibration data contract

Three things stay separate:

1. **Art landmarks**: points on the artwork, in sheet px. They describe the drawing. They are measurements and never move
   to fix placement. A landmark that is not on the art is a defect in the descriptor.
2. **Skeleton joints**: from the rig contract. Never changed for one character (D-S5).
3. **Attachment transforms**: per-part placement correction in `calibration.json`. Offset, rotation, optional uniform scale.

The descriptor (`aigg.modular-sheet/0.1`) keeps `regions[].joints` with one meaning: art landmarks.
The R2/R4 practice of a "joint" that is really a placement anchor stops.

### File `calibration.json` (Proposed, format `aigg.part-calibration/0.1`)

```json
{
  "format": "aigg.part-calibration/0.1",
  "descriptor": { "sha256": "<sha256 of the descriptor file bytes>" },
  "rig": { "rigId": "humanoid_girl_v1_c05_candidate", "contractVersion": "0.3.0", "sha256": "<sha256 of rig.contract.json>" },
  "parts": {
    "upper_arm_near": { "offset": { "x": 6, "y": 24 }, "rotationDeg": 0, "scale": 1, "source": "proposal:split-0.5" },
    "forearm_near": { "offset": { "x": 0, "y": 0 }, "rotationDeg": -16.36, "scale": 1, "source": "manual" }
  }
}
```

- Binding: a tool refuses the file when the descriptor hash, the `rigId`, the contract version, or the contract hash differ.
  The descriptor already binds the sheet (`sheet.sha256`).
- A slot without an entry has the identity transform. `source` is `proposal:<rule>` or `manual`. No field holds executable text.

### Transform semantics

| Item             | Definition                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordinate space | Rig canvas px: origin top-left, x right, y down. 1 sheet px = 1 rig px (`sheetPxPerContractPx` = 1).                                                                                                                                  |
| Pivot            | The part's art landmark for its slot bone (for a limb: the proximal landmark; for a foot: the ankle).                                                                                                                                 |
| Units            | `offset` in rig px; `rotationDeg` in degrees, positive = clockwise on screen (y down); `scale` dimensionless, > 0.                                                                                                                    |
| Order            | For each part pixel `q` with pivot landmark `L`: `p = J + offset + R(rotationDeg) · (scale · (q − L))`, where `J` = the contract joint of the slot bone in rig px. Scale first, then rotation, both about the pivot; the offset last. |
| Effect of scale  | The attachment region gets `scaleX` = `scaleY` = `scale`. The PNG pixels are not resampled. The other landmarks of the part move with the same transform, so gaps use the transformed landmarks.                                      |
| Spine output     | The assembler converts the transform into the region attachment `x`, `y`, `rotation`, `scaleX`, `scaleY` in the bone frame (Spine y up). Bones, slots, draw order, and animations do not change.                                      |
| Reproducibility  | The same sheet, descriptor, contract, and calibration give the same package bytes.                                                                                                                                                    |

Example (R2 C2): the near forearm turns −16.36° (counterclockwise on screen) about its art elbow; no offset; scale 1.

### Reports

- **Source geometry** is measured on the descriptor landmarks without the calibration. The `scale` and `joint_residuals` checks keep
  their source results.
- **Calibrated visual alignment** is measured after the transforms: gaps between the transformed parent and child landmarks.
- The report shows both and lists every non-identity transform. A non-identity scale is always reported as a scale correction.

Smallest missing capabilities (from R2): per-part offset separate from the landmark, per-part rotation, per-part uniform scale,
landmark outside the box.

## 5. Human calibration in AIGG Studio

User-facing calibration belongs to the Rig Calibration page of AIGG Studio, the unified Vue 3 + TypeScript + Vite application
(D36, PR #57). It reuses the existing Spine rendering of `@aigg/viewer` where practical. It is **not** built into the old viewer app,
and it is **not** a universal animation editor: no bone editing, no keyframes. This PR does not implement it.

| Element          | Behavior                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| View             | Assembled character, setup pose.                                                                                                                                                             |
| Markers          | Contract joints (fixed). Art landmarks of the selected part (fixed, editable only as a descriptor correction with its own record). Gap line between parent and child landmarks, value in px. |
| Edit             | Select a part. Drag = offset. Rotate handle = rotation about the pivot. Scale field = uniform scale. Arrow keys = 1 px.                                                                      |
| Preview          | Setup, `idle`, `wave`, pause, time slider. Gap values update per frame.                                                                                                                      |
| Proposal         | "Reset to proposal" (deterministic rule: split or follow) and "Reset to identity" per part.                                                                                                  |
| Save and restore | Save `calibration.json`; load a file; undo per edit.                                                                                                                                         |
| Approval         | The owner approves the calibration. The page writes only the file; package assembly is a separate command.                                                                                   |

Acceptance for a first version: the R2 C2 calibration (one rotation, three offsets) is made in under 5 minutes, and the saved
file reproduces the same package bytes as a hand-written file.

## 6. Experiment E1: prompt v3.1 with and without a geometry reference

- **Blocker:** defects 2–8 come from generation and cost manual work or stay visible.
- **Why the evidence is insufficient:** two sheets from two different prompts; no comparison of a geometry reference.
- **Question:** does the synthetic `sheet-fixture` geometry reference improve source geometry over prompt v3.1 alone?
- **Arms:** (a) prompt v3.1 = v3.0 plus the section 2 rules. (b) the same v3.1 text plus the `sheet-fixture` image
  (18 flat silhouettes at attachment-rectangle size and C0.5 orientation; synthetic, no private assets, decision 6).
- **Conditions:** the same service, the same model choice in the service, the same character text, new conversations, 3 sheets per arm.
  The owner generates. Agents do not call the service and do not send images.
- **Limitation:** the service does not expose seeds or exact model settings. The comparison is indicative, not controlled.
  It does not compare v3.0 with v3.1; R4 (v3.0) is context only.
- **Measurement:** the R4 scripts (components, landmarks by the rounded-end rule, gaps) and the section 3 classes.
- **Success (per arm, ≥ 2 of 3 sheets):** `sheet-check` PASS without preprocessing; `H_art` / `H_contract` 0.9–1.1; all limb lengths
  0.9–1.1 of the bone; axis difference ≤ 6°; at most one end-finish defect on a part drawn on top.
- **Decision rule:** if (b) is not better than (a) on head ratio and limb lengths, do not use the geometry reference now.
- No GPU, no model download, no ComfyUI, no per-part generation in E1.

## 7. Milestones

Each milestone is a separate task with separate owner approval. This PR starts none of them.

| Milestone | Content                                                                                                        | Acceptance                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| V2-M1     | Prompt v3.1 with the section 2 rules; E1 run by the owner; analysis (docs and evidence only)                   | E1 success criteria and decision rule                                                          |
| V2-M2     | `aigg.part-calibration/0.1` schema and `sheet-assemble` support (offset, rotation, uniform scale); dual report | R2 C2 and R4 rebuilt with true art landmarks only; same visual result; source checks unchanged |
| V2-M3     | Sheet lint for the deterministic rules of section 3                                                            | R1 and R4 lint results match section 1                                                         |
| V2-M4     | AIGG Studio Rig Calibration page (D36)                                                                         | Section 5 acceptance                                                                           |

## Open questions and risks

1. Experimental thresholds: two sheets set the first values. E1 can show that they are too strict or too loose.
2. Uniform scale limits are not known. A large scale changes the line weight and the detail size against other parts.
3. Kept draw order: open ends on parts drawn on top must be fixed in generation or by masked repair. Prompt rules can fail.
4. Without a ground constraint, the leg follow chain leaves the feet 40–106 px above the contract ankles. Reassess before locomotion.
5. E1 has no fixed seeds. Three sheets per arm can show a large difference, not a small one.
6. A new rendering of the same character must keep the character identity. E1 does not measure identity.
