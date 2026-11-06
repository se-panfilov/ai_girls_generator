import { AtlasCache } from '@rig-runtime/atlas-cache';
import { parseRigContract } from '@rig-runtime/contract';
import { RigRuntimeError } from '@rig-runtime/problems';
import { loadSharedRig } from '@rig-runtime/rig';
import { describe, expect, it } from 'vitest';

import { eyeColumns, eyeFrames, spikeLoader, SpikeTexture } from './d26/assets';
import { plannedBlinks } from './d26/blink';
import { type AnimatedCharacter } from './d26/controller';
import { readSpikeFile } from './d26/fixture';
import { ownershipProblems, parseOwners } from './d26/ownership';
import { loadSpikeRig } from './d26/rig';
import { blinkOptions, loadSpike, makeCharacter, moduleOf, ownersByFile, type Spike, spine } from './d26/setup';
import { readFixture } from './helpers';

// D26 spike tests on the real spine-core 4.3.13 runtime (SkeletonJson, Skeleton, AnimationState, SequenceTimeline).
// No timeline or pose is mocked. Textures are counting objects without GPU memory; pixels are checked by the visual smoke test.

const frame = 1 / 60;
const hairSlots = ['hair_back', 'hair_front', 'hair_tail', 'ear_far', 'ear_near'];
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function codes(action: () => unknown): Promise<string[]> {
  try {
    await action();
  } catch (error) {
    if (error instanceof RigRuntimeError) return error.problems.map((item) => item.code);
    return [String(error)];
  }
  return [];
}

const slotOf = (animated: AnimatedCharacter, name: string): spine.Slot => {
  const slot = animated.skeleton.findSlot(name);
  if (!slot) throw new Error(`No slot ${name}`);
  return slot;
};
const boneOf = (skeleton: spine.Skeleton, name: string): spine.Bone => {
  const bone = skeleton.findBone(name);
  if (!bone) throw new Error(`No bone ${name}`);
  return bone;
};

/** The eye frame index that a renderer draws now (SlotPose.sequenceIndex resolved by the sequence), or -1 without the eye attachment. */
function eyeFrame(animated: AnimatedCharacter): number {
  const slot = slotOf(animated, 'eyes');
  const attachment = slot.appliedPose.getAttachment();
  if (!(attachment instanceof spine.RegionAttachment) || attachment !== animated.sequenceAttachment('eyes')) return -1;
  return attachment.sequence.resolveIndex(slot.appliedPose);
}

/** Atlas page of the attachment that a slot shows, or null. */
function pageOf(animated: AnimatedCharacter, name: string): string | null {
  const attachment = slotOf(animated, name).appliedPose.getAttachment();
  if (!(attachment instanceof spine.RegionAttachment)) return null;
  const pose = slotOf(animated, name).appliedPose;
  return (attachment.sequence.regions[attachment.sequence.resolveIndex(pose)] as spine.TextureAtlasRegion).page.name;
}

const rotation = (skeleton: spine.Skeleton, bone: string): number => boneOf(skeleton, bone).pose.rotation;

/** The local pose of `bones` after one animation alone was applied on a fresh skeleton at `time`. */
function reference(spike: Spike, animation: string, time: number, bones: readonly string[]): number[] {
  const skeleton = new spine.Skeleton(spike.rig.data);
  skeleton.setupPose();
  spike.rig.data.findAnimation(animation)?.apply(skeleton, time, time, true, null, 1, spine.MixFrom.setup, false, false, false);
  return bones.flatMap((name) => {
    const pose = boneOf(skeleton, name).pose;
    return [pose.rotation, pose.x, pose.y];
  });
}
const maxDifference = (left: readonly number[], right: readonly number[]): number => {
  expect(left).toHaveLength(right.length);
  return Math.max(...left.map((value, index) => Math.abs(value - (right[index] ?? Number.NaN))));
};
const localPose = (skeleton: spine.Skeleton, bones: readonly string[]): number[] =>
  bones.flatMap((name) => {
    const pose = boneOf(skeleton, name).pose;
    return [pose.rotation, pose.x, pose.y];
  });

