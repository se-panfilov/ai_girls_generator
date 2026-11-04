import { applySkin, makeRegionAttachment, regionProblems } from '@rig-runtime/assemble';
import { type AtlasCache } from '@rig-runtime/atlas-cache';
import { compatibilityProblems, type CompatibilityRule, type ModuleGroup, parseModule, type PartModule } from '@rig-runtime/modules';
import { type Problem, problem, RigRuntimeError, show, throwIfAny } from '@rig-runtime/problems';
import { type SharedRig } from '@rig-runtime/rig';
import type { Spine, SpineRuntime } from '@rig-runtime/spine';

type Installed = { readonly module: PartModule; readonly atlas: Spine.TextureAtlas };
type Prepared = { readonly module: PartModule; readonly atlas: Spine.TextureAtlas; readonly attachments: ReadonlyMap<number, Spine.RegionAttachment> };

export type CharacterOptions = {
  readonly groups: readonly ModuleGroup[];
  readonly rules?: readonly CompatibilityRule[];
  /** Expected pma flag of all atlases of this character. All module atlases must agree with it. */
  readonly pma: boolean;
  /**
   * An existing skeleton and animation state to adopt, for example the ones of a spine-webcomponents widget
   * that got the shared SkeletonData through its `skeletonData` property. The skeleton must use the shared SkeletonData.
   */
  readonly host?: { readonly skeleton: Spine.Skeleton; readonly state: Spine.AnimationState };
};

/**
 * One character instance on the shared rig. It owns one Skeleton, one AnimationState and one runtime Skin.
 * Modules change with `setModules`: all checks and loads come first; the change itself is one synchronous step,
 * so a renderer that draws between animation frames never sees a mix of the old and the new module.
 * When a check fails, the character keeps its old modules and the cache keeps no extra owner (atomic rollback).
 */
export class ModularCharacter {
  readonly skeleton: Spine.Skeleton;
  readonly state: Spine.AnimationState;
  private skin: Spine.Skin;
  private readonly installed = new Map<string, Installed>();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  /** Increments after each committed change. */
  revision = 0;

  constructor(
    private readonly spine: Pick<SpineRuntime, 'AnimationState' | 'AnimationStateData' | 'RegionAttachment' | 'Sequence' | 'Skeleton' | 'Skin'>,
    private readonly rig: SharedRig,
    private readonly cache: AtlasCache,
    private readonly options: CharacterOptions,
    readonly id: string
  ) {
    if (options.host && options.host.skeleton.data !== rig.data) {
      throw new RigRuntimeError([problem('E_RIG_DATA_MISMATCH', 'The host skeleton does not use the shared SkeletonData of the rig.')]);
    }
    this.skeleton = options.host?.skeleton ?? new spine.Skeleton(rig.data);
    this.state = options.host?.state ?? new spine.AnimationState(new spine.AnimationStateData(rig.data));
    this.skin = new spine.Skin(`character:${id}:0`);
    this.skeleton.setSkin(this.skin);
  }

  /** Module id by group. */
  modules(): ReadonlyMap<string, string> {
    return new Map([...this.installed].map(([group, item]) => [group, item.module.moduleId]));
  }

