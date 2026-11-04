import { isRecord, type Problem, problem, RigRuntimeError, show, throwIfAny } from '@rig-runtime/problems';

// The part of the rig contract (docs/RIG_CONTRACT.md, v0.2-rc) that runtime assembly needs.
// Other contract fields are kept by the caller and are checked by other tools.

export type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
export type ContractSlot = { readonly id: string; readonly bone: string; readonly drawOrder: number; readonly required: boolean; readonly attachmentRect: Rect };
export type RigContract = { readonly rigId: string; readonly contractVersion: string; readonly slots: readonly ContractSlot[] };

export const idPattern = /^[a-z][a-z0-9_]{0,63}$/;
export const semverPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isSize = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function rectProblems(value: unknown, subject: string): Problem[] {
  if (!isRecord(value)) return [problem('E_CONTRACT_FORMAT', 'attachmentRect must be an object.', subject)];
  const { x, y, w, h } = value;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !isSize(w) || !isSize(h)) {
    return [problem('E_CONTRACT_FORMAT', 'attachmentRect needs integer x and y and positive integer w and h.', subject)];
  }
  return [];
}

/** Validates the runtime subset of a rig contract. Throws RigRuntimeError with E_CONTRACT_* codes. */
export function parseRigContract(value: unknown): RigContract {
  const problems: Problem[] = [];
  if (!isRecord(value)) throw new RigRuntimeError([problem('E_CONTRACT_FORMAT', 'The rig contract must be a JSON object.')]);
  const { rigId, contractVersion, slots } = value;
  if (typeof rigId !== 'string' || !idPattern.test(rigId)) problems.push(problem('E_CONTRACT_FORMAT', `rigId ${show(rigId)} is not a valid identifier.`));
  if (typeof contractVersion !== 'string' || !semverPattern.test(contractVersion)) problems.push(problem('E_CONTRACT_FORMAT', `contractVersion ${show(contractVersion)} is not X.Y.Z.`));
  if (!Array.isArray(slots) || slots.length === 0 || slots.length > 256) {
    problems.push(problem('E_CONTRACT_FORMAT', 'slots must be an array of 1 to 256 entries.'));
    throwIfAny(problems);
    return value as unknown as RigContract;
  }
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const [index, slot] of (slots as unknown[]).entries()) {
    const subject = `slots[${index}]`;
    if (!isRecord(slot)) {
      problems.push(problem('E_CONTRACT_FORMAT', 'A slot must be an object.', subject));
      continue;
    }
    if (typeof slot.id !== 'string' || !idPattern.test(slot.id)) problems.push(problem('E_CONTRACT_FORMAT', `slot id ${show(slot.id)} is not a valid identifier.`, subject));
    else if (ids.has(slot.id)) problems.push(problem('E_CONTRACT_DUPLICATE_SLOT', `slot ${show(slot.id)} occurs more than once.`, subject));
    else ids.add(slot.id);
    if (typeof slot.bone !== 'string' || !idPattern.test(slot.bone)) problems.push(problem('E_CONTRACT_FORMAT', 'bone must be an identifier.', subject));
    if (typeof slot.required !== 'boolean') problems.push(problem('E_CONTRACT_FORMAT', 'required must be true or false.', subject));
    if (!isCount(slot.drawOrder) || slot.drawOrder >= slots.length) problems.push(problem('E_CONTRACT_FORMAT', 'drawOrder must be an index in the slot list.', subject));
    else if (orders.has(slot.drawOrder)) problems.push(problem('E_CONTRACT_FORMAT', `drawOrder ${slot.drawOrder} occurs more than once.`, subject));
    else orders.add(slot.drawOrder);
    problems.push(...rectProblems(slot.attachmentRect, subject));
  }
  throwIfAny(problems);
  return value as unknown as RigContract;
}

/** Slot ids of the contract, by id. */
export function slotMap(contract: RigContract): ReadonlyMap<string, ContractSlot> {
  return new Map(contract.slots.map((slot) => [slot.id, slot]));
}

/** Major and minor parts of the contract version. Modules are compatible with the same major.minor version. */
export function contractLine(version: string): string {
  const match = semverPattern.exec(version);
  return match ? `${match[1]}.${match[2]}` : '';
}
