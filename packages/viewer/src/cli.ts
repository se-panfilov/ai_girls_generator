#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { exportReport, readExport, safeText, ViewerError } from '@viewer/exportbundle';
import { defaultPort, pageRoutes, startServer, viewerRoutes } from '@viewer/server';

export const reportFormat = 'aigg.mvp-c.viewer/0.1';

const help = `Usage: aigg-viewer <export-folder> [options]

Play a Spine 4.3 export (skeleton JSON, text atlas, PNG pages) in the official Spine web runtime on a local page.
The folder is read once and is not changed. The server listens on 127.0.0.1 only. Stop it with Ctrl+C.

Options:
  --port <n>          the local port (default ${defaultPort}; 0 selects a free port)
  --skeleton <name>   the skeleton JSON file name in the folder, when the folder has more than one
  --atlas <name>      the atlas file name in the folder, when the folder has more than one
  --check             check the folder, write the JSON report, and stop (no server)
  --help              show this help

Output: one JSON report on stdout. Messages for the user go to stderr.
Exit status: 0 success, 1 the export is not usable, 2 usage error.`;

const pageFolder = fileURLToPath(new URL('../page/', import.meta.url));

type Exit = { code: number; report: Record<string, unknown> };

function failure(error: unknown): Exit {
  if (error instanceof ViewerError) {
    const code = error.code === 'E_USAGE' ? 2 : 1;
    return { code, report: { format: reportFormat, status: 'FAIL', error: { code: error.code, message: safeText(error.message, 500) } } };
  }
  return { code: 1, report: { format: reportFormat, status: 'FAIL', error: { code: 'E_INTERNAL', message: safeText(error instanceof Error ? error.message : error, 500) } } };
}

function print(report: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: { port: { type: 'string' }, skeleton: { type: 'string' }, atlas: { type: 'string' }, check: { type: 'boolean' }, help: { type: 'boolean' } }
    });
  } catch (error) {
    process.stderr.write(`${safeText(error instanceof Error ? error.message : error, 300)}\n\n${help}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(`${help}\n`);
    return 0;
  }
  if (positionals.length !== 1) {
    process.stderr.write(`Give exactly one export folder.\n\n${help}\n`);
    return 2;
  }
  const port = values.port === undefined ? defaultPort : /^\d{1,5}$/.test(values.port) ? Number(values.port) : Number.NaN;
  if (!Number.isInteger(port) || port > 65535) {
    process.stderr.write('--port must be a number from 0 to 65535.\n');
    return 2;
  }
  try {
    const bundle = readExport(positionals[0] as string, { ...(values.skeleton === undefined ? {} : { skeleton: values.skeleton }), ...(values.atlas === undefined ? {} : { atlas: values.atlas }) });
    const report = { format: reportFormat, status: 'PASS', export: exportReport(bundle) };
    if (values.check) {
      print(report);
      return 0;
    }
    const routes = viewerRoutes(pageRoutes(pageFolder), bundle);
    const started = await startServer(routes, port);
    print({ ...report, status: 'SERVING', url: started.url });
    process.stderr.write(`Viewer: ${started.url}\nOpen this address in a browser. Stop the server with Ctrl+C.\n`);
    const stop = (): void => {
      started.server.close();
      started.server.closeAllConnections();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await new Promise<void>((resolve) =>
      started.server.once('close', () => {
        resolve();
      })
    );
    return 0;
  } catch (error) {
    const exit = failure(error);
    print(exit.report);
    const detail = exit.report.error as { message: string };
    process.stderr.write(`Error: ${detail.message}\n`);
    return exit.code;
  }
}

process.exitCode = await main(process.argv.slice(2));
