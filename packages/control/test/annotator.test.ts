import { landmarkFormat, landmarkIds, parseManualLandmarks } from '@control/alignstudy';
import {
  type Action,
  activeSeconds,
  apply,
  boxFrom,
  buildExport,
  confidences,
  entriesFromFile,
  entryProblems,
  fitView,
  type History,
  panBy,
  startHistory,
  toImage,
  toScreen,
  undo,
  visibilities,
  zoomAt
} from '@control/annotator';
import { describe, expect, it } from 'vitest';

// L0-1d annotation page: the pure state, view, and export functions. The browser part is checked by hand in a browser.

const frame = { width: 1280, height: 1280 };
const session = { activeSeconds: 0, idleLimitSeconds: 60, counters: startHistory().present.counters };

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const exportOf = (history: History, markedBy = 'tester'): ReturnType<typeof buildExport> =>
  buildExport({
    format: landmarkFormat,
    markedBy,
    frame,
    ids: landmarkIds,
    state: history.present,
    image: { name: 'i.png', sha256: 'a'.repeat(64) },
    automaticLandmarksSha256: 'b'.repeat(64),
    session
  });

describe('state', () => {
  it('a new point starts as inferred with low confidence, not as a confident mark', () => {
    const history = apply(startHistory(), { type: 'place', id: 'hip_image_left', point: { x: 10.04, y: 20.06 } }, frame);
    expect(history.present.entries.hip_image_left).toMatchObject({ visibility: 'inferred', confidence: 'low', point: { x: 10, y: 20.1 } });
  });

  it('unknown and confidence none remove the point and keep the range', () => {
    let history = apply(startHistory(), { type: 'place', id: 'knee_image_left', point: { x: 5, y: 5 } }, frame);
    history = apply(history, { type: 'range', id: 'knee_image_left', range: { left: 1, top: 1, right: 9, bottom: 9 } }, frame);
    history = apply(history, { type: 'unknown', id: 'knee_image_left' }, frame);
    expect(history.present.entries.knee_image_left).toMatchObject({ visibility: 'unknown', confidence: 'none', point: null, range: { left: 1 } });
    history = apply(history, { type: 'place', id: 'knee_image_left', point: { x: 6, y: 6 } }, frame);
    expect(history.present.entries.knee_image_left?.visibility).toBe('inferred');
    history = apply(history, { type: 'confidence', id: 'knee_image_left', value: 'none' }, frame);
    expect(history.present.entries.knee_image_left).toMatchObject({ visibility: 'unknown', point: null });
  });

  it('counts placements, re-placements, moves and undos, and undo restores the entries', () => {
    let history = apply(startHistory(), { type: 'place', id: 'head_top', point: { x: 5, y: 5 } }, frame);
    history = apply(history, { type: 'place', id: 'head_top', point: { x: 6, y: 6 } }, frame);
    history = apply(history, { type: 'move', id: 'head_top', point: { x: 7, y: 7 } }, frame);
    history = undo(history);
    expect(history.present.entries.head_top?.point).toEqual({ x: 6, y: 6 });
    expect(history.present.counters).toMatchObject({ placements: 1, replacements: 1, moves: 1, undos: 1 });
    history = undo(undo(history));
    expect(history.present.entries.head_top).toBeUndefined();
    expect(undo(history)).toBe(history);
  });

  it('clamps points to the frame and refuses a box without area', () => {
    const history = apply(startHistory(), { type: 'place', id: 'nose', point: { x: -4, y: 9999 } }, frame);
    expect(history.present.entries.nose?.point).toEqual({ x: 0, y: 1280 });
    expect(boxFrom(frame, { x: 10, y: 10 }, { x: 10, y: 50 })).toBeNull();
    expect(boxFrom(frame, { x: 50, y: 60 }, { x: 10, y: 20 })).toEqual({ left: 10, top: 20, right: 50, bottom: 60 });
  });

  it('merges consecutive text edits into one undo step', () => {
    let history = apply(startHistory(), { type: 'note', id: 'nose', value: 'a' }, frame);
    history = apply(history, { type: 'note', id: 'nose', value: 'ab' }, frame, true);
    expect(history.past).toHaveLength(1);
    expect(undo(history).present.entries.nose).toBeUndefined();
  });
});

