import * as spine from '@esotericsoftware/spine-core';
import { AtlasCache, atlasIdentity } from '@rig-runtime/atlas-cache';
import { parseRigContract } from '@rig-runtime/contract';
import { ModularCharacter } from '@rig-runtime/modular-character';
import { type PartModule } from '@rig-runtime/modules';

import { makeSyntheticAssets, spikeGroups, spikeLoader, type SyntheticAssets } from './assets';
import { type BlinkOptions } from './blink';
import { AnimatedCharacter } from './controller';
import { readSpikeFile } from './fixture';
import { type AnimationOwner, type Companion, parseCompanions, parseOwners } from './ownership';
import { loadSpikeRig, type SpikeRig } from './rig';

// D26 spike (experiment, not production). Shared setup of the spike tests and the visual smoke test.

export { spine };

export const blinkOptions: BlinkOptions = { seed: 26, minInterval: 1.2, maxInterval: 2.4, track: 1, animation: 'blink' };

export type Spike = {
  readonly rig: SpikeRig;
  readonly owners: readonly AnimationOwner[];
  readonly companions: readonly Companion[];
  readonly assets: SyntheticAssets;
};

export function loadSpike(): Spike {
  const contractJson: unknown = JSON.parse(readSpikeFile('rig.contract.json'));
  const contract = parseRigContract(contractJson);
  const rig = loadSpikeRig(spine, readSpikeFile('skeleton.json'), contract);
  const owners = parseOwners(contractJson);
  return { rig, owners, companions: parseCompanions(contractJson, owners), assets: makeSyntheticAssets(rig) };
}

export const moduleOf = (spike: Spike, id: string): PartModule => {
  const item = spike.assets.modules.get(id);
  if (!item) throw new Error(`Unknown spike module ${id}`);
  return item;
};

/** Body modules plus hair A and tail A. */
export const startModules = (spike: Spike): PartModule[] =>
  [...spike.assets.modules.values()].filter((item) => item.moduleId.startsWith('body.') || item.moduleId === 'hair.a' || item.moduleId === 'tail.a');

/** A character with all modules and the eye frames. `delay` slows each atlas load (frames continue while a module loads). */
export async function makeCharacter(
  spike: Spike,
  options: { cache?: AtlasCache; delay?: () => Promise<void>; blink?: BlinkOptions; id?: string } = {}
): Promise<{ animated: AnimatedCharacter; cache: AtlasCache }> {
  const cache = options.cache ?? new AtlasCache(spikeLoader(spike.assets.files, options.delay));
  const character = new ModularCharacter(spine, spike.rig, cache, { groups: spikeGroups, pma: false }, options.id ?? 'spike');
  await character.setModules(startModules(spike));
  const animated = new AnimatedCharacter(spine, spike.rig, cache, character, spike.owners, spike.companions, options.blink ?? blinkOptions);
  await animated.installSequence('eyes', spike.assets.eyes.atlas, spike.assets.eyes.frames);
  return { animated, cache };
}

/** Owner counts above zero, by atlas file. */
export function ownersByFile(cache: AtlasCache, spike: Spike): Record<string, number> {
  const refs = [...spike.assets.modules.values()].map((item) => item.atlas).concat(spike.assets.eyes.atlas);
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(cache.stats().owners)) {
    if (count <= 0) continue;
    const ref = refs.find((item) => atlasIdentity(item) === key);
    result[ref?.file ?? key] = count;
  }
  return result;
}
