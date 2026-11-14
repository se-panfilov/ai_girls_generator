import { type Affine, applyAffine, decompose, fitSimilarity } from '@control/align';
import { landmarkFormat, landmarkIds } from '@control/alignstudy';
import { type CommandResult, type FileRecord, json, record, sheetOf } from '@control/commands';
import type { Joint } from '@control/contract';
import { drawText } from '@control/glyphs';
import { half, layerPngLimits } from '@control/layersplit';
import type { PlannedFile } from '@control/output';
import { decodePng, encodePng, sha256 } from '@control/png';
import { fail, isRecord } from '@control/problems';
import { type Color, Raster } from '@control/raster';

// `compare-landmarks` (experiment L0-1d, prototype): compares two align-study runs, for example automatic landmarks (before) and manual landmarks (after).
// It reads the landmarks.json and correspondence.json files of both runs and the input image. It does not run a new alignment:
// the similarity fit uses the same pairs and the same confidence rule (medium or more, near = image-left) as align-study.
// It does not change or warp the art. The images are diagnostics.

export const compareFormat = 'aigg.l0-1d.compare-landmarks/0.1';

type Box = { left: number; top: number; right: number; bottom: number };
export type RunLandmark = { id: string; point: Joint | null; range: Box | null; visibility: string; confidence: string; origin: string };
export type RunPair = { id: string; character: Joint; templatePoint: Joint; confidence: string };
export type Run = { frame: { width: number; height: number }; landmarks: RunLandmark[]; pairs: RunPair[]; bodyHeight: number };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function parseJson(bytes: Buffer, label: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('E_INPUT', `${label} is not valid JSON.`);
  }
  return value;
}

/** Reads one align-study run (landmarks.json and correspondence.json) with run-time checks of the used fields. */
export function parseRun(landmarkBytes: Buffer, correspondenceBytes: Buffer, label: string): Run {
  const landmarks = parseJson(landmarkBytes, `${label} landmarks`);
  const study = parseJson(correspondenceBytes, `${label} correspondence`);
  if (!isRecord(landmarks) || landmarks.format !== landmarkFormat || !isRecord(landmarks.frame) || !Array.isArray(landmarks.landmarks)) fail('E_INPUT', `${label}: not an align-study landmarks.json.`);
  const { width, height } = landmarks.frame;
  if (!finite(width) || !finite(height) || width < 1 || height < 1 || width > 2048 || height > 2048) fail('E_INPUT', `${label}: the frame is not valid.`);
  const inFrame = (p: unknown): p is Joint => isRecord(p) && finite(p.x) && finite(p.y) && p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height;
  const box = (r: unknown): Box | null =>
    isRecord(r) && inFrame({ x: r.left, y: r.top }) && inFrame({ x: r.right, y: r.bottom })
      ? { left: r.left as number, top: r.top as number, right: r.right as number, bottom: r.bottom as number }
      : null;
  const items = landmarks.landmarks.map((item: unknown): RunLandmark => {
    if (!isRecord(item) || typeof item.id !== 'string' || !(landmarkIds as readonly string[]).includes(item.id)) fail('E_INPUT', `${label}: unknown landmark id.`);
    const point = item.point === null ? null : inFrame(item.point) ? { x: item.point.x, y: item.point.y } : fail('E_INPUT', `${label}: ${item.id} point is not valid.`);
    return { id: item.id, point, range: box(item.range), visibility: String(item.visibility), confidence: String(item.confidence), origin: item.origin === 'manual' ? 'manual' : 'automatic' };
  });
  if (!isRecord(study) || !isRecord(study.template) || !finite(study.template.bodyHeightPx) || study.template.bodyHeightPx <= 0 || !Array.isArray(study.alignment))
    fail('E_INPUT', `${label}: not an align-study correspondence.json.`);
  const nearLeft: unknown = (study.alignment as unknown[]).find((item: unknown) => isRecord(item) && item.hypothesis === 'near_is_image_left');
  if (!isRecord(nearLeft) || !Array.isArray(nearLeft.pairs)) fail('E_INPUT', `${label}: the near_is_image_left alignment is missing.`);
  const pairs = nearLeft.pairs.map((item: unknown): RunPair => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !isRecord(item.character) ||
      !isRecord(item.templatePoint) ||
      !finite(item.character.x) ||
      !finite(item.character.y) ||
      !finite(item.templatePoint.x) ||
      !finite(item.templatePoint.y)
    )
      fail('E_INPUT', `${label}: a pair is not valid.`);
    return { id: item.id, character: { x: item.character.x, y: item.character.y }, templatePoint: { x: item.templatePoint.x, y: item.templatePoint.y }, confidence: String(item.confidence) };
  });
  return { frame: { width, height }, landmarks: items, pairs, bodyHeight: study.template.bodyHeightPx };
}

