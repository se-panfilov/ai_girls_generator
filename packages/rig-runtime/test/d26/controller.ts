import { regionProblems } from '@rig-runtime/assemble';
import { type AtlasCache } from '@rig-runtime/atlas-cache';
import { type ModularCharacter } from '@rig-runtime/modular-character';
import { type AtlasRef } from '@rig-runtime/modules';
import { type Problem, problem, show, throwIfAny } from '@rig-runtime/problems';
import type { Spine, SpineRuntime } from '@rig-runtime/spine';

import { type BlinkOptions, BlinkScheduler, type BlinkSnapshot } from './blink';
import { type AnimationOwner, type Companion } from './ownership';
import { type SpikeRig } from './rig';

// D26 spike (experiment, not production). One character with:
// - the primary animation on track 0 (owner "primary"),
// - a seeded periodic blink on its own track (a native Spine SequenceTimeline on slot `eyes`),
// - a tail animation on its own track, chosen from the primary animation (companion table),
// - appearance modules through the existing ModularCharacter and AtlasCache.

type Installed = { readonly atlas: AtlasRef; readonly attachment: Spine.RegionAttachment };

export class AnimatedCharacter {
  readonly blink: BlinkScheduler;
  private readonly sequences = new Map<string, Installed>();
  private readonly primary: AnimationOwner;
  private disposed = false;

  constructor(
    private readonly spine: Pick<SpineRuntime, 'RegionAttachment' | 'Sequence'> & { readonly Physics: typeof Spine.Physics },
    private readonly rig: SpikeRig,
    private readonly cache: AtlasCache,
    readonly character: ModularCharacter,
    private readonly owners: readonly AnimationOwner[],
    private readonly companions: readonly Companion[],
    blink: BlinkOptions
  ) {
    const primary = owners.find((item) => item.track === 0);
    const blinkOwner = owners.find((item) => item.animations.includes(blink.animation));
    const animation = rig.data.findAnimation(blink.animation);
    const problems: Problem[] = [];
    if (!primary) problems.push(problem('E_OWNER_FORMAT', 'No owner uses track 0.'));
    if (!blinkOwner || blinkOwner.track !== blink.track || !animation)
      problems.push(problem('E_OWNER_FORMAT', `The blink animation ${show(blink.animation)} must belong to the owner of track ${blink.track}.`));
    throwIfAny(problems);
    this.primary = primary as AnimationOwner;
    this.blink = new BlinkScheduler(blink, animation?.duration ?? 0);
  }

  get skeleton(): Spine.Skeleton {
    return this.character.skeleton;
  }

  get state(): Spine.AnimationState {
    return this.character.state;
  }

