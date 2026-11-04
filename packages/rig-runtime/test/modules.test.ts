import { AtlasCache, atlasIdentity } from '@rig-runtime/atlas-cache';
import { ModularCharacter } from '@rig-runtime/modular-character';
import { composeModules, humanoidGirlV1Groups, moduleGroupProblems, parseModule, type PartModule, selectionText } from '@rig-runtime/modules';
import { RigRuntimeError } from '@rig-runtime/problems';
import { type SharedRig } from '@rig-runtime/rig';
import { describe, expect, it } from 'vitest';

import { atlasText, contract, CountingTexture, fixtureFiles, fullSet, moduleFor, readFixture, sha256, sharedRig, spine, testLoader } from './helpers';

const armSlots = ['upper_arm_near', 'forearm_near', 'hand_near', 'hand_near_front'];
const rules = [{ tag: 'skin_tone', groups: ['head', 'torso', 'arm_near', 'arm_far', 'legs'] }];
/** Owner counts above zero. An atlas without owners may stay in the cache for reuse. */
const owned = (cache: AtlasCache): Record<string, number> => Object.fromEntries(Object.entries(cache.stats().owners).filter(([, count]) => count > 0));
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Atlas file of the attachment that a slot shows now, or null. */
function atlasOf(character: ModularCharacter, slotName: string): string | null {
  const attachment = character.skeleton.findSlot(slotName)?.pose.getAttachment();
  if (!(attachment instanceof spine.RegionAttachment)) return null;
  const region = attachment.sequence.regions[0] as spine.TextureAtlasRegion;
  return region.page.name;
}

/** Attachment object of every slot, to prove that a failed change leaves a character unchanged. */
const attachments = (character: ModularCharacter): unknown[] => character.skeleton.slots.map((slot) => slot.pose.getAttachment());
const boneState = (skeleton: spine.Skeleton): number[] =>
  skeleton.bones.flatMap((bone) => [bone.appliedPose.worldX, bone.appliedPose.worldY, bone.appliedPose.a, bone.appliedPose.b, bone.appliedPose.c, bone.appliedPose.d]);

async function mixed(rig: SharedRig, cache: AtlasCache, id = 'mix'): Promise<ModularCharacter> {
  const character = new ModularCharacter(spine, rig, cache, { groups: humanoidGirlV1Groups, rules, pma: true }, id);
  const base = fullSet('a').filter((item) => item.group !== 'legs' && item.group !== 'arm_near');
  await character.setModules([...base, moduleFor('b', 'legs'), moduleFor('c', 'arm_near')]);
  return character;
}

async function codes(action: () => Promise<unknown>): Promise<string[]> {
  try {
    await action();
  } catch (error) {
    if (error instanceof RigRuntimeError) return error.problems.map((item) => item.code);
    return [String(error)];
  }
  return [];
}

describe('module groups and manifests', () => {
  it('the draft group table covers each contract slot exactly once', () => {
    expect(moduleGroupProblems(contract(), humanoidGirlV1Groups)).toEqual([]);
  });

  it('modules made from the owner atlases are valid', () => {
    for (const id of ['a', 'b', 'c'] as const) expect(fullSet(id)).toHaveLength(humanoidGirlV1Groups.length);
  });
});

describe('MIX-01 multi-atlas character', () => {
  it('head A + legs B + near arm C draw from three atlases on one shared SkeletonData', async () => {
    const rig = sharedRig();
    const character = await mixed(rig, new AtlasCache(testLoader(fixtureFiles())));
    expect(character.skeleton.data).toBe(rig.data);
    expect(atlasOf(character, 'head')).toBe('a.png');
    expect(atlasOf(character, 'thigh_near')).toBe('b.png');
    expect(armSlots.map((slot) => atlasOf(character, slot))).toEqual(['c.png', 'c.png', 'c.png', 'c.png']);
    const pages = new Set<string>();
    character.state.setAnimation(0, 'run', true);
    character.state.update(0.2);
    character.state.apply(character.skeleton);
    character.skeleton.updateWorldTransform(spine.Physics.update);
    for (const slot of character.skeleton.drawOrder.appliedPose) {
      const attachment = slot.appliedPose.getAttachment();
      if (!(attachment instanceof spine.RegionAttachment)) continue;
      const vertices = new Array<number>(8).fill(0);
      attachment.computeWorldVertices(slot, attachment.getOffsets(slot.appliedPose), vertices, 0, 2);
      expect(vertices.every(Number.isFinite)).toBe(true);
      const region = attachment.sequence.regions[0] as spine.TextureAtlasRegion;
      expect(region.texture).toBeInstanceOf(CountingTexture);
      pages.add(region.page.name);
    }
    expect([...pages].sort()).toEqual(['a.png', 'b.png', 'c.png']);
  });
});