const strong = (pair: RunPair): boolean => pair.confidence === 'high' || pair.confidence === 'medium';
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

function invert(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, tx: -(a * m.tx + b * m.ty), ty: -(c * m.tx + d * m.ty) };
}

/** Similarity fit on the medium-or-more pairs and the residual of each pair (also the pairs outside the fit). */
export function similarityOf(run: Run, ids?: readonly string[]): { fit: Affine; ids: string[]; residuals: Map<string, number>; mean: number; max: number } | null {
  const used = run.pairs.filter((pair) => (ids ? ids.includes(pair.id) : strong(pair)));
  const fit = fitSimilarity(
    used.map((pair) => pair.character),
    used.map((pair) => pair.templatePoint)
  );
  if (!fit) return null;
  const residuals = new Map<string, number>();
  for (const pair of run.pairs) {
    const q = applyAffine(fit, pair.character);
    residuals.set(pair.id, round3((Math.hypot(q.x - pair.templatePoint.x, q.y - pair.templatePoint.y) / run.bodyHeight) * 100));
  }
  const inFit = used.map((pair) => residuals.get(pair.id) ?? 0);
  return { fit, ids: used.map((pair) => pair.id), residuals, mean: round3(inFit.reduce((s, v) => s + v, 0) / inFit.length), max: round3(Math.max(...inFit)) };
}

const blue: Color = [30, 110, 230, 255];
const orange: Color = [230, 110, 20, 255];
const green: Color = [20, 150, 60, 255];
const sideColor = (id: string): Color => (id.endsWith('image_left') ? blue : id.endsWith('image_right') ? orange : green);
const black: Color = [0, 0, 0, 255];
const label = (raster: Raster, text: string, at: Joint): void => {
  drawText(raster, text, at.x + 8, at.y - 4, 1, black, [255, 255, 255, 200]);
};

function faded(image: Raster, opacity: number): Raster {
  const out = new Raster(image.width, image.height, [255, 255, 255, 255]);
  out.draw(image, 0, 0, opacity);
  return out;
}

function square(raster: Raster, at: Joint, size: number, color: Color): void {
  raster.strokeRect(at.x - size, at.y - size, size * 2, size * 2, 2, color);
}

function arrow(raster: Raster, from: Joint, to: Joint, color: Color): void {
  raster.line(from, to, 2, color);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  for (const turn of [2.6, -2.6]) raster.line(to, { x: to.x + Math.cos(angle + turn) * 8, y: to.y + Math.sin(angle + turn) * 8 }, 2, color);
}

function legend(raster: Raster, lines: readonly string[]): void {
  lines.forEach((line, index) => {
    drawText(raster, line, 12, 12 + index * 20, 2, black, [255, 255, 255, 230]);
  });
}

function dashed(raster: Raster, r: Box, color: Color): void {
  const edges: [Joint, Joint][] = [
    [
      { x: r.left, y: r.top },
      { x: r.right, y: r.top }
    ],
    [
      { x: r.right, y: r.top },
      { x: r.right, y: r.bottom }
    ],
    [
      { x: r.right, y: r.bottom },
      { x: r.left, y: r.bottom }
    ],
    [
      { x: r.left, y: r.bottom },
      { x: r.left, y: r.top }
    ]
  ];
  for (const [a, b] of edges) {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    for (let t = 0; t < length; t += 12) {
      const u = t / length;
      const v = Math.min(1, (t + 6) / length);
      raster.line({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }, { x: a.x + (b.x - a.x) * v, y: a.y + (b.y - a.y) * v }, 2, color);
    }
  }
}

