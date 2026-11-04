import { safeRelativePath } from '@rig-runtime/character';
import { contractLine, idPattern, type RigContract } from '@rig-runtime/contract';
import { isRecord, type Problem, problem, RigRuntimeError, show, throwIfAny } from '@rig-runtime/problems';

// Part modules. DRAFT (proposal for the contract, not accepted): a module is a group of slots that changes as one unit,
// for example the near arm (upper arm, forearm, hand). One module draws its regions from one atlas.

export type Side = 'near' | 'far' | 'none';
export type ModuleGroup = { readonly id: string; readonly side: Side; readonly slots: readonly string[] };
export type ModuleBinding = { readonly slot: string; readonly status: 'present'; readonly region: string } | { readonly slot: string; readonly status: 'absent_by_design' };
export type AtlasRef = {
  readonly file: string;
  readonly sha256: string;
  readonly pma: boolean;
  readonly pages: readonly { readonly file: string; readonly sha256: string }[];
};
export type PartModule = {
  readonly schema: typeof moduleSchema;
  readonly moduleId: string;
  readonly rig: { readonly rigId: string; readonly contractVersion: string };
  readonly group: string;
  readonly side: Side;
  readonly bindings: readonly ModuleBinding[];
  readonly atlas: AtlasRef;
  readonly tags: Readonly<Record<string, string>>;
  readonly provenance: Readonly<Record<string, string>>;
};
/** All modules in the listed groups must have the same value of `tag`. */
export type CompatibilityRule = { readonly tag: string; readonly groups: readonly string[] };

export const moduleSchema = 'aigg.part-module/0.1';
export const moduleIdPattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const tagPattern = /^[a-z][a-z0-9_]{0,31}$/;
const tagValuePattern = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * DRAFT module groups for the rig humanoid_girl_v1 (contract v0.2-rc). Every contract slot is in exactly one group.
 * `head_accessory` is separate so that an accessory can be added or removed without a head change.
 */
export const humanoidGirlV1Groups: readonly ModuleGroup[] = [
  { id: 'head', side: 'none', slots: ['head', 'hair_back', 'hair_front', 'hair_tail', 'ear_far', 'ear_near'] },
  { id: 'head_accessory', side: 'none', slots: ['acc_head'] },
  { id: 'torso', side: 'none', slots: ['torso', 'hips', 'neck', 'skirt_back', 'skirt_front', 'tail'] },
  { id: 'arm_near', side: 'near', slots: ['upper_arm_near', 'forearm_near', 'hand_near', 'hand_near_front'] },
  { id: 'arm_far', side: 'far', slots: ['upper_arm_far', 'forearm_far', 'hand_far'] },
  { id: 'legs', side: 'none', slots: ['thigh_far', 'shin_far', 'foot_far', 'thigh_near', 'shin_near', 'foot_near'] },
  { id: 'weapon', side: 'none', slots: ['weapon'] }
];

/** Checks a group table against the contract: each slot in exactly one group, and side names that agree with the slot names. */
export function moduleGroupProblems(contract: RigContract, groups: readonly ModuleGroup[]): Problem[] {
  const problems: Problem[] = [];
  const owner = new Map<string, string>();
  const ids = new Set(contract.slots.map((slot) => slot.id));
  const groupIds = new Set<string>();
  for (const group of groups) {
    if (!idPattern.test(group.id) || groupIds.has(group.id)) problems.push(problem('E_GROUP_TABLE', `The group id ${show(group.id)} is not valid or not unique.`, group.id));
    groupIds.add(group.id);
    for (const slot of group.slots) {
      if (!ids.has(slot)) problems.push(problem('E_UNKNOWN_SLOT', `The group ${show(group.id)} has the slot ${show(slot)}, which the contract does not define.`, slot));
      if (owner.has(slot)) problems.push(problem('E_GROUP_TABLE', `The slot ${show(slot)} is in the groups ${show(owner.get(slot))} and ${show(group.id)}.`, slot));
      owner.set(slot, group.id);
      if (group.side !== 'none' && !slot.includes(`_${group.side}`)) problems.push(problem('E_MODULE_SIDE_MISMATCH', `The ${group.side} group ${show(group.id)} has the slot ${show(slot)}.`, slot));
    }
  }
  for (const id of ids) if (!owner.has(id)) problems.push(problem('E_GROUP_TABLE', `The slot ${show(id)} is in no group.`, id));
  return problems;
}

