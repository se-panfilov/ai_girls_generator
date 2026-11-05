# D26 spike: animated parts on one shared skeleton

**Draft. Experiment report.** This spike gives evidence for D23 and D26. It does not close or freeze a decision, and it does not change the production rig contract, the L1 fixtures or the `@aigg/rig-runtime` source.
Related: [the decision log](../DECISIONS.md) (D23, D26 open), [the D23/D26 proposal](D23_D26_MODULES_AND_ANIMATED_PARTS.md), [the roadmap](../ROADMAP.md#animated-parts-and-secondary-animation-d26).

## Result

| Feature (one shared skeleton, at the same time)            | Result         | Evidence                                                                                                         |
| ---------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| Primary `run` on track 0                                   | **Verified**   | Real spine-core 4.3.13 `AnimationState`. Pose of the run bones = `run` alone, each frame for 5 s.                |
| Blinking: 3 frames, own track, periodic, seeded            | **Verified**   | Native Spine sequence attachment and `SequenceTimeline`. Same seed → same frame list for 20 s.                   |
| Tail: bone animation on its own track                      | **Verified**   | Pose of `tail_1`, `tail_2` = `tail_run` alone, each frame for 5 s. Primary change → companion tail animation.    |
| Hair module change during playback, without a reset        | **Verified**   | Existing `ModularCharacter` and `AtlasCache`. Same track entries, no time jump, schedule kept, one-frame change. |
| Failed hair change → old state kept                        | **Verified**   | Hash mismatch and missing regions: attachments, tracks, times, schedule and atlas owners unchanged.              |
| Ownership check (two owners key one bone or slot property) | **Verified**   | Finds the `tail_1` conflict of the unchanged L1 set. The spike set has no conflict.                              |
| Eye frame geometry                                         | **Verified**   | Trimmed frames: quad = content box at its place in the 140×48 rectangle. Exact eye pixel counts in WebGL.        |
| Browser drawing with software WebGL                        | **Verified**   | Chromium 153 with SwiftShader. 6 scenes, point samples and pixel counts pass. Same pixels in two runs.           |
| Spine Essential can author sequence attachments            | **Assumption** | Not tested. The spike fixture is JSON made by code. Verify in Spine Essential 4.3 before production use.         |

Strategy A (Spine sequence attachment with `SequenceTimeline`) works with the real runtime. Strategy B (attachment timeline or a separate frame controller) was not necessary and is not implemented.

## Native sequence attachments: what works and what fails

**Works** (test `d26-runtime.test.ts`, group "strategy A"):

- spine-core 4.3.13 reads a region attachment with `"sequence": { "count": 3, "start": 0, "setup": 0 }` and an animation `blink` with `attachments → default → eyes → eyes → sequence` keys.
- A `SequenceTimeline` sets `SlotPose.sequenceIndex`. It applies to every attachment whose `timelineAttachment` is the attachment of the timeline (`Attachment.isTimelineActive`). So each character can make its own runtime attachment with its own atlas regions and set `timelineAttachment` to the one data-only attachment of the shared rig. The shared animation then plays on every character.
- Blink keys: `once` from frame 0 with a delay of 0.05 s (0, 1, 2), `onceReverse` at 0.15 s (2, 1, 0), `hold` frame 0 at 0.3 s. Measured at 60 Hz: 0, 1, 2, 1, 0; the closed frame shows for 6 frames; the entry ends on frame 0 (open).

**Fails with the current production loader** (concrete evidence, kept as tests):

1. `loadSharedRig` rejects the spike skeleton: `E_PROFILE_ATTACHMENT_FIELDS` for slot `eyes`, field `sequence`.
2. A loader that drops region attachments (as the production loader does) cannot read the animation: spine-core throws `Timeline attachment not found: eyes`.

The spike loader `test/d26/rig.ts` solves both: it keeps one data-only attachment per sequence slot (with a 1×1 placeholder region, never drawn), and removes it from the default skin after loading. The shared `SkeletonData` then has no drawable attachment, as before.

## Track ownership

| Owner     | Track | Animations                                                                                                 | Keys                     |
| --------- | ----- | ---------------------------------------------------------------------------------------------------------- | ------------------------ |
| `primary` | 0     | `idle`, `run`, `jump_start`, `jump_air`, `jump_land`, `crouch_enter`, `shoot_stand`, `shoot_crouch`, `hit` | body bones               |
| `blink`   | 1     | `blink`                                                                                                    | slot `eyes` sequence     |
| `tail`    | 2     | `tail_idle`, `tail_run`, `tail_jump`                                                                       | bones `tail_1`, `tail_2` |

- The check reads the real timelines of the loaded `SkeletonData` (`Timeline.getPropertyIds()`). The attachment and the sequence frame of one slot are one key, because an attachment key of one owner replaces the sequence attachment of another owner. Draw order is one key for the skeleton.
- Codes: `E_OWNER_CONFLICT`, `E_OWNER_MISSING` (animation without owner), `E_OWNER_UNKNOWN_ANIMATION`, `E_OWNER_DUPLICATE`, `E_OWNER_FORMAT`.
- Primary change: `playPrimary` sets track 0 and starts the companion animation of each secondary owner (`run` → `tail_run`, `jump_air` → `tail_jump`, other → `tail_idle`). The blink track is not touched. A second `run` keeps the tail entry and its time.
- In the spike fixture the `tail_1` keys of `run` and `jump_air` moved to `tail_run` and `tail_jump` with the same values and times. `tail_run` and `tail_idle` also move `tail_2`. The L1 fixture is unchanged; a test proves its hashes.

## Blink schedule

- `BlinkScheduler` has its own clock and a mulberry32 generator (`seededRandom` of `modules.ts`). Interval: uniform in `[minInterval, maxInterval]` (spike: 1.2–2.4 s, seed 26).
- It starts the one-shot `blink` on its track when a start time is due. The frame step quantises the start time (at most one frame late).
- The interval must be longer than the blink animation (`E_BLINK_OPTIONS`).
- A module change or a primary change does not touch the scheduler: its time, next start and start list continue.

## Module change

- Groups of the spike: `head` (only `head`), `hair` (`hair_back`, `hair_front`, `hair_tail`, `ear_far`, `ear_near`), `tail`, and the other groups as in the proposal (section 3).
- Test: run, tail and blink play; the hair A → hair B change loads with a delay of three event loop turns, so frames continue during the load. Then 120 more frames.
- Results: the track 0 and track 2 entries are the same objects; run, tail and scheduler time grow by exactly one frame per step; each frame shows one complete hairstyle; the change happens once; hair B has no ears and no hair tail (`absent_by_design`), so these slots are empty after the change; the attachments of all other slots (including `eyes` and `tail`) are the same objects.
- Atlas owners: before `body 7, hair_a 1, tail 1, eyes 1`; after `body 7, hair_b 1, tail 1, eyes 1`. After `dispose` and `trim`: no owner and no live texture.

## Limits of the spike

- **Spike shortcut for `eyes`.** `ModularCharacter` makes one region per slot, so the sequence slot is outside the group table. `AnimatedCharacter.installSequence` puts the attachment into the runtime skin of the character, and `ModularCharacter` copies it into each new skin because the slot is in no group. The eyes atlas has its own owner in the cache. This is not a production design.
- The fixture skeleton is made by code from the L1 export, not exported by Spine Editor. Spine Editor import and export of this JSON were not tested.
- Tail changes start without a mix (`AnimationStateData` mix 0), so the tail jumps to the new pose. Production needs mix times for companion changes.
- Blink start times are quantised to frames. Two runs with different frame steps give different frame lists for the same seed.
- Synthetic flat-colour art. The face of the test head has no drawn eyes. Real heads with drawn eyes are not covered (risk 2 of the proposal).
- spine-webcomponents was not used. The visual test sends the spine-core draw list to a minimal WebGL page. The widget integration (adopted skeleton and state, several tracks) is not tested.
- The visual test needs Playwright and Chromium. They are not repository dependencies. Without them the test is not run (opt-in).
- Node.js v24.22.1 was used, because the container has no Node.js 26.12.1 (`.nvmrc`). macOS and a real GPU were not used. No performance or GPU measurement (deferred by the owner).

## Production changes that adoption needs

**Proposed.** None of these is done. Each needs the related decision (D23, D26, D24, D25).

### Master rig (Spine Editor)

1. Add slot `eyes` on bone `head`, directly above `head` in the draw order (below `ear_near` and `hair_front`).
2. Give it one region attachment with a sequence (3 frames, start 0, setup frame 0). Attachment rectangle from the art specification (spike: 140×48 at head offset 30, 120).
3. Remove the `tail_1` timelines from `run` and `jump_air`. Add `tail_run`, `tail_jump`, `tail_idle` with the same movement. Add `blink` with sequence keys.
4. Export again; the L1 parity and profile checks must pass with the new profile.

### Rig contract

1. New slot entry `eyes` (`category: face`, `required: false`, rectangle, frame count and frame names).
2. New animation list entries for `blink` and the tail animations.
3. New owner table (`animationOwners`: owner, track, animations) and companion table (`companions`), as in the spike contract. The contract holds them because Spine does not store ownership rules.
4. Minor contract version (additive slot) and a new shared animation set version (moved tail keys).

### Module table and module format

1. Split `head` into `head` and `hair`; split `torso` into `torso` and `tail` (no slot change; proposal section 4).
2. Put `eyes` into the `head` group, or into a new face group (open question).
3. New binding form for sequence slots, for example `{ "slot": "eyes", "status": "present", "frames": ["eyes_0", "eyes_1", "eyes_2"] }`, and a new schema id (`aigg.part-module/0.2`). Each frame: same original size as the attachment rectangle, no 1×1 blank (D22).

### `@aigg/rig-runtime`

1. `loadSharedRig`: accept `sequence` on region attachments (bounded count), keep one data-only timeline attachment per sequence slot, and remove it from the default skin. The spike loader shows the method.
2. `ModularCharacter`: make sequence attachments from `frames` bindings (all frames from the module atlas, `timelineAttachment` set), so that the eyes change with the head module and the cache owns the atlas through the module.
3. Owner check at rig load (`E_OWNER_*`), and a small track controller (`playPrimary` with companions; reject an animation on the track of another owner).
4. Seeded scheduler for periodic one-shot animations, with options in the character or game data.
5. Mix times for companion changes.

## Questions for D23 and D26

1. Do the eyes belong to the `head` module, or to a separate face module (for expressions)?
2. Is strategy A (sequence attachment) the accepted frame strategy? The spike shows that it works with spine-core 4.3.13.
3. Where do the blink options live (character data, game code), and which value gives the seed (for example the character id)?
4. Where does the companion table live (contract or game code)? Which mix times?
5. How do existing heads with drawn eyes stay valid after the face slot is added?
6. Track numbers and priorities when equipment (D25) adds secondary animations.
7. Can Spine Essential 4.3 author and export the sequence attachment and the sequence keys? (Assumption, not verified.)

## Files

| File                                            | Content                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/rig-runtime/test/fixtures/d26-spike/` | Derived skeleton and contract (generated, compared byte for byte with the derivation).         |
| `packages/rig-runtime/test/d26/fixture.ts`      | Derivation from the L1 export; owner and companion tables.                                     |
| `packages/rig-runtime/test/d26/rig.ts`          | Spike loader with sequence slots.                                                              |
| `packages/rig-runtime/test/d26/ownership.ts`    | Owner table parser and the ownership check on spine-core timelines.                            |
| `packages/rig-runtime/test/d26/blink.ts`        | Seeded periodic scheduler.                                                                     |
| `packages/rig-runtime/test/d26/controller.ts`   | `AnimatedCharacter`: tracks, companions, sequence install, step.                               |
| `packages/rig-runtime/test/d26/assets.ts`       | Synthetic atlases and PNG pages made at run time, module manifests, spike group table, loader. |
| `packages/rig-runtime/test/d26/render.ts`       | Draw list from the spine-core pose, and the WebGL page of the visual test.                     |
| `packages/rig-runtime/test/d26-*.test.ts`       | Fixture, runtime and visual tests.                                                             |

## Commands and results

Run from the repository root:

```sh
npm ci --ignore-scripts
npm test --workspace @aigg/rig-runtime
npm run check
```

Visual smoke test (opt-in, needs Playwright with Chromium in the environment):

```sh
cd packages/rig-runtime
AIGG_VISUAL_SMOKE=1 AIGG_VISUAL_OUT=/tmp/aigg-d26-visual npx vitest run test/d26-visual.test.ts
```

To write the derived fixture again after a change of `test/d26/fixture.ts`:

```sh
cd packages/rig-runtime
AIGG_D26_WRITE_FIXTURE=1 npx vitest run test/d26-fixture.test.ts
```

Actual results (Linux container, Node.js v24.22.1):

| Command                                  | Result                                                                                                                                                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test --workspace @aigg/rig-runtime` | PASS: 105 tests passed, 1 skipped (the opt-in visual test). Before the spike: 81 tests.                                                                                                                                                                   |
| `npm run check`                          | PASS (format, lint, configuration, workflow self-tests, package build and tests). `npm run typecheck`: PASS.                                                                                                                                              |
| Visual smoke test                        | PASS: 6 scenes. Renderer `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`, Chromium 153.0.8010.12, Playwright 1.63.0. Three runs gave the same pixel SHA-256 for each scene (summary hash `b543b42f…a5d7`). |

Eye pixel counts in the visual test (exact): open 1536, partly closed 864, closed 192 (2 eyes × 24 px × 32, 18 or 4 rows).
