import { idPattern, type RigContract } from '@rig-runtime/contract';
import { isRecord, type Problem, problem, RigRuntimeError, show, throwIfAny } from '@rig-runtime/problems';

// character.json: the presence of each part comes from this typed status, never from pixels or from a blank placeholder image.

export type PartStatus = 'present' | 'absent_by_design';
export type PresentPart = { readonly status: 'present'; readonly file: string };
export type AbsentPart = { readonly status: 'absent_by_design' };
export type Part = PresentPart | AbsentPart;
export type CharacterParts = { readonly characterId: string; readonly rigId: string; readonly parts: Readonly<Record<string, Part>> };

const partFile = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}$/;

/** Checks that a relative part path stays inside the package. No absolute path, no `..`, no backslash. */
export function safeRelativePath(path: string): boolean {
  return partFile.test(path) && !path.startsWith('/') && !path.includes('//');
}

/**
 * Validates character.json against the rig contract.
 * Error codes: E_CHARACTER_FORMAT, E_RIG_ID_MISMATCH, E_UNKNOWN_SLOT, E_PART_STATUS_MISSING, E_REQUIRED_PART_ABSENT,
 * E_UNEXPECTED_EXTENSION, E_UNSAFE_PATH.
 */
export function parseCharacter(value: unknown, contract: RigContract): CharacterParts {
  if (!isRecord(value)) throw new RigRuntimeError([problem('E_CHARACTER_FORMAT', 'character.json must be a JSON object.')]);
  const problems: Problem[] = [];
  const { characterId, rigId, parts } = value;
  if (typeof characterId !== 'string' || !idPattern.test(characterId)) problems.push(problem('E_CHARACTER_FORMAT', `characterId ${show(characterId)} is not a valid identifier.`));
  if (rigId !== contract.rigId) problems.push(problem('E_RIG_ID_MISMATCH', `rigId ${show(rigId)} is not the contract rig ${show(contract.rigId)}.`));
  if (!isRecord(parts)) {
    problems.push(problem('E_CHARACTER_FORMAT', 'parts must be an object keyed by slot id.'));
    throwIfAny(problems);
  }
  const slots = new Map(contract.slots.map((slot) => [slot.id, slot]));
  for (const [slotId, part] of Object.entries(parts as Record<string, unknown>)) {
    const slot = slots.get(slotId);
    if (!slot) {
      problems.push(problem('E_UNKNOWN_SLOT', `parts has the slot ${show(slotId)}, which the contract does not define.`, slotId));
      continue;
    }
    if (!isRecord(part)) {
      problems.push(problem('E_CHARACTER_FORMAT', 'A part must be an object.', slotId));
      continue;
    }
    const extra = Object.keys(part).filter((key) => key !== 'status' && key !== 'file');
    if (extra.length > 0) problems.push(problem('E_CHARACTER_FORMAT', `A part has unknown fields: ${extra.map(show).join(', ')}.`, slotId));
    if (part.status === 'absent_by_design') {
      if (slot.required) problems.push(problem('E_REQUIRED_PART_ABSENT', `The required slot ${show(slotId)} is marked absent_by_design.`, slotId));
      if (part.file !== undefined) problems.push(problem('E_CHARACTER_FORMAT', 'An absent part must not name a file.', slotId));
    } else if (part.status === 'present') {
      if (typeof part.file !== 'string' || !safeRelativePath(part.file)) problems.push(problem('E_UNSAFE_PATH', `The part file ${show(part.file)} is not a safe relative path.`, slotId));
      else if (!part.file.endsWith('.png')) problems.push(problem('E_UNEXPECTED_EXTENSION', `The part file ${show(part.file)} is not a .png file.`, slotId));
    } else {
      problems.push(problem('E_CHARACTER_FORMAT', `status ${show(part.status)} must be "present" or "absent_by_design".`, slotId));
    }
  }
  for (const slot of contract.slots) {
    if (!Object.hasOwn(parts as Record<string, unknown>, slot.id)) problems.push(problem('E_PART_STATUS_MISSING', `parts has no status for the slot ${show(slot.id)}.`, slot.id));
  }
  throwIfAny(problems);
  return value as unknown as CharacterParts;
}
