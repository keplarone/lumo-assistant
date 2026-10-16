/**
 * Gaze toward things on the page: converts a client-space point (or a DOM element's centre) into
 * Lumo's gaze coordinates (-1..1, screen-like, y up), relative to where the character's head is on
 * its canvas. Works for targets outside the canvas too: the direction is kept and the magnitude is
 * capped at the edge of the gaze range, so Lumo looks "off to the upper right" toward a toolbar
 * button that lives outside its own little window.
 */
import type { Point } from '../behavior/machine';

export interface RectLike { left: number; top: number; width: number; height: number }

export interface GazeOrigin {
  /** Head position in client px. Defaults to the canvas centre, 42% down (the reference framing). */
  x: number;
  y: number;
}

/** Same scale as the reference page's pointer gaze: x * 1.3, y * 1.4 - 0.1. */
const SX = 1.3, SY = 1.4, OY = -0.1;

export function gazeTowardClientPoint(point: Point, canvas: RectLike, origin?: GazeOrigin): Point {
  const w = Math.max(1, canvas.width), h = Math.max(1, canvas.height);
  const ox = origin?.x ?? canvas.left + w / 2;
  const oy = origin?.y ?? canvas.top + h * 0.42;
  const dx = (point.x - ox) / (w / 2);
  const dy = -(point.y - oy) / (h / 2);
  let gx = dx * SX, gy = dy * SY + OY;
  const m = Math.max(Math.abs(gx), Math.abs(gy));
  if (m > 1) { gx /= m; gy /= m; }
  return { x: round(gx), y: round(gy) };
}

export function gazeTowardElement(el: Element, canvas: RectLike, origin?: GazeOrigin): Point {
  const r = el.getBoundingClientRect();
  return gazeTowardClientPoint({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, canvas, origin);
}

function round(v: number) {
  return Math.round(v * 1e4) / 1e4 || 0;
}
