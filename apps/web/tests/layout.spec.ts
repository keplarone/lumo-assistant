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

test('workflow tabs are keyboard operable', async ({ page }) => {
  await page.goto('/');
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(5);
  await tabs.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await expect(page.getByRole('tabpanel')).toContainText('Lumo works out what you mean');
  await page.keyboard.press('End');
  await expect(tabs.nth(4)).toHaveAttribute('aria-selected', 'true');
});

test('in-action walkthrough steps through with buttons', async ({ page }) => {
  await page.goto('/#in-action');
  const replay = page.getByRole('button', { name: 'Replay' });
  await expect(replay).toBeVisible();
  await replay.click();
  await expect(page.locator('.ia-transcript > li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.ia-transcript > li')).toHaveCount(2);
  await page.getByRole('button', { name: /Asks before changing/ }).click();
  await expect(page.locator('.ia-transcript > li')).toHaveCount(4);
});

test('mobile menu works without JavaScript', async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 800 } });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.locator('.nav-mobile summary').click();
  await expect(page.locator('.nav-mobile nav a[href="/docs/"]')).toBeVisible();
  await ctx.close();
});
