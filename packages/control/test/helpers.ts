import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
