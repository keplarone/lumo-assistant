/** One mascot behavior machine per window, driven by agent events and the composer. */
import { lumoVoice, type Chirp, type MascotEvent, type MascotOutput, MascotMachine } from '@lumo/mascot';
import { useEffect, useSyncExternalStore } from 'react';

type Listener = () => void;

/** One-shot things every visible Lumo in this window should do now. */
export type MascotAct =
  | { kind: 'celebrate' }
  | { kind: 'boop' }
  | { kind: 'wave' }
  | { kind: 'spin' }
  /** Hop out of the chat icon to a named element (data-lumo-target) or the latest reply, then back. */
  | { kind: 'hop'; target: string | null };

/** Sounds for moods, played once when the mood starts. */
const MOOD_SOUND: Partial<Record<string, Chirp>> = {
  greet: 'hello',
  happy: 'happy',
  recover: 'uhoh',
  unsure: 'question',
  love: 'love',
  sleep: 'yawn',
};

class MascotBus {
  readonly machine = new MascotMachine();
  private out: MascotOutput = this.machine.send({ type: 'boot' });
  private listeners = new Set<Listener>();
  private actors = new Set<(a: MascotAct) => void>();
  private ticking = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Whether this window is the one that makes Lumo's mood noises (only one window should). */
  voiced = false;

  send(e: MascotEvent | MascotEvent[]) {
    for (const x of Array.isArray(e) ? e : [e]) this.out = this.machine.send(x);
    this.emit();
  }

  /** The machine's phase (what the agent is doing), not the displayed mood. */
  get phase() {
    return this.machine.state.phase;
  }

  act(a: MascotAct) {
    for (const f of this.actors) f(a);
  }

  onAct(f: (a: MascotAct) => void) {
    this.actors.add(f);
    return () => void this.actors.delete(f);
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    if (this.ticking++ === 0) {
      this.timer = setInterval(() => {
        const next = this.machine.send({ type: 'tick' });
        if (JSON.stringify(next) !== JSON.stringify(this.out)) {
          this.out = next;
          this.emit();
        }
      }, 120);
    }
    return () => {
      this.listeners.delete(l);
      if (--this.ticking === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  };

  getSnapshot = () => this.out;

  private lastMood = this.out.mood;
  private emit() {
    if (this.out.mood !== this.lastMood) {
      const sound = MOOD_SOUND[this.out.mood];
      if (sound && this.voiced) lumoVoice.play(sound);
      this.lastMood = this.out.mood;
    }
    for (const l of this.listeners) l();
  }
}

export const mascotBus = new MascotBus();

export function useMascotOutput(): MascotOutput {
  return useSyncExternalStore(mascotBus.subscribe, mascotBus.getSnapshot, mascotBus.getSnapshot);
}

/** Composer focus means Lumo is listening, unless it is busy with a run. */
export function useListening(active: boolean, busy: boolean) {
  useEffect(() => {
    if (busy) return;
    if (active) mascotBus.send({ type: 'agent', phase: 'listening' });
    else if (mascotBus.phase === 'listening') mascotBus.send({ type: 'agent', phase: 'idle' });
  }, [active, busy]);
}

/** Play a noise if sounds are on (the voice's own switch follows the setting). */
export function chirp(kind: Chirp) {
  lumoVoice.play(kind);
}
