import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { applySkin, assembleCharacter } from '@rig-runtime/assemble';
import { parseCharacter } from '@rig-runtime/character';
import { RigRuntimeError } from '@rig-runtime/problems';
import { loadSharedRig, type SharedRig } from '@rig-runtime/rig';
import { describe, expect, it } from 'vitest';

import { atlasText, character, contract, fixtureDir, readFixture, sha256, sharedRig, spine } from './helpers';

type Pose = { animation: string | null; time: number };
const poses: Pose[] = [
  { animation: null, time: 0 },
  { animation: 'run', time: 0.37 },
  { animation: 'shoot_crouch', time: 0.5 }
];

function pose(skeleton: spine.Skeleton, data: spine.SkeletonData, item: Pose): void {
  skeleton.setupPose();
  if (item.animation) {
    const state = new spine.AnimationState(new spine.AnimationStateData(data));
    state.setAnimation(0, item.animation, true);
    state.update(item.time);
    state.apply(skeleton);
  }
  skeleton.updateWorldTransform(spine.Physics.update);
}

/** World vertices and UVs of every visible region attachment, keyed by slot. */
function drawList(skeleton: spine.Skeleton): Map<string, { vertices: number[]; uvs: number[]; region: string }> {
  const list = new Map<string, { vertices: number[]; uvs: number[]; region: string }>();
  for (const slot of skeleton.drawOrder.appliedPose) {
    const attachment = slot.appliedPose.getAttachment();
    if (!(attachment instanceof spine.RegionAttachment)) continue;
    const vertices = new Array<number>(8).fill(0);
    attachment.computeWorldVertices(slot, attachment.getOffsets(slot.appliedPose), vertices, 0, 2);
    const index = attachment.sequence.resolveIndex(slot.appliedPose);
    const region = attachment.sequence.regions[index] as spine.TextureAtlasRegion;
    list.set(slot.data.name, { vertices, uvs: [...attachment.sequence.getUVs(index)], region: region.name });
  }
  return list;
}

/** The v4 path: the unchanged editor JSON read with the standard AtlasAttachmentLoader of one atlas. */
function editorPath(atlas: string): spine.Skeleton {
  const data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(new spine.TextureAtlas(atlas))).readSkeletonData(readFixture('editor-out/skeleton.json'));
  return new spine.Skeleton(data);
}

function assembled(rig: SharedRig, id: 'a' | 'b' | 'c', atlas = atlasText(id)): { skeleton: spine.Skeleton; result: ReturnType<typeof assembleCharacter> } {
  const result = assembleCharacter(spine, rig, character(id), atlas, { pma: true });
  const skeleton = new spine.Skeleton(rig.data);
  applySkin(skeleton, result.skin);
  return { skeleton, result };
}

function codes(action: () => unknown): string[] {
  try {
    action();
  } catch (error) {
    if (error instanceof RigRuntimeError) return error.problems.map((item) => item.code);
    throw error;
  }
  return [];
}

describe('owner fixtures', () => {
  it('are byte-exact copies of the owner evidence', () => {
    const sums = readFixture('SHA256SUMS')
      .trim()
      .split('\n')
      .map((line) => line.split('  ./') as [string, string]);
    expect(sums).toHaveLength(9);
    for (const [hash, path] of sums) expect(sha256(readFileSync(join(fixtureDir, path))), path).toBe(hash);
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [relative(fixtureDir, join(dir, name))]));
    expect(
      files(fixtureDir)
        .filter((path) => !['README.md', 'SHA256SUMS'].includes(path))
        .sort()
    ).toEqual(sums.map(([, path]) => path).sort());
    expect(sha256(readFixture('editor-out/skeleton.json'))).toBe('1cd5bf8c886f09f4fd629cd504020616a105ce310cd7f46031898e0883943eb5');
  });
});

