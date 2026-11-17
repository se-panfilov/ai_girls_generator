import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

// Reads and checks a Spine export folder (skeleton JSON, text atlas, PNG pages) before the viewer serves it.
// The folder is read once. The server keeps the bytes in memory, so a later change of the folder has no effect,
// and no HTTP request can reach another file. Nothing in the folder is changed.

/** The Spine runtime generation of the viewer page. The export must come from the same major and minor version. */
export const runtimeVersion = '4.3';
export const requiredAnimations = ['idle', 'wave'] as const;
export const limits = {
  /** Entries in the export folder. */
  folderEntries: 256,
  skeletonBytes: 32 * 1024 * 1024,
  atlasBytes: 4 * 1024 * 1024,
  pageBytes: 64 * 1024 * 1024,
  pages: 32,
  totalBytes: 256 * 1024 * 1024,
  /** Largest width or height of one atlas page in pixels. */
  pageSide: 16384
} as const;

/** Plain file names only: no folder parts, no leading dot, no spaces. The server uses them as URL path segments without decoding. */
export const fileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class ViewerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const fail = (code: string, message: string): never => {
  throw new ViewerError(code, message);
};

/** Makes untrusted text safe for one line of terminal or JSON output: control characters become `?`, and the length is limited. */
export function safeText(value: unknown, max = 200): string {
  const input = String(value);
  let text = '';
  for (let index = 0; index < input.length && index < max; index += 1) {
    const code = input.charCodeAt(index);
    text += code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 ? '?' : input.charAt(index);
  }
  return input.length > max ? `${text}…` : text;
}

