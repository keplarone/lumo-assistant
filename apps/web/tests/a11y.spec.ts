import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PAGES } from './pages';

for (const path of PAGES) {
  test(`${path} has no serious or critical axe violations`, async ({ page }) => {
    await page.goto(path);
    await page.waitForTimeout(500);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
    const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`)).toEqual([]);
  });
}

test('home without JavaScript has no serious or critical axe violations', async ({ page, request, baseURL }) => {
  // axe cannot be injected into a page with JavaScript disabled, so analyze the server HTML with every
  // script removed instead, which is exactly what a no-JS visitor gets.
  const html = (await (await request.get('/')).text())
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace('<head>', `<head><base href="${baseURL}/">`);
  await page.route('**/*', (route) => (route.request().resourceType() === 'script' ? route.abort() : route.continue()));
  await page.goto('/robots.txt');
  await page.setContent(html, { waitUntil: 'load' });
  await expect(page.locator('canvas')).toHaveCount(0);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`)).toEqual([]);
});
