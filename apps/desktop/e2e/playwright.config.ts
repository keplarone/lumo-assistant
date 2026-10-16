import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Chromium is preinstalled; never run `playwright install`.
const CHROME = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux64/chrome',
].find((p) => existsSync(p));
const root = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  testDir: '.',
  outputDir: '../test-results/playwright',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:1420',
    viewport: { width: 1180, height: 780 },
    colorScheme: 'light',
    launchOptions: {
      executablePath: CHROME,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
      ],
    },
  },
  webServer: {
    command: 'pnpm exec vite --port 1420 --strictPort',
    cwd: root,
    url: 'http://localhost:1420',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