describe('D26 strategy A: native Spine sequence attachments', () => {
  it('the production loader rejects the spike skeleton: the profile has no sequence field', () => {
    const contract = parseRigContract(JSON.parse(readSpikeFile('rig.contract.json')));
    expect(() => loadSharedRig(spine, readSpikeFile('skeleton.json'), contract)).toThrow(/E_PROFILE_ATTACHMENT_FIELDS[^\n]*eyes[^\n]*sequence/);
  });

  it('a loader that drops region attachments (as the production loader does) cannot read the SequenceTimeline', () => {
    const dropRegions: spine.AttachmentLoader = {
      newRegionAttachment: () => null as unknown as spine.RegionAttachment,
      newMeshAttachment: () => null as unknown as spine.MeshAttachment,
      newBoundingBoxAttachment: () => null as unknown as spine.BoundingBoxAttachment,
      newPathAttachment: () => null as unknown as spine.PathAttachment,
      newClippingAttachment: () => null as unknown as spine.ClippingAttachment,
      newPointAttachment: () => null as unknown as spine.PointAttachment
    };
    expect(() => new spine.SkeletonJson(dropRegions).readSkeletonData(JSON.parse(readSpikeFile('skeleton.json')))).toThrow('Timeline attachment not found: eyes');
  });

  it('the spike loader reads the SequenceTimeline and keeps no drawable attachment in the shared data', () => {
    const { rig } = loadSpike();
    const blink = rig.data.findAnimation('blink');
    const timeline = blink?.timelines[0];
    expect(timeline).toBeInstanceOf(spine.SequenceTimeline);
    expect((timeline as spine.SequenceTimeline).getAttachment()).toBe(rig.sequences.get('eyes')?.timelineAttachment);
    expect(blink?.duration).toBeCloseTo(0.3, 6);
    expect(rig.data.defaultSkin?.getAttachments()).toEqual([]);
    expect(rig.templates.has('eyes')).toBe(false);
    expect(rig.sequences.get('eyes')).toMatchObject({ count: 3, start: 0, setupIndex: 0, width: 140, height: 48 });
  });

  it('the blink plays open, partly closed, closed, partly closed, open on its own track and ends open', async () => {
    const spike = loadSpike();
    const { animated } = await makeCharacter(spike, { blink: { ...blinkOptions, minInterval: 100, maxInterval: 100 } });
    animated.playPrimary('run');
    animated.state.setAnimation(1, 'blink', false);
    const frames: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      animated.step(frame);
      frames.push(eyeFrame(animated));
    }
    const runs = frames.filter((value, index) => index === 0 || value !== frames[index - 1]);
    expect(runs).toEqual([0, 1, 2, 1, 0]);
    expect(frames.at(-1)).toBe(0);
    // Each frame is shown for 0.05 s (3 frames at 60 Hz), the closed frame for 0.1 s.
    expect(frames.filter((value) => value === 2)).toHaveLength(6);
  });
});

describe('D26 property ownership', () => {
  it('the spike animation set has no ownership conflict', () => {
    const spike = loadSpike();
    expect(ownershipProblems(spike.rig.data, spike.owners)).toEqual([]);
  });

  it('detects the tail_1 conflict of the unchanged L1 animation set', () => {
    const json = JSON.parse(readFixture('editor-out/skeleton.json')) as { animations: Record<string, unknown> };
    // The L1 set with a secondary tail animation added, but without the migration of the tail keys.
    json.animations.tail_run = { bones: { tail_1: { rotate: [{ value: 10 }, { time: 0.3, value: -10 }, { time: 0.6, value: 10 }] } } };
    const rig = loadSharedRig(spine, JSON.stringify(json), parseRigContract(JSON.parse(readFixture('rig.contract.json'))));
    const owners = parseOwners({ animationOwners: [loadSpike().owners[0], { owner: 'tail', track: 2, animations: ['tail_run'] }] });
    const problems = ownershipProblems(rig.data, owners);
    expect(problems.map((item) => item.code)).toEqual(['E_OWNER_CONFLICT']);
    expect(problems[0]?.message).toBe('The bone tail_1 rotate is keyed by primary (jump_air, run) and tail (tail_run).');
  });

  it('detects an attachment key of a primary animation on the sequence slot, and animations without an owner', () => {
    const json = JSON.parse(readSpikeFile('skeleton.json')) as { animations: Record<string, Record<string, unknown>> };
    json.animations.hit = { ...json.animations.hit, slots: { eyes: { attachment: [{ name: null }] } } };
    json.animations.wave = { bones: { tail_2: { rotate: [{ value: 5 }] } } };
    const spike = loadSpike();
    const rig = loadSpikeRig(spine, JSON.stringify(json), spike.rig.contract);
    const problems = ownershipProblems(rig.data, spike.owners).map((item) => `${item.code}:${item.subject}`);
    expect(problems).toEqual(['E_OWNER_MISSING:wave', 'E_OWNER_CONFLICT:slot eyes attachment/sequence']);
  });

  it('rejects an owner table that gives one animation or one track to two owners', () => {
    expect(() =>
      parseOwners({
        animationOwners: [
          { owner: 'primary', track: 0, animations: ['run'] },
          { owner: 'tail', track: 0, animations: ['run'] }
        ]
      })
    ).toThrow(/E_OWNER_DUPLICATE/);
  });
});

