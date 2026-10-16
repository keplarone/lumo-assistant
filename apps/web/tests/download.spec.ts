import { test, expect, type Browser } from '@playwright/test';
import { PLATFORMS, RELEASE, assetsFor, releasesUrl } from '../src/data/release';
import { REDIRECTS } from './pages';

const UA = {
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  macos:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  linux: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
};
const NAME = Object.fromEntries(PLATFORMS.map((p) => [p.id, p.name])) as Record<string, string>;

async function open(browser: Browser, userAgent: string) {
  const ctx = await browser.newContext({ userAgent });
  const page = await ctx.newPage();
  await page.goto('/');
  return { ctx, page };
}

test('the download page has the name, tagline, requirements, pre-release note and footer', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Lumo');
  await expect(page.locator('.tagline')).toHaveText(
    'Tell Lumo what you want. Lumo figures out how to make it happen.',
  );
  await expect(page.locator('.hero-stage')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'System requirements' })).toBeVisible();
  await expect(page.locator('.req-card h3')).toHaveText(['Windows', 'macOS', 'Linux']);
  await expect(page.locator('.prerelease')).toContainText('Pre-release software');
  await expect(page.locator('footer.site-footer')).toBeVisible();
  // Nothing from the old marketing site is left on the page.
  for (const gone of ['Pricing', 'Features', 'Integrations', 'Lumo Pro', '$19.99']) {
    await expect(page.getByText(gone, { exact: true })).toHaveCount(0);
  }
});

for (const os of ['windows', 'macos', 'linux'] as const) {
  test(`detects ${NAME[os]} and offers it first`, async ({ browser }) => {
    const { ctx, page } = await open(browser, UA[os]);
    const dl = page.locator('[data-dl]');
    await expect(dl).toHaveAttribute('data-detected', 'true');
    await expect(dl).toHaveAttribute('data-os', os);
    const primary = page.locator('[data-dl-primary]:visible');
    await expect(primary).toHaveCount(1);
    await expect(primary).toHaveAttribute('data-dl-primary', os);
    await expect(primary).toContainText(NAME[os]!);
    // The other two platforms stay visible as links or "Coming soon".
    await expect(page.locator('.dl-others-title span:visible')).toHaveText('Other platforms');
    const others = page.locator('.dl-others-list li:visible .dl-os');
    await expect(others).toHaveText(PLATFORMS.filter((p) => p.id !== os).map((p) => p.name));
    await ctx.close();
  });
}

for (const device of ['iphone', 'android'] as const) {
  test(`on a phone (${device}) every desktop platform is listed and none is guessed`, async ({ browser }) => {
    const { ctx, page } = await open(browser, UA[device]);
    await expect(page.locator('[data-dl]')).toHaveAttribute('data-os', 'other');
    await expect(page.locator('.dl-others-title span:visible')).toHaveText('All platforms');
    await expect(page.locator('.dl-others-list li:visible .dl-os')).toHaveText(['Windows', 'macOS', 'Linux']);
    await expect(page.getByText('Lumo is a desktop app.')).toBeVisible();
    await ctx.close();
  });
}

test('without JavaScript the Windows button shows and the other platforms are listed', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.locator('[data-dl-primary]:visible')).toHaveAttribute('data-dl-primary', 'windows');
  await expect(page.locator('.dl-others-list li:visible .dl-os')).toHaveText(['macOS', 'Linux']);
  await ctx.close();
});

test.describe('no published version', () => {
  test.skip(RELEASE.version !== null, 'release.ts has a version');

  test('shows a disabled "Coming soon" state and no download links', async ({ page, request }) => {
    await page.goto('/');
    const primary = page.locator('[data-dl-primary]:visible');
    await expect(primary).toBeDisabled();
    await expect(primary).toContainText('Coming soon');
    await expect(page.getByText('The first build is being prepared')).toBeVisible();
    const releases = page.getByRole('link', { name: 'Watch GitHub Releases' });
    await expect(releases).toBeVisible();
    await expect(releases).toHaveAttribute('href', 'https://github.com/keplarone/lumo-assistant/releases');
    // No pretend file links anywhere in the page source.
    const html = await (await request.get('/')).text();
    expect(html).not.toContain('/releases/download/');
    expect(html).not.toMatch(/\.(dmg|exe|msi|AppImage|deb)\b/);
    await expect(page.locator('a[data-dl-primary], a[data-dl-file]')).toHaveCount(0);
    await expect(page.locator('.dl-file-soon')).toHaveCount(3);
  });
});

test.describe('published version', () => {
  test.skip(RELEASE.version === null, 'release.ts has no version yet');

  test('links every platform to its GitHub release asset', async ({ page }) => {
    await page.goto('/');
    for (const p of PLATFORMS) {
      for (const a of assetsFor(p.id)) {
        await expect(page.locator(`a[href="${a.url}"]`).first()).toBeAttached();
      }
    }
    await expect(page.locator('button[data-dl-primary]')).toHaveCount(0);
  });
});

test('the releases link is the one from release.ts', () => {
  expect(releasesUrl()).toBe(`https://github.com/${RELEASE.repo}/releases`);
});

for (const [from, to] of Object.entries(REDIRECTS)) {
  test(`${from} redirects to ${to}`, async ({ page, request }) => {
    const res = await request.get(from);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain(`http-equiv="refresh" content="0;url=${to}"`);
    await page.goto(from);
    await page.waitForURL((u) => u.pathname === to);
  });
}

for (const [path, title] of [
  ['/privacy/', 'Privacy policy'],
  ['/terms/', 'Terms of use'],
] as const) {
  test(`${path} loads`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page.locator('h1')).toHaveText(title);
    await expect(page.locator('.prose h2').first()).toBeVisible();
  });
}
