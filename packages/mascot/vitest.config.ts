import { defineConfig } from 'vitest/config';

// Unit tests only; Playwright specs under test/visual run with `pnpm test:visual`.
export default defineConfig({ test: { include: ['test/*.test.ts'] } });