describe('D26 independent playback on one shared skeleton', () => {
  it('run, tail and blink play at the same time; each owner gives exactly its own bones and slots', async () => {
    const spike = loadSpike();
    const { animated } = await makeCharacter(spike, { blink: { ...blinkOptions, seed: 7 } });
    const run = animated.playPrimary('run');
    const runBones = ['hips', 'thigh_near', 'thigh_far', 'shin_near', 'shin_far', 'upper_arm_near', 'upper_arm_far'];
    const tailBones = ['tail_1', 'tail_2'];
    const seen = new Set<number>();
    for (let index = 1; index <= 300; index += 1) {
      animated.step(frame);
      const time = index * frame;
      expect(run.trackTime).toBeCloseTo(time, 9);
      const runTime = time % 0.6;
      const tail = animated.state.tracks[2];
      expect(tail?.animation?.name).toBe('tail_run');
      expect(maxDifference(localPose(animated.skeleton, runBones), reference(spike, 'run', runTime, runBones))).toBeLessThan(1e-4);
      expect(maxDifference(localPose(animated.skeleton, tailBones), reference(spike, 'tail_run', (tail?.trackTime ?? 0) % 0.6, tailBones))).toBeLessThan(1e-4);
      seen.add(eyeFrame(animated));
    }
    // Five seconds with blinks every 1.2–2.4 s: all three eye frames were drawn, and the tail moved.
    expect([...seen].sort()).toEqual([0, 1, 2]);
    expect(animated.blinkSnapshot().count).toBeGreaterThanOrEqual(2);
  });

  it('a primary change does not cancel the blink or the tail: the blink track keeps its entry and the tail follows the companion table', async () => {
    const spike = loadSpike();
    const { animated } = await makeCharacter(spike);
    animated.playPrimary('run');
    for (let index = 0; index < 200; index += 1) animated.step(frame);
    const blinkEntry = animated.state.tracks[1];
    const blinkBefore = animated.blinkSnapshot();
    expect(blinkEntry?.animation?.name).toBe('blink');
    animated.playPrimary('jump_air');
    expect(animated.state.tracks[1]).toBe(blinkEntry);
    expect(animated.state.tracks[2]?.animation?.name).toBe('tail_jump');
    animated.step(frame);
    expect(rotation(animated.skeleton, 'tail_1')).toBeCloseTo(reference(spike, 'tail_jump', 0, ['tail_1'])[0] ?? Number.NaN, 4);
    expect(animated.blinkSnapshot().time).toBeCloseTo(blinkBefore.time + frame, 9);
    expect(animated.blinkSnapshot().starts).toEqual(blinkBefore.starts);
    // Back to run: tail_run starts again. A second run keeps the tail entry (no time reset).
    animated.playPrimary('run');
    const tail = animated.state.tracks[2];
    for (let index = 0; index < 10; index += 1) animated.step(frame);
    animated.playPrimary('run');
    expect(animated.state.tracks[2]).toBe(tail);
    expect(tail?.trackTime).toBeCloseTo(10 * frame, 9);
    animated.playPrimary('idle');
    expect(animated.state.tracks[2]?.animation?.name).toBe('tail_idle');
    expect(await codes(() => animated.playPrimary('tail_run'))).toEqual(['E_OWNER_TRACK']);
  });
});

