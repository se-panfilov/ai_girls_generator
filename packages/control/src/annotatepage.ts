import { landmarkFormat, landmarkIds, maxLandmarkBytes, parseManualLandmarks } from '@control/alignstudy';
import type { AutomaticLandmark, Entry, PagePayload } from '@control/annotator';
import type { CommandResult } from '@control/commands';
import { layerPngLimits } from '@control/layersplit';
import { decodePng, sha256 } from '@control/png';
import { fail, isRecord } from '@control/problems';

// `annotate-page` (experiment L0-1d, prototype): one self-contained HTML file for manual landmark marks.
// The file holds the image (data URL), the automatic L0-1c landmarks, an optional earlier manual file, and the compiled page code.
// It needs no server and no network. The export is the L0-1c manual landmark format. The input files are only read.

export const annotateFormat = 'aigg.l0-1d.annotate-page/0.1';

/** Landmarks for the first manual pass (L0-1c: unknown or low confidence). */
export const priorityLandmarks = ['shoulder_image_left', 'shoulder_image_right', 'elbow_image_left', 'hip_image_left', 'hip_image_right', 'knee_image_left', 'knee_image_right', 'head_top'] as const;
/** Landmarks to check again (L0-1c: found, but from an occluding item or a weak cue). */
export const recheckLandmarks = ['elbow_image_right', 'wrist_image_left', 'wrist_image_right', 'ankle_image_left', 'ankle_image_right', 'neck_base'] as const;

const visibilities = ['visible', 'occluded', 'inferred', 'unknown'] as const;
const confidences = ['high', 'medium', 'low', 'none'] as const;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Reads the `landmarks.json` of `align-study`. Only the fields that the page shows are kept. Text is cut to 300 characters. */
export function parseAutomaticLandmarks(bytes: Buffer): { frame: { width: number; height: number }; landmarks: AutomaticLandmark[]; regions: PagePayload['regions'] } {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('E_LANDMARKS', 'The automatic landmark file is not valid JSON.');
  }
  if (!isRecord(value) || value.format !== landmarkFormat || !isRecord(value.frame) || !Array.isArray(value.landmarks))
    fail('E_LANDMARKS', 'The automatic landmark file must be the landmarks.json of align-study.');
  const { width, height } = value.frame;
  if (!finite(width) || !finite(height) || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048)
    fail('E_LANDMARKS', 'The frame size is not valid.');
  const inFrame = (x: unknown, y: unknown): boolean => finite(x) && finite(y) && x >= 0 && y >= 0 && x <= width && y <= height;
  const box = (item: unknown): AutomaticLandmark['range'] => {
    if (item === null || item === undefined) return null;
    if (!isRecord(item) || !inFrame(item.left, item.top) || !inFrame(item.right, item.bottom)) fail('E_LANDMARKS', 'A range is outside the frame.');
    return { left: item.left as number, top: item.top as number, right: item.right as number, bottom: item.bottom as number };
  };
  const text = (item: unknown): string => (typeof item === 'string' ? item.slice(0, 300) : '');
  const landmarks = value.landmarks.map((item: unknown): AutomaticLandmark => {
    if (!isRecord(item) || typeof item.id !== 'string' || !(landmarkIds as readonly string[]).includes(item.id)) fail('E_LANDMARKS', 'An automatic landmark has an unknown id.');
    const visibility = visibilities.find((v) => v === item.visibility);
    const confidence = confidences.find((c) => c === item.confidence);
    if (!visibility || !confidence) fail('E_LANDMARKS', `${item.id}: visibility or confidence is not valid.`);
    let point: AutomaticLandmark['point'] = null;
    if (item.point !== null && item.point !== undefined) {
      if (!isRecord(item.point) || !inFrame(item.point.x, item.point.y)) fail('E_LANDMARKS', `${item.id}: the point is outside the frame.`);
      point = { x: item.point.x as number, y: item.point.y as number };
    }
    if ((visibility === 'unknown') !== (point === null)) fail('E_LANDMARKS', `${item.id}: an unknown landmark has no point, and other landmarks have one.`);
    return { id: item.id, point, range: box(item.range), visibility, confidence, method: text(item.method), note: text(item.note) };
  });
  const regions = (Array.isArray(value.regions) ? value.regions : []).map((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== 'string') fail('E_LANDMARKS', 'A region is not valid.');
    const range = box(item.range);
    if (!range) fail('E_LANDMARKS', 'A region has no range.');
    return { id: item.id.slice(0, 64), range, reason: text(item.reason) };
  });
  return { frame: { width, height }, landmarks, regions };
}

