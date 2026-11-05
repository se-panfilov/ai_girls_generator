import { idPattern } from '@rig-runtime/contract';
import { isRecord, type Problem, problem, show, throwIfAny } from '@rig-runtime/problems';
import type { Spine } from '@rig-runtime/spine';

// D26 spike (experiment, not production). Animation owners and the property ownership check.
// Each animation has exactly one owner. Each owner plays on its own AnimationState track.
// Two owners must never key the same bone or slot property, so that a secondary track never overrides a primary track (or the
// reverse) and a change on one track never cancels the motion of another owner.

export type AnimationOwner = { readonly owner: string; readonly track: number; readonly animations: readonly string[] };
export type Companion = { readonly owner: string; readonly fallback: string; readonly byPrimary: Readonly<Record<string, string>> };

const maxTracks = 16;

/** Reads `animationOwners` from the spike contract. Codes: E_OWNER_FORMAT, E_OWNER_DUPLICATE. */
export function parseOwners(contract: unknown): AnimationOwner[] {
  const raw = isRecord(contract) ? contract.animationOwners : undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > maxTracks) throwIfAny([problem('E_OWNER_FORMAT', `animationOwners must be an array of 1 to ${maxTracks} entries.`)]);
  const problems: Problem[] = [];
  const owners: AnimationOwner[] = [];
  const tracks = new Set<number>();
  const names = new Set<string>();
  const animations = new Map<string, string>();
  for (const entry of raw as unknown[]) {
    if (!isRecord(entry) || typeof entry.owner !== 'string' || !idPattern.test(entry.owner) || !Number.isSafeInteger(entry.track) || !Array.isArray(entry.animations)) {
      problems.push(problem('E_OWNER_FORMAT', 'An owner needs an id, an integer track and an animation list.'));
      continue;
    }
    const track = entry.track as number;
    if (track < 0 || track >= maxTracks) problems.push(problem('E_OWNER_FORMAT', `The track of ${show(entry.owner)} must be 0..${maxTracks - 1}.`, entry.owner));
    if (names.has(entry.owner)) problems.push(problem('E_OWNER_DUPLICATE', `The owner ${show(entry.owner)} occurs more than once.`, entry.owner));
    if (tracks.has(track)) problems.push(problem('E_OWNER_DUPLICATE', `Two owners use the track ${track}.`, entry.owner));
    names.add(entry.owner);
    tracks.add(track);
    const list: string[] = [];
    for (const name of entry.animations as unknown[]) {
      if (typeof name !== 'string' || !idPattern.test(name)) {
        problems.push(problem('E_OWNER_FORMAT', `The owner ${show(entry.owner)} lists an invalid animation name.`, entry.owner));
        continue;
      }
      const other = animations.get(name);
      if (other !== undefined) problems.push(problem('E_OWNER_DUPLICATE', `The animation ${show(name)} has the owners ${show(other)} and ${show(entry.owner)}.`, name));
      animations.set(name, entry.owner);
      list.push(name);
    }
    owners.push({ owner: entry.owner, track, animations: list });
  }
  throwIfAny(problems);
  return owners;
}

/** Reads `companions` from the spike contract and checks them against the owners. Code: E_OWNER_FORMAT. */
export function parseCompanions(contract: unknown, owners: readonly AnimationOwner[]): Companion[] {
  const raw = isRecord(contract) ? contract.companions : undefined;
  if (!Array.isArray(raw)) throwIfAny([problem('E_OWNER_FORMAT', 'companions must be an array.')]);
  const problems: Problem[] = [];
  const result: Companion[] = [];
  const primary = owners.find((item) => item.track === 0);
  for (const entry of raw as unknown[]) {
    const owner = isRecord(entry) ? owners.find((item) => item.owner === entry.owner) : undefined;
    if (!isRecord(entry) || !owner || owner.track === 0 || typeof entry.fallback !== 'string' || !isRecord(entry.byPrimary)) {
      problems.push(problem('E_OWNER_FORMAT', 'A companion needs a secondary owner, a fallback animation and a byPrimary map.'));
      continue;
    }
    const byPrimary: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry.byPrimary)) {
      if (!primary?.animations.includes(key) || typeof value !== 'string' || !owner.animations.includes(value)) {
        problems.push(problem('E_OWNER_FORMAT', `The companion entry ${show(key)} must map a primary animation to an animation of ${show(owner.owner)}.`, key));
        continue;
      }
      byPrimary[key] = value;
    }
    if (!owner.animations.includes(entry.fallback)) problems.push(problem('E_OWNER_FORMAT', `The fallback ${show(entry.fallback)} is not an animation of ${show(owner.owner)}.`));
    result.push({ owner: owner.owner, fallback: entry.fallback, byPrimary });
  }
  throwIfAny(problems);
  return result;
}

