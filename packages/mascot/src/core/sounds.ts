/**
 * Lumo's little noises, synthesized on the fly with Web Audio (no sound files): chirps, giggles, a
 * sleepy yawn, a wing whoosh. Quiet by default, rate limited so they never pile up, and silent
 * until the page has had a user gesture (browsers block audio before that anyway).
 */

export type Chirp =
  | 'boop'
  | 'giggle'
  | 'hello'
  | 'happy'
  | 'think'
  | 'uhoh'
  | 'yawn'
  | 'whoosh'
  | 'pop'
  | 'tap'
  | 'love'
  | 'question'
  | 'done';

type Step = [t: number, f: number];

interface ToneSpec {
  steps: Step[];
  dur: number;
  type?: OscillatorType;
  gain?: number;
  vibrato?: number;
  at?: number;
}

export class LumoVoice {
  enabled = true;
  /** 0..1 master volume. */
  volume = 0.35;
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private last = new Map<Chirp, number>();
  private recent: number[] = [];

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor =
      typeof window === 'undefined'
        ? undefined
        : (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
      this.out = this.ctx.createGain();
      this.out.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  /** Play a noise. Returns false when muted, rate limited or audio is unavailable. */
  play(kind: Chirp): boolean {
    if (!this.enabled || this.volume <= 0) return false;
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (nowMs - (this.last.get(kind) ?? -1e9) < 140) return false;
    this.recent = this.recent.filter((t) => nowMs - t < 1000);
    if (this.recent.length >= 6) return false;
    const ctx = this.context();
    if (!ctx || !this.out) return false;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    this.last.set(kind, nowMs);
    this.recent.push(nowMs);
    this.out.gain.value = this.volume;
    const pitch = 0.94 + Math.random() * 0.12; // never exactly the same twice
    for (const spec of SOUNDS[kind](pitch)) {
      if ('noise' in spec) this.noise(ctx, spec as NoiseSpec);
      else this.tone(ctx, spec as ToneSpec);
    }
    return true;
  }

  private tone(ctx: AudioContext, s: ToneSpec) {
    const t0 = ctx.currentTime + (s.at ?? 0);
    const osc = ctx.createOscillator();
    osc.type = s.type ?? 'triangle';
    const g = ctx.createGain();
    const peak = s.gain ?? 0.5;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.015, s.dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + s.dur);
    const [first, ...rest] = s.steps;
    osc.frequency.setValueAtTime(first![1], t0 + first![0]);
    for (const [t, f] of rest) osc.frequency.exponentialRampToValueAtTime(f, t0 + t);
    if (s.vibrato) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = 11;
      lg.gain.value = s.vibrato;
      lfo.connect(lg).connect(osc.frequency);
      lfo.start(t0);
      lfo.stop(t0 + s.dur);
    }
    osc.connect(g).connect(this.out!);
    osc.start(t0);
    osc.stop(t0 + s.dur + 0.02);
  }

  private noise(ctx: AudioContext, s: NoiseSpec) {
    const t0 = ctx.currentTime + (s.at ?? 0);
    const len = Math.ceil(ctx.sampleRate * s.dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(s.from, t0);
    bp.frequency.exponentialRampToValueAtTime(s.to, t0 + s.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(s.gain, t0 + s.dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + s.dur);
    src.connect(bp).connect(g).connect(this.out!);
    src.start(t0);
    src.stop(t0 + s.dur);
  }

  dispose() {
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.out = null;
  }
}

interface NoiseSpec {
  noise: true;
  from: number;
  to: number;
  dur: number;
  gain: number;
  at?: number;
}

const SOUNDS: Record<Chirp, (p: number) => (ToneSpec | NoiseSpec)[]> = {
  boop: (p) => [
    {
      steps: [
        [0, 620 * p],
        [0.08, 1180 * p],
      ],
      dur: 0.11,
      gain: 0.45,
    },
  ],
  giggle: (p) =>
    [0, 1, 2, 3].map((i) => ({
      steps: [
        [0, (i % 2 ? 1250 : 980) * p],
        [0.05, (i % 2 ? 1100 : 1180) * p],
      ] as Step[],
      dur: 0.07,
      at: i * 0.075,
      gain: 0.32 - i * 0.04,
      vibrato: 30,
    })),
  hello: (p) => [
    {
      steps: [
        [0, 700 * p],
        [0.09, 1040 * p],
      ],
      dur: 0.12,
      gain: 0.4,
    },
    {
      steps: [
        [0, 880 * p],
        [0.12, 1320 * p],
        [0.2, 1250 * p],
      ],
      dur: 0.22,
      at: 0.13,
      gain: 0.4,
      vibrato: 18,
    },
  ],
  happy: (p) =>
    [1047, 1319, 1568, 2093].map((f, i) => ({
      steps: [
        [0, f * p],
        [0.06, f * p * 1.01],
      ] as Step[],
      dur: 0.1,
      at: i * 0.07,
      gain: 0.3,
      type: 'sine' as OscillatorType,
    })),
  done: (p) => [
    { steps: [[0, 1319 * p]], dur: 0.12, gain: 0.3, type: 'sine' },
    { steps: [[0, 1976 * p]], dur: 0.25, at: 0.1, gain: 0.3, type: 'sine' },
  ],
  think: (p) => [
    {
      steps: [
        [0, 330 * p],
        [0.2, 300 * p],
        [0.4, 340 * p],
      ],
      dur: 0.45,
      gain: 0.2,
      type: 'sine',
      vibrato: 6,
    },
  ],
  question: (p) => [
    {
      steps: [
        [0, 600 * p],
        [0.16, 980 * p],
      ],
      dur: 0.2,
      gain: 0.35,
      vibrato: 10,
    },
  ],
  uhoh: (p) => [
    {
      steps: [
        [0, 620 * p],
        [0.1, 560 * p],
      ],
      dur: 0.13,
      gain: 0.35,
    },
    {
      steps: [
        [0, 480 * p],
        [0.16, 360 * p],
      ],
      dur: 0.2,
      at: 0.15,
      gain: 0.35,
    },
  ],
  yawn: (p) => [
    {
      steps: [
        [0, 420 * p],
        [0.25, 560 * p],
        [0.75, 240 * p],
      ],
      dur: 0.8,
      gain: 0.18,
      type: 'sine',
      vibrato: 4,
    },
    { noise: true, from: 900, to: 300, dur: 0.6, gain: 0.03, at: 0.1 },
  ],
  whoosh: () => [{ noise: true, from: 300, to: 2400, dur: 0.38, gain: 0.12 }],
  pop: (p) => [
    {
      steps: [
        [0, 1400 * p],
        [0.05, 220 * p],
      ],
      dur: 0.06,
      gain: 0.35,
      type: 'sine',
    },
  ],
  tap: (p) => [{ steps: [[0, 2100 * p]], dur: 0.025, gain: 0.08, type: 'square' }],
  love: (p) => [
    {
      steps: [
        [0, 520 * p],
        [0.15, 760 * p],
        [0.4, 640 * p],
      ],
      dur: 0.45,
      gain: 0.32,
      type: 'sine',
      vibrato: 14,
    },
  ],
};

/** One shared voice per page. */
export const lumoVoice = new LumoVoice();
