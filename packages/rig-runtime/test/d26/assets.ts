import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

import * as spine from '@esotericsoftware/spine-core';
import { type AtlasLoader } from '@rig-runtime/atlas-cache';
import { type AtlasRef, type ModuleGroup, moduleSchema, parseModule, type PartModule } from '@rig-runtime/modules';

import { type SpikeRig } from './rig';

// D26 spike (experiment, not production). Small deterministic synthetic assets, made at run time (no images in Git).
// Each module has its own atlas (text) and page (PNG). The pixels are flat colours with a border, so that a screenshot can show
// which module and which eye frame is drawn.

/** Experimental group table with independent `head`, `hair` and `tail` groups (D23 proposal, section 3). Slot `eyes` is in no group: see the report. */
export const spikeGroups: readonly ModuleGroup[] = [
  { id: 'head', side: 'none', slots: ['head'] },
  { id: 'hair', side: 'none', slots: ['hair_back', 'hair_front', 'hair_tail', 'ear_far', 'ear_near'] },
  { id: 'head_accessory', side: 'none', slots: ['acc_head'] },
  { id: 'torso', side: 'none', slots: ['torso', 'hips', 'neck', 'skirt_back', 'skirt_front'] },
  { id: 'tail', side: 'none', slots: ['tail'] },
  { id: 'arm_near', side: 'near', slots: ['upper_arm_near', 'forearm_near', 'hand_near', 'hand_near_front'] },
  { id: 'arm_far', side: 'far', slots: ['upper_arm_far', 'forearm_far', 'hand_far'] },
  { id: 'legs', side: 'none', slots: ['thigh_far', 'shin_far', 'foot_far', 'thigh_near', 'shin_near', 'foot_near'] },
  { id: 'weapon', side: 'none', slots: ['weapon'] }
];

type Rgba = readonly [number, number, number, number];
export const colours = {
  skin: [240, 200, 170, 255],
  eyes: [20, 20, 70, 255],
  hairA: [230, 110, 170, 255],
  hairB: [70, 180, 110, 255],
  tail: [240, 150, 40, 255],
  body: [90, 120, 210, 255],
  clothes: [60, 60, 90, 255],
  clear: [0, 0, 0, 0]
} as const satisfies Record<string, Rgba>;

/** One image of a region. `pixel(x, y)` gives the colour; y is 0 at the top. */
type Image = { readonly name: string; readonly width: number; readonly height: number; readonly pixel: (x: number, y: number) => Rgba };

const darker = (colour: Rgba): Rgba => [colour[0] >> 1, colour[1] >> 1, colour[2] >> 1, colour[3]];

/** A filled rectangle with a 3 px darker border. */
function box(name: string, width: number, height: number, colour: Rgba): Image {
  return { name, width, height, pixel: (x, y) => (x < 3 || y < 3 || x >= width - 3 || y >= height - 3 ? darker(colour) : colour) };
}

/** Eye frames on a logical 140x48 rectangle: two eyes at x 30..54 and 86..110. Lid line top: open 8, partly closed 22, closed 34. Bottom 40 (38 when closed). */
export const eyeFrames = [
  { name: 'eyes_0', top: 8, bottom: 40 },
  { name: 'eyes_1', top: 22, bottom: 40 },
  { name: 'eyes_2', top: 34, bottom: 38 }
] as const;
export const eyeColumns = [
  [30, 54],
  [86, 110]
] as const;

function eyeImage(frame: (typeof eyeFrames)[number], width: number, height: number): Image {
  return {
    name: frame.name,
    width,
    height,
    pixel: (x, y) => (y >= frame.top && y < frame.bottom && eyeColumns.some(([left, right]) => x >= left && x < right) ? colours.eyes : colours.clear)
  };
}

/** Hair: the back hair is full; the front hair is a fringe (style A: top band; style B: top band and two side strands). */
function hairImage(slot: string, width: number, height: number, style: 'a' | 'b'): Image {
  const colour = style === 'a' ? colours.hairA : colours.hairB;
  if (slot !== 'hair_front') return box(slot, width, height, colour);
  const band = style === 'a' ? 0.32 : 0.2;
  return {
    name: slot,
    width,
    height,
    pixel: (x, y) => {
      const inBand = y < height * band;
      const inStrand = style === 'b' && (x < width * 0.14 || x >= width * 0.86);
      return inBand || inStrand ? colour : colours.clear;
    }
  };
}

