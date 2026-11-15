import type { Affine } from '@control/align';
import { type CommandResult, json, sheetOf } from '@control/commands';
import type { Joint } from '@control/contract';
import { buildVariant, regionsOf, variantSpecs } from '@control/jointgeometry';
import { checker } from '@control/layersplit';
import { compose, crop, cross, evaluateRotations, type LimbStudyOptions, prepareLimb, rotationAbout, rotationTests, scaled, titled, transformPart } from '@control/limbstudy';
import type { PlannedFile } from '@control/output';
import { decodePng, encodePng, pixelHash, sha256 } from '@control/png';
import { type Color, Raster } from '@control/raster';
import {
  buildArmSkeleton,
  type Check,
  checkArmSkeleton,
  diagnosticAnimations,
  geometryTolerance,
  type ImageBox,
  partSlots,
  referenceSlot,
  regionImageAffine,
  skeletonBytes,
  skeletonFormat,
  spineDataVersion,
  spineDegrees,
  type SpineFrame,
  type SpineRegion,
  type SpineSkeleton,
  toImage,
  toSpine,
  type WorldBone,
  worldBones
} from '@control/spineskeleton';

// `spine-arm` (experiment M0-F0a, prototype): makes an import-ready Spine skeleton JSON and cropped region PNGs for the image-left (near)
// arm from the L0-1e cut and the L0-1g tube underlay, plus offline checks and previews. It does not run Spine. A package from this command
// is JSON_GENERATED only; CLI_VALIDATED needs `spine-validate` with a real Spine executable, and VISUALLY_VALIDATED needs the owner.

export const packageFormat = 'aigg.m0-f0a.package/0.1';
/** Transparent margin around the alpha bounds of each part, so that the filtered edge of a region is not cut. */
export const cropPaddingPx = 2;
export const skeletonFile = 'arm-spine.json';
export const variants = ['tube', 'baseline'] as const;
/** Largest deviation of a pose map (matrix entries and image px) from the reference map. The JSON values have 4 decimals. */
export const mapTolerance = 1e-3;
/** Largest share of arm pixels that can differ in a key pose: nearest-neighbor ties at pixel boundaries after 4-decimal rounding. */
export const pixelShare = 5e-4;

const countAlpha = (raster: Raster): number => {
  let n = 0;
  for (let p = 0; p < raster.width * raster.height; p += 1) if ((raster.data[p * 4 + 3] ?? 0) > 0) n += 1;
  return n;
};
export type Variant = (typeof variants)[number];

export type ArmPackageInput = {
  readonly width: number;
  readonly height: number;
  readonly joints: { readonly shoulder: Joint; readonly elbow: Joint; readonly wrist: Joint };
  /** Full-canvas part rasters (upper arm, forearm, hand) for each variant. */
  readonly parts: Readonly<Record<Variant, readonly [Raster, Raster, Raster]>>;
  /** Optional full-canvas source pose image for the hidden reference slot. */
  readonly reference?: Raster;
  readonly provenance: Record<string, unknown>;
  readonly toolVersion: string;
};

/** The alpha bounds of a raster (alpha > 0), or null when it is empty. */
export function alphaBounds(raster: Raster): ImageBox | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let p = 0; p < raster.width * raster.height; p += 1) {
    if ((raster.data[p * 4 + 3] ?? 0) === 0) continue;
    const x = p % raster.width;
    const y = (p - x) / raster.width;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + 1);
    bottom = Math.max(bottom, y + 1);
  }
  return left === Infinity ? null : { left, top, width: right - left, height: bottom - top };
}

/** The union of boxes plus a margin, inside the canvas. */
export function paddedUnion(boxes: readonly ImageBox[], pad: number, width: number, height: number): ImageBox {
  const left = Math.max(0, Math.min(...boxes.map((box) => box.left)) - pad);
  const top = Math.max(0, Math.min(...boxes.map((box) => box.top)) - pad);
  const right = Math.min(width, Math.max(...boxes.map((box) => box.left + box.width)) + pad);
  const bottom = Math.min(height, Math.max(...boxes.map((box) => box.top + box.height)) + pad);
  return { left, top, width: right - left, height: bottom - top };
}

