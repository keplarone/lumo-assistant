/**
 * Microphone capture for the composer: push-to-talk (hold) or hands-free (click; stops after a
 * pause). The recording is sent to the user's speech-to-text endpoint by Rust and the text comes
 * back; nothing is sent until the user records.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/ipc';
import {
  blobToBase64,
  DEFAULT_VAD,
  MAX_BYTES,
  MAX_MS,
  pickMimeType,
  rmsOf,
  vadStart,
  vadStep,
  type VadState,
} from '../lib/voice';

export type VoiceMode = 'hold' | 'handsfree';
export type VoiceStatus = 'idle' | 'starting' | 'recording' | 'transcribing';

export interface Voice {
  status: VoiceStatus;
  mode: VoiceMode | null;
  elapsed: number;
  level: number;
  error: string | null;
  supported: boolean;
  start: (mode: VoiceMode) => Promise<void>;
  /** Stop and transcribe. */
  stop: () => void;
  /** Stop without transcribing. */
  cancel: () => void;
  setMode: (mode: VoiceMode) => void;
  clearError: () => void;
}

export function useVoice(onText: (text: string) => void): Voice {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [mode, setModeState] = useState<VoiceMode | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    ctx: AudioContext | null;
    analyser: AnalyserNode | null;
    timer: ReturnType<typeof setInterval>;
    chunks: Blob[];
    startedAt: number;
    vad: VadState;
    discard: boolean;
    mime: string;
  } | null>(null);
  const modeRef = useRef<VoiceMode | null>(null);
  const pendingStop = useRef<'stop' | 'cancel' | null>(null);
  const textCb = useRef(onText);
  textCb.current = onText;

  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined';

  const cleanup = () => {
    const r = rec.current;
    if (!r) return;
    clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
    void r.ctx?.close().catch(() => {});
    rec.current = null;
    setLevel(0);
  };

  const finish = useCallback((how: 'stop' | 'cancel') => {
    const r = rec.current;
    if (!r) {
      pendingStop.current = how;
      return;
    }
    r.discard = how === 'cancel';
    if (r.recorder.state !== 'inactive') r.recorder.stop();
  }, []);

  const start = useCallback(
    async (m: VoiceMode) => {
      if (rec.current || status === 'starting' || status === 'transcribing') return;
      setError(null);
      if (!supported) {
        setError('Recording audio isn’t supported in this window.');
        return;
      }
      const mime = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
      modeRef.current = m;
      setModeState(m);
      setStatus('starting');
      pendingStop.current = null;
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (e) {
        setStatus('idle');
        setModeState(null);
        const name = e instanceof DOMException ? e.name : '';
        setError(
          name === 'NotAllowedError'
            ? `Lumo isn’t allowed to use the microphone (${errorMessage(e)}). Allow it in your system’s privacy settings and try again.`
            : name === 'NotFoundError'
              ? 'No microphone was found.'
              : `The microphone couldn’t be started: ${errorMessage(e)}`,
        );
        return;
      }
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      let ctx: AudioContext | null = null;
      let analyser: AnalyserNode | null = null;
      try {
        ctx = new AudioContext();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
      } catch {
        analyser = null;
      }
      const startedAt = performance.now();
      const buf = new Uint8Array(analyser?.fftSize ?? 0);
      const r = {
        recorder,
        stream,
        ctx,
        analyser,
        chunks: [] as Blob[],
        startedAt,
        vad: vadStart(startedAt),
        discard: false,
        mime: recorder.mimeType || mime || 'audio/webm',
        timer: setInterval(() => {
          const now = performance.now();
          setElapsed(now - startedAt);
          let rms = 0;
          if (analyser) {
            analyser.getByteTimeDomainData(buf);
            rms = rmsOf(buf);
            setLevel(Math.min(1, rms * 8));
          }
          if (modeRef.current === 'handsfree' && analyser) {
            const step = vadStep(r.vad, rms, now, DEFAULT_VAD);
            r.vad = step.state;
            if (step.stop) finish('stop');
          } else if (now - startedAt >= MAX_MS) finish('stop');
        }, 100),
      };
      recorder.ondataavailable = (ev) => ev.data.size > 0 && r.chunks.push(ev.data);
      recorder.onstop = async () => {
        const duration = performance.now() - r.startedAt;
        const blob = new Blob(r.chunks, { type: r.mime });
        const discard = r.discard;
        cleanup();
        setModeState(null);
        modeRef.current = null;
        if (discard || duration < 350 || blob.size === 0) {
          setStatus('idle');
          return;
        }
        if (blob.size > MAX_BYTES) {
          setStatus('idle');
          setError('That recording is too long to transcribe (over 25 MB).');
          return;
        }
        setStatus('transcribing');
        try {
          const text = await api.transcribeAudio(await blobToBase64(blob), r.mime);
          if (text.trim()) textCb.current(text.trim());
          else setError('No speech was recognized.');
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setStatus('idle');
        }
      };
      rec.current = r;
      recorder.start(250);
      setElapsed(0);
      setStatus('recording');
      // Released before the microphone was ready.
      if (pendingStop.current) finish(pendingStop.current);
    },
    [finish, status, supported],
  );

  useEffect(
    () => () => {
      if (rec.current) {
        rec.current.discard = true;
        if (rec.current.recorder.state !== 'inactive') rec.current.recorder.stop();
        cleanup();
      }
    },
    [],
  );

  return {
    status,
    mode,
    elapsed,
    level,
    error,
    supported,
    start,
    stop: () => finish('stop'),
    cancel: () => finish('cancel'),
    setMode: (m) => {
      modeRef.current = m;
      setModeState(m);
      if (rec.current && m === 'handsfree') rec.current.vad = vadStart(performance.now());
    },
    clearError: () => setError(null),
  };
}
