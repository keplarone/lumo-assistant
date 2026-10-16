import { describe, expect, it } from 'vitest';
import { gazeTowardClientPoint } from '../src/core/gaze';

const canvas = { left: 100, top: 100, width: 200, height: 200 }; // head origin at (200, 184)

describe('gaze toward a client-space point', () => {
  it('looks straight ahead at the head position', () => {
    expect(gazeTowardClientPoint({ x: 200, y: 184 }, canvas)).toEqual({ x: 0, y: -0.1 });
  });

  it('matches the reference pointer mapping inside the canvas', () => {
    const g = gazeTowardClientPoint({ x: 250, y: 184 }, canvas);
    expect(g.x).toBeCloseTo(0.65);
    expect(g.y).toBeCloseTo(-0.1);
  });

  it('keeps direction and caps magnitude for targets outside the canvas', () => {
    const right = gazeTowardClientPoint({ x: 5000, y: 184 }, canvas);
    expect(right.x).toBe(1);
    expect(Math.abs(right.y)).toBeLessThan(0.01);
    const upLeft = gazeTowardClientPoint({ x: -1000, y: -1000 }, canvas);
    expect(upLeft.x).toBeLessThan(0);
    expect(upLeft.y).toBeGreaterThan(0);
    expect(Math.max(Math.abs(upLeft.x), Math.abs(upLeft.y))).toBeCloseTo(1);
    expect(upLeft.y / upLeft.x).toBeLessThan(0);
  });

  it('honours an explicit head origin (e.g. after walking)', () => {
    const g = gazeTowardClientPoint({ x: 150, y: 184 }, canvas, { x: 150, y: 184 });
    expect(g).toEqual({ x: 0, y: -0.1 });
  });
});
