import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { colours } from './d26/assets';
import { type AnimatedCharacter } from './d26/controller';
import { type DrawItem, drawList, logicalPoint, rendererPage } from './d26/render';
import { loadSpike, makeCharacter, moduleOf, type Spike, spine } from './d26/setup';

// D26 spike: browser visual smoke test with software WebGL (opt-in).
// Run: AIGG_VISUAL_SMOKE=1 npx vitest run test/d26-visual.test.ts (in packages/rig-runtime).
// It needs Playwright with Chromium. The repository does not install them (no new dependency for a spike): the test resolves
// `playwright` from the environment and fails with a clear message when it is not there. Screenshots go to AIGG_VISUAL_OUT
// (default: <tmp>/aigg-d26-visual). Nothing is written into the repository.

const enabled = process.env.AIGG_VISUAL_SMOKE === '1';
const view = { x0: -300, y0: 1340, scale: 1, width: 800, height: 1380 };
const frame = 1 / 60;

type Rgba = readonly number[];
type Sample = { readonly name: string; readonly at: readonly [number, number]; readonly expected: Rgba };
type Scene = { readonly name: string; readonly eyeFrame: number; readonly items: readonly DrawItem[]; readonly samples: readonly Sample[] };
type Browser = { newPage: () => Promise<Page>; close: () => Promise<void>; version: () => string };
type Page = {
  goto: (url: string) => Promise<unknown>;
  evaluate: <T>(code: string) => Promise<T>;
  locator: (selector: string) => { screenshot: (options: { path: string }) => Promise<unknown> };
};

function loadPlaywright(): { chromium: { launch: (options: { args: string[] }) => Promise<Browser> } } {
  try {
    return createRequire(import.meta.url)('playwright') as ReturnType<typeof loadPlaywright>;
  } catch {
    throw new Error('NOT RUN: the visual smoke test needs Playwright with Chromium in the environment (it is not a repository dependency).');
  }
}

const toScreen = ([x, y]: [number, number]): [number, number] => [Math.floor((x - view.x0) * view.scale), Math.floor((view.y0 - y) * view.scale)];

function scene(name: string, spike: Spike, animated: AnimatedCharacter, hair: Rgba): Scene {
  const skeleton = animated.skeleton;
  const eyes = spike.rig.sequences.get('eyes');
  const index = (animated.sequenceAttachment('eyes') as spine.RegionAttachment).sequence.resolveIndex(skeleton.findSlot('eyes')?.appliedPose as spine.SlotPose);
  const template = (slot: string): { x: number; y: number; width: number; height: number } => {
    const found = slot === 'eyes' ? eyes : spike.rig.templates.get(slot);
    if (!found) throw new Error(`No template ${slot}`);
    return found;
  };
  const at = (slot: string, x: number, y: number): [number, number] => toScreen(logicalPoint(skeleton, slot, template(slot), x, y));
  // Eye colour at three heights of each eye column: lid top (14), middle (30) and low (36). See eyeFrames in test/d26/assets.ts.
  const eye = (y: number): Rgba => ((index === 0 && y >= 8) || (index === 1 && y >= 22) || (index === 2 && y >= 34 && y < 38) ? colours.eyes : colours.skin);
  const samples: Sample[] = [
    { name: 'left eye top', at: at('eyes', 42, 14), expected: eye(14) },
    { name: 'left eye middle', at: at('eyes', 42, 30), expected: eye(30) },
    { name: 'left eye low', at: at('eyes', 42, 36), expected: eye(36) },
    { name: 'right eye top', at: at('eyes', 98, 14), expected: eye(14) },
    { name: 'right eye low', at: at('eyes', 98, 36), expected: eye(36) },
    { name: 'between the eyes', at: at('eyes', 70, 30), expected: colours.skin },
    { name: 'eye area left of the eyes', at: at('eyes', 20, 36), expected: colours.skin },
    { name: 'back hair', at: at('hair_back', 15, 390), expected: hair },
    { name: 'front hair fringe', at: at('hair_front', 150, 20), expected: hair }
  ];
  return { name, eyeFrame: index, items: drawList(skeleton, spine.RegionAttachment), samples };
}

