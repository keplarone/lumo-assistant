/**
 * "Hey Lumo" detection that runs entirely on this computer. The user records the phrase a few
 * times; each recording becomes a short sequence of MFCC frames (a compact description of the
 * sound, not the audio). While listening, every short burst of speech is compared with those
 * samples by dynamic time warping, and a close enough match wakes Lumo. Nothing is sent anywhere
 * until the wake word is heard. Pure functions, so it is unit tested.
 */

export const SAMPLE_RATE = 16_000;
const FRAME = 400; // 25 ms
const HOP = 160; // 10 ms
const FFT = 512;
const MELS = 26;
export const COEFFS = 13;
/** Speech bursts that could be "Hey Lumo": not a click, not a sentence. */
export const MIN_MS = 300;
export const MAX_MS = 1800;

/** Resample mono audio to 16 kHz by linear interpolation. */
export function resample(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === SAMPLE_RATE) return input;
  const ratio = fromRate / SAMPLE_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = (input[j] ?? 0) * (1 - f) + (input[j + 1] ?? input[j] ?? 0) * f;
  }
  return out;
}

function fftMag(re: Float64Array): Float64Array {
  const n = re.length;
  const im = new Float64Array(n);
  // Bit reversal.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
  const mag = new Float64Array(n / 2 + 1);
  for (let i = 0; i <= n / 2; i++) mag[i] = re[i]! * re[i]! + im[i]! * im[i]!;
  return mag;
}

const hz2mel = (h: number) => 2595 * Math.log10(1 + h / 700);
const mel2hz = (m: number) => 700 * (10 ** (m / 2595) - 1);

let filters: Float64Array[] | null = null;
function melFilters(): Float64Array[] {
  if (filters) return filters;
  const lo = hz2mel(60);
  const hi = hz2mel(SAMPLE_RATE / 2);
  const pts = Array.from({ length: MELS + 2 }, (_, i) =>
    Math.floor(((FFT + 1) * mel2hz(lo + ((hi - lo) * i) / (MELS + 1))) / SAMPLE_RATE),
  );
  filters = Array.from({ length: MELS }, (_, m) => {
    const f = new Float64Array(FFT / 2 + 1);
    const [a, b, c] = [pts[m]!, pts[m + 1]!, pts[m + 2]!];
    for (let k = a; k < b; k++) f[k] = (k - a) / Math.max(1, b - a);
    for (let k = b; k < c; k++) f[k] = (c - k) / Math.max(1, c - b);
    return f;
  });
  return filters;
}

/** MFCC frames for 16 kHz audio, mean-normalized so the microphone and room matter less. */
export function mfcc(samples: Float32Array): number[][] {
  const fb = melFilters();
  const frames: number[][] = [];
  for (let start = 0; start + FRAME <= samples.length; start += HOP) {
    const buf = new Float64Array(FFT);
    let prev = start > 0 ? samples[start - 1]! : 0;
    for (let i = 0; i < FRAME; i++) {
      const s = samples[start + i]!;
      const emph = s - 0.97 * prev;
      prev = s;
      buf[i] = emph * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
    }
    const power = fftMag(buf);
    const logMel = fb.map((f) => {
      let e = 0;
      for (let k = 0; k < f.length; k++) e += f[k]! * power[k]!;
      return Math.log(e + 1e-10);
    });
    const c: number[] = [];
    for (let i = 0; i < COEFFS; i++) {
      let sum = 0;
      for (let m = 0; m < MELS; m++) sum += logMel[m]! * Math.cos((Math.PI * i * (m + 0.5)) / MELS);
      c.push(sum);
    }
    frames.push(c);
  }
  if (!frames.length) return frames;
  const mean = Array.from(
    { length: COEFFS },
    (_, i) => frames.reduce((a, f) => a + f[i]!, 0) / frames.length,
  );
  return frames.map((f) => f.map((v, i) => Math.round((v - mean[i]!) * 1000) / 1000));
}

function dist(a: number[], b: number[]): number {
  let s = 0;
  // c0 is loudness; leave it out so a louder "Hey Lumo" still matches.
  for (let i = 1; i < a.length; i++) s += (a[i]! - b[i]!) ** 2;
  return Math.sqrt(s);
}

/** Dynamic time warping distance, averaged over the path, within a band around the diagonal. */
export function dtw(a: number[][], b: number[][]): number {
  if (!a.length || !b.length) return Infinity;
  const n = a.length;
  const m = b.length;
  if (Math.max(n, m) > 2.5 * Math.min(n, m)) return Infinity;
  const band = Math.max(Math.abs(n - m) + 8, Math.ceil(Math.max(n, m) * 0.25));
  let prev = new Float64Array(m + 1).fill(Infinity);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    const cur = new Float64Array(m + 1).fill(Infinity);
    const center = Math.round((i * m) / n);
    for (let j = Math.max(1, center - band); j <= Math.min(m, center + band); j++) {
      cur[j] = dist(a[i - 1]!, b[j - 1]!) + Math.min(prev[j]!, cur[j - 1]!, prev[j - 1]!);
    }
    prev = cur;
  }
  return prev[m]! / (n + m);
}

/**
 * How far a burst may be from the closest sample: a little above how far the user's own samples
 * are from each other, within fixed bounds so one odd sample can't make it trigger on anything.
 */
export function threshold(templates: number[][][]): number {
  const d: number[] = [];
  for (let i = 0; i < templates.length; i++)
    for (let j = i + 1; j < templates.length; j++) d.push(dtw(templates[i]!, templates[j]!));
  const finite = d.filter(Number.isFinite);
  if (!finite.length) return 6;
  const spread = finite.reduce((a, b) => a + b, 0) / finite.length;
  return Math.min(9, Math.max(4, spread * 1.2));
}

/** Score a speech burst against the samples: true when it sounds like the user's "Hey Lumo". */
export function matches(burst: number[][], templates: number[][][], limit = threshold(templates)): boolean {
  if (!templates.length) return false;
  return Math.min(...templates.map((t) => dtw(burst, t))) <= limit;
}

/** Splits a stream of 10 ms levels into speech bursts, tracking the room's noise floor. */
export class BurstFinder {
  private floor = 0.004;
  private inSpeech = false;
  private quietFor = 0;
  private start = 0;

  /** Feed one 10 ms frame's RMS at sample position `at`; returns a [start, end) burst when one ends. */
  push(rms: number, at: number): [number, number] | null {
    const on = Math.max(0.012, this.floor * 3);
    if (!this.inSpeech) {
      // The floor follows the room slowly, and only while nobody is talking.
      this.floor = this.floor * 0.995 + rms * 0.005;
      if (rms > on) {
        this.inSpeech = true;
        this.start = Math.max(0, at - 2 * HOP);
        this.quietFor = 0;
      }
      return null;
    }
    this.quietFor = rms > on * 0.6 ? 0 : this.quietFor + 10;
    const len = ((at - this.start) / SAMPLE_RATE) * 1000;
    if (this.quietFor >= 250 || len > MAX_MS + 1000) {
      this.inSpeech = false;
      const end = at - Math.round((this.quietFor / 1000) * SAMPLE_RATE) + 2 * HOP;
      const ms = ((end - this.start) / SAMPLE_RATE) * 1000;
      return ms >= MIN_MS && ms <= MAX_MS ? [this.start, end] : null;
    }
    return null;
  }
}

export function rms(x: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
}

export { HOP as HOP_SAMPLES };
