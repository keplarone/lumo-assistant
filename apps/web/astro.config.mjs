// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

/** Canonical origin: the production domain. SITE_URL overrides it only for staging or preview deploys. */
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

/**
 * The site is a single download page. Every page that used to exist redirects, so old links keep
 * working: product pages go to the download page, the legal pages to their new short paths.
 */
const redirects = {
  ...Object.fromEntries(
    [
      '/features',
      '/how-it-works',
      '/integrations',
      '/pricing',
      '/docs',
      '/support',
      '/security',
      '/download',
      '/legal',
    ].map((from) => [from, '/']),
  ),
  '/legal/privacy': '/privacy/',
  '/legal/terms': '/terms/',
  '/legal/licenses': '/licenses/',
};

export default defineConfig({
  site,
  redirects,
  output: 'static',
  devToolbar: { enabled: false },
  trailingSlash: 'ignore',
  build: { format: 'directory', inlineStylesheets: 'auto' },
  integrations: [react(), sitemap({ filter: (page) => !page.includes('/404') }), stillRoutes()],
  vite: {
    ssr: { noExternal: ['@lumo/ui', '@lumo/mascot'] },
  },
});