  /**
   * Installs the frames of a sequence slot from one atlas. All checks and the atlas load come first; the change is one synchronous step.
   * On a failure the old frames stay and the cache keeps no extra owner.
   * Codes: E_SEQUENCE_UNKNOWN_SLOT, E_SEQUENCE_FRAME_COUNT, E_REGION_MISSING, E_PRESENT_PART_BLANK, E_REGION_ORIG_MISMATCH, E_PMA_MISMATCH.
   *
   * Spike shortcut: the attachment goes into the runtime skin of the ModularCharacter. ModularCharacter copies the attachments of the
   * slots outside the changed groups into each new skin, and slot `eyes` is in no group, so a module change keeps it.
   * Production needs sequence bindings in the module format instead (see the report).
   */
  async installSequence(slot: string, atlasRef: AtlasRef, frames: readonly string[]): Promise<void> {
    if (this.disposed) throwIfAny([problem('E_CHARACTER_DISPOSED', 'The character is disposed.')]);
    const template = this.rig.sequences.get(slot);
    if (!template) throwIfAny([problem('E_SEQUENCE_UNKNOWN_SLOT', `The rig has no sequence slot ${show(slot)}.`, slot)]);
    const sequenceTemplate = template as NonNullable<typeof template>;
    if (frames.length !== sequenceTemplate.count) throwIfAny([problem('E_SEQUENCE_FRAME_COUNT', `The slot ${show(slot)} needs ${sequenceTemplate.count} frames, not ${frames.length}.`, slot)]);
    const atlas = await this.cache.acquire(atlasRef);
    let attachment: Spine.RegionAttachment;
    try {
      const problems: Problem[] = [];
      if (atlas.pages.some((page) => page.pma !== atlasRef.pma)) problems.push(problem('E_PMA_MISMATCH', 'The atlas pages do not agree with the pma flag of the reference.', slot));
      const sequence = new this.spine.Sequence(frames.length, true);
      sequence.start = sequenceTemplate.start;
      sequence.digits = sequenceTemplate.digits;
      sequence.setupIndex = sequenceTemplate.setupIndex;
      for (const [index, name] of frames.entries()) {
        const region = atlas.findRegion(name);
        if (!region) {
          problems.push(problem('E_REGION_MISSING', `The atlas has no frame region ${show(name)}.`, slot));
          continue;
        }
        // Every frame has the logical size of the attachment rectangle (D26 frame geometry); blank frames of a present part are errors (D22).
        problems.push(...regionProblems({ ...sequenceTemplate, color: null }, region));
        sequence.regions[index] = region;
      }
      throwIfAny(problems);
      attachment = new this.spine.RegionAttachment(sequenceTemplate.name, sequence);
      attachment.path = sequenceTemplate.path;
      attachment.x = sequenceTemplate.x;
      attachment.y = sequenceTemplate.y;
      attachment.scaleX = sequenceTemplate.scaleX;
      attachment.scaleY = sequenceTemplate.scaleY;
      attachment.rotation = sequenceTemplate.rotation;
      attachment.width = sequenceTemplate.width;
      attachment.height = sequenceTemplate.height;
      // The SequenceTimelines of the shared animations refer to the data-only attachment of the rig.
      attachment.timelineAttachment = sequenceTemplate.timelineAttachment;
      attachment.updateSequence();
    } catch (error) {
      this.cache.release(atlasRef);
      throw error;
    }
    // Commit: no await below this line.
    const skin = this.skeleton.skin;
    if (!skin) throwIfAny([problem('E_CHARACTER_EMPTY', 'Install the modules before the sequence slots.')]);
    (skin as Spine.Skin).setAttachment(sequenceTemplate.slotIndex, sequenceTemplate.placeholder, attachment);
    this.skeleton.slots[sequenceTemplate.slotIndex]?.pose.setAttachment(attachment);
    const old = this.sequences.get(slot);
    this.sequences.set(slot, { atlas: atlasRef, attachment });
    if (old) this.cache.release(old.atlas);
  }

  /** Starts a primary animation on track 0 and the matching companion animations on their tracks. Other tracks do not change. */
  playPrimary(name: string, loop = true): Spine.TrackEntry {
    if (!this.primary.animations.includes(name)) throwIfAny([problem('E_OWNER_TRACK', `The animation ${show(name)} is not a primary animation.`, name)]);
    const entry = this.state.setAnimation(0, name, loop);
    for (const companion of this.companions) {
      const owner = this.owners.find((item) => item.owner === companion.owner);
      if (!owner) continue;
      const target = companion.byPrimary[name] ?? companion.fallback;
      // The companion keeps playing when the target is the same animation, so its time does not reset.
      if (this.state.tracks[owner.track]?.animation?.name !== target) this.state.setAnimation(owner.track, target, true);
    }
    return entry;
  }

  /** One frame: blink schedule, animation state, pose. */
  step(delta: number): void {
    this.blink.update(delta, this.state);
    this.state.update(delta);
    this.state.apply(this.skeleton);
    this.skeleton.updateWorldTransform(this.spine.Physics.update);
  }

  blinkSnapshot(): BlinkSnapshot {
    return this.blink.snapshot();
  }

  /** The installed sequence attachment of a slot. */
  sequenceAttachment(slot: string): Spine.RegionAttachment | undefined {
    return this.sequences.get(slot)?.attachment;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.sequences.values()) this.cache.release(item.atlas);
    this.sequences.clear();
    await this.character.dispose();
  }
}
