/// <reference lib="dom" />

// Manual landmark page for experiment L0-1d (prototype). This module runs in the browser.
// It has no runtime import: `annotate-page` puts its compiled code into one self-contained HTML file.
// The pure functions (state, undo, view transform, validation, export) have no DOM access, so the tests run them in Node.js.
// The export is the L0-1c manual landmark format (`aigg.l0-1c.landmarks/0.1`). `parseManualLandmarks` in alignstudy.ts is the reference parser.
// A click is a human judgment, not ground truth of a hidden joint. The page never invents a point: an unknown landmark has no x and y.

export type Visibility = 'visible' | 'occluded' | 'inferred' | 'unknown';
export type Confidence = 'high' | 'medium' | 'low' | 'none';
export type Point = { readonly x: number; readonly y: number };
export type Box = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
export type Frame = { readonly width: number; readonly height: number };

/** One manual entry. An id without an entry is "not reviewed": the automatic value stays. */
export type Entry = {
  readonly id: string;
  readonly visibility: Visibility;
  readonly confidence: Confidence;
  readonly point: Point | null;
  readonly range: Box | null;
  readonly method: string;
  readonly note: string;
};

export type Counters = {
  /** A point put on a landmark that had no point. */
  readonly placements: number;
  /** A point put again (click) on a landmark that already had a point. */
  readonly replacements: number;
  /** A drag of an existing point. */
  readonly moves: number;
  readonly ranges: number;
  readonly unknowns: number;
  readonly clears: number;
  readonly attributeEdits: number;
  readonly undos: number;
};

export type State = { readonly entries: Readonly<Record<string, Entry>>; readonly counters: Counters };
export type History = { readonly past: readonly State[]; readonly present: State };

export type Action =
  | { readonly type: 'place'; readonly id: string; readonly point: Point }
  | { readonly type: 'move'; readonly id: string; readonly point: Point }
  | { readonly type: 'range'; readonly id: string; readonly range: Box }
  | { readonly type: 'unknown'; readonly id: string }
  | { readonly type: 'clear'; readonly id: string }
  | { readonly type: 'visibility'; readonly id: string; readonly value: Visibility }
  | { readonly type: 'confidence'; readonly id: string; readonly value: Confidence }
  | { readonly type: 'method'; readonly id: string; readonly value: string }
  | { readonly type: 'note'; readonly id: string; readonly value: string };

export const visibilities: readonly Visibility[] = ['visible', 'occluded', 'inferred', 'unknown'];
export const confidences: readonly Confidence[] = ['high', 'medium', 'low', 'none'];
export const defaultMethod = 'manual mark on the image';
export const maxText = 300;

export const emptyCounters: Counters = { placements: 0, replacements: 0, moves: 0, ranges: 0, unknowns: 0, clears: 0, attributeEdits: 0, undos: 0 };

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** A point in the frame, rounded to 0.1 px. Outside values go to the nearest frame edge. */
export const clampPoint = (frame: Frame, point: Point): Point => ({ x: round1(Math.min(frame.width, Math.max(0, point.x))), y: round1(Math.min(frame.height, Math.max(0, point.y))) });

/** A box from two corners in any order, inside the frame. Null when it has no area. */
export function boxFrom(frame: Frame, a: Point, b: Point): Box | null {
  const p = clampPoint(frame, a);
  const q = clampPoint(frame, b);
  const box = { left: Math.min(p.x, q.x), top: Math.min(p.y, q.y), right: Math.max(p.x, q.x), bottom: Math.max(p.y, q.y) };
  return box.right > box.left && box.bottom > box.top ? box : null;
}

const fresh = (id: string): Entry => ({ id, visibility: 'inferred', confidence: 'low', point: null, range: null, method: defaultMethod, note: '' });

const bump = (counters: Counters, key: keyof Counters): Counters => ({ ...counters, [key]: counters[key] + 1 });

