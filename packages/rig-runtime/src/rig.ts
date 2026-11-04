import { type RigContract } from '@rig-runtime/contract';
import { isRecord, type Problem, problem, show, throwIfAny } from '@rig-runtime/problems';
import type { Spine, SpineRuntime } from '@rig-runtime/spine';

/** Geometry of one region attachment in the editor master, read from the default skin of the skeleton JSON. */
export type AttachmentTemplate = {
  readonly slot: string;
  readonly slotIndex: number;
  /** Skin key (the placeholder name) that the slot setup pose and attachment timelines use. */
  readonly placeholder: string;
  readonly name: string;
  /** Atlas region name. It is the attachment `path`, or the name when no path is set. */
  readonly path: string;
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotation: number;
  readonly width: number;
  readonly height: number;
  readonly color: string | null;
};

/**
 * One immutable skeleton and animation set for all characters.
 * `data` has no region attachments: the attachment loader drops them, so no character can fall back to a default skin
 * region and no texture lookup happens at load time. Each character gets its own runtime skin from `templates`.
 */
export type SharedRig = {
  readonly contract: RigContract;
  readonly data: Spine.SkeletonData;
  readonly templates: ReadonlyMap<string, AttachmentTemplate>;
  readonly spineVersion: string;
};

const allowedAttachmentKeys = new Set(['type', 'name', 'path', 'x', 'y', 'scaleX', 'scaleY', 'rotation', 'width', 'height', 'color']);

/** Attachment loader for the shared rig: no region is resolved, no mesh, clipping, path or bounding box is accepted. */
function templateLoader(): Spine.AttachmentLoader {
  const unsupported = (kind: string) => (): never => {
    throw new Error(`E_PROFILE_ATTACHMENT_TYPE: ${kind} attachments are not in the rigid-region profile.`);
  };
  return {
    // Returning null makes SkeletonJson skip the attachment. The templates keep its geometry.
    newRegionAttachment: () => null as unknown as Spine.RegionAttachment,
    newMeshAttachment: unsupported('mesh'),
    newBoundingBoxAttachment: unsupported('bounding box'),
    newPathAttachment: unsupported('path'),
    newClippingAttachment: unsupported('clipping'),
    newPointAttachment: unsupported('point')
  };
}