  /** Installs or replaces modules as one change. The first call must give a module for every group. */
  setModules(modules: readonly PartModule[]): Promise<void> {
    const run = this.queue.then(() => this.change(modules));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Releases all atlases of this character. The skeleton must not be drawn after this call. */
  dispose(): Promise<void> {
    const run = this.queue.then(() => {
      if (this.disposed) return;
      this.disposed = true;
      for (const item of this.installed.values()) this.cache.release(item.module.atlas);
      this.installed.clear();
      for (const slot of this.skeleton.slots) slot.pose.setAttachment(null);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private selectionProblems(modules: readonly PartModule[]): { selection: Map<string, PartModule>; problems: Problem[] } {
    const problems: Problem[] = [];
    const selection = new Map([...this.installed].map(([group, item]) => [group, item.module]));
    const requested = new Set<string>();
    for (const item of modules) {
      const group = this.options.groups.find((entry) => entry.id === item.group);
      if (!group) problems.push(problem('E_MODULE_UNKNOWN_GROUP', `The group ${show(item.group)} is not in the group table.`, item.moduleId));
      if (requested.has(item.group)) problems.push(problem('E_MODULE_DUPLICATE_GROUP', `Two modules in one change are for the group ${show(item.group)}.`, item.moduleId));
      if (item.rig.rigId !== this.rig.contract.rigId) problems.push(problem('E_MODULE_RIG_MISMATCH', `The module is for the rig ${show(item.rig.rigId)}.`, item.moduleId));
      if (item.atlas.pma !== this.options.pma) problems.push(problem('E_PMA_MISMATCH', `The module atlas uses pma=${item.atlas.pma}; the character uses pma=${this.options.pma}.`, item.moduleId));
      requested.add(item.group);
      selection.set(item.group, item);
    }
    const missing = this.options.groups.filter((group) => !selection.has(group.id)).map((group) => group.id);
    if (missing.length > 0) problems.push(problem('E_MODULE_INCOMPLETE_CHARACTER', `The character has no module for ${missing.map(show).join(', ')}.`));
    problems.push(...compatibilityProblems(selection, this.options.rules ?? []));
    return { selection, problems };
  }

  private prepare(item: PartModule, atlas: Spine.TextureAtlas): Prepared {
    const problems: Problem[] = [];
    const attachments = new Map<number, Spine.RegionAttachment>();
    if (atlas.pages.some((page) => page.pma !== item.atlas.pma)) problems.push(problem('E_PMA_MISMATCH', 'The atlas pages do not agree with the pma flag of the module.', item.moduleId));
    if (atlas.pages.some((page) => page.texture === null)) problems.push(problem('E_TEXTURE_MISSING', 'A page of the module atlas has no texture.', item.moduleId));
    for (const binding of item.bindings) {
      if (binding.status !== 'present') continue;
      const template = this.rig.templates.get(binding.slot);
      if (!template) {
        problems.push(problem('E_UNKNOWN_SLOT', `The rig has no template for ${show(binding.slot)}.`, item.moduleId));
        continue;
      }
      const region = atlas.findRegion(binding.region);
      if (!region) {
        problems.push(problem('E_REGION_MISSING', `The module atlas has no region ${show(binding.region)}.`, item.moduleId));
        continue;
      }
      const found = regionProblems(template, region);
      problems.push(...found);
      if (found.length === 0) attachments.set(template.slotIndex, makeRegionAttachment(this.spine, template, region));
    }
    throwIfAny(problems);
    return { module: item, atlas, attachments };
  }

  private async change(modules: readonly PartModule[]): Promise<void> {
    if (this.disposed) throw new RigRuntimeError([problem('E_CHARACTER_DISPOSED', `The character ${show(this.id)} is disposed.`)]);
    // Objects that did not come from parseModule get the same structural checks here.
    for (const item of modules) parseModule(item, this.rig.contract, this.options.groups);
    throwIfAny(this.selectionProblems(modules).problems);
    // Load the new atlases. Each successful acquire is released again if a later step fails.
    const acquired: PartModule[] = [];
    const prepared: Prepared[] = [];
    try {
      for (const item of modules) {
        const atlas = await this.cache.acquire(item.atlas);
        acquired.push(item);
        prepared.push(this.prepare(item, atlas));
      }
    } catch (error) {
      for (const item of acquired) this.cache.release(item.atlas);
      throw error;
    }
    // Commit: one synchronous step, no await below this line.
    const groups = new Set(modules.map((item) => item.group));
    const changedSlots = new Set<number>();
    for (const group of this.options.groups) {
      if (!groups.has(group.id)) continue;
      for (const slotId of group.slots) {
        const template = this.rig.templates.get(slotId);
        if (template) changedSlots.add(template.slotIndex);
      }
    }
    const next = new this.spine.Skin(`character:${this.id}:${this.revision + 1}`);
    for (const entry of this.skin.getAttachments()) {
      if (!changedSlots.has(entry.slotIndex)) next.setAttachment(entry.slotIndex, entry.placeholder, entry.attachment);
    }
    for (const item of prepared) {
      for (const [slotIndex, attachment] of item.attachments) {
        const template = [...this.rig.templates.values()].find((entry) => entry.slotIndex === slotIndex);
        if (template) next.setAttachment(slotIndex, template.placeholder, attachment);
      }
    }
    applySkin(
      this.skeleton,
      next,
      [...changedSlots].sort((left, right) => left - right)
    );
    this.skin = next;
    const replaced: PartModule[] = [];
    for (const item of prepared) {
      const old = this.installed.get(item.module.group);
      if (old) replaced.push(old.module);
      this.installed.set(item.module.group, { module: item.module, atlas: item.atlas });
    }
    this.revision += 1;
    // The old atlases are released after the commit, so the skeleton never refers to an unloaded texture.
    for (const old of replaced) this.cache.release(old.atlas);
  }
}
