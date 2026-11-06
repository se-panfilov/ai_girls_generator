import { ControlError, isRecord, type Problem, problem, show } from '@control/problems';

// The part of the rig contract (docs/RIG_CONTRACT.md, v0.2-rc) that control images need: canvas, view, side names, bones, and slots.
// This parser validates the fields at run time. It reads the data and never changes the contract.

export type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
export type Joint = { readonly x: number; readonly y: number };
export type ContractBone = { readonly id: string; readonly parent: string | null; readonly joint: Joint };
export type ContractSlot = { readonly id: string; readonly bone: string; readonly drawOrder: number; readonly attachmentRect: Rect };
export type ContractPoint = { readonly id: string; readonly bone: string; readonly position: Joint };
export type Size = { readonly width: number; readonly height: number };
export type Tolerances = { readonly jointErrorMaxPctHeight: number; readonly jointErrorMeanPctHeight: number; readonly segmentLengthRatio: readonly [number, number] };

export type ControlContract = {
  readonly rigId: string;
  readonly contractVersion: string;
  readonly canvas: Size;
  readonly rigOrigin: Joint;
  readonly generationResolution: Size;
  readonly view: string;
  readonly sideNaming: string;
  readonly tolerances: Tolerances;
  readonly bones: ReadonlyMap<string, ContractBone>;
  readonly slots: ReadonlyMap<string, ContractSlot>;
  /** Named positions without images (`points`). Optional in the contract. */
  readonly points: ReadonlyMap<string, ContractPoint>;
};

const idPattern = /^[a-z][a-z0-9_]{0,63}$/;
const semverPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const maxSide = 16384;

const isSize = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maxSide;
const isCoordinate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maxSide * 4;

function sizeOf(value: unknown, subject: string, problems: Problem[]): Size {
  if (isRecord(value) && isSize(value.width) && isSize(value.height)) return { width: value.width, height: value.height };
  problems.push(problem('E_CONTRACT_FORMAT', `${subject} needs integer width and height from 1 to ${maxSide}.`, subject));
  return { width: 1, height: 1 };
}

function pointOf(value: unknown, subject: string, problems: Problem[]): Joint {
  if (isRecord(value) && isCoordinate(value.x) && isCoordinate(value.y)) return { x: value.x, y: value.y };
  problems.push(problem('E_CONTRACT_FORMAT', `${subject} needs finite x and y.`, subject));
  return { x: 0, y: 0 };
}

function tolerancesOf(value: unknown, problems: Problem[]): Tolerances {
  const fallback: Tolerances = { jointErrorMaxPctHeight: 0, jointErrorMeanPctHeight: 0, segmentLengthRatio: [1, 1] };
  if (!isRecord(value)) {
    problems.push(problem('E_CONTRACT_FORMAT', 'tolerances must be an object.', 'tolerances'));
    return fallback;
  }
  const { jointErrorMaxPctHeight: max, jointErrorMeanPctHeight: mean, segmentLengthRatio: ratio } = value;
  const positive = (item: unknown): item is number => typeof item === 'number' && Number.isFinite(item) && item > 0;
  if (!positive(max) || !positive(mean) || !Array.isArray(ratio) || ratio.length !== 2 || !positive(ratio[0]) || !positive(ratio[1]) || ratio[0] > ratio[1]) {
    problems.push(problem('E_CONTRACT_FORMAT', 'tolerances needs positive jointErrorMaxPctHeight, jointErrorMeanPctHeight, and a [min, max] segmentLengthRatio.', 'tolerances'));
    return fallback;
  }
  return { jointErrorMaxPctHeight: max, jointErrorMeanPctHeight: mean, segmentLengthRatio: [ratio[0], ratio[1]] };
}