export const cropBox = (raster: Raster, box: ImageBox): Raster => crop(raster, { left: box.left, top: box.top, right: box.left + box.width, bottom: box.top + box.height });

/** Puts a cropped raster back on an empty canvas at its box. Exact copy, no blend. */
export function uncrop(cropped: Raster, box: ImageBox, width: number, height: number): Raster {
  const out = new Raster(width, height);
  for (let y = 0; y < cropped.height; y += 1) out.data.set(cropped.data.subarray(y * cropped.width * 4, (y + 1) * cropped.width * 4), ((box.top + y) * width + box.left) * 4);
  return out;
}

/** Source-over of full-canvas layers in order on a transparent canvas (the straight-alpha blend of the L0-1e renderer). */
export function composeLayers(layers: readonly Raster[], width: number, height: number): Raster {
  const out = new Raster(width, height);
  for (const layer of layers) {
    for (let p = 0; p < width * height; p += 1) {
      const a = layer.data[p * 4 + 3] ?? 0;
      if (a === 0) continue;
      const x = p % width;
      out.blend(x, (p - x) / width, [layer.data[p * 4] ?? 0, layer.data[p * 4 + 1] ?? 0, layer.data[p * 4 + 2] ?? 0, a]);
    }
  }
  return out;
}

export function differentPixels(a: Raster, b: Raster): { pixels: number; max: number } {
  let pixels = 0;
  let max = 0;
  for (let p = 0; p < a.width * a.height; p += 1) {
    let d = 0;
    for (let c = 0; c < 4; c += 1) d = Math.max(d, Math.abs((a.data[p * 4 + c] ?? 0) - (b.data[p * 4 + c] ?? 0)));
    if (d === 0) continue;
    pixels += 1;
    max = Math.max(max, d);
  }
  return { pixels, max };
}

/** The pose of the diagnostic renderer of L0-1e: forearm about the elbow, hand about the wrist after the forearm turn (screen degrees). */
export function screenTransforms(elbow: Joint, wrist: Joint, elbowDegrees: number, wristDegrees: number): Affine[] {
  const identity: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  const fore = rotationAbout(elbow, elbowDegrees);
  return [identity, fore, compose(fore, rotationAbout(wrist, wristDegrees))];
}

/** The transforms that the skeleton JSON gives for rotate values (Spine degrees) on each bone, as image-space maps of the full-canvas parts. */
export function skeletonTransforms(skeleton: SpineSkeleton, frame: SpineFrame, boxes: readonly ImageBox[], delta: Readonly<Record<string, number>>): Affine[] {
  const world = worldBones(skeleton.bones, delta);
  const attachments = skeleton.skins[0]?.attachments ?? {};
  return partSlots.map((slot, index) => regionImageAffine(frame, world.get(slot) as WorldBone, attachments[slot]?.[slot] as SpineRegion, boxes[index] as ImageBox));
}

const near = (m: Affine, n: Affine): number => Math.max(Math.abs(m.a - n.a), Math.abs(m.b - n.b), Math.abs(m.c - n.c), Math.abs(m.d - n.d), Math.abs(m.tx - n.tx), Math.abs(m.ty - n.ty));
const r = (value: number, digits = 4): number => Math.round(value * 10 ** digits) / 10 ** digits;

type KeyPose = { readonly animation: string; readonly time: number; readonly elbow: number; readonly wrist: number };
/** Every distinct key pose of the test animations. */
export function keyPoses(): KeyPose[] {
  const poses: KeyPose[] = [];
  for (const animation of diagnosticAnimations) {
    for (const key of animation.keys) {
      if (poses.some((pose) => pose.elbow === key.elbow && pose.wrist === key.wrist)) continue;
      poses.push({ animation: animation.name, time: key.time, elbow: key.elbow, wrist: key.wrist });
    }
  }
  return poses;
}

const red: Color = [230, 0, 0, 255];
const blue: Color = [0, 90, 230, 255];
const green: Color = [0, 150, 60, 255];

function onChecker(source: Raster): Raster {
  const out = checker(source.width, source.height);
  out.draw(source, 0, 0);
  return out;
}

