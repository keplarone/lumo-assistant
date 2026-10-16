/**
 * The R3F host (src/react/LumoMascot.tsx) in a real browser: it renders, frees every GPU resource
 * on unmount, leaves no rAF loop behind, stops rendering when hidden or off-screen, and caps the
 * frame rate while resting.
 */
import { expect, test, type Page } from '@playwright/test';
import { writeResult } from './util';

interface Stats {
  mounted: boolean;
  frames: number;
  calls: number;
  triangles: number;
  points: number;
  geometries: number;
  textures: number;
  rate: number;
  programs?: number;
}
type HostWindow = {
  __host: {
    mount(m?: string, p?: object, size?: [number, number]): void;
    setMood(m: string, p?: object): void;
    unmount(): void;
    stats(): Stats;
    rafCalls(): number;
    canvases(): number;
  };
};

const host = <T>(page: Page, fn: (h: HostWindow['__host'], arg: any) => T, arg?: unknown) =>
  page.evaluate(
    ({ src, arg }) =>
      new Function('h', 'arg', `return (${src})(h, arg)`)((window as unknown as HostWindow).__host, arg),
    { src: fn.toString(), arg },
  ) as Promise<T>;

async function open(page: Page) {
  page.on('pageerror', (e) => console.error('pageerror', e));
  await page.goto('/host.html');
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
}
const frames = (page: Page) => host(page, (h) => h.stats().frames);
async function framesOver(page: Page, ms: number) {
  const a = await frames(page);
  await page.waitForTimeout(ms);
  return (await frames(page)) - a;
}

test('mounts, renders, and frees all GPU memory and its rAF loop on unmount', async ({ page }) => {
  await open(page);
  await host(page, (h) => h.mount('think'));
  await page.waitForFunction(() => (window as unknown as HostWindow).__host.stats().frames > 10, null, {
    timeout: 30_000,
  });
  const live = await host(page, (h) => h.stats());
  console.log(
    `per frame: ${live.calls} draw calls, ${live.triangles} triangles, ${live.points} points; live GPU memory: ${live.geometries} geometries, ${live.textures} textures`,
  );
  writeResult('host/render-stats.json', JSON.stringify(live, null, 2));
  expect(live.calls).toBeGreaterThan(0);
  expect(live.geometries).toBeGreaterThan(0);
  expect(live.textures).toBeGreaterThan(0);

  await host(page, (h) => h.unmount());
  await page.waitForTimeout(300);
  const after = await host(page, (h) => h.stats());
  console.log(`after unmount: ${after.geometries} geometries, ${after.textures} textures`);
  writeResult('host/after-unmount.json', JSON.stringify(after, null, 2));
  expect(after.mounted).toBe(false);
  expect(after.geometries).toBe(0);
  expect(after.textures).toBe(0);
  expect(await host(page, (h) => h.canvases())).toBe(0);

  const raf0 = await host(page, (h) => h.rafCalls());
  await page.waitForTimeout(1000);
  expect(await host(page, (h) => h.rafCalls()), 'rAF callbacks after unmount').toBe(raf0);

  // Remount works (no stale state) and unmounts clean again.
  await host(page, (h) => h.mount('idle'));
  await page.waitForFunction(() => (window as unknown as HostWindow).__host.stats().frames > 5, null, {
    timeout: 30_000,
  });
  await host(page, (h) => h.unmount());
  await page.waitForTimeout(300);
  const again = await host(page, (h) => h.stats());
  expect([again.geometries, again.textures]).toEqual([0, 0]);
});

test('stops rendering while the document is hidden, resumes when visible', async ({ page }) => {
  await open(page);
  await host(page, (h) => h.mount('think'));
  await page.waitForFunction(() => (window as unknown as HostWindow).__host.stats().frames > 5, null, {
    timeout: 30_000,
  });
  expect(await framesOver(page, 500)).toBeGreaterThan(0);

  const setHidden = (hidden: boolean) =>
    page.evaluate((hidden) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (hidden ? 'hidden' : 'visible'),
      });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);

  await setHidden(true);
  await page.waitForTimeout(200);
  const raf0 = await host(page, (h) => h.rafCalls());
  expect(await framesOver(page, 1000), 'frames while hidden').toBe(0);
  expect(await host(page, (h) => h.rafCalls()), 'rAF callbacks while hidden').toBe(raf0);
  expect((await host(page, (h) => h.stats())).rate).toBe(0);

  await setHidden(false);
  expect(await framesOver(page, 600), 'frames after becoming visible').toBeGreaterThan(0);
});

test('stops rendering while scrolled off-screen, resumes when back', async ({ page }) => {
  await open(page);
  await host(page, (h) => h.mount('think'));
  await page.waitForFunction(() => (window as unknown as HostWindow).__host.stats().frames > 5, null, {
    timeout: 30_000,
  });
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.waitForTimeout(300);
  expect(await framesOver(page, 1000), 'frames while off-screen').toBe(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await framesOver(page, 600), 'frames after scrolling back').toBeGreaterThan(0);
});

test('picks a lower frame cap while idle and asleep', async ({ page }) => {
  await open(page);
  await host(page, (h) => h.mount('think'));
  await page.waitForFunction(() => (window as unknown as HostWindow).__host.stats().frames > 2, null, {
    timeout: 30_000,
  });
  const expected: Record<string, number> = { think: 60, idle: 30, sleep: 12, type: 60 };
  for (const [mood, rate] of Object.entries(expected)) {
    await host(page, (h, m) => h.setMood(m), mood);
    // The driver re-reads the cap on its next rAF tick (software GL frames are slow here).
    await expect.poll(() => host(page, (h) => h.stats().rate), { message: mood, timeout: 5000 }).toBe(rate);
  }
  await host(page, (h) => h.unmount());
});

test('the frame driver actually throttles to the cap', async ({ page }) => {
  // Software GL here tops out around 10-12 fps, so use caps well below that to measure throttling.
  const caps = { fps: 8, idleFps: 4, sleepFps: 2, particles: 40 };
  await open(page);
  await host(page, (h, p) => h.mount('think', p, [120, 140]), caps);
  await page.waitForFunction(() => (window as unknown as HostWindow).__host.stats().frames > 3, null, {
    timeout: 30_000,
  });
  await page.waitForTimeout(1000); // warm-up
  const measured: Record<string, number> = {};
  for (const mood of ['think', 'idle', 'sleep']) {
    await host(page, (h, a) => h.setMood(a.mood, a.caps), { mood, caps });
    await page.waitForTimeout(400);
    measured[mood] = (await framesOver(page, 3000)) / 3;
  }
  console.log(`measured fps with caps 8/4/2 (active/idle/sleep): ${JSON.stringify(measured)}`);
  writeResult('host/throttle.json', JSON.stringify({ caps, measured }, null, 2));
  expect(measured.think).toBeLessThanOrEqual(8.4);
  expect(measured.idle).toBeLessThanOrEqual(4.4);
  expect(measured.idle).toBeGreaterThanOrEqual(3);
  expect(measured.sleep).toBeLessThanOrEqual(2.4);
  expect(measured.sleep).toBeGreaterThanOrEqual(1.5);
  expect(measured.think!).toBeGreaterThan(measured.idle!);
  await host(page, (h) => h.unmount());
});
