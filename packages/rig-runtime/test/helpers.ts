import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as spine from '@esotericsoftware/spine-core';
import { type AtlasLoader } from '@rig-runtime/atlas-cache';
import { type CharacterParts, parseCharacter } from '@rig-runtime/character';
import { parseRigContract, type RigContract } from '@rig-runtime/contract';
import { humanoidGirlV1Groups, moduleSchema, parseModule, type PartModule } from '@rig-runtime/modules';
import { loadSharedRig, type SharedRig } from '@rig-runtime/rig';

export { spine };

export const fixtureDir = fileURLToPath(new URL('fixtures/l1-owner/', import.meta.url));
export const readFixture = (path: string): string => readFileSync(`${fixtureDir}${path}`, 'utf8');
export const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

/** Page image hashes from the owner archive (the images are not in the repository). */
export const pageSha256: Record<string, string> = {
  'a.png': 'b2bfd12cddc62f27b51487c22d24269573d29467a3b493ef58da91ce0bd382f9',
  'b.png': '3d738f051ca267428b02a90268e80aa3590d417d45999765ccdea452c10b4e0e',
  'c.png': '4e6a2d5fbaa91cc1121d97ccb039ff1e190bfd6611305849cea09c9251cdee22'
};

export const contract = (): RigContract => parseRigContract(JSON.parse(readFixture('rig.contract.json')));
export const sharedRig = (): SharedRig => loadSharedRig(spine, readFixture('editor-out/skeleton.json'), contract());
export const character = (id: 'a' | 'b' | 'c', base = contract()): CharacterParts => parseCharacter(JSON.parse(readFixture(`characters/${id}.json`)), base);
export const atlasText = (id: 'a' | 'b' | 'c'): string => readFixture(`editor-out/${id}/${id}.atlas`);

/** Texture without GPU memory. It counts live textures, so tests can measure leaks. */
export class CountingTexture extends spine.Texture {
  static live = 0;
  static created = 0;
  disposed = false;

  constructor(readonly label: string) {
    super({ width: 1, height: 1 });
    CountingTexture.live += 1;
    CountingTexture.created += 1;
  }

  setFilters(): void {}

  setWraps(): void {}

  dispose(): void {
    if (this.disposed) throw new Error(`Texture ${this.label} is disposed twice.`);
    this.disposed = true;
    CountingTexture.live -= 1;
  }
}

/**
 * Atlas loader for tests. Files come from `files` (path → text). Each page gets a CountingTexture.
 * It checks the atlas hash like a real loader and can fail for listed page files (a missing source texture).
 */
export function testLoader(files: Record<string, string>, options: { missingPages?: readonly string[]; delay?: () => Promise<void> } = {}): AtlasLoader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async load(ref) {
      calls.push(ref.file);
      if (options.delay) await options.delay();
      const text = files[ref.file];
      if (text === undefined) throw new Error(`E_ATLAS_FILE_MISSING: ${ref.file}`);
      if (sha256(text) !== ref.sha256) throw new Error(`E_ATLAS_HASH_MISMATCH: ${ref.file}`);
      const atlas = new spine.TextureAtlas(text);
      for (const page of atlas.pages) {
        if (options.missingPages?.includes(page.name)) throw new Error(`E_TEXTURE_MISSING: ${page.name}`);
        page.setTexture(new CountingTexture(`${ref.file}:${page.name}`));
      }
      return atlas;
    },
    unload(_ref, atlas) {
      atlas.dispose();
    }
  };
}

export const fixtureFiles = (): Record<string, string> => ({ 'a/a.atlas': atlasText('a'), 'b/b.atlas': atlasText('b'), 'c/c.atlas': atlasText('c') });

/** Makes a module manifest for one group from a fixture character. Tags are synthetic test values. */
export function moduleFor(id: 'a' | 'b' | 'c', groupId: string, overrides: Partial<Record<keyof PartModule, unknown>> = {}): PartModule {
  const base = contract();
  const group = humanoidGirlV1Groups.find((item) => item.id === groupId);
  if (!group) throw new Error(`Unknown group ${groupId}`);
  const parts = character(id, base).parts;
  const raw = {
    schema: moduleSchema,
    moduleId: `${id}.${groupId}`,
    rig: { rigId: base.rigId, contractVersion: base.contractVersion },
    group: group.id,
    side: group.side,
    bindings: group.slots.map((slot) => (parts[slot]?.status === 'present' ? { slot, status: 'present', region: slot } : { slot, status: 'absent_by_design' })),
    atlas: { file: `${id}/${id}.atlas`, sha256: sha256(atlasText(id)), pma: true, pages: [{ file: `${id}/${id}.png`, sha256: pageSha256[`${id}.png`] }] },
    tags: { skin_tone: 'tone1', style: 'fixture' },
    provenance: { source: `l1-owner-evidence ${id}`, tool: 'Spine Essential 4.3.26 Texture Packer' },
    ...overrides
  };
  return parseModule(raw, base, humanoidGirlV1Groups);
}

/** One module per group, all from one fixture character. */
export const fullSet = (id: 'a' | 'b' | 'c'): PartModule[] => humanoidGirlV1Groups.map((group) => moduleFor(id, group.id));