type Packed = { readonly image: Image; readonly x: number; readonly y: number; readonly trim: { x: number; y: number; width: number; height: number } };

/** Bounding box of the non-transparent pixels. The packer trims to it, as the Spine Texture Packer does with whitespace stripping. */
function trimBox(image: Image): Packed['trim'] {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.pixel(x, y)[3] === 0) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) throw new Error(`The synthetic image ${image.name} is blank.`);
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** Shelf packer without rotation. Page width 1024. Two pixels of padding. Deterministic for the same image list. */
function pack(images: readonly Image[], trim: boolean): { packed: Packed[]; width: number; height: number } {
  const width = 1024;
  const packed: Packed[] = [];
  let x = 2;
  let y = 2;
  let shelf = 0;
  for (const image of images) {
    const box = trim ? trimBox(image) : { x: 0, y: 0, width: image.width, height: image.height };
    if (x + box.width + 2 > width) {
      x = 2;
      y += shelf + 2;
      shelf = 0;
    }
    packed.push({ image, x, y, trim: box });
    x += box.width + 2;
    shelf = Math.max(shelf, box.height);
  }
  return { packed, width, height: y + shelf + 2 };
}

/** PNG encoder: 8-bit RGBA, no interlace, filter 0. zlib output is stable for one Node.js build; the hashes are made at run time. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) raw.set(rgba.subarray(row * width * 4, (row + 1) * width * 4), row * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Atlas text (Spine 4 format) and the page PNG for one module. Trimmed regions get an `offsets` line (y offset from the bottom). */
function makeAtlas(page: string, images: readonly Image[], trim: boolean): { atlas: string; png: Buffer } {
  const { packed, width, height } = pack(images, trim);
  const rgba = new Uint8Array(width * height * 4);
  const lines = [page, `size:${width},${height}`, 'filter:Nearest,Nearest', 'pma:false'];
  for (const item of packed) {
    const { image, trim: box } = item;
    for (let y = 0; y < box.height; y += 1) {
      for (let x = 0; x < box.width; x += 1) rgba.set(image.pixel(box.x + x, box.y + y), ((item.y + y) * width + item.x + x) * 4);
    }
    lines.push(image.name, `bounds:${item.x},${item.y},${box.width},${box.height}`);
    if (box.width !== image.width || box.height !== image.height) lines.push(`offsets:${box.x},${image.height - box.y - box.height},${image.width},${image.height}`);
  }
  return { atlas: `${lines.join('\n')}\n`, png: encodePng(width, height, rgba) };
}

