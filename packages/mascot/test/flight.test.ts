import { describe, expect, it } from 'vitest';
import {
  areaFor,
  besidePoint,
  clampInto,
  holdFlight,
  initialFlight,
  releaseFlight,
  stepFlight,
  type FlightInput,
  type FlightState,
  type Rect,
} from '../src/behavior/flight';
import { mulberry32 } from '../src/core/character';

const SCREEN: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const SIZE = { w: 220, h: 240 };

function run(
  s: FlightState,
  seconds: number,
  over: Partial<FlightInput> = {},
  start = 0,
): { s: FlightState; inside: boolean; now: number } {
  const rng = mulberry32(3);
  let inside = true;
  const dt = 1 / 60;
  let now = start;
  for (let i = 0; i < seconds * 60; i++) {
    now += dt;
    s = stepFlight(s, {
      now,
      dt,
      mood: 'idle',
      areas: [SCREEN],
      size: SIZE,
      scale: 1,
      cursor: { x: 900, y: 500 },
      point: null,
      calm: false,
      rng,
      ...over,
    });
    const areas = over.areas ?? [SCREEN];
    const a = areaFor(areas, { x: s.pos.x + SIZE.w / 2, y: s.pos.y + SIZE.h / 2 });
    if (
      s.pos.x < a.x - 0.5 ||
      s.pos.y < a.y - 0.5 ||
      s.pos.x + SIZE.w > a.x + a.width + 0.5 ||
      s.pos.y + SIZE.h > a.y + a.height + 0.5
    )
      inside = false;
  }
  return { s, inside, now };
}

describe('desktop flight', () => {
  it('wanders for minutes without ever leaving the screen, and actually moves', () => {
    const start = initialFlight({ x: 1600, y: 760 });
    const { s, inside } = run(start, 240);
    expect(inside).toBe(true);
    expect(Math.hypot(s.pos.x - 1600, s.pos.y - 760) + Math.abs(s.vel.x)).toBeGreaterThanOrEqual(0);
    // Over 4 minutes he has been somewhere else at least once.
    let moved = false;
    let st = start;
    const rng = mulberry32(5);
    for (let i = 0; i < 240 * 60; i++) {
      st = stepFlight(st, { now: i / 60, dt: 1 / 60, mood: 'idle', areas: [SCREEN], size: SIZE, scale: 1, cursor: null, point: null, calm: false, rng });
      if (Math.hypot(st.pos.x - 1600, st.pos.y - 760) > 200) moved = true;
    }
    expect(moved).toBe(true);
  });

  it('goes to the dock in the bottom-right corner while Lumo is working', () => {
    const { s } = run(initialFlight({ x: 100, y: 100 }), 6, { mood: 'type' });
    expect(s.mode).toBe('dock');
    expect(s.pos.x).toBeCloseTo(1920 - 220 - 24, 0);
    expect(s.pos.y).toBeCloseTo(1040 - 240 - 24, 0);
  });

  it('lands on the bottom edge to nap', () => {
    const { s } = run(initialFlight({ x: 600, y: 200 }), 6, { mood: 'sleep' });
    expect(s.mode).toBe('nap');
    expect(s.pos.y).toBeCloseTo(1040 - 240, 0);
    expect(s.pos.x).toBeCloseTo(600, 0);
  });

  it('flies beside a spot he is about to click, never covering it', () => {
    for (const pt of [
      { x: 960, y: 520 },
      { x: 1910, y: 10 },
      { x: 5, y: 1035 },
      { x: 1900, y: 1030 },
    ]) {
      const { s } = run(initialFlight({ x: 300, y: 300 }), 4, { point: pt });
      expect(s.mode).toBe('point');
      const covers = pt.x >= s.pos.x && pt.x <= s.pos.x + SIZE.w && pt.y >= s.pos.y && pt.y <= s.pos.y + SIZE.h;
      expect(covers, JSON.stringify({ pt, pos: s.pos })).toBe(false);
    }
  });

  it('stays on the right monitor with negative coordinates', () => {
    const left: Rect = { x: -1280, y: 0, width: 1280, height: 1000 };
    const { inside } = run(initialFlight({ x: -900, y: 400 }), 120, { areas: [left, SCREEN] });
    expect(inside).toBe(true);
  });

  it('happy moods loop the loop, and come back to hovering', () => {
    let { s, now } = run(initialFlight({ x: 800, y: 500 }), 1);
    ({ s, now } = run(s, 0.3, { mood: 'happy' }, now));
    expect(s.mode).toBe('loop');
    ({ s } = run(s, 2, { mood: 'happy' }, now));
    expect(s.mode).not.toBe('loop');
  });

  it('holds still while dragged and resumes from where it was dropped', () => {
    let s = holdFlight(initialFlight({ x: 800, y: 500 }));
    s = run(s, 2).s;
    expect(s.pos).toEqual({ x: 800, y: 500 });
    s = releaseFlight(s, { x: 100, y: 120 }, 2);
    expect(s.mode).toBe('hover');
    expect(s.pos).toEqual({ x: 100, y: 120 });
  });

  it('clamps and places geometry correctly', () => {
    expect(clampInto({ x: -50, y: 2000 }, SIZE, SCREEN)).toEqual({ x: 0, y: 800 });
    const p = besidePoint({ x: 1000, y: 500 }, SIZE, SCREEN, 36);
    expect(p.x).toBe(1036);
  });
});
