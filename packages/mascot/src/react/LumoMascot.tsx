/**
 * React Three Fiber host for Lumo. Owns the render loop policy:
 * - renders on demand, capped to `fps` while active and lower while idle or asleep;
 * - stops entirely when the canvas is off-screen or the document is hidden;
 * - respects prefers-reduced-motion (calm rig + lower frame rate);
 * - disposes every GPU resource on unmount.
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from 'react';
import * as THREE from 'three';
import { LumoCompanion } from '../core/companion';
import { STATES } from '../core/lumo';
import type { MascotOutput, Point } from '../behavior/machine';

export interface LumoMascotHandle {
  /** The live character, for imperative one-shots (blink, pulse, walkTo, turnAround). */
  readonly lumo: LumoCompanion | null;
}

export interface LumoMascotProps {
  /** What to show, usually from MascotMachine output. */
  behavior: MascotOutput;
  /** Follow the pointer with the eyes when nothing else holds the gaze. */
  followPointer?: boolean;
  /** Called when the character is clicked or tapped. */
  onPoke?: () => void;
  /** Max frames per second while active. */
  fps?: number;
  /** Framing: how much of the scene height to fit (larger = smaller character). */
  framing?: number;
  /** Fewer particles for compact surfaces. */
  particles?: number;
  /** 0..1 TTS level to drive the beak; null for automatic. */
  speakLevel?: number | null;
  className?: string;
  style?: CSSProperties;
  label?: string;
}

function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(() =>
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)').matches : false,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduce(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduce;
}

function Framing({ framing }: { framing: number }) {
  const { camera, size } = useThree();
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const aspect = size.width / Math.max(1, size.height);
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    // Same fit rule as the reference: fit 5.5 units tall or 5.9 units wide, whichever is tighter.
    const dist = Math.max(framing / (2 * tanH), (framing + 0.4) / (2 * tanH * aspect));
    cam.position.set(0, 0.35, dist);
    cam.lookAt(0, 0.2, 0);
    cam.updateProjectionMatrix();
  }, [camera, size, framing]);
  return null;
}

function Driver({ fps, active, idleFps }: { fps: number; active: boolean; idleFps: number }) {
  const { invalidate } = useThree();
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last >= 1000 / idleFps - 1) {
        last = now;
        invalidate();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [invalidate, active, fps, idleFps]);
  return null;
}

function Character({
  lumoRef,
  behavior,
  followPointer,
  onPoke,
  calm,
  particles,
  speakLevel,
}: {
  lumoRef: React.MutableRefObject<LumoCompanion | null>;
  behavior: MascotOutput;
  followPointer: boolean;
  onPoke?: () => void;
  calm: boolean;
  particles: number;
  speakLevel: number | null;
}) {
  const { gl } = useThree();
  const lumo = useMemo(() => new LumoCompanion({ pixelRatio: gl.getPixelRatio(), calm, particles }), [gl, calm, particles]);
  lumoRef.current = lumo;
  useEffect(() => () => lumo.dispose(), [lumo]);

  // Mood
  useEffect(() => {
    if (lumo.state !== behavior.mood) lumo.setState(behavior.mood);
  }, [lumo, behavior.mood]);

  // Celebration pulse (edge-triggered by counter)
  const pulses = useRef(behavior.pulses);
  useEffect(() => {
    if (behavior.pulses !== pulses.current) {
      pulses.current = behavior.pulses;
      lumo.pulse();
    }
  }, [lumo, behavior.pulses]);

  // Gaze: attention target overrides the mood's own gaze lock.
  const pointer = useRef<Point | null>(null);
  useEffect(() => {
    if (!followPointer) return;
    const el = gl.domElement;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 2 - 1;
      const y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      pointer.current = Math.abs(x) < 2.5 && Math.abs(y) < 2.5 ? { x: x * 1.3, y: y * 1.4 - 0.1 } : null;
    };
    const leave = () => (pointer.current = null);
    window.addEventListener('pointermove', move);
    document.addEventListener('pointerleave', leave);
    return () => {
      window.removeEventListener('pointermove', move);
      document.removeEventListener('pointerleave', leave);
    };
  }, [gl, followPointer]);

  useEffect(() => {
    lumo.speakLevel = speakLevel;
  }, [lumo, speakLevel]);

  useFrame((_, dt) => {
    const att = behavior.gaze;
    const moodLock = STATES[lumo.state]?.gazeLock ?? 0;
    if (att) {
      lumo.gaze(att.x, att.y);
      lumo.targets.gazeLock = 0;
    } else {
      lumo.targets.gazeLock = moodLock;
      const p = pointer.current;
      if (p && lumo.state !== 'search') lumo.gaze(p.x, p.y);
      else if (lumo.state !== 'search') lumo.gaze(null);
    }
    lumo.update(dt);
  });

  return (
    <primitive
      object={lumo}
      onClick={(e: { stopPropagation(): void }) => {
        e.stopPropagation();
        onPoke?.();
      }}
    />
  );
}

export const LumoMascot = forwardRef<LumoMascotHandle, LumoMascotProps>(function LumoMascot(
  { behavior, followPointer = true, onPoke, fps = 60, framing = 5.5, particles = 150, speakLevel = null, className, style, label = 'Lumo' },
  ref,
) {
  const reduce = usePrefersReducedMotion();
  const lumoRef = useRef<LumoCompanion | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(true);
  const [docVisible, setDocVisible] = useState(() => (typeof document === 'undefined' ? true : !document.hidden));

  useImperativeHandle(ref, () => ({ get lumo() { return lumoRef.current; } }), []);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((en) => setOnScreen(en[0]?.isIntersecting ?? true));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    const on = () => setDocVisible(!document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  const resting = behavior.mood === 'sleep' || behavior.mood === 'idle';
  const cap = reduce ? Math.min(fps, 30) : fps;
  const rate = behavior.mood === 'sleep' ? Math.min(cap, 20) : resting ? Math.min(cap, 45) : cap;

  return (
    <div ref={hostRef} className={className} style={{ position: 'relative', ...style }} role="img" aria-label={`${label}, ${behavior.mood}`}>
      <Canvas
        frameloop="demand"
        dpr={[1, 2]}
        linear
        flat
        gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
        camera={{ fov: 32, near: 0.1, far: 100, position: [0, 0.35, 10] }}
        style={{ position: 'absolute', inset: 0 }}
      >
        <Framing framing={framing} />
        <Driver fps={cap} idleFps={rate} active={onScreen && docVisible} />
        <Character
          lumoRef={lumoRef}
          behavior={behavior}
          followPointer={followPointer}
          onPoke={onPoke}
          calm={reduce}
          particles={particles}
          speakLevel={speakLevel}
        />
      </Canvas>
    </div>
  );
});
