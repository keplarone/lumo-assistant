/**
 * Voice capture helpers. The recorder itself needs a browser; the voice-activity logic is pure so it
 * is unit tested.
 */

/** Recording formats the transcription command accepts, best first. */
export const PREFERRED_MIME = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
  'audio/wav',
];
export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_MS = 60_000;

export function pickMimeType(isSupported: (t: string) => boolean): string | null {
  for (const t of PREFERRED_MIME) if (isSupported(t)) return t;
  return null;
}

export interface VadConfig {
  /** RMS (0..1) above which a frame counts as speech. */
  threshold: number;
  /** Silence after speech that ends the recording. */
  silenceMs: number;
  maxMs: number;
}

export const DEFAULT_VAD: VadConfig = { threshold: 0.025, silenceMs: 1200, maxMs: MAX_MS };

export interface VadState {
  startedAt: number;
  heardSpeech: boolean;
  lastSpeechAt: number | null;
}

export function vadStart(now: number): VadState {
  return { startedAt: now, heardSpeech: false, lastSpeechAt: null };
}

/** Feed one level reading; returns the new state and whether to stop. */
export function vadStep(
  s: VadState,
  rms: number,
  now: number,
  cfg: VadConfig = DEFAULT_VAD,
): { state: VadState; stop: 'silence' | 'max' | null } {
  let next = s;
  if (rms >= cfg.threshold) next = { ...s, heardSpeech: true, lastSpeechAt: now };
  if (now - next.startedAt >= cfg.maxMs) return { state: next, stop: 'max' };
  if (next.heardSpeech && next.lastSpeechAt !== null && now - next.lastSpeechAt >= cfg.silenceMs)
    return { state: next, stop: 'silence' };
  return { state: next, stop: null };
}

/** Root-mean-square level of time-domain samples centred on 128 (AnalyserNode byte data). */
export function rmsOf(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const v of samples) {
    const x = (v - 128) / 128;
    sum += x * x;
  }
  return Math.sqrt(sum / samples.length);
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  return btoa(bin);
}
