// Vite builds the browser client (client/ → dist/client/). See AGENTS.md « Commands ».
// - `npm run dev`   : the Express server runs Vite as middleware on the same port (hot reload, no build).
// - `npm run build` : production bundle in dist/client/, served by Express when it exists.
// Module stylesheets (loadCss('/modules/…css')) and the i18n dictionaries are still fetched at run time: Express
// serves them from client/ in every mode.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(ROOT, 'client'),
  plugins: [react()],
  publicDir: false,
  resolve: {
    // The client imports the shared rules modules as '/shared/x.js' (same URL the server used to serve).
    alias: [
      { find: /^\/shared\//, replacement: `${path.join(ROOT, 'shared')}/` },
      // TRANSITIONAL (React migration): unconverted modules still import their hooks from Preact.
      { find: /^preact\/hooks$/, replacement: 'react' },
    ],
  },
  server: {
    fs: { allow: [ROOT] },
  },
  build: {
    outDir: path.join(ROOT, 'dist', 'client'),
    emptyOutDir: true,
    // Not 'assets/': /assets/… is the server's media folder (Foundry art, music).
    assetsDir: 'build',
    sourcemap: true,
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
});
