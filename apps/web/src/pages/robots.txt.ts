import type { APIRoute } from 'astro';
import { SITE } from '../data/site';

export const GET: APIRoute = ({ site }) => {
  const sitemap = new URL('/sitemap-index.xml', site ?? SITE.url).href;
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${sitemap}\n`, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