/** Template joints mapped into the image by the inverse fit, with a line from each character landmark to its template joint. */
function alignmentPanel(image: Raster, run: Run, fitted: NonNullable<ReturnType<typeof similarityOf>>, title: string): Raster {
  const panel = faded(image, 0.35);
  const inverse = invert(fitted.fit);
  for (const pair of run.pairs) {
    const mapped = applyAffine(inverse, pair.templatePoint);
    const inFit = fitted.ids.includes(pair.id);
    panel.line(pair.character, mapped, 2, inFit ? [200, 0, 0, 255] : [200, 0, 0, 120]);
    panel.fillCircle(mapped, 5, [120, 0, 160, 255]);
    panel.fillCircle(pair.character, 5, sideColor(pair.id));
    label(
      panel,
      `${pair.id.replace('_image_left', ' l').replace('_image_right', ' r').replace(/_/g, ' ')} ${(fitted.residuals.get(pair.id) ?? 0).toFixed(1)}%${inFit ? '' : ' (not in fit)'}`,
      pair.character
    );
  }
  legend(panel, [title, `similarity fit on ${fitted.ids.length} landmarks (medium+): mean ${fitted.mean}%, max ${fitted.max}%`, 'purple = c0.5 joint, colored = character, red = error']);
  return panel;
}

export type CompareOptions = {
  readonly imageBytes: Buffer;
  readonly before: { readonly landmarks: Buffer; readonly correspondence: Buffer };
  readonly after: { readonly landmarks: Buffer; readonly correspondence: Buffer };
  readonly toolVersion: string;
};

