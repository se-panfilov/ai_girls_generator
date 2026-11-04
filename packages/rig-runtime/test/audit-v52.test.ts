import { composeModules, humanoidGirlV1Groups, type PartModule, selectionText } from '@rig-runtime/modules';
import { describe, expect, it } from 'vitest';

import { fullSet, moduleFor, sha256 } from './helpers';

// Regression tests for the second independent PR #7 audit (Agent Task v5.2): the identity of a module selection
// must cover the full content of each selected module and must not depend on the order of JSON keys.

const rules = [{ tag: 'skin_tone', groups: ['head', 'torso', 'arm_near', 'arm_far', 'legs'] }];
const one = (item: PartModule): Map<string, PartModule> => new Map([[item.group, item]]);
const identity = (selection: ReadonlyMap<string, PartModule>): string => sha256(selectionText(selection));

/** Deep copy with the object keys in reverse order at every level. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => reversedKeys(item));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reversedKeys(item)])
    );
  return value;
}

describe('selection identity covers the full module content', () => {
  const arm = moduleFor('c', 'arm_near');

  it('same moduleId and .atlas hash, different page image hash: different identities', () => {
    const other = { ...arm, atlas: { ...arm.atlas, pages: [{ file: arm.atlas.pages[0]?.file ?? 'c/c.png', sha256: '0'.repeat(64) }] } };
    expect(other.moduleId).toBe(arm.moduleId);
    expect(other.atlas.sha256).toBe(arm.atlas.sha256);
    expect(identity(one(other))).not.toBe(identity(one(arm)));
  });

  it('a change of bindings or compatibility tags gives a different identity', () => {
    const bindings = arm.bindings.map((binding) => (binding.slot === 'hand_near_front' ? { slot: binding.slot, status: 'absent_by_design' as const } : binding));
    const changedBindings = { ...arm, bindings };
    const changedTags = { ...arm, tags: { ...arm.tags, skin_tone: 'tone2' } };
    const changedProvenance = { ...arm, provenance: { ...arm.provenance, source: 'other export' } };
    const base = identity(one(arm));
    expect(identity(one(changedBindings))).not.toBe(base);
    expect(identity(one(changedTags))).not.toBe(base);
    expect(identity(one(changedProvenance))).not.toBe(base);
    expect(new Set([base, identity(one(changedBindings)), identity(one(changedTags)), identity(one(changedProvenance))]).size).toBe(4);
  });

  it('semantically equal manifests with another key order give the same identity', () => {
    const selection = new Map(fullSet('a').map((item) => [item.group, item]));
    const reordered = new Map([...selection].reverse().map(([group, item]) => [group, reversedKeys(item) as PartModule]));
    expect(JSON.stringify(reordered.get('head'))).not.toBe(JSON.stringify(selection.get('head')));
    expect(selectionText(reordered)).toBe(selectionText(selection));
    const head = selection.get('head') as PartModule;
    expect(selectionText(one({ ...head, unused: undefined } as PartModule))).toBe(selectionText(one(head)));
  });

  it('the same data and seed give a reproducible identity', () => {
    const catalog = (['a', 'b', 'c'] as const).flatMap((id) => fullSet(id));
    const first = identity(composeModules(20261104, catalog, humanoidGirlV1Groups, rules));
    const second = identity(composeModules(20261104, structuredClone(catalog).reverse(), humanoidGirlV1Groups, rules));
    expect(second).toBe(first);
    expect(first).toMatchSnapshot();
  });
});
