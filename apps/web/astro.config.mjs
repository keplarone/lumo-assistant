// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

/** Canonical origin. Set SITE_URL in the deploy environment once the production domain is final. */
const site = process.env.SITE_URL ?? 'https://lumo.keplar.one';

/**
 * Dev-only routes used by scripts/render-stills.mjs to render the static fallback images and the
 * Open Graph card from the real mascot. Only injected when LUMO_STILLS=1, so they never ship.
 * @returns {import('astro').AstroIntegration}
 */
function stillRoutes() {
  return {
    name: 'lumo-still-routes',
    hooks: {
      'astro:config:setup': ({ injectRoute, command }) => {
        if (command !== 'dev' || process.env.LUMO_STILLS !== '1') return;
        injectRoute({ pattern: '/__still', entrypoint: './src/tools/still.astro' });
        injectRoute({ pattern: '/__og', entrypoint: './src/tools/og.astro' });
      },
    },
  };
}

export default defineConfig({
  site,
  output: 'static',
  devToolbar: { enabled: false },
  trailingSlash: 'ignore',
  build: { format: 'directory', inlineStylesheets: 'auto' },
  integrations: [
    react(),
    sitemap({ filter: (page) => !page.includes('/404') }),
    stillRoutes(),
  ],
  vite: {
    ssr: { noExternal: ['@lumo/ui', '@lumo/mascot'] },
  },
});