describe('shared rig from the real editor export (P2)', () => {
  it('loads 28 bones, 27 slots and 9 animations with an empty default skin', () => {
    const rig = sharedRig();
    expect(rig.spineVersion).toBe('4.3.26');
    expect(rig.data.bones).toHaveLength(28);
    expect(rig.data.slots).toHaveLength(27);
    expect(rig.data.animations).toHaveLength(9);
    expect(rig.data.skins).toHaveLength(1);
    expect(rig.data.defaultSkin?.getAttachments()).toEqual([]);
    expect(rig.templates.size).toBe(27);
  });

  it('rejects attachments outside the rigid-region profile and rectangles that differ from the contract', () => {
    const json = JSON.parse(readFixture('editor-out/skeleton.json')) as { skins: { attachments: Record<string, Record<string, Record<string, unknown>>> }[] };
    const mesh = structuredClone(json);
    const tail = mesh.skins[0]?.attachments.tail?.tail;
    if (tail) tail.type = 'mesh';
    expect(codes(() => loadSharedRig(spine, JSON.stringify(mesh), contract()))).toContain('E_PROFILE_ATTACHMENT_TYPE');
    const wide = structuredClone(json);
    const head = wide.skins[0]?.attachments.head?.head;
    if (head) head.width = 251;
    expect(codes(() => loadSharedRig(spine, JSON.stringify(wide), contract()))).toEqual(['E_TEMPLATE_RECT_MISMATCH']);
  });
});

describe('character assembly with absent parts (P2)', () => {
  it('A with "Ignore blank images: off": 19 parts attached, 8 absent parts without attachment, 8 1x1 regions ignored', () => {
    const { skeleton, result } = assembled(sharedRig(), 'a');
    expect(result.attached.size).toBe(19);
    expect([...result.omitted].sort()).toEqual(['acc_head', 'ear_far', 'ear_near', 'hair_tail', 'hand_near_front', 'skirt_back', 'skirt_front', 'tail']);
    expect(result.warnings.map((item) => item.code)).toEqual(new Array(8).fill('W_ABSENT_PART_REGION_IGNORED'));
    for (const slot of result.omitted) expect(skeleton.findSlot(slot)?.pose.getAttachment()).toBeNull();
  });

  it('A with "Ignore blank images: on" (no region for absent parts) assembles the same skin, where the v4 path throws', () => {
    const blank = readFixture('editor-out-blank/a/a.atlas');
    expect(() => editorPath(blank)).toThrow(/Region not found in atlas: acc_head/);
    const { result } = assembled(sharedRig(), 'a', blank);
    expect(result.attached.size).toBe(19);
    expect(result.warnings).toEqual([]);
  });

  it('B has 27 parts and C has 23 parts with 4 absent', () => {
    const rig = sharedRig();
    expect(assembled(rig, 'b').result.attached.size).toBe(27);
    const c = assembled(rig, 'c').result;
    expect(c.attached.size).toBe(23);
    expect([...c.omitted].sort()).toEqual(['ear_far', 'ear_near', 'hair_tail', 'tail']);
  });

  it.each(['a', 'b', 'c'] as const)('character %s: present parts have the same world vertices and UVs as the v4 editor path in setup, run and shoot_crouch', (id) => {
    const rig = sharedRig();
    const { skeleton } = assembled(rig, id);
    const reference = editorPath(atlasText(id));
    const absent = new Set(Object.entries(character(id).parts).flatMap(([slot, part]) => (part.status === 'present' ? [] : [slot])));
    for (const item of poses) {
      pose(skeleton, rig.data, item);
      pose(reference, reference.data, item);
      const ours = drawList(skeleton);
      const theirs = drawList(reference);
      // The v4 path also draws the invisible 1x1 placeholders of absent parts. They are the only difference.
      expect([...theirs.keys()].filter((slot) => !ours.has(slot)).sort()).toEqual([...absent].sort());
      for (const [slot, draw] of ours) expect(draw, `${id} ${slot} ${item.animation ?? 'setup'}`).toEqual(theirs.get(slot));
    }
  });

  it('A, B and C share one SkeletonData, which assembly does not change', () => {
    const rig = sharedRig();
    const summary = (): string =>
      JSON.stringify([
        rig.data.bones.map((bone) => bone.name),
        rig.data.slots.map((slot) => slot.attachmentName),
        rig.data.animations.map((item) => item.duration),
        rig.data.defaultSkin?.getAttachments().length
      ]);
    const before = summary();
    const skeletons = (['a', 'b', 'c'] as const).map((id) => assembled(rig, id).skeleton);
    expect(new Set(skeletons.map((item) => item.data)).size).toBe(1);
    expect(summary()).toBe(before);
  });
});

