import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG as C,
  initialState,
  output,
  reduce,
  type MascotEvent,
  type MascotState,
} from '../src/behavior/machine';

function run(events: [number, MascotEvent][], s: MascotState = initialState(0)) {
  for (const [t, e] of events) s = reduce(s, e, t);
  return s;
}

describe('mascot behavior machine', () => {
  it('greets on boot, then settles to idle', () => {
    let s = run([[0, { type: 'boot' }]]);
    expect(output(s).mood).toBe('greet');
    s = reduce(s, { type: 'tick' }, C.greetMs + 1);
    expect(output(s).mood).toBe('idle');
  });

  it('maps agent phases to moods', () => {
    const cases = {
      listening: 'listen',
      thinking: 'think',
      planning: 'process',
      searching: 'search',
      working: 'work',
      speaking: 'speak',
      uncertain: 'unsure',
      awaiting_approval: 'listen',
    } as const;
    for (const [phase, mood] of Object.entries(cases)) {
      const s = run([[1000, { type: 'agent', phase: phase as keyof typeof cases }]]);
      expect(output(s).mood, phase).toBe(mood);
    }
  });

  it('smooths rapid phase changes with a minimum dwell', () => {
    let s = run([
      [1000, { type: 'agent', phase: 'thinking' }],
      [1100, { type: 'agent', phase: 'searching' }],
    ]);
    expect(output(s).mood).toBe('think');
    s = reduce(s, { type: 'tick' }, 1000 + C.minDwellMs);
    expect(output(s).mood).toBe('search');
  });

  it('celebrates once on done, with a pulse, then returns to idle', () => {
    let s = run([
      [1000, { type: 'agent', phase: 'working' }],
      [3000, { type: 'agent', phase: 'done' }],
    ]);
    expect(output(s)).toMatchObject({ mood: 'happy', pulses: 1 });
    s = reduce(s, { type: 'tick' }, 3000 + C.celebrateMs + 1);
    expect(output(s).mood).toBe('idle');
  });

  it('shows recovery on failure, then returns to idle', () => {
    let s = run([[1000, { type: 'agent', phase: 'failed' }]]);
    expect(output(s).mood).toBe('recover');
    s = reduce(s, { type: 'tick' }, 1000 + C.recoverMs + 1);
    expect(output(s).mood).toBe('idle');
  });

  it('a new task interrupts a celebration', () => {
    const s = run([
      [1000, { type: 'agent', phase: 'done' }],
      [1500, { type: 'agent', phase: 'thinking' }],
    ]);
    expect(output(s).mood).toBe('think');
  });

  it('falls asleep after inactivity only while idle, and wakes with a greeting', () => {
    let s = run([[0, { type: 'tick' }]]);
    s = reduce(s, { type: 'tick' }, C.sleepAfterMs + 1);
    expect(output(s).mood).toBe('sleep');
    s = reduce(s, { type: 'activity' }, C.sleepAfterMs + 10);
    expect(output(s).mood).toBe('greet');

    let busy = run([[0, { type: 'agent', phase: 'working' }]]);
    busy = reduce(busy, { type: 'tick' }, C.sleepAfterMs * 2);
    expect(output(busy).mood).toBe('work');
  });

  it('looks toward attention targets briefly', () => {
    let s = run([[0, { type: 'attention', target: { x: 2, y: -0.5 } }]]);
    expect(output(s).gaze).toEqual({ x: 1, y: -0.5 });
    s = reduce(s, { type: 'tick' }, C.attentionMs + 1);
    expect(output(s).gaze).toBeNull();
  });
});