describe('D26 deterministic blink schedule', () => {
  const eyeTrace = async (seed: number, seconds: number): Promise<{ frames: number[]; starts: readonly number[] }> => {
    const spike = loadSpike();
    const { animated } = await makeCharacter(spike, { blink: { ...blinkOptions, seed } });
    animated.playPrimary('run');
    const frames: number[] = [];
    for (let index = 0; index < seconds * 60; index += 1) {
      animated.step(frame);
      frames.push(eyeFrame(animated));
    }
    return { frames, starts: animated.blinkSnapshot().starts };
  };

  it('the same seed gives the same frame list; another seed gives another list', async () => {
    const first = await eyeTrace(26, 20);
    const second = await eyeTrace(26, 20);
    const other = await eyeTrace(27, 20);
    expect(second.frames).toEqual(first.frames);
    expect(other.frames).not.toEqual(first.frames);
    expect(first.starts).toEqual(plannedBlinks(blinkOptions, 20).filter((at) => at < 20 - frame / 2));
  });

  it('blinks are periodic, not continuous: the eyes are open most of the time and each blink is one complete cycle', async () => {
    const { frames, starts } = await eyeTrace(26, 20);
    const open = frames.filter((value) => value === 0).length;
    expect(open / frames.length).toBeGreaterThan(0.85);
    const closings = frames.filter((value, index) => value === 2 && frames[index - 1] !== 2).length;
    expect(closings).toBe(starts.length);
    for (let index = 1; index < starts.length; index += 1) {
      const gap = (starts[index] ?? 0) - (starts[index - 1] ?? 0);
      expect(gap).toBeGreaterThanOrEqual(blinkOptions.minInterval);
      expect(gap).toBeLessThanOrEqual(blinkOptions.maxInterval);
    }
  });

  it('rejects an interval that is not longer than the blink animation', async () => {
    const spike = loadSpike();
    expect(await codes(() => makeCharacter(spike, { blink: { ...blinkOptions, minInterval: 0.2 } }))).toEqual(['E_BLINK_OPTIONS']);
  });
});

describe('D26 eye frame geometry', () => {
  it('every frame keeps the logical rectangle: the drawn quad is the frame content at its position in the 140x48 rectangle', async () => {
    const spike = loadSpike();
    const { animated } = await makeCharacter(spike);
    animated.playPrimary('run');
    for (let index = 0; index < 20; index += 1) animated.step(frame);
    const slot = slotOf(animated, 'eyes');
    const attachment = animated.sequenceAttachment('eyes') as spine.RegionAttachment;
    const template = spike.rig.sequences.get('eyes');
    const bone = slot.bone.appliedPose;
    // Local point (x from the left, y from the top) of the logical rectangle → world.
    const world = (x: number, y: number): [number, number] => {
      const localX = (template?.x ?? 0) - 70 + x;
      const localY = (template?.y ?? 0) + 24 - y;
      return [bone.a * localX + bone.b * localY + bone.worldX, bone.c * localX + bone.d * localY + bone.worldY];
    };
    for (const [index, expected] of eyeFrames.entries()) {
      slot.appliedPose.sequenceIndex = index;
      expect(attachment.sequence.resolveIndex(slot.appliedPose)).toBe(index);
      expect(attachment.sequence.regions[index]?.originalWidth).toBe(140);
      expect(attachment.sequence.regions[index]?.originalHeight).toBe(48);
      const vertices = new Array<number>(8).fill(0);
      attachment.computeWorldVertices(slot, attachment.getOffsets(slot.appliedPose), vertices, 0, 2);
      // The packer trimmed every frame to its content box (x 30..110; y from the lid line to the bottom), so each frame has other
      // offsets. The quad must be exactly that content box at its place in the logical rectangle: no jump between frames.
      const box = { left: eyeColumns[0][0], right: eyeColumns[1][1], top: expected.top, bottom: expected.bottom };
      const corners = [world(box.left, box.bottom), world(box.left, box.top), world(box.right, box.top), world(box.right, box.bottom)].flat();
      expect(vertices.map((value) => Number(value.toFixed(3)))).toEqual(corners.map((value) => Number(value.toFixed(3))));
    }
  });

  it('rejects frames with another logical size, a missing frame and a wrong frame count, and keeps the old frames', async () => {
    const spike = loadSpike();
    const { animated, cache } = await makeCharacter(spike);
    const before = animated.sequenceAttachment('eyes');
    const owners = ownersByFile(cache, spike);
    const tailAtlas = moduleOf(spike, 'tail.a').atlas;
    expect(await codes(() => animated.installSequence('eyes', tailAtlas, ['tail', 'tail', 'tail']))).toEqual(['E_REGION_ORIG_MISMATCH', 'E_REGION_ORIG_MISMATCH', 'E_REGION_ORIG_MISMATCH']);
    expect(await codes(() => animated.installSequence('eyes', spike.assets.eyes.atlas, ['eyes_0', 'eyes_1', 'eyes_9']))).toEqual(['E_REGION_MISSING']);
    expect(await codes(() => animated.installSequence('eyes', spike.assets.eyes.atlas, ['eyes_0', 'eyes_1']))).toEqual(['E_SEQUENCE_FRAME_COUNT']);
    expect(animated.sequenceAttachment('eyes')).toBe(before);
    expect(slotOf(animated, 'eyes').pose.getAttachment()).toBe(before);
    expect(ownersByFile(cache, spike)).toEqual(owners);
  });
});