describe('negative tests with stable error codes (P2)', () => {
  const rig = sharedRig();
  const base = contract();
  const assemble = (id: 'a' | 'b' | 'c', atlas: string, parts?: unknown, pma = true): string[] =>
    codes(() => assembleCharacter(spine, rig, parts === undefined ? character(id) : parseCharacter(parts, base), atlas, { pma }));
  const charJson = (id: 'a' | 'b' | 'c'): { characterId: string; rigId: string; parts: Record<string, { status: string; file?: string }> } => JSON.parse(readFixture(`characters/${id}.json`)) as never;
  /** Replaces the lines of one region in atlas text. */
  const replaceRegion = (atlas: string, name: string, lines: string[]): string => {
    const all = atlas.split('\n');
    const start = all.indexOf(name);
    let end = start + 1;
    while (end < all.length && /^[a-z]+:/.test(all[end] ?? '')) end += 1;
    return [...all.slice(0, start), ...lines, ...all.slice(end)].join('\n');
  };

  it('a removed region of a present part: E_REGION_MISSING', () => {
    expect(assemble('b', replaceRegion(atlasText('b'), 'head', []))).toEqual(['E_REGION_MISSING']);
  });
  it('a required part marked absent: E_REQUIRED_PART_ABSENT', () => {
    const parts = charJson('b');
    parts.parts.head = { status: 'absent_by_design' };
    expect(assemble('b', atlasText('b'), parts)).toEqual(['E_REQUIRED_PART_ABSENT']);
  });
  it('a wrong original size of a present region: E_REGION_ORIG_MISMATCH', () => {
    expect(assemble('b', atlasText('b').replace('offsets:80,9,320,180', 'offsets:80,9,321,180'))).toEqual(['E_REGION_ORIG_MISMATCH']);
  });
  it('an unknown slot: E_UNKNOWN_SLOT', () => {
    const parts = charJson('b');
    parts.parts.wing_near = { status: 'present', file: 'parts/wing_near.png' };
    expect(assemble('b', atlasText('b'), parts)).toEqual(['E_UNKNOWN_SLOT']);
  });
  it('an unexpected file extension: E_UNEXPECTED_EXTENSION', () => {
    const parts = charJson('b');
    parts.parts.head = { status: 'present', file: 'parts/head.jpg' };
    expect(assemble('b', atlasText('b'), parts)).toEqual(['E_UNEXPECTED_EXTENSION']);
  });
  it('a transparent required asset (packed as a 1x1 region): E_PRESENT_PART_BLANK', () => {
    expect(assemble('b', replaceRegion(atlasText('b'), 'head', ['head', 'bounds:2,2,1,1']))).toEqual(['E_PRESENT_PART_BLANK']);
  });
  it('a straight-alpha atlas for a premultiplied renderer: E_PMA_MISMATCH', () => {
    expect(assemble('b', atlasText('b').replace('pma:true', 'pma:false'))).toEqual(['E_PMA_MISMATCH']);
    expect(assemble('b', atlasText('b'), undefined, false)).toEqual(['E_PMA_MISMATCH']);
  });
  it('an extra region that belongs to no slot: E_ATLAS_UNKNOWN_REGION', () => {
    expect(assemble('b', `${atlasText('b')}wing_near\nbounds:2,2,4,4\n`)).toEqual(['E_ATLAS_UNKNOWN_REGION']);
  });
  it('a duplicate region: E_ATLAS_DUPLICATE_REGION', () => {
    expect(assemble('b', `${atlasText('b')}head\nbounds:2,2,4,4\n`)).toEqual(['E_ATLAS_DUPLICATE_REGION']);
  });
  it('invalid geometry: E_ATLAS_REGION_GEOMETRY and E_ATLAS_REGION_OUTSIDE_PAGE', () => {
    expect(assemble('b', atlasText('b').replace('offsets:80,9,320,180', 'offsets:200,9,320,180'))).toEqual(['E_ATLAS_REGION_GEOMETRY']);
    expect(assemble('b', atlasText('b').replace('bounds:1756,155,160,162', 'bounds:1900,155,160,162'))).toEqual(['E_ATLAS_REGION_OUTSIDE_PAGE']);
  });
  it('another rig id: E_RIG_ID_MISMATCH', () => {
    const parts = charJson('b');
    parts.rigId = 'other_rig';
    expect(assemble('b', atlasText('b'), parts)).toEqual(['E_RIG_ID_MISMATCH']);
  });
});
