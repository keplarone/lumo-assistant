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
 * - Attention requests (a file dragged in, an approval card appearing) override gaze briefly: either
 *   a gaze point (`attention`) or a named UI element (`attend`) that the host resolves to a DOM
 *   element. The newer request replaces the older one; asleep, Lumo attends to nothing.
 * - Locomotion: Lumo stands at a named station (x in -1..1 across its canvas). Work and typing take
 *   it to the workspace; anything else brings it home. An explicit `move` holds until the base mood
 *   changes. While a transient plays (celebration, recovery, greeting) it stays where it is.
 * - Facing: `face` turns Lumo (e.g. to show its back); any new working phase or sleep faces the
 *   viewer again.
 */
export type AgentPhase =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'planning'
  | 'searching'
  | 'working'
  | 'awaiting_approval'
  | 'typing'
  | 'speaking'
  | 'uncertain'
  | 'done'
  | 'failed';

export interface Point {
  x: number;
  y: number;
}

export type Facing = 'viewer' | 'away' | 'left' | 'right';

export type MascotEvent =
  | { type: 'boot' }
  | { type: 'agent'; phase: AgentPhase }
  | { type: 'activity' }
  | { type: 'attention'; target: Point | null; durationMs?: number }
  /** Look at a named UI element (resolved by the host, e.g. via data-lumo-target). */
  | { type: 'attend'; target: string | null; durationMs?: number }
  /** Go to a station by name, or to x in -1..1 across the canvas. */
  | { type: 'move'; to: string | number }
  | { type: 'face'; facing: Facing }
  | { type: 'tick' };

export interface MascotConfig {
  minDwellMs: number;
  sleepAfterMs: number;
  celebrateMs: number;
  recoverMs: number;
  greetMs: number;
  attentionMs: number;
  /** Named positions, x in -1..1 across the mascot's canvas. Must include home and workspace. */
  stations: Record<string, number> & { home: number; workspace: number };
  /** Base moods that take Lumo to the workspace. */
  workspaceMoods: readonly string[];
}

export const DEFAULT_CONFIG: MascotConfig = {
  minDwellMs: 450,
  sleepAfterMs: 3 * 60_000,
  celebrateMs: 2200,
  recoverMs: 2600,
  greetMs: 1800,
  attentionMs: 1800,
  stations: { home: 0, workspace: 0.6 },
  workspaceMoods: ['work', 'type'],
};

interface Transient {
  mood: string;
  until: number;
}

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
  /** Named UI element to look at. */
  attend: { target: string; until: number } | null;
  /** Explicit position from a `move` event; cleared when the base mood changes. */
  manualX: number | null;
  /** Current position, -1..1. */
  x: number;
  facing: Facing;
  /** Incremented each time a light pulse should fire (celebration). */
  pulses: number;
}

export interface MascotOutput {
  mood: string;
  gaze: Point | null;
  /** Named UI element to look at (takes the gaze while set). */
  attend: string | null;
  pulses: number;
  /** Where to stand (-1..1 across the canvas) and which way to face. */
  locomotion: { x: number; facing: Facing };
}

export const PHASE_MOOD: Record<AgentPhase, string> = {
  idle: 'idle',
  listening: 'listen',
  thinking: 'think',
  planning: 'process',
  searching: 'search',
  working: 'work',
  typing: 'type',
  awaiting_approval: 'listen',
  speaking: 'speak',
  uncertain: 'unsure',
  // Outcomes are transient; their base mood is idle.
  done: 'idle',
  failed: 'idle',
};

export function initialState(now: number, cfg: MascotConfig = DEFAULT_CONFIG): MascotState {
  return {
    phase: 'idle',
    baseMood: 'idle',
    pendingMood: null,
    baseSince: now,
    transient: null,
    asleep: false,
    lastActivity: now,
    attention: null,
    attend: null,
    manualX: null,
    x: cfg.stations.home,
    facing: 'viewer',
    pulses: 0,
  };
}

