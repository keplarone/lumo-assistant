/** One mascot behavior machine per window, driven by agent events and the composer. */
import { MascotMachine, type MascotEvent, type MascotOutput } from '@lumo/mascot';
import { useEffect, useSyncExternalStore } from 'react';

type Listener = () => void;

class MascotBus {
  readonly machine = new MascotMachine();
  private out: MascotOutput = this.machine.send({ type: 'boot' });
  private listeners = new Set<Listener>();
  private ticking = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  send(e: MascotEvent | MascotEvent[]) {
    for (const x of Array.isArray(e) ? e : [e]) this.out = this.machine.send(x);
    this.emit();
  }

  /** The machine's phase (what the agent is doing), not the displayed mood. */
  get phase() {
    return this.machine.state.phase;
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

  private emit() {
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
