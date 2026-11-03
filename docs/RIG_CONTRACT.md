# Rig contract

**Draft.** This document summarizes the proposed contract version 0.2. It replaces the owner's "Character Asset Contract v0.1" only after the owner accepts the changes.
The example geometry is a placeholder. The real coordinates come from the mannequin.

## Purpose

The rig contract defines what every character package must supply, so that one skeleton and one animation set work for all characters.
A character package never changes the contract.
A contract change needs a human decision and a new contract version under SemVer.

## Sources of truth

| Data                                                                       | Source of truth                      | How the factory reads it                                          |
| -------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| Bones, slots, draw order, animations                                       | Spine master rig                     | A script extracts `rig.generated.json` from the Spine JSON export |
| Required slots, attachment rectangles, overlaps, zones, tolerances, points | `rig.contract.json` (edited by hand) | Direct read, validated by JSON Schema                             |
| Character parts and their status                                           | `character.json` in the package      | Direct read, validated by JSON Schema                             |

A check compares `rig.contract.json` with `rig.generated.json`. Each bone and slot must exist in both files. A difference stops the build.
This removes the second source of truth that contract v0.1 had.

## Coordinate spaces

| Space          | Units       | Y axis | Origin                        |
| -------------- | ----------- | ------ | ----------------------------- |
| Contract space | pixels      | down   | top-left corner of the canvas |
| Rig space      | Spine units | up     | the `root` bone               |

Proposed values: canvas 1024 × 1536, `root` at contract point (512, 1490), one Spine unit for each pixel.
Conversion: `x_rig = x - 512`, `y_rig = 1490 - y`. Confirm the origin on the mannequin.

The generation resolution is separate from the contract canvas. For example, the model generates at 832 × 1248. A deterministic step scales the result to the canvas.

## Contract file blocks

| Block                      | Content                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `rigId`, `contractVersion` | Identity and version of the contract.                                                          |
| `spine`                    | Editor version, path and SHA-256 of the exported skeleton.                                     |
| `space`                    | Canvas size, Y direction, rig origin, units per pixel, generation resolution.                  |
| `view`, `sideNaming`       | `three_quarter_right`. `near_far` or `anatomical_lr` (decision D3).                            |
| `tolerances`               | Joint error, segment length ratio, zone IoU.                                                   |
| `bones`                    | `id`, `parent`, `joint` in contract space, `role`: `deform`, `attach_point`, `aim`, `control`. |
| `slots`                    | `id`, `bone`, `drawOrder`, `required`, `category`, `attachmentRect`, overlaps, zone mask.      |
| `points`                   | Named positions without images, for example `grip`, `muzzle`, effect points.                   |
| `animations`               | `id` and `loop` for each animation in the shared set.                                          |
| `mirroring`                | Method (`scaleX`) and whether asymmetric designs are allowed.                                  |

## Bones (proposed)

All characters have all bones. An animation can move a tail bone even when a character has no tail. Then the slot is empty.

| Group           | Bones                                                                             |
| --------------- | --------------------------------------------------------------------------------- |
| Body            | `root`, `hips`, `spine`, `chest`, `neck`, `head`                                  |
| Near arm        | `upper_arm_near`, `forearm_near`, `hand_near`                                     |
| Far arm         | `upper_arm_far`, `forearm_far`, `hand_far`                                        |
| Near leg        | `thigh_near`, `shin_near`, `foot_near`                                            |
| Far leg         | `thigh_far`, `shin_far`, `foot_far`                                               |
| Optional chains | `hair_tail_1..N`, `ear_near`, `ear_far`, `tail_1..N`, `skirt_front`, `skirt_back` |
| Weapon and aim  | `weapon_grip` (child of the near hand), `aim`                                     |

## Slots and draw order (proposed)

The list goes from back to front. The contract sets the order. A package cannot change it.

