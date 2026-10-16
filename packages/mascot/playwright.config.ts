import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, defineConfig } from '@playwright/test';

/**
 * Use Playwright's own Chromium when it is installed; otherwise fall back to a preinstalled one
 * (newest chromium-* under PLAYWRIGHT_BROWSERS_PATH) or LUMO_CHROMIUM. Never downloads browsers.
 */
function chromiumExecutable(): string | undefined {
  if (process.env.LUMO_CHROMIUM) return process.env.LUMO_CHROMIUM;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    /* fall through */
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const exe = join(root, d, rel);
      if (existsSync(exe)) return exe;
    }
  }
  return undefined;
}

export default defineConfig({
  testDir: './test/visual',
  testMatch: /.*\.spec\.ts/,
  outputDir: './test-results/playwright',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5179',
    viewport: { width: 1100, height: 760 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    launchOptions: {
      executablePath: chromiumExecutable(),
      // Headless Chromium with WebGL on SwiftShader (software GL), deterministic across runs.
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'vite --config harness/vite.config.ts',
    url: 'http://localhost:5179/render.html',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
