# Appearance modules and animated parts (D23, D26)

**Proposal. Not accepted as a whole.** The owner accepted the design principles of D23 and the strategic intent of D26. The group table, the migration, the data formats and the APIs in this document are proposals. D23 and D26 stay open.
Related: [the decision log](../DECISIONS.md) (D22 accepted, D23–D26 open), [the rig contract](../RIG_CONTRACT.md), [the v5 contract patch](RIG_CONTRACT_V5_PATCH.md), [the roadmap](../ROADMAP.md).

This document changes no code, no module registry, no Spine skeleton, no asset manifest, and no contract version.

## Status labels

| Label               | Meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| **Accepted intent** | The owner approved it. Later design must agree with it.                 |
| **Recommended**     | The recommendation of this document. Not approved.                      |
| **Assumption**      | A technical statement that no test in this repository has verified yet. |
| **Open**            | A question for the owner or for a later spike.                          |

## 1. Terms

| Term              | Meaning                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rig part          | One sprite on one slot. Bones and joints of the shared rig move it. Example: `forearm_near`.                                                                      |
| Appearance module | A group of parts that is replaced as one unit, for example a complete arm or a hairstyle. A module can contain several slots, attachments and animated rig parts. |
| Equipment item    | A removable item (weapon, armor, helmet). It is a different entity from appearance (D25).                                                                         |

A joint-level sprite is not necessarily a separate swappable module. Example: the forearm is a rig part, but the arm is the module.

## 2. D23: accepted intent

**Accepted intent** (owner):

1. Rig parts and appearance modules are different concepts.
2. Arms keep independent upper-arm, forearm and hand sprites. Legs keep thigh, shin and foot sprites. The torso supports upper and lower body articulation.
3. Appearance modules stay reasonably coarse, for visual consistency and less compatibility complexity.
4. A hairstyle is replaceable independently of the head and face.
5. Cat ears and similar features that are part of a hairstyle belong to the hair module. They are not a mandatory separate module.
6. A tail is replaceable independently and can be absent.
7. A module can contain several slots, attachments and animated rig parts.
8. A multi-part module change is atomic.
9. The separation of appearance and equipment (D25) stays possible.

## 3. Proposed appearance groups

**Recommended** for further design. This is not an approved group table.

| Group            | Content                                                     | Slots of contract 0.2                                                             | Change against the current runtime table                            |
| ---------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `head`           | Head and face, including eye and expression components      | `head` (eye and expression slots do not exist yet, see 4.1)                       | Loses `hair_back`, `hair_front`, `hair_tail`, `ear_far`, `ear_near` |
| `hair`           | Hairstyle, strands, hairstyle-integrated animal ears        | `hair_back`, `hair_front`, `hair_tail`, `ear_far`, `ear_near`                     | New group                                                           |
| `torso`          | Articulated upper and lower torso                           | `torso` (bone `chest`), `hips` (bone `hips`), `neck`, `skirt_back`, `skirt_front` | Loses `tail`                                                        |
| `arm_near`       | Complete articulated near arm                               | `upper_arm_near`, `forearm_near`, `hand_near`, `hand_near_front`                  | None                                                                |
| `arm_far`        | Complete articulated far arm                                | `upper_arm_far`, `forearm_far`, `hand_far`                                        | None                                                                |
| `legs`           | Both articulated legs                                       | `thigh_far`, `shin_far`, `foot_far`, `thigh_near`, `shin_near`, `foot_near`       | None                                                                |
| `tail`           | Optional independent tail                                   | `tail`                                                                            | New group                                                           |
| `head_accessory` | Accessory                                                   | `acc_head`                                                                        | None                                                                |
| `weapon`         | Transitional group. Later separation under D25 (equipment). | `weapon`                                                                          | None                                                                |

Every slot of contract 0.2 stays in exactly one group. The table has 9 groups. The current runtime table (`humanoidGirlV1Groups` in `packages/rig-runtime/src/modules.ts`) has 7.

The slots of one module do not need to be next to each other in the draw order. Example: `hair_back` is at position 0, `ear_near` at 18 and `hair_front` at 19. The contract sets the draw order, so this is permitted.

## 4. Migration analysis

### 4.1 Rig and slot changes

