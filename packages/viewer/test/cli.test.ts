import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { syntheticExport } from './helpers';

// The tests run the built command (npm test builds first), as the owner does.
const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const run = (args: readonly string[]): SpawnSyncReturns<string> => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 30_000 });

describe('aigg-viewer command', () => {
  it('checks an export folder with --check and writes one JSON report', () => {
    const folder = syntheticExport();
    const result = run([folder, '--check']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as { status: string; format: string; export: { skeleton: { animations: string[] } } };
    expect(report.format).toBe('aigg.mvp-c.viewer/0.1');
    expect(report.status).toBe('PASS');
    expect(report.export.skeleton.animations).toEqual(['idle', 'wave']);
    expect(readFileSync(join(folder, 'character.json'), 'utf8')).toContain('"wave"');
  });

  it('exits with 1 and a clear message when a file is missing', () => {
    const result = run([syntheticExport((files) => files.delete('parts.png')), '--check']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'FAIL', error: { code: 'E_FILE_MISSING' } });
    expect(result.stderr).toContain('parts.png is missing');
  });

  it('exits with 2 on usage errors', () => {
    expect(run([]).status).toBe(2);
    expect(run(['a', 'b']).status).toBe(2);
    expect(run(['a', '--port', '70000']).status).toBe(2);
    expect(run(['a', '--unknown']).status).toBe(2);
    expect(run(['--help']).status).toBe(0);
  });

  it('serves the page and the export on 127.0.0.1 and stops on SIGTERM', async () => {
    const child = spawn(process.execPath, [cli, syntheticExport(), '--port', '0'], { env: { PATH: process.env.PATH ?? '' } });
    try {
      const report = await new Promise<{ status: string; url: string }>((resolve, reject) => {
        let text = '';
        child.stdout.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8');
          try {
            resolve(JSON.parse(text) as { status: string; url: string });
          } catch {
            // Wait for the complete report.
          }
        });
        child.once('exit', (code) => reject(new Error(`exit ${code}`)));
      });
      expect(report.status).toBe('SERVING');
      expect(report.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const page = await fetch(report.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('AIGG viewer');
      expect((await fetch(`${report.url}export/parts.png`)).status).toBe(200);
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
