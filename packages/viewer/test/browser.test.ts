import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readExport } from '@viewer/exportbundle';
import { pageRoutes, type Route, startServer, viewerRoutes } from '@viewer/server';
import { describe, expect, it } from 'vitest';

import { colours, decodePng, syntheticExport } from './helpers';

// Browser smoke test of the built viewer page in headless Chromium with software WebGL (SwiftShader). Opt-in:
//   AIGG_BROWSER_SMOKE=1 npx vitest run test/browser.test.ts                      (synthetic export, in packages/viewer)
//   AIGG_BROWSER_SMOKE=1 AIGG_VIEWER_EXPORT=<export folder> AIGG_VIEWER_OUT=<folder> npx vitest run test/browser.test.ts
// The second form also plays a real Spine export and writes screenshots and summary.json to AIGG_VIEWER_OUT
// (default: a new private folder <tmp>/aigg-viewer-smoke-*). Nothing is written into the repository.
// Playwright with Chromium is not a repository dependency: the test resolves `playwright` from the environment
// and fails with a clear message when it is not there. Run `npm run build --workspace @aigg/viewer` first.

const enabled = process.env.AIGG_BROWSER_SMOKE === '1';
const realExport = process.env.AIGG_VIEWER_EXPORT;
const pageFolder = fileURLToPath(new URL('../dist/page/', import.meta.url));
const viewport = { width: 900, height: 1000 };
/** The page background (#7a8590). A pixel that differs from it by more than the limit belongs to the character. */
const background = [122, 133, 144] as const;

type Snapshot = {
  status: string;
  message: string;
  animation: string | null;
  paused: boolean;
  trackTime: number | null;
  sameSkeleton: boolean;
  skeletonsCreated: number;
  bones: { name: string; rotation: number; worldX: number; worldY: number }[];
};
type Locator = { screenshot: (options?: Record<string, unknown>) => Promise<Buffer> };
type Page = {
  goto: (url: string) => Promise<unknown>;
  on: (event: string, listener: (value: { type?: () => string; text?: () => string; message?: string }) => void) => void;
  evaluate: <T, A>(code: (arg: A) => T | Promise<T>, arg: A) => Promise<T>;
  waitForFunction: <A>(code: (arg: A) => boolean, arg: A, options: { timeout: number }) => Promise<unknown>;
  click: (selector: string) => Promise<void>;
  waitForTimeout: (ms: number) => Promise<void>;
  locator: (selector: string) => Locator;
  close: () => Promise<void>;
};
type Browser = { newPage: (options: Record<string, unknown>) => Promise<Page>; close: () => Promise<void>; version: () => string };

function loadPlaywright(): { chromium: { launch: (options: { args: string[] }) => Promise<Browser> } } {
  try {
    return createRequire(import.meta.url)('playwright') as ReturnType<typeof loadPlaywright>;
  } catch {
    throw new Error('NOT RUN: the browser smoke test needs Playwright with Chromium in the environment (it is not a repository dependency).');
  }
}

const launch = (): Promise<Browser> => loadPlaywright().chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

/** Pixel statistics of a stage screenshot: character pixels, their bounding box, and pixels near each given colour. */
type Measure = {
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
  readonly box: { left: number; top: number; right: number; bottom: number };
  readonly counts: Record<string, number>;
  readonly sha256: string;
};

function measure(png: Buffer, wanted: Record<string, readonly number[]> = {}): Measure {
  const { width, height, rgba } = decodePng(png);
  let pixels = 0;
  let box = { left: width, top: height, right: -1, bottom: -1 };
  const counts: Record<string, number> = Object.fromEntries(Object.keys(wanted).map((name) => [name, 0]));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const pixel = [rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0];
      if (pixel.some((value, channel) => Math.abs(value - (background[channel] ?? 0)) > 8)) {
        pixels += 1;
        box = { left: Math.min(box.left, x), top: Math.min(box.top, y), right: Math.max(box.right, x), bottom: Math.max(box.bottom, y) };
      }
      for (const [name, colour] of Object.entries(wanted)) if (pixel.every((value, channel) => Math.abs(value - (colour[channel] ?? 0)) <= 6)) counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return { width, height, pixels, box, counts, sha256: createHash('sha256').update(rgba).digest('hex') };
}