| Change                                  | Rig or slot change necessary? | Evidence and reason                                                                                                                                                                                                            |
| --------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hair and ears out of `head`             | No                            | The hair slots are on bone `head` and bones `hair_tail_1`/`hair_tail_2`, the ear slots on bones `ear_far`/`ear_near`. Only the group table changes.                                                                            |
| Tail out of `torso`                     | No                            | Slot `tail` is on bone `tail_1` (chain `tail_1`, `tail_2`). The primary animations `run` and `jump_air` already key `tail_1`; this conflicts with D26 (see 5.3).                                                               |
| Torso upper and lower articulation      | Probably no                   | Slot `torso` is on bone `chest`, slot `hips` on bone `hips`. Bone `spine` has no slot. **Open:** whether a waist slot or a joint overlap check between `torso` and `hips` is needed.                                           |
| Eye and expression components in `head` | **Yes, later**                | The face is now part of the `head` sprite. Independent blinking (D26) needs at least one face slot above `head` and below `hair_front`, for example `eyes`. This is a new slot in the master rig and a minor contract version. |
| Hair strands that move independently    | Maybe                         | Only the `hair_tail` chain has bones. Front strands that move need new bones and slots. **Open.**                                                                                                                              |

**Recommended:** do not add a slot now. Collect the face and strand slots together with the equipment slots (D25) and add them in one minor contract version before the rig contract freeze.

### 4.2 Runtime and module registry

These changes are for a later implementation task, not for this PR.

- A new group table replaces `humanoidGirlV1Groups`. A module manifest that names the old `head` or `torso` group with the old slot list fails `E_MODULE_INCOMPLETE_GROUP` or `E_MODULE_SLOT_OUTSIDE_GROUP` under the new table.
- `ModularCharacter` requires one module for each group (`E_MODULE_INCOMPLETE_CHARACTER`). An optional tail then needs either an empty tail module (all bindings `absent_by_design`, permitted because slot `tail` is not required) or a list of optional groups.
- **Current limit of empty modules (fact from the code):** `parseModule` and the JSON Schema require an `atlas` with at least one page, and `ModularCharacter` acquires the atlas of every module, also when all its slots are absent. So an empty tail module is possible now only with a valid atlas reference, for example the shared atlas of the source character. The atlas is then loaded although no region of it is used.
- A module without resources (no atlas) needs a separate decision: optional groups, or a change of the module schema and the runtime. **Open.** The runtime does not support modules without resources now.
- The hair group contains the required slots `hair_back` and `hair_front`. A hairless design is then impossible without a contract change. **Open.**
- Compatibility rules name group ids. The current test rule (`skin_tone` over `head`, `torso`, the arms and `legs`) stays valid. New rules can be necessary, for example a hair colour rule between `hair` and `tail`.
- More groups make the composition search larger. The bounded backtracking search (`maxSteps`) stops it. The limits stay the same.
- The atlas cache does not change: two modules can use the same atlas, and the cache shares it by content identity.

### 4.3 Versioning

| Item                   | Change                                         | Proposed version step                                                                         |
| ---------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Rig contract           | None for the group move. A new face slot later | No step for the group move. Minor step (additive) when slots are added.                       |
| Module manifest format | Group ids and slot lists change                | New schema id, for example `aigg.part-module/0.2`. The runtime reads one version at a time.   |
| Group table            | Published as data, with an id and a version    | **Recommended:** a group table id in the module manifest, so that a manifest names its table. |
| `@aigg/rig-runtime`    | New table and possibly optional groups         | Minor step while the package is 0.x.                                                          |
| `character.json`       | None                                           | None. It lists parts by slot, not by group.                                                   |

### 4.4 Migration of the test characters A, B and C

- `character.json` and the atlases of A, B and C do not change. Absent parts stay `absent_by_design` (D22).
- Only module manifests change. A converter can make the new manifests from the old ones: the old `head` module becomes a `head` module and a `hair` module with the same atlas; the old `torso` module becomes a `torso` module and a `tail` module.
- A has `hair_tail`, `ear_far`, `ear_near` and `tail` absent; C has the same four absent. Their `hair` modules bind the ears and `hair_tail` as absent. Their `tail` modules are empty modules that refer to the character atlas (see 4.2), until the open choice about modules without resources is made. B has all parts.
- The existing tests that use the old table (MIX-01 to MIX-04, MIX-DET) need new fixtures. The seeded selection snapshot changes, because the group list changes.

