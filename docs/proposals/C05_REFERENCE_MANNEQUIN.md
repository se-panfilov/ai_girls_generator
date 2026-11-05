# C0.5: reference mannequin and view calibration

**Draft proposal.** This report resolves finding F1 of [the C0 report](C0_RIG_GUIDED_GENERATION.md) with a candidate geometry. The owner decides if the candidate is accepted.
The intended view is a **proposed interpretation** of `three_quarter_right`: a neutral, front-visible, three-quarter view of an adult character that faces the right side of the image.
No production rig geometry, master skeleton, L1 fixture, or D26 fixture is changed. No AI inference ran.

## Result

| Item                                  | Status              | Where                                                                                            |
| ------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| F1 analysis                           | Done                | [F1 analysis](#f1-analysis)                                                                      |
| Candidate geometry (experimental)     | Done                | `packages/control/test/fixtures/c05-candidate/rig.contract.json`                                 |
| Mannequin, before and after pictures  | Done                | Project files `research/c05/` (`comparison.png`, overlays, OpenPose images, animation key poses) |
| Consistency checks on the candidate   | **PASS** (10 of 10) | [Consistency checks](#consistency-checks). One visual check is for the owner.                    |
| Consistency checks on the L1 test rig | **FAIL** (5 of 10)  | The same checks. Two are INCOMPLETE because L1 has no face points.                               |
| Migration impact                      | Done                | [Migration impact](#migration-impact)                                                            |
| Owner acceptance                      | **Open**            | [Owner decisions](#owner-decisions)                                                              |

## F1 analysis

Data: the L1 test rig contract 0.2.0 and its Spine export (`packages/rig-runtime/test/fixtures/l1-owner/`).

| Aspect           | L1 data                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Near/far depth   | Only the draw order shows depth: far limbs (3–8) are behind `torso` (10), near legs (12–14) are in front of `hips` (11), the near arm (22–26) is in front of the head (17). |
| Anatomical side  | Not in the contract. `near_far` names and the view `three_quarter_right` give it: with the face to the right, the subject's right side is near.                             |
| Projected joints | Near shoulder x 580 and near hip x 550 are on the **right** of the far shoulder (445) and far hip (480). The animal ear bones are the same (near 560, far 480).             |
| Face direction   | Not in the contract. The head joint is 6 px right of the chest. C0 used an assumed face template.                                                                           |
| Front/back cues  | `skirt_front` right of `skirt_back`, `tail_1` and `hair_tail_1` on the left (back), `aim` and `muzzle` on the right. All agree with facing right.                           |
| Animations       | `crouch_enter` bends the knees toward +x, and `shoot_stand` turns `upper_arm_near` to point at +x. Both agree with facing right.                                            |

What is geometrically established (from the coordinates and the view definition):

1. In an orthographic view where the body turns from the camera toward the right of the image by a yaw between 0° and 90°, the subject's right side moves toward the camera and to the left of the image. So in the **neutral setup pose**, the near shoulder and the near hip are on the left of the far ones.
2. L1 has the opposite lateral order for the shoulders, the hips and the ear bones, while its front/back cues, draw order and animations say "faces right". The data is internally inconsistent. Only the lateral placement of the paired joints disagrees.
3. BODY_18 OpenPose labels must follow the subject's anatomy. With near = subject's right, L1 gives a right shoulder on the right of the image under a face that looks right. Pose models trained on detector output can read this as a back view.

What needs visual confirmation:

1. The intended meaning of `three_quarter_right` (front-visible, facing the right of the image) is a proposal. A back-visible view or a body that faces left with the head turned right would also explain some of the L1 joints. The front/back cues make these less likely, but only the owner can confirm the intent.
2. The x order of joints is a valid view cue only in the neutral setup pose. In animation poses, arms and legs cross (for example, `shoot_stand` moves the near hand to the right of the far hand), so the checks do not use it for posed frames.
3. Whether the flat mannequin reads as the intended view for a person, and whether a model reads the OpenPose image as intended, needs a person and later a generation test.

## Candidate geometry

Made by code (`aigg-control candidate`) from a simple 3D reference body (`referenceBody` in `packages/control/src/mannequin.ts`), projected orthographically:

| Parameter          | Value (proposal)                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Proportion         | 7 head heights, body height 1240 px (the same canvas use as L1: head top y 250, ground y 1490)                                                                           |
| Yaw                | 40° from the camera toward the right of the image                                                                                                                        |
| Pose               | Neutral standing. Arms slightly away from the torso (elbows 1.25, wrists 1.5 head units from the center line before projection). Feet at hip width, toes forward.        |
| Torso articulation | `chest` at 4.9, `spine` (waist) at 4.25, `hips` at 3.7 head units above the ground                                                                                       |
| Face               | New points `head_top`, `face_nose`, `face_eye_near`, `face_eye_far`, `face_ear_near` on the `head` bone. The far ear is hidden.                                          |
| Kept from L1       | Bone ids, parents, roles, slot ids, bones, draw order, required flags, categories, overlaps, animations, tolerances, space, view, side names, mirroring, the `aim` joint |

Main joints (contract pixels):

| Joint          | L1 (x, y) | Candidate (x, y) |
| -------------- | --------- | ---------------- |
| head (chin)    | 518, 520  | 518, 427         |
| neck           | 515, 560  | 510, 480         |
| chest          | 512, 700  | 512, 622         |
| spine          | 512, 820  | 512, 737         |
| hips           | 512, 900  | 512, 835         |
| upper_arm_near | 580, 600  | 394, 507         |
| forearm_near   | 600, 770  | 337, 719         |
| hand_near      | 610, 920  | 322, 905         |
| upper_arm_far  | 445, 605  | 625, 507         |
| forearm_far    | 420, 770  | 676, 719         |
| hand_far       | 410, 915  | 729, 905         |
| thigh_near     | 550, 920  | 451, 861         |
| shin_near      | 565, 1180 | 457, 1153        |
| foot_near      | 575, 1440 | 447, 1446        |
| thigh_far      | 480, 915  | 573, 861         |
| shin_far       | 470, 1175 | 579, 1153        |
| foot_far       | 460, 1435 | 577, 1446        |
| face_nose      | —         | 575, 374         |

The attachment rectangles are recomputed from the projected segments, their radii and the 24 px overlap. Hair, ear, tail, skirt, accessory and weapon rectangles are generous placeholders.
The candidate OpenPose image (anatomical labels, 832 x 1216) has no warnings: its right shoulder and hip are on the left of the image and the nose is on the right.

## Pictures

In the project files, folder `research/c05/` (no binary files in the repository before decision D15):

| File                      | Content                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `comparison.png`          | Top row L1 (red bar), bottom row candidate (green bar): flat mannequin, joints and slot rectangles, OpenPose |
| `animation-key-poses.png` | The most extreme key pose of each L1 animation, on L1 (left) and on the candidate (right)                    |
| `c05-evidence.tar.gz`     | All PNG files at full size, `calibration.json`, the candidate control images, `reference.svg` with labels    |

The flat mannequin uses the same generic widths for both contracts. It is a picture of joints and draw order, not character art.
Colors: near side blue, far side orange, body gray. The gray wedge on the head points from the head center to the nose.

## Consistency checks

`aigg-control calibrate` runs these checks on both contracts. Kinds: geometric (from coordinates and the view definition), heuristic (a proxy with a threshold), visual (a person decides).

| Id  | Check                                                                                      | Kind      | L1         | Candidate    |
| --- | ------------------------------------------------------------------------------------------ | --------- | ---------- | ------------ |
| V1  | Near shoulder left of far shoulder (setup pose)                                            | geometric | FAIL       | PASS         |
| V2  | Near hip left of far hip (setup pose)                                                      | geometric | FAIL       | PASS         |
| V3  | Near animal ear bone left of far ear bone                                                  | geometric | FAIL       | PASS         |
| V4  | Front/back cues (skirt, tail, hair tail, aim, muzzle) say "faces right"                    | geometric | PASS       | PASS         |
| V5  | Face points: nose right of chin and of the eye midpoint, far eye right of near eye         | geometric | INCOMPLETE | PASS         |
| V6  | Anatomical and detector BODY_18 labels agree, no back-view signal                          | geometric | FAIL       | PASS         |
| V7  | Draw order: far limbs behind torso, near arm in front of torso, near legs in front of hips | geometric | PASS       | PASS         |
| V8  | Slot rectangles on the canvas, limb rectangles cover pivot and child overlap               | geometric | PASS       | PASS         |
| V9  | At least 6.5 head heights (adult proportion proxy, not a proof of age)                     | heuristic | INCOMPLETE | PASS (7.0)   |
| V10 | Near elbow and wrist do not touch the torso silhouette                                     | heuristic | FAIL       | PASS (62 px) |
| V11 | The pictures read as the intended view                                                     | visual    | owner      | owner        |

Tests (`packages/control/test/calibration.test.ts`): the fixture equals the generator output; the candidate passes all checks; V1, V2, V5, V6 and V7 pass for yaw 15° to 65°; L1 gives the expected failures; forward kinematics and the animation reader; the calibration output is deterministic.

## Migration impact

If the owner adopts the candidate geometry:

| Area                        | Impact                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bone ids, hierarchy, slots  | No change. Same bone ids and parents, same slot ids and draw order (checked by `calibrate`).                                                                                                                                                                                                                                                                     |
| Spine master rig setup pose | Changes. Every bone except `root` and `aim` gets a new local translation (table in `calibration.json`, `migration.bones`). The owner edits the master rig in the Spine Editor and exports again.                                                                                                                                                                 |
| Attachments and atlases     | All attachment rectangles change, so every region attachment offset in the skins changes, and all part images must be cut again for the new rectangles. The synthetic characters A, B and C and their atlases become invalid for the candidate.                                                                                                                  |
| Animations                  | The keys are local rotations and translations, so the same keys apply. The key pose sheet shows the expected results: `shoot_stand` points the near arm across the torso at the aim, `crouch_enter` bends the knees forward, `run` swings arms and legs in opposite phase. A person must review them in Spine; curves were not evaluated (linear approximation). |
| Contract                    | New contract version (candidate uses 0.3.0) and new `points` ids for the face. The JSON Schema in the research prototype must allow these points.                                                                                                                                                                                                                |
| `@aigg/rig-runtime`         | No code change expected: it reads slots and atlas regions from the contract and the export. The L1 fixtures stay as test data.                                                                                                                                                                                                                                   |
| D26 spike fixture           | Not affected. It is derived from L1 and stays a test fixture.                                                                                                                                                                                                                                                                                                    |
| Mirroring                   | No change (`scaleX`).                                                                                                                                                                                                                                                                                                                                            |
| C0 workflows                | Make new control images from the adopted contract (`aigg-control pose`).                                                                                                                                                                                                                                                                                         |

## Owner decisions

1. Accept or change the intended view: front-visible three-quarter view facing the right of the image as the meaning of `three_quarter_right` (related: D17, D3).
2. Accept or change the reference body: 7 head heights, yaw 40°, arms slightly away from the torso, neutral stance.
3. Accept face points (`head_top`, `face_nose`, `face_eye_near`, `face_eye_far`, `face_ear_near`) as contract points.
4. Adopt the candidate as the next contract version and update the Spine master rig, or keep it as an experimental fixture only.
5. Still open from C0: the generation resolution (F2), model approval (D9), GPU host (D19), and the ComfyUI endpoint.

## Reproduce

```sh
npm run build --workspace @aigg/control
node packages/control/dist/src/cli.js candidate --base packages/rig-runtime/test/fixtures/l1-owner/rig.contract.json --out /tmp/c05/candidate
node packages/control/dist/src/cli.js calibrate --before packages/rig-runtime/test/fixtures/l1-owner/rig.contract.json \
  --after packages/control/test/fixtures/c05-candidate/rig.contract.json \
  --skeleton packages/rig-runtime/test/fixtures/l1-owner/editor-out/skeleton.json --out /tmp/c05/calibration
node packages/control/dist/src/cli.js pose --contract packages/control/test/fixtures/c05-candidate/rig.contract.json --size 832x1216 --mapping anatomical --out /tmp/c05/control
```
