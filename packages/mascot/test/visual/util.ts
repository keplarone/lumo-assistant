import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

export const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const RESULTS = resolve(PKG, 'test-results');

export function writeResult(rel: string, data: Buffer | string) {
  const file = resolve(RESULTS, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  return file;
}

export async function openRender(page: Page, extra = '') {
  page.on('pageerror', (e) => console.error('pageerror', e));
  await page.goto(`/render.html${extra ? '?' + extra : ''}`);
  await page.waitForFunction(
    () => document.body.dataset.ready === 'true' || !!document.body.dataset.error,
    null,
    { timeout: 30_000 },
  );
  const err = await page.evaluate(() => document.body.dataset.error);
  if (err) throw new Error(`harness failed to boot: ${err}`);
}