`hair_back`, `tail`, `ear_far`, `hand_far`, `forearm_far`, `upper_arm_far`, `foot_far`, `shin_far`, `thigh_far`, `skirt_back`, `torso`, `hips`, `foot_near`, `shin_near`, `thigh_near`, `skirt_front`, `neck`, `head`, `ear_near`, `hair_front`, `hair_tail`, `acc_head`, `upper_arm_near`, `forearm_near`, `weapon`, `hand_near`, `hand_near_front`.

Rules:

1. An empty optional slot has the status `absent_by_design` in the sidecar.
2. An empty required slot is a validation error.
3. Only the master rig can change the draw order during an animation. The change is the same for all characters.
4. Accessories use a closed list of slots, for example `acc_head`, `acc_neck`, `acc_waist`, `acc_back`, `acc_hand_near`. There is no open `accessory_*` list.

## Animations (proposed)

The owner's list is `idle`, `run`, `jump`, `shoot_stand`, `shoot_crouch`, and `hit`, facing left and right.
The proposal splits the jump and adds a crouch entry: `idle`, `run`, `jump_start`, `jump_air`, `jump_land`, `crouch_enter`, `shoot_stand`, `shoot_crouch`, `hit`.
This lets game physics control the jump height. See decision D5.

## Names

1. Use `snake_case` with `[a-z0-9_]` only.
2. Use a side suffix from the selected side naming system.
3. The part file name, the attachment name, and the sidecar key are the same.
4. Mark a variant of a part with a double underscore, for example `face_mouth__open`.
5. Reject generator layer names, such as `Layer 1` or `hair copy`.

## Joints and overlaps

1. The contract sets the pivot of each bone in contract space.
2. An attachment covers its pivot and a circle around the pivot of each child bone. The circle radius is the joint overlap, for example 24 px.
3. The overlap pixels continue the same part. They are not a separate image.
4. The validator renders extreme poses from the animation set and looks for gaps inside the silhouette.

## Attachment rectangles

Each slot has one fixed attachment rectangle (`attachmentRect`). Every character part for that slot fits inside it.
The packer exports each region to this rectangle and removes empty pixels with a saved offset.
Then one `skeleton.json` works for all characters without changes. This must be confirmed by experiment D.

## Category limits (proposed)

| Category                    | Limit in version 1                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| Torso clothes               | Does not go past the shoulder onto the arm. Sleeves are separate parts for each segment. |
| Skirt                       | Only `skirt_front` and `skirt_back`. Length to mid-thigh or shorter.                     |
| Long dresses, cloaks, coats | Not permitted in version 1. They need meshes or physics.                                 |
| Trousers                    | Cut like legs, one part for each segment.                                                |
| Hair                        | Back, front, side strands, and one tail chain. Length to the hips or shorter.            |
| Animal ears                 | Only on the ear bones, inside the head zone.                                             |
| Tail                        | Only on the tail chain, from the hips, segments with overlap.                            |
| Weapon                      | One firearm image in the near hand. Grip and muzzle points come from the contract.       |
| Scale                       | The character is fully inside the canvas. The head is inside its zone within ±3%.        |

## Tolerances for production art (proposed)

| Metric         | Method                                               | Threshold                  |
| -------------- | ---------------------------------------------------- | -------------------------- |
| Joint error    | Distance to the rig joint divided by body height     | each ≤ 2.5 %, mean ≤ 1.5 % |
| Segment length | Ratio to the reference segment length                | 0.95–1.05                  |
| Zone IoU       | Character mask against mannequin mask, per body zone | ≥ 0.85 for each body zone  |
| Near / far     | The near arm is in front of the torso                | 100 %                      |

Pose detectors trained on photos can fail on anime images. Experiment C compares a detector with manual marks first.

## Validator

The research prototype checks the schemas and these cross rules: one root bone, existing parents, unique ids and draw order, rectangles inside the canvas, overlap circles inside slot rectangles, points on existing bones, matching rig id and version, a slot for each part, a status for each slot, required slots present, and safe relative paths.

Not implemented yet: the comparison with the Spine export, and pixel checks (parts inside rectangles and zones, overlap coverage by opaque pixels, stray alpha components).
