import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readExport, ViewerError } from '@viewer/exportbundle';
import { answer, contentSecurityPolicy, pageRoutes, type Route, startServer, viewerConfig, viewerRoutes } from '@viewer/server';
import { describe, expect, it } from 'vitest';

import { syntheticExport } from './helpers';

const page = new Map<string, Route>([['index.html', { body: Buffer.from('<!doctype html>'), type: 'text/html; charset=utf-8' }]]);
const routes = viewerRoutes(page, readExport(syntheticExport()));
const port = 5180;
const okHost = `127.0.0.1:${port}`;

describe('request rules', () => {
  it('serves the page, viewer.json, and the checked export files under export/', () => {
    expect(answer(routes, 'GET', '/', okHost, port).status).toBe(200);
    expect(answer(routes, 'GET', '/export/character.json', okHost, port).status).toBe(200);
    expect(answer(routes, 'HEAD', '/export/parts.png?x=1', `localhost:${port}`, port).type).toBe('image/png');
    const config = JSON.parse(answer(routes, 'GET', '/viewer.json', okHost, port).body.toString('utf8')) as Record<string, unknown>;
    expect(config).toEqual({ skeleton: 'export/character.json', atlas: 'export/character.atlas', animations: ['idle', 'wave'], required: ['idle', 'wave'], pages: ['export/parts.png'] });
  });

  it('answers only known paths: no parent folders, no encoded paths, no other files', () => {
    for (const url of ['/export/../package.json', '/export/%2e%2e/x', '/etc/passwd', '/export/', '/export/character.json/', '/index.html/..']) {
      expect(answer(routes, 'GET', url, okHost, port).status, url).toBe(404);
    }
    expect(answer(routes, 'GET', '//evil.example/x', okHost, port).status).toBe(400);
    expect(answer(routes, 'GET', 'http://127.0.0.1/', okHost, port).status).toBe(400);
  });

  it('refuses other methods and other Host headers (DNS rebinding)', () => {
    expect(answer(routes, 'POST', '/', okHost, port).status).toBe(405);
    expect(answer(routes, 'PUT', '/export/parts.png', okHost, port).status).toBe(405);
    expect(answer(routes, 'GET', '/', 'evil.example', port).status).toBe(421);
    expect(answer(routes, 'GET', '/', `127.0.0.1:${port + 1}`, port).status).toBe(421);
    expect(answer(routes, 'GET', '/', undefined, port).status).toBe(421);
  });

  it('gives relative export URLs to the page', () => {
    const config = viewerConfig(readExport(syntheticExport()));
    for (const url of [config.skeleton, config.atlas, ...config.pages]) expect(url).toMatch(/^export\/[A-Za-z0-9._-]+$/);
  });

  it('stops with a clear error when the page is not built', () => {
    expect(() => pageRoutes(join(mkdtempSync(join(tmpdir(), 'aigg-viewer-')), 'missing'))).toThrow(ViewerError);
  });
});

describe('local server', () => {
  it('listens on 127.0.0.1 and sends the security headers', async () => {
    const started = await startServer(routes, 0);
    try {
      expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const address = started.server.address();
      expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');
      const response = await fetch(`${started.url}export/parts.png`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toBe(contentSecurityPolicy);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect((await fetch(`${started.url}missing.png`)).status).toBe(404);
    } finally {
      started.server.close();
    }
  });

  it('reports a port that is in use', async () => {
    const first = await startServer(routes, 0);
    try {
      await expect(startServer(routes, first.port)).rejects.toMatchObject({ code: 'E_PORT' });
    } finally {
      first.server.close();
    }
  });
});
