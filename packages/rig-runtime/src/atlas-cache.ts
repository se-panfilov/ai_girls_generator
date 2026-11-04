import { type AtlasRef } from '@rig-runtime/modules';
import { problem, RigRuntimeError, show } from '@rig-runtime/problems';
import type { Spine } from '@rig-runtime/spine';

/**
 * Loads one atlas with its page textures. The loader must check the hashes in the reference and throw on a mismatch
 * (E_ATLAS_HASH_MISMATCH) or a missing page image (E_TEXTURE_MISSING). `unload` frees the textures (GPU memory in a browser).
 */
export type AtlasLoader = {
  readonly load: (ref: AtlasRef) => Promise<Spine.TextureAtlas>;
  readonly unload: (ref: AtlasRef, atlas: Spine.TextureAtlas) => void;
};

export type AtlasCacheStats = {
  /** Atlases with at least one owner. */
  readonly live: number;
  /** Loaded atlases without an owner, kept for a later acquire. */
  readonly unused: number;
  readonly loads: number;
  readonly unloads: number;
  /** Owner count by atlas identity (see `atlasIdentity`). */
  readonly owners: Readonly<Record<string, number>>;
};

/**
 * Cache identity of an atlas: the hash of the atlas text, the alpha mode, and the hash of each page image in page order.
 * File paths are not part of the identity: two references with the same content share one texture set.
 * Two references with the same atlas text but different page images have different identities, so a texture is never
 * reused for an image with other bytes.
 */
export function atlasIdentity(ref: AtlasRef): string {
  return `${ref.sha256}:${ref.pma ? 'pma' : 'straight'}:${ref.pages.map((page) => page.sha256).join(',')}`;
}

type Entry = { ref: AtlasRef; owners: number; promise: Promise<Spine.TextureAtlas>; atlas: Spine.TextureAtlas | null };

/**
 * Shared atlas cache with explicit owners. Each acquire needs one release. An atlas without owners stays loaded
 * until more than `maxUnused` atlases have no owner; then the least recently released atlas is unloaded.
 * The key is `atlasIdentity` (atlas and page content hashes), so two characters that use the same atlas share one texture set,
 * and a release by one character never unloads an atlas that another character still owns.
 */
export class AtlasCache {
  private readonly entries = new Map<string, Entry>();
  /** Keys without owners, oldest first. */
  private readonly unusedKeys: string[] = [];
  private loads = 0;
  private unloads = 0;

  constructor(
    private readonly loader: AtlasLoader,
    private readonly maxUnused = 2
  ) {
    if (!Number.isSafeInteger(maxUnused) || maxUnused < 0) throw new RigRuntimeError([problem('E_CACHE_CONFIG', 'maxUnused must be a non-negative integer.')]);
  }

  /** Adds one owner and returns the loaded atlas. A failed load adds no owner and keeps no entry. */
  async acquire(ref: AtlasRef): Promise<Spine.TextureAtlas> {
    const key = atlasIdentity(ref);
    let entry = this.entries.get(key);
    if (!entry) {
      this.loads += 1;
      const created: Entry = { ref, owners: 0, atlas: null, promise: this.loader.load(ref) };
      this.entries.set(key, created);
      created.promise.then(
        (atlas) => {
          created.atlas = atlas;
        },
        () => {
          if (this.entries.get(key) === created) this.entries.delete(key);
        }
      );
      entry = created;
    }
    entry.owners += 1;
    this.removeUnused(key);
    try {
      return await entry.promise;
    } catch (error) {
      entry.owners -= 1;
      throw error;
    }
  }

  /** Removes one owner. Releasing an atlas without an owner is an error (E_CACHE_RELEASE), because it shows a lifetime defect. */
  release(ref: AtlasRef): void {
    const key = atlasIdentity(ref);
    const entry = this.entries.get(key);
    if (!entry || entry.owners <= 0) throw new RigRuntimeError([problem('E_CACHE_RELEASE', `The atlas ${show(ref.file)} has no owner to release.`)]);
    entry.owners -= 1;
    if (entry.owners === 0) {
      this.unusedKeys.push(key);
      this.evict(this.maxUnused);
    }
  }

  /** Unloads every atlas without an owner. */
  trim(): void {
    this.evict(0);
  }

  stats(): AtlasCacheStats {
    const owners: Record<string, number> = {};
    let live = 0;
    for (const [key, entry] of this.entries) {
      owners[key] = entry.owners;
      if (entry.owners > 0) live += 1;
    }
    return { live, unused: this.unusedKeys.length, loads: this.loads, unloads: this.unloads, owners };
  }

  private removeUnused(key: string): void {
    const index = this.unusedKeys.indexOf(key);
    if (index >= 0) this.unusedKeys.splice(index, 1);
  }

  private evict(limit: number): void {
    while (this.unusedKeys.length > limit) {
      const key = this.unusedKeys.shift();
      const entry = key === undefined ? undefined : this.entries.get(key);
      if (key === undefined || !entry) continue;
      this.entries.delete(key);
      if (entry.atlas) {
        this.unloads += 1;
        this.loader.unload(entry.ref, entry.atlas);
      }
    }
  }
}
