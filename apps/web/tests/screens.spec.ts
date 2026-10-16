/**
 * Review screenshots (not pixel assertions) of the download page, saved to test-results/screens/:
 * the first screen with the live mascot, and the whole page, at 1440px and 390px.
 */
import { test, expect } from '@playwright/test';

const OUT = 'test-results/screens';

for (const vp of [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'mobile-390', width: 390, height: 844 },
]) {
  test(`download page screenshots ${vp.name}`, async ({ browser }) => {
    test.setTimeout(90_000);
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.locator('.hero-stage')).toHaveAttribute('data-live', 'true', { timeout: 30_000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/home-${vp.name}.png` });
    await page.screenshot({ path: `${OUT}/home-${vp.name}-full.png`, fullPage: true });
    await ctx.close();
  });
}