describe('view', () => {
  it('keeps image coordinates independent of zoom and pan', () => {
    const next = random(3);
    for (let trial = 0; trial < 200; trial += 1) {
      let view = fitView(frame, { width: 800 + next() * 800, height: 600 + next() * 600 });
      const screen = { x: next() * 1000, y: next() * 800 };
      const anchor = toImage(view, screen);
      view = zoomAt(view, screen, 0.2 + next() * 5);
      const after = toImage(view, screen);
      expect(after.x).toBeCloseTo(anchor.x, 6);
      expect(after.y).toBeCloseTo(anchor.y, 6);
      view = panBy(view, next() * 200 - 100, next() * 200 - 100);
      const image = { x: next() * 1280, y: next() * 1280 };
      const back = toImage(view, toScreen(view, image));
      expect(back.x).toBeCloseTo(image.x, 6);
      expect(back.y).toBeCloseTo(image.y, 6);
    }
  });

  it('fits the frame in the viewport and limits the zoom', () => {
    expect(fitView(frame, { width: 640, height: 1000 })).toEqual({ scale: 0.5, offsetX: 0, offsetY: 180 });
    expect(zoomAt({ scale: 30, offsetX: 0, offsetY: 0 }, { x: 0, y: 0 }, 10).scale).toBe(32);
  });
});

describe('export', () => {
  it('refuses incomplete entries and a missing name, and gives the problems', () => {
    const history = apply(startHistory(), { type: 'place', id: 'hip_image_left', point: { x: 5, y: 5 } }, frame);
    const result = exportOf(history, ' ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((problem) => problem.includes('Marked by'))).toBe(true);
      expect(result.problems.some((problem) => problem.includes('note'))).toBe(true);
    }
    expect(entryProblems({ id: 'x', visibility: 'visible', confidence: 'high', point: null, range: null, method: 'm', note: 'n' }, frame)).toHaveLength(1);
  });

  it('writes only reviewed entries, without x and y for unknown entries, and the reference parser accepts every valid export', () => {
    const next = random(9);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
    for (let trial = 0; trial < 300; trial += 1) {
      let history = startHistory();
      for (let step = 0; step < 25; step += 1) {
        const id = pick(landmarkIds);
        const point = { x: next() * 1400 - 60, y: next() * 1400 - 60 };
        const actions: Action[] = [
          { type: 'place', id, point },
          { type: 'move', id, point },
          { type: 'unknown', id },
          { type: 'clear', id },
          { type: 'visibility', id, value: pick(visibilities) },
          { type: 'confidence', id, value: pick(confidences) },
          { type: 'note', id, value: next() < 0.9 ? 'seen' : '' },
          { type: 'method', id, value: 'click' }
        ];
        const range = boxFrom(frame, point, { x: next() * 1280, y: next() * 1280 });
        if (range) actions.push({ type: 'range', id, range });
        history = next() < 0.1 ? undo(history) : apply(history, pick(actions), frame);
      }
      const result = exportOf(history);
      const entries = Object.values(history.present.entries);
      const valid = entries.every((entry) => entryProblems(entry, frame).length === 0);
      expect(result.ok).toBe(valid);
      if (!result.ok) continue;
      const bytes = Buffer.from(JSON.stringify(result.json));
      const parsed = parseManualLandmarks(bytes, frame);
      expect(parsed.map((item) => item.id).sort()).toEqual(entries.map((entry) => entry.id).sort());
      for (const item of parsed) {
        if (item.visibility === 'unknown') expect(item.point).toBeNull();
        else expect(item.point).not.toBeNull();
        expect(item.origin).toBe('manual');
      }
      expect(entriesFromFile(JSON.parse(bytes.toString('utf8')) as unknown, landmarkIds).entries).toHaveLength(entries.length);
    }
  });

  it('measures active time with an idle limit', () => {
    expect(activeSeconds([0, 1000, 3000, 500000, 501000], 60)).toBe(64);
    expect(activeSeconds([], 60)).toBe(0);
  });

  it('skips unknown ids when it reads a file', () => {
    const read = entriesFromFile(
      {
        markedBy: 'p',
        landmarks: [
          { id: 'tail', visibility: 'visible', confidence: 'high' },
          { id: 'nose', visibility: 'visible', confidence: 'high', x: 1, y: 2, method: 'm', note: 'n' }
        ]
      },
      landmarkIds
    );
    expect(read.entries.map((entry) => entry.id)).toEqual(['nose']);
    expect(read.skipped).toHaveLength(1);
    expect(read.markedBy).toBe('p');
  });
});
