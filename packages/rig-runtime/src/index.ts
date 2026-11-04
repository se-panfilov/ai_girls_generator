// Browser-safe entry: no Node.js modules. spine-core classes are passed in by the caller (see SpineRuntime).
export { applySkin, assembleCharacter, type AssemblyOptions, type CharacterAssembly, makeRegionAttachment, regionProblems } from '@rig-runtime/assemble';
export { type AtlasInspection, inspectAtlas } from '@rig-runtime/atlas';
export { AtlasCache, type AtlasCacheStats, atlasIdentity, type AtlasLoader } from '@rig-runtime/atlas-cache';
export { type AbsentPart, type CharacterParts, parseCharacter, type Part, type PartStatus, type PresentPart, safeRelativePath } from '@rig-runtime/character';
export { contractLine, type ContractSlot, parseRigContract, type Rect, type RigContract, slotMap } from '@rig-runtime/contract';
export { type CharacterOptions, ModularCharacter } from '@rig-runtime/modular-character';
export {
  type AtlasRef,
  canonicalJson,
  catalogProblems,
  compatibilityProblems,
  type CompatibilityRule,
  composeLimits,
  composeModules,
  type ComposeOptions,
  humanoidGirlV1Groups,
  type ModuleBinding,
  type ModuleGroup,
  moduleGroupProblems,
  moduleSchema,
  parseModule,
  type PartModule,
  seededRandom,
  selectionText,
  type Side
} from '@rig-runtime/modules';
export { type Problem, problem, RigRuntimeError } from '@rig-runtime/problems';
export { type AttachmentTemplate, loadSharedRig, type SharedRig } from '@rig-runtime/rig';
export { type SpineRuntime } from '@rig-runtime/spine';
