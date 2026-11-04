import { type Problem, problem, show } from '@rig-runtime/problems';
import type { Spine, SpineRuntime } from '@rig-runtime/spine';

export type AtlasInspection = {
  readonly atlas: Spine.TextureAtlas;
  /** Regions by name. A duplicate name keeps the first region and adds E_ATLAS_DUPLICATE_REGION. */
  readonly regions: ReadonlyMap<string, Spine.TextureAtlasRegion>;
  readonly problems: readonly Problem[];
};

/**
 * Parses an atlas (or takes a parsed one) with the spine-core TextureAtlas parser (the parser that the game uses) and checks its structure.
 * TextureAtlas does not reject bad input, so these checks add error codes:
 * E_ATLAS_PARSE, E_ATLAS_EMPTY, E_ATLAS_PAGE_SIZE, E_ATLAS_REGION_BOUNDS, E_ATLAS_REGION_OUTSIDE_PAGE, E_ATLAS_REGION_GEOMETRY,
 * E_ATLAS_DUPLICATE_REGION, E_ATLAS_PMA_MIXED.
 */
export function inspectAtlas(spine: Pick<SpineRuntime, 'TextureAtlas'>, source: string | Spine.TextureAtlas): AtlasInspection {
  let atlas: Spine.TextureAtlas;
  try {
    // A loaded atlas (for example with page textures from a renderer) is checked as it is.
    atlas = typeof source === 'string' ? new spine.TextureAtlas(source) : source;
  } catch (error) {
    const empty = new spine.TextureAtlas('');
    return { atlas: empty, regions: new Map(), problems: [problem('E_ATLAS_PARSE', `The atlas text cannot be parsed: ${show(String(error))}.`)] };
  }
  const problems: Problem[] = [];
  const regions = new Map<string, Spine.TextureAtlasRegion>();
  if (atlas.pages.length === 0 || atlas.regions.length === 0) problems.push(problem('E_ATLAS_EMPTY', `The atlas has ${atlas.pages.length} pages and ${atlas.regions.length} regions.`));
  for (const page of atlas.pages) {
    if (!(page.width > 0 && page.height > 0)) problems.push(problem('E_ATLAS_PAGE_SIZE', `The page ${show(page.name)} has no valid size.`, page.name));
  }
  if (new Set(atlas.pages.map((page) => page.pma)).size > 1) problems.push(problem('E_ATLAS_PMA_MIXED', 'The pages of one atlas use different pma flags.'));
  for (const region of atlas.regions) {
    const { name, x, y, width, height, originalWidth, originalHeight, offsetX, offsetY, degrees } = region;
    if (regions.has(name)) {
      problems.push(problem('E_ATLAS_DUPLICATE_REGION', `The region ${show(name)} occurs more than once.`, name));
      continue;
    }
    regions.set(name, region);
    if (![x, y, width, height, originalWidth, originalHeight, offsetX, offsetY].every(Number.isFinite) || width <= 0 || height <= 0) {
      problems.push(problem('E_ATLAS_REGION_BOUNDS', `The region ${show(name)} has no valid bounds.`, name));
      continue;
    }
    const rotated = degrees === 90 || degrees === 270;
    const pageWidth = rotated ? height : width;
    const pageHeight = rotated ? width : height;
    if (region.page.width > 0 && (x < 0 || y < 0 || x + pageWidth > region.page.width || y + pageHeight > region.page.height)) {
      problems.push(problem('E_ATLAS_REGION_OUTSIDE_PAGE', `The region ${show(name)} is outside its page.`, name));
    }
    if (degrees !== 0 && degrees !== 90) problems.push(problem('E_ATLAS_REGION_GEOMETRY', `The region ${show(name)} has the unsupported rotation ${degrees}.`, name));
    if (offsetX < 0 || offsetY < 0 || offsetX + width > originalWidth || offsetY + height > originalHeight) {
      problems.push(problem('E_ATLAS_REGION_GEOMETRY', `The packed image of ${show(name)} is not inside its original size.`, name));
    }
  }
  return { atlas, regions, problems };
}
