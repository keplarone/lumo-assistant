/** Vite server for the mascot playground, the preview page and the Playwright harness pages. */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  server: { port: 5179, strictPort: true },
  build: {
    outDir: resolve(here, '../dist-harness'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(here, 'index.html'),
        render: resolve(here, 'render.html'),
        host: resolve(here, 'host.html'),
        preview: resolve(here, 'preview.html'),
      },
    },
  },
});
