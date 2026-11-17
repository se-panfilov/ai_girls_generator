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

// A fake Spine program for the CLI validation tests. It imitates the import (-r) and the export (-e json+pack) with files only.
// FAKE_SPINE_MODE: ok, fail-import, rotate (the export changes a rotation), drop-image (one image is not packed), step-constant (the
// export writes stepped on each interval with equal start and end values, as Spine 4.3.26 did), step-changing (stepped on a changing interval).
export const fakeSpine = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const get = (name) => args[args.indexOf(name) + 1];
const mode = process.env.FAKE_SPINE_MODE || 'ok';
if (args.includes('--import')) {
  if (mode === 'fail-import') { process.stderr.write('ERROR: Unable to import skeleton.'); process.exit(1); }
  fs.writeFileSync(get('--output'), JSON.stringify({ source: path.resolve(get('--input')), name: get('--import') }));
  process.stdout.write('Import complete.');
  process.exit(0);
}
if (args.includes('--export')) {
  const project = JSON.parse(fs.readFileSync(get('--input'), 'utf8'));
  const skeleton = JSON.parse(fs.readFileSync(project.source, 'utf8'));
  skeleton.skeleton.spine = '4.3.26';
  delete skeleton.skeleton.images;
  for (const bone of skeleton.bones) if (bone.y === 0) delete bone.y;
  for (const animation of Object.values(skeleton.animations)) for (const timeline of Object.values(animation.bones)) {
    timeline.rotate.forEach((key, i) => { const next = timeline.rotate[i + 1]; if (next && ((mode === 'step-constant' && next.value === key.value) || (mode === 'step-changing' && next.value !== key.value && i === 1))) key.curve = 'stepped'; });
    for (const key of timeline.rotate) { if (key.time === 0) delete key.time; if (key.value === 0) delete key.value; }
  }
  if (mode === 'rotate') skeleton.bones[2].rotation += 1;
  const out = get('--output');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, project.name + '.json'), JSON.stringify(skeleton));
  let names = fs.readdirSync(path.join(path.dirname(project.source), 'images')).map((n) => n.replace(/\\.png$/, '')).sort();
  if (mode === 'drop-image') names = names.filter((n) => n !== 'hand_near');
  fs.writeFileSync(path.join(out, project.name + '.atlas'), project.name + '.png\\nsize:256,256\\nfilter:Linear,Linear\\n' + names.map((n) => n + '\\nbounds:0,0,8,8').join('\\n') + '\\n');
  fs.writeFileSync(path.join(out, project.name + '.png'), '');
  process.exit(0);
}
process.exit(2);
`;

// A synthetic full-body See-through run for MVP-A (assemble-body): simple shapes on a 320 x 480 frame, near limbs on the image left.
// The upper thighs touch, so the legwear split needs the scan-row method and the nearest-label fill, as on the L0 concept.
function bodyLayers(): { layers: Map<string, Raster>; marks: Record<string, { x: number; y: number }> } {
  const w = 320;
  const h = 480;
  const marks = {
    head_top: { x: 160, y: 30 },
    neck_base: { x: 160, y: 112 },
    shoulder_image_left: { x: 128, y: 124 },
    sleeve_end_image_right: { x: 197, y: 150 },
    elbow_image_left: { x: 104, y: 190 },
    elbow_image_right: { x: 216, y: 190 },
    wrist_image_left: { x: 92, y: 250 },
    wrist_image_right: { x: 228, y: 250 },
    hip_image_left: { x: 150, y: 262 },
    hip_image_right: { x: 172, y: 262 },
    knee_image_left: { x: 140, y: 350 },
    knee_image_right: { x: 182, y: 350 },
    ankle_image_left: { x: 138, y: 428 },
    ankle_image_right: { x: 184, y: 428 },
    foot_anchor_image_left: { x: 122, y: 458 },
    foot_anchor_image_right: { x: 200, y: 458 }
  };
  const layer = (): Raster => new Raster(w, h);
  const hairBack = layer();
  hairBack.fillPolygon(
    [
      { x: 120, y: 40 },
      { x: 200, y: 40 },
      { x: 210, y: 170 },
      { x: 110, y: 170 }
    ],
    [90, 120, 40, 255]
  );
  const face = layer();
  face.fillCircle({ x: 160, y: 75 }, 32, [240, 200, 180, 255]);
  const eyes = layer();
  eyes.fillCircle({ x: 150, y: 72 }, 4, [40, 40, 40, 255]);
  eyes.fillCircle({ x: 172, y: 72 }, 4, [40, 40, 40, 255]);
  const hairFront = layer();
  hairFront.fillPolygon(
    [
      { x: 128, y: 40 },
      { x: 192, y: 40 },
      { x: 192, y: 56 },
      { x: 128, y: 56 }
    ],
    [110, 150, 50, 255]
  );
  const neck = layer();
  neck.fillPolygon(
    [
      { x: 152, y: 100 },
      { x: 168, y: 100 },
      { x: 168, y: 122 },
      { x: 152, y: 122 }
    ],
    [230, 190, 170, 255]
  );
  const topwear = layer();
  topwear.fillPolygon(
    [
      { x: 130, y: 115 },
      { x: 190, y: 115 },
      { x: 195, y: 240 },
      { x: 125, y: 240 }
    ],
    [240, 240, 245, 255]
  );
  topwear.line({ x: 128, y: 124 }, { x: 120, y: 150 }, 22, [240, 240, 245, 255]);
  topwear.line({ x: 192, y: 124 }, { x: 197, y: 150 }, 22, [240, 240, 245, 255]);
  const handwear = layer();
  for (const [s, e, wr, end] of [
    [marks.shoulder_image_left, marks.elbow_image_left, marks.wrist_image_left, { x: 88, y: 278 }],
    [{ x: 196, y: 126 }, marks.elbow_image_right, marks.wrist_image_right, { x: 232, y: 278 }]
  ] as const) {
    handwear.line(s, e, 16, [235, 195, 170, 255]);
    handwear.line(e, wr, 14, [235, 195, 170, 255]);
    handwear.line(wr, end, 14, [40, 60, 150, 255]);
  }
  const bottomwear = layer();
  bottomwear.fillPolygon(
    [
      { x: 125, y: 228 },
      { x: 195, y: 228 },
      { x: 212, y: 300 },
      { x: 108, y: 300 }
    ],
    [40, 40, 50, 255]
  );
  const legwear = layer();
  legwear.line({ x: 150, y: 240 }, marks.knee_image_left, 26, [30, 30, 35, 255]);
  legwear.line({ x: 172, y: 240 }, marks.knee_image_right, 26, [30, 30, 35, 255]);
  legwear.line(marks.knee_image_left, marks.ankle_image_left, 20, [30, 30, 35, 255]);
  legwear.line(marks.knee_image_right, marks.ankle_image_right, 20, [30, 30, 35, 255]);
  legwear.line(marks.ankle_image_left, { x: 132, y: 446 }, 16, [30, 30, 35, 255]);
  legwear.line(marks.ankle_image_right, { x: 190, y: 446 }, 16, [30, 30, 35, 255]);
  const footwear = layer();
  footwear.line({ x: 140, y: 420 }, marks.foot_anchor_image_left, 22, [200, 170, 60, 255]);
  footwear.line({ x: 182, y: 420 }, marks.foot_anchor_image_right, 22, [200, 170, 60, 255]);
  const objects = layer();
  objects.line({ x: 225, y: 290 }, { x: 300, y: 150 }, 8, [180, 180, 200, 255]);
  // See-through order (back to front): back hair, objects, legwear, footwear, topwear, bottomwear, neck, handwear, face, eyewhite, front hair.
  const layers = new Map<string, Raster>([
    ['back hair', hairBack],
    ['objects', objects],
    ['legwear', legwear],
    ['footwear', footwear],
    ['topwear', topwear],
    ['bottomwear', bottomwear],
    ['neck', neck],
    ['handwear', handwear],
    ['face', face],
    ['eyewhite', eyes],
    ['front hair', hairFront]
  ]);
  return { layers, marks };
}

const body = bodyLayers();
const bodyImageBytes = encodePng(composite(320, 480, [...body.layers.values()]));
const bodyMetadataBytes = Buffer.from(
  JSON.stringify({
    parts: Object.fromEntries([...body.layers.keys()].map((tag, index) => [tag, { xyxy: [0, 0, 320, 480], tag, part_id: index, depth_median: 0.95 - index * 0.05 }])),
    frame_size: [320, 480]
  })
);
const bodyLayerFiles = new Map([...body.layers].map(([tag, raster]) => [tag, { name: `${tag}.png`, bytes: encodePng(raster) }]));
const bodyLandmarkBytes = manual(body.marks);

export const syntheticBody = {
  contractBytes,
  metadataBytes: bodyMetadataBytes,
  metadataName: 'synthetic-body.psd.json',
  layerFiles: bodyLayerFiles,
  imageBytes: bodyImageBytes,
  landmarkBytes: bodyLandmarkBytes,
  studyBytes: study(bodyLandmarkBytes, 1.2, sha256(bodyImageBytes)),
  marks: body.marks,
  manual,
  study,
  width: 320,
  height: 480
} as const;