describe('MIX-02 arm swap during run', () => {
  it('switches the whole arm between two frames, keeps time, bones, objects and other attachments', async () => {
    const rig = sharedRig();
    // The loader waits three frames, so frames continue with the old arm while the new atlas loads.
    const cache = new AtlasCache(testLoader(fixtureFiles(), { delay: async () => Promise.all([tick(), tick(), tick()]).then(() => undefined) }));
    const character = await mixed(rig, cache);
    const { skeleton, state } = character;
    const entry = state.setAnimation(0, 'run', true);
    const frames: { time: number; arm: (string | null)[] }[] = [];
    const frame = (): void => {
      state.update(1 / 60);
      state.apply(skeleton);
      skeleton.updateWorldTransform(spine.Physics.update);
      frames.push({ time: entry.trackTime, arm: armSlots.map((slot) => atlasOf(character, slot)) });
    };
    for (let index = 0; index < 10; index += 1) frame();
    const others = character.skeleton.slots.filter((slot) => !armSlots.includes(slot.data.name)).map((slot) => slot.pose.getAttachment());
    const swap = character.setModules([moduleFor('b', 'arm_near')]);
    let done = false;
    void swap.then(() => {
      done = true;
    });
    for (let index = 0; index < 20 && !done; index += 1) {
      frame();
      await tick();
    }
    await swap;
    const timeAtCommit = entry.trackTime;
    for (let index = 0; index < 5; index += 1) frame();
    expect(character.skeleton).toBe(skeleton);
    expect(character.state).toBe(state);
    expect(state.tracks[0]).toBe(entry);
    expect(entry.trackTime).toBeCloseTo(timeAtCommit + 5 / 60, 10);
    // Time grows by one step per frame, without a reset.
    for (let index = 1; index < frames.length; index += 1) expect((frames[index]?.time ?? 0) - (frames[index - 1]?.time ?? 0)).toBeCloseTo(1 / 60, 10);
    // Every frame shows one complete arm: never a mix of C and B parts.
    for (const item of frames) expect(new Set(item.arm).size, JSON.stringify(item)).toBe(1);
    const sequence = frames.map((item) => item.arm[0]);
    expect(sequence[0]).toBe('c.png');
    expect(sequence.at(-1)).toBe('b.png');
    expect(sequence.filter((page, index) => index > 0 && page !== sequence[index - 1])).toEqual(['b.png']);
    expect(frames.filter((item) => item.arm[0] === 'c.png').length).toBeGreaterThan(10);
    expect(character.skeleton.slots.filter((slot) => !armSlots.includes(slot.data.name)).map((slot) => slot.pose.getAttachment())).toEqual(others);
  });

  it('the swap commit changes no bone transform', async () => {
    const character = await mixed(sharedRig(), new AtlasCache(testLoader(fixtureFiles())));
    character.state.setAnimation(0, 'run', true);
    character.state.update(0.4);
    character.state.apply(character.skeleton);
    character.skeleton.updateWorldTransform(spine.Physics.update);
    const before = boneState(character.skeleton);
    await character.setModules([moduleFor('b', 'arm_near')]);
    expect(boneState(character.skeleton)).toEqual(before);
    character.skeleton.updateWorldTransform(spine.Physics.update);
    expect(boneState(character.skeleton)).toEqual(before);
  });
});

