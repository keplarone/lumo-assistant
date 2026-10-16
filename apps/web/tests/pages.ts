/** Every page of the site, for the e2e tests. Keep in sync with src/pages. */
export const PAGES = ['/', '/privacy/', '/terms/', '/licenses/', '/404.html'] as const;

/** Old routes and where astro.config.mjs redirects them. Keep in sync with its `redirects`. */
export const REDIRECTS: Record<string, string> = {
  '/features/': '/',
  '/how-it-works/': '/',
  '/integrations/': '/',
  '/pricing/': '/',
  '/docs/': '/',
  '/support/': '/',
  '/security/': '/',
  '/download/': '/',
  '/legal/': '/',
  '/legal/privacy/': '/privacy/',
  '/legal/terms/': '/terms/',
  '/legal/licenses/': '/licenses/',
};