export type ExportFile = { readonly name: string; readonly bytes: number; readonly sha256: string; readonly data: Buffer };
export type AtlasPage = ExportFile & { readonly width: number; readonly height: number };
export type ExportBundle = {
  readonly folder: string;
  readonly skeleton: ExportFile & { readonly spine: string; readonly bones: number; readonly slots: number; readonly animations: readonly string[] };
  readonly atlas: ExportFile & { readonly regions: number };
  readonly pages: readonly AtlasPage[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Pages and regions of a Spine 4 text atlas. A page block starts after an empty line; its first line is the page image name. */
export function parseAtlas(text: string): { pages: { name: string; size: [number, number] | null }[]; regions: string[] } {
  const pages: { name: string; size: [number, number] | null }[] = [];
  const regions: string[] = [];
  const blocks = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n[ \t]*\r?\n/)
    .map((block) => block.split(/\r?\n/).filter((line) => line.trim() !== ''))
    .filter((lines) => lines.length > 0);
  for (const lines of blocks) {
    const [name, ...rest] = lines;
    if (name === undefined || name.includes(':')) fail('E_ATLAS_FORMAT', 'The atlas has a page block without a page name.');
    let size: [number, number] | null = null;
    let inPageHeader = true;
    for (const line of rest) {
      const colon = line.indexOf(':');
      if (colon < 0) {
        inPageHeader = false;
        regions.push(line.trim());
        continue;
      }
      if (inPageHeader && line.slice(0, colon).trim() === 'size') {
        const match = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(line.slice(colon + 1));
        if (match) size = [Number(match[1]), Number(match[2])];
      }
    }
    pages.push({ name: String(name).trim(), size });
  }
  return { pages, regions };
}

/** Width and height from the PNG signature and the IHDR chunk. The image data is not decoded. */
export function pngSize(data: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (data.length < 33 || !data.subarray(0, 8).equals(signature) || data.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** Image names that the region and mesh attachments of a Spine 4 skeleton need from the atlas (`path`, else the attachment name). */
export function attachmentImages(skeleton: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const skins = Array.isArray(skeleton.skins) ? skeleton.skins : [];
  for (const skin of skins) {
    if (!isRecord(skin) || !isRecord(skin.attachments)) continue;
    for (const slot of Object.values(skin.attachments)) {
      if (!isRecord(slot)) continue;
      for (const [name, attachment] of Object.entries(slot)) {
        if (!isRecord(attachment)) continue;
        const type = attachment.type ?? 'region';
        if (type !== 'region' && type !== 'mesh') continue;
        if (attachment.sequence !== undefined) continue;
        names.add(typeof attachment.path === 'string' ? attachment.path : typeof attachment.name === 'string' ? attachment.name : name);
      }
    }
  }
  return [...names].sort();
}

/**
 * Reads one regular file without following a symbolic link. The file is opened first (O_NOFOLLOW, O_NONBLOCK so that a FIFO
 * does not block), and all checks use the open descriptor. So no other file can take its place between the check and the read.
 * It returns a problem code, or the bytes.
 */
export function readFileNoFollow(path: string, maxBytes: number): Buffer | 'missing' | 'link' | 'type' | 'size' | 'changed' {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ELOOP' || code === 'EMLINK' ? 'link' : code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'type';
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return 'type';
    if (stat.size > maxBytes) return 'size';
    const data = readFileSync(descriptor);
    return data.length === stat.size ? data : 'changed';
  } finally {
    closeSync(descriptor);
  }
}

function readRegularFile(folder: string, name: string, maxBytes: number): ExportFile {
  if (!fileNamePattern.test(name)) fail('E_FILE_NAME', `The file name ${JSON.stringify(safeText(name))} is not supported. Use plain names (letters, digits, ".", "_", "-").`);
  const data = readFileNoFollow(join(folder, name), maxBytes);
  if (data === 'missing') return fail('E_FILE_MISSING', `The file ${name} is missing in the export folder.`);
  if (data === 'link') return fail('E_FILE_LINK', `${name} is a symbolic link. Use the files that Spine exported.`);
  if (data === 'type') return fail('E_FILE_TYPE', `${name} is not a regular file.`);
  if (data === 'size') return fail('E_FILE_SIZE', `${name} has more than ${maxBytes} bytes.`);
  if (data === 'changed') return fail('E_FILE_CHANGED', `${name} changed while it was read.`);
  return { name, bytes: data.length, sha256: sha256(data), data };
}

function pickOne(entries: readonly string[], suffixes: readonly string[], given: string | undefined, kind: string): string {
  if (given !== undefined) return given;
  const found = entries.filter((name) => suffixes.some((suffix) => name.endsWith(suffix)));
  if (found.length === 0) fail('E_FILE_MISSING', `The export folder has no ${kind} file (${suffixes.join(' or ')}).`);
  if (found.length > 1) fail('E_AMBIGUOUS', `The export folder has ${found.length} ${kind} files (${found.map((name) => safeText(name, 80)).join(', ')}). Select one with --${kind}.`);
  return found[0] as string;
}

export type ExportOptions = { readonly skeleton?: string; readonly atlas?: string };

/** Reads the export folder and checks it. It throws a ViewerError with a stable code at the first problem. */
export function readExport(folderInput: string, options: ExportOptions = {}): ExportBundle {
  let folder: string;
  try {
    folder = realpathSync(folderInput);
  } catch {
    return fail('E_FOLDER_MISSING', `The export folder ${JSON.stringify(safeText(folderInput))} does not exist.`);
  }
  let entries: string[];
  try {
    entries = readdirSync(folder);
  } catch {
    return fail('E_FOLDER_MISSING', `${JSON.stringify(safeText(folderInput))} is not a folder.`);
  }
  if (entries.length > limits.folderEntries) fail('E_FOLDER_SIZE', `The export folder has ${entries.length} entries. The limit is ${limits.folderEntries}.`);

  const skeletonName = pickOne(entries, ['.json'], options.skeleton, 'skeleton');
  const atlasName = pickOne(entries, ['.atlas', '.atlas.txt'], options.atlas, 'atlas');
  const skeletonFile = readRegularFile(folder, skeletonName, limits.skeletonBytes);
  const atlasFile = readRegularFile(folder, atlasName, limits.atlasBytes);

  let json: unknown;
  try {
    json = JSON.parse(skeletonFile.data.toString('utf8'));
  } catch {
    return fail('E_SKELETON_JSON', `${skeletonName} is not valid JSON.`);
  }
  if (!isRecord(json) || !isRecord(json.skeleton)) return fail('E_SKELETON_JSON', `${skeletonName} is not a Spine skeleton JSON file (no "skeleton" object).`);
  const spine = typeof json.skeleton.spine === 'string' ? json.skeleton.spine : '';
  if (spine !== runtimeVersion && !spine.startsWith(`${runtimeVersion}.`)) {
    fail('E_SPINE_VERSION', `${skeletonName} comes from Spine ${JSON.stringify(safeText(spine, 40))}. The viewer runtime is Spine ${runtimeVersion}. Export with Spine ${runtimeVersion}.`);
  }
  const animations = isRecord(json.animations) ? Object.keys(json.animations).sort() : [];
  const missing = requiredAnimations.filter((name) => !animations.includes(name));
  if (missing.length > 0) fail('E_ANIMATION_MISSING', `${skeletonName} has no animation ${missing.join(', ')}. Animations: ${animations.map((name) => safeText(name, 40)).join(', ') || 'none'}.`);

  const atlas = parseAtlas(atlasFile.data.toString('utf8'));
  if (atlas.pages.length === 0) fail('E_ATLAS_FORMAT', `${atlasName} has no page.`);
  if (atlas.pages.length > limits.pages) fail('E_ATLAS_FORMAT', `${atlasName} has ${atlas.pages.length} pages. The limit is ${limits.pages}.`);
  const regionSet = new Set(atlas.regions);
  const absent = attachmentImages(json).filter((name) => !regionSet.has(name));
  if (absent.length > 0)
    fail(
      'E_REGION_MISSING',
      `${atlasName} has no region for ${absent.length} attachment images: ${absent
        .slice(0, 10)
        .map((name) => safeText(name, 60))
        .join(', ')}.`
    );

  const pageNames = atlas.pages.map((page) => page.name);
  if (new Set(pageNames).size !== pageNames.length) fail('E_ATLAS_FORMAT', `${atlasName} names one page image more than once.`);
  let total = skeletonFile.bytes + atlasFile.bytes;
  const pages: AtlasPage[] = atlas.pages.map((page) => {
    if (!page.name.toLowerCase().endsWith('.png')) fail('E_PAGE_TYPE', `The atlas page ${JSON.stringify(safeText(page.name))} is not a PNG file.`);
    const file = readRegularFile(folder, page.name, limits.pageBytes);
    const size = pngSize(file.data);
    if (size === null) return fail('E_PAGE_PNG', `${page.name} is not a PNG image.`);
    if (size.width < 1 || size.height < 1 || size.width > limits.pageSide || size.height > limits.pageSide) {
      fail('E_PAGE_SIZE', `${page.name} is ${size.width}x${size.height} px. The limit is ${limits.pageSide} px for each side.`);
    }
    if (page.size !== null && (page.size[0] !== size.width || page.size[1] !== size.height)) {
      fail('E_PAGE_SIZE', `${page.name} is ${size.width}x${size.height} px, but the atlas gives ${page.size[0]}x${page.size[1]}.`);
    }
    total += file.bytes;
    if (total > limits.totalBytes) fail('E_FOLDER_SIZE', `The export files have more than ${limits.totalBytes} bytes.`);
    return { ...file, ...size };
  });

  return {
    folder,
    skeleton: {
      ...skeletonFile,
      spine,
      bones: Array.isArray(json.bones) ? json.bones.length : 0,
      slots: Array.isArray(json.slots) ? json.slots.length : 0,
      animations
    },
    atlas: { ...atlasFile, regions: atlas.regions.length },
    pages
  };
}

/** The JSON report of an export, without the file bytes. */
export function exportReport(bundle: ExportBundle): Record<string, unknown> {
  const file = ({ name, bytes, sha256 }: ExportFile): Record<string, unknown> => ({ name, bytes, sha256 });
  return {
    folder: bundle.folder,
    skeleton: { ...file(bundle.skeleton), spine: bundle.skeleton.spine, bones: bundle.skeleton.bones, slots: bundle.skeleton.slots, animations: bundle.skeleton.animations },
    atlas: { ...file(bundle.atlas), regions: bundle.atlas.regions },
    pages: bundle.pages.map((page) => ({ ...file(page), width: page.width, height: page.height }))
  };
}
