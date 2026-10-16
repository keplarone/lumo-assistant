import { test, expect } from '@playwright/test';

test.describe('hero mascot', () => {
  test('renders a WebGL canvas when WebGL is available', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto('/');
    const stage = page.locator('.hero-stage');
    await expect(stage).toHaveAttribute('data-webgl', 'true');
    await expect(stage.locator('canvas')).toHaveCount(1, { timeout: 30_000 });
    await expect(stage).toHaveAttribute('data-live', 'true', { timeout: 30_000 });
    // The still is hidden from assistive tech once the live mascot is up; the live host is labelled.
    await expect(stage.locator('img.stage-still')).toHaveAttribute('alt', '');
    await expect(stage.locator('[role="img"][aria-label^="Lumo"]')).toHaveCount(1);
    // The "wave" control triggers a reaction without errors.
    await stage.getByRole('button', { name: 'Wave at Lumo' }).click();
    await page.waitForTimeout(600);
    expect(errors).toEqual([]);
  });

  test('shows the static fallback with JavaScript disabled', async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto('/');
    const still = page.locator('.hero-stage img.stage-still');
    await expect(still).toBeVisible();
    expect(await still.getAttribute('alt')).toMatch(/Lumo/);
    expect(await still.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect(page.locator('canvas')).toHaveCount(0);
    await ctx.close();
  });

  test('keeps the static fallback when WebGL is unavailable', async ({ page }) => {
    await page.addInitScript(() => {
      const proto = HTMLCanvasElement.prototype as unknown as { getContext: (type: string, ...rest: unknown[]) => unknown };
      const orig = proto.getContext;
      proto.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (/webgl/.test(type)) return null;
        return orig.call(this, type, ...rest);
      };
    });
    await page.goto('/');
    const stage = page.locator('.hero-stage');
    await expect(stage).toHaveAttribute('data-webgl', 'false');
    await page.waitForTimeout(1500);
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect(stage.locator('img.stage-still')).toBeVisible();
  });
});

test.describe('prefers-reduced-motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('no live motion until the visitor opts in', async ({ page }) => {
    await page.goto('/');
    const stage = page.locator('.hero-stage');
    await expect(stage).toHaveAttribute('data-webgl', 'true');
    await page.waitForTimeout(1500);
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect(stage.locator('img.stage-still')).toBeVisible();
    await stage.getByRole('button', { name: /Show Lumo live/ }).click();
    await expect(stage.locator('canvas')).toHaveCount(1, { timeout: 30_000 });
  });
});
