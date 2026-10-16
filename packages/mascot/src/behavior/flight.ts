/**
 * Where Lumo flies on the desktop. Pure and deterministic (time and randomness are passed in), so it
 * is unit tested; the overlay window feeds it the screen's work areas each frame and moves itself to
 * `pos` (the window's top-left, in physical pixels).
 *
 * - Idle, he lives a little life: hovers a while, then cruises somewhere new, perches on the bottom
 *   edge of the screen (sitting on the taskbar), or comes over to say hi near the cursor (never on
 *   top of it, so he never blocks a click).
 * - While Lumo is working (thinking, typing, talking...) he goes to his dock in the bottom-right
 *   corner and stays there, out of the way.
 * - When he is using the computer for you, he flies next to each spot he is about to click, staying
 *   just clear of it, so you can see what he is doing.
 * - Happy moods do a loop-the-loop. Asleep, he lands on the bottom edge and naps.
 * - While you drag him, he goes where you put him and carries on from there.
 * - Calm (reduced motion): slower, rarer trips, no loops.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Vec {
  x: number;
  y: number;
}

export type FlightMode = 'hover' | 'cruise' | 'perch' | 'visit' | 'dock' | 'point' | 'loop' | 'nap' | 'held';

export interface FlightInput {
  /** Seconds (monotonic). */
  now: number;
  dt: number;
  mood: string;
  /** Usable screen areas (physical px), e.g. each monitor minus its taskbar. */
  areas: Rect[];
  /** Window size (physical px). */
  size: { w: number; h: number };
  /** Display scale factor (speeds and margins scale with it). */
  scale: number;
  cursor: Vec | null;
  /** A spot he is about to act on (computer control), or null. */
  point: Vec | null;
  calm: boolean;
  rng: () => number;
}

export interface FlightState {
  pos: Vec;
  vel: Vec;
  mode: FlightMode;
  target: Vec;
  /** When the current mode ends (seconds), for timed modes. */
  until: number;
  loop: { center: Vec; r: number; t: number; dur: number; dir: number } | null;
  /** Mood seen last step, to notice changes. */
  mood: string;
}

const BUSY = new Set(['think', 'process', 'search', 'work', 'type', 'speak', 'listen', 'unsure']);
const PARTY = new Set(['happy', 'greet']);

export function initialFlight(pos: Vec, now = 0): FlightState {
  return {
    pos: { ...pos },
    vel: { x: 0, y: 0 },
    mode: 'hover',
    target: { ...pos },
    until: now + 3,
    loop: null,
    mood: 'idle',
  };
}