/** Assembles the package files and the offline checks from part rasters. Shared by the real command and the synthetic tests. */
export function assembleArmPackage(input: ArmPackageInput): { files: PlannedFile[]; checks: Check[]; geometry: Record<string, unknown>; skeleton: SpineSkeleton; status: 'PASS' | 'FAIL' } {
  const { width, height } = input;
  const frame: SpineFrame = { origin: { x: width / 2, y: height } };
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, status: ok ? 'PASS' : 'FAIL', detail });
  };

  // Crop boxes: the same box for a part in all variants, so that both packages share one skeleton JSON.
  const boxes = partSlots.map((slot, index) => {
    const bounds = variants.map((variant) => alphaBounds(input.parts[variant][index] as Raster)).filter((box): box is ImageBox => box !== null);
    if (bounds.length === 0) throw new RangeError(`The part ${slot} is empty.`);
    return paddedUnion(bounds, cropPaddingPx, width, height);
  }) as [ImageBox, ImageBox, ImageBox];
  const referenceBox = input.reference ? paddedUnion(boxes, 24, width, height) : undefined;

  // The hand bone points from the wrist to the centroid of the hand part (direction and length only; the pivot is the wrist mark).
  const hand = input.parts.tube[2];
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let p = 0; p < width * height; p += 1) {
    if ((hand.data[p * 4 + 3] ?? 0) === 0) continue;
    sx += (p % width) + 0.5;
    sy += Math.floor(p / width) + 0.5;
    n += 1;
  }
  const handEnd = { x: sx / n, y: sy / n };
  const rigInput = { frame, joints: { ...input.joints, handEnd }, parts: boxes, ...(referenceBox ? { reference: referenceBox } : {}) };
  const skeleton = buildArmSkeleton(rigInput);
  const bytes = skeletonBytes(skeleton);
  // The checks read the bytes back, as Spine would.
  checks.push(...checkArmSkeleton(JSON.parse(bytes.toString('utf8')) as unknown, rigInput));

  const files: PlannedFile[] = [];
  const addFile = (name: string, fileBytes: Buffer): void => {
    files.push({ name, bytes: fileBytes });
  };

  const variantReports: Record<string, unknown>[] = [];
  const decoded = new Map<Variant, Raster[]>();
  for (const variant of variants) {
    const dir = `spine/${variant}`;
    addFile(`${dir}/${skeletonFile}`, bytes);
    const full: Raster[] = [];
    const parts = partSlots.map((slot, index) => {
      const source = input.parts[variant][index] as Raster;
      const box = boxes[index] as ImageBox;
      const cropped = cropBox(source, box);
      const png = encodePng(cropped);
      addFile(`${dir}/images/${slot}.png`, png);
      // Crop preservation: the decoded PNG, put back at its box, is the same raster as the full-canvas part.
      const back = uncrop(decodePng(png).raster, box, width, height);
      full.push(back);
      return { slot, box, pixelSha256: pixelHash(cropped), fullCanvasPixelSha256: pixelHash(source), preserved: pixelHash(back) === pixelHash(source) };
    });
    add(
      `crop_preservation_${variant}`,
      parts.every((part) => part.preserved),
      'Each cropped PNG, decoded and put back at its box, equals the full-canvas part (pixel hash).'
    );
    if (input.reference && referenceBox) {
      const cropped = cropBox(input.reference, referenceBox);
      addFile(`${dir}/images/${referenceSlot}.png`, encodePng(cropped));
    }
    decoded.set(variant, full);

    // Setup pose through the skeleton: identity maps for all parts, and the same pixels as the direct composite.
    const setup = skeletonTransforms(skeleton, frame, boxes, {});
    const identity: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
    const setupError = Math.max(...setup.map((m) => near(m, identity)));
    const direct = composeLayers(full, width, height);
    const throughSkeleton = composeLayers(
      full.map((part, index) => transformPart(part, setup[index] as Affine)),
      width,
      height
    );
    const setupDifference = differentPixels(direct, throughSkeleton);
    add(
      `setup_pose_${variant}`,
      setupError < mapTolerance && setupDifference.pixels === 0,
      `Setup pose maps are the identity (max deviation ${setupError.toExponential(2)}); ${setupDifference.pixels} different pixels against the direct composite.`
    );

    // Key poses: skeleton JSON rotate values against the L0-1e diagnostic renderer with screen degrees.
    const poses = keyPoses().map((pose) => {
      const delta = { forearm_near: spineDegrees(pose.elbow), hand_near: spineDegrees(pose.wrist) };
      const fromSkeleton = skeletonTransforms(skeleton, frame, boxes, delta);
      const fromScreen = screenTransforms(input.joints.elbow, input.joints.wrist, pose.elbow, pose.wrist);
      const mapError = Math.max(...fromSkeleton.map((m, index) => near(m, fromScreen[index] as Affine)));
      const a = composeLayers(
        full.map((part, index) => transformPart(part, fromSkeleton[index] as Affine)),
        width,
        height
      );
      const b = composeLayers(
        full.map((part, index) => transformPart(part, fromScreen[index] as Affine)),
        width,
        height
      );
      const world = worldBones(skeleton.bones, delta);
      const wristWorld = toImage(frame, world.get('hand_near') as WorldBone);
      const screenWrist = fromScreen[1] as Affine;
      const expectedWrist = {
        x: screenWrist.a * input.joints.wrist.x + screenWrist.b * input.joints.wrist.y + screenWrist.tx,
        y: screenWrist.c * input.joints.wrist.x + screenWrist.d * input.joints.wrist.y + screenWrist.ty
      };
      return {
        ...pose,
        spineValues: delta,
        maxMapDeviation: mapError,
        differentPixelsAgainstScreenRenderer: differentPixels(a, b).pixels,
        wristPivotImagePx: { x: r(wristWorld.x), y: r(wristWorld.y) },
        wristPivotErrorPx: Math.hypot(wristWorld.x - expectedWrist.x, wristWorld.y - expectedWrist.y),
        frame: a
      };
    });
    const armPixels = full.reduce((sum, part) => sum + countAlpha(part), 0);
    const pixelLimit = Math.ceil(armPixels * pixelShare);
    const worstMap = Math.max(...poses.map((pose) => pose.maxMapDeviation));
    const worstPixels = Math.max(...poses.map((pose) => pose.differentPixelsAgainstScreenRenderer));
    const worstPivot = Math.max(...poses.map((pose) => pose.wristPivotErrorPx));
    add(
      `key_poses_${variant}`,
      worstMap < mapTolerance && worstPixels <= pixelLimit && worstPivot < geometryTolerance,
      `Skeleton rotate values reproduce the L0-1e screen rotations: map deviation ${worstMap.toExponential(2)} (limit ${mapTolerance}), at most ${worstPixels} different pixels per pose (limit ${pixelLimit}, ${armPixels} arm pixels; nearest-neighbor ties from the 4-decimal JSON values), wrist pivot error ${worstPivot.toExponential(2)} px.`
    );
    variantReports.push({
      variant,
      directory: dir,
      parts: parts.map(({ slot, box, pixelSha256, fullCanvasPixelSha256 }) => ({ slot, box, pixelSha256, fullCanvasPixelSha256 })),
      keyPoses: poses.map(({ frame: _frame, ...rest }) => ({
        ...rest,
        maxMapDeviation: Number(rest.maxMapDeviation.toExponential(3)),
        wristPivotErrorPx: Number(rest.wristPivotErrorPx.toExponential(3))
      }))
    });

    // Preview: setup pose and key poses, arm only, on transparency (checker), with the joint marks.
    const view = paddedUnion(boxes, 40, width, height);
    const cells = [
      { label: 'setup pose', raster: throughSkeleton, pose: { elbow: 0, wrist: 0 } },
      ...poses.filter((pose) => pose.elbow !== 0 || pose.wrist !== 0).map((pose) => ({ label: `e ${pose.elbow} w ${pose.wrist}`, raster: pose.frame, pose }))
    ].map((cell) => {
      const image = onChecker(cropBox(cell.raster, view));
      const world = worldBones(skeleton.bones, { forearm_near: spineDegrees(cell.pose.elbow), hand_near: spineDegrees(cell.pose.wrist) });
      const marks: [string, Color][] = [
        ['upper_arm_near', red],
        ['forearm_near', blue],
        ['hand_near', green]
      ];
      for (const [bone, color] of marks) {
        const at = toImage(frame, world.get(bone) as WorldBone);
        cross(image, { x: at.x - view.left, y: at.y - view.top }, color, 5);
      }
      return titled(scaled(image, 2), cell.label);
    });
    const preview = titled(sheetOf([cells.slice(0, 5), cells.slice(5)], 10), `M0-F0a ${variant}: skeleton JSON poses (local nearest-neighbor renderer, not Spine)`, [
      'screen degrees, positive = clockwise; crosses: shoulder (red), elbow (blue), wrist (green)'
    ]);
    addFile(`evidence/preview-${variant}.png`, encodePng(preview));
  }

  // Both variants share one skeleton JSON.
  const jsons = files.filter((file) => file.name.endsWith(`/${skeletonFile}`)).map((file) => sha256(file.bytes));
  add('shared_skeleton', new Set(jsons).size === 1, 'The tube and baseline packages have the same skeleton JSON bytes; only the PNGs differ.');

  // Neutral preview with the source pose for comparison.
  if (input.reference) {
    const view = paddedUnion(boxes, 40, width, height);
    const tubeSetup = composeLayers(decoded.get('tube') ?? [], width, height);
    const baseSetup = composeLayers(decoded.get('baseline') ?? [], width, height);
    const cells = [
      titled(scaled(onChecker(cropBox(input.reference, view)), 2), 'source pose (layer composite)'),
      titled(scaled(onChecker(cropBox(baseSetup, view)), 2), 'baseline setup pose'),
      titled(scaled(onChecker(cropBox(tubeSetup, view)), 2), 'tube setup pose')
    ];
    const neutral = titled(sheetOf([cells], 10), 'M0-F0a neutral pose from the package PNGs and offsets');
    addFile('evidence/preview-neutral.png', encodePng(neutral));
  }

  const world = worldBones(skeleton.bones);
  const geometry = {
    format: skeletonFormat,
    prototype: true,
    note: 'Experiment M0-F0a. Region boxes, pivots, and angles are research values, not a change of the C0.5 rig contract.',
    spineDataVersion,
    coordinates: {
      image: 'Origin at the top-left corner of the source canvas, x right, y down, 1 unit = 1 px. Pixel (i, j) covers [i, i+1) x [j, j+1).',
      spine: 'Origin (root bone) at the bottom center of the source canvas, x right, y up. Spine x = image x - origin x; Spine y = origin y - image y.',
      origin: frame.origin,
      canvas: { width, height },
      unitsPerImagePx: 1,
      rotation: 'Spine bone and attachment rotation in degrees, counterclockwise. Test angles are given in screen degrees (clockwise, L0-1e convention); Spine rotate value = -screen degrees.',
      attachmentOffset: 'Region x, y = the image-box center in the bone frame; region rotation = -(bone world rotation), so the image stays upright in the setup pose.'
    },
    joints: (['shoulder', 'elbow', 'wrist'] as const).map((id) => ({ id, imagePx: input.joints[id], spine: toSpine(frame, input.joints[id]) })),
    handBoneEnd: { imagePx: { x: r(handEnd.x), y: r(handEnd.y) }, rule: 'centroid of the tube hand part; sets only the hand bone direction and length' },
    bones: skeleton.bones.map((bone) => ({ ...bone, world: (({ x, y, rotation }) => ({ x: r(x), y: r(y), rotation: r(rotation) }))(world.get(bone.name) as WorldBone) })),
    drawOrder: skeleton.slots.map((slot) => slot.name),
    attachments: skeleton.slots.map((slot) => ({
      slot: slot.name,
      bone: slot.bone,
      setupVisible: slot.attachment !== undefined,
      imageBox: slot.name === referenceSlot ? referenceBox : boxes[partSlots.indexOf(slot.name as (typeof partSlots)[number])],
      region: skeleton.skins[0]?.attachments[slot.name]?.[slot.name]
    })),
    cropPaddingPx,
    animations: diagnosticAnimations.map((animation) => ({
      name: animation.name,
      keys: animation.keys.map((key) => ({
        time: key.time,
        elbowScreenDegrees: key.elbow,
        wristScreenDegrees: key.wrist,
        forearmSpineValue: spineDegrees(key.elbow),
        handSpineValue: spineDegrees(key.wrist)
      })),
      curve: 'linear (Spine default)',
      note: 'Diagnostic values from L0-1e and L0-1g. Not animation limits.'
    })),
    variants: variantReports,
    provenance: input.provenance
  };
  const status = checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL';
  addFile('evidence/geometry.json', json(geometry));
  return { files, checks, geometry, skeleton, status };
}

