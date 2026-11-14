# L0-1c: alignment and joint feasibility study

**Draft. Research result.** This report does not close a decision. It does not approve a joint, a pivot, a cut, a part, or a package. It does not change the C0.5 template or the rig contract.
The images of this study are derivatives of the L0 test concept. They stay in the project shared folder. They are not in Git.

## tl;dr

We measured anatomical landmarks on the See-through L0-1 layers of the test concept and compared them with the joints of the C0.5 template. The tool uses only deterministic geometry: no GPU, no model, and no change to the art.
The character aligns **partially**. One global similarity transform (scale and position, no warp) places the head, neck, wrists, and ankles on the template with a mean error of 2.7 % and a maximum of 5.3 % of the body height. The template tolerances are 1.5 % and 2.5 %, so the fit is good for placement and comparison, but not for the contract.
The hips, both knees, the near elbow, and both shoulders are hidden by clothing, hair, or the torso. Geometry cannot find them without a guess, so the tool keeps them as `unknown` ranges or low-confidence proxies. These joints, the merged thighs under the skirt, and the sword in the far hand block part cuts.

## 1. Scope and limits

- Input: the L0-1 output files (`concept-mirrored/<tag>.png`, 1280 x 1280 RGBA, `concept-mirrored.psd.json`) and the See-through input image `src_img.png` (1280 x 1280, a resize of `concept-mirrored.png`).
- Template: `packages/control/test/fixtures/c05-candidate/rig.contract.json` (`rig_c05_candidate`, contract version 0.3.0, 1024 x 1536, `three_quarter_right`, `near_far`).
- Local run only. No GPU, no model, no inference, no network, no new dependency. The input hashes before and after the run are equal.
- Tool: `aigg-control align-study` (`@aigg/control` 0.8.0, prototype). See [the package README](../../packages/control/README.md#alignment-study-l0-1c).
- Out of scope: cuts, repaint, generative completion, automatic rigging, Spine import or export, and changes to the template or the contract.
- One character only. The color rules for the wrist band, the sleeve, and the tie are specific to this concept (section 3.2). The results do not prove a general method.

## 2. Task A: C0.5 template audit

Source: the contract fixture above. The `head` joint is the chin (`figure.ts`, `headShape`). Coordinates are contract pixels, y down. Subject right is near and image-left.

| Joint            | x, y     | Parent           | Segment to child          | Overlap at the joint (parent slot, radius) |
| ---------------- | -------- | ---------------- | ------------------------- | ------------------------------------------ |
| `root`           | 512,1490 | none             | root to hips              | none                                       |
| `hips`           | 512,835  | `root`           | hips to spine, thighs     | none                                       |
| `spine`          | 512,737  | `hips`           | spine to chest            | none                                       |
| `chest`          | 512,622  | `spine`          | chest to neck, upper arms | none                                       |
| `neck`           | 510,480  | `chest`          | neck to head              | none                                       |
| `head` (chin)    | 518,427  | `neck`           | head (slots `head`, hair) | none                                       |
| `upper_arm_near` | 394,507  | `chest`          | 220 px to `forearm_near`  | none                                       |
| `forearm_near`   | 337,719  | `upper_arm_near` | 187 px to `hand_near`     | `upper_arm_near`, 24 px                    |
| `hand_near`      | 322,905  | `forearm_near`   | hand slots, `weapon_grip` | `forearm_near`, 24 px                      |
| `upper_arm_far`  | 625,507  | `chest`          | 218 px to `forearm_far`   | none                                       |
| `forearm_far`    | 676,719  | `upper_arm_far`  | 194 px to `hand_far`      | `upper_arm_far`, 24 px                     |
| `hand_far`       | 729,905  | `forearm_far`    | hand slot                 | `forearm_far`, 24 px                       |
| `thigh_near`     | 451,861  | `hips`           | 292 px to `shin_near`     | none                                       |
| `shin_near`      | 457,1153 | `thigh_near`     | 293 px to `foot_near`     | `thigh_near`, 24 px                        |
| `foot_near`      | 447,1446 | `shin_near`      | foot slot                 | `shin_near`, 24 px                         |
| `thigh_far`      | 573,861  | `hips`           | 292 px to `shin_far`      | none                                       |
| `shin_far`       | 579,1153 | `thigh_far`      | 293 px to `foot_far`      | `thigh_far`, 24 px                         |
| `foot_far`       | 577,1446 | `shin_far`       | foot slot                 | `shin_far`, 24 px                          |
| `weapon_grip`    | 329,923  | `hand_near`      | slot `weapon`             | none                                       |

Named points: `head_top` (512,250), `face_nose` (575,374), `face_eye_near` (519,347), `face_eye_far` (568,347), `face_ear_near` (449,347).
Tolerances: joint error at most 2.5 % of the body height, mean at most 1.5 %, segment length ratio 0.95 to 1.05.

**Missing in the template** (the character data has them, the template has no point): head center, mouth, a torso front mark (sternum or tie), sleeve ends, and a foot anchor (sole contact or toe). The template has no clavicle, no separate shoulder point (the shoulder is the `upper_arm_*` joint), and no hip or knee overlap with the skirt.
Image requirements of the template: one character, full body, three-quarter view facing image-right, near limbs on image-left, the weapon in the near hand, both feet on one ground line (orthographic, no camera height).

## 3. Task B: landmarks of the character

### 3.1 Results

Coordinates are in the 1280 x 1280 See-through frame, y down. Side names are image sides. Visibility: `visible` (drawn), `occluded` (the joint is under a drawn item, the point comes from that item), `inferred` (derived from the outline, not drawn), `unknown` (no point, only a range).

| Landmark                   | x, y          | Range (x, y)           | Visibility | Confidence | Method and note                                                              |
| -------------------------- | ------------- | ---------------------- | ---------- | ---------- | ---------------------------------------------------------------------------- |
| `head_top`                 | none          | x 478–589, y 60–88     | unknown    | none       | Hair hides the skull top. The range is from the hair top to the face top.    |
| `head_center`              | 533.9, 148    | x 478–589, y 88–219    | inferred   | low        | Face layer centroid. A proxy: the skull center is behind the face.           |
| `chin`                     | 551, 217.2    |                        | visible    | medium     | Lowest 3 rows of the face layer.                                             |
| `nose`                     | 567.8, 165.7  |                        | visible    | high       | Nose layer centroid.                                                         |
| `mouth`                    | 553.1, 184.1  |                        | visible    | high       | Mouth layer centroid.                                                        |
| `eye_image_left`           | 532.1, 134    |                        | visible    | high       | Iris component centroid.                                                     |
| `eye_image_right`          | 574.6, 155.7  |                        | visible    | high       | Iris component centroid.                                                     |
| `neck_base`                | 516, 258.7    |                        | occluded   | medium     | Lowest 10 rows of the neck layer. The collar hides it.                       |
| `torso_front_mark`         | 562.6, 334.6  |                        | visible    | high       | Red tie pixels. A front midline cue.                                         |
| `shoulder_image_left`      | 459.4, 271.6  | x 421–492, y 248–288   | inferred   | low        | Sleeve cap centroid. The sleeve and hair hide the joint.                     |
| `shoulder_image_right`     | 637.8, 353.4  | x 625–653, y 332–367   | inferred   | low        | Visible sleeve cap only. The torso hides most of this shoulder.              |
| `sleeve_end_image_left`    | 450.2, 365.2  |                        | visible    | high       | Sleeve hem. A clothing edge, not a joint.                                    |
| `sleeve_end_image_right`   | 639.4, 366.3  |                        | visible    | high       | Sleeve hem.                                                                  |
| `elbow_image_left`         | none          | x 275–492, y 366–610   | unknown    | none       | The arm is almost straight (bend 4.5°). The outline does not show the elbow. |
| `elbow_image_right`        | 641.8, 441.5  | x 589–822, y 367–603   | inferred   | medium     | Break of a two-segment fit on drawn pixels, bend 37.3°.                      |
| `wrist_image_left`         | 323.8, 610.5  |                        | occluded   | medium     | Top of the blue wrist band. The band covers the joint.                       |
| `wrist_image_right`        | 760.4, 603.8  |                        | occluded   | medium     | Top of the blue wrist band (sword hand).                                     |
| `hip_image_left`, `_right` | none          | x 409–666, y 504–728   | unknown    | none       | The skirt hides the hips. The thighs are one merged shape (L0-1b).           |
| `knee_image_left`          | none          | x 377–546, y 728–1137  | unknown    | none       | The leg is almost straight below the skirt (bend 7.2°). Black stocking.      |
| `knee_image_right`         | 589.5, 1014.5 | x 549–662, y 728–1132  | inferred   | low        | Bend 14.3°. Probably the calf outline, not the knee (section 4.2).           |
| `ankle_image_left`         | 396.5, 1137.1 | x 377–415, y 1119–1155 | occluded   | medium     | Shoe and stocking overlap (shoe collar). The shoe hides the joint.           |
| `ankle_image_right`        | 598.9, 1132.5 | x 581–620, y 1122–1141 | occluded   | medium     | Shoe collar.                                                                 |
| `foot_anchor_image_left`   | 390.5, 1257.4 | x 348–429, y 1119–1261 | visible    | high       | Lowest 6 rows of the shoe (sole contact).                                    |
| `foot_anchor_image_right`  | 650.6, 1236.6 | x 556–688, y 1122–1240 | visible    | high       | Lowest 6 rows of the shoe.                                                   |

Totals: 10 visible, 5 occluded, 5 inferred, 5 unknown. Of the 19 landmarks that have a template joint or point, 10 have medium or high confidence.

### 3.2 Method and assumptions

- See-through completes the parts that other parts hide. The tool compares each layer pixel (alpha 128 or more) with the input image. A pixel with a channel difference above 32 is a completion, not drawn evidence. The draw order cannot show this, because one `handwear` layer holds both arms and is in front of `topwear`. Completed share: image-left arm 7.3 %, image-right arm 28.4 %, legs 1.7 % and 2.5 %.
- Elbow and knee: the break point of a two-segment fit of the row centerline of the drawn pixels only. The break must leave 20 % of the rows on each side. A bend below 10° gives `unknown`. A break point on a completed pixel would be `occluded` with low confidence.
- The wrist band, sleeve, and tie are found by color rules (blue, white, red). These rules are specific to this concept. They are listed in `landmarks.json`.
- No landmark uses a fixed fraction of a limb. No landmark uses a template coordinate.
- A manual pass is possible: `landmarks-manual.template.json` lists all ids as `unknown`. A person adds points only where they can see them. The tool refuses `x` and `y` on an `unknown` entry.

## 4. Task C: alignment study

### 4.1 Global fits

Residuals in % of the template body height (1240 px). "Medium+" uses the 10 landmarks with medium or high confidence. "Low+" adds the low-confidence shoulders and knee (13).

| Hypothesis         | Fit        | Set     | Mean % | Max % | Scale s1 / s2 | Rotation | Reflection |
| ------------------ | ---------- | ------- | ------ | ----- | ------------- | -------- | ---------- |
| near = image-left  | uniform    | medium+ | 2.71   | 5.45  | 1.096         | 0°       | no         |
| near = image-left  | similarity | medium+ | 2.68   | 5.34  | 1.097         | −1.1°    | no         |
| near = image-left  | affine     | medium+ | 2.18   | 4.11  | 1.122 / 0.917 | 0.8°     | no         |
| near = image-left  | similarity | low+    | 3.94   | 10.28 | 1.058         | −1.6°    | no         |
| near = image-right | similarity | medium+ | 14.99  | 34.23 | 0.934         | −2.0°    | no         |
| near = image-right | affine     | medium+ | 3.22   | 7.30  | 1.135 / 0.919 | 33.6°    | **yes**    |

Similarity residuals per landmark (near = image-left, medium+): left eye 0.6, neck base 1.0, nose 1.6, right eye 2.4, chin 2.5, left wrist 2.5, right elbow 3.3, right ankle 3.1, left ankle 4.4, right wrist 5.3.

- A uniform scale already gives the similarity result. The figure needs no global rotation (about −1°).
- An affine fit gains only 0.5 points. It needs an anisotropy of 1.22 (wider in the image than the template in x), and that distorts the face.
- Under near = image-right, only an affine fit with a reflection fits. A reflection is a mirror image, not a pose, so this hypothesis is rejected.

### 4.2 Segments and triangles (near = image-left, after the similarity fit)

| Segment                         | Length ratio | Angle difference | Confidence | Reading                                                          |
| ------------------------------- | ------------ | ---------------- | ---------- | ---------------------------------------------------------------- |
| whole near arm (shoulder–wrist) | 0.99         | +10.4°           | low        | Same length. The arm is closer to the body: pose.                |
| whole far arm                   | 0.74         | −12.6°           | low        | Shorter, because the torso hides the shoulder. Not anatomy.      |
| far forearm                     | 1.14         | −21.4°           | medium     | The forearm swings out to hold the sword: pose.                  |
| far upper arm                   | 0.44         | +9.8°            | low        | The far shoulder proxy is wrong. Not measurable.                 |
| far shin (knee–ankle)           | 0.44         | −6.1°            | low        | The knee point is too low: the bend is the calf. Not measurable. |
| shoulder line                   | 0.93         | +23.5°           | low        | The far shoulder proxy is too low. Not measurable.               |
| ankle line                      | 1.71         | −2.4°            | medium     | Feet are 1.7 times wider apart: pose (stance), not anatomy.      |
| neck to chin                    | 1.11         | +30.4°           | medium     | The head tilts and turns more than in the template: pose.        |

Triangle maps (exact affine map of three landmarks): face (eyes, nose) anisotropy 2.46 with a rotation of −39°; shoulders and neck 5.40; wrists and neck 1.31; ankles and neck 1.72. No triangle has a reflection under near = image-left. All have a reflection under near = image-right.

### 4.3 Answers

1. **Parts that align without strong deformation:** head and neck (residuals 0.6 % to 2.5 %), the near arm length (ratio 0.99), the wrists (2.5 % near, 5.3 % far), and the general scale of the body (one uniform scale, no rotation).
2. **Where proportions differ:** the stance (ankle line 1.71), the face (the eye–nose triangle is 2.5 times more anisotropic: more head turn and tilt), and the far arm length in the image (0.74, from occlusion). The thigh to shin ratio cannot be measured, because the hips and knees are unknown.
3. **Pose or anatomy:** the head tilt (30°), the far forearm angle (−21°), the near arm angle (10°), and the stance width come from the pose. The foot height difference (the image-left sole is 21 px lower) comes from the camera height, which the orthographic template does not have. The measured arm length agrees with the template, so we see no anatomy difference in the arms. For the legs and the torso length, the data is not sufficient.
4. **Hidden joints:** hips (skirt and merged thighs), both knees (straight legs in black stockings), the near elbow (straight arm), the far shoulder (torso and bust), the near shoulder (sleeve and hair), the head top (hair), the neck base (collar), the wrists (bands), and the ankles (shoes). The last four have an occluding item with a clear position, so they have medium confidence.
5. **Consistent joint map:** partially. Under near = image-left, one consistent map exists for the head, neck, wrists, ankles, and the far elbow. It does not exist for the hips, knees, near elbow, and shoulders without human marks.
6. **Transforms that damage the art:** a reflection (it flips the sword hand, the light direction, and the asymmetric hair and clothing details). A non-uniform scale (anisotropy 1.22 makes the face and glasses oval). Piecewise affine maps of the face (anisotropy 2.46) and of the shoulders (5.40), which would tear the face and the collar. Rigid rotations of limbs about unknown pivots, which open gaps in sleeves, skirt, and stockings and need repaint. A uniform scale and a translation do not damage the art.

## 5. Task D: near and far

| Cue                           | Measurement                                                               | Vote               | Confidence                                     |
| ----------------------------- | ------------------------------------------------------------------------- | ------------------ | ---------------------------------------------- |
| Face direction                | Nose is right of the eye midpoint by 0.34 eye distances (template 0.64)   | near = image-left  | medium                                         |
| Torso front mark (tie)        | Tie is 46.6 px right of the neck base                                     | near = image-left  | medium                                         |
| Visible sleeve area           | White sleeve pixels: image-left 4,344, image-right 264                    | near = image-left  | medium                                         |
| Foot contact height           | The image-left sole is 20.8 px lower                                      | near = image-left  | low                                            |
| Shoulder widths from the neck | image-left 56.6 px, image-right 121.8 px                                  | near = image-right | low, not reliable (the far cap proxy is wrong) |
| Global fit                    | Similarity mean 2.68 % against 14.99 %; the other side needs a reflection | near = image-left  | high                                           |

Per limb, in the mirrored input:

| Limb                    | Image side  | Near or far | Anatomical side (inferred) | Confidence |
| ----------------------- | ----------- | ----------- | -------------------------- | ---------- |
| Arm without the sword   | image-left  | near        | subject right              | high       |
| Arm with the sword      | image-right | far         | subject left               | high       |
| Leg with the lower shoe | image-left  | near        | subject right              | medium     |
| Other leg               | image-right | far         | subject left               | medium     |

The anatomical sides follow from the facing direction (C0.5 convention: subject right is near and image-left). They are inferred, not drawn. In the original (not mirrored) concept, the sword is in the subject's right hand, and that hand is also the far hand.

**Template incompatibility:** the sword is in the far hand. The C0.5 template has `weapon_grip` on `hand_near` and the `hand_near_front` slot for fingers over a grip. This is true for the original and for the mirrored image. The L0 input README says that the sword is in the near hand on the image-left; the pixels do not agree with that text. A human decision is necessary (section 8). This study does not change the template.

## 6. Task E: segmentation feasibility

No cut was made. A cut line candidate is perpendicular to the limb axis at the joint. The C0.5 overlap radius is 24 contract px, which is about 22 image px with the similarity scale.

| Cut                      | Status     | Basis and risks                                                                                                                                                             |
| ------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrist, image-left (near) | candidate  | The wrist band is a natural seam and gives drawn overlap. Small rotation only. The glove and fingers are one shape.                                                         |
| Wrist, image-right (far) | candidate  | Same seam. The hand wraps the sword grip, so a hand rotation moves the sword. The template expects this hand to be empty (weapon on the near hand).                         |
| Ankle, both              | candidate  | The shoe collar is a natural seam. The stocking continues inside the shoe (See-through completed 1.7 % and 2.5 % of the leg pixels).                                        |
| Elbow, image-right (far) | candidate  | Drawn bend at 641.8, 441.5. The upper arm above it is 28 % completion pixels under the torso, so a far upper arm part is mostly invented and needs review.                  |
| Elbow, image-left (near) | blocked    | No visible bend. A cut at a fixed fraction is not allowed. A human mark is necessary.                                                                                       |
| Shoulder, both           | hypothesis | The sleeve hides the joint. The sleeve hem (y 365) is a clothing seam, not the joint. A shoulder rotation opens the sleeve cap and needs repaint. Hair covers the near cap. |
| Hip, both                | blocked    | The skirt hides the hips. The thighs are one merged shape (27,077 px, L0-1b). A thigh part needs completion.                                                                |
| Knee, image-left         | blocked    | Straight leg, uniform black stocking: no cue.                                                                                                                               |
| Knee, image-right        | hypothesis | The bend (14.3°) is at y 1014, which is too low for a knee (residual 10.3 %). Probably the calf.                                                                            |

Specific risks:

- **Shoulders and white sleeves:** the sleeve is a separate garment over the shoulder joint. A cut through the sleeve shows the sleeve edge in motion. The near cap is partly under the hair.
- **Elbows:** the elbow overlap needs pixels on both sides of the cut. When the forearm turns, the inner elbow opens. Those pixels do not exist in the drawing.
- **The sword hand:** the hand, the grip, and the guard overlap. A separate weapon part needs the fingers in front of the grip (`hand_*_front`), and that slot exists only for the near hand.
- **Thighs under the skirt:** see L0-1b. A thigh part needs completion or repaint.
- **Knees:** no drawn cue. The stocking shine is not a joint mark.
- **Ankles and shoes:** good seams. The foot anchor (sole) is not in the template.

## 7. Task F: images (project shared folder only)

In `research/l0-1c/` of the project shared folder (not in Git):

- `a-anatomy-overlay.png`: landmarks. A dot is visible, a ring is occluded, a ring with a cross is inferred, and a dashed red box is an unknown range. The letter is the confidence.
- `b-skeleton-comparison.png`: the C0.5 mannequin with the joint names under near = image-left, and the character skeleton from known landmarks only. Unknown joints have no lines.
- `c-alignment-diagnostics.png`: the C0.5 joints mapped into the image by the similarity fit, with error lines and the residual of each landmark.
- `d-segmentation-map.png`: cut line candidates (green: candidate, yellow: hypothesis, red box: blocked), with the overlap radius.
- `e-uncertainty-map.png`: merged thighs, skirt, unknown ranges, low-confidence and occluded points.
- `contact-sheet.png`, `landmarks.json`, `correspondence.json`, `landmarks-manual.template.json`, the run report, and the input hashes before and after.

## 8. Answers to the study questions

| Question                            | Answer                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is alignment possible?              | Partially. One similarity transform places the character on the template (mean 2.7 %, max 5.3 %). It does not meet the contract tolerances (1.5 % and 2.5 %). The differences come mainly from the pose (head tilt, arm angles, stance), not from a scale or rotation error.                                |
| Is ordinary geometry enough?        | For placement, scale, and near and far: yes. For joints under clothing (hips, knees, near elbow, shoulders): no. Geometry gives a range, not a point.                                                                                                                                                       |
| Is AI pose normalization necessary? | Not for alignment. The pose differences are inside the rotation range of a rig. A pose-estimation model would also only infer the hidden joints, so it would not give more evidence than a human mark. We recommend no AI step now.                                                                         |
| Which joints can the tool find?     | Eyes, nose, mouth, chin, neck base, both wrists (band), both ankles (shoe collar), both sole anchors, and a bent elbow (the far elbow here).                                                                                                                                                                |
| Where is a human necessary?         | Hips, knees, the near elbow, both shoulders, and the head top. Also the weapon hand decision and the confirmation of near = image-left.                                                                                                                                                                     |
| What blocks part cuts?              | (1) Unknown pivots at the hips, knees, near elbow, and shoulders. (2) The merged thighs under the skirt. (3) The far upper arm is 28 % completion pixels. (4) The sword is in the far hand, and the template has the weapon on the near hand. (5) No drawn overlap pixels at elbows and knees for rotation. |
| What is the minimal next study?     | See section 9.                                                                                                                                                                                                                                                                                              |

## 9. Recommendation for the next stage (not started)

1. **Owner decision on the weapon hand.** Options: allow the weapon on either hand in the contract, or require near-hand weapons in concepts, or mirror the weapon only (not the art). This is a rig contract question and needs a human decision.
2. **L0-1d manual landmark pass (local, no GPU).** A person marks the hips, knees, near elbow, shoulders, and head top in `landmarks-manual.template.json` (estimated 15 minutes) and records the time. Then run `align-study --landmarks` again and check: residuals under the tolerances, segment ratios in 0.95 to 1.05, and the human marking time.
3. **Then one limb trial (local):** the far arm at the wrist and elbow only, with the 24 px overlap measured on drawn pixels. No repaint and no generation.
4. Thigh completion (L0-2) stays a separate decision. It probably needs generative inference and a GPU.

## 10. Verification

- Input files unchanged: SHA-256 of all 50 PNG files of the run directory (layers, depth maps, and `src_img.png`), the metadata, and the contract before and after the run are equal.
- Determinism: two runs give byte-equal output files.
- Size: the output images keep the 1280 x 1280 frame. The contact sheet is a half-size grid.
- Unknown landmarks have no coordinates (checked in the code and in the tests). Measured and inferred values are separate fields.
- Tests (synthetic shapes only): `align.test.ts` (fits recover known transforms, reflection, degenerate input, bends) and `alignstudy.test.ts` (landmarks on a synthetic figure, completed pixels, manual file validation, exact template recovery, mirrored input as a reflection, determinism, frame size, CLI without input change).
- Residual risks: the color rules fit only this concept; the completion test uses a fixed tolerance of 32 and cannot see a completion with the same color as the cover (for example dark stockings under a dark skirt); the centerline of a silhouette is not the bone line.