function readTemplates(json: Record<string, unknown>, contract: RigContract): { templates: Map<string, AttachmentTemplate>; problems: Problem[] } {
  const problems: Problem[] = [];
  const templates = new Map<string, AttachmentTemplate>();
  const slots = Array.isArray(json.slots) ? (json.slots as unknown[]) : [];
  const skins = Array.isArray(json.skins) ? (json.skins as unknown[]) : [];
  if (skins.length !== 1 || !isRecord(skins[0]) || skins[0].name !== 'default') {
    problems.push(problem('E_PROFILE_SKINS', 'The editor master must have exactly one skin, named "default". Character skins are made at run time.'));
    return { templates, problems };
  }
  const attachments = isRecord(skins[0].attachments) ? skins[0].attachments : {};
  const rects = new Map(contract.slots.map((slot) => [slot.id, slot.attachmentRect]));
  const contractIds = new Set(contract.slots.map((slot) => slot.id));
  const jsonIds = slots.map((slot) => (isRecord(slot) ? slot.name : undefined));
  for (const id of contractIds) if (!jsonIds.includes(id)) problems.push(problem('E_PARITY_SLOT', `The skeleton has no slot ${show(id)}.`, id));
  for (const [index, slot] of slots.entries()) {
    if (!isRecord(slot) || typeof slot.name !== 'string') continue;
    const id = slot.name;
    if (!contractIds.has(id)) {
      problems.push(problem('E_PARITY_SLOT', `The skeleton slot ${show(id)} is not in the contract.`, id));
      continue;
    }
    const entries = isRecord(attachments[id]) ? Object.entries(attachments[id]) : [];
    if (entries.length !== 1) {
      problems.push(problem('E_PROFILE_ATTACHMENTS', `The slot ${show(id)} must have exactly one attachment in the default skin, not ${entries.length}.`, id));
      continue;
    }
    const [placeholder, raw] = entries[0] as [string, unknown];
    if (!isRecord(raw)) continue;
    if (slot.attachment !== placeholder) problems.push(problem('E_PROFILE_SETUP_ATTACHMENT', `The setup attachment of ${show(id)} must be ${show(placeholder)}.`, id));
    const extra = Object.keys(raw).filter((key) => !allowedAttachmentKeys.has(key));
    if ((raw.type ?? 'region') !== 'region') problems.push(problem('E_PROFILE_ATTACHMENT_TYPE', `The attachment of ${show(id)} has the type ${show(raw.type)}; only region is permitted.`, id));
    if (extra.length > 0) problems.push(problem('E_PROFILE_ATTACHMENT_FIELDS', `The attachment of ${show(id)} has unsupported fields: ${extra.map(show).join(', ')}.`, id));
    const number = (key: string, fallback: number): number => {
      const value = raw[key] ?? fallback;
      if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(problem('E_PROFILE_ATTACHMENT_FIELDS', `${key} of ${show(id)} must be a finite number.`, id));
      return Number(value);
    };
    const template: AttachmentTemplate = {
      slot: id,
      slotIndex: index,
      placeholder,
      name: typeof raw.name === 'string' ? raw.name : placeholder,
      path: typeof raw.path === 'string' ? raw.path : typeof raw.name === 'string' ? raw.name : placeholder,
      x: number('x', 0),
      y: number('y', 0),
      scaleX: number('scaleX', 1),
      scaleY: number('scaleY', 1),
      rotation: number('rotation', 0),
      width: number('width', Number.NaN),
      height: number('height', Number.NaN),
      color: typeof raw.color === 'string' ? raw.color : null
    };
    const rect = rects.get(id);
    if (rect && (template.width !== rect.w || template.height !== rect.h)) {
      problems.push(problem('E_TEMPLATE_RECT_MISMATCH', `The attachment of ${show(id)} is ${template.width}x${template.height}; the contract rectangle is ${rect.w}x${rect.h}.`, id));
    }
    templates.set(id, template);
  }
  return { templates, problems };
}

/**
 * Loads the editor master export once for all characters.
 * The skeleton JSON is not changed. Region attachments become templates; SkeletonData gets bones, slots, animations and an empty default skin.
 * Error codes: E_SKELETON_FORMAT, E_PROFILE_*, E_PARITY_SLOT, E_TEMPLATE_RECT_MISMATCH.
 */
export function loadSharedRig(spine: Pick<SpineRuntime, 'SkeletonJson'>, skeletonJsonText: string, contract: RigContract): SharedRig {
  let json: unknown;
  try {
    json = JSON.parse(skeletonJsonText);
  } catch (error) {
    throwIfAny([problem('E_SKELETON_FORMAT', `The skeleton JSON cannot be parsed: ${show(String(error))}.`)]);
  }
  if (!isRecord(json) || !isRecord(json.skeleton)) throwIfAny([problem('E_SKELETON_FORMAT', 'The skeleton JSON has no "skeleton" object.')]);
  const root = json as Record<string, unknown>;
  const { templates, problems } = readTemplates(root, contract);
  throwIfAny(problems);
  let data: Spine.SkeletonData;
  try {
    data = new spine.SkeletonJson(templateLoader()).readSkeletonData(root);
  } catch (error) {
    const message = String(error);
    const code = /^Error: (E_[A-Z_]+):/.exec(message)?.[1] ?? 'E_SKELETON_FORMAT';
    throwIfAny([problem(code, `spine-core cannot read the skeleton: ${show(message)}.`)]);
    throw error;
  }
  for (const template of templates.values()) {
    if (data.slots[template.slotIndex]?.name !== template.slot) throwIfAny([problem('E_PARITY_SLOT', `The slot index of ${show(template.slot)} does not agree with SkeletonData.`)]);
  }
  const skeleton = root.skeleton as Record<string, unknown>;
  return { contract, data, templates, spineVersion: typeof skeleton.spine === 'string' ? skeleton.spine : '' };
}
