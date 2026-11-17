# MVP-A: full-body test character assembly

**Research candidate.** This report describes MVP-A of the MVP vertical slice (decision D33, [the roadmap](../ROADMAP.md#near-term-priority-mvp-vertical-slice)).
The package is not a production character package, not an approved character, and not a rig contract version. It closes no decision.

## Status

| Item                 | Result                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------- |
| Full-body assembly   | PASS: all 18 required slots of the C0.5 candidate have an image.                            |
| Skeleton generation  | PASS: 28 bones (all C0.5 bone ids), 27 slots in the C0.5 draw order, 19 region attachments. |
| Demo animations      | PASS: `idle` (2 s, 7 bones) and `wave` (2.4 s, 5 bones), linear rotate keys.                |
| Offline validation   | PASS: 13 checks (see below).                                                                |
| Spine CLI validation | NOT RUN. It needs the owner's licensed Spine (`spine-validate`).                            |
| Overall              | `WAITING_FOR_SPINE_CLI_VALIDATION`                                                          |

## Inputs

| Input                                    | SHA-256            | Note                                                             |
| ---------------------------------------- | ------------------ | ---------------------------------------------------------------- |
| L0-1 results archive (`l0-1-results-v2`) | `c85fcea7…218951`  | The same archive as L0-1b to M0-F0a. Local only.                 |
| L0-1d manual landmarks                   | `1417cfc5…b7ede6`  | Owner marks. No new manual step in MVP-A.                        |
| L0-1d align-study `correspondence.json`  | `c23d7d42…87ca663` | Similarity scale for the L0-1e cut and the L0-1g underlay.       |
| C0.5 candidate contract                  | test fixture       | `packages/control/test/fixtures/c05-candidate/rig.contract.json` |

The SHA-256 of all 172 files of the extracted archive are the same before and after the runs.
The L0 test concept is a licensed test asset. The package images are derivatives. They stay outside Git.

## Method

The command `assemble-body` of `@aigg/control` does all steps. It runs no model, no Spine, and no network access. It reuses the existing methods without change:

1. **Joints (candidate geometry).** Bones start at the manual marks. The spine, chest, and head joints are on the mark lines at the shares of the C0.5 joints. The far shoulder is hidden in the concept, so its joint is an estimate: the far elbow plus the near upper arm length in the direction of the far sleeve end. Bones without marks get the C0.5 joint through a similarity fit of the marked joints. No image part uses these bones in MVP-A.
2. **Layers to slots.** A fixed table maps each See-through tag to a slot or a split rule:
   - Arms: the L0-1e cut at the near marks with the L0-1g tube underlay (method B), as in M0-F0a. The far arm uses the same cut rule at the far marks.
   - Legs and shoes: the L0-1b split (scan rows for the legwear), then the cut rule at hip, knee, and ankle.
   - The merged upper thighs (27,216 pixels) and all other residual pixels go to the nearest segment with a deterministic breadth-first fill.
   - Sleeves: topwear pixels nearer to the shoulder-elbow segment than to the neck-hips axis, on the arm side, go with the upper arm.
   - Skirt: above the line through the hip marks to `hips`, below it to `skirt_front`. Both move with the pelvis.
   - Face layers (face, eyes, brows, nose, mouth, ears, glasses) go to `head`. Hair goes to `hair_back` and `hair_front`.
   - The sword (`objects`) goes into `hand_far`. The contract `weapon` slot is on `weapon_grip` under the near hand, and the concept holds the sword in the far hand.
3. **Draw order.** The contract draw order is kept. Pixels that a higher source layer hides go into the image of the covering slot along fixed pairs (shin to foot, thigh to hips, upper arm to forearm, forearm to hand). This keeps the source look in the setup pose.
4. **Spine JSON.** The M0-F0a frame: root at the bottom center of the source canvas, y up, 1 Spine unit = 1 image px. Each region is centered on its image box and stays upright in the setup pose.

## Offline checks

All checks pass on the real inputs and on the synthetic test figure:
Essential subset, bone hierarchy (all bones connect to `root`), finite numbers, joint positions (largest error 5.1e-5 px), slots and draw order, region attachments (largest corner error 6.0e-5 px), animations (existing bones, increasing times, real motion), image files, required parts, source pixel conservation (each pixel of the 18 layers in exactly one slot image), setup pose render (0 different pixels against the direct composite), and source likeness.

Source likeness: 1,458 of 370,066 character pixels (0.39 %) differ from the source composite. The causes are the contract draw order (far arm behind the torso, near arm over the hair) and the tube underlay.

Other agent checks: the official spine-core 4.3.13 runtime reads the skeleton JSON (28 bones, 27 slots, 2 animations). Two runs give the same bytes for all files. `spine-validate --dry-run` accepts the package manifests.

## Known limitations

- Candidate geometry. The joints come from the marks of the test concept, not from the C0.5 joint positions.
- The far shoulder joint is an estimate with high uncertainty. The hip marks are occluded (medium confidence).
- The merged upper thighs are split along an approximate boundary.
- The sword is part of the far hand image. The `weapon` slot is empty.
- The skirt and the hair are static on their bones. The long back hair turns with the head.
- The far arm is behind the torso, the skirt, and the legs. Where it is in front in the source, it is hidden.
- Only the near arm has a joint underlay. Other joints show gaps or seams when they bend. In the wave pose the near shoulder shows a seam and the sleeve edge.
- The previews use a local nearest-neighbor renderer. They are not Spine output.

## Backlog (not MVP-A blockers)

- Far arm draw order and far shoulder geometry (needs an owner decision on the far arm layering).
- Joint underlay for the far arm and the legs (the L0-1g method for other limbs).
- Weapon in the far hand: contract change or mirrored concept (D6).
- Skirt and hair motion (D26).

## Owner action

Run `spine-validate` on the package (MVP-B). The commands are in the package `README.md`.