const snapshot = (page: Page): Promise<Snapshot> => page.evaluate(() => (globalThis as unknown as { aiggViewer: { snapshot: () => Snapshot } }).aiggViewer.snapshot(), null);
const waitStatus = (page: Page): Promise<unknown> =>
  page.waitForFunction(
    () => {
      const viewer = (globalThis as unknown as { aiggViewer?: { snapshot: () => { status: string } } }).aiggViewer;
      return viewer !== undefined && viewer.snapshot().status !== 'loading';
    },
    null,
    { timeout: 90_000 }
  );
/** Waits until the current track time reaches `time` seconds, then pauses the animation for a stable screenshot. */
async function pauseAt(page: Page, time: number): Promise<Snapshot> {
  await page.waitForFunction(
    (at) => {
      const viewer = (globalThis as unknown as { aiggViewer: { snapshot: () => { trackTime: number | null }; pause: (value: boolean) => void } }).aiggViewer;
      const reached = (viewer.snapshot().trackTime ?? 0) >= at;
      if (reached) viewer.pause(true);
      return reached;
    },
    time,
    { timeout: 30_000 }
  );
  return snapshot(page);
}
const resume = (page: Page): Promise<void> => page.evaluate(() => (globalThis as unknown as { aiggViewer: { pause: (value: boolean) => void } }).aiggViewer.pause(false), null);