/** SHA-256 of the bytes and of the decoded pixels (for PNG files; the project storage can re-encode PNG files). */
export function manifests(files: readonly PlannedFile[]): PlannedFile[] {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const bytes = sorted.map((file) => `${sha256(file.bytes)}  ${file.name}`).join('\n');
  const pixels = sorted
    .filter((file) => file.name.endsWith('.png'))
    .map((file) => `${pixelHash(decodePng(file.bytes).raster)}  ${file.name}`)
    .join('\n');
  return [
    { name: 'SHA256SUMS', bytes: Buffer.from(`${bytes}\n`, 'utf8') },
    { name: 'PIXEL-SHA256SUMS', bytes: Buffer.from(`${pixels}\n`, 'utf8') }
  ];
}

export function packageReadme(): Buffer {
  const text = `# M0-F0a near arm Spine package

Prototype of experiment M0-F0a. Not a production character package. Status: JSON_GENERATED (offline checks only).
The package is not checked in Spine until \`spine-validate\` runs the real Spine executable (CLI_VALIDATED) and the owner looks at it in the Spine editor (VISUALLY_VALIDATED).

## Contents

- \`spine/tube/${skeletonFile}\` and \`spine/tube/images/\`: the main test. The parent parts have the deterministic L0-1g tube underlay (method B).
- \`spine/baseline/${skeletonFile}\` and \`spine/baseline/images/\`: the same skeleton JSON with the L0-1e parts (no underlay).
- \`evidence/geometry.json\`: coordinate frame, joint marks, bones, attachments, draw order, animations, provenance.
- \`evidence/validation.json\`: offline checks.
- \`evidence/preview-*.png\`: local renderer previews (nearest-neighbor, not Spine).
- \`SHA256SUMS\` (bytes) and \`PIXEL-SHA256SUMS\` (decoded pixels; storage can re-encode PNG files).

Skeleton: root > upper_arm_near > forearm_near > hand_near. Slots back to front: ${referenceSlot} (hidden, no setup attachment), upper_arm_near, forearm_near, hand_near.
Animations: ${diagnosticAnimations.map((item) => item.name).join(', ')}. Linear keys. The angles are diagnostic values, not limits.
Only Spine Essential features: bones, slots, region attachments, draw order, rotate keys.

## Spine CLI validation (no GUI)

From the repository root, after \`npm ci --ignore-scripts\` and \`npm run build --workspace @aigg/control\`:

\`\`\`sh
node packages/control/dist/src/cli.js spine-validate --spine /Applications/Spine.app/Contents/MacOS/Spine --package <this folder> --out <new folder>
\`\`\`

The command imports each \`${skeletonFile}\` into a new \`.spine\` project with the Spine CLI, exports the project to JSON with a texture atlas, compares the export with the intended skeleton, and writes \`cli-validation.json\` and all logs.

## Optional look in the Spine editor

Open the \`.spine\` project that \`spine-validate\` made, or use Spine > Import Data with \`spine/tube/${skeletonFile}\` and New project checked. Check the Images node path (\`./images/\` next to the JSON).

The images are derivatives of a licensed test concept. Keep them local. Do not commit them to Git.
`;
  return Buffer.from(text, 'utf8');
}

