# V2-M1 experiment E2: Jun-derived silhouette geometry template (Gates 1 and 2)

**Draft. Proposed.** Gate 1 is inspection and design. Gate 2 (see [Gate 2 result](#gate-2-result)) built a prototype map in the private project files.
The owner then supplied a manual anatomy map. It replaces the Gate 2 map as the primary geometry reference (see [Owner map](#owner-map-primary-geometry-reference)).
This document creates no template, no image generation, no GPU use, and no change to the C0.5 candidate contract or to Pipeline v2.
The E1 plan (prompt v3.1 and conditions A and B) is in PR #58. E2 does not change it.

## Question

Does a silhouette template made from a professional, artist-sliced character improve the source geometry of a generated
modular sheet, compared with prompt v3.1 alone (E1 condition A) and with the synthetic geometry reference (E1 condition B)?

Gate 1 answers a smaller question first: is the Jun asset a usable and permitted geometry source for the 18 required C0.5 slots?

## Recommendation

**`PROCEED_WITH_LIMITATIONS`** (Proposed).

- 14 of 18 slots come from Jun artist layers with deterministic operations only: mirror, uniform scale, rigid rotation, band split.
- 2 slots need a substitution (`hand_far`, `foot_near`). 2 hair slots need an owner choice of normalization.
- The main incompatibility is anatomical style: Jun's shins are 1.28–1.35 × the C0.5 target at thigh scale. The head is 1.15 ×.
- The license allows edits for game development, but it does not address AI services. The owner must decide on the upload for E2.

Gate 2 starts only after the owner approves the source, the mapping, and the decisions in [Owner decisions](#owner-decisions).

## 1. Source asset inventory

Source: project file `Aekashics Librarium - Hero Jun Dragon DL.zip`, SHA-256 `81bd769e1fe20e0470b72672d948507fbb0af0cd0e81561d0fd7ea1bacb284fd`.
The archive and every derivative stay in the private project files. Nothing from it is committed.

| Item in the archive                       | Format          | Content                                                                                         | Use in E2                   |
| ----------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------- | --------------------------- |
| `Dragon/Sliced PSD/HeroJun.psd`           | PSD, 8-bit RGBA | 8000 × 9615 px, 32 independent pixel layers, figure about 6000 px tall. SHA-256 `e27b7afe…f702` | **Primary geometry source** |
| `Dragon/spine_assets/HeroJun.json`        | Spine 3.7.92    | Artist rig: 41 bones, 32 slots, 15 animations, IK on the legs. SHA-256 `26723114…5164`          | Joint landmarks (bones)     |
| `Dragon/spine_assets/HeroJun.atlas`/`png` | Spine atlas     | The same layers at sprite scale (about 1/18)                                                    | Not used                    |
| `Dragon/Animation Source Files/`          | Spine, DB, PNG  | Editor project files and frame PNGs (sprite scale)                                              | Not used                    |
| `Dragon/PSD & Resizes/`                   | PSD, PNG        | Flattened full-body image (3989 × 6023) and resizes                                             | Visual check only           |
| `Dragon/dragonbones_assets/`, others      | JSON, PNG       | DragonBones export, battler sheets, portraits, icons                                            | Not used                    |
| `Dragon/Terms of use.txt`                 | Text (UTF-16)   | A link to the terms page only. No license text                                                  | License pointer             |

Correction to earlier intake notes (MVP-E): the archive **does** contain a high-resolution layered source (`Sliced PSD`).
The MVP-E work used the 224 × 337 sprite frame because this file was not found then.

### Layers

17 of the 32 layers make the default (idle) pose. The other 15 are attack variants, 4 alternative face layers, and effects. They are not used.

| Layer                        | Box in PSD (x, y, w, h) | Content                                                           |
| ---------------------------- | ----------------------- | ----------------------------------------------------------------- |
| `back hair`                  | 4250, 2568, 1048, 987   | Rear hair                                                         |
| `default head`               | 4384, 2550, 828, 829    | Head with hair cap, ear, profile face contour, a part of the nape |
| `face default`               | 4505, 2926, 186, 300    | Eye, brow, mouth lines (discarded: not geometry)                  |
| `front hair`                 | 4209, 2312, 1184, 1016  | Bangs and side locks, with an upright hair strand ("ahoge")       |
| `torso`                      | 4227, 3141, 1062, 2122  | Neck stub, turtleneck, chest, belt, upper trousers to the crotch  |
| `default Arm right top`      | 5076, 3550, 410, 952    | Near upper arm with short sleeve                                  |
| `DEfault arm right bot`      | 5304, 4312, 322, 967    | Near forearm with wristband                                       |
| `DEfault arm right bot Copy` | 5449, 5149, 252, 411    | Near hand, relaxed fist                                           |
| `default arm top L`          | 4137, 3549, 470, 935    | Far upper arm with short sleeve                                   |
| `default arm bot L`          | 3799, 4300, 553, 1004   | Far forearm with wristband and the base of the palm               |
| `default Hand l`             | 1712, 5045, 2580, 1311  | Far hand fingers **merged with the rapier** in one layer          |
| `Leg Top r`, `leg top l`     | see measurements file   | Near and far thigh (trousers)                                     |
| `Leg bot r`, `leg bot L`     | see measurements file   | Near and far shin (trousers to the hem)                           |
| `foot r`                     | 5143, 7686, 272, 649    | Near foot, seen from the front, toes toward the viewer            |
| `fgoot l`                    | 3918, 7613, 654, 505    | Far foot, seen from the side, toes in the facing direction        |

The layers are truly independent. The artist painted hidden geometry under the neighbors:
the thigh tops under the torso, the far upper arm under the torso, the neck stub under the head.

### View and sides

- The source faces **image left**. The near side is image right: the right-side arm and leg layers draw above the torso and the other leg.
- C0.5 faces image right with the near limbs on image left. A horizontal mirror maps the source to the C0.5 view. **Verified** by draw order.
- The rapier is in the **far** hand (image left, drawn under the torso). The C0.5 `weapon_grip` is on `hand_near`.
  The weapon is not part of the 18 slots, so this has no effect on the template.

## 2. License summary

| Point                         | Status                                                                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner statement               | Bought. Commercial use is OK. Redistribution of the sources is not allowed. Never commit it or derivatives                                                                                                                   |
| Archive                       | No license text. `Terms of use.txt` links to the vendor terms page                                                                                                                                                           |
| Vendor terms page (read once) | "Commercial game development use – ok!", "Edits for your project needs – ok!", redistribution of assets, edited or not, "not allowed!", credit to Aekashics required. Use outside game development: "contact me, usually ok" |
| AI services, AI training      | **Not addressed** by the terms page                                                                                                                                                                                          |

Assessment (**Assumption**, not legal advice): a flat dark silhouette with no artwork is an edit for the project's own game asset work.
Gate 2 creates it only in the private project files.
Uploading the silhouette to an external AI service for E2 is a transfer to a third party, which the terms do not address.
That upload needs an explicit owner decision. The vendor can be asked to confirm.

## 3. Jun → C0.5 slot mapping

Classes: **S** source-derived (artist pixels, deterministic operations only), **T** deterministically transformed (cut, trim, hull),
**E** estimated or substituted (geometry not present in the source for that slot).
All slots also get the common operations: mirror, uniform scale, alpha threshold, single fill.

| C0.5 slot        | Source layer(s)              | Exists | Split / merge                                             | Hidden geometry                    | Joint landmarks           | Fits C0.5 setup pose                       | Class  |
| ---------------- | ---------------------------- | ------ | --------------------------------------------------------- | ---------------------------------- | ------------------------- | ------------------------------------------ | ------ |
| `hair_back`      | `back hair`                  | Yes    | None                                                      | Complete                           | Head bone                 | Yes. Hairstyle shape is identity (see D3)  | S or T |
| `head`           | `default head`               | Yes    | Drop `face default`                                       | Complete cranium                   | Cranium top, chin: manual | **Near profile view**, not 3/4 (limit)     | S      |
| `hair_front`     | `front hair`                 | Yes    | None. Optional removal of the upright strand              | Complete                           | Head bone                 | Yes. Identity as `hair_back`               | S or T |
| `neck`           | `torso` (top band)           | No     | **Split** at the neck base, overlap band                  | Stub under the head: complete      | Spine `bone4`             | Yes                                        | T      |
| `torso`          | `torso` (middle band)        | Yes    | **Split** at neck base and waist                          | Shoulders under the arms: complete | Spine `bone3`, `bone4`    | Yes. Torso turn is stronger than 40°       | T      |
| `hips`           | `torso` (bottom band)        | No     | **Split** at the waist (spine joint)                      | Under the thighs: complete         | Spine `bone2`, hip bones  | Yes. Low trousers rim, see section 4       | T      |
| `upper_arm_near` | `default Arm right top`      | Yes    | None                                                      | Shoulder cap: complete             | Spine `bone10`, `bone11`  | Yes, 2.6° from C0.5                        | S      |
| `upper_arm_far`  | `default arm top L`          | Yes    | None                                                      | Complete under the torso           | Spine `bone13`, `bone14`  | 8.5° from C0.5: rigid rotation             | S      |
| `forearm_near`   | `DEfault arm right bot`      | Yes    | None. Trim at wrist + overlap                             | Complete                           | Spine `bone11`, `bone12`  | 4.4° from C0.5                             | S      |
| `forearm_far`    | `default arm bot L`          | Yes    | **Trim** the palm base past wrist + overlap               | Complete                           | Spine `bone14`, `bone15`  | 3.6° from C0.5                             | T      |
| `hand_near`      | `DEfault arm right bot Copy` | Yes    | None                                                      | Complete                           | Spine `bone12`            | Closed fist, not "slightly open" (limit)   | S      |
| `hand_far`       | `default Hand l`             | Merged | Weapon is in the same layer, the guard covers the fingers | **Incomplete** without the rapier  | Spine `bone15`            | Gripping pose, not hanging                 | **E**  |
| `thigh_near`     | `Leg Top r`                  | Yes    | None                                                      | Top under the torso: complete      | Spine `bone16`, `bone17`  | 8.5° from C0.5: rigid rotation             | S      |
| `thigh_far`      | `leg top l`                  | Yes    | None                                                      | Complete                           | Spine `bone19`, `bone20`  | 1.5° from C0.5                             | S      |
| `shin_near`      | `Leg bot r`                  | Yes    | None                                                      | Knee overlap: complete             | Spine `bone17`, `bone18`  | Length 1.35 × target (see D4)              | S or T |
| `shin_far`       | `leg bot L`                  | Yes    | None                                                      | Knee overlap: complete             | Spine `bone20`, `bone21`  | Length 1.28 × target (see D4)              | S or T |
| `foot_near`      | `foot r`                     | Yes    | None                                                      | Complete                           | Spine `bone18`            | **No**: front view, toes toward the viewer | **E**  |
| `foot_far`       | `fgoot l`                    | Yes    | None                                                      | Complete                           | Spine `bone21`            | Yes after mirror: toes to screen right     | S      |

Summary: 11 slots S, 4 slots T (`neck`, `torso`, `hips`, `forearm_far`), 2 slots E (`hand_far`, `foot_near`),
and the hair and shin slots depend on decisions D3 and D4.
No slot needs generative reconstruction. The proposed substitutions use other Jun layers (see D2).

## 4. Geometry validation

### Landmarks

- **Limb, neck, and waist joints:** the artist Spine bones. A least-squares fit of the 18 region attachment centers to the PSD layer centers
  gives 17.94 PSD px per Spine unit with residuals of 8 px or less (0.13 % of the figure height). **Verified** by the fit.
  The knee and elbow bones agree with the centroids of the parent and child layer overlaps within 5–40 px.
- **Cranium top:** top of `default head` (y 2550). **Chin:** manual, (4480, 3370), ±15 px.
- All values are in `e2-gate1-measurements.json` (project files). The landmark diagnostic image shows them on the source silhouettes.

### Scale normalization

The E1 protocol uses the thigh: `s` = mean thigh length / 292 (C0.5 thigh). For Jun, mean thigh = 1174 px, so `s` = 4.021 source px per contract px.
A second normalization by height (cranium top to mean ankle, 5242 / 1196) gives `sH` = 4.383. It is reported for comparison only.

### Proportions: native and normalized

| Measurement (joint to joint)          | Jun native (px) | Jun / T | C0.5 / T | Ratio at `s` (thigh) | Ratio at `sH` (height) |
| ------------------------------------- | --------------- | ------- | -------- | -------------------- | ---------------------- |
| Thigh T (near / far)                  | 1215 / 1133     | 1.00    | 1.00     | 1.03 / 0.97          | 0.95 / 0.89            |
| Shin (near / far)                     | 1587 / 1509     | 1.32    | 1.00     | **1.35 / 1.28**      | **1.24 / 1.17**        |
| Upper arm (near / far)                | 783 / 866       | 0.70    | 0.75     | 0.89 / 0.99          | 0.81 / 0.91            |
| Forearm (near / far)                  | 783 / 821       | 0.68    | 0.65     | 1.04 / 1.06          | 0.96 / 0.97            |
| Head, cranium top to chin             | 820             | 0.70    | 0.61     | **1.15**             | 1.06                   |
| Neck, chin to neck base               | 202             | 0.17    | 0.18     | 0.95                 | 0.87                   |
| Torso, neck base to waist             | 913             | 0.78    | 0.88     | 0.89                 | 0.82                   |
| Pelvis, waist to hip joints           | 598             | 0.51    | 0.42     | 1.20                 | 1.10                   |
| Shoulder joint width (image x)        | 621             | 0.53    | 0.79     | **0.67**             | 0.62                   |
| Hip joint width (image x)             | 460             | 0.39    | 0.42     | 0.94                 | 0.86                   |
| Cranium top to mean ankle             | 5242            | 4.47    | 4.10     | 1.09                 | 1.00                   |
| Hand, wrist to fingertips (near fist) | 386             | 0.33    | 0.47     | 0.70                 | 0.64                   |

Other ratios: upper arm / forearm = 1.03 (C0.5 1.16). Shin / thigh = 1.32 (C0.5 1.00). Heads to the ankle: 6.39 (C0.5 6.76).

### Orientation, widths, overlaps (after mirror, at `s`)

| Limb             | Axis difference to C0.5 | Mid width / fixture mid width | Overlap past proximal joint (T) | Past distal joint (T) |
| ---------------- | ----------------------- | ----------------------------- | ------------------------------- | --------------------- |
| `upper_arm_near` | −2.6°                   | 0.95                          | 0.09                            | 0.08                  |
| `upper_arm_far`  | +8.5°                   | 1.23                          | 0.04                            | 0.02                  |
| `forearm_near`   | −4.4°                   | 0.95                          | 0.07                            | 0.09                  |
| `forearm_far`    | +3.6°                   | 0.82                          | 0.10                            | 0.11 (palm base)      |
| `thigh_near`     | −8.5°                   | 1.15                          | 0.20                            | 0.16                  |
| `thigh_far`      | +1.5°                   | 1.07                          | 0.21                            | 0.12                  |
| `shin_near`      | −5.6°                   | 0.84                          | 0.12                            | 0.01                  |
| `shin_far`       | −1.3°                   | 0.93                          | 0.13                            | 0.03                  |

The fixture mid widths come from the E1 reference shapes (`sheet-fixture`). They are mock shapes, not a contract value.
All scaled part boxes fit inside their C0.5 attachment rectangles, except `shin_near` (433 px long with overlaps, rectangle height 381)
and `foot_near` (68 × 161, rectangle 157 × 118). The far foot fits well: 163 × 126 against 162 × 118.

### Interpretation

| Difference                                 | Cause (Assumption, from visual inspection)                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Long shins (+28–35 %)                      | **Stylistic.** Fashion-illustration leg length. Knee position is confirmed by bones and overlaps  |
| Head +15 % at thigh scale                  | Stylistic (anime head). Much closer than the generated sheets R1 (1.35) and R4 (1.57)             |
| Narrow shoulders (0.67), near-profile head | **Perspective.** Jun's upper body and head are turned more than 40°. The head is almost a profile |
| Long pelvis (1.20), short torso (0.89)     | Rig construction: the artist's spine joint is at the natural waist, the trousers rim is low       |
| Upper arm near/far asymmetry               | Perspective and drawing. The 3/4 view foreshortens the near arm                                   |
| Fist hand (0.70)                           | Pose: closed hand, not "slightly open"                                                            |

Jun is **not** geometrically authoritative for C0.5. The arms, thighs, neck, hip width, and far foot agree within about ±10 %.
The shins, the head yaw, and the shoulder width do not.

## 5. Missing geometry and incompatibilities

1. **`hand_far`**: the fingers are in one layer with the rapier, and the guard covers them. A clean hand silhouette needs reconstruction.
2. **`foot_near`**: front view with the toes toward the viewer. C0.5 needs toes toward screen right.
3. **Head view**: near profile. The C0.5 head is front-visible 3/4. A silhouette cannot fix this deterministically. Recorded as a limit.
4. **Shins**: 1.28–1.35 × the C0.5 length at thigh scale. This contradicts prompt v3.1 Section A.3 ("shin 1.0 T").
5. **Hair**: the hair silhouettes carry Jun's bob haircut and pointed locks, which is a part of Jun's identity.
6. **Split edges**: `neck`/`torso`/`hips` and the `forearm_far` wrist get straight cut edges. They are geometry normalization, not source contours.
7. **Hands**: the near hand is a closed fist. Prompt v3.1 asks for slightly open hands.

## 6. Proposed deterministic transformation (Gate 2 recipe)

Proposed. Every step is pure geometry. No generative model. Each step is recorded in the provenance file.

1. Verify the archive SHA-256 and the PSD SHA-256. Read the 17 default-pose layers. Keep the originals unchanged.
2. Silhouette: alpha ≥ 128 → inside. Keep the largest connected component. Fill internal holes.
3. Splits of `torso` (source px): `neck` = y < 3572 + b, `torso` = 3572 − b ≤ y < 4485 + b, `hips` = y ≥ 4485 − b.
   b = 24 contract px × `s` (the C0.5 overlap radius) = 97 source px. The overlap band is duplicated source pixels, not new shapes.
4. Trim both forearms along the bone axis at wrist + b.
5. Apply decisions D2–D4.
6. Mirror horizontally (parts and landmarks).
7. Scale every part by 1 / `s` = 1 / 4.021 (one uniform scale for all parts). Area-average resampling, then a 2-level antialiased edge.
8. Rotate each limb rigidly about its proximal joint to the C0.5 bone angle (−8.5° to +8.5°, see the table above). No shear, no stretch.
   Rotate each foot so that the sole line is horizontal, and record the angle.
9. Fill all 18 parts with one neutral dark color (`#2b2b2b`, opaque). Transparent background. No lines, labels, or markers.
10. Place the parts on 1024 × 1536 in the prompt v3.1 rows and order (as the E1 reference, near item first), with gaps of 17 px or more.
    Row positions follow the part heights. Estimate: rows 253 + 275 + 240 + 433 px plus gaps = about 1290 px, so the sheet fits.
11. Write the `aigg.modular-sheet/0.1` descriptor (boxes and joints) and run `sheet-check`. It must PASS.
12. Render variant B (annotated map) from the same data: slot labels, boxes, joints, near/far marks, class S/T/E per slot.
13. Write the provenance JSON: source hashes, C0.5 contract hash, per-slot mapping, source and output boxes, source and output landmarks,
    transforms, splits, substitutions, output file and raw RGBA hashes.

Tooling (Proposed): one research script in the project files, like `make-reference.mjs` for E1, in Node.js and TypeScript style.
It needs a small PSD layer reader (raw and RLE channels), about 100 lines, and no new dependency.
The Gate 1 measurements used short Python scripts (Pillow and NumPy in the agent container) because no Node.js PSD reader exists in the repository.
They are measurement tools only and stay in the project files. No generic asset-processing framework.

## Owner decisions

| Id  | Decision                                                                | Options                                                                                                                                      | Recommendation                                                                                  |
| --- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| D1  | Accept Jun `Sliced PSD` as the E2 source and the license interpretation | Accept / Reject                                                                                                                              | Accept for private use. Decide the AI-service upload separately (D5)                            |
| D2  | Substitutions for `hand_far` and `foot_near`                            | (a) copy the near hand / far foot silhouette, mark class E; (b) keep the source shapes, mark them as defects; (c) reconstruct by hand        | (a): no new shape is invented, paired limbs share dimensions                                    |
| D3  | Hair shapes                                                             | (a) native Jun hair; (b) convex hull of each hair layer (size and roots stay, the haircut is removed); (c) rectangles as E1                  | (b): keeps size and placement, reduces identity transfer                                        |
| D4  | Shin length                                                             | (a) native Jun shins (honest, contradicts Section A.3); (b) remove a straight mid-shaft section to 1.0 T, ends and widths unchanged, class T | (b) if the goal is C0.5 compatibility. (a) gives a template that conflicts with the prompt text |
| D5  | Upload of the variant A silhouette to the E2 generation service         | Allow / Do not allow / Ask the vendor first                                                                                                  | Owner choice. The terms do not address AI services                                              |

Decisions D1–D5 are not recorded in [the decision log](../DECISIONS.md). A human closes them.

## 7. E2 experiment addendum

E2 adds condition C to E1. It does not change conditions A and B, their prompt, their reference, or their results.

| Condition                    | Input                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| A (from E1)                  | Prompt v3.1 only. Reuse the E1 sheets. Do not generate them again                                         |
| B (from E1)                  | Prompt v3.1 + E1 synthetic reference. Reuse the E1 sheets                                                 |
| **C: text + Jun silhouette** | The full text of `v3.1.md`, then the addendum below, and the approved variant A image in the same message |

SECTION A and SECTION B stay byte-identical to E1. Use the same service and model as E1, a new conversation per sheet, 3 sheets, first image only.

Addendum for condition C (paste after the prompt text, unchanged):

```text
# GEOMETRY REFERENCE

The attached image is a geometry reference. It shows 18 flat dark silhouettes in the same rows and order as Section A.2.

Use it only for the geometry: the outline, the relative size, the rest orientation and the position of each part on the canvas.

The silhouettes come from a different character. Do not copy that character's identity, hairstyle, face, costume or any other detail that the silhouettes suggest.

Do not copy the flat dark fill. Every part follows Section A and Section B.
```

Measurement: the E1 protocol without changes, plus these items for condition C:

- Reproduction of reference identity: Jun hairstyle outline, rapier or grip pose, fist hands, near-profile head. Yes or no per item.
- The human review of E1 (identity, clothing, style). A geometry gain that consistently loses the Section B identity is a failure.
- Three sheets per condition are exploratory evidence, not statistical proof.

E2 generation starts only after a separate owner approval of the variant A image.

## 8. Acceptance criteria for the template (Gate 2)

From the task, unchanged: explicit mapping for all 18 slots, disclosed estimated geometry, traceable landmarks, measured proportions,
no source texture, face, color, or line art in variant A, 18 regions extractable without overlap, `sheet-check` PASS,
visual check against variant B, license allows the use, and owner approval before any generation.
A silhouette does not guarantee correct joints or correct animations.

## Files in the project files (not in Git)

`research/v2-m1-e2/gate1/`:

- `e2-gate1-measurements.json`: hashes, layer boxes, Spine-to-PSD fit, joints, limb measurements.
- `e2-gate1-landmarks.png`: source silhouettes with joints and proposed cut lines. Derivative of licensed art: private, never commit.
- `scripts/`: the measurement scripts.

## Gate 2 result

**Draft.** Prototype for owner visual approval. Not approved. No image generation. No change to C0.5 or to Pipeline v2.

### Owner decisions for Gate 2

The owner approved D1–D5 with limitations:

| Id  | Decision                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Jun `Sliced PSD` and the Spine 3.7.92 skeleton are the experimental source. Jun is not an anatomical standard. C0.5 stays authoritative              |
| D2  | `hand_far` and `foot_near` are deterministic substitutes from other Jun parts, marked `estimated`                                                    |
| D3  | Neutral, smoothed hair envelopes replace the Jun hairstyle outlines                                                                                  |
| D4  | Both shins are normalized to the C0.5 knee-to-ankle length by a recorded mid-shaft excision. No nonuniform stretch                                   |
| D5  | Upload of the final silhouette reference to ChatGPT for E2 only. The vendor terms do not address AI services: an unresolved third-party license risk |

### Method

One research script (`research/v2-m1-e2/gate2/scripts/make-template.mjs` in the project files, Node.js, uses `@aigg/control` PNG and raster code, no new dependency) builds **one normalized geometry dataset**.
Each slot has one mask and one set of landmarks. Every image is rendered from this dataset with integer translations only.

Order of operations:

1. Verify the SHA-256 of the PSD, the Spine JSON, and the C0.5 contract.
2. Read the alpha channel of the default-pose PSD layers.
3. Compute the artist joints: Spine setup-pose FK, least-squares fit to the PSD layer boxes (maximum residual 7.6 px).
4. Mirror (`x' = 8000 − x`).
5. One global scale: mean artist thigh / 292 = 4.0207 source px per contract px.
6. Per part: band split or trim, D4 excision, rigid rotation to the C0.5 rest direction.
7. Silhouette: 4 × 4 supersampling of source alpha ≥ 128, largest component, hole fill.
8. D3 hair envelopes and D2 substitutes. Tight crop. Canonical mask and landmarks.
9. Placements: assembled (anchor landmark on the C0.5 joint) and inventories, translation only.

Rigid rotations (degrees, output to source): `torso` −14.6, `hips` +9.8, `neck` −0.3, limbs −8.4 to +8.5, hands to the forearm direction, feet +18.7 (sole level).
The torso, hips, and neck rotations align their landmark axes with the C0.5 spine. The Jun torso leans about 15° in the source.

### D2–D4 handling

| Item         | Operation                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hand_far`   | Near-hand (fist) silhouette, rotated to the far forearm direction. `estimated`. A fist is not neutral hand geometry                                   |
| `foot_near`  | Far-foot silhouette, identical mask. `estimated`                                                                                                      |
| `hair_back`  | Convex hull, then morphological opening (radius 24 px). The haircut outline is removed                                                                |
| `hair_front` | Closing (radius 10) and opening (radius 14). A hull would cover the face. Rounded lobes of the side locks remain                                      |
| Shins        | Excision of a straight shaft band: 409.5 source px (near) and 331.9 source px (far), at the position with the smallest width step (0 and 3 source px) |

### Classification and normalized geometry

Classes: `direct` 8 (`head`, upper arms, `forearm_near`, `hand_near`, thighs, `foot_far`), `transformed` 8 (`hair_back`, `hair_front`, `neck`, `torso`, `hips`, `forearm_far`, shins), `estimated` 2 (`hand_far`, `foot_near`).

| Measurement                 | Normalized (px) | C0.5 (px)     | Ratio         |
| --------------------------- | --------------- | ------------- | ------------- |
| Thigh near / far            | 302.2 / 281.8   | 292.1         | 1.035 / 0.965 |
| Shin near / far             | 293.2 / 293.0   | 293.2 / 293.0 | 1.000 / 1.000 |
| Upper arm near / far        | 194.8 / 215.4   | 219.5 / 218.0 | 0.887 / 0.988 |
| Forearm near / far          | 194.8 / 204.4   | 186.6 / 193.4 | 1.044 / 1.057 |
| Head, mask top to chin      | 204.1           | 177           | 1.153         |
| Neck, base to head joint    | 63.4            | 53.6          | 1.184         |
| Torso, waist to neck base   | 235.2           | 257           | 0.915         |
| Shoulder joint distance     | 155.1           | 231           | 0.671         |
| Pelvis, waist to hip joints | 151.2           | 124           | 1.220         |
| Hip joint distance          | 114.6           | 122           | 0.939         |

All 8 limb rest angles equal the C0.5 bone angles (rigid rotation).

### Validation

- **`ONE_SHARED_SCALE: PASS`.** For all 18 slots, the assembled view and the four inventory placements use the same mask (same SHA-256),
  the same size, and the same landmark distances. All placements are integer translations. The mask pixels decoded from
  `inventory-clean.png` and `generation-reference.png` equal the canonical masks.
- Inventory: 18 slots, no box overlap, no clipping, each box = silhouette bounds + 4 px.
- `sheet-check` on `inventory-clean.png` with its descriptor: **PASS** (P1–P5). Hair joints are left out of the descriptor because the head joint is outside the hair art.
- Assembled: C0.5 draw order, anchor residual 0 px, all 17 joint pairs overlap (no disconnected part).
- The script is deterministic: two runs gave the same image hashes.

### Known defects (not hidden)

- Art-joint gaps in the assembled figure: far shoulder 56.7 px, near shoulder 27.0 px, waist 27.2 px, neck base 21.8 px, near elbow 24.7 px, others ≤ 12.2 px.
  The cause is Jun's narrower, more turned torso (shoulders 0.67) and the shorter near upper arm. The parts still overlap.
- The head is a near-profile view (front-visible 3/4 in C0.5). The head is 1.15 × the C0.5 head.
- Straight cut edges at the neck, waist, and far wrist. The torso cut is slanted after the torso rotation.
- The front hair envelope still covers the upper face, as the source bangs do.
- The shins keep the bunched trouser hem at the ankle.

### Outputs (project files, private, never commit)

`research/v2-m1-e2/gate2/`: `assembled-reference.png`, `assembled-clean.png`, `parts-inventory.png`, `anatomy-map.png`,
`generation-reference.png` (1563 × 1536, clean assembled silhouette and inventory with plain grey boxes, no text, no markers, display scale 1),
`inventory-clean.png` and `inventory-clean.sheet.json` (sheet-check input), `anatomy-map.provenance.json`, `anatomy-map.validation.json`,
`sheet-check/`, `SHA256SUMS`, and `e2-gate2-outputs.tar.gz` (exact bytes: the project file store can add metadata chunks to loose PNG files).

E2 generation needs a separate owner approval of the reference image. Use the file SHA-256 of the exact file that is uploaded.

## Owner map (primary geometry reference)

The owner made a manual anatomy and parts map of Jun from the Sliced PSD layers. The owner decided:

| Item                       | Decision                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary geometry reference | The owner map. The Gate 2 map is a comparison artifact only.                                                                                         |
| Master source              | The owner PSD (10000 × 10000, SHA-256 `00e7f8fd…9190`). The owner PNG (8000 × 8000, the PSD at 0.8, SHA-256 `9815e11f…a5ef`) is the human reference. |
| Orientation for E2         | The mirrored set (`x' = W - x`), which faces image-right as C0.5. The source set (faces screen-left) stays private as provenance.                    |
| Model input for E2         | Only the clean mirrored `generation-reference.png` (2000 × 2050, SHA-256 `ef3c483b…8168`).                                                           |
| QA only, not model input   | `assembled-reference.png`, `parts-inventory.png`, `generation-reference-boxes.png`.                                                                  |
| Neck                       | Stays inside the torso part. This is a known limitation. The contract does not change. It does not block E2.                                         |

### What the owner map contains

- Each part is a Jun Sliced PSD layer at 1:1. 14 of 18 part masks are identical to the Jun layers.
  The owner removed the rapier from the far hand, split the torso into a top part (with the neck) and a bottom part, and trimmed the shins and feet a little.
- The assembled figure is the Jun setup pose, moved by (+1910, +192). There is no scale and no mirror.
- The inventory uses the same masks, moved only. Thus one scale applies to all parts.
- 16 landmarks (shoulders, elbows, wrists, hips, knees, ankles, waist, neck base, eyes, mouth) and the cranium top and chin lines.
  `Right` is near and `Left` is far, as in C0.5. The owner put `Neck base` behind the ear.

### Derived set

A script (private, `research/v2-m1-e2/user-map/scripts/build.py`) makes all files from the PSD layers. It uses masks only (alpha 128 or more),
translation, and an optional horizontal mirror. It does not scale or repaint a part. Each composite has one display downscale (1/5) for the full image.
The canvas is 250 px taller at the bottom because `foot_near` touches the PSD edge. The face layer is merged into the head mask.
The owner colour of `hair_back` is black (not visible on black), so the script uses a lilac colour.

Proportions from the owner landmarks, as a ratio to C0.5 (T = mean thigh length, 1291 source px):

| Part                       | Near | Far  |
| -------------------------- | ---- | ---- |
| Thigh                      | 1.06 | 0.94 |
| Shin                       | 1.13 | 1.14 |
| Upper arm                  | 0.77 | 0.81 |
| Forearm                    | 1.01 | 1.03 |
| Head (cranium top to chin) | 1.05 |      |

Validation:

- Same mask in the three PSD groups (inventory, coloured assembly, black assembly) for all 17 parts. Same part sizes in the assembled view and the inventory.
- All 14 body landmarks are inside the mask of their own part. No box overlaps. Two runs give identical files.
- `sheet-check` with the C0.5 candidate contract: ERROR, only `E_SHEET_REQUIRED_MISSING` for `neck` (expected).
  A diagnostic run with a private copy of the contract where `neck` is optional: PASS. The C0.5 contract does not change.

Outputs (project files, private, never commit): `research/v2-m1-e2/user-map/` (`source/`, `map.json`, `parts/`, `native/`, `mirrored/`, `scripts/`,
`README.md`, `SHA256SUMS`) and `research/v2-m1-e2/user-map.tar.gz`.
E2 generation needs a separate owner approval.