function stringRecord(value: unknown, keys: RegExp, values: RegExp): value is Record<string, string> {
  return isRecord(value) && Object.entries(value).every(([key, item]) => keys.test(key) && typeof item === 'string' && values.test(item));
}

/**
 * Validates a part module manifest (schema aigg.part-module/0.1) against the contract and the group table.
 * Codes: E_MODULE_FORMAT, E_MODULE_RIG_MISMATCH, E_MODULE_UNKNOWN_GROUP, E_MODULE_SIDE_MISMATCH, E_UNKNOWN_SLOT,
 * E_MODULE_SLOT_OUTSIDE_GROUP, E_MODULE_DUPLICATE_BINDING, E_MODULE_INCOMPLETE_GROUP, E_REQUIRED_PART_ABSENT,
 * E_MODULE_REGION_COLLISION, E_UNSAFE_PATH.
 */
export function parseModule(value: unknown, contract: RigContract, groups: readonly ModuleGroup[]): PartModule {
  if (!isRecord(value)) throw new RigRuntimeError([problem('E_MODULE_FORMAT', 'A module manifest must be a JSON object.')]);
  const problems: Problem[] = [];
  const subject = typeof value.moduleId === 'string' ? value.moduleId : undefined;
  const add = (code: string, message: string): void => {
    problems.push(problem(code, message, subject));
  };
  const known = new Set(['schema', 'moduleId', 'rig', 'group', 'side', 'bindings', 'atlas', 'tags', 'provenance']);
  for (const key of Object.keys(value)) if (!known.has(key)) add('E_MODULE_FORMAT', `The module has the unknown field ${show(key)}.`);
  if (value.schema !== moduleSchema) add('E_MODULE_FORMAT', `schema must be ${show(moduleSchema)}.`);
  if (typeof value.moduleId !== 'string' || !moduleIdPattern.test(value.moduleId)) add('E_MODULE_FORMAT', `moduleId ${show(value.moduleId)} is not valid.`);
  const rig = value.rig;
  if (!isRecord(rig) || typeof rig.rigId !== 'string' || typeof rig.contractVersion !== 'string') add('E_MODULE_FORMAT', 'rig needs rigId and contractVersion.');
  else if (rig.rigId !== contract.rigId || contractLine(rig.contractVersion) !== contractLine(contract.contractVersion)) {
    add('E_MODULE_RIG_MISMATCH', `The module is for ${show(`${rig.rigId}@${rig.contractVersion}`)}; the rig is ${show(`${contract.rigId}@${contract.contractVersion}`)}.`);
  }
  const group = groups.find((item) => item.id === value.group);
  if (!group) add('E_MODULE_UNKNOWN_GROUP', `The group ${show(value.group)} is not in the group table.`);
  if (value.side !== 'near' && value.side !== 'far' && value.side !== 'none') add('E_MODULE_FORMAT', 'side must be "near", "far" or "none".');
  else if (group && group.side !== value.side) add('E_MODULE_SIDE_MISMATCH', `The module side is ${show(value.side)}; the group ${show(group.id)} is ${show(group.side)}.`);
  const atlas = value.atlas;
  const pageOk = (page: unknown): boolean => isRecord(page) && typeof page.file === 'string' && safeRelativePath(page.file) && typeof page.sha256 === 'string' && sha256Pattern.test(page.sha256);
  if (!isRecord(atlas) || !pageOk(atlas) || typeof atlas.pma !== 'boolean' || !Array.isArray(atlas.pages) || atlas.pages.length === 0 || !atlas.pages.every(pageOk)) {
    add('E_UNSAFE_PATH', 'atlas needs a safe relative file, a sha256, a pma flag and at least one page with a safe relative file and a sha256.');
  }
  if (!stringRecord(value.tags, tagPattern, tagValuePattern)) add('E_MODULE_FORMAT', 'tags must map lowercase names to short text values.');
  if (!stringRecord(value.provenance, tagPattern, /^[\x20-\x7e]{1,200}$/) || typeof value.provenance.source !== 'string')
    add('E_MODULE_FORMAT', 'provenance must map names to printable text and have a source.');
  const slots = new Map(contract.slots.map((slot) => [slot.id, slot]));
  const seen = new Set<string>();
  const regions = new Map<string, string>();
  if (!Array.isArray(value.bindings) || value.bindings.length === 0) add('E_MODULE_FORMAT', 'bindings must be a non-empty array.');
  for (const binding of Array.isArray(value.bindings) ? (value.bindings as unknown[]) : []) {
    if (!isRecord(binding) || typeof binding.slot !== 'string') {
      add('E_MODULE_FORMAT', 'A binding needs a slot.');
      continue;
    }
    const slot = slots.get(binding.slot);
    if (!slot) {
      add('E_UNKNOWN_SLOT', `The binding slot ${show(binding.slot)} is not in the contract.`);
      continue;
    }
    if (group && !group.slots.includes(binding.slot)) add('E_MODULE_SLOT_OUTSIDE_GROUP', `The slot ${show(binding.slot)} is not in the group ${show(group.id)}.`);
    if (seen.has(binding.slot)) add('E_MODULE_DUPLICATE_BINDING', `The slot ${show(binding.slot)} has more than one binding.`);
    seen.add(binding.slot);
    if (binding.status === 'absent_by_design') {
      if (slot.required) add('E_REQUIRED_PART_ABSENT', `The required slot ${show(binding.slot)} is absent in the module.`);
      if (binding.region !== undefined) add('E_MODULE_FORMAT', `The absent slot ${show(binding.slot)} must not name a region.`);
    } else if (binding.status === 'present') {
      if (typeof binding.region !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(binding.region)) add('E_MODULE_FORMAT', `The region of ${show(binding.slot)} is not a valid name.`);
      else if (regions.has(binding.region)) add('E_MODULE_REGION_COLLISION', `The slots ${show(regions.get(binding.region))} and ${show(binding.slot)} use the same region ${show(binding.region)}.`);
      else regions.set(binding.region, binding.slot);
    } else {
      add('E_MODULE_FORMAT', `The status of ${show(binding.slot)} must be "present" or "absent_by_design".`);
    }
  }
  if (group) {
    const missing = group.slots.filter((slot) => !seen.has(slot));
    if (missing.length > 0) add('E_MODULE_INCOMPLETE_GROUP', `The module does not bind ${missing.map(show).join(', ')} of the group ${show(group.id)}.`);
  }
  throwIfAny(problems);
  return value as unknown as PartModule;
}