/** `spine-arm`: experiment M0-F0a for the image-left (near) arm of the L0 test concept. */
export function spineArmCommand(options: LimbStudyOptions): CommandResult {
  const context = prepareLimb(options);
  const tubeSpec = variantSpecs.find((item) => item.id === 'tube_B');
  if (!tubeSpec) throw new Error('The tube_B variant is missing.');
  const regions = regionsOf(context);
  const tube = buildVariant(context, regions, tubeSpec);
  if (tube.changedSource !== 0 || tube.outsideRegion !== 0) throw new Error('The tube underlay changed source pixels.');
  const parts = {
    baseline: context.parts as unknown as readonly [Raster, Raster, Raster],
    tube: tube.parts as unknown as readonly [Raster, Raster, Raster]
  };
  const provenance = {
    tool: { name: '@aigg/control', version: options.toolVersion, command: 'spine-arm' },
    inputs: { imageSha256: context.imageSha, manualLandmarksSha256: context.landmarkSha, similarityScaleImageToTemplate: context.scale, layers: context.inputs },
    jointMarks: context.marks.map((mark) => ({ id: mark.id, point: mark.point })),
    cut: 'L0-1e cutArm at the manual marks (no change).',
    underlay: {
      tube: 'L0-1g region C (tube) with fill method B (directional), full region (not occlusion-safe). New pixels are tagged generated_by_deterministic_extension.',
      newPixels: tube.fills.map((fill, index) => ({ joint: context.specs[index]?.id, newPixels: fill.counts.newPixels }))
    },
    residual: 'The L0-1e residual pixels (fragments not connected to the arm) are not in any attachment.',
    reference: 'The hidden reference slot shows the source pose: the layer composite of all See-through layers, cropped around the arm.'
  };
  const assembled = assembleArmPackage({
    width: context.width,
    height: context.height,
    joints: { shoulder: context.shoulder, elbow: context.elbow, wrist: context.wrist },
    parts,
    reference: context.reference,
    provenance,
    toolVersion: options.toolVersion
  });

  // The package parts, put back on the body with the L0-1e renderer, give the L0-1g source pose result.
  const checks = [...assembled.checks];
  const sourcePose: Record<string, { differentPixels: number; maxChannelDifference: number }> = {};
  for (const variant of variants) {
    const full = partSlots.map((slot) => {
      const file = assembled.files.find((item) => item.name === `spine/${variant}/images/${slot}.png`);
      const box = (assembled.geometry.attachments as { slot: string; imageBox: ImageBox }[]).find((item) => item.slot === slot)?.imageBox as ImageBox;
      return uncrop(decodePng(file?.bytes ?? Buffer.alloc(0)).raster, box, context.width, context.height);
    });
    const fromPackage = evaluateRotations(context, full, [rotationTests[0] as (typeof rotationTests)[number]]).sourceFrame;
    const fromStudy = evaluateRotations(context, parts[variant], [rotationTests[0] as (typeof rotationTests)[number]]).sourceFrame;
    const difference = differentPixels(fromPackage, context.reference);
    sourcePose[variant] = { differentPixels: difference.pixels, maxChannelDifference: difference.max };
    const same = differentPixels(fromPackage, fromStudy).pixels === 0;
    checks.push({
      id: `source_pose_${variant}`,
      status: same && (variant === 'tube' || difference.pixels === 0) ? 'PASS' : 'FAIL',
      detail: `On the body: ${difference.pixels} pixels differ from the source pose (max ${difference.max}); the package gives ${same ? 'the same' : 'another'} frame as the L0-1g parts.${variant === 'tube' ? ' The tube difference is the known L0-1g effect (underlay under soft child edges).' : ''}`
    });
  }
  const status = checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL';
  const validation = {
    format: packageFormat,
    prototype: true,
    levels: { JSON_GENERATED: status, CLI_VALIDATED: 'NOT_RUN', VISUALLY_VALIDATED: 'NOT_RUN' },
    spineImport: 'SPINE_IMPORT_UNVERIFIED',
    note: 'Offline checks with the local TypeScript model of the Spine JSON. They do not replace a Spine CLI import and export or a look in the Spine editor.',
    checks,
    sourcePose
  };
  const files = [...assembled.files, { name: 'evidence/validation.json', bytes: json(validation) }, { name: 'README.md', bytes: packageReadme() }];
  const all = [...files, ...manifests(files)];
  return {
    report: {
      format: packageFormat,
      status,
      levels: validation.levels,
      spineImport: validation.spineImport,
      checks: checks.map((check) => ({ id: check.id, status: check.status })),
      sourcePose,
      files: all.length
    },
    files: all
  };
}
