import { basename, dirname, join } from 'node:path';

import { digestOf, fail, isRecord, pngSize, readOrFail, safeText, sha256, shaPattern } from '@factory/files';

// Checks of the files that a person gives. The factory reads them and never changes them.
// The checks are small: the existing commands do the full validation when they run.

export const limits = {
  contractBytes: 4 * 1024 * 1024,
  imageBytes: 64 * 1024 * 1024,
  imageSide: 8192,
  metadataBytes: 1024 * 1024,
  layers: 64,
  layerBytes: 64 * 1024 * 1024,
  landmarkBytes: 1024 * 1024,
  landmarks: 500,
  correspondenceBytes: 16 * 1024 * 1024
};

export const landmarkFormat = 'aigg.l0-1c.landmarks/0.1';
export const metadataSuffix = '.psd.json';

function parseJson(data: Buffer, label: string, code: string): unknown {
  try {
    return JSON.parse(data.toString('utf8'));
  } catch {
    return fail(code, `${label} is not valid JSON.`);
  }
}

/** The rig contract or candidate rig: a JSON object. assemble-body checks the content. */
export function readContract(path: string): { sha256: string; bytes: number } {
  const data = readOrFail(path, limits.contractBytes, 'The contract file', 'E_CONTRACT');
  if (!isRecord(parseJson(data, 'The contract file', 'E_CONTRACT'))) fail('E_CONTRACT', 'The contract file must be a JSON object.');
  return { sha256: sha256(data), bytes: data.length };
}

/** The approved concept image: a PNG file. Only the header is read for the size; the pixels are not decoded. */
export function readConcept(path: string): { sha256: string; width: number; height: number } {
  const data = readOrFail(path, limits.imageBytes, 'The concept image', 'E_CONCEPT');
  const size = pngSize(data);
  if (size === null) fail('E_CONCEPT', 'The concept image must be a PNG file.');
  const { width, height } = size as { width: number; height: number };
  if (width < 1 || height < 1 || width > limits.imageSide || height > limits.imageSide) fail('E_CONCEPT', `The concept image is ${width} x ${height}. The limit is ${limits.imageSide} on each side.`);
  return { sha256: sha256(data), width, height };
}

export type LayerSet = {
  readonly digest: string;
  readonly metadataPath: string;
  readonly layersDir: string;
  readonly imagePath: string;
  readonly metadataSha256: string;
  readonly imageSha256: string;
  readonly frame: readonly [number, number];
  readonly layers: readonly { tag: string; sha256: string; width: number; height: number }[];
  readonly missing: readonly string[];
};

const tagIsSafe = (tag: string): boolean => tag.length > 0 && tag.length <= 64 && !tag.startsWith('.') && !tag.includes('/') && !tag.includes('\\') && safeText(tag) === tag;

/** The folder of the layer PNG files of a See-through result: `<stem>.psd.json` and `<stem>/`. */
export function layerPaths(metadataPath: string): { layersDir: string; imagePath: string } {
  const name = basename(metadataPath);
  if (!name.endsWith(metadataSuffix) || name.length === metadataSuffix.length) fail('E_LAYERS', `The layer metadata file must be named <stem>${metadataSuffix}.`);
  const layersDir = join(dirname(metadataPath), name.slice(0, -metadataSuffix.length));
  return { layersDir, imagePath: join(layersDir, 'src_img.png') };
}

/**
 * Reads a See-through result (an import, not a generation): the metadata, the layer PNG files that it names, and src_img.png.
 * The digest covers the metadata and each file, so that a changed layer makes the layer review and all later stages stale.
 */
