/**
 * Renders Lumo's app icon and the frames of his live icons (tray, taskbar and Dock while the app
 * runs) from the real 3D character, so they always match him.
 *
 *   pnpm --filter @lumo/mascot render:icons
 *
 * Writes apps/desktop/src-tauri/icons/source-1024.png (feed it to `pnpm tauri icon`) and
 * apps/desktop/src-tauri/icons/live/{idle,blink,work,wave}-N.png (64 px, embedded by the app).
 * Uses the Chromium Playwright finds; set CHROMIUM to point at another one.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const icons = resolve(here, '../../../apps/desktop/src-tauri/icons');
mkdirSync(resolve(icons, 'live'), { recursive: true });

const server = await createServer({
  configFile: resolve(here, '../harness/vite.config.ts'),
  server: { port: 5181 },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 2 });
const small = await browser.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1 });
for (const p of [page, small]) p.on('pageerror', (e) => console.error(e));

async function open(p, query) {
  await p.goto(`http://localhost:5181/icon.html${query}`);
  await p.waitForSelector('body[data-ready]');
}

// The app icon: 1024 px, happy, wings out.
await open(page, '?size=512&dpr=2');
await page.evaluate(() => window.__icon.setup('happy', 150));
await page.evaluate(() => window.__icon.step(3));
await page.locator('#tile').screenshot({ path: resolve(icons, 'source-1024.png'), omitBackground: true });

// Live frames: 64 px tiles rendered at 4x inside and downsampled.
async function frames(name, mood, count, between, before) {
  await open(small, '?size=64&dpr=4&span=3.3');
  await small.evaluate((m) => window.__icon.setup(m, 150), mood);
  if (before) await small.evaluate(before);
  for (let i = 0; i < count; i++) {
    await small.evaluate((n) => window.__icon.step(n), between);
    await small
      .locator('#tile')
      .screenshot({ path: resolve(icons, `live/${name}-${i}.png`), omitBackground: true });
  }
}
await frames('idle', 'idle', 1, 1);
await frames('blink', 'idle', 3, 6, () => window.__icon.act('blink'));
await frames('work', 'greet', 6, 2);
await frames('wave', 'happy', 10, 6, () => window.__icon.act('wave', 'right'));

await browser.close();
await server.close();
console.log('icons written to', icons);