/** Validates the fields of a rig contract that control images need. Throws ControlError with E_CONTRACT_* codes. */
export function parseControlContract(value: unknown): ControlContract {
  const problems: Problem[] = [];
  if (!isRecord(value)) throw new ControlError([problem('E_CONTRACT_FORMAT', 'The rig contract must be a JSON object.')]);
  const { rigId, contractVersion, space, view, sideNaming, bones, slots, tolerances, points } = value;
  if (typeof rigId !== 'string' || !idPattern.test(rigId)) problems.push(problem('E_CONTRACT_FORMAT', `rigId ${show(rigId)} is not a valid identifier.`));
  if (typeof contractVersion !== 'string' || !semverPattern.test(contractVersion)) problems.push(problem('E_CONTRACT_FORMAT', `contractVersion ${show(contractVersion)} is not X.Y.Z.`));
  if (typeof view !== 'string' || !idPattern.test(view)) problems.push(problem('E_CONTRACT_FORMAT', `view ${show(view)} is not a valid identifier.`));
  if (typeof sideNaming !== 'string' || !idPattern.test(sideNaming)) problems.push(problem('E_CONTRACT_FORMAT', `sideNaming ${show(sideNaming)} is not a valid identifier.`));
  const spaceRecord = isRecord(space) ? space : {};
  if (!isRecord(space)) problems.push(problem('E_CONTRACT_FORMAT', 'space must be an object.', 'space'));
  if (spaceRecord.yAxis !== 'down') problems.push(problem('E_CONTRACT_FORMAT', 'space.yAxis must be "down".', 'space.yAxis'));
  const canvas = sizeOf(spaceRecord.canvas, 'space.canvas', problems);
  const generationResolution = sizeOf(spaceRecord.generationResolution, 'space.generationResolution', problems);
  const rigOrigin = pointOf(spaceRecord.rigOrigin, 'space.rigOrigin', problems);

  const boneMap = new Map<string, ContractBone>();
  if (!Array.isArray(bones) || bones.length === 0 || bones.length > 512) problems.push(problem('E_CONTRACT_FORMAT', 'bones must be an array of 1 to 512 entries.'));
  else {
    for (const [index, bone] of (bones as unknown[]).entries()) {
      const subject = `bones[${index}]`;
      if (!isRecord(bone) || typeof bone.id !== 'string' || !idPattern.test(bone.id)) {
        problems.push(problem('E_CONTRACT_FORMAT', 'A bone needs a valid id.', subject));
        continue;
      }
      if (boneMap.has(bone.id)) problems.push(problem('E_CONTRACT_DUPLICATE_BONE', `bone ${show(bone.id)} occurs more than once.`, subject));
      const parent = bone.parent === null ? null : typeof bone.parent === 'string' && idPattern.test(bone.parent) ? bone.parent : undefined;
      if (parent === undefined) problems.push(problem('E_CONTRACT_FORMAT', 'parent must be null or a bone id.', subject));
      boneMap.set(bone.id, { id: bone.id, parent: parent ?? null, joint: pointOf(bone.joint, `${subject}.joint`, problems) });
    }
    for (const bone of boneMap.values()) {
      if (bone.parent !== null && !boneMap.has(bone.parent)) problems.push(problem('E_CONTRACT_PARENT', `bone ${show(bone.id)} has an unknown parent ${show(bone.parent)}.`, bone.id));
    }
  }

  const slotMap = new Map<string, ContractSlot>();
  if (!Array.isArray(slots) || slots.length === 0 || slots.length > 256) problems.push(problem('E_CONTRACT_FORMAT', 'slots must be an array of 1 to 256 entries.'));
  else {
    for (const [index, slot] of (slots as unknown[]).entries()) {
      const subject = `slots[${index}]`;
      if (!isRecord(slot) || typeof slot.id !== 'string' || !idPattern.test(slot.id) || typeof slot.bone !== 'string' || !boneMap.has(slot.bone)) {
        problems.push(problem('E_CONTRACT_FORMAT', 'A slot needs a valid id and an existing bone.', subject));
        continue;
      }
      const rect = slot.attachmentRect;
      if (!isRecord(rect) || !Number.isSafeInteger(rect.x) || !Number.isSafeInteger(rect.y) || !isSize(rect.w) || !isSize(rect.h)) {
        problems.push(problem('E_CONTRACT_FORMAT', 'attachmentRect needs integer x and y and positive integer w and h.', subject));
        continue;
      }
      if (!Number.isSafeInteger(slot.drawOrder)) problems.push(problem('E_CONTRACT_FORMAT', 'drawOrder must be an integer.', subject));
      if (slotMap.has(slot.id)) problems.push(problem('E_CONTRACT_DUPLICATE_SLOT', `slot ${show(slot.id)} occurs more than once.`, subject));
      slotMap.set(slot.id, {
        id: slot.id,
        bone: slot.bone,
        drawOrder: slot.drawOrder as number,
        attachmentRect: { x: rect.x as number, y: rect.y as number, w: rect.w, h: rect.h }
      });
    }
  }
  const pointMap = new Map<string, ContractPoint>();
  if (points !== undefined) {
    if (!Array.isArray(points) || points.length > 256) problems.push(problem('E_CONTRACT_FORMAT', 'points must be an array of at most 256 entries.'));
    else {
      for (const [index, point] of (points as unknown[]).entries()) {
        const subject = `points[${index}]`;
        if (!isRecord(point) || typeof point.id !== 'string' || !idPattern.test(point.id) || typeof point.bone !== 'string' || !boneMap.has(point.bone)) {
          problems.push(problem('E_CONTRACT_FORMAT', 'A point needs a valid id and an existing bone.', subject));
          continue;
        }
        if (pointMap.has(point.id)) problems.push(problem('E_CONTRACT_DUPLICATE_POINT', `point ${show(point.id)} occurs more than once.`, subject));
        pointMap.set(point.id, { id: point.id, bone: point.bone, position: pointOf(point.position, `${subject}.position`, problems) });
      }
    }
  }
  const parsedTolerances = tolerancesOf(tolerances, problems);
  if (problems.length > 0) throw new ControlError(problems);
  return {
    rigId: rigId as string,
    contractVersion: contractVersion as string,
    canvas,
    rigOrigin,
    generationResolution,
    view: view as string,
    sideNaming: sideNaming as string,
    tolerances: parsedTolerances,
    bones: boneMap,
    slots: slotMap,
    points: pointMap
  };
}