export function compareLandmarksCommand(options: CompareOptions): CommandResult {
  const before = parseRun(options.before.landmarks, options.before.correspondence, 'before');
  const after = parseRun(options.after.landmarks, options.after.correspondence, 'after');
  if (before.frame.width !== after.frame.width || before.frame.height !== after.frame.height || before.bodyHeight !== after.bodyHeight)
    fail('E_INPUT', 'The two runs do not have the same frame and template.');
  const image = decodePng(options.imageBytes, layerPngLimits).raster;
  if (image.width !== before.frame.width || image.height !== before.frame.height) fail('E_IMAGE', 'The image does not have the frame size.');
  const fitBefore = similarityOf(before);
  const fitAfter = similarityOf(after);
  if (!fitBefore || !fitAfter) fail('E_INPUT', 'A run has too few landmarks for a similarity fit.');
  const common = fitBefore.ids.filter((id) => after.pairs.some((pair) => pair.id === id));
  const fitCommon = similarityOf(after, common);

  const byId = (run: Run): Map<string, RunLandmark> => new Map(run.landmarks.map((item) => [item.id, item]));
  const was = byId(before);
  const now = byId(after);
  const rows = landmarkIds.map((id) => {
    const a = was.get(id);
    const b = now.get(id);
    const shift = a?.point && b?.point ? round3(Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y)) : null;
    const insideBeforeRange = a?.range && b?.point ? b.point.x >= a.range.left && b.point.x <= a.range.right && b.point.y >= a.range.top && b.point.y <= a.range.bottom : null;
    return {
      id,
      before: a ? { visibility: a.visibility, confidence: a.confidence, point: a.point, origin: a.origin } : null,
      after: b ? { visibility: b.visibility, confidence: b.confidence, point: b.point, range: b.range, origin: b.origin } : null,
      shiftPx: shift,
      afterPointInsideBeforeRange: insideBeforeRange,
      residualBeforePct: fitBefore.residuals.get(id) ?? null,
      residualAfterPct: fitAfter.residuals.get(id) ?? null
    };
  });

  const files: PlannedFile[] = [];
  const records: FileRecord[] = [];
  const png = (name: string, raster: Raster): void => {
    const file = { name, bytes: encodePng(raster) };
    files.push(file);
    records.push(record(file, raster));
  };

  // Before and after landmarks: circle = before, square = after, arrow = shift.
  const overlay = faded(image, 0.5);
  for (const row of rows) {
    const color = sideColor(row.id);
    const a = row.before?.point ?? null;
    const b = row.after?.point ?? null;
    if (row.after?.range) dashed(overlay, row.after.range, [122, 0, 180, 255]);
    if (a) overlay.fillCircle(a, 5, color);
    if (b) square(overlay, b, 7, color);
    if (a && b && (row.shiftPx ?? 0) > 3) arrow(overlay, a, b, [200, 0, 0, 255]);
    const at = b ?? a ?? (row.after?.range ? { x: row.after.range.left, y: row.after.range.top } : null);
    if (at)
      label(
        overlay,
        `${row.id.replace('_image_left', ' l').replace('_image_right', ' r').replace(/_/g, ' ')} ${row.after ? `${row.after.visibility.charAt(0)}/${row.after.confidence.charAt(0)}` : ''}`,
        at
      );
  }
  legend(overlay, ['before (dot, automatic l0-1c) and after (square, manual l0-1d)', 'red arrow = shift, purple dashed box = manual range', 'letters: visibility / confidence after review']);
  png('before-after-landmarks.png', overlay);

  // Alignment before and after.
  const panelBefore = alignmentPanel(image, before, fitBefore, 'before: automatic landmarks');
  const panelAfter = alignmentPanel(image, after, fitAfter, 'after: manual landmarks');
  png('alignment-before-after.png', sheetOf([[panelBefore, panelAfter]], 16));

  // Error vectors after review: the image-space vector from the character landmark to the fitted template joint, times 3.
  const vectors = faded(image, 0.35);
  const inverse = invert(fitAfter.fit);
  for (const pair of after.pairs) {
    const mapped = applyAffine(inverse, pair.templatePoint);
    const end = { x: pair.character.x + (mapped.x - pair.character.x) * 3, y: pair.character.y + (mapped.y - pair.character.y) * 3 };
    arrow(vectors, pair.character, end, fitAfter.ids.includes(pair.id) ? [200, 0, 0, 255] : [200, 0, 0, 120]);
    vectors.fillCircle(pair.character, 5, sideColor(pair.id));
    label(vectors, `${(fitAfter.residuals.get(pair.id) ?? 0).toFixed(1)}%`, pair.character);
  }
  legend(vectors, [
    'per-joint error vectors after manual review (x3)',
    'arrow: from the character landmark toward the fitted c0.5 joint',
    'pose differences and proportion differences both show here'
  ]);
  png('error-vectors.png', vectors);
  png(
    'contact-sheet.png',
    sheetOf(
      [
        [half(overlay), half(vectors)],
        [half(panelBefore), half(panelAfter)]
      ],
      8
    )
  );

  const scale = (fit: Affine): number => round3(decompose(fit).s1);
  const report = {
    format: compareFormat,
    tool: { version: options.toolVersion, command: 'compare-landmarks' },
    prototype: true,
    note: 'Similarity fit on medium-or-more pairs, near = image-left, residuals in % of the template body height. Manual marks are human judgments, not ground truth.',
    inputs: {
      image: sha256(options.imageBytes),
      before: { landmarks: sha256(options.before.landmarks), correspondence: sha256(options.before.correspondence) },
      after: { landmarks: sha256(options.after.landmarks), correspondence: sha256(options.after.correspondence) }
    },
    fits: {
      before: { landmarks: fitBefore.ids.length, mean: fitBefore.mean, max: fitBefore.max, scale: scale(fitBefore.fit) },
      after: { landmarks: fitAfter.ids.length, mean: fitAfter.mean, max: fitAfter.max, scale: scale(fitAfter.fit) },
      afterOnBeforeLandmarkSet: fitCommon ? { landmarks: fitCommon.ids.length, mean: fitCommon.mean, max: fitCommon.max } : null
    },
    counts: Object.fromEntries(
      (['before', 'after'] as const).map((key) => {
        const run = key === 'before' ? before : after;
        return [
          key,
          {
            highOrMedium: run.landmarks.filter((item) => item.confidence === 'high' || item.confidence === 'medium').length,
            unknown: run.landmarks.filter((item) => item.visibility === 'unknown').length,
            manual: run.landmarks.filter((item) => item.origin === 'manual').length
          }
        ];
      })
    ),
    landmarks: rows,
    files: records
  };
  files.push({ name: 'comparison.json', bytes: json(report) });
  return { report: { format: compareFormat, status: 'PASS', fits: report.fits, counts: report.counts, files: files.length }, files };
}
