/**
 * Lumo on the desktop (window label "buddy", loaded at #/buddy): a small transparent window that
 * stays on top, with Lumo in it. The window itself flies: each frame the flight brain
 * (@lumo/mascot stepFlight) decides where he goes and Rust moves the window (buddy_move, which keeps
 * it on screen). He watches the cursor anywhere on the screen, says short things in a speech bubble,
 * and when Lumo uses the computer for you he flies next to each spot first.
 *
 * Click: boop. Double-click: ask Lumo. Drag: put him somewhere. Right-click: a small menu, including
 * "Hide from desktop" (also in Settings and the tray menu).
 */
import {
  holdFlight,
  initialFlight,
  releaseFlight,
  stepFlight,
  type FlightState,
  type Rect,
} from '@lumo/mascot';
import type { LumoMascotHandle } from '@lumo/mascot/react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useRef, useState } from 'react';
import { Mascot } from '../components/Mascot';
import { lineFor, shouldSuggestBreak, type Moment } from '../lib/companion';
import { api, on, type BuddyScreen } from '../lib/ipc';
import { useApp } from '../state/app';
import { chirp, mascotBus, useMascotOutput } from '../state/mascot';

const POLL_MS = 140;
const POINT_HOLD_MS = 3500;
const BUBBLE_MS = 4200;

