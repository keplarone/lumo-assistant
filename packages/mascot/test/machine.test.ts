import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG as C, initialState, output, reduce, type MascotEvent, type MascotState } from '../src/behavior/machine';

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
    const cases = { listening: 'listen', thinking: 'think', planning: 'process', searching: 'search', working: 'work', speaking: 'speak', uncertain: 'unsure', awaiting_approval: 'listen' } as const;
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
