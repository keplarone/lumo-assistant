/**
 * Review screenshots (not pixel assertions), saved to test-results/screens/:
 * the homepage at 1440px and 390px (first screen, then the page in viewport-sized sections, because
 * very tall full-page captures wrap in headless SwiftShader), and the features page.
 */
import { test, expect, type Page } from '@playwright/test';

const OUT = 'test-results/screens';

async function sections(page: Page, prefix: string, height: number) {
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  let i = 0;
  for (let y = 0; y < total; y += height) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${OUT}/${prefix}-${String(++i).padStart(2, '0')}.png` });
  }
}

for (const vp of [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'mobile-390', width: 390, height: 844 },
]) {
  test(`home screenshots ${vp.name}`, async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.locator('.hero-stage')).toHaveAttribute('data-live', 'true', { timeout: 30_000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/home-${vp.name}-hero.png` });
    await sections(page, `home-${vp.name}-section`, vp.height);
    await ctx.close();
  });
}

test('features screenshot desktop', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('/features/');
  await page.screenshot({ path: `${OUT}/features-desktop-1440-full.png`, fullPage: true });
  await ctx.close();
});