describe('MIX-03 optional parts without a fake 1x1 image', () => {
  it('turns the head accessory and the ears on and off with modules', async () => {
    // The atlas of A is the "Ignore blank images: on" export: it has no region for any absent part.
    const blank = readFixture('editor-out-blank/a/a.atlas');
    const blankRef = { ...moduleFor('a', 'head').atlas, file: 'a-blank/a.atlas', sha256: sha256(blank) };
    const blankA = (group: string): PartModule => moduleFor('a', group, { atlas: blankRef });
    const character = new ModularCharacter(
      spine,
      sharedRig(),
      new AtlasCache(testLoader({ ...fixtureFiles(), 'a-blank/a.atlas': blank })),
      { groups: humanoidGirlV1Groups, rules, pma: true },
      'blank'
    );
    await character.setModules(humanoidGirlV1Groups.map((group) => blankA(group.id)));
    expect(atlasOf(character, 'acc_head')).toBeNull();
    expect(atlasOf(character, 'ear_near')).toBeNull();
    await character.setModules([moduleFor('b', 'head_accessory')]);
    expect(atlasOf(character, 'acc_head')).toBe('b.png');
    await character.setModules([moduleFor('b', 'head')]);
    expect(atlasOf(character, 'ear_near')).toBe('b.png');
    await character.setModules([blankA('head_accessory'), blankA('head')]);
    expect(atlasOf(character, 'acc_head')).toBeNull();
    expect(atlasOf(character, 'ear_near')).toBeNull();
    for (const slot of character.skeleton.slots) {
      const attachment = slot.pose.getAttachment();
      if (attachment instanceof spine.RegionAttachment) expect((attachment.sequence.regions[0] as spine.TextureAtlasRegion).originalWidth).toBeGreaterThan(1);
    }
  });
});

describe('MIX-04 resource lifetime', () => {
  it('120 swaps and 12 destroy/re-create cycles keep textures inside the budget and leave none after disposal', async () => {
    CountingTexture.live = 0;
    const rig = sharedRig();
    const loader = testLoader(fixtureFiles());
    const cache = new AtlasCache(loader, 1);
    const watcher = await mixed(rig, cache, 'watcher');
    const watcherAttachments = attachments(watcher);
    const swapper = await mixed(rig, cache, 'swapper');
    let temporary = await mixed(rig, cache, 'temporary');
    const order = ['b', 'c', 'a'] as const;
    let peak = 0;
    for (let index = 0; index < 120; index += 1) {
      await swapper.setModules([moduleFor(order[index % 3] ?? 'a', 'arm_near')]);
      if (index % 10 === 9) {
        await temporary.dispose();
        temporary = await mixed(rig, cache, `temporary-${index}`);
      }
      peak = Math.max(peak, CountingTexture.live);
      // Budget: three atlases with one page each. Owned + unused atlases can never exceed it.
      expect(CountingTexture.live).toBeLessThanOrEqual(3);
      expect(cache.stats().unused).toBeLessThanOrEqual(1);
    }
    expect(attachments(watcher)).toEqual(watcherAttachments);
    expect(swapper.revision).toBe(121);
    for (const item of [watcher, swapper, temporary]) await item.dispose();
    expect(Object.values(cache.stats().owners).every((count) => count === 0)).toBe(true);
    cache.trim();
    expect(CountingTexture.live).toBe(0);
    expect(cache.stats()).toMatchObject({ live: 0, unused: 0 });
    expect(peak).toBe(3);
    expect(() => cache.release(moduleFor('a', 'arm_near').atlas)).toThrow(/E_CACHE_RELEASE/);
  });
});