/** Opens the viewer for the given routes and collects console problems (errors, warnings, CSP reports). */
async function open(browser: Browser, routes: ReadonlyMap<string, Route>): Promise<{ page: Page; problems: string[]; close: () => Promise<void> }> {
  const started = await startServer(routes, 0);
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const problems: string[] = [];
  page.on('console', (message) => {
    const type = message.type?.() ?? '';
    if (type === 'error' || type === 'warning') problems.push(`${type}: ${message.text?.() ?? ''}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message ?? ''}`));
  await page.goto(started.url);
  await waitStatus(page);
  return {
    page,
    problems,
    close: async () => {
      await page.close();
      started.server.close();
    }
  };
}

describe.skipIf(!enabled)('viewer in headless Chromium (software WebGL)', () => {
  it('plays idle, switches to wave and back on the same skeleton, pauses, and disposes', async () => {
    const browser = await launch();
    try {
      const { page, problems, close } = await open(browser, viewerRoutes(pageRoutes(pageFolder), readExport(syntheticExport())));
      const first = await snapshot(page);
      expect(first.status, first.message).toBe('ready');
      expect(first.animation).toBe('idle');
      await page.waitForTimeout(400);
      const later = await snapshot(page);
      expect(later.trackTime ?? 0).toBeGreaterThan(first.trackTime ?? 0);
      const arm = (value: Snapshot): number => value.bones.find((bone) => bone.name === 'arm')?.rotation ?? Number.NaN;
      expect(arm(later)).not.toBeCloseTo(arm(first), 3);

      await pauseAt(page, 0.5);
      const idle = measure(await page.locator('#stage').screenshot(), colours);
      await resume(page);
      await page.click('#wave');
      const wave = await pauseAt(page, 0.5);
      expect(wave.animation).toBe('wave');
      expect(wave.sameSkeleton).toBe(true);
      expect(wave.skeletonsCreated).toBe(1);
      const raised = measure(await page.locator('#stage').screenshot(), colours);
      // Textures are drawn (both part colours), the character is inside the stage, and the wave pose looks different.
      for (const shot of [idle, raised]) {
        expect(shot.counts.body ?? 0).toBeGreaterThan(1000);
        expect(shot.counts.arm ?? 0).toBeGreaterThan(300);
        expect(shot.box.left).toBeGreaterThan(0);
        expect(shot.box.top).toBeGreaterThan(0);
        expect(shot.box.right).toBeLessThan(shot.width - 1);
        expect(shot.box.bottom).toBeLessThan(shot.height - 1);
      }
      expect(raised.sha256).not.toBe(idle.sha256);
      expect(raised.box.top).toBeLessThan(idle.box.top);

      // While paused, the time does not change. After resume, it does.
      await page.waitForTimeout(300);
      expect((await snapshot(page)).trackTime).toBe(wave.trackTime);
      await resume(page);
      await page.waitForTimeout(300);
      expect((await snapshot(page)).trackTime ?? 0).toBeGreaterThan(wave.trackTime ?? 0);

      await page.click('#idle');
      const back = await snapshot(page);
      expect(back.animation).toBe('idle');
      expect(back.sameSkeleton).toBe(true);
      expect(back.skeletonsCreated).toBe(1);

      await page.evaluate(() => (globalThis as unknown as { aiggViewer: { dispose: () => void } }).aiggViewer.dispose(), null);
      const disposed = await page.evaluate(() => ({ elements: document.querySelectorAll('spine-skeleton').length, status: document.getElementById('status')?.dataset.status }), null);
      expect(disposed).toEqual({ elements: 0, status: 'disposed' });
      expect(problems).toEqual([]);
      await close();
    } finally {
      await browser.close();
    }
  });

  it('shows a clear error when an export file cannot be loaded', async () => {
    const browser = await launch();
    try {
      const routes = viewerRoutes(pageRoutes(pageFolder), readExport(syntheticExport()));
      for (const missing of ['export/character.atlas', 'export/parts.png', 'viewer.json']) {
        const partial = new Map(routes);
        partial.delete(missing);
        const { page, close } = await open(browser, partial);
        const state = await snapshot(page);
        expect(state.status, missing).toBe('error');
        expect(state.message, missing).toMatch(/^Error: /);
        const shown = await page.evaluate(() => ({ text: document.getElementById('status')?.textContent ?? '', role: document.getElementById('status')?.getAttribute('role') }), null);
        expect(shown.role).toBe('alert');
        expect(shown.text).toBe(state.message);
        await close();
      }
    } finally {
      await browser.close();
    }
  });

  it.skipIf(realExport === undefined)('plays the real export and writes screenshots (AIGG_VIEWER_EXPORT)', async () => {
    const bundle = readExport(realExport as string);
    const named = process.env.AIGG_VIEWER_OUT;
    if (named) mkdirSync(named, { recursive: true });
    const out = named ?? mkdtempSync(join(tmpdir(), 'aigg-viewer-smoke-'));
    const browser = await launch();
    try {
      const { page, problems, close } = await open(browser, viewerRoutes(pageRoutes(pageFolder), bundle));
      const ready = await snapshot(page);
      expect(ready.status, ready.message).toBe('ready');
      const shots: Record<string, unknown>[] = [];
      const capture = async (name: string, state: Snapshot): Promise<Measure> => {
        const png = await page.locator('#stage').screenshot();
        writeFileSync(join(out, `${name}.png`), png);
        const result = measure(png);
        shots.push({ name, animation: state.animation, trackTime: state.trackTime, characterPixels: result.pixels, box: result.box, sha256: result.sha256 });
        return result;
      };
      const idle = await capture('1-idle', await pauseAt(page, 0.5));
      await resume(page);
      await page.click('#wave');
      const raised = await capture('2-wave-arm-raised', await pauseAt(page, 0.6));
      await resume(page);
      const other = await capture('3-wave-later', await pauseAt(page, 1.0));
      await resume(page);
      await page.click('#idle');
      const back = await snapshot(page);
      const summary = {
        format: 'aigg.mvp-c.browser-smoke/0.1',
        chromium: browser.version(),
        node: process.version,
        viewport,
        export: {
          folder: bundle.folder,
          skeleton: bundle.skeleton.name,
          sha256: bundle.skeleton.sha256,
          atlas: bundle.atlas.name,
          pages: bundle.pages.map((item) => ({ name: item.name, sha256: item.sha256 }))
        },
        ready: ready.message,
        shots,
        backToIdle: back.animation,
        sameSkeleton: back.sameSkeleton,
        skeletonsCreated: back.skeletonsCreated,
        consoleProblems: problems
      };
      writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
      for (const shot of [idle, raised, other]) {
        expect(shot.pixels).toBeGreaterThan(10000);
        expect(shot.box.left).toBeGreaterThan(0);
        expect(shot.box.top).toBeGreaterThan(0);
        expect(shot.box.right).toBeLessThan(shot.width - 1);
        expect(shot.box.bottom).toBeLessThan(shot.height - 1);
      }
      expect(new Set([idle.sha256, raised.sha256, other.sha256]).size).toBe(3);
      expect(back.animation).toBe('idle');
      expect(back.sameSkeleton).toBe(true);
      expect(problems).toEqual([]);
      await close();
    } finally {
      await browser.close();
    }
  });
});
