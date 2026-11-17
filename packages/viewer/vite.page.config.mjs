import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

// Browser build of the viewer page: src/page/index.html and its module go to dist/page/ with relative URLs.
// The official Spine web runtime (@esotericsoftware/spine-webcomponents, a pinned root development dependency) is bundled into the page.
// The node build (vite.config.mjs) runs first, so this build must not empty dist/.
export default defineConfig({
  root: fileURLToPath(new URL('src/page/', import.meta.url)),
  base: './',
  logLevel: 'silent',
  envDir: false,
  publicDir: false,
  resolve: { alias: { '@viewer': fileURLToPath(new URL('src/', import.meta.url)) } },
  build: {
    outDir: fileURLToPath(new URL('dist/page/', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    sourcemap: false,
    reportCompressedSize: false,
    modulePreload: { polyfill: false }
  }
});
