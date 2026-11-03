// Run an npm script in all workspace packages. Exit with success when packages/ has no package yet.
// `npm run <script> --workspaces` stops with "No workspaces found" before the first package exists.
// Usage: npm run <root script>, which calls: node scripts/workspaces.mjs <script> [--if-present]
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { root, safe } from './ci/lib.mjs';

const scriptName = /^[a-z][a-z0-9:-]{0,63}$/;

// Directories in packages/ with a package.json file. The configuration check validates their content.
export function workspaceDirectories(base = root) {
  const directory = join(base, 'packages');
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && existsSync(join(directory, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort();
}

function main() {
  const [script, ...options] = process.argv.slice(2);
  if (!script || !scriptName.test(script) || options.some((option) => option !== '--if-present') || options.length > 1) {
    throw new Error('Usage: workspaces.mjs <script> [--if-present]');
  }
  if (workspaceDirectories().length === 0) {
    console.log(`No package in packages/. The ${script} script has nothing to run.`);
    return;
  }
  // npm sets npm_execpath to its CLI module. Starting it with the current Node.js avoids a shell and the Windows npm.cmd wrapper.
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Start this script with npm run, so that npm_execpath is set.');
  const result = spawnSync(process.execPath, [npm, 'run', script, '--workspaces', ...options], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw new Error(`Cannot start npm: ${result.error.message}`, { cause: result.error });
  process.exitCode = result.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(safe(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  }
}
