import { type RigContract } from '@rig-runtime/contract';
import { isRecord, type Problem, problem, show, throwIfAny } from '@rig-runtime/problems';
import { type AttachmentTemplate, type SharedRig } from '@rig-runtime/rig';
import type { Spine, SpineRuntime } from '@rig-runtime/spine';

// D26 spike (experiment, not production). A rig loader that also accepts region attachments with a Spine sequence.
//
// Why a separate loader: the production loader `loadSharedRig` has two limits for frame sequences.
// 1. Its profile rejects the `sequence` field (E_PROFILE_ATTACHMENT_FIELDS).
// 2. Its attachment loader drops every region attachment. spine-core then cannot read a SequenceTimeline, because the timeline
//    needs the attachment object ("Timeline attachment not found"). The spike test d26-sequence records both failures.
//
// This loader keeps one data-only "timeline attachment" for each sequence slot. Runtime attachments of a character refer to it
// through `Attachment.timelineAttachment`, so the SequenceTimeline of the shared animation applies to them.
// The timeline attachment is removed from the default skin, so the shared SkeletonData has no drawable attachment, as before.

export type SequenceTemplate = Omit<AttachmentTemplate, 'color'> & {
  readonly count: number;
  readonly start: number;
  readonly digits: number;
  readonly setupIndex: number;
  /** The data-only attachment that the SequenceTimelines of the shared animations refer to. Never drawn. */
  readonly timelineAttachment: Spine.RegionAttachment;
};

export type SpikeRig = SharedRig & {
  /** Slots with a frame sequence, by slot id. These slots have no entry in `templates`. */
  readonly sequences: ReadonlyMap<string, SequenceTemplate>;
};

const allowedKeys = new Set(['type', 'name', 'path', 'x', 'y', 'scaleX', 'scaleY', 'rotation', 'width', 'height', 'color', 'sequence']);
const maxFrames = 64;

type RawTemplate = { slot: string; slotIndex: number; placeholder: string; raw: Record<string, unknown> };