/** Makes the JSON safe inside an HTML script element: no `<`, `>`, `&`, or line separator characters stay as they are. */
export const scriptJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

const style = `
:root { color-scheme: light; font: 13px system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; display: grid; grid-template-columns: 1fr 360px; height: 100vh; background: #f4f4f4; color: #111; }
#stage { position: relative; min-width: 0; }
#view { width: 100%; height: calc(100vh - 28px); display: block; background: #ddd; cursor: crosshair; }
#status { height: 28px; padding: 6px 8px; font-size: 12px; white-space: nowrap; overflow: hidden; background: #fff; border-top: 1px solid #ccc; }
aside { overflow: auto; padding: 8px; background: #fff; border-left: 1px solid #ccc; }
h1 { font-size: 15px; margin: 0 0 6px; }
.help { font-size: 12px; color: #333; margin: 0 0 8px; padding-left: 16px; }
.tools { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; }
button { font: inherit; padding: 4px 8px; }
label { display: block; margin-top: 6px; font-weight: 600; }
input[type=text], select, textarea { width: 100%; font: inherit; padding: 3px; }
textarea { height: 54px; }
#list { margin-top: 8px; }
.group { font-weight: 700; margin: 8px 0 2px; }
.row { display: flex; justify-content: space-between; width: 100%; text-align: left; border: 1px solid #ddd; background: #fafafa; margin: 1px 0; }
.row small { color: #555; }
.row.selected { background: #fff3c4; border-color: #c9a400; }
#auto { font-size: 12px; color: #444; margin-top: 6px; }
#problems { color: #a00; font-size: 12px; margin-top: 6px; }
`;

const body = `
<div id="stage"><canvas id="view"></canvas><div id="status"></div></div>
<aside>
  <h1>L0-1d manual landmarks</h1>
  <ul class="help">
    <li>Select a landmark in the list. Click the image to put its point. Drag the point to correct it.</li>
    <li>Mark only what you can see or derive from visible shapes. If a joint is hidden, use "Range" to draw a box, then "Unknown". Do not guess a point under the skirt.</li>
    <li>Set visibility and confidence. Write the reason (method) and a note. Both are required for export.</li>
    <li>Wheel: zoom at the cursor. Right or middle drag, Alt + drag, or a drag on the image: pan. Ctrl+Z: undo.</li>
    <li>Squares are your marks. Circles are the automatic L0-1c points. Blue: image left. Orange: image right.</li>
  </ul>
  <label for="marked-by">Marked by</label><input id="marked-by" type="text" maxlength="200">
  <div class="tools">
    <button id="mode-point" type="button">Point</button><button id="mode-range" type="button">Range</button>
    <button id="unknown" type="button">Unknown</button><button id="clear" type="button">Not reviewed</button>
    <button id="undo" type="button">Undo</button>
  </div>
  <div class="tools">
    <button id="zoom-in" type="button">Zoom +</button><button id="zoom-out" type="button">Zoom −</button><button id="fit" type="button">Fit</button>
    <label style="display:inline;font-weight:400"><input id="show-auto" type="checkbox" checked> automatic points</label>
  </div>
  <label for="visibility">Visibility</label>
  <select id="visibility"><option value="" disabled>not reviewed</option><option>visible</option><option>occluded</option><option>inferred</option><option>unknown</option></select>
  <label for="confidence">Confidence</label>
  <select id="confidence"><option value="" disabled>not reviewed</option><option>high</option><option>medium</option><option>low</option><option>none</option></select>
  <label for="method">Reason (method)</label><input id="method" type="text" maxlength="300">
  <label for="note">Note</label><textarea id="note" maxlength="300"></textarea>
  <div id="auto"></div>
  <div class="tools"><button id="export" type="button">Export JSON</button><label style="display:inline;font-weight:400">Import JSON <input id="import" type="file" accept="application/json,.json"></label></div>
  <div id="problems"></div>
  <div id="list"></div>
</aside>`;