### 4.5 Migration risks

1. **Old manifests stop working.** All manifests with the old group ids need conversion. Mitigation: a new schema id and a converter with tests.
2. **Face slot changes the master rig.** Blinking needs a face slot. Every head image must then exist without the eyes, or the eyes must be drawn over the face. This affects all heads, including A, B and C. **Open:** how old heads with drawn eyes stay valid.
3. **Hair and head seams.** A hairstyle on another head can show gaps at the hairline and the ears. This is an art and validation issue. Compatibility tags reduce the risk, but they do not prove a good result.
4. **Draw order across groups.** Hair slots are behind and in front of the head. A hairstyle that needs another order (for example, hair between the ears) needs a contract change. The contract stays the only owner of the draw order.
5. **Optional groups.** An empty module and an optional group give the same result on screen but different data. The choice must be one rule for all optional groups (tail, accessory, later equipment). An empty module now also needs an atlas reference and loads that atlas (see 4.2).
6. **Profile limits.** The runtime profile now accepts exactly one region attachment per slot without `sequence` fields (`E_PROFILE_ATTACHMENTS`, `E_PROFILE_ATTACHMENT_FIELDS`). Frame sequences (D26) need a profile change.
7. **Tail keys in primary animations.** `run` and `jump_air` key bone `tail_1`. The ownership rule of D26 needs a change of the shared animation set (see 5.3).

## 5. D26: animated parts and secondary animation

### 5.1 Accepted intent

**Accepted intent** (owner): individual visual parts can have their own animations. These animations run at the same time as the primary character animation and need no character-specific skeleton.
Examples: periodic blinking, facial expressions, independently animated eyes, breathing, tail and hair movement, glowing or pulsing accessories, small looping effects.

Conceptual behaviours (not final enum values or API names):

| Behaviour        | Meaning                                                |
| ---------------- | ------------------------------------------------------ |
| `static`         | A conventional static attachment.                      |
| `frame_sequence` | A sequence of image frames that plays at its own rate. |
| `bone_animated`  | Movement through the bones of the shared Spine rig.    |

Requirements from the owner:

- GIF-like behaviour is desired. Playback of GIF files at run time is not required.
- A later Node.js/TypeScript build step can accept GIF, APNG, animated WebP or image sequences and convert them into normalised frames and texture atlases.
- Prefer capabilities that Spine Essential supports, where practical. The initial feature set must not need Spine Professional.
- Later playback policies: loop, one-shot, ping-pong, periodic activation.
- Secondary animations do not disturb primary animations.
- A defined ownership and priority strategy for properties that more than one controller changes.
- All frames keep the alignment, the logical size and the attachment geometry.
- Deterministic playback where requested (seeded scheduling).

### 5.2 Recommended architecture

| Topic              | Recommendation                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Property ownership | Each slot and bone has one owner class. Primary animations own the body bones. Secondary animations own only the slots and bones that the primary animations never key (face slots, tail and hair chains, accessory colour). A validator rejects an animation set that breaks this rule. The current `run` and `jump_air` break it for the tail (see 5.3). |
| Layering           | Primary animations on track 0 of the Spine `AnimationState`. Secondary animations on higher tracks. Each secondary animation keys only the properties that it owns, so no mix weight is necessary.                                                                                                                                                         |
| `frame_sequence`   | First choice: a Spine attachment sequence or an attachment timeline on a secondary track. Fallback: a small runtime controller that changes the region of one attachment in a seeded schedule.                                                                                                                                                             |
| `bone_animated`    | Secondary animations in the master rig, for example `tail_sway` and `hair_sway`. They are part of the shared animation set, so they need no character-specific skeleton.                                                                                                                                                                                   |
| Frame geometry     | The build step writes every frame of one part at the same logical size, equal to the attachment rectangle, with a saved offset. The D22 rules apply to every frame: a 1×1 blank frame of a present part is an error.                                                                                                                                       |
| Determinism        | A seeded scheduler for periodic actions (for example a blink every 2–6 s). The same seed and the same start time give the same frame sequence.                                                                                                                                                                                                             |
| Module change      | A hairstyle or tail change replaces attachments only. It keeps the track entries and their times, as the MIX-02 test already shows for the arm.                                                                                                                                                                                                            |

### 5.3 Known conflict: tail keys in primary animations