function readRaw(json: Record<string, unknown>, contract: RigContract): { items: RawTemplate[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const items: RawTemplate[] = [];
  const slots = Array.isArray(json.slots) ? (json.slots as unknown[]) : [];
  const skins = Array.isArray(json.skins) ? (json.skins as unknown[]) : [];
  const skin = skins[0];
  if (skins.length !== 1 || !isRecord(skin) || skin.name !== 'default') return { items, problems: [problem('E_PROFILE_SKINS', 'The skeleton must have exactly one skin, named "default".')] };
  const attachments = isRecord(skin.attachments) ? skin.attachments : {};
  const contractIds = new Set(contract.slots.map((slot) => slot.id));
  const jsonIds = slots.map((slot) => (isRecord(slot) ? slot.name : undefined));
  for (const id of contractIds) if (!jsonIds.includes(id)) problems.push(problem('E_PARITY_SLOT', `The skeleton has no slot ${show(id)}.`, id));
  for (const [index, slot] of slots.entries()) {
    if (!isRecord(slot) || typeof slot.name !== 'string') continue;
    if (!contractIds.has(slot.name)) {
      problems.push(problem('E_PARITY_SLOT', `The skeleton slot ${show(slot.name)} is not in the contract.`, slot.name));
      continue;
    }
    const entries = isRecord(attachments[slot.name]) ? Object.entries(attachments[slot.name] as Record<string, unknown>) : [];
    const entry = entries[0];
    if (entries.length !== 1 || !entry || !isRecord(entry[1])) {
      problems.push(problem('E_PROFILE_ATTACHMENTS', `The slot ${show(slot.name)} must have exactly one attachment in the default skin.`, slot.name));
      continue;
    }
    const [placeholder, raw] = entry as [string, Record<string, unknown>];
    if (slot.attachment !== placeholder) problems.push(problem('E_PROFILE_SETUP_ATTACHMENT', `The setup attachment of ${show(slot.name)} must be ${show(placeholder)}.`, slot.name));
    if ((raw.type ?? 'region') !== 'region') problems.push(problem('E_PROFILE_ATTACHMENT_TYPE', `The attachment of ${show(slot.name)} is not a region.`, slot.name));
    const extra = Object.keys(raw).filter((key) => !allowedKeys.has(key));
    if (extra.length > 0) problems.push(problem('E_PROFILE_ATTACHMENT_FIELDS', `The attachment of ${show(slot.name)} has unsupported fields: ${extra.map(show).join(', ')}.`, slot.name));
    items.push({ slot: slot.name, slotIndex: index, placeholder, raw });
  }
  return { items, problems };
}

function geometry(item: RawTemplate, contract: RigContract, problems: Problem[]): Omit<AttachmentTemplate, 'color'> {
  const { raw, slot } = item;
  const number = (key: string, fallback: number): number => {
    const value = raw[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(problem('E_PROFILE_ATTACHMENT_FIELDS', `${key} of ${show(slot)} must be a finite number.`, slot));
    return Number(value);
  };
  const name = typeof raw.name === 'string' ? raw.name : item.placeholder;
  const result = {
    slot,
    slotIndex: item.slotIndex,
    placeholder: item.placeholder,
    name,
    path: typeof raw.path === 'string' ? raw.path : name,
    x: number('x', 0),
    y: number('y', 0),
    scaleX: number('scaleX', 1),
    scaleY: number('scaleY', 1),
    rotation: number('rotation', 0),
    width: number('width', Number.NaN),
    height: number('height', Number.NaN)
  };
  const rect = contract.slots.find((entry) => entry.id === slot)?.attachmentRect;
  if (rect && (result.width !== rect.w || result.height !== rect.h)) {
    problems.push(problem('E_TEMPLATE_RECT_MISMATCH', `The attachment of ${show(slot)} is ${result.width}x${result.height}; the contract rectangle is ${rect.w}x${rect.h}.`, slot));
  }
  return result;
}

function sequenceFields(raw: unknown, slot: string, problems: Problem[]): { count: number; start: number; digits: number; setupIndex: number } {
  const value = isRecord(raw) ? raw : {};
  const count = value.count;
  const start = value.start ?? 1;
  const digits = value.digits ?? 0;
  const setupIndex = value.setup ?? 0;
  const integer = (item: unknown, min: number, max: number): item is number => Number.isSafeInteger(item) && (item as number) >= min && (item as number) <= max;
  if (!integer(count, 2, maxFrames) || !integer(start, 0, 9999) || !integer(digits, 0, 8) || !integer(setupIndex, 0, Number(count) - 1)) {
    problems.push(problem('E_SEQUENCE_FORMAT', `The sequence of ${show(slot)} needs count 2..${maxFrames}, start, digits and a setup index inside the sequence.`, slot));
    return { count: 2, start: 0, digits: 0, setupIndex: 0 };
  }
  return { count, start, digits, setupIndex };
}

/**
 * Loads the spike skeleton once for all characters. Static region slots become `templates` (as in `loadSharedRig`).
 * Region slots with a `sequence` become `sequences`.
 */
export function loadSpikeRig(
  spine: Pick<SpineRuntime, 'SkeletonJson' | 'RegionAttachment'> & { readonly TextureRegion: typeof Spine.TextureRegion },
  skeletonJsonText: string,
  contract: RigContract
): SpikeRig {
  let root: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(skeletonJsonText);
    if (isRecord(parsed) && isRecord(parsed.skeleton)) root = parsed;
    else throwIfAny([problem('E_SKELETON_FORMAT', 'The skeleton JSON has no "skeleton" object.')]);
  } catch (error) {
    throwIfAny([problem('E_SKELETON_FORMAT', `The skeleton JSON cannot be read: ${show(String(error))}.`)]);
  }
  const { items, problems } = readRaw(root, contract);
  const templates = new Map<string, AttachmentTemplate>();
  const sequenceInfo = new Map<string, Omit<SequenceTemplate, 'timelineAttachment'>>();
  for (const item of items) {
    const base = geometry(item, contract, problems);
    if (item.raw.sequence !== undefined) {
      if (item.raw.color !== undefined) problems.push(problem('E_PROFILE_ATTACHMENT_FIELDS', `The sequence attachment of ${show(item.slot)} must not set a color.`, item.slot));
      sequenceInfo.set(item.slot, { ...base, ...sequenceFields(item.raw.sequence, item.slot, problems) });
    } else {
      templates.set(item.slot, { ...base, color: typeof item.raw.color === 'string' ? item.raw.color : null });
    }
  }
  throwIfAny(problems);
  // A 1x1 region keeps RegionAttachment.updateSequence valid for the data-only attachments. It has no texture and is never drawn.
  const placeholderRegion = new spine.TextureRegion();
  placeholderRegion.width = 1;
  placeholderRegion.height = 1;
  placeholderRegion.originalWidth = 1;
  placeholderRegion.originalHeight = 1;
  const timelineAttachments = new Map<string, Spine.RegionAttachment>();
  const unsupported = (kind: string) => (): never => {
    throw new Error(`E_PROFILE_ATTACHMENT_TYPE: ${kind} attachments are not in the spike profile.`);
  };
  const loader: Spine.AttachmentLoader = {
    newRegionAttachment: (_skin, placeholder, name, _path, sequence) => {
      if (!sequence.hasPathSuffix()) return null as unknown as Spine.RegionAttachment;
      sequence.regions.fill(placeholderRegion);
      const attachment = new spine.RegionAttachment(name, sequence);
      timelineAttachments.set(placeholder, attachment);
      return attachment;
    },
    newMeshAttachment: unsupported('mesh'),
    newBoundingBoxAttachment: unsupported('bounding box'),
    newPathAttachment: unsupported('path'),
    newClippingAttachment: unsupported('clipping'),
    newPointAttachment: unsupported('point')
  };
  let data: Spine.SkeletonData;
  try {
    data = new spine.SkeletonJson(loader).readSkeletonData(root);
  } catch (error) {
    throwIfAny([problem('E_SKELETON_FORMAT', `spine-core cannot read the skeleton: ${show(String(error))}.`)]);
    throw error;
  }
  const sequences = new Map<string, SequenceTemplate>();
  for (const [slot, info] of sequenceInfo) {
    const timelineAttachment = timelineAttachments.get(info.placeholder);
    if (!timelineAttachment || data.slots[info.slotIndex]?.name !== slot) throwIfAny([problem('E_PARITY_SLOT', `The sequence slot ${show(slot)} does not agree with SkeletonData.`, slot)]);
    sequences.set(slot, { ...info, timelineAttachment: timelineAttachment as Spine.RegionAttachment });
    // The shared data keeps no drawable attachment: a character never falls back to the default skin.
    data.defaultSkin?.removeAttachment(info.slotIndex, info.placeholder);
  }
  for (const template of templates.values()) {
    if (data.slots[template.slotIndex]?.name !== template.slot) throwIfAny([problem('E_PARITY_SLOT', `The slot index of ${show(template.slot)} does not agree with SkeletonData.`)]);
  }
  const skeleton = root.skeleton as Record<string, unknown>;
  return { contract, data, templates, sequences, spineVersion: typeof skeleton.spine === 'string' ? skeleton.spine : '' };
}