function setBase(s: MascotState, mood: string, now: number, cfg: MascotConfig, force = false): MascotState {
  if (mood === s.baseMood) return { ...s, pendingMood: null };
  if (force || now - s.baseSince >= cfg.minDwellMs)
    return { ...s, baseMood: mood, pendingMood: null, baseSince: now, manualX: null };
  return { ...s, pendingMood: mood };
}

export function reduce(
  s: MascotState,
  e: MascotEvent,
  now: number,
  cfg: MascotConfig = DEFAULT_CONFIG,
): MascotState {
  return place(step(s, e, now, cfg), cfg);
}

/** Resolve where Lumo stands. Transients (celebrate, recover, greet) hold the current spot. */
function place(s: MascotState, cfg: MascotConfig): MascotState {
  if (s.transient && !s.asleep) return s;
  const x = s.asleep
    ? cfg.stations.home
    : (s.manualX ?? (cfg.workspaceMoods.includes(s.baseMood) ? cfg.stations.workspace : cfg.stations.home));
  return x === s.x ? s : { ...s, x };
}

function step(s: MascotState, e: MascotEvent, now: number, cfg: MascotConfig): MascotState {
  switch (e.type) {
    case 'boot':
      return { ...s, transient: { mood: 'greet', until: now + cfg.greetMs }, lastActivity: now };

    case 'activity': {
      if (s.asleep) {
        return {
          ...s,
          asleep: false,
          lastActivity: now,
          baseSince: now,
          transient: { mood: 'greet', until: now + cfg.greetMs },
        };
      }
      return { ...s, lastActivity: now };
    }

    case 'agent': {
      let next: MascotState = { ...s, phase: e.phase, lastActivity: now, asleep: false };
      // Working phases want Lumo's face; idle and outcomes keep whatever it was doing.
      if (e.phase !== 'idle' && e.phase !== 'done' && e.phase !== 'failed') next.facing = 'viewer';
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
        attend: null,
        attention: {
          x: clampUnit(e.target.x),
          y: clampUnit(e.target.y),
          until: now + (e.durationMs ?? cfg.attentionMs),
        },
      };

    case 'attend':
      if (!e.target) return { ...s, attend: null };
      return {
        ...s,
        lastActivity: now,
        asleep: false,
        attention: null,
        attend: { target: e.target, until: now + (e.durationMs ?? cfg.attentionMs) },
      };

    case 'move': {
      const x = typeof e.to === 'number' ? clampUnit(e.to) : cfg.stations[e.to];
      if (x === undefined || Number.isNaN(x)) return s;
      return { ...s, manualX: x, lastActivity: now };
    }

    case 'face':
      return { ...s, facing: s.asleep ? 'viewer' : e.facing, lastActivity: now };

    case 'tick': {
      let next = s;
      if (next.transient && now >= next.transient.until) next = { ...next, transient: null };
      if (next.attention && now >= next.attention.until) next = { ...next, attention: null };
      if (next.attend && now >= next.attend.until) next = { ...next, attend: null };
      if (next.pendingMood && now - next.baseSince >= cfg.minDwellMs) {
        next = { ...next, baseMood: next.pendingMood, pendingMood: null, baseSince: now, manualX: null };
      }
      if (
        !next.asleep &&
        next.phase === 'idle' &&
        !next.transient &&
        now - next.lastActivity >= cfg.sleepAfterMs
      ) {
        next = { ...next, asleep: true, facing: 'viewer', manualX: null };
      }
      return next;
    }
  }
}

export function output(s: MascotState): MascotOutput {
  const mood = s.asleep ? 'sleep' : s.transient ? s.transient.mood : s.baseMood;
  return {
    mood,
    gaze: s.attention && !s.asleep ? { x: s.attention.x, y: s.attention.y } : null,
    attend: s.attend && !s.asleep ? s.attend.target : null,
    pulses: s.pulses,
    locomotion: { x: s.x, facing: s.asleep ? 'viewer' : s.facing },
  };
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
    this.state = initialState(this.clock(), this.cfg);
  }
  send(e: MascotEvent) {
    this.state = reduce(this.state, e, this.clock(), this.cfg);
    return output(this.state);
  }
  get output() {
    return output(this.state);
  }
}
