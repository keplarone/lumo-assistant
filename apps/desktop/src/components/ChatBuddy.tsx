/**
 * Lumo as the chat's icon. He sits in a little round nest in the conversation header; when something
 * needs you (an approval, a question) or a task finishes, he flies out of the icon to it, hovers
 * there a moment looking at it, and flies back. In flight he banks into the turn and is drawn with
 * motion blur (blur plus a stretch along his direction of travel).
 *
 * The flyer never takes clicks while it is out (pointer-events: none), so he never gets in the way.
 * With reduced motion he stays in the icon and just reacts there.
 */
import type { LumoMascotHandle } from '@lumo/mascot/react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../state/app';
import { chirp, mascotBus } from '../state/mascot';
import { Mascot } from './Mascot';

const FLYER = 92;
const OUT_MS = 620;
const STAY_MS = 1700;
const BACK_MS = 560;

interface P {
  x: number;
  y: number;
}

function prefersReduced(setting: boolean) {
  return (
    setting || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  );
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const bez = (a: P, c: P, b: P, t: number): P => ({
  x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x,
  y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y,
});

/** Motion blur for a moving element: blur grows with speed, and it stretches along its heading. */
export function motionBlurStyle(vx: number, vy: number): { filter: string; stretch: string } {
  const speed = Math.hypot(vx, vy);
  const blur = Math.min(5, speed / 380);
  if (blur < 0.35) return { filter: '', stretch: '' };
  const ang = (Math.atan2(vy, vx) * 180) / Math.PI;
  const k = 1 + Math.min(0.35, speed / 4000);
  return {
    filter: `blur(${blur.toFixed(2)}px)`,
    stretch: ` rotate(${ang.toFixed(1)}deg) scale(${k.toFixed(3)}, ${(1 / Math.sqrt(k)).toFixed(3)}) rotate(${(-ang).toFixed(1)}deg)`,
  };
}

export function ChatBuddy() {
  const { settings } = useApp();
  const nest = useRef<HTMLDivElement>(null);
  const flyer = useRef<HTMLDivElement>(null);
  const handle = useRef<LumoMascotHandle | null>(null);
  const [out, setOut] = useState(false);
  const flying = useRef(false);
  const reduced = prefersReduced(settings.reducedMotion);

  // Keep the flyer over the nest while docked.
  useEffect(() => {
    const place = () => {
      if (flying.current || !nest.current || !flyer.current) return;
      const r = nest.current.getBoundingClientRect();
      flyer.current.style.transform = `translate(${r.left + r.width / 2 - FLYER / 2}px, ${r.top + r.height / 2 - FLYER / 2 - 6}px)`;
    };
    place();
    const ro = new ResizeObserver(place);
    if (nest.current) ro.observe(nest.current);
    window.addEventListener('resize', place);
    const id = setInterval(place, 500);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
      clearInterval(id);
    };
  }, []);

  useEffect(
    () =>
      mascotBus.onAct((a) => {
        if (a.kind !== 'hop' || flying.current || !settings.mascotEnabled) return;
        const h = handle.current;
        if (reduced) {
          h?.wave('right');
          return;
        }
        const target = a.target
          ? document.querySelector(`[data-lumo-target="${CSS.escape(a.target)}"]`)
          : [...document.querySelectorAll('.lm-assistant')].pop();
        if (!target || !nest.current || !flyer.current) {
          h?.celebrate();
          return;
        }
        void hop(target, a.target == null);
      }),
    // hop reads refs only
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reduced, settings.mascotEnabled],
  );

  async function hop(target: Element, celebrate: boolean) {
    const el = flyer.current!;
    const n = nest.current!.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    const start = { x: n.left + n.width / 2, y: n.top + n.height / 2 };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const end = {
      x: Math.min(vw - FLYER / 2 - 8, Math.max(FLYER / 2 + 8, t.left - FLYER * 0.15)),
      y: Math.min(vh - FLYER / 2 - 8, Math.max(FLYER / 2 + 8, t.top + Math.min(40, t.height / 2))),
    };
    const ctrl = { x: (start.x + end.x) / 2 + 60, y: Math.min(start.y, end.y) - 80 };
    flying.current = true;
    setOut(true);
    el.dataset.flying = 'true';
    chirp('whoosh');
    await fly(el, start, ctrl, end, OUT_MS);
    if (celebrate) handle.current?.celebrate();
    else handle.current?.wave('right');
    await hover(el, end, STAY_MS);
    chirp('whoosh');
    const n2 = nest.current?.getBoundingClientRect() ?? n;
    const home = { x: n2.left + n2.width / 2, y: n2.top + n2.height / 2 - 6 };
    await fly(el, end, { x: (end.x + home.x) / 2 - 80, y: Math.min(end.y, home.y) - 60 }, home, BACK_MS);
    handle.current?.setFlight(0, 0);
    el.style.filter = '';
    delete el.dataset.flying;
    flying.current = false;
    setOut(false);
    chirp('pop');
  }

  function fly(el: HTMLElement, a: P, c: P, b: P, ms: number) {
    return new Promise<void>((resolve) => {
      const t0 = performance.now();
      let prev = a;
      let prevT = t0;
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / ms);
        const p = bez(a, c, b, ease(k));
        const dt = Math.max(1, now - prevT) / 1000;
        const vx = (p.x - prev.x) / dt;
        const vy = (p.y - prev.y) / dt;
        prev = p;
        prevT = now;
        const mb = motionBlurStyle(vx, vy);
        el.style.transform = `translate(${p.x - FLYER / 2}px, ${p.y - FLYER / 2}px)${mb.stretch}`;
        el.style.filter = mb.filter;
        handle.current?.setFlight(vx, vy);
        if (k < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  function hover(el: HTMLElement, at: P, ms: number) {
    return new Promise<void>((resolve) => {
      handle.current?.setFlight(0, 0);
      el.style.filter = '';
      el.style.transform = `translate(${at.x - FLYER / 2}px, ${at.y - FLYER / 2}px)`;
      setTimeout(resolve, ms);
    });
  }

  return (
    <div className="lm-chat-nest" ref={nest} data-out={out || undefined}>
      {/* In a portal so page transitions (transforms) never re-anchor the fixed-position flyer. */}
      {createPortal(
        <div className="lm-chat-flyer" ref={flyer} style={{ width: FLYER, height: FLYER }}>
          <Mascot size="nest" handle={handle} ground={false} label="Lumo" />
        </div>,
        document.body,
      )}
    </div>
  );
}
