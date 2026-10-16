import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, defineConfig } from '@playwright/test';

/**
 * Tests run against the built site (run `pnpm build` first). Uses Playwright's Chromium if installed,
 * otherwise the newest chromium-* under PLAYWRIGHT_BROWSERS_PATH (or LUMO_CHROMIUM). Never downloads.
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
  const dirs = readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const exe = join(root, d, rel);
      if (existsSync(exe)) return exe;
    }
  }
  return undefined;
}

const PORT = 4329;

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts/,
  outputDir: './test-results/playwright',
  timeout: 60_000,
  fullyParallel: true,
  workers: 4,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    colorScheme: 'dark',
    launchOptions: {
      executablePath: chromiumExecutable(),
      // Headless WebGL through SwiftShader.
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `node tests/serve.mjs ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
