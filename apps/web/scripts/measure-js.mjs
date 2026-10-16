/**
 * Reports the JavaScript each page loads (after scrolling to the bottom, so lazy islands count),
 * raw and gzip, plus total build output size. Run after `pnpm build`:  node scripts/measure-js.mjs
 */
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['/', '/features/', '/how-it-works/', '/download/', '/integrations/', '/pricing/', '/security/', '/docs/', '/support/', '/legal/', '/legal/terms/', '/legal/privacy/', '/legal/licenses/', '/404.html'];
const port = 4398;

function exe() {
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  try { if (existsSync(chromium.executablePath())) return undefined; } catch {}
  if (!dir) return undefined;
  const d = readdirSync(dir).filter((x) => /^chromium-\d+$/.test(x)).sort().pop();
  return d ? join(dir, d, 'chrome-linux/chrome') : undefined;
}
function du(p) {
  const s = statSync(p);
  return s.isDirectory() ? readdirSync(p).reduce((a, f) => a + du(join(p, f)), 0) : s.size;
}
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

const server = spawn('node', ['tests/serve.mjs', String(port)], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const browser = await chromium.launch({ executablePath: exe(), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
console.log('page'.padEnd(20), 'inline'.padStart(10), 'js raw'.padStart(12), 'js gzip'.padStart(12));
for (const path of PAGES) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const bodies = [];
  page.on('response', async (res) => {
    if (res.request().resourceType() === 'script') bodies.push(res.body().catch(() => Buffer.alloc(0)));
  });
  await page.goto(`http://localhost:${port}${path}`, { waitUntil: 'networkidle' });
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += 700) {
    await page.evaluate((t) => window.scrollTo(0, t), y);
    await page.waitForTimeout(120);
  }
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  const inline = await page.evaluate(() =>
    Array.from(document.querySelectorAll('script:not([src]):not([type="application/ld+json"])')).reduce((a, s) => a + (s.textContent?.length ?? 0), 0),
  );
  const bufs = await Promise.all(bodies);
  const raw = bufs.reduce((a, b) => a + b.length, 0);
  const gz = bufs.reduce((a, b) => a + gzipSync(b).length, 0);
  console.log(path.padEnd(20), kb(inline).padStart(10), kb(raw).padStart(12), kb(gz).padStart(12));
  await page.close();
}
await browser.close();
server.kill();
const dist = join(root, 'dist');
console.log(`\ndist total: ${kb(du(dist))}  (_astro: ${kb(du(join(dist, '_astro')))}, stills: ${kb(du(join(dist, 'stills')))}, og.png: ${kb(statSync(join(dist, 'og.png')).size)})`);
