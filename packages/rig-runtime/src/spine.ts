import type * as Spine from '@esotericsoftware/spine-core';

/**
 * The spine-core classes that this package uses. The caller passes them in.
 * A browser page passes the namespace of the bundle that also renders (for example `spine` from spine-webcomponents),
 * so that `instanceof RegionAttachment` in the renderer and in this package refer to the same class.
 * Thus this package has no runtime dependency on spine-core; it uses only its types.
 */
export type SpineRuntime = Pick<typeof Spine, 'AnimationState' | 'AnimationStateData' | 'PointAttachment' | 'RegionAttachment' | 'Sequence' | 'Skeleton' | 'SkeletonJson' | 'Skin' | 'TextureAtlas'>;

export type { Spine };
