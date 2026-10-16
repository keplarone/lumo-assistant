/**
 * The live hero mascot (lazy chunk: three.js and the mascot load only when this is rendered).
 *
 * Behaviors, all driven through MascotMachine:
 * - greets once when it appears;
 * - eyes follow the pointer (LumoMascot's followPointer);
 * - pointing at or focusing a call to action ([data-lumo-look]) makes Lumo listen and look at it;
 * - scrolling the hero away makes Lumo glance down toward the content (native scroll, no hijacking);
 * - a click or tap on Lumo, or the "Wave" button, plays a short celebration with a light pulse.
 */
import { useEffect, useImperativeHandle, useRef, type Ref, type RefObject } from 'react';
import { LumoMascot, type LumoMascotHandle } from '@lumo/mascot/react';
import { useMascotMachine } from './useMascotMachine';

export interface LiveHandle {
  poke(): void;
}

export default function HeroLive({
  stageRef,
  onReady,
  calm,
  handle,
}: {
  stageRef: RefObject<HTMLElement | null>;
  onReady(): void;
  calm: boolean;
  handle: Ref<LiveHandle>;
}) {
  const { output, send } = useMascotMachine();
  const mascot = useRef<LumoMascotHandle>(null);
  const lastPoke = useRef(0);

  const poke = () => {
    const now = performance.now();
    if (now - lastPoke.current < 700) return;
    lastPoke.current = now;
    send({ type: 'agent', phase: 'done' });
  };
  useImperativeHandle(handle, () => ({ poke }));

  // Greet once, and report readiness after the first frames are on screen.
  useEffect(() => {
    if (!calm) send({ type: 'boot' });
    let raf = 0;
    let frames = 0;
    const wait = () => {
      if (mascot.current?.lumo && ++frames > 2) onReady();
      else raf = requestAnimationFrame(wait);
    };
    raf = requestAnimationFrame(wait);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Calls to action: listen and look toward them.
  useEffect(() => {
    const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-lumo-look]'));
    // The mascot host resolves [data-lumo-target] names to elements and aims the gaze itself.
    const look = (el: HTMLElement) => {
      send({ type: 'agent', phase: 'listening' });
      send({ type: 'attend', target: el.dataset.lumoTarget ?? null, durationMs: 4000 });
    };
    const release = () => {
      send({ type: 'attend', target: null });
      send({ type: 'agent', phase: 'idle' });
    };
    const offs = targets.map((el) => {
      const on = () => look(el);
      el.addEventListener('pointerenter', on);
      el.addEventListener('focus', on);
      el.addEventListener('pointerleave', release);
      el.addEventListener('blur', release);
      return () => {
        el.removeEventListener('pointerenter', on);
        el.removeEventListener('focus', on);
        el.removeEventListener('pointerleave', release);
        el.removeEventListener('blur', release);
      };
    });
    return () => offs.forEach((f) => f());
  }, [stageRef, send]);

  // Scroll position: as the hero leaves, Lumo glances down at what comes next.
  useEffect(() => {
    if (calm) return;
    const stage = stageRef.current;
    if (!stage) return;
    let looking = false;
    let raf = 0;
    const check = () => {
      raf = 0;
      const r = stage.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, -r.top / Math.max(1, r.height)));
      if (p > 0.22 && !looking) {
        looking = true;
        send({ type: 'attention', target: { x: 0.05, y: -0.95 }, durationMs: 60_000 });
      } else if (p < 0.12 && looking) {
        looking = false;
        send({ type: 'attention', target: null });
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [stageRef, send, calm]);

  return (
    <LumoMascot
      ref={mascot}
      className="stage-live"
      behavior={output}
      followPointer={!calm}
      fps={calm ? 30 : 60}
      framing={5.2}
      particles={calm ? 80 : 150}
      onPoke={poke}
      label="Lumo, the mascot"
    />
  );
}