export type SyntheticAssets = {
  /** Relative file path → content. Atlas files are text, page files are PNG bytes. */
  readonly files: ReadonlyMap<string, string | Buffer>;
  /** Module manifests by module id: body groups, `hair.a`, `hair.b`, `tail.a`. */
  readonly modules: ReadonlyMap<string, PartModule>;
  /** Atlas of the eye frames and the frame region names, in sequence order. */
  readonly eyes: { readonly atlas: AtlasRef; readonly frames: readonly string[] };
};

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** Makes all synthetic assets for a spike rig. The same rig gives the same files and the same manifests. */
export function makeSyntheticAssets(rig: SpikeRig): SyntheticAssets {
  const files = new Map<string, string | Buffer>();
  const size = (slot: string): { width: number; height: number } => {
    const template = rig.templates.get(slot);
    if (!template) throw new Error(`The spike rig has no template for ${slot}.`);
    return { width: template.width, height: template.height };
  };
  const addAtlas = (base: string, images: readonly Image[], trim: boolean): AtlasRef => {
    const { atlas, png } = makeAtlas(`${base}.png`, images, trim);
    files.set(`${base}.atlas`, atlas);
    files.set(`${base}.png`, png);
    return { file: `${base}.atlas`, sha256: sha256(atlas), pma: false, pages: [{ file: `${base}.png`, sha256: sha256(png) }] };
  };
  // Body: every slot of the body groups, except the optional slots that the synthetic character does not have.
  const absent = new Set(['acc_head', 'weapon', 'hand_near_front']);
  const bodyGroups = spikeGroups.filter((group) => group.id !== 'hair' && group.id !== 'tail');
  const bodySlots = bodyGroups.flatMap((group) => group.slots).filter((slot) => !absent.has(slot));
  const bodyColour = (slot: string): Rgba => (slot === 'head' || slot === 'neck' || slot.startsWith('hand') ? colours.skin : slot.startsWith('skirt') ? colours.clothes : colours.body);
  const body = addAtlas(
    'body',
    bodySlots.map((slot) => box(slot, size(slot).width, size(slot).height, bodyColour(slot))),
    false
  );
  const hairSlots = spikeGroups.find((group) => group.id === 'hair')?.slots ?? [];
  const hairA = addAtlas(
    'hair_a',
    hairSlots.map((slot) => hairImage(slot, size(slot).width, size(slot).height, 'a')),
    false
  );
  // Style B has no ears and no hair tail (absent by design, D22).
  const hairBSlots = ['hair_back', 'hair_front'];
  const hairB = addAtlas(
    'hair_b',
    hairBSlots.map((slot) => hairImage(slot, size(slot).width, size(slot).height, 'b')),
    false
  );
  const tail = addAtlas('tail', [box('tail', size('tail').width, size('tail').height, colours.tail)], false);
  const eyesTemplate = rig.sequences.get('eyes');
  if (!eyesTemplate) throw new Error('The spike rig has no sequence slot eyes.');
  const eyes = addAtlas(
    'eyes',
    eyeFrames.map((frame) => eyeImage(frame, eyesTemplate.width, eyesTemplate.height)),
    true
  );
  const modules = new Map<string, PartModule>();
  const add = (moduleId: string, groupId: string, atlas: AtlasRef, present: readonly string[], tags: Record<string, string>): void => {
    const group = spikeGroups.find((item) => item.id === groupId);
    if (!group) throw new Error(`Unknown group ${groupId}`);
    const raw = {
      schema: moduleSchema,
      moduleId,
      rig: { rigId: rig.contract.rigId, contractVersion: rig.contract.contractVersion },
      group: group.id,
      side: group.side,
      bindings: group.slots.map((slot) => (present.includes(slot) ? { slot, status: 'present', region: slot } : { slot, status: 'absent_by_design' })),
      atlas,
      tags,
      provenance: { source: 'd26-spike synthetic', tool: 'test/d26/assets.ts' }
    };
    modules.set(moduleId, parseModule(raw, rig.contract, spikeGroups));
  };
  for (const group of bodyGroups) add(`body.${group.id}`, group.id, body, bodySlots, { style: 'body' });
  add('hair.a', 'hair', hairA, hairSlots, { style: 'hair_a' });
  add('hair.b', 'hair', hairB, hairBSlots, { style: 'hair_b' });
  add('tail.a', 'tail', tail, ['tail'], { style: 'tail_a' });
  return { files, modules, eyes: { atlas: eyes, frames: eyeFrames.map((frame) => frame.name) } };
}

/** A texture without GPU memory that counts live instances, so a test can find leaks. */
export class SpikeTexture extends spine.Texture {
  static live = 0;
  disposed = false;

  constructor(readonly label: string) {
    super({ width: 1, height: 1 });
    SpikeTexture.live += 1;
  }

  setFilters(): void {}

  setWraps(): void {}

  dispose(): void {
    if (this.disposed) throw new Error(`Texture ${this.label} is disposed twice.`);
    this.disposed = true;
    SpikeTexture.live -= 1;
  }
}

/**
 * Atlas loader over the synthetic files. It checks the atlas hash and each page hash of the reference, as a real loader must
 * (E_ATLAS_HASH_MISMATCH, E_TEXTURE_MISSING). `delay` runs before each load, so a test can draw frames while a module loads.
 */
export function spikeLoader(files: ReadonlyMap<string, string | Buffer>, delay?: () => Promise<void>): AtlasLoader & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async load(ref) {
      calls.push(ref.file);
      if (delay) await delay();
      const text = files.get(ref.file);
      if (typeof text !== 'string' || sha256(text) !== ref.sha256) throw new Error(`E_ATLAS_HASH_MISMATCH: ${ref.file}`);
      const atlas = new spine.TextureAtlas(text);
      for (const page of atlas.pages) {
        const pageRef = ref.pages.find((item) => item.file.endsWith(page.name));
        const bytes = pageRef ? files.get(pageRef.file) : undefined;
        if (!pageRef || !Buffer.isBuffer(bytes)) throw new Error(`E_TEXTURE_MISSING: ${page.name}`);
        if (sha256(bytes) !== pageRef.sha256) throw new Error(`E_ATLAS_HASH_MISMATCH: ${pageRef.file}`);
        page.setTexture(new SpikeTexture(`${ref.file}:${page.name}`));
      }
      return atlas;
    },
    unload(_ref, atlas) {
      atlas.dispose();
    }
  };
}