export function readLayerSet(metadataPath: string): LayerSet {
  const { layersDir, imagePath } = layerPaths(metadataPath);
  const metadataData = readOrFail(metadataPath, limits.metadataBytes, 'The layer metadata', 'E_LAYERS');
  const metadata = parseJson(metadataData, 'The layer metadata', 'E_LAYERS');
  if (!isRecord(metadata) || !isRecord(metadata.parts)) return fail('E_LAYERS', 'The layer metadata must have a "parts" object (See-through <stem>.psd.json).');
  const frame = metadata.frame_size;
  if (!Array.isArray(frame) || frame.length !== 2 || !frame.every((side) => Number.isSafeInteger(side) && (side as number) > 0 && (side as number) <= limits.imageSide)) {
    return fail('E_LAYERS', `The layer metadata must have "frame_size": [width, height] with sides from 1 to ${limits.imageSide}.`);
  }
  const [width, height] = frame as [number, number];
  const tags = Object.keys(metadata.parts).sort();
  if (tags.length === 0 || tags.length > limits.layers) fail('E_LAYERS', `The layer metadata must name 1 to ${limits.layers} layers.`);
  const layers: { tag: string; sha256: string; width: number; height: number }[] = [];
  const missing: string[] = [];
  for (const tag of tags) {
    if (!tagIsSafe(tag)) fail('E_LAYERS', `The layer name ${JSON.stringify(safeText(tag, 70))} is not supported.`);
    const path = join(layersDir, `${tag}.png`);
    let data: Buffer;
    try {
      data = readOrFail(path, limits.layerBytes, 'The layer file', 'E_LAYERS');
    } catch (error) {
      if ((error as { code?: string }).code === 'E_LAYERS_MISSING') {
        missing.push(tag);
        continue;
      }
      throw error;
    }
    const size = pngSize(data);
    if (size === null) fail('E_LAYERS', `The layer file ${safeText(tag)}.png is not a PNG file.`);
    layers.push({ tag, sha256: sha256(data), width: size?.width ?? 0, height: size?.height ?? 0 });
  }
  if (layers.length === 0) fail('E_LAYERS_MISSING', `No layer file is in ${safeText(layersDir)}.`);
  const image = readOrFail(imagePath, limits.imageBytes, 'The See-through input image', 'E_LAYERS');
  const imageSize = pngSize(image);
  if (imageSize === null || imageSize.width !== width || imageSize.height !== height) fail('E_LAYERS', `src_img.png must be a PNG file of the frame size ${width} x ${height}.`);
  const metadataSha256 = sha256(metadataData);
  const imageSha256 = sha256(image);
  return {
    digest: digestOf({ metadata: metadataSha256, image: imageSha256, layers: layers.map((layer) => [layer.tag, layer.sha256]), missing }),
    metadataPath,
    layersDir,
    imagePath,
    metadataSha256,
    imageSha256,
    frame: [width, height],
    layers,
    missing
  };
}

export type Marks = { readonly landmarksSha256: string; readonly correspondenceSha256: string; readonly count: number; readonly markedBy: string };

/** Reads the manual landmark file. */
export function readLandmarks(path: string): { sha256: string; count: number; markedBy: string } {
  const data = readOrFail(path, limits.landmarkBytes, 'The landmark file', 'E_LANDMARKS');
  const value = parseJson(data, 'The landmark file', 'E_LANDMARKS');
  if (!isRecord(value) || value.format !== landmarkFormat || !Array.isArray(value.landmarks))
    return fail('E_LANDMARKS', `The landmark file must have "format": "${landmarkFormat}" and a "landmarks" list.`);
  if (value.landmarks.length === 0 || value.landmarks.length > limits.landmarks) fail('E_LANDMARKS', `The landmark file must have 1 to ${limits.landmarks} landmarks.`);
  return { sha256: sha256(data), count: value.landmarks.length, markedBy: safeText(typeof value.markedBy === 'string' ? value.markedBy : 'unknown', 100) };
}

/** Reads the align-study correspondence file and returns the digests that it names. */
export function readCorrespondence(path: string): { sha256: string; imageSha256: string; landmarksSha256: string } {
  const data = readOrFail(path, limits.correspondenceBytes, 'The correspondence file', 'E_LANDMARKS');
  const value = parseJson(data, 'The correspondence file', 'E_LANDMARKS');
  const inputs = isRecord(value) ? value.inputs : null;
  const image = isRecord(inputs) ? inputs.image : null;
  const imageSha256 = isRecord(image) ? image.sha256 : null;
  const landmarksSha256 = isRecord(inputs) ? inputs.manualLandmarks : null;
  if (typeof imageSha256 !== 'string' || !shaPattern.test(imageSha256) || typeof landmarksSha256 !== 'string' || !shaPattern.test(landmarksSha256)) {
    return fail('E_LANDMARKS', 'The correspondence file must be the correspondence.json of align-study with --landmarks (inputs.image.sha256 and inputs.manualLandmarks).');
  }
  return { sha256: sha256(data), imageSha256, landmarksSha256 };
}
