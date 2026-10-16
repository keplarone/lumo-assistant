import { test, expect } from '@playwright/test';
import { PAGES } from './pages';

test.describe('360px viewport', () => {
  test.use({ viewport: { width: 360, height: 760 } });
  for (const path of PAGES) {
    test(`${path} has no horizontal overflow`, async ({ page }) => {
      await page.goto(path);
      await page.waitForTimeout(300);
      const { scroll, client } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(client);
    });
  }
});

test('header is the logo only, with the owl icon', async ({ page }) => {
  await page.goto('/privacy/');
  const brand = page.locator('header.site-header a.brand');
  await expect(brand).toHaveAttribute('href', '/');
  await expect(brand).toHaveText('Lumo');
  const logo = brand.locator('img.logo-mark');
  await expect(logo).toHaveAttribute('src', '/logo-80.png');
  expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.locator('header nav')).toHaveCount(0);
});