/** Applies one action. Pure. The rules keep the parser invariants: unknown has no point, and confidence none goes only with unknown. */
export function reduce(state: State, action: Action, frame: Frame): State {
  const current = state.entries[action.id];
  const base = current ?? fresh(action.id);
  const put = (entry: Entry, key: keyof Counters): State => ({ entries: { ...state.entries, [entry.id]: entry }, counters: bump(state.counters, key) });
  switch (action.type) {
    case 'place': {
      const known = base.visibility === 'unknown' ? { visibility: 'inferred' as const, confidence: 'low' as const } : {};
      return put({ ...base, ...known, point: clampPoint(frame, action.point) }, base.point ? 'replacements' : 'placements');
    }
    case 'move':
      if (!current?.point) return state;
      return put({ ...current, point: clampPoint(frame, action.point) }, 'moves');
    case 'range':
      return put({ ...base, range: action.range }, 'ranges');
    case 'unknown':
      return put({ ...base, visibility: 'unknown', confidence: 'none', point: null }, 'unknowns');
    case 'clear': {
      if (!current) return state;
      const entries = { ...state.entries };
      Reflect.deleteProperty(entries, action.id);
      return { entries, counters: bump(state.counters, 'clears') };
    }
    case 'visibility':
      if (action.value === 'unknown') return put({ ...base, visibility: 'unknown', confidence: 'none', point: null }, 'unknowns');
      return put({ ...base, visibility: action.value, confidence: base.confidence === 'none' ? 'low' : base.confidence }, 'attributeEdits');
    case 'confidence':
      if (action.value === 'none') return put({ ...base, visibility: 'unknown', confidence: 'none', point: null }, 'unknowns');
      return put({ ...base, confidence: action.value, visibility: base.visibility === 'unknown' ? 'inferred' : base.visibility }, 'attributeEdits');
    case 'method':
      return put({ ...base, method: action.value.slice(0, maxText) }, 'attributeEdits');
    case 'note':
      return put({ ...base, note: action.value.slice(0, maxText) }, 'attributeEdits');
    default:
      return state;
  }
}

export const startHistory = (entries: readonly Entry[] = []): History => ({ past: [], present: { entries: Object.fromEntries(entries.map((entry) => [entry.id, entry])), counters: emptyCounters } });

/** Applies an action and keeps the previous state for undo. A text edit of the same field merges with the previous text edit. */
export function apply(history: History, action: Action, frame: Frame, mergeWithLast = false): History {
  const next = reduce(history.present, action, frame);
  if (next === history.present) return history;
  if (mergeWithLast && history.past.length > 0) return { past: history.past, present: next };
  return { past: [...history.past, history.present].slice(-500), present: next };
}

/** Undo restores the entries but keeps the counters, plus one undo. */
export function undo(history: History): History {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return { past: history.past.slice(0, -1), present: { entries: previous.entries, counters: bump(history.present.counters, 'undos') } };
}

// ---------- view ----------

/** Display transform: screen = image * scale + offset. Coordinates in the data stay in the image frame. */
export type View = { readonly scale: number; readonly offsetX: number; readonly offsetY: number };

export const toImage = (view: View, screen: Point): Point => ({ x: (screen.x - view.offsetX) / view.scale, y: (screen.y - view.offsetY) / view.scale });
export const toScreen = (view: View, image: Point): Point => ({ x: image.x * view.scale + view.offsetX, y: image.y * view.scale + view.offsetY });

/** Zoom by `factor` about a screen point. The image point under that screen point does not move. Scale stays in [0.05, 32]. */
export function zoomAt(view: View, screen: Point, factor: number): View {
  const scale = Math.min(32, Math.max(0.05, view.scale * factor));
  const anchor = toImage(view, screen);
  return { scale, offsetX: screen.x - anchor.x * scale, offsetY: screen.y - anchor.y * scale };
}

export const panBy = (view: View, dx: number, dy: number): View => ({ scale: view.scale, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy });

/** The view that shows the full frame centered in a viewport. */
export function fitView(frame: Frame, viewport: Frame): View {
  const scale = Math.min(viewport.width / frame.width, viewport.height / frame.height);
  return { scale, offsetX: (viewport.width - frame.width * scale) / 2, offsetY: (viewport.height - frame.height * scale) / 2 };
}

// ---------- validation and export ----------

const inside = (frame: Frame, x: number, y: number): boolean => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= frame.width && y <= frame.height;
const textOk = (text: string): boolean => text.trim().length > 0 && text.length <= maxText;

