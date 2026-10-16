import { test, expect } from '@playwright/test';
import { PAGES } from './pages';

for (const path of PAGES) {
  test(`${path}: status, single h1, meta, canonical, social tags`, async ({ page, request }) => {
    const res = await request.get(path);
    expect(res.status()).toBe(200);

    await page.goto(path);
    await expect(page.locator('h1')).toHaveCount(1);
    expect(await page.getAttribute('html', 'lang')).toBe('en');

    const desc = await page.getAttribute('meta[name="description"]', 'content');
    expect(desc?.length ?? 0).toBeGreaterThan(40);
    const title = await page.title();
    expect(title.length).toBeGreaterThan(5);

    const canonical = await page.getAttribute('link[rel="canonical"]', 'href');
    expect(canonical).toMatch(/^https:\/\/[^/]+\//);

    for (const prop of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type']) {
      const v = await page.getAttribute(`meta[property="${prop}"]`, 'content');
      expect(v, prop).toBeTruthy();
    }
    expect(await page.getAttribute('meta[name="twitter:card"]', 'content')).toBe('summary_large_image');
    expect(await page.getAttribute('meta[name="twitter:image"]', 'content')).toMatch(/\/og\.png$/);

    // A skip link, and landmarks.
    await expect(page.locator('a.skip-link[href="#main"]')).toHaveCount(1);
    await expect(page.locator('header.site-header')).toHaveCount(1);
    await expect(page.locator('main#main')).toHaveCount(1);
    await expect(page.locator('footer.site-footer')).toHaveCount(1);
  });
}

test('unknown paths return 404 with the not-found page', async ({ request }) => {
  const res = await request.get('/this-page-does-not-exist/');
  expect(res.status()).toBe(404);
  expect(await res.text()).toContain('Lumo looked everywhere');
});

test('home has SoftwareApplication JSON-LD without ratings', async ({ page }) => {
  await page.goto('/');
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  const items = blocks.flatMap((b) => JSON.parse(b) as Record<string, unknown>[]);
  const app = items.find((i) => i['@type'] === 'SoftwareApplication');
  expect(app).toBeTruthy();
  expect(app).not.toHaveProperty('aggregateRating');
  expect(app).not.toHaveProperty('review');
});

test('robots.txt, sitemap and OG image are served', async ({ request }) => {
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toMatch(/Sitemap: https:\/\/.+\/sitemap-index\.xml/);
  expect((await request.get('/sitemap-index.xml')).status()).toBe(200);
  const sm = await request.get('/sitemap-0.xml');
  expect(sm.status()).toBe(200);
  expect(await sm.text()).not.toContain('404');
  const og = await request.get('/og.png');
  expect(og.status()).toBe(200);
  expect(og.headers()['content-type']).toBe('image/png');
});

test('no analytics code is shipped when PUBLIC_ANALYTICS_ENDPOINT is unset', async ({ request }) => {
  for (const path of PAGES) {
    const html = await (await request.get(path)).text();
    expect(html, path).not.toContain('data-endpoint');
  }
});
