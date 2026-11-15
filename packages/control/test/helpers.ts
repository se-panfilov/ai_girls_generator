import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { landmarkFormat } from '@control/alignstudy';
import { composite } from '@control/layersplit';
import { encodePng, sha256 } from '@control/png';
import { type Color, Raster } from '@control/raster';

/** The L1 test rig contract of the rig-runtime fixtures (owner test data, not production geometry). */
export const l1ContractBytes = (): Buffer => readFileSync(fileURLToPath(new URL('../../rig-runtime/test/fixtures/l1-owner/rig.contract.json', import.meta.url)));

type Bone = { id: string; parent: string | null; joint: { x: number; y: number } };

/**
 * A synthetic contract with the bones and slots that the pose needs.
 * `nearOnLeft` selects the side layout: true puts the near side on the left of the image.
 */
export function syntheticContract(nearOnLeft = true): Record<string, unknown> {
  const near = nearOnLeft ? -1 : 1;
  const side = (base: number, offset: number, sign: number): number => base + sign * offset;
  const bones: Bone[] = [
    { id: 'root', parent: null, joint: { x: 200, y: 580 } },
    { id: 'hips', parent: 'root', joint: { x: 200, y: 360 } },
    { id: 'chest', parent: 'hips', joint: { x: 200, y: 260 } },
    { id: 'neck', parent: 'chest', joint: { x: 200, y: 200 } },
    { id: 'head', parent: 'neck', joint: { x: 202, y: 190 } }
  ];
  for (const [name, sign] of [
    ['near', near],
    ['far', -near]
  ] as const) {
    bones.push(
      { id: `upper_arm_${name}`, parent: 'chest', joint: { x: side(200, 30, sign), y: 220 } },
      { id: `forearm_${name}`, parent: `upper_arm_${name}`, joint: { x: side(200, 34, sign), y: 290 } },
      { id: `hand_${name}`, parent: `forearm_${name}`, joint: { x: side(200, 36, sign), y: 350 } },
      { id: `thigh_${name}`, parent: 'hips', joint: { x: side(200, 16, sign), y: 370 } },
      { id: `shin_${name}`, parent: `thigh_${name}`, joint: { x: side(200, 18, sign), y: 470 } },
      { id: `foot_${name}`, parent: `shin_${name}`, joint: { x: side(200, 20, sign), y: 560 } }
    );
  }
  return {
    rigId: 'synthetic_rig',
    contractVersion: '0.2.0',
    space: { canvas: { width: 400, height: 600 }, yAxis: 'down', rigOrigin: { x: 200, y: 580 }, rigUnitsPerPx: 1, generationResolution: { width: 320, height: 480 } },
    view: 'three_quarter_right',
    sideNaming: 'near_far',
    tolerances: { jointErrorMaxPctHeight: 2.5, jointErrorMeanPctHeight: 1.5, segmentLengthRatio: [0.95, 1.05], zoneIoUMin: 0.85 },
    bones,
    slots: [
      { id: 'torso', bone: 'chest', drawOrder: 0, required: true, attachmentRect: { x: 160, y: 190, w: 80, h: 180 } },
      { id: 'head', bone: 'head', drawOrder: 1, required: true, attachmentRect: { x: 160, y: 80, w: 90, h: 120 } }
    ]
  };
}

export const bytesOf = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8');
export const temporaryDirectory = (): string => mkdtempSync(join(tmpdir(), 'aigg-control-'));

// A synthetic See-through run for the near-arm studies (L0-1e, L0-1f): a straight arm of simple shapes on a 240 x 360 frame.
const contractBytes = readFileSync(fileURLToPath(new URL('fixtures/c05-candidate/rig.contract.json', import.meta.url)));
const width = 240;
const height = 360;
const skin: Color = [230, 190, 160, 255];
const glove: Color = [40, 60, 150, 255];
const cloth: Color = [60, 60, 70, 255];

const shoulder = { x: 70, y: 60 };
const elbow = { x: 70, y: 140 };
const wrist = { x: 70, y: 220 };

function layersOf(): Map<string, Raster> {
  const handwear = new Raster(width, height);
  handwear.line(shoulder, elbow, 30, skin);
  handwear.line(elbow, wrist, 26, skin);
  handwear.line(wrist, { x: 70, y: 260 }, 24, glove);
  handwear.line({ x: 170, y: 60 }, { x: 170, y: 250 }, 24, skin);
  const topwear = new Raster(width, height);
  topwear.fillPolygon(
    [
      { x: 90, y: 50 },
      { x: 150, y: 50 },
      { x: 150, y: 200 },
      { x: 90, y: 200 }
    ],
    cloth
  );
  return new Map([
    ['topwear', topwear],
    ['handwear', handwear]
  ]);
}

const layers = layersOf();
const image = composite(width, height, [...layers.values()]);
const imageBytes = encodePng(image);
const metadataBytes = Buffer.from(
  JSON.stringify({
    parts: Object.fromEntries([...layers.keys()].map((tag, index) => [tag, { xyxy: [0, 0, width, height], tag, part_id: index, depth_median: 0.9 - index * 0.1 }])),
    frame_size: [width, height]
  })
);
const layerFiles = new Map([...layers].map(([tag, raster]) => [tag, { name: `${tag}.png`, bytes: encodePng(raster) }]));

function manual(points: Record<string, { x: number; y: number }>): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: landmarkFormat,
      markedBy: 'synthetic test',
      landmarks: Object.entries(points).map(([id, point]) => ({ id, visibility: 'visible', confidence: 'high', x: point.x, y: point.y, method: 'synthetic mark', note: 'synthetic' }))
    })
  );
}

const landmarkBytes = manual({ shoulder_image_left: shoulder, elbow_image_left: elbow, wrist_image_left: wrist });

function study(landmarks: Buffer, scale = 1.2, imageSha = sha256(imageBytes)): Buffer {
  return Buffer.from(
    JSON.stringify({
      inputs: { image: { sha256: imageSha }, manualLandmarks: sha256(landmarks) },
      alignment: [{ hypothesis: 'near_is_image_left', fits: [{ name: 'similarity', landmarkSet: 'confidence >= medium', scale: { s1: scale } }] }]
    })
  );
}

export const syntheticArm = { contractBytes, metadataBytes, layerFiles, imageBytes, landmarkBytes, manual, study, width, height, skin, glove, shoulder, elbow, wrist } as const;
