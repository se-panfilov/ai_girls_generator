import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';

import { type ExportBundle, fileNamePattern, requiredAnimations, ViewerError } from '@viewer/exportbundle';

// The local HTTP server of the viewer. It listens on 127.0.0.1 only and answers GET and HEAD for a fixed table of paths.
// The table is made at start from the built page and the checked export. A request path is a key in the table, never a file path,
// so no request can read another file. Requests with another Host header are refused (protection against DNS rebinding).

export const host = '127.0.0.1';
export const defaultPort = 5180;
/** The URL folder of the export files. The page loads `export/<name>` with relative URLs. */
export const exportPrefix = 'export/';
export const maxPageFiles = 64;
export const maxPageBytes = 16 * 1024 * 1024;

export type Route = { readonly body: Buffer; readonly type: string };
export type Routes = ReadonlyMap<string, Route>;

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.atlas': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

/**
 * Content Security Policy of all answers. Scripts come only from this server. The Spine runtime loads JSON and the atlas with fetch
 * and decodes the textures through an image element. Inline styles are allowed, because the web component sets styles at run time.
 */
export const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

const securityHeaders = {
  'content-security-policy': contentSecurityPolicy,
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'x-frame-options': 'DENY'
};

/** The data that the page reads first (`viewer.json`): relative URLs of the export files and the animation names. */
export type ViewerConfig = {
  readonly skeleton: string;
  readonly atlas: string;
  readonly animations: readonly string[];
  readonly required: readonly string[];
  readonly pages: readonly string[];
};

export function viewerConfig(bundle: ExportBundle): ViewerConfig {
  return {
    skeleton: `${exportPrefix}${bundle.skeleton.name}`,
    atlas: `${exportPrefix}${bundle.atlas.name}`,
    animations: bundle.skeleton.animations,
    required: [...requiredAnimations],
    pages: bundle.pages.map((page) => `${exportPrefix}${page.name}`)
  };
}

const typeOf = (name: string): string => types[extname(name).toLowerCase()] ?? 'application/octet-stream';

/** Reads the built page folder (dist/page) into routes. Only regular files with known types; no links. */
export function pageRoutes(pageFolder: string): Map<string, Route> {
  const routes = new Map<string, Route>();
  let total = 0;
  const visit = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name);
      if (!fileNamePattern.test(entry.name)) throw new ViewerError('E_PAGE_BUILD', `The built page has an unexpected file name: ${entry.name}.`);
      if (entry.isDirectory()) {
        visit(path, `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.isFile() || lstatSync(path).isSymbolicLink()) throw new ViewerError('E_PAGE_BUILD', `The built page has an entry that is not a regular file: ${entry.name}.`);
      const type = types[extname(entry.name).toLowerCase()];
      if (type === undefined) continue;
      const body = readFileSync(path);
      total += body.length;
      if (routes.size >= maxPageFiles || total > maxPageBytes) throw new ViewerError('E_PAGE_BUILD', 'The built page is larger than expected.');
      routes.set(`${prefix}${entry.name}`, { body, type });
    }
  };
  try {
    visit(pageFolder, '');
  } catch (error) {
    if (error instanceof ViewerError) throw error;
    throw new ViewerError('E_PAGE_BUILD', 'The viewer page is not built. Run: npm run build --workspace @aigg/viewer');
  }
  if (!routes.has('index.html')) throw new ViewerError('E_PAGE_BUILD', 'The viewer page is not built. Run: npm run build --workspace @aigg/viewer');
  return routes;
}

/** All routes: the page files, viewer.json, and the export files under export/. */
export function viewerRoutes(page: ReadonlyMap<string, Route>, bundle: ExportBundle): Map<string, Route> {
  const routes = new Map(page);
  routes.set('viewer.json', { body: Buffer.from(`${JSON.stringify(viewerConfig(bundle), null, 2)}\n`), type: types['.json'] as string });
  for (const file of [bundle.skeleton, bundle.atlas, ...bundle.pages]) routes.set(`${exportPrefix}${file.name}`, { body: file.data, type: typeOf(file.name) });
  return routes;
}

export type Answer = { readonly status: number; readonly type: string; readonly body: Buffer; readonly headers?: Readonly<Record<string, string>> };

const text = (status: number, message: string): Answer => ({ status, type: 'text/plain; charset=utf-8', body: Buffer.from(`${message}\n`) });

/** The answer to one request. A pure function, so the tests can check each rule without a socket. */
export function answer(routes: Routes, method: string | undefined, url: string | undefined, hostHeader: string | undefined, port: number): Answer {
  const allowedHosts = new Set([`${host}:${port}`, `localhost:${port}`]);
  if (hostHeader === undefined || !allowedHosts.has(hostHeader.toLowerCase())) return text(421, 'Use http://127.0.0.1 with the port of the viewer.');
  if (method !== 'GET' && method !== 'HEAD') return { ...text(405, 'Only GET and HEAD are supported.'), headers: { allow: 'GET, HEAD' } };
  const raw = url ?? '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return text(400, 'Bad request path.');
  const path = raw.split(/[?#]/, 1)[0] ?? '/';
  const key = path === '/' ? 'index.html' : path.slice(1);
  const route = routes.get(key);
  if (route === undefined) return text(404, 'Not found.');
  return { status: 200, type: route.type, body: route.body };
}

function respond(routes: Routes, port: () => number, request: IncomingMessage, response: ServerResponse): void {
  const result = answer(routes, request.method, request.url, request.headers.host, port());
  response.writeHead(result.status, { ...securityHeaders, ...result.headers, 'content-type': result.type, 'content-length': String(result.body.length) });
  response.end(request.method === 'HEAD' ? undefined : result.body);
}

/** Starts the server on 127.0.0.1. Port 0 selects a free port. */
export function startServer(routes: Routes, port: number): Promise<{ server: Server; url: string; port: number }> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) return Promise.reject(new ViewerError('E_USAGE', `The port ${port} is not valid.`));
  let actual = port;
  const server = createServer((request, response) => {
    respond(routes, () => actual, request, response);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(new ViewerError('E_PORT', error.code === 'EADDRINUSE' ? `The port ${port} is in use. Select another port with --port.` : `The server did not start: ${error.code ?? 'error'}.`));
    });
    server.listen({ host, port, exclusive: true }, () => {
      const address = server.address();
      actual = typeof address === 'object' && address !== null ? address.port : port;
      resolve({ server, url: `http://${host}:${actual}/`, port: actual });
    });
  });
}