/** The work area that contains p (or the nearest one). */
export function areaFor(areas: Rect[], p: Vec): Rect {
  let best = areas[0] ?? { x: 0, y: 0, width: 1920, height: 1080 };
  let bestD = Infinity;
  for (const a of areas) {
    const dx = Math.max(a.x - p.x, 0, p.x - (a.x + a.width));
    const dy = Math.max(a.y - p.y, 0, p.y - (a.y + a.height));
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

/** Keep a window of `size` with top-left `p` fully inside `a` (top-left wins if it can't fit). */
export function clampInto(p: Vec, size: { w: number; h: number }, a: Rect): Vec {
  return {
    x: Math.max(a.x, Math.min(p.x, a.x + a.width - size.w)),
    y: Math.max(a.y, Math.min(p.y, a.y + a.height - size.h)),
  };
}

const center = (p: Vec, size: { w: number; h: number }): Vec => ({
  x: p.x + size.w / 2,
  y: p.y + size.h / 2,
});

/** Where to sit next to a spot without covering it: beside it, a little above. */
export function besidePoint(pt: Vec, size: { w: number; h: number }, a: Rect, gap: number): Vec {
  const right = { x: pt.x + gap, y: pt.y - size.h * 0.75 };
  const left = { x: pt.x - gap - size.w, y: pt.y - size.h * 0.75 };
  const fitsRight = right.x + size.w <= a.x + a.width;
  const p = clampInto(fitsRight ? right : left, size, a);
  // If clamping pushed the window over the spot (e.g. near a corner), move it above or below.
  if (pt.x >= p.x && pt.x <= p.x + size.w && pt.y >= p.y && pt.y <= p.y + size.h) {
    const above = { x: p.x, y: pt.y - gap - size.h };
    const below = { x: p.x, y: pt.y + gap };
    return clampInto(above.y >= a.y ? above : below, size, a);
  }
  return p;
}

export function dockSpot(a: Rect, size: { w: number; h: number }, margin: number): Vec {
  return { x: a.x + a.width - size.w - margin, y: a.y + a.height - size.h - margin };
}

export function stepFlight(prev: FlightState, inp: FlightInput): FlightState {
  const s: FlightState = { ...prev, pos: { ...prev.pos }, vel: { ...prev.vel }, target: { ...prev.target } };
  const { now, dt, size, scale, rng } = inp;
  const a = areaFor(inp.areas, center(s.pos, size));
  const margin = 24 * scale;
  const moodChanged = inp.mood !== s.mood;
  s.mood = inp.mood;

  if (s.mode === 'held') return s;

  // Decide the mode. Priority: pointing > sleep > busy > party > idle life.
  if (inp.point) {
    s.mode = 'point';
    s.loop = null;
    s.target = besidePoint(inp.point, size, areaFor(inp.areas, inp.point), 36 * scale);
  } else if (inp.mood === 'sleep') {
    if (s.mode !== 'nap') {
      s.mode = 'nap';
      s.loop = null;
      s.target = clampInto({ x: s.pos.x, y: a.y + a.height - size.h }, size, a);
    }
  } else if (BUSY.has(inp.mood)) {
    if (s.mode !== 'dock') {
      s.mode = 'dock';
      s.loop = null;
      s.target = dockSpot(a, size, margin);
    }
  } else if (PARTY.has(inp.mood) && moodChanged && !inp.calm && s.mode !== 'loop') {
    const r = 70 * scale;
    s.mode = 'loop';
    s.loop = { center: { x: s.pos.x, y: s.pos.y - r }, r, t: 0, dur: 1.5, dir: rng() < 0.5 ? -1 : 1 };
  } else if (s.mode === 'point' || s.mode === 'dock' || s.mode === 'nap') {
    s.mode = 'hover';
    s.target = { ...s.pos };
    s.until = now + 2 + rng() * 2;
  } else if (s.mode !== 'loop' && now >= s.until && arrived(s)) {
    pickNext(s, inp, a, margin);
  }

  // Loop-the-loop is kinematic (a circle), then back to hovering.
  if (s.mode === 'loop' && s.loop) {
    const L = s.loop;
    L.t += dt;
    const k = Math.min(1, L.t / L.dur);
    const ang = easeInOut(k) * Math.PI * 2 * L.dir;
    const next = clampInto(
      { x: L.center.x + Math.sin(ang) * L.r, y: L.center.y + Math.cos(ang) * L.r },
      size,
      a,
    );
    s.vel = { x: (next.x - s.pos.x) / Math.max(dt, 1e-3), y: (next.y - s.pos.y) / Math.max(dt, 1e-3) };
    s.pos = next;
    if (k >= 1) {
      s.loop = null;
      s.mode = 'hover';
      s.target = { ...s.pos };
      s.vel = { x: 0, y: 0 };
      s.until = now + 3 + rng() * 3;
    }
    return s;
  }

  s.target = clampInto(s.target, size, areaFor(inp.areas, center(s.target, size)));
  steer(s, dt, scale, inp.calm ? 0.55 : s.mode === 'point' ? 1.6 : 1);
  return s;
}

function arrived(s: FlightState) {
  return Math.hypot(s.target.x - s.pos.x, s.target.y - s.pos.y) < 2 && Math.hypot(s.vel.x, s.vel.y) < 5;
}

function pickNext(s: FlightState, inp: FlightInput, a: Rect, margin: number) {
  const { now, size, rng, calm } = inp;
  const free = {
    x: a.x + margin,
    y: a.y + margin,
    width: a.width - 2 * margin,
    height: a.height - 2 * margin,
  };
  if (s.mode === 'cruise' || s.mode === 'visit' || s.mode === 'perch') {
    // After a trip, hover a while.
    s.mode = 'hover';
    s.target = { ...s.pos };
    s.until = now + (calm ? 10 + rng() * 10 : 4 + rng() * 6);
    return;
  }
  const roll = rng();
  if (inp.cursor && roll < 0.2) {
    s.mode = 'visit';
    const side = inp.cursor.x > a.x + a.width / 2 ? -1 : 1;
    s.target = clampInto(
      {
        x: inp.cursor.x + side * 180 * inp.scale - size.w / 2,
        y: inp.cursor.y - size.h / 2 - 40 * inp.scale,
      },
      size,
      free,
    );
    s.until = now + 4 + rng() * 4;
  } else if (roll < 0.45) {
    s.mode = 'perch';
    s.target = clampInto({ x: free.x + rng() * free.width, y: a.y + a.height - size.h }, size, a);
    s.until = now + 10 + rng() * 15;
  } else {
    s.mode = 'cruise';
    s.target = clampInto({ x: free.x + rng() * free.width, y: free.y + rng() * free.height }, size, free);
    s.until = now + 1;
  }
}

/** Arrive-steering with limited acceleration: eases out of rest, banks into turns, settles softly. */
function steer(s: FlightState, dt: number, scale: number, speedK: number) {
  const dx = s.target.x - s.pos.x;
  const dy = s.target.y - s.pos.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1 && Math.hypot(s.vel.x, s.vel.y) < 8) {
    s.pos = { ...s.target };
    s.vel = { x: 0, y: 0 };
    return;
  }
  const maxSpeed = 780 * scale * speedK;
  const want = Math.min(maxSpeed, dist * 3.2);
  const dvx = (dist > 0 ? (dx / dist) * want : 0) - s.vel.x;
  const dvy = (dist > 0 ? (dy / dist) * want : 0) - s.vel.y;
  const accel = 2600 * scale * speedK * dt;
  const dv = Math.hypot(dvx, dvy);
  const k = dv > accel ? accel / dv : 1;
  s.vel.x += dvx * k;
  s.vel.y += dvy * k;
  s.pos.x += s.vel.x * dt;
  s.pos.y += s.vel.y * dt;
}

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** The user grabbed him: stop flying until released. */
export function holdFlight(s: FlightState): FlightState {
  return { ...s, mode: 'held', vel: { x: 0, y: 0 }, loop: null };
}

/** Released at `pos` (where the window really is now): hover there a moment, then carry on. */
export function releaseFlight(s: FlightState, pos: Vec, now: number): FlightState {
  return { ...s, mode: 'hover', pos: { ...pos }, target: { ...pos }, vel: { x: 0, y: 0 }, until: now + 3 };
}
