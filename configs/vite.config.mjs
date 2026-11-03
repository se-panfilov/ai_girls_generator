import { join } from 'node:path';

import { defineConfig } from 'vite';

/** Shared Node.js build settings for a library or CLI package. Resolve paths from each package root. */
export function nodePackageConfig({ root, namespace, modules }) {
  const source = join(root, 'src');
  return defineConfig({
    root,
    logLevel: 'silent',
    envDir: false,
    resolve: { alias: { [`@${namespace}`]: source } },
    build: {
      target: 'node26',
      minify: false,
      sourcemap: false,
      emptyOutDir: false,
      copyPublicDir: false,
      reportCompressedSize: false,
      lib: { entry: modules.map((name) => join(source, `${name}.ts`)), formats: ['es'] },
      rolldownOptions: {
        external: [/^node:/],
        output: { preserveModules: true, preserveModulesRoot: source, entryFileNames: 'src/[name].js' }
      }
    }
  });
}
