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
  // The download page and the three legal pages are all linked from somewhere.
  expect([...seen.keys()].sort()).toEqual(expect.arrayContaining(['/', '/licenses/', '/privacy/', '/terms/']));
  const broken: string[] = [];
  for (const [target, anchors] of seen) {
    const res = await request.get(target);
    if (res.status() !== 200) {
      broken.push(`${target} -> ${res.status()}`);
      continue;
    }
    // Internal links must point at real pages, not at redirect stubs.
    if ((await res.text()).includes('http-equiv="refresh"')) broken.push(`${target} (redirect stub)`);
    if (anchors.size) {
      await page.goto(target);
      for (const id of anchors) {
        if ((await page.locator(`[id="${id}"]`).count()) === 0) broken.push(`${target}#${id} (missing anchor)`);
      }
    }
  }
  expect(broken).toEqual([]);
});

test('footer links the privacy policy and terms on every page', async ({ page }) => {
  for (const path of PAGES) {
    await page.goto(path);
    const footer = page.locator('footer.site-footer');
    await expect(footer.getByRole('link', { name: 'Privacy' }), path).toHaveAttribute('href', '/privacy/');
    await expect(footer.getByRole('link', { name: 'Terms' }), path).toHaveAttribute('href', '/terms/');
  }
});
