/**
 * The microphone side of "Hey Lumo": a small audio pipeline that finds short bursts of speech and
 * hands them to the matcher in lib/wakeword.ts. Audio stays in this window; only when the wake word
 * matches does Lumo start a normal hands-free recording (which is transcribed as usual).
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/ipc';
import { speech } from '../lib/speech';
import {
  BurstFinder,
  HOP_SAMPLES,
  matches,
  mfcc,
  resample,
  rms,
  SAMPLE_RATE,
  threshold,
} from '../lib/wakeword';

type Stop = () => void;

/** Listen to the microphone and call `onBurst` with each short burst of speech (16 kHz samples). */
export async function listenForBursts(onBurst: (samples: Float32Array) => void): Promise<Stop> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but works in every webview Lumo runs in, without a worklet file.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const ringLen = SAMPLE_RATE * 4;
  const ring = new Float32Array(ringLen);
  let written = 0; // total 16 kHz samples seen
  let pending = new Float32Array(0);
  const finder = new BurstFinder();
  proc.onaudioprocess = (ev) => {
    const chunk = resample(ev.inputBuffer.getChannelData(0), ctx.sampleRate);
    const joined = new Float32Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);
    let i = 0;
    for (; i + HOP_SAMPLES <= joined.length; i += HOP_SAMPLES) {
      for (let k = 0; k < HOP_SAMPLES; k++) ring[(written + k) % ringLen] = joined[i + k]!;
      written += HOP_SAMPLES;
      const burst = finder.push(rms(joined, i, i + HOP_SAMPLES), written);
      if (burst && written - burst[0] < ringLen) {
        const [from, to] = burst;
        const out = new Float32Array(to - from);
        for (let k = 0; k < out.length; k++) out[k] = ring[(from + k) % ringLen]!;
        onBurst(out);
      }
    }
    pending = joined.slice(i);
  };
  source.connect(proc);
  // A muted sink keeps the processor running without playing the microphone back.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  proc.connect(sink);
  sink.connect(ctx.destination);
  return () => {
    proc.onaudioprocess = null;
    proc.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
  };
}

/** Record one "Hey Lumo" sample for setup: the first burst of speech within `timeoutMs`. */
export async function captureWakeSample(timeoutMs = 6000): Promise<number[][] | null> {
  let stop: Stop | null = null;
  try {
    return await new Promise<number[][] | null>((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      listenForBursts((samples) => {
        clearTimeout(timer);
        resolve(mfcc(samples));
      }).then(
        (s) => (stop = s),
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  } finally {
    (stop as Stop | null)?.();
  }
}

/** A short, cheerful two-note chime so the user knows Lumo heard them. */
export function chime() {
  try {
    const ctx = new AudioContext();
    const t = ctx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.11);
      g.gain.linearRampToValueAtTime(0.12, t + i * 0.11 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.11 + 0.18);
      o.connect(g).connect(ctx.destination);
      o.start(t + i * 0.11);
      o.stop(t + i * 0.11 + 0.2);
    });
    setTimeout(() => void ctx.close().catch(() => {}), 600);
  } catch {
    // No audio output: the visual cue is enough.
  }
}

export type WakeStatus = 'off' | 'needs_setup' | 'listening' | 'unavailable';

/**
 * Listen for "Hey Lumo" while `enabled`. Calls `onWake` when heard. Detection pauses while Lumo is
 * speaking (so it can't wake itself) and for a few seconds after each wake.
 */
export function useWakeWord(
  enabled: boolean,
  onWake: () => void,
): { status: WakeStatus; error: string | null } {
  const [status, setStatus] = useState<WakeStatus>('off');
  const [error, setError] = useState<string | null>(null);
  const wake = useRef(onWake);
  wake.current = onWake;

  useEffect(() => {
    if (!enabled) {
      setStatus('off');
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setStatus('unavailable');
      return;
    }
    let stop: Stop | null = null;
    let cancelled = false;
    let quietUntil = 0;
    const reload = async () => {
      const templates = await api.getWakeTemplates().catch(() => [] as number[][][]);
      if (cancelled) return;
      if (templates.length < 3) {
        setStatus('needs_setup');
        return;
      }
      const limit = threshold(templates);
      try {
        stop = await listenForBursts((samples) => {
          if (Date.now() < quietUntil || speech.isSpeaking()) return;
          if (matches(mfcc(samples), templates, limit)) {
            quietUntil = Date.now() + 8000;
            wake.current();
          }
        });
        if (cancelled) stop();
        else {
          setError(null);
          setStatus('listening');
        }
      } catch (e) {
        setStatus('unavailable');
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    void reload();
    const again = () => {
      stop?.();
      stop = null;
      void reload();
    };
    window.addEventListener('lumo:wake-samples-changed', again);
    return () => {
      cancelled = true;
      window.removeEventListener('lumo:wake-samples-changed', again);
      stop?.();
    };
  }, [enabled]);

  return { status, error };
}
