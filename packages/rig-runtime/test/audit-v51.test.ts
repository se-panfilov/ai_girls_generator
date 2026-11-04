import { AtlasCache } from '@rig-runtime/atlas-cache';
import { type AtlasRef, canonicalJson, catalogProblems, composeModules, humanoidGirlV1Groups, type ModuleGroup, type PartModule, selectionText } from '@rig-runtime/modules';
import { RigRuntimeError } from '@rig-runtime/problems';
import { describe, expect, it } from 'vitest';

import { atlasText, CountingTexture, fullSet, moduleFor, sha256, testLoader } from './helpers';

// Regression tests for the findings of the independent PR #7 audit (Agent Task v5.1).

const rules = [{ tag: 'skin_tone', groups: ['head', 'torso', 'arm_near', 'arm_far', 'legs'] }];
const group = (id: string): ModuleGroup[] => humanoidGirlV1Groups.filter((item) => item.id === id);

/** Result of a composition as text: the selection, or the error codes. */
function outcome(seed: number, catalog: readonly PartModule[], groups = humanoidGirlV1Groups): string {
  try {
    return selectionText(composeModules(seed, catalog, groups, rules));
  } catch (error) {
    if (error instanceof RigRuntimeError) return error.problems.map((item) => item.code).join(',');
    throw error;
  }
}

describe('P0 atlas cache identity', () => {
  const text = atlasText('b');
  const files = { 'x/b.atlas': text, 'y/b.atlas': text, 'z/b.atlas': text };
  const ref = (dir: string, pageSha: string): AtlasRef => ({ file: `${dir}/b.atlas`, sha256: sha256(text), pma: true, pages: [{ file: `${dir}/b.png`, sha256: pageSha }] });
  const pageOne = '1'.repeat(64);
  const pageTwo = '2'.repeat(64);
  const label = (atlas: { pages: { texture: unknown }[] }): string => (atlas.pages[0]?.texture as CountingTexture).label;

  it('identical .atlas bytes with different page image hashes load two texture sets', async () => {
    const loader = testLoader(files);
    const cache = new AtlasCache(loader, 0);
    const first = await cache.acquire(ref('x', pageOne));
    const second = await cache.acquire(ref('y', pageTwo));
    expect(second).not.toBe(first);
    expect(loader.calls).toEqual(['x/b.atlas', 'y/b.atlas']);
    expect(label(first)).toBe('x/b.atlas:b.png');
    expect(label(second)).toBe('y/b.atlas:b.png');
    // Independent ownership: releasing the first reference never disposes the texture of the second.
    cache.release(ref('x', pageOne));
    cache.trim();
    expect((first.pages[0]?.texture as CountingTexture).disposed).toBe(true);
    expect((second.pages[0]?.texture as CountingTexture).disposed).toBe(false);
    expect(() => cache.release(ref('x', pageOne))).toThrow(/E_CACHE_RELEASE/);
    cache.release(ref('y', pageTwo));
    cache.trim();
    expect((second.pages[0]?.texture as CountingTexture).disposed).toBe(true);
  });

  it('genuinely identical assets (same atlas and page hashes) share one texture set with counted owners', async () => {
    const loader = testLoader(files);
    const cache = new AtlasCache(loader, 0);
    const live = CountingTexture.live;
    const first = await cache.acquire(ref('x', pageOne));
    const second = await cache.acquire(ref('z', pageOne));
    expect(second).toBe(first);
    expect(loader.calls).toEqual(['x/b.atlas']);
    expect(cache.stats()).toMatchObject({ live: 1, loads: 1 });
    cache.release(ref('z', pageOne));
    expect((first.pages[0]?.texture as CountingTexture).disposed).toBe(false);
    cache.release(ref('x', pageOne));
    expect((first.pages[0]?.texture as CountingTexture).disposed).toBe(true);
    expect(CountingTexture.live).toBe(live);
    expect(cache.stats()).toMatchObject({ live: 0, unused: 0, loads: 1, unloads: 1 });
  });
});

