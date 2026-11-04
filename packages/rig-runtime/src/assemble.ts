import { inspectAtlas } from '@rig-runtime/atlas';
import { type CharacterParts } from '@rig-runtime/character';
import { type Problem, problem, show, throwIfAny } from '@rig-runtime/problems';
import { type AttachmentTemplate, type SharedRig } from '@rig-runtime/rig';
import type { Spine, SpineRuntime } from '@rig-runtime/spine';

export type AssemblyOptions = {
  /** Expected pma flag of the atlas pages. When absent, every page of one assembly must use the same flag. */
  readonly pma?: boolean;
};

export type CharacterAssembly = {
  readonly skin: Spine.Skin;
  /** Slot id → atlas region name, for present parts. */
  readonly attached: ReadonlyMap<string, string>;
  /** Slots without an attachment, because the part is absent by design. */
  readonly omitted: readonly string[];
  /** Notes that do not stop the assembly, for example W_ABSENT_PART_REGION_IGNORED. */
  readonly warnings: readonly Problem[];
};

/**
 * Checks one atlas region against the attachment template of the editor master (which has the contract rectangle size).
 * E_PRESENT_PART_BLANK: the packer wrote a 1x1 region for a part that must be visible (a transparent source image).
 * E_REGION_ORIG_MISMATCH: the original size of the region is not the attachment rectangle size.
 */
export function regionProblems(template: AttachmentTemplate, region: Spine.TextureAtlasRegion): Problem[] {
  const { originalWidth, originalHeight, width, height } = region;
  if (originalWidth === 1 && originalHeight === 1 && width === 1 && height === 1 && (template.width > 1 || template.height > 1)) {
    return [problem('E_PRESENT_PART_BLANK', `The region ${show(region.name)} is a 1x1 blank image, but ${show(template.slot)} is present. The source image is transparent.`, template.slot)];
  }
  if (originalWidth !== template.width || originalHeight !== template.height) {
    return [
      problem(
        'E_REGION_ORIG_MISMATCH',
        `The region ${show(region.name)} has the original size ${originalWidth}x${originalHeight}; the attachment rectangle is ${template.width}x${template.height}.`,
        template.slot
      )
    ];
  }
  return [];
}

/** Makes a new region attachment from a template and an atlas region. The template and the region stay unchanged. */
export function makeRegionAttachment(spine: Pick<SpineRuntime, 'RegionAttachment' | 'Sequence'>, template: AttachmentTemplate, region: Spine.TextureAtlasRegion): Spine.RegionAttachment {
  const sequence = new spine.Sequence(1, false);
  sequence.regions[0] = region;
  const attachment = new spine.RegionAttachment(template.name, sequence);
  attachment.path = template.path;
  attachment.x = template.x;
  attachment.y = template.y;
  attachment.scaleX = template.scaleX;
  attachment.scaleY = template.scaleY;
  attachment.rotation = template.rotation;
  attachment.width = template.width;
  attachment.height = template.height;
  if (template.color !== null) attachment.color.setFromString(template.color);
  attachment.updateSequence();
  return attachment;
}

/**
 * Makes the runtime skin of one character from the shared rig, character.json and the character atlas.
 * Present parts get a region attachment with a real atlas region. Absent parts get no attachment.
 * Atlas regions for absent parts (for example 1x1 regions from "Ignore blank images: off") are ignored and reported as warnings.
 * Error codes: E_REGION_MISSING, E_PRESENT_PART_BLANK, E_REGION_ORIG_MISMATCH, E_ATLAS_UNKNOWN_REGION, E_PMA_MISMATCH, and the E_ATLAS_* codes.
 */
export function assembleCharacter(
  spine: Pick<SpineRuntime, 'RegionAttachment' | 'Sequence' | 'Skin' | 'TextureAtlas'>,
  rig: SharedRig,
  character: CharacterParts,
  atlasSource: string | Spine.TextureAtlas,
  options: AssemblyOptions = {}
): CharacterAssembly & { readonly atlas: Spine.TextureAtlas } {
  const inspection = inspectAtlas(spine, atlasSource);
  const problems: Problem[] = [...inspection.problems];
  const warnings: Problem[] = [];
  const known = new Set([...rig.templates.values()].map((template) => template.path));
  for (const name of inspection.regions.keys()) {
    if (!known.has(name)) problems.push(problem('E_ATLAS_UNKNOWN_REGION', `The atlas region ${show(name)} belongs to no slot of the rig.`, name));
  }
  const pmaFlags = new Set(inspection.atlas.pages.map((page) => page.pma));
  if (options.pma !== undefined && (pmaFlags.size !== 1 || !pmaFlags.has(options.pma))) {
    problems.push(problem('E_PMA_MISMATCH', `The atlas pages use pma=${[...pmaFlags].join('/')}; the renderer expects pma=${options.pma}.`));
  }
  const skin = new spine.Skin(`character:${character.characterId}`);
  const attached = new Map<string, string>();
  const omitted: string[] = [];
  for (const template of rig.templates.values()) {
    const part = character.parts[template.slot];
    const region = inspection.regions.get(template.path);
    if (part?.status !== 'present') {
      omitted.push(template.slot);
      if (region) warnings.push(problem('W_ABSENT_PART_REGION_IGNORED', `The atlas has the region ${show(region.name)} for an absent part. It is not attached.`, template.slot));
      continue;
    }
    if (!region) {
      problems.push(problem('E_REGION_MISSING', `The present part ${show(template.slot)} has no region ${show(template.path)} in the atlas.`, template.slot));
      continue;
    }
    const found = regionProblems(template, region);
    problems.push(...found);
    if (found.length > 0) continue;
    skin.setAttachment(template.slotIndex, template.placeholder, makeRegionAttachment(spine, template, region));
    attached.set(template.slot, region.name);
  }
  throwIfAny(problems);
  return { skin, attached, omitted, warnings, atlas: inspection.atlas };
}

/**
 * Applies a skin to a skeleton in one synchronous step.
 * Skeleton.setSkin keeps the old attachment of a slot when the new skin has no entry for it (Skin.attachAll).
 * This function sets every slot explicitly: the attachment of the new skin, or none.
 * Only the slots in `slotIndexes` change when the list is given. Bones, animation state and the other slots stay unchanged.
 */
export function applySkin(skeleton: Spine.Skeleton, skin: Spine.Skin, slotIndexes?: readonly number[]): void {
  const oldSkin = skeleton.skin;
  const indexes = slotIndexes ?? skeleton.slots.map((_slot, index) => index);
  // The placeholder that each slot shows now. It is the setup placeholder unless an attachment timeline changed it.
  const placeholders = indexes.map((index) => {
    const slot = skeleton.slots[index];
    const current = slot?.pose.getAttachment();
    const entry = current && oldSkin ? oldSkin.getAttachments().find((item) => item.slotIndex === index && item.attachment === current) : undefined;
    return entry?.placeholder ?? slot?.data.attachmentName ?? null;
  });
  skeleton.setSkin(skin);
  for (const [position, index] of indexes.entries()) {
    const slot = skeleton.slots[index];
    const name = placeholders[position];
    if (slot) slot.pose.setAttachment(name ? skin.getAttachment(index, name) : null);
  }
}