describe('typing, attention to elements, locomotion and facing', () => {
  it('maps the typing phase to the type mood', () => {
    const s = run([[1000, { type: 'agent', phase: 'typing' }]]);
    expect(output(s).mood).toBe('type');
  });

  it('walks to the workspace for work and typing, and home again afterwards', () => {
    let s = run([[1000, { type: 'agent', phase: 'typing' }]]);
    expect(output(s).locomotion).toEqual({ x: C.stations.workspace, facing: 'viewer' });
    s = reduce(s, { type: 'agent', phase: 'working' }, 2000);
    expect(output(s).locomotion.x).toBe(C.stations.workspace);
    s = reduce(s, { type: 'agent', phase: 'speaking' }, 3000);
    expect(output(s).locomotion.x).toBe(C.stations.home);
  });

  it('location follows the dwell-smoothed mood, not every flicker', () => {
    let s = run([
      [1000, { type: 'agent', phase: 'thinking' }],
      [1100, { type: 'agent', phase: 'typing' }],
    ]);
    expect(output(s).locomotion.x).toBe(C.stations.home);
    s = reduce(s, { type: 'tick' }, 1000 + C.minDwellMs);
    expect(output(s).locomotion.x).toBe(C.stations.workspace);
  });

  it('stays put while celebrating or recovering, then goes home', () => {
    let s = run([
      [1000, { type: 'agent', phase: 'typing' }],
      [5000, { type: 'agent', phase: 'done' }],
    ]);
    expect(output(s)).toMatchObject({ mood: 'happy', locomotion: { x: C.stations.workspace } });
    s = reduce(s, { type: 'tick' }, 5000 + C.celebrateMs + 1);
    expect(output(s)).toMatchObject({ mood: 'idle', locomotion: { x: C.stations.home } });

    let f = run([
      [1000, { type: 'agent', phase: 'working' }],
      [5000, { type: 'agent', phase: 'failed' }],
    ]);
    expect(output(f).locomotion.x).toBe(C.stations.workspace);
    f = reduce(f, { type: 'tick' }, 5000 + C.recoverMs + 1);
    expect(output(f).locomotion.x).toBe(C.stations.home);
  });

  it('moves to a named station or a clamped x, until the base mood changes', () => {
    let s = run([[1000, { type: 'move', to: 'workspace' }]]);
    expect(output(s).locomotion.x).toBe(C.stations.workspace);
    s = reduce(s, { type: 'move', to: -3 }, 1100);
    expect(output(s).locomotion.x).toBe(-1);
    s = reduce(s, { type: 'move', to: 'nowhere' }, 1200);
    expect(output(s).locomotion.x).toBe(-1);
    s = reduce(s, { type: 'agent', phase: 'listening' }, 2000);
    expect(output(s).locomotion.x).toBe(C.stations.home);
  });

  it('uses configured stations', () => {
    const cfg = { ...C, stations: { home: -0.5, workspace: 0.8, inbox: 0.2 } };
    let s = initialState(0, cfg);
    expect(output(s).locomotion.x).toBe(-0.5);
    s = reduce(s, { type: 'agent', phase: 'typing' }, 1000, cfg);
    expect(output(s).locomotion.x).toBe(0.8);
    s = reduce(s, { type: 'move', to: 'inbox' }, 1100, cfg);
    expect(output(s).locomotion.x).toBe(0.2);
  });

  it('turns on request; a working phase or sleep faces the viewer again', () => {
    let s = run([[1000, { type: 'face', facing: 'away' }]]);
    expect(output(s).locomotion.facing).toBe('away');
    s = reduce(s, { type: 'agent', phase: 'idle' }, 1100);
    expect(output(s).locomotion.facing).toBe('away');
    s = reduce(s, { type: 'agent', phase: 'thinking' }, 2000);
    expect(output(s).locomotion.facing).toBe('viewer');

    let z = run([[0, { type: 'face', facing: 'left' }]]);
    z = reduce(z, { type: 'tick' }, C.sleepAfterMs + 1);
    expect(output(z)).toMatchObject({ mood: 'sleep', locomotion: { x: C.stations.home, facing: 'viewer' } });
  });

  it('attends to named UI elements briefly; newer gaze requests replace older ones', () => {
    let s = run([[0, { type: 'attend', target: 'composer' }]]);
    expect(output(s)).toMatchObject({ attend: 'composer', gaze: null });
    s = reduce(s, { type: 'attention', target: { x: 0.3, y: 0.2 } }, 100);
    expect(output(s)).toMatchObject({ attend: null, gaze: { x: 0.3, y: 0.2 } });
    s = reduce(s, { type: 'attend', target: 'approval', durationMs: 500 }, 200);
    expect(output(s)).toMatchObject({ attend: 'approval', gaze: null });
    s = reduce(s, { type: 'tick' }, 701);
    expect(output(s).attend).toBeNull();
    s = reduce(s, { type: 'attend', target: 'composer' }, 800);
    s = reduce(s, { type: 'attend', target: null }, 900);
    expect(output(s).attend).toBeNull();
  });

  it('attends to nothing while asleep', () => {
    let s = run([[0, { type: 'tick' }]]);
    s = reduce(s, { type: 'tick' }, C.sleepAfterMs + 1);
    s = { ...s, attend: { target: 'composer', until: Infinity } };
    expect(output(s).attend).toBeNull();
  });
});