/** The problems that `parseManualLandmarks` would report for one entry. Empty: the entry is valid. */
export function entryProblems(entry: Entry, frame: Frame): string[] {
  const problems: string[] = [];
  if (entry.visibility === 'unknown' && entry.point) problems.push('an unknown landmark must not have a point');
  if (entry.visibility !== 'unknown' && !entry.point) problems.push(`a ${entry.visibility} landmark needs a point (click the image) or set it to unknown`);
  if ((entry.visibility === 'unknown') !== (entry.confidence === 'none')) problems.push('confidence none goes only with visibility unknown');
  if (entry.point && !inside(frame, entry.point.x, entry.point.y)) problems.push('the point is outside the image');
  if (
    entry.range &&
    (!inside(frame, entry.range.left, entry.range.top) || !inside(frame, entry.range.right, entry.range.bottom) || !(entry.range.right > entry.range.left) || !(entry.range.bottom > entry.range.top))
  )
    problems.push('the range is not valid');
  if (!textOk(entry.method)) problems.push(`the reason (method) must have 1 to ${maxText} characters`);
  if (!textOk(entry.note)) problems.push(`the note must have 1 to ${maxText} characters`);
  return problems;
}

export type Session = {
  /** Seconds of active work: time between page actions, each gap counted up to `idleLimitSeconds`. */
  readonly activeSeconds: number;
  readonly idleLimitSeconds: number;
  readonly counters: Counters;
};

export type ExportInput = {
  readonly format: string;
  readonly markedBy: string;
  readonly frame: Frame;
  readonly ids: readonly string[];
  readonly state: State;
  readonly image: { readonly name: string; readonly sha256: string };
  readonly automaticLandmarksSha256: string;
  readonly session: Session;
};

/** The export file, or the list of problems. Only reviewed ids are written, in the fixed id order. */
export function buildExport(input: ExportInput): { readonly ok: true; readonly json: Record<string, unknown> } | { readonly ok: false; readonly problems: readonly string[] } {
  const problems: string[] = [];
  if (input.markedBy.trim().length === 0 || input.markedBy.length > 200) problems.push('Enter your name in "Marked by" (1 to 200 characters).');
  const entries = input.ids.flatMap((id) => {
    const entry = input.state.entries[id];
    return entry ? [entry] : [];
  });
  for (const entry of entries) for (const problem of entryProblems(entry, input.frame)) problems.push(`${entry.id}: ${problem}.`);
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    json: {
      format: input.format,
      markedBy: input.markedBy.trim(),
      rules: 'Manual marks are human judgments on the image, not ground truth of hidden joints. Unknown landmarks have no x and y. Coordinates are in the image frame, y down.',
      image: input.image,
      automaticLandmarksSha256: input.automaticLandmarksSha256,
      session: input.session,
      landmarks: entries.map((entry) => ({
        id: entry.id,
        origin: 'manual',
        visibility: entry.visibility,
        confidence: entry.confidence,
        ...(entry.point ? { x: entry.point.x, y: entry.point.y } : {}),
        ...(entry.range ? { range: entry.range } : {}),
        method: entry.method.trim(),
        note: entry.note.trim()
      }))
    }
  };
}

/** Active time: the sum of gaps between action times (milliseconds), each gap at most `idleLimitSeconds`. */
export function activeSeconds(times: readonly number[], idleLimitSeconds: number): number {
  let total = 0;
  for (let index = 1; index < times.length; index += 1) total += Math.min(Math.max(0, (times[index] ?? 0) - (times[index - 1] ?? 0)), idleLimitSeconds * 1000);
  return Math.round(total / 1000);
}