/** Plays run with blinking and a tail, captures open/partly closed/closed frames, changes the hair, and captures again. */
async function scenes(spike: Spike): Promise<Scene[]> {
  const { animated } = await makeCharacter(spike);
  animated.playPrimary('run');
  const result: Scene[] = [];
  const capture = (name: string, wanted: number, hair: Rgba): void => {
    for (let index = 0; index < 60 * 10; index += 1) {
      animated.step(frame);
      const current = (animated.sequenceAttachment('eyes') as spine.RegionAttachment).sequence.resolveIndex(animated.skeleton.findSlot('eyes')?.appliedPose as spine.SlotPose);
      if (current === wanted) {
        result.push(scene(name, spike, animated, hair));
        return;
      }
    }
    throw new Error(`The eye frame ${wanted} did not occur in 10 s.`);
  };
  capture('1-hair-a-open', 0, colours.hairA);
  capture('2-hair-a-partly-closed', 1, colours.hairA);
  capture('3-hair-a-closed', 2, colours.hairA);
  await animated.character.setModules([moduleOf(spike, 'hair.b')]);
  capture('4-hair-b-open', 0, colours.hairB);
  capture('5-hair-b-partly-closed', 1, colours.hairB);
  capture('6-hair-b-closed', 2, colours.hairB);
  await animated.dispose();
  return result;
}

function serve(files: ReadonlyMap<string, string | Buffer>): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').replace(/^\//, '') || 'index.html';
    const body = path === 'index.html' ? rendererPage : files.get(path);
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': path.endsWith('.png') ? 'image/png' : path.endsWith('.html') ? 'text/html' : 'text/plain' }).end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/` });
    });
  });
}

describe.skipIf(!enabled)('D26 visual smoke test (software WebGL)', () => {
  it('draws the real spine-core poses: eye frames at the right place, hair A then hair B, tail present; the same scene twice gives the same pixels', async () => {
    const spike = loadSpike();
    const list = await scenes(spike);
    const out = process.env.AIGG_VISUAL_OUT ?? join(tmpdir(), 'aigg-d26-visual');
    mkdirSync(out, { recursive: true });
    const { chromium } = loadPlaywright();
    const { server, url } = await serve(spike.assets.files);
    const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    try {
      const page = await browser.newPage();
      await page.goto(`${url}index.html`);
      const renderer = await page.evaluate<string>(`window.spike.setup(${view.width}, ${view.height})`);
      const pages = [...spike.assets.files.keys()].filter((path) => path.endsWith('.png'));
      await page.evaluate(`Promise.all(${JSON.stringify(pages)}.map((name) => window.spike.loadPage(name, ${JSON.stringify(url)} + name)))`);
      const report: Record<string, unknown>[] = [];
      for (const item of list) {
        const payload = JSON.stringify({
          view,
          items: item.items,
          samples: item.samples.map(({ name, at }) => ({ name, at })),
          counts: [
            { name: 'eyes', rgba: colours.eyes },
            { name: 'tail', rgba: colours.tail }
          ]
        });
        const first = await page.evaluate<{ digest: string; samples: { name: string; rgba: number[] }[]; counts: { name: string; pixels: number }[] }>(`window.spike.draw(${payload})`);
        await page.locator('canvas').screenshot({ path: join(out, `${item.name}.png`) });
        const second = await page.evaluate<{ digest: string }>(`window.spike.draw(${payload})`);
        const mismatches = item.samples.filter((sample, index) => JSON.stringify(first.samples[index]?.rgba) !== JSON.stringify(sample.expected));
        report.push({
          scene: item.name,
          eyeFrame: item.eyeFrame,
          pixelSha256: first.digest,
          colourPixels: first.counts,
          repeatSame: second.digest === first.digest,
          samples: item.samples.map((sample, index) => ({ name: sample.name, at: sample.at, expected: sample.expected, actual: first.samples[index]?.rgba }))
        });
        expect(second.digest, item.name).toBe(first.digest);
        expect(
          mismatches.map((sample) => sample.name),
          item.name
        ).toEqual([]);
        // The eye pixels are exactly the frame content (2 eyes x 24 px x 32, 18 or 4 rows): no frame is shifted, cut or doubled.
        expect(first.counts[0]?.pixels, item.name).toBe([1536, 864, 192][item.eyeFrame]);
        // The tail module is drawn (a large part of its 260x260 rectangle is visible behind the body).
        expect(first.counts[1]?.pixels, item.name).toBeGreaterThan(15000);
      }
      const summary = { renderer, chromium: browser.version(), node: process.version, scenes: report };
      writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
      writeFileSync(join(out, 'summary.sha256'), `${createHash('sha256').update(JSON.stringify(report)).digest('hex')}\n`);
      expect(renderer).toMatch(/SwiftShader/);
      expect(list.map((item) => item.eyeFrame)).toEqual([0, 1, 2, 0, 1, 2]);
    } finally {
      await browser.close();
      server.close();
    }
  });
});