describe('MIX-NEG explicit failure with atomic rollback', () => {
  const rig = sharedRig();
  const base = contract();
  const raw = (item: PartModule, change: (copy: Record<string, unknown>) => void): PartModule => {
    const copy = structuredClone(item) as unknown as Record<string, unknown>;
    change(copy);
    return copy as unknown as PartModule;
  };
  const arm = (): PartModule => moduleFor('b', 'arm_near');
  const bindings = (item: PartModule): Record<string, unknown>[] => structuredClone(item.bindings) as unknown as Record<string, unknown>[];
  // The atlas "d" is a copy of B with its own page name, so that the cache loads it only for the swap under test.
  const dText = atlasText('b').replace('b.png', 'd.png');
  const dBroken = dText.replace('offsets:25,11,100,220', 'offsets:25,11,100,221');
  const dArm = (text = dText): PartModule =>
    moduleFor('b', 'arm_near', { moduleId: 'd.arm_near', atlas: { file: 'd/d.atlas', sha256: sha256(text), pma: true, pages: [{ file: 'd/d.png', sha256: '0'.repeat(64) }] } });
  const cases: [string, () => PartModule, string, Record<string, string>?, string[]?][] = [
    ['unknown slot', () => raw(arm(), (copy) => (copy.bindings = [...bindings(arm()), { slot: 'wing_near', status: 'present', region: 'wing_near' }])), 'E_UNKNOWN_SLOT'],
    ['wrong rigId', () => raw(arm(), (copy) => (copy.rig = { rigId: 'other_rig', contractVersion: '0.2.0' })), 'E_MODULE_RIG_MISMATCH'],
    ['wrong contract line', () => raw(arm(), (copy) => (copy.rig = { rigId: base.rigId, contractVersion: '0.3.0' })), 'E_MODULE_RIG_MISMATCH'],
    ['missing source texture', () => dArm(), 'Error: E_TEXTURE_MISSING: d.png', { 'd/d.atlas': dText }, ['d.png']],
    ['changed atlas bytes', () => dArm(), 'Error: E_ATLAS_HASH_MISMATCH: d/d.atlas', { 'd/d.atlas': `${dText}\n` }],
    ['invalid rect', () => dArm(dBroken), 'E_REGION_ORIG_MISMATCH', { 'd/d.atlas': dBroken }],
    ['incompatible module', () => raw(arm(), (copy) => (copy.tags = { skin_tone: 'tone2' })), 'E_MODULE_INCOMPATIBLE'],
    ['incomplete grouped arm', () => raw(arm(), (copy) => (copy.bindings = bindings(arm()).filter((item) => item.slot !== 'hand_near'))), 'E_MODULE_INCOMPLETE_GROUP'],
    [
      'region collision',
      () => raw(arm(), (copy) => (copy.bindings = bindings(arm()).map((item) => (item.slot === 'hand_near_front' ? { ...item, region: 'hand_near' } : item)))),
      'E_MODULE_REGION_COLLISION'
    ],
    ['wrong side', () => raw(arm(), (copy) => (copy.side = 'far')), 'E_MODULE_SIDE_MISMATCH'],
    ['pma mismatch', () => raw(arm(), (copy) => (copy.atlas = { ...arm().atlas, pma: false })), 'E_PMA_MISMATCH'],
    ['missing region', () => raw(arm(), (copy) => (copy.bindings = bindings(arm()).map((item) => (item.slot === 'hand_near' ? { ...item, region: 'hand_far_x' } : item)))), 'E_REGION_MISSING']
  ];

  it.each(cases)('%s: fails with %s and keeps the character and the cache unchanged', async (_name, make, code, files, missingPages) => {
    const cache = new AtlasCache(testLoader({ ...fixtureFiles(), ...files }, missingPages ? { missingPages } : {}));
    const character = await mixed(rig, cache);
    const before = { attachments: attachments(character), modules: character.modules(), revision: character.revision, owners: owned(cache) };
    expect(await codes(() => character.setModules([make()]))).toContain(code);
    expect(attachments(character)).toEqual(before.attachments);
    expect(character.modules()).toEqual(before.modules);
    expect(character.revision).toBe(before.revision);
    expect(owned(cache)).toEqual(before.owners);
    // The character still accepts a valid change after the failure.
    await character.setModules([moduleFor('b', 'arm_near')]);
    expect(atlasOf(character, 'hand_near')).toBe('b.png');
  });

  it('parseModule rejects the same defects before any load', () => {
    expect(() => parseModule({ ...arm(), group: 'wings' }, base, humanoidGirlV1Groups)).toThrow(/E_MODULE_UNKNOWN_GROUP/);
    expect(() => parseModule({ ...arm(), atlas: { ...arm().atlas, file: '../x.atlas' } }, base, humanoidGirlV1Groups)).toThrow(/E_UNSAFE_PATH/);
    expect(() => parseModule({ ...arm(), extra: 1 }, base, humanoidGirlV1Groups)).toThrow(/E_MODULE_FORMAT/);
  });
});

