/**
 * Smoke test of the playground (harness/index.html, React StrictMode): every agent phase, every
 * mood and every one-shot button works without page errors while the mascot keeps rendering.
 */
import { expect, test } from '@playwright/test';
import { writeResult } from './util';

test('playground: every phase, mood and one-shot runs without errors', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  const frames = () =>
    page.evaluate(
      () =>
        (
          window as unknown as { __pg: { handle: { current: { stats(): { frames: number } } | null } } }
        ).__pg?.handle.current?.stats().frames ?? 0,
    );
  await expect.poll(frames, { timeout: 30_000 }).toBeGreaterThan(3);

  for (const b of await page.locator('button[data-phase]').all()) {
    await b.click();
    await expect(b).toHaveAttribute('aria-pressed', 'true');
  }
  for (const b of await page.locator('button[data-mood]').all()) {
    const mood = await b.getAttribute('data-mood');
    await b.click();
    await expect(page.getByTestId('mood')).toHaveText(mood!);
  }
  for (const label of [
    'blink',
    'pulse',
    'celebrate',
    'wave',
    'turn around',
    'walk right',
    'walk home',
    'move: workspace',
    'face away',
    'face viewer',
    'inbox',
    'composer',
    'approve',
    'header',
    'attend (machine)',
    'release',
    'fall asleep',
    'activity',
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
  }
  await page.getByLabel('Reduced motion (calm)').check();
  const before = await frames();
  await page.waitForTimeout(800);
  expect(await frames()).toBeGreaterThan(before);
  expect(errors).toEqual([]);

  await page.getByLabel('Reduced motion (calm)').uncheck();
  await page.locator('button[data-phase="typing"]').click();
  await page.waitForTimeout(2500);
  writeResult('screens/playground.png', await page.screenshot());
});
