import { describe, expect, it } from 'vitest';
import {
  BurstFinder,
  dtw,
  HOP_SAMPLES,
  matches,
  mfcc,
  resample,
  rms,
  SAMPLE_RATE,
  threshold,
} from '../src/lib/wakeword';

/** A made-up "phrase": a few voiced syllables, each a buzzy tone with two formants. */
function phrase(
  syllables: [f0: number, f1: number, f2: number, ms: number][],
  { stretch = 1, gain = 0.3, noise = 0.003, seed = 1 } = {},
): Float32Array {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const out: number[] = [];
  for (const [f0, f1, f2, ms] of syllables) {
    const n = Math.round((ms * stretch * SAMPLE_RATE) / 1000);
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const env = Math.sin((Math.PI * i) / n);
      const pulse = Math.sin(2 * Math.PI * f0 * t) > 0.9 ? 1 : 0;
      const v = pulse * 0.4 + Math.sin(2 * Math.PI * f1 * t) * 0.6 + Math.sin(2 * Math.PI * f2 * t) * 0.3;
      out.push(v * env * gain + rand() * noise);
    }
  }
  return Float32Array.from(out);
}

const HEY_LUMO: [number, number, number, number][] = [
  [140, 600, 2300, 180],
  [150, 400, 1100, 160],
  [130, 500, 900, 260],
];
const OTHER: [number, number, number, number][] = [
  [140, 750, 1200, 200],
  [145, 300, 2600, 220],
];

describe('Hey Lumo matching', () => {
  const templates = [0.95, 1, 1.05].map((st, i) => mfcc(phrase(HEY_LUMO, { stretch: st, seed: i + 2 })));

  it('matches the phrase said a little faster, slower or louder, and nothing else', () => {
    const limit = threshold(templates);
    for (const [stretch, gain, seed] of [
      [0.9, 0.3, 7],
      [1.12, 0.5, 8],
      [1, 0.15, 9],
    ] as const) {
      const said = mfcc(phrase(HEY_LUMO, { stretch, gain, seed, noise: 0.006 }));
      expect(matches(said, templates, limit), `stretch ${stretch} gain ${gain}`).toBe(true);
    }
    for (const seed of [11, 12]) {
      expect(matches(mfcc(phrase(OTHER, { seed })), templates, limit)).toBe(false);
    }
    // Pure noise and a much longer utterance never match.
    expect(matches(mfcc(phrase([[0, 0, 0, 600]], { noise: 0.2 })), templates, limit)).toBe(false);
    expect(matches(mfcc(phrase([...HEY_LUMO, ...OTHER, ...OTHER, ...HEY_LUMO])), templates, limit)).toBe(
      false,
    );
  });

  it('computes features and distances sensibly', () => {
    const f = mfcc(phrase(HEY_LUMO));
    expect(f[0]).toHaveLength(13);
    expect(f.length).toBeGreaterThan(55);
    expect(dtw(f, f)).toBe(0);
    expect(dtw(f, [])).toBe(Infinity);
    expect(matches(f, [])).toBe(false);
    expect(resample(new Float32Array(48_000), 48_000)).toHaveLength(16_000);
  });

  it('finds bursts of speech between silences', () => {
    const silence = new Float32Array(SAMPLE_RATE / 2);
    const audio = Float32Array.from([
      ...silence,
      ...phrase(HEY_LUMO),
      ...silence,
      ...new Float32Array(SAMPLE_RATE * 3).map(() => 0.2),
      ...silence,
    ]);
    const finder = new BurstFinder();
    const bursts: [number, number][] = [];
    for (let i = 0; i + HOP_SAMPLES <= audio.length; i += HOP_SAMPLES) {
      const b = finder.push(rms(audio, i, i + HOP_SAMPLES), i + HOP_SAMPLES);
      if (b) bursts.push(b);
    }
    // The phrase is found; the 3-second sound is too long to be a wake word.
    expect(bursts).toHaveLength(1);
    const ms = ((bursts[0]![1] - bursts[0]![0]) / SAMPLE_RATE) * 1000;
    expect(ms).toBeGreaterThan(550);
    expect(ms).toBeLessThan(800);
  });
});