describe('MIX-DET deterministic composition', () => {
  const catalog = (['a', 'b', 'c'] as const).flatMap((id) => fullSet(id));

  it('gives the same selection and hash for a fixed seed, independent of catalog order', () => {
    const first = selectionText(composeModules(20261104, catalog, humanoidGirlV1Groups, rules));
    const second = selectionText(composeModules(20261104, [...catalog].reverse(), humanoidGirlV1Groups, rules));
    expect(second).toBe(first);
    expect(sha256(first)).toBe(sha256(second));
    const selections = new Set(Array.from({ length: 20 }, (_item, seed) => selectionText(composeModules(seed, catalog, humanoidGirlV1Groups, rules))));
    expect(selections.size).toBeGreaterThan(5);
  });

  it('respects compatibility rules and reports when no module fits', () => {
    const odd = { ...moduleFor('c', 'legs'), moduleId: 'x.legs', tags: { skin_tone: 'tone2', style: 'fixture' } } as PartModule;
    for (let seed = 0; seed < 50; seed += 1) {
      const selection = composeModules(seed, [...catalog, odd], humanoidGirlV1Groups, rules);
      expect(selection.get('legs')?.moduleId).not.toBe('x.legs');
    }
    expect(() => composeModules(1, [...catalog.filter((item) => item.group !== 'legs'), odd], humanoidGirlV1Groups, rules)).toThrow(/E_COMPOSE_NO_COMPATIBLE/);
  });

  it('records the composition hash of seed 20261104 for cross-platform comparison', () => {
    const text = selectionText(composeModules(20261104, catalog, humanoidGirlV1Groups, rules));
    expect(text.split('\n').map((line) => `${line.slice(0, line.indexOf('='))}=${(JSON.parse(line.slice(line.indexOf('=') + 1)) as PartModule).moduleId}`)).toMatchSnapshot();
  });
});

describe('host adoption and cache sharing', () => {
  it('adopts the skeleton and state of a host (for example a spine-webcomponents widget) only on the shared SkeletonData', async () => {
    const rig = sharedRig();
    const cache = new AtlasCache(testLoader(fixtureFiles()));
    const skeleton = new spine.Skeleton(rig.data);
    const state = new spine.AnimationState(new spine.AnimationStateData(rig.data));
    const character = new ModularCharacter(spine, rig, cache, { groups: humanoidGirlV1Groups, rules, pma: true, host: { skeleton, state } }, 'host');
    await character.setModules(fullSet('b'));
    expect(character.skeleton).toBe(skeleton);
    expect(skeleton.findSlot('head')?.pose.getAttachment()).not.toBeNull();
    const other = sharedRig();
    expect(() => new ModularCharacter(spine, other, cache, { groups: humanoidGirlV1Groups, pma: true, host: { skeleton, state } }, 'bad')).toThrow(/E_RIG_DATA_MISMATCH/);
  });

  it('loads an atlas once for concurrent owners', async () => {
    const loader = testLoader(fixtureFiles(), { delay: tick });
    const cache = new AtlasCache(loader);
    const ref = moduleFor('b', 'legs').atlas;
    const [first, second] = await Promise.all([cache.acquire(ref), cache.acquire(ref)]);
    expect(first).toBe(second);
    expect(loader.calls).toEqual(['b/b.atlas']);
    expect(cache.stats().owners[atlasIdentity(ref)]).toBe(2);
  });
});
