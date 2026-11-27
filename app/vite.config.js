// Vite builds the browser client (client/ → dist/client/). See AGENTS.md « Commands ».
// - `npm run dev`   : the Express server runs Vite as middleware on the same port (hot reload, no build).
// - `npm run build` : production bundle in dist/client/, served by Express when it exists.
// Module stylesheets (loadCss('/modules/…css')) and the i18n dictionaries are still fetched at run time: Express
// serves them from client/ in every mode.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(ROOT, 'client'),
  publicDir: false,
  resolve: {
    // The client imports the shared rules modules as '/shared/x.js' (same URL the server used to serve).
    alias: [
      { find: /^\/shared\//, replacement: `${path.join(ROOT, 'shared')}/` },
      // The raw client loads Socket.IO from the server's own route; the bundle takes the same file from the package.
      { find: '/socket.io/socket.io.esm.min.js', replacement: path.join(ROOT, 'node_modules/socket.io-client/dist/socket.io.esm.min.js') },
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