**Fact** (from `packages/rig-runtime/test/fixtures/l1-owner/editor-out/skeleton.json`, the L1 owner export): the primary animations `run` and `jump_air` key the rotation of bone `tail_1` (`run`: 10° → −10° → 10° over 0.6 s; `jump_air`: −20°). The ownership rule of 5.2 gives the tail chain only to secondary animations. The current rig does not agree with this rule.

**Recommended migration** (not implemented):

1. Remove the `tail_1` timelines from `run` and `jump_air` in the master rig.
2. Add secondary animations that own the tail chain, for example `tail_run` and `tail_jump`, which keep the same movement, and a neutral `tail_idle`.
3. The game or a small controller starts the matching tail animation on a secondary track when it starts `run` or `jump_air`. The primary track does not change.
4. A validator checks that no bone or slot is keyed by both a primary and a secondary animation.

**Consequences:**

- The shared animation set changes. It needs a new animation set version, and the contract file must name it. Bones, slots and the draw order do not change.
- Old exports with `tail_1` keys in `run` and `jump_air` stay playable, but they fail the new ownership check. A converter can move the keys into the new tail animations, or the old set stays valid under the old version only.
- Until the migration, a character without a tail is not affected (slot `tail` is empty), but a character with a tail gets its tail movement only from the primary animations.
- The same check applies to the hair chain (`hair_tail_1`, `hair_tail_2`): no primary animation of the L1 export keys it now.

### 5.4 Assumptions (not verified)

1. Spine Essential can export attachment sequences and attachment timelines. spine-core 4.3.13 can read both (`Sequence`, `SequenceTimeline`, `AttachmentTimeline` exist in its source). The Essential export was not tested.
2. Spine physics constraints need Spine Professional. The proposal therefore uses keyed secondary animations for hair and tail, not physics.
3. spine-webcomponents 4.3.13 plays several tracks on one widget without a problem, and a secondary track does not reset track 0.
4. A secondary track that keys only its own properties never changes a property of track 0.
5. An attachment timeline of a secondary track resolves names through the character skin, so each module must supply each frame name that its animations use.

### 5.5 Open questions

- Exact manifest schemas for animated parts and for behaviours.
- Spine attachment strategy (sequence attachment or attachment timeline) and track strategy.
- Frame timing and scheduling API.
- Animation layering priorities, also with later equipment (D25).
- Supported import formats (GIF, APNG, animated WebP, image sequences).
- Implementation and resource budgets. Full GPU and performance tests stay deferred by the owner.

## 6. Pre-freeze validation spike (future task)

Before the rig contract 1.0 freeze, a small automated spike shows:

1. One shared skeleton.
2. The primary animation `run` on track 0.
3. Independent blinking with a short frame sequence.
4. Independent tail movement.
5. A hairstyle change without a reset of the active animations.

Acceptance criteria:

| Criterion                  | Check                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deterministic playback     | The same seed gives the same frame and attachment list for a recorded period.                                                                                                                                            |
| No attachment conflicts    | No slot or bone is keyed by two controllers. The validator of 5.2 passes. In particular, no primary animation has a `tail_1` or `tail_2` timeline after the migration of 5.3, and no two tracks key the same attachment. |
| No visible alignment jumps | Every frame has the same logical size and offset rules. A pixel check of the eye area passes.                                                                                                                            |
| Runtime state kept         | Track entries, animation times and the blink schedule are the same before and after the hairstyle change.                                                                                                                |

The spike uses synthetic or test assets and software WebGL. It does not include GPU or performance benchmarks. It needs no manual Spine work from the owner if the test rig can be made as JSON; **Open:** whether the face slot and the secondary animations need an editor export.

Spike result (draft evidence, D26 stays open): [the D26 spike report](D26_ANIMATED_PARTS_SPIKE.md).

## 7. Relation to other decisions

| Decision | Relation                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D22      | Accepted. Absent parts and empty modules use `absent_by_design`. An empty module still needs an atlas reference now (see 4.2). Frame sequences follow the same blank rules. |
| D24      | Open. Animated parts add frames to atlases; texture budgets stay open.                                                                                                      |
| D25      | Open. Equipment stays separate from appearance. `weapon` is a transitional appearance group.                                                                                |
| D6       | Open. Grips are not part of D23 or D26.                                                                                                                                     |