export type AnnotatePageOptions = {
  readonly imageBytes: Buffer;
  readonly imageName: string;
  readonly landmarkBytes: Buffer;
  readonly manualBytes?: Buffer;
  readonly pageCode: Buffer;
  readonly toolVersion: string;
};

/** `annotate-page`: writes annotate.html. Deterministic: the same inputs give the same bytes. */
export function annotatePageCommand(options: AnnotatePageOptions): CommandResult {
  const automatic = parseAutomaticLandmarks(options.landmarkBytes);
  const image = decodePng(options.imageBytes, layerPngLimits).raster;
  if (image.width !== automatic.frame.width || image.height !== automatic.frame.height)
    fail('E_IMAGE', `The image is ${image.width}x${image.height}. The landmark frame is ${automatic.frame.width}x${automatic.frame.height}.`);
  const code = options.pageCode.toString('utf8');
  if (code.length === 0 || !code.includes('function start(')) fail('E_INPUT', 'The compiled page code is missing. Build the package first.');
  if (/^\s*import[\s{*]/m.test(code) || code.includes('</script')) fail('E_INPUT', 'The compiled page code must have no import and no closing script tag.');
  let prior: Entry[] = [];
  let priorMarkedBy = '';
  if (options.manualBytes) {
    if (options.manualBytes.length > maxLandmarkBytes) fail('E_INPUT_TOO_LARGE', 'The manual landmark file is too large.');
    prior = parseManualLandmarks(options.manualBytes, automatic.frame).map((item) => ({
      id: item.id,
      visibility: item.visibility,
      confidence: item.confidence,
      point: item.point,
      range: item.range,
      method: item.method,
      note: item.note
    }));
    const raw = JSON.parse(options.manualBytes.toString('utf8')) as { markedBy?: unknown };
    priorMarkedBy = typeof raw.markedBy === 'string' ? raw.markedBy : '';
  }
  const imageSha256 = sha256(options.imageBytes);
  const payload: PagePayload = {
    format: landmarkFormat,
    frame: automatic.frame,
    ids: landmarkIds,
    priority: priorityLandmarks,
    recheck: recheckLandmarks,
    image: { name: options.imageName.slice(0, 200), sha256: imageSha256, dataUrl: `data:image/png;base64,${options.imageBytes.toString('base64')}` },
    automatic: automatic.landmarks,
    automaticSha256: sha256(options.landmarkBytes),
    regions: automatic.regions,
    prior,
    priorMarkedBy
  };
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'">
<title>L0-1d landmarks</title>
<style>${style}</style>
</head>
<body>${body}
<script id="payload" type="application/json">${scriptJson(payload)}</script>
<script type="module">
${code}
start(JSON.parse(document.getElementById('payload').textContent));
</script>
</body>
</html>
`;
  const file = { name: 'annotate.html', bytes: Buffer.from(html, 'utf8') };
  return {
    report: {
      format: annotateFormat,
      status: 'PASS',
      tool: { version: options.toolVersion, command: 'annotate-page' },
      inputs: { image: { name: options.imageName, sha256: imageSha256 }, automaticLandmarks: sha256(options.landmarkBytes), manualLandmarks: options.manualBytes ? sha256(options.manualBytes) : null },
      priority: priorityLandmarks,
      recheck: recheckLandmarks,
      priorManualEntries: prior.length,
      files: [{ name: file.name, sha256: sha256(file.bytes), bytes: file.bytes.length }]
    },
    files: [file]
  };
}
