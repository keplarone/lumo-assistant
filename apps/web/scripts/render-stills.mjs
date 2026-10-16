/**
 * Renders the static hero mascot still (the fallback for the 3D hero) from the real @lumo/mascot, and
 * the Open Graph card (owl app icon and download line), using the dev-only /__still and /__og routes.
 *
 *   pnpm --filter @lumo/web render:stills          (stills and OG card)
 *   pnpm --filter @lumo/web render:stills --og     (OG card only)
 *
 * Starts `astro dev` with LUMO_STILLS=1, captures with headless Chromium (SwiftShader WebGL), writes
 * into public/stills/hero.jpg and public/og.png. Output is committed; the site build does not run this.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = 4391;
const base = `http://localhost:${port}`;

function chromiumExecutable() {
  if (process.env.LUMO_CHROMIUM) return process.env.LUMO_CHROMIUM;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {}
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!dir || !existsSync(dir)) return undefined;
  const dirs = readdirSync(dir).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome']) if (existsSync(join(dir, d, rel))) return join(dir, d, rel);
  return undefined;
}

const SHOTS = [
  // name, mood, size, extra params. Only the hero still is used by the site now.
  { name: 'hero', mood: 'idle', w: 760, h: 820, q: 'framing=5.2&gx=0.15&gy=0.05' },
];

async function waitFor(url, ms = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const dev = spawn('pnpm', ['exec', 'astro', 'dev', '--port', String(port)], { cwd: root, env: { ...process.env, LUMO_STILLS: '1' }, stdio: 'inherit' });
try {
  await waitFor(`${base}/__still`);
  const browser = await chromium.launch({ executablePath: chromiumExecutable(), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  mkdirSync(join(root, 'public/stills'), { recursive: true });
  const ogOnly = process.argv.includes('--og');
  for (const s of ogOnly ? [] : SHOTS) {
    const page = await browser.newPage({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 2 });
    await page.goto(`${base}/__still?mood=${s.mood}&${s.q}`);
    await page.waitForSelector('html[data-ready="1"]', { timeout: 30_000 });
    // JPEG with the stage gradient baked in: the mascot's additive glow does not survive a transparent PNG.
    await page.screenshot({ path: join(root, `public/stills/${s.name}.jpg`), type: 'jpeg', quality: 86 });
    await page.close();
    console.log('rendered', s.name);
  }
  const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await og.goto(`${base}/__og`);
  await og.waitForLoadState('networkidle');
  await og.evaluate(() => document.fonts.ready);
  await og.screenshot({ path: join(root, 'public/og.png') });
  console.log('rendered og');
  await browser.close();
} finally {
  dev.kill('SIGTERM');
  // Astro may detach the dev server into the background when not attached to a terminal.
  spawn('pnpm', ['exec', 'astro', 'dev', 'stop'], { cwd: root, stdio: 'inherit' });
}