describe('D26 hair module change during playback', () => {
  it('replaces the hair atomically while run, tail and blink continue without a reset', async () => {
    const spike = loadSpike();
    // Each atlas load waits three event loop turns, so frames continue with the old hair while the new atlas loads.
    const { animated, cache } = await makeCharacter(spike, { delay: async () => Promise.all([tick(), tick(), tick()]).then(() => undefined) });
    const run = animated.playPrimary('run');
    const trace: { run: number; tail: number; blink: number; hair: (string | null)[]; eyes: number }[] = [];
    const step = (): void => {
      animated.step(frame);
      trace.push({
        run: run.trackTime,
        tail: animated.state.tracks[2]?.trackTime ?? -1,
        blink: animated.blinkSnapshot().time,
        hair: hairSlots.map((slot) => pageOf(animated, slot)),
        eyes: eyeFrame(animated)
      });
    };
    for (let index = 0; index < 90; index += 1) step();
    const tracksBefore = [0, 1, 2].map((track) => animated.state.tracks[track]);
    const blinkBefore = animated.blinkSnapshot();
    const unrelatedSlots = animated.skeleton.slots.filter((slot) => !hairSlots.includes(slot.data.name));
    const unrelatedBefore = unrelatedSlots.map((slot) => slot.pose.getAttachment());
    expect(ownersByFile(cache, spike)).toEqual({ 'body.atlas': 7, 'hair_a.atlas': 1, 'tail.atlas': 1, 'eyes.atlas': 1 });
    const swap = animated.character.setModules([moduleOf(spike, 'hair.b')]);
    let done = false;
    void swap.then(() => {
      done = true;
    });
    let pendingFrames = 0;
    for (let index = 0; index < 20 && !done; index += 1) {
      step();
      pendingFrames += 1;
      await tick();
    }
    await swap;
    for (let index = 0; index < 120; index += 1) step();
    expect(pendingFrames).toBeGreaterThan(0);
    // Same track entries; time grows by one frame each step (no reset).
    expect([0, 1, 2].map((track) => animated.state.tracks[track]?.animation?.name)).toEqual(['run', 'blink', 'tail_run']);
    expect(animated.state.tracks[0]).toBe(tracksBefore[0]);
    expect(animated.state.tracks[2]).toBe(tracksBefore[2]);
    for (let index = 1; index < trace.length; index += 1) {
      const [previous, current] = [trace[index - 1], trace[index]];
      expect((current?.run ?? 0) - (previous?.run ?? 0)).toBeCloseTo(frame, 9);
      expect((current?.tail ?? 0) - (previous?.tail ?? 0)).toBeCloseTo(frame, 9);
      expect((current?.blink ?? 0) - (previous?.blink ?? 0)).toBeCloseTo(frame, 9);
    }
    // The blink schedule continued: the starts before the change are kept, and later blinks were drawn.
    const blinkAfter = animated.blinkSnapshot();
    expect(blinkAfter.starts.slice(0, blinkBefore.count)).toEqual(blinkBefore.starts);
    expect(blinkAfter.count).toBeGreaterThan(blinkBefore.count);
    expect(blinkAfter.starts).toEqual(plannedBlinks(blinkOptions, blinkAfter.time).filter((at) => at <= blinkAfter.time));
    // Every frame shows one complete hairstyle; the change happens once.
    const styles = trace.map((item) => {
      const pages = new Set(item.hair.filter((page) => page !== null));
      expect(pages.size, JSON.stringify(item.hair)).toBe(1);
      return [...pages][0];
    });
    expect(styles.filter((page, index) => index > 0 && page !== styles[index - 1])).toEqual(['hair_b.png']);
    expect(trace.at(-1)?.hair).toEqual(['hair_b.png', 'hair_b.png', null, null, null]);
    // No unrelated attachment changed (the eyes, the tail and the body keep the same objects).
    expect(unrelatedSlots.map((slot) => slot.pose.getAttachment())).toEqual(unrelatedBefore);
    expect(slotOf(animated, 'eyes').pose.getAttachment()).toBe(animated.sequenceAttachment('eyes'));
    // Atlas owners: hair A released, hair B owned once, the others unchanged.
    expect(ownersByFile(cache, spike)).toEqual({ 'body.atlas': 7, 'hair_b.atlas': 1, 'tail.atlas': 1, 'eyes.atlas': 1 });
  });

  it('a failed hair change leaves the hair, the animations, the blink schedule and the atlas owners unchanged', async () => {
    const spike = loadSpike();
    const { animated, cache } = await makeCharacter(spike);
    animated.playPrimary('run');
    for (let index = 0; index < 50; index += 1) animated.step(frame);
    const attachments = animated.skeleton.slots.map((slot) => slot.pose.getAttachment());
    const tracks = [0, 1, 2].map((track) => animated.state.tracks[track]);
    const times = tracks.map((entry) => entry?.trackTime);
    const blink = animated.blinkSnapshot();
    const owners = ownersByFile(cache, spike);
    const hairB = moduleOf(spike, 'hair.b');
    const badPage = { ...hairB, atlas: { ...hairB.atlas, pages: [{ file: 'hair_b.png', sha256: '0'.repeat(64) }] } };
    const wrongAtlas = { ...hairB, moduleId: 'hair.wrong', atlas: moduleOf(spike, 'tail.a').atlas };
    expect(await codes(() => animated.character.setModules([badPage]))).toEqual(['Error: E_ATLAS_HASH_MISMATCH: hair_b.png']);
    expect(await codes(() => animated.character.setModules([wrongAtlas]))).toEqual(['E_REGION_MISSING', 'E_REGION_MISSING']);
    expect(animated.skeleton.slots.map((slot) => slot.pose.getAttachment())).toEqual(attachments);
    expect([0, 1, 2].map((track) => animated.state.tracks[track])).toEqual(tracks);
    expect([0, 1, 2].map((track) => animated.state.tracks[track]?.trackTime)).toEqual(times);
    expect(animated.blinkSnapshot()).toEqual(blink);
    expect(ownersByFile(cache, spike)).toEqual(owners);
    expect(animated.character.modules().get('hair')).toBe('hair.a');
    // The character continues and a later valid change works.
    await animated.character.setModules([hairB]);
    expect(animated.character.modules().get('hair')).toBe('hair.b');
  });

  it('dispose releases every atlas owner, and trim frees every texture', async () => {
    const spike = loadSpike();
    const live = SpikeTexture.live;
    const cache = new AtlasCache(spikeLoader(spike.assets.files), 0);
    const { animated } = await makeCharacter(spike, { cache });
    await animated.character.setModules([moduleOf(spike, 'hair.b')]);
    await animated.dispose();
    expect(ownersByFile(cache, spike)).toEqual({});
    cache.trim();
    expect(SpikeTexture.live).toBe(live);
  });
});
