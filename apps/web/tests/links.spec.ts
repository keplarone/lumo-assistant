import { test, expect } from '@playwright/test';
import { PAGES } from './pages';

test('every internal link and in-page anchor resolves', async ({ page, request }) => {
  test.setTimeout(120_000);
  const seen = new Map<string, Set<string>>(); // target path -> anchors referenced
  for (const path of PAGES) {
    await page.goto(path);
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!));
    for (const href of hrefs) {
      if (/^(https?:|mailto:)/.test(href)) continue;
      const url = new URL(href, `http://x${path}`);
      const target = url.pathname;
      if (!seen.has(target)) seen.set(target, new Set());
      if (url.hash) seen.get(target)!.add(url.hash.slice(1));
    }
  }
  expect(seen.size).toBeGreaterThan(10);
  const broken: string[] = [];
  for (const [target, anchors] of seen) {
    const res = await request.get(target);
    if (res.status() !== 200) {
      broken.push(`${target} -> ${res.status()}`);
      continue;
    }
    if (anchors.size) {
      await page.goto(target);
      for (const id of anchors) {
        if ((await page.locator(`[id="${id}"]`).count()) === 0) broken.push(`${target}#${id} (missing anchor)`);
      }
    }
  }
  expect(broken).toEqual([]);
});

test('primary navigation links resolve', async ({ page, request }) => {
  await page.goto('/');
  const hrefs = await page.$$eval('header a[href]', (as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!));
  expect(hrefs.length).toBeGreaterThanOrEqual(8);
  for (const h of hrefs) expect((await request.get(h)).status(), h).toBe(200);
});