describe('P1 complete composition', () => {
  const headOne = moduleFor('a', 'head', { moduleId: 'h.tone1', tags: { skin_tone: 'tone1', style: 'fixture' } });
  const headTwo = moduleFor('b', 'head', { moduleId: 'h.tone2', tags: { skin_tone: 'tone2', style: 'fixture' } });
  const torso = moduleFor('a', 'torso', { moduleId: 't.tone1', tags: { skin_tone: 'tone1', style: 'fixture' } });
  const groups = [...group('head'), ...group('torso')];

  it('finds the only compatible selection for every seed (head tone2 has no torso)', () => {
    for (let seed = 0; seed < 64; seed += 1) {
      expect(outcome(seed, [headOne, headTwo, torso], groups)).toBe(`head=h.tone1@${headOne.atlas.sha256}\ntorso=t.tone1@${torso.atlas.sha256}`);
    }
  });

  it('keeps seeded reproducibility and uses more than one choice when several selections exist', () => {
    const catalog = (['a', 'b', 'c'] as const).flatMap((id) => fullSet(id));
    for (let seed = 0; seed < 16; seed += 1) expect(outcome(seed, catalog)).toBe(outcome(seed, catalog));
    expect(new Set(Array.from({ length: 32 }, (_item, seed) => outcome(seed, catalog))).size).toBeGreaterThan(5);
  });

  it('reports E_COMPOSE_NO_COMPATIBLE when no complete selection exists', () => {
    expect(outcome(1, [headTwo, torso], groups)).toBe('E_COMPOSE_NO_COMPATIBLE');
    expect(outcome(1, [headOne], groups)).toBe('E_COMPOSE_NO_COMPATIBLE');
  });

  it('bounds the search and the catalog size, and stops without a result at a limit', () => {
    // Worst case: 40 heads of tone2 are tried before the only head of tone1 (no torso agrees with tone2).
    const heads = Array.from({ length: 40 }, (_item, index) => moduleFor('b', 'head', { moduleId: `h.tone2.${index}`, tags: { skin_tone: 'tone2', style: 'fixture' } }));
    const catalog = [...heads, headOne, torso];
    expect(outcome(3, catalog, groups)).toBe(`head=h.tone1@${headOne.atlas.sha256}\ntorso=t.tone1@${torso.atlas.sha256}`);
    const limited = (options: { maxModules?: number; maxSteps?: number }): string => {
      try {
        return selectionText(composeModules(3, catalog, groups, rules, options));
      } catch (error) {
        return error instanceof RigRuntimeError ? error.code : String(error);
      }
    };
    expect(limited({ maxSteps: 5 })).toBe('E_COMPOSE_SEARCH_LIMIT');
    expect(limited({ maxModules: 10 })).toBe('E_COMPOSE_CATALOG_TOO_LARGE');
    expect(limited({ maxSteps: 0 })).toBe('E_COMPOSE_CONFIG');
    expect(limited({ maxSteps: 1.5 })).toBe('E_COMPOSE_CONFIG');
  });
});

describe('P1 duplicate module ids', () => {
  const legsA = moduleFor('a', 'legs', { moduleId: 'dup.legs' });
  const legsB = moduleFor('b', 'legs', { moduleId: 'dup.legs' });
  const rest = fullSet('a').filter((item) => item.group !== 'legs');

  it('a reversed catalog gives the same outcome for the same seed, also with an ambiguous module id', () => {
    for (let seed = 0; seed < 32; seed += 1) {
      const catalog = [...rest, legsA, legsB];
      expect(outcome(seed, [...catalog].reverse())).toBe(outcome(seed, catalog));
    }
  });

  it('rejects the same module id with different content (E_CATALOG_DUPLICATE_ID) in every order', () => {
    expect(outcome(7, [...rest, legsA, legsB])).toBe('E_CATALOG_DUPLICATE_ID');
    expect(outcome(7, [legsB, ...rest, legsA])).toBe('E_CATALOG_DUPLICATE_ID');
    expect(catalogProblems([legsA, legsB, legsA])).toHaveLength(1);
  });

  it('permits copies with the same content and ignores key order in the content identity', () => {
    const copy = JSON.parse(JSON.stringify(legsA)) as PartModule;
    const reordered = Object.fromEntries(Object.entries(copy).reverse()) as PartModule;
    expect(canonicalJson(reordered)).toBe(canonicalJson(legsA));
    for (let seed = 0; seed < 16; seed += 1) {
      const catalog = [...rest, legsA, reordered, moduleFor('b', 'legs')];
      expect(outcome(seed, [...catalog].reverse())).toBe(outcome(seed, catalog));
      expect(outcome(seed, catalog)).not.toMatch(/^E_/);
    }
  });
});