export function Buddy() {
  const app = useApp();
  const behavior = useMascotOutput();
  const handle = useRef<LumoMascotHandle | null>(null);
  const [bubble, setBubble] = useState<{ text: string; action?: 'open' } | null>(null);
  const [menu, setMenu] = useState(false);
  const screen = useRef<BuddyScreen | null>(null);
  const flight = useRef<FlightState | null>(null);
  const point = useRef<{ x: number; y: number; until: number } | null>(null);
  const held = useRef<{ last: string; still: number } | null>(null);
  const mood = useRef(behavior.mood);
  mood.current = behavior.mood;
  const calm = app.settings.reducedMotion;
  const name = app.settings.userName;

  useEffect(() => {
    document.documentElement.dataset.route = 'buddy';
  }, []);

  const say = (moment: Moment, action?: 'open') => {
    setBubble({ text: lineFor(moment, name, new Date(), Math.random()), action });
  };
  useEffect(() => {
    if (!bubble) return;
    const t = setTimeout(() => setBubble(null), bubble.action ? BUBBLE_MS * 2 : BUBBLE_MS);
    return () => clearTimeout(t);
  }, [bubble]);

  // Say hello once.
  useEffect(() => {
    const t = setTimeout(() => say('hello'), 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What Lumo is doing → what he says.
  useEffect(() => {
    const subs = [
      on('agent-event', ({ event: ev }) => {
        if (ev.type === 'run_finished' && ev.status === 'done') say('done');
        else if (ev.type === 'run_finished' && ev.status === 'failed') say('failed', 'open');
        else if (ev.type === 'approval_requested' && !ev.native) say('approval', 'open');
        else if (ev.type === 'question') say('question', 'open');
      }),
      on('buddy-point', (p) => {
        const s = screen.current?.scale ?? 1;
        point.current = { x: p.x * s, y: p.y * s, until: performance.now() + POINT_HOLD_MS };
      }),
    ];
    return () => subs.forEach((p) => void p.then((u) => u()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Gentle care: a break nudge after long sessions, a goodnight late at night, rare idle chatter.
  useEffect(() => {
    const started = Date.now();
    let lastNudge = -Infinity;
    let lateSaid = false;
    let nextChatter = Date.now() + (12 + Math.random() * 12) * 60_000;
    const id = setInterval(() => {
      const now = new Date();
      const activeMin = (Date.now() - started) / 60_000;
      if (shouldSuggestBreak(activeMin, (Date.now() - lastNudge) / 60_000) && mood.current === 'idle') {
        lastNudge = Date.now();
        say('break');
      } else if (!lateSaid && now.getHours() >= 0 && now.getHours() < 4 && mood.current === 'idle') {
        lateSaid = true;
        say('late');
      } else if (Date.now() > nextChatter && mood.current === 'idle') {
        nextChatter = Date.now() + (15 + Math.random() * 20) * 60_000;
        say('idle');
      }
    }, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Screen polling: work areas, scale, where the window is, and the cursor (for his eyes).
  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const s = await api.buddyScreen();
        if (!live) return;
        screen.current = s;
        if (!flight.current)
          flight.current = initialFlight({ x: s.window.x, y: s.window.y }, performance.now() / 1000);
        // Dragged: follow the real window until it stops moving, then carry on from there.
        if (held.current) {
          const key = `${s.window.x},${s.window.y}`;
          if (key === held.current.last) held.current.still += POLL_MS;
          else held.current = { last: key, still: 0 };
          if (held.current.still >= 500) {
            held.current = null;
            flight.current = releaseFlight(
              flight.current,
              { x: s.window.x, y: s.window.y },
              performance.now() / 1000,
            );
            chirp('whoosh');
          }
        }
        if (s.cursor) {
          handle.current?.lookAt(
            { x: (s.cursor.x - s.window.x) / s.scale, y: (s.cursor.y - s.window.y) / s.scale },
            POLL_MS * 3,
          );
        }
      } catch {
        /* the window is closing */
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  // Flight loop: move the window where the flight brain says, and tell the mascot how fast.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let sent = { x: NaN, y: NaN };
    let inFlight = false;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const s = screen.current;
      const f = flight.current;
      if (!s || !f) return;
      if (point.current && now > point.current.until) point.current = null;
      const areas: Rect[] = s.monitors.length ? s.monitors : [{ x: 0, y: 0, width: 1920, height: 1080 }];
      const next = stepFlight(f, {
        now: now / 1000,
        dt,
        mood: mood.current,
        areas,
        size: { w: s.window.width, h: s.window.height },
        scale: s.scale,
        cursor: s.cursor,
        point: point.current,
        calm,
        rng: Math.random,
      });
      flight.current = next;
      const x = Math.round(next.pos.x);
      const y = Math.round(next.pos.y);
      if (x !== sent.x || y !== sent.y) {
        sent = { x, y };
        if (!inFlight) {
          inFlight = true;
          api.buddyMove(x, y).finally(() => (inFlight = false));
        }
      }
      handle.current?.setFlight(next.vel.x / s.scale, next.vel.y / s.scale);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [calm]);

  // Pointer: click boops (the mascot handles that), drag moves the window, right-click opens the menu.
  const down = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    down.current = { x: e.screenX, y: e.screenY };
    setMenu(false);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = down.current;
    if (!d || Math.hypot(e.screenX - d.x, e.screenY - d.y) < 6) return;
    down.current = null;
    if (flight.current) flight.current = holdFlight(flight.current);
    held.current = { last: '', still: 0 };
    void getCurrentWindow()
      .startDragging()
      .catch(() => (held.current = null));
  };
  const onPointerUp = () => (down.current = null);

  const hide = async () => {
    setMenu(false);
    chirp('pop');
    try {
      await api.buddyHide();
    } catch (e) {
      app.reportError(e, 'Couldn’t hide Lumo');
    }
  };

  return (
    <div
      className="lm-buddy"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => void api.toggleCompactWindow()}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu((m) => !m);
      }}
    >
      {bubble && (
        <button
          type="button"
          className="lm-buddy-bubble"
          onClick={() => {
            if (bubble.action === 'open') void api.showMainWindow();
            setBubble(null);
          }}
        >
          {bubble.text}
        </button>
      )}
      <Mascot
        size="buddy"
        className="lm-buddy-mascot"
        handle={handle}
        ground={false}
        onPoke={() => {
          mascotBus.send({ type: 'activity' });
          if (Math.random() < 0.3) say('poke');
        }}
      />
      {menu && (
        <div className="lm-buddy-menu" role="menu">
          <button role="menuitem" onClick={() => (setMenu(false), void api.toggleCompactWindow())}>
            Ask Lumo…
          </button>
          <button role="menuitem" onClick={() => (setMenu(false), void api.showMainWindow())}>
            Open Lumo
          </button>
          <button role="menuitem" onClick={() => void hide()}>
            Hide from desktop
          </button>
        </div>
      )}
    </div>
  );
}