/** Entries from a manual landmark file (the export format). Entries with wrong fields are skipped and reported. */
export function entriesFromFile(value: unknown, ids: readonly string[]): { entries: Entry[]; skipped: string[]; markedBy: string } {
  const entries: Entry[] = [];
  const skipped: string[] = [];
  const record = (item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item);
  if (!record(value) || !Array.isArray(value.landmarks)) return { entries, skipped: ['the file has no landmarks array'], markedBy: '' };
  for (const item of value.landmarks as unknown[]) {
    if (!record(item) || typeof item.id !== 'string' || !ids.includes(item.id)) {
      skipped.push('an entry with an unknown id');
      continue;
    }
    const visibility = visibilities.find((v) => v === item.visibility);
    const confidence = confidences.find((c) => c === item.confidence);
    if (!visibility || !confidence) {
      skipped.push(`${item.id}: visibility or confidence`);
      continue;
    }
    const point = typeof item.x === 'number' && typeof item.y === 'number' && visibility !== 'unknown' ? { x: item.x, y: item.y } : null;
    const r = item.range;
    const range =
      record(r) && typeof r.left === 'number' && typeof r.top === 'number' && typeof r.right === 'number' && typeof r.bottom === 'number'
        ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
        : null;
    entries.push({
      id: item.id,
      visibility,
      confidence,
      point,
      range,
      method: typeof item.method === 'string' ? item.method.slice(0, maxText) : defaultMethod,
      note: typeof item.note === 'string' ? item.note.slice(0, maxText) : ''
    });
  }
  return { entries, skipped, markedBy: typeof value.markedBy === 'string' ? value.markedBy.slice(0, 200) : '' };
}

// ---------- browser page ----------

export type AutomaticLandmark = {
  readonly id: string;
  readonly point: Point | null;
  readonly range: Box | null;
  readonly visibility: Visibility;
  readonly confidence: Confidence;
  readonly method: string;
  readonly note: string;
};

export type PagePayload = {
  readonly format: string;
  readonly frame: Frame;
  readonly ids: readonly string[];
  readonly priority: readonly string[];
  readonly recheck: readonly string[];
  readonly image: { readonly name: string; readonly sha256: string; readonly dataUrl: string };
  readonly automatic: readonly AutomaticLandmark[];
  readonly automaticSha256: string;
  readonly regions: readonly { readonly id: string; readonly range: Box; readonly reason: string }[];
  readonly prior: readonly Entry[];
  readonly priorMarkedBy: string;
};

type Mode = 'point' | 'range';

const sideColor = (id: string): string => (id.endsWith('image_left') ? '#1e6ee6' : id.endsWith('image_right') ? '#e66e14' : '#14963c');