const boneProperties = ['rotate', 'x', 'y', 'scaleX', 'scaleY', 'shearX', 'shearY', 'inherit'];
const slotProperties: Record<number, string> = { 8: 'rgb', 9: 'alpha', 10: 'rgb2', 11: 'attachment', 12: 'deform', 29: 'sequence' };
const eventProperty = 13;
const drawOrderProperties = new Set([14, 15]);

/**
 * The ownership key of one spine-core timeline property id (`<Property>|<index>[|<id>]`) and a readable label.
 * The attachment and the sequence frame of one slot are one key ("display"): an attachment timeline of one owner would replace the
 * sequence attachment of another owner. Draw order is one key for the whole skeleton. Event timelines change no pose and have no key.
 */
export function ownershipKey(data: Spine.SkeletonData, propertyId: string): { key: string; label: string } | null {
  const [kindText, indexText] = propertyId.split('|');
  const kind = Number(kindText);
  const index = Number(indexText);
  if (kind === eventProperty) return null;
  if (drawOrderProperties.has(kind)) return { key: 'drawOrder', label: 'draw order' };
  const boneProperty = boneProperties[kind];
  if (boneProperty !== undefined) return { key: propertyId, label: `bone ${data.bones[index]?.name ?? index} ${boneProperty}` };
  const slotProperty = slotProperties[kind];
  if (slotProperty !== undefined) {
    const slot = data.slots[index]?.name ?? String(index);
    if (slotProperty === 'attachment' || slotProperty === 'sequence') return { key: `display|${index}`, label: `slot ${slot} attachment/sequence` };
    return { key: `${kind}|${index}`, label: `slot ${slot} ${slotProperty}` };
  }
  // Constraint and slider timelines: no profile of this rig uses them; each id is its own key.
  return { key: propertyId, label: `property ${propertyId}` };
}

/**
 * Checks the owner table against the animations of a SkeletonData (the real spine-core timelines, after loading).
 * Codes: E_OWNER_UNKNOWN_ANIMATION (listed, but not in the data), E_OWNER_MISSING (in the data, but no owner),
 * E_OWNER_CONFLICT (two owners key the same property; the subject is the property label).
 */
export function ownershipProblems(data: Spine.SkeletonData, owners: readonly AnimationOwner[]): Problem[] {
  const problems: Problem[] = [];
  const ownerOf = new Map<string, string>();
  for (const owner of owners) {
    for (const name of owner.animations) {
      ownerOf.set(name, owner.owner);
      if (!data.findAnimation(name)) problems.push(problem('E_OWNER_UNKNOWN_ANIMATION', `The owner ${show(owner.owner)} lists ${show(name)}, which the skeleton does not have.`, name));
    }
  }
  // key → owner → animations
  const keyed = new Map<string, { label: string; owners: Map<string, string[]> }>();
  for (const animation of data.animations) {
    const owner = ownerOf.get(animation.name);
    if (owner === undefined) {
      problems.push(problem('E_OWNER_MISSING', `The animation ${show(animation.name)} has no owner.`, animation.name));
      continue;
    }
    for (const timeline of animation.timelines) {
      for (const id of timeline.getPropertyIds()) {
        const found = ownershipKey(data, id);
        if (!found) continue;
        const entry = keyed.get(found.key) ?? { label: found.label, owners: new Map<string, string[]>() };
        const names = entry.owners.get(owner) ?? [];
        if (!names.includes(animation.name)) names.push(animation.name);
        entry.owners.set(owner, names);
        keyed.set(found.key, entry);
      }
    }
  }
  for (const { label, owners: byOwner } of keyed.values()) {
    if (byOwner.size < 2) continue;
    const detail = [...byOwner].map(([owner, names]) => `${owner} (${names.join(', ')})`).join(' and ');
    problems.push(problem('E_OWNER_CONFLICT', `The ${label} is keyed by ${detail}.`, label));
  }
  return problems;
}