/** Checks the compatibility rules for a selection of modules (one per group). Code: E_MODULE_INCOMPATIBLE. */
export function compatibilityProblems(selection: ReadonlyMap<string, PartModule>, rules: readonly CompatibilityRule[]): Problem[] {
  const problems: Problem[] = [];
  for (const rule of rules) {
    const values = new Map<string, string[]>();
    for (const groupId of rule.groups) {
      const selected = selection.get(groupId);
      if (!selected) continue;
      const tagValue = selected.tags[rule.tag] ?? '(none)';
      values.set(tagValue, [...(values.get(tagValue) ?? []), selected.moduleId]);
    }
    if (values.size > 1) {
      const detail = [...values].map(([tagValue, modules]) => `${modules.join('+')}=${tagValue}`).join(', ');
      problems.push(problem('E_MODULE_INCOMPATIBLE', `The modules do not agree on the tag ${show(rule.tag)}: ${show(detail)}.`, rule.tag));
    }
  }
  return problems;
}

/** Small deterministic random generator (mulberry32). The same seed gives the same sequence on every platform. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Chooses one module per group with a fixed seed. Candidates are sorted by moduleId, so the input order has no effect.
 * Each choice must agree with the rules and the earlier choices. Code: E_COMPOSE_NO_COMPATIBLE.
 */
export function composeModules(seed: number, catalog: readonly PartModule[], groups: readonly ModuleGroup[], rules: readonly CompatibilityRule[]): Map<string, PartModule> {
  const random = seededRandom(seed);
  const selection = new Map<string, PartModule>();
  for (const group of groups) {
    const candidates = catalog
      .filter((item) => item.group === group.id)
      .sort((left, right) => (left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : 0))
      .filter((item) => compatibilityProblems(new Map([...selection, [group.id, item]]), rules).length === 0);
    const choice = candidates[Math.floor(random() * candidates.length)];
    if (!choice) throw new RigRuntimeError([problem('E_COMPOSE_NO_COMPATIBLE', `No module of the group ${show(group.id)} agrees with the earlier choices.`, group.id)]);
    selection.set(group.id, choice);
  }
  return selection;
}

/** Canonical text of a selection (group order, module id and atlas hash). Hash it to get a stable composition id. */
export function selectionText(selection: ReadonlyMap<string, PartModule>): string {
  return [...selection]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([groupId, item]) => `${groupId}=${item.moduleId}@${item.atlas.sha256}`)
    .join('\n');
}
