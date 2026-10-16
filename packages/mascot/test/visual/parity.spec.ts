/**
 * Visual parity: the TypeScript port on three 0.186.1 must render the established mascot exactly
 * like the original reference code (sliced from docs/reference/lumo-mascot.html) on three r149.
 *
 * Each mood is rendered in a fresh page per implementation: identical 520x600 canvas over the stage
 * gradient at DPR 1, the reference camera framing, seeded Math.random, and 90 fixed update(1/60)
 * steps after setState. Gates (both must hold, per mood):
 *  - pixelmatch at a strict threshold (0.02, default is 0.1): at most 0.5% of pixels differ;
 *  - raw RGB: at most 0.5% of pixels have any channel off by more than 3 levels.
 * The strict gate matters: the darker additive glow from r152+ color management / blend factors
 * only shows as small per-channel deltas that pixelmatch's default threshold ignores.
 */
import { expect, test, type Browser } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { openRender, writeResult } from './util';

const MOODS = ['idle', 'think', 'speak', 'happy', 'majestic', 'sleep'] as const;
const STEPS = 90;
// Extra case: majestic early, while its pulse ring (an additive sprite) is still expanding.
const CASES: { name: string; mood: string; steps: number }[] = [
  ...MOODS.map((mood) => ({ name: mood, mood, steps: STEPS })),
  { name: 'majestic-pulse', mood: 'majestic', steps: 30 },
];
const MAX_RATIO = 0.005; // 0.5% of pixels
const summary: Record<string, unknown> = {};

async function shoot(browser: Browser, impl: 'ref' | 'port' | 'companion', mood: string, steps = STEPS) {
  const page = await browser.newPage();
  await openRender(page, impl);
  const info = await page.evaluate(
    ({ mood, steps }) => {
      const w = window as unknown as {
        __lumo: {
          three: string;
          run(o: object): { calls: number; triangles: number; points: number; state: string };
        };
      };
      return { three: w.__lumo.three, ...w.__lumo.run({ mood, steps }) };
    },
    { mood, steps },
  );
  const png = await page.locator('#stage').screenshot({ animations: 'disabled' });
  await page.close();
  return { png, info };
}

function compare(aBuf: Buffer, bBuf: Buffer) {
  const a = PNG.sync.read(aBuf),
    b = PNG.sync.read(bBuf);
  expect([b.width, b.height]).toEqual([a.width, a.height]);
  const total = a.width * a.height;
  const diff = new PNG({ width: a.width, height: a.height });
  const strict = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.02 });
  let channel = 0,
    sum = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) {
      const x = Math.abs(a.data[i + c]! - b.data[i + c]!);
      d = Math.max(d, x);
      sum += x;
    }
    if (d > 3) channel++;
  }
  return { total, strict, channel, mae: sum / (total * 3), diff };
}

for (const { name: mood, mood: setMood, steps } of CASES) {
  test(`parity: ${mood}`, async ({ browser }) => {
    const ref = await shoot(browser, 'ref', setMood, steps);
    const port = await shoot(browser, 'port', setMood, steps);
    const r = compare(ref.png, port.png);
    const strictPct = (r.strict / r.total) * 100,
      channelPct = (r.channel / r.total) * 100;
    summary[mood] = {
      steps,
      pixels: r.total,
      pixelmatch002: r.strict,
      pixelmatch002Pct: +strictPct.toFixed(4),
      channelGt3: r.channel,
      channelGt3Pct: +channelPct.toFixed(4),
      meanAbsError: +r.mae.toFixed(5),
      ref: ref.info,
      port: port.info,
    };
    writeResult('parity/summary.json', JSON.stringify(summary, null, 2));
    console.log(
      `parity ${mood}: pixelmatch(0.02) ${r.strict} px (${strictPct.toFixed(4)}%), channel>3 ${r.channel} px (${channelPct.toFixed(4)}%), MAE ${r.mae.toFixed(5)}; draw calls ref ${ref.info.calls} / port ${port.info.calls}`,
    );
    const fail = r.strict / r.total > MAX_RATIO || r.channel / r.total > MAX_RATIO;
    if (fail || process.env.LUMO_SAVE_PARITY) {
      writeResult(`parity/${mood}-ref.png`, ref.png);
      writeResult(`parity/${mood}-port.png`, port.png);
      writeResult(`parity/${mood}-diff.png`, PNG.sync.write(r.diff));
    }
    expect(r.strict / r.total, `${mood}: pixelmatch(0.02) ${strictPct.toFixed(3)}%`).toBeLessThanOrEqual(
      MAX_RATIO,
    );
    expect(r.channel / r.total, `${mood}: channel>3 ${channelPct.toFixed(3)}%`).toBeLessThanOrEqual(
      MAX_RATIO,
    );
  });
}

// The product layer (LumoCompanion) must add nothing while no product behavior is playing: in the
// reference moods, before the first blink, it renders identically to the reference too.
for (const mood of ['idle', 'think', 'majestic'] as const) {
  test(`parity: companion adds nothing in ${mood}`, async ({ browser }) => {
    const ref = await shoot(browser, 'ref', mood, 60);
    const comp = await shoot(browser, 'companion', mood, 60);
    const r = compare(ref.png, comp.png);
    console.log(`parity companion ${mood}: pixelmatch(0.02) ${r.strict} px, channel>3 ${r.channel} px`);
    summary[`companion-${mood}`] = {
      steps: 60,
      pixelmatch002: r.strict,
      channelGt3: r.channel,
      meanAbsError: +r.mae.toFixed(5),
    };
    writeResult('parity/summary.json', JSON.stringify(summary, null, 2));
    expect(r.strict / r.total).toBeLessThanOrEqual(MAX_RATIO);
    expect(r.channel / r.total).toBeLessThanOrEqual(MAX_RATIO);
  });
}

test('parity harness is sensitive (different moods do not compare equal)', async ({ browser }) => {
  const a = await shoot(browser, 'port', 'idle');
  const b = await shoot(browser, 'port', 'majestic');
  const r = compare(a.png, b.png);
  expect(r.strict / r.total).toBeGreaterThan(0.05);
});
