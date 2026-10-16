/**
 * Vite server for the mascot playground and the Playwright harness pages.
 *
 * `virtual:lumo-reference` serves the ORIGINAL character code from docs/reference/lumo-mascot.html:
 * the `createLumoFactory` script is sliced out of the HTML at request time and exported as-is, so
 * the reference file is never copied or edited. It runs on three r149 (`three-r149`, an npm alias
 * of three@0.149.0 installed locally; no CDN).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const REFERENCE_HTML = resolve(here, '../../../docs/reference/lumo-mascot.html');
const VIRTUAL = 'virtual:lumo-reference';

export function extractReferenceFactory(html: string): string {
  const start = html.indexOf('function createLumoFactory(THREE) {');
  if (start < 0) throw new Error('createLumoFactory not found in the reference HTML');
  const end = html.indexOf('</script>', start);
  if (end < 0) throw new Error('unterminated reference <script>');
  return html.slice(start, end);
}

function lumoReference(): Plugin {
  return {
    name: 'lumo-reference',
    resolveId(id) {
      return id === VIRTUAL ? '\0' + VIRTUAL : null;
    },
    load(id) {
      if (id !== '\0' + VIRTUAL) return null;
      this.addWatchFile(REFERENCE_HTML);
      return `// Sliced verbatim from docs/reference/lumo-mascot.html\nexport ${extractReferenceFactory(readFileSync(REFERENCE_HTML, 'utf8'))}`;
    },
  };
}

export default defineConfig({
  root: here,
  plugins: [react(), lumoReference()],
  server: { port: 5179, strictPort: true },
  build: {
    outDir: resolve(here, '../dist-harness'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(here, 'index.html'),
        render: resolve(here, 'render.html'),
        host: resolve(here, 'host.html'),
      },
    },
  },
});
