/**
 * The mascot behavior state machine: turns what the app is actually doing into what Lumo shows.
 *
 * Pure and deterministic (time is passed in), so it is unit-tested without WebGL. The React
 * component feeds it events and applies its output to the rig.
 *
 * Rules:
 * - Each agent phase maps to one mood. Rapid phase changes are smoothed by a minimum dwell time so
 *   the character never flickers between poses.
 * - Outcomes (done, failed) and greetings are transient: they play for a while, then return to the
 *   current base mood. Done celebrates once (with a light pulse); failed dims, then recovers.
 * - With no activity while idle, Lumo falls asleep; any activity wakes it with a short greeting.
 * - Attention requests (a file dragged in, an approval card appearing) override gaze briefly.
 */
export type AgentPhase =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'planning'
  | 'searching'
  | 'working'
  | 'awaiting_approval'
  | 'speaking'
  | 'uncertain'
  | 'done'
  | 'failed';

export interface Point { x: number; y: number }

export type MascotEvent =
  | { type: 'boot' }
  | { type: 'agent'; phase: AgentPhase }
  | { type: 'activity' }
  | { type: 'attention'; target: Point | null; durationMs?: number }
  | { type: 'tick' };

export interface MascotConfig {
  minDwellMs: number;
  sleepAfterMs: number;
  celebrateMs: number;
  recoverMs: number;
  greetMs: number;
  attentionMs: number;
}

export const DEFAULT_CONFIG: MascotConfig = {
  minDwellMs: 450,
  sleepAfterMs: 3 * 60_000,
  celebrateMs: 2200,
  recoverMs: 2600,
  greetMs: 1800,
  attentionMs: 1800,
};

interface Transient { mood: string; until: number }

export interface MascotState {
  phase: AgentPhase;
  /** Mood shown when nothing transient is playing. */
  baseMood: string;
  /** A base mood waiting for the dwell time to pass. */
  pendingMood: string | null;
  baseSince: number;
  transient: Transient | null;
  asleep: boolean;
  lastActivity: number;
  attention: (Point & { until: number }) | null;
  /** Incremented each time a light pulse should fire (celebration). */
  pulses: number;
}

export interface MascotOutput {
  mood: string;
  gaze: Point | null;
  pulses: number;
}

export const PHASE_MOOD: Record<AgentPhase, string> = {
  idle: 'idle',
  listening: 'listen',
  thinking: 'think',
  planning: 'process',
  searching: 'search',
  working: 'work',
  awaiting_approval: 'listen',
  speaking: 'speak',
  uncertain: 'unsure',
  // Outcomes are transient; their base mood is idle.
  done: 'idle',
  failed: 'idle',
};

export function initialState(now: number): MascotState {
  return {
    phase: 'idle',
    baseMood: 'idle',
    pendingMood: null,
    baseSince: now,
    transient: null,
    asleep: false,
    lastActivity: now,
    attention: null,
    pulses: 0,
  };
}

function setBase(s: MascotState, mood: string, now: number, cfg: MascotConfig, force = false): MascotState {
  if (mood === s.baseMood) return { ...s, pendingMood: null };
  if (force || now - s.baseSince >= cfg.minDwellMs) return { ...s, baseMood: mood, pendingMood: null, baseSince: now };
  return { ...s, pendingMood: mood };
}

export function reduce(s: MascotState, e: MascotEvent, now: number, cfg: MascotConfig = DEFAULT_CONFIG): MascotState {
  switch (e.type) {
    case 'boot':
      return { ...s, transient: { mood: 'greet', until: now + cfg.greetMs }, lastActivity: now };

    case 'activity': {
      if (s.asleep) {
        return { ...s, asleep: false, lastActivity: now, baseSince: now, transient: { mood: 'greet', until: now + cfg.greetMs } };
      }
      return { ...s, lastActivity: now };
    }

    case 'agent': {
      let next: MascotState = { ...s, phase: e.phase, lastActivity: now, asleep: false };
      if (e.phase === 'done') {
        next = setBase(next, 'idle', now, cfg, true);
        return { ...next, transient: { mood: 'happy', until: now + cfg.celebrateMs }, pulses: s.pulses + 1 };
      }
      if (e.phase === 'failed') {
        next = setBase(next, 'idle', now, cfg, true);
        return { ...next, transient: { mood: 'recover', until: now + cfg.recoverMs } };
      }
      // A new working phase interrupts a celebration or greeting immediately.
      if (e.phase !== 'idle') next = { ...next, transient: null };
      return setBase(next, PHASE_MOOD[e.phase], now, cfg);
    }

    case 'attention':
      if (!e.target) return { ...s, attention: null };
      return {
        ...s,
        lastActivity: now,
        asleep: false,
        attention: { x: clampUnit(e.target.x), y: clampUnit(e.target.y), until: now + (e.durationMs ?? cfg.attentionMs) },
      };

    case 'tick': {
      let next = s;
      if (next.transient && now >= next.transient.until) next = { ...next, transient: null };
      if (next.attention && now >= next.attention.until) next = { ...next, attention: null };
      if (next.pendingMood && now - next.baseSince >= cfg.minDwellMs) {
        next = { ...next, baseMood: next.pendingMood, pendingMood: null, baseSince: now };
      }
      if (!next.asleep && next.phase === 'idle' && !next.transient && now - next.lastActivity >= cfg.sleepAfterMs) {
        next = { ...next, asleep: true };
      }
      return next;
    }
  }
}

export function output(s: MascotState): MascotOutput {
  const mood = s.asleep ? 'sleep' : s.transient ? s.transient.mood : s.baseMood;
  return { mood, gaze: s.attention && !s.asleep ? { x: s.attention.x, y: s.attention.y } : null, pulses: s.pulses };
}

function clampUnit(v: number) {
  return Math.max(-1, Math.min(1, v));
}

/** Small stateful wrapper for UI code. */
export class MascotMachine {
  state: MascotState;
  constructor(
    private cfg: MascotConfig = DEFAULT_CONFIG,
    private clock: () => number = () => performance.now(),
  ) {
    this.state = initialState(this.clock());
  }
  send(e: MascotEvent) {
    this.state = reduce(this.state, e, this.clock(), this.cfg);
    return output(this.state);
  }
  get output() {
    return output(this.state);
  }
}