/** Starts the page. Called by the inline script of the generated HTML file. */
export function start(payload: PagePayload): void {
  const doc = globalThis.document;
  const byId = (id: string): HTMLElement => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`missing #${id}`);
    return element;
  };
  const canvas = byId('view') as HTMLCanvasElement;
  const maybeContext = canvas.getContext('2d');
  if (!maybeContext) throw new Error('no 2D canvas');
  const context: CanvasRenderingContext2D = maybeContext;
  const list = byId('list') as HTMLDivElement;
  const status = byId('status') as HTMLDivElement;
  const problemsBox = byId('problems') as HTMLDivElement;
  const markedBy = byId('marked-by') as HTMLInputElement;
  const visibilitySelect = byId('visibility') as HTMLSelectElement;
  const confidenceSelect = byId('confidence') as HTMLSelectElement;
  const methodInput = byId('method') as HTMLInputElement;
  const noteInput = byId('note') as HTMLTextAreaElement;
  const autoBox = byId('auto') as HTMLDivElement;
  const showAuto = byId('show-auto') as HTMLInputElement;
  const storageKey = `aigg-l0-1d-${payload.image.sha256}`;
  const idle = 60;
  const frame = payload.frame;
  const image = new Image();

  let history = startHistory(payload.prior);
  let selected: string = payload.priority[0] ?? payload.ids[0] ?? '';
  let mode: Mode = 'point';
  let view: View = { scale: 1, offsetX: 0, offsetY: 0 };
  let times: number[] = [];
  let drag: { kind: 'pan' | 'move' | 'range' | 'click'; start: Point; last: Point; moved: boolean; base: History } | null = null;
  let draftRange: Box | null = null;
  markedBy.value = payload.priorMarkedBy;

  // Restore unsaved work of this image from the browser storage, when it exists. The storage can be missing.
  try {
    const saved = globalThis.localStorage.getItem(storageKey);
    if (saved) {
      const parsed = JSON.parse(saved) as { entries?: unknown; markedBy?: unknown; times?: unknown };
      const restored = entriesFromFile({ landmarks: Object.values((parsed.entries ?? {}) as Record<string, unknown>) }, payload.ids);
      history = startHistory(restored.entries);
      if (typeof parsed.markedBy === 'string') markedBy.value = parsed.markedBy;
      if (Array.isArray(parsed.times)) times = parsed.times.filter((t): t is number => typeof t === 'number').slice(-5000);
    }
  } catch {
    // Browser storage is optional.
  }

  const save = (): void => {
    try {
      globalThis.localStorage.setItem(storageKey, JSON.stringify({ entries: history.present.entries, markedBy: markedBy.value, times }));
    } catch {
      // Browser storage is optional.
    }
  };

  const act = (action: Action, merge = false): void => {
    history = apply(history, action, frame, merge);
    times.push(Date.now());
    save();
    render();
  };

  const resize = (): void => {
    const box = canvas.getBoundingClientRect();
    const ratio = globalThis.devicePixelRatio || 1;
    canvas.width = Math.round(box.width * ratio);
    canvas.height = Math.round(box.height * ratio);
  };

  const screenOf = (event: MouseEvent): Point => {
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const marker = (at: Point, visibility: Visibility, color: string, manual: boolean, chosen: boolean): void => {
    const size = manual ? 7 : 5;
    context.lineWidth = manual ? 2.5 : 1.5;
    context.strokeStyle = color;
    context.fillStyle = color;
    context.beginPath();
    if (manual) context.rect(at.x - size, at.y - size, size * 2, size * 2);
    else context.arc(at.x, at.y, size, 0, Math.PI * 2);
    if (visibility === 'visible') context.fill();
    else context.stroke();
    if (visibility === 'inferred') {
      context.beginPath();
      context.moveTo(at.x - size, at.y - size);
      context.lineTo(at.x + size, at.y + size);
      context.moveTo(at.x - size, at.y + size);
      context.lineTo(at.x + size, at.y - size);
      context.stroke();
    }
    if (chosen) {
      context.lineWidth = 1.5;
      context.strokeStyle = '#000';
      context.beginPath();
      context.arc(at.x, at.y, size + 6, 0, Math.PI * 2);
      context.stroke();
    }
  };

  const boxOutline = (range: Box, color: string, dashed: boolean): void => {
    const a = toScreen(view, { x: range.left, y: range.top });
    const b = toScreen(view, { x: range.right, y: range.bottom });
    context.setLineDash(dashed ? [6, 5] : []);
    context.lineWidth = 1.5;
    context.strokeStyle = color;
    context.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    context.setLineDash([]);
  };

  const label = (text: string, at: Point): void => {
    context.font = '12px system-ui, sans-serif';
    const width = context.measureText(text).width;
    context.fillStyle = 'rgba(255,255,255,0.85)';
    context.fillRect(at.x + 9, at.y - 9, width + 6, 16);
    context.fillStyle = '#000';
    context.fillText(text, at.x + 12, at.y + 3);
  };

  function render(): void {
    const ratio = globalThis.devicePixelRatio || 1;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = view.scale < 2;
    context.drawImage(image, view.offsetX, view.offsetY, frame.width * view.scale, frame.height * view.scale);
    if (showAuto.checked) {
      for (const region of payload.regions) {
        const a = toScreen(view, { x: region.range.left, y: region.range.top });
        const b = toScreen(view, { x: region.range.right, y: region.range.bottom });
        context.fillStyle = region.id === 'merged_thighs' ? 'rgba(230,0,0,0.12)' : 'rgba(230,120,0,0.08)';
        context.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      }
      for (const item of payload.automatic) {
        if (item.range && (item.visibility === 'unknown' || item.id === selected)) boxOutline(item.range, '#c80000', true);
        if (item.point) {
          const at = toScreen(view, item.point);
          marker(at, item.visibility, sideColor(item.id), false, false);
          if (view.scale >= 0.9 || item.id === selected) label(`${item.id} (auto, ${item.confidence})`, at);
        }
      }
    }
    for (const entry of Object.values(history.present.entries)) {
      if (entry.range) boxOutline(entry.range, '#7a00b4', false);
      if (entry.point) {
        const at = toScreen(view, entry.point);
        marker(at, entry.visibility, sideColor(entry.id), true, entry.id === selected);
        label(`${entry.id} (manual, ${entry.confidence})`, at);
      }
    }
    if (draftRange) boxOutline(draftRange, '#7a00b4', true);
    renderPanel();
  }

  const entryState = (id: string): string => {
    const entry = history.present.entries[id];
    if (!entry) return 'not reviewed';
    const problems = entryProblems(entry, frame);
    return `${entry.visibility}, ${entry.confidence}${entry.point ? ', point' : ''}${entry.range ? ', range' : ''}${problems.length > 0 ? ' (incomplete)' : ''}`;
  };

  function renderPanel(): void {
    list.replaceChildren();
    const groups: [string, readonly string[]][] = [
      ['Priority', payload.priority],
      ['Check again', payload.recheck],
      ['Other', payload.ids.filter((id) => !payload.priority.includes(id) && !payload.recheck.includes(id))]
    ];
    for (const [title, ids] of groups) {
      const heading = doc.createElement('div');
      heading.className = 'group';
      heading.textContent = title;
      list.append(heading);
      for (const id of ids) {
        const row = doc.createElement('button');
        row.type = 'button';
        row.className = id === selected ? 'row selected' : 'row';
        const name = doc.createElement('span');
        name.textContent = id;
        name.style.color = sideColor(id);
        const state = doc.createElement('small');
        state.textContent = entryState(id);
        row.append(name, state);
        row.addEventListener('click', () => {
          selected = id;
          render();
        });
        list.append(row);
      }
    }
    const entry = history.present.entries[selected];
    visibilitySelect.value = entry?.visibility ?? '';
    confidenceSelect.value = entry?.confidence ?? '';
    if (doc.activeElement !== methodInput) methodInput.value = entry?.method ?? '';
    if (doc.activeElement !== noteInput) noteInput.value = entry?.note ?? '';
    const auto = payload.automatic.find((item) => item.id === selected);
    autoBox.textContent = auto
      ? `Automatic (L0-1c): ${auto.visibility}, ${auto.confidence}${auto.point ? ` at ${auto.point.x}, ${auto.point.y}` : ', no point'}. ${auto.method}. ${auto.note}`
      : 'Automatic (L0-1c): no entry.';
    const counters = history.present.counters;
    const entries = Object.values(history.present.entries);
    status.textContent = `${selected} | mode: ${mode} | zoom ${Math.round(view.scale * 100)} % | reviewed ${entries.length}, with point ${entries.filter((e) => e.point).length}, unknown ${entries.filter((e) => e.visibility === 'unknown').length} | active ${activeSeconds(times, idle)} s | placements ${counters.placements}, re-placements ${counters.replacements}, moves ${counters.moves}, undos ${counters.undos}`;
  }

  const nearestManual = (screen: Point): string | null => {
    const entry = history.present.entries[selected];
    if (!entry?.point) return null;
    const at = toScreen(view, entry.point);
    return Math.hypot(at.x - screen.x, at.y - screen.y) <= 12 ? entry.id : null;
  };

  canvas.addEventListener('mousedown', (event) => {
    const at = screenOf(event);
    const kind = event.button === 1 || event.button === 2 || event.altKey ? 'pan' : mode === 'range' ? 'range' : nearestManual(at) ? 'move' : 'click';
    drag = { kind, start: at, last: at, moved: false, base: history };
    event.preventDefault();
  });
  globalThis.addEventListener('mousemove', (event) => {
    if (!drag) return;
    const at = screenOf(event);
    if (Math.hypot(at.x - drag.start.x, at.y - drag.start.y) > 3) drag.moved = true;
    if (drag.kind === 'pan' || (drag.kind === 'click' && drag.moved)) {
      drag.kind = 'pan';
      view = panBy(view, at.x - drag.last.x, at.y - drag.last.y);
    } else if (drag.kind === 'range') draftRange = boxFrom(frame, toImage(view, drag.start), toImage(view, at));
    else if (drag.kind === 'move' && drag.moved) {
      const entry = history.present.entries[selected];
      // Preview only. The mouseup handler records the action.
      if (entry)
        history = { past: drag.base.past, present: { ...drag.base.present, entries: { ...drag.base.present.entries, [selected]: { ...entry, point: clampPoint(frame, toImage(view, at)) } } } };
    }
    drag.last = at;
    render();
  });
  globalThis.addEventListener('mouseup', (event) => {
    if (!drag) return;
    const at = screenOf(event);
    const done = drag;
    drag = null;
    if (done.kind === 'click' && !done.moved && selected) act({ type: 'place', id: selected, point: toImage(view, at) });
    else if (done.kind === 'move' && done.moved) {
      // One action for the whole drag, applied to the state before the drag, so that undo returns to it.
      const moved = history.present.entries[selected]?.point;
      history = done.base;
      if (moved) act({ type: 'move', id: selected, point: moved });
    } else if (done.kind === 'range' && draftRange && selected) {
      const range = draftRange;
      draftRange = null;
      act({ type: 'range', id: selected, range });
    } else render();
  });
  canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      view = zoomAt(view, screenOf(event), Math.exp(-event.deltaY * 0.0015));
      render();
    },
    { passive: false }
  );

  const bind = (id: string, handler: () => void): void => {
    (byId(id) as HTMLButtonElement).addEventListener('click', handler);
  };
  bind('mode-point', () => {
    mode = 'point';
    render();
  });
  bind('mode-range', () => {
    mode = 'range';
    render();
  });
  bind('unknown', () => {
    act({ type: 'unknown', id: selected });
  });
  bind('clear', () => {
    act({ type: 'clear', id: selected });
  });
  bind('undo', () => {
    history = undo(history);
    times.push(Date.now());
    save();
    render();
  });
  bind('fit', () => {
    view = fitView(frame, { width: canvas.clientWidth, height: canvas.clientHeight });
    render();
  });
  bind('zoom-in', () => {
    view = zoomAt(view, { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }, 1.5);
    render();
  });
  bind('zoom-out', () => {
    view = zoomAt(view, { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }, 1 / 1.5);
    render();
  });
  bind('export', () => {
    const result = buildExport({
      format: payload.format,
      markedBy: markedBy.value,
      frame,
      ids: payload.ids,
      state: history.present,
      image: { name: payload.image.name, sha256: payload.image.sha256 },
      automaticLandmarksSha256: payload.automaticSha256,
      session: { activeSeconds: activeSeconds(times, idle), idleLimitSeconds: idle, counters: history.present.counters }
    });
    problemsBox.replaceChildren();
    if (!result.ok) {
      for (const problem of result.problems) {
        const line = doc.createElement('div');
        line.textContent = problem;
        problemsBox.append(line);
      }
      return;
    }
    const blob = new Blob([`${JSON.stringify(result.json, null, 2)}\n`], { type: 'application/json' });
    const link = doc.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'landmarks-manual.json';
    link.click();
    URL.revokeObjectURL(link.href);
    problemsBox.textContent = 'Exported landmarks-manual.json.';
  });
  (byId('import') as HTMLInputElement).addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file || file.size > 256 * 1024) return;
    void file.text().then((text) => {
      try {
        const restored = entriesFromFile(JSON.parse(text) as unknown, payload.ids);
        history = startHistory(restored.entries);
        if (restored.markedBy) markedBy.value = restored.markedBy;
        problemsBox.textContent = restored.skipped.length > 0 ? `Imported. Skipped: ${restored.skipped.join('; ')}` : 'Imported.';
      } catch {
        problemsBox.textContent = 'The file is not valid JSON.';
      }
      save();
      render();
    });
  });
  visibilitySelect.addEventListener('change', () => {
    const value = visibilities.find((v) => v === visibilitySelect.value);
    if (value) act({ type: 'visibility', id: selected, value });
  });
  confidenceSelect.addEventListener('change', () => {
    const value = confidences.find((c) => c === confidenceSelect.value);
    if (value) act({ type: 'confidence', id: selected, value });
  });
  let lastText = '';
  methodInput.addEventListener('input', () => {
    act({ type: 'method', id: selected, value: methodInput.value }, lastText === `method:${selected}`);
    lastText = `method:${selected}`;
  });
  noteInput.addEventListener('input', () => {
    act({ type: 'note', id: selected, value: noteInput.value }, lastText === `note:${selected}`);
    lastText = `note:${selected}`;
  });
  markedBy.addEventListener('input', save);
  doc.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'z') {
      history = undo(history);
      times.push(Date.now());
      save();
      render();
      event.preventDefault();
    }
  });
  globalThis.addEventListener('resize', () => {
    resize();
    render();
  });

  image.addEventListener('load', () => {
    resize();
    view = fitView(frame, { width: canvas.clientWidth, height: canvas.clientHeight });
    render();
  });
  image.src = payload.image.dataUrl;
}
