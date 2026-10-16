/**
 * React Three Fiber host for Lumo. Owns the render loop policy:
 * - R3F runs with frameloop="never"; one requestAnimationFrame loop here advances the root at a
 *   capped rate: `fps` while something is happening, `idleFps` while resting in idle, `sleepFps`
 *   while asleep, and min(fps, 30) under prefers-reduced-motion;
 * - no frames at all (and no rAF loop) while the canvas is off-screen or the document is hidden,
 *   and window pointer listeners are attached only while visible;
 * - high-DPI via dpr [1, 2]; linear output and no tone mapping (`linear flat`), which together with
 *   rawColor()/ADDITIVE in core/lumo.ts reproduce the reference's r149 colors exactly;
 * - prefers-reduced-motion builds the rig with `calm` (damped amplitudes, no hops or turns);
 * - disposes every GPU resource on unmount.
 */
import { Canvas, useFrame, useThree, type RootState } from '@react-three/fiber';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
} from 'react';
import * as THREE from 'three';
import { LumoCompanion, type WingSide } from '../core/companion';
import { STATES } from '../core/lumo';
import { gazeTowardClientPoint } from '../core/gaze';
import type { Facing, MascotOutput, Point } from '../behavior/machine';

/** Something to look at: a DOM element, or a point in client (viewport) pixels. */
export type LookTarget = Element | Point;

export interface LumoFrameStats {
  /** Frames rendered since mount. */
  frames: number;
  /** Draw calls and triangles of the last frame. */
  calls: number;
  triangles: number;
  points: number;
  /** GPU resources currently held by the renderer. */
  geometries: number;
  textures: number;
  /** Current frame cap (0 = paused). */
  rate: number;
}

export interface LumoMascotHandle {
  /** The live character, for anything not covered below. */
  readonly lumo: LumoCompanion | null;
  readonly renderer: THREE.WebGLRenderer | null;
  /** Hop-glide to x in -1..1 across the canvas (same units as the machine's locomotion.x). */
  walkTo(x: number): void;
  turnAround(): void;
  pulse(): void;
  blink(): void;
  celebrate(): void;
  wave(side?: WingSide): void;
  /** Look at an element or client-space point (even outside the canvas); null releases the gaze. */
  lookAt(target: LookTarget | null, durationMs?: number): void;
  stats(): LumoFrameStats;
}

export interface LumoMascotProps {
  /** What to show, usually from MascotMachine output. */
  behavior: MascotOutput;
  /** Declarative gaze target (element or client point). Overrides behavior gaze while set. */
  lookAt?: LookTarget | null;
  /** Resolves behavior.attend names to elements. Default: [data-lumo-target="<name>"]. */
  resolveTarget?: (name: string) => Element | null;
  /** Follow the pointer with the eyes when nothing else holds the gaze. */
  followPointer?: boolean;
  /** Called when the character is clicked or tapped. */
  onPoke?: () => void;
  /** Max frames per second while active. */
  fps?: number;
  /** Cap while resting in the idle mood. */
  idleFps?: number;
  /** Cap while asleep. */
  sleepFps?: number;
  /** Force reduced motion on or off; default follows prefers-reduced-motion. */
  reducedMotion?: boolean;
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

const FACING_YAW: Record<Facing, number> = { viewer: 0, away: Math.PI, left: -0.5, right: 0.5 };
const defaultResolve = (name: string) =>
  typeof document === 'undefined' ? null : document.querySelector(`[data-lumo-target="${CSS.escape(name)}"]`);

function usePrefersReducedMotion(force?: boolean) {
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
  return force ?? reduce;
}

interface Shared {
  lumo: LumoCompanion | null;
  gl: THREE.WebGLRenderer | null;
  /** Scene units Lumo may walk either side of centre. */
  walkRange: number;
  frames: number;
  rate: number;
  /** Imperative walkTo (-1..1); holds until behavior.locomotion.x changes. */
  walkX: number | null;
  look: { target: LookTarget; until: number } | null;
}

function Framing({ framing, shared }: { framing: number; shared: MutableRefObject<Shared> }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const aspect = size.width / Math.max(1, size.height);
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    // Same fit rule as the reference: fit 5.5 units tall or 5.9 units wide, whichever is tighter.
    const dist = Math.max(framing / (2 * tanH), (framing + 0.4) / (2 * tanH * aspect));
    cam.aspect = aspect;
    cam.position.set(0, 0.35, dist);
    cam.lookAt(0, 0.2, 0);
    cam.updateProjectionMatrix();
    // Visible half-width at the character's depth, minus its own half-width (wings, halo).
    shared.current.walkRange = Math.max(0, dist * tanH * aspect - 1.35);
  }, [camera, size, framing, shared]);
  return null;
}

/** The only frame driver: a rAF loop that advances this root at the current cap, or nothing. */
function Driver({ active, rate, shared }: { active: boolean; rate: () => number; shared: MutableRefObject<Shared> }) {
  const advance = useThree((s) => s.advance);
  useEffect(() => {
    if (!active) {
      shared.current.rate = 0;
      return;
    }
    let raf = 0;
    let last = -Infinity;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const fps = rate();
      shared.current.rate = fps;
      // Small tolerance so a 60 Hz display does not skip every other frame at a 60 fps cap.
      if (now - last >= 1000 / fps - 2) {
        last = now;
        advance(now / 1000);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, advance, rate, shared]);
  return null;
}

const _head = new THREE.Vector3();

function Character({
  shared,
  behavior,
  lookAt,
  resolveTarget,
  followPointer,
  onPoke,
  calm,
  particles,
  speakLevel,
  active,
}: {
  shared: MutableRefObject<Shared>;
  behavior: MascotOutput;
  lookAt: LookTarget | null;
  resolveTarget: (name: string) => Element | null;
  followPointer: boolean;
  onPoke?: () => void;
  calm: boolean;
  particles: number;
  speakLevel: number | null;
  active: boolean;
}) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const lumo = useMemo(() => new LumoCompanion({ pixelRatio: gl.getPixelRatio(), calm, particles }), [gl, calm, particles]);
  useEffect(() => {
    const holder = shared.current;
    holder.lumo = lumo;
    holder.gl = gl;
    // releaseGpu (not dispose) so a StrictMode re-mount keeps a working, attached character.
    return () => {
      lumo.releaseGpu();
      if (holder.lumo === lumo) holder.lumo = null;
    };
  }, [lumo, gl, shared]);

  // Keep particle size right when the DPR changes (dpr is [1, 2]).
  const dpr = useThree((s) => s.viewport.dpr);
  useEffect(() => lumo.setPixelRatio(dpr), [lumo, dpr]);

  // Mood
  useEffect(() => {
    if (lumo.state !== behavior.mood) lumo.setState(behavior.mood);
  }, [lumo, behavior.mood]);

  // Celebration (edge-triggered by the pulse counter): pulse + hop + wing flourish.
  const pulses = useRef(behavior.pulses);
  useEffect(() => {
    if (behavior.pulses !== pulses.current) {
      pulses.current = behavior.pulses;
      lumo.celebrate();
    }
  }, [lumo, behavior.pulses]);

  // Locomotion
  const locoX = behavior.locomotion?.x ?? 0;
  const facing = behavior.locomotion?.facing ?? 'viewer';
  useEffect(() => {
    shared.current.walkX = null;
  }, [locoX, shared]);
  useEffect(() => {
    lumo.turnTo(FACING_YAW[facing]);
  }, [lumo, facing]);

  // Pointer gaze, only while visible.
  const pointer = useRef<Point | null>(null);
  useEffect(() => {
    if (!followPointer || !active) {
      pointer.current = null;
      return;
    }
    const el = gl.domElement;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 2 - 1;
      const y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      // Same mapping as the reference page; beyond ~1.3 canvas half-sizes Lumo stops tracking.
      pointer.current = Math.abs(x) < 1.3 && Math.abs(y) < 1.3 ? { x: x * 1.3, y: y * 1.4 - 0.1 } : null;
    };
    const leave = () => (pointer.current = null);
    window.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerleave', leave);
    return () => {
      window.removeEventListener('pointermove', move);
      document.removeEventListener('pointerleave', leave);
    };
  }, [gl, followPointer, active]);

  useEffect(() => {
    lumo.speakLevel = speakLevel;
  }, [lumo, speakLevel]);

  useFrame((_, dt) => {
    const s = shared.current;
    s.frames++;
    if (s.look && performance.now() > s.look.until) s.look = null;

    // Gaze priority: imperative lookAt > lookAt prop > behavior.attend > behavior.gaze > pointer.
    let target: LookTarget | null = s.look?.target ?? lookAt ?? null;
    if (!target && behavior.attend) target = resolveTarget(behavior.attend);
    let g: Point | null = null;
    if (target) {
      const rect = gl.domElement.getBoundingClientRect();
      // Head origin in client px, from where the character actually is (it may have walked).
      lumo.parts.head.getWorldPosition(_head);
      _head.y += 0.35;
      _head.project(camera);
      const origin = { x: rect.left + ((_head.x + 1) / 2) * rect.width, y: rect.top + ((1 - _head.y) / 2) * rect.height };
      const p = target instanceof Element ? centerOf(target) : target;
      if (p) g = gazeTowardClientPoint(p, rect, origin);
    } else if (behavior.gaze) g = behavior.gaze;

    const moodLock = STATES[lumo.state]?.gazeLock ?? 0;
    if (g) {
      lumo.gaze(g.x, g.y);
      lumo.targets.gazeLock = 0;
    } else {
      lumo.targets.gazeLock = moodLock;
      const p = pointer.current;
      if (lumo.state !== 'search') lumo.gaze(p ? p.x : null, p ? p.y : 0);
    }
    // Walk target in scene units; re-evaluated each frame so a resize keeps the right station.
    const wx = (s.walkX ?? locoX) * s.walkRange;
    if (Math.abs(wx - lumo.walkTarget) > 1e-3) lumo.walkTo(wx);

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

function centerOf(el: Element): Point | null {
  if (!el.isConnected) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export const LumoMascot = forwardRef<LumoMascotHandle, LumoMascotProps>(function LumoMascot(
  {
    behavior,
    lookAt = null,
    resolveTarget = defaultResolve,
    followPointer = true,
    onPoke,
    fps = 60,
    idleFps = 30,
    sleepFps = 12,
    reducedMotion,
    framing = 5.5,
    particles = 150,
    speakLevel = null,
    className,
    style,
    label = 'Lumo',
  },
  ref,
) {
  const reduce = usePrefersReducedMotion(reducedMotion);
  const shared = useRef<Shared>({ lumo: null, gl: null, walkRange: 0, frames: 0, rate: 0, walkX: null, look: null });
  const hostRef = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(true);
  const [docVisible, setDocVisible] = useState(() => (typeof document === 'undefined' ? true : !document.hidden));

  useImperativeHandle(
    ref,
    () => ({
      get lumo() { return shared.current.lumo; },
      get renderer() { return shared.current.gl; },
      walkTo: (x) => { shared.current.walkX = Math.max(-1, Math.min(1, x)); },
      turnAround: () => shared.current.lumo?.turnAround(),
      pulse: () => shared.current.lumo?.pulse(),
      blink: () => shared.current.lumo?.blink(),
      celebrate: () => shared.current.lumo?.celebrate(),
      wave: (side) => shared.current.lumo?.wave(side),
      lookAt: (target, durationMs = 2500) => {
        shared.current.look = target ? { target, until: performance.now() + durationMs } : null;
      },
      stats: () => {
        const gl = shared.current.gl;
        const info = gl?.info;
        return {
          frames: shared.current.frames,
          calls: info?.render.calls ?? 0,
          triangles: info?.render.triangles ?? 0,
          points: info?.render.points ?? 0,
          geometries: info?.memory.geometries ?? 0,
          textures: info?.memory.textures ?? 0,
          rate: shared.current.rate,
        };
      },
    }),
    [],
  );

  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((en) => setOnScreen(en[en.length - 1]?.isIntersecting ?? true));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    const on = () => setDocVisible(!document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  const active = onScreen && docVisible;
  const cap = reduce ? Math.min(fps, 30) : fps;
  const mood = behavior.mood;
  // Read live each frame: one-shots and walking briefly lift the resting caps.
  const rate = useMemo(
    () => () => {
      const busy = shared.current.lumo?.busy ?? false;
      if (mood === 'sleep' && !busy) return Math.min(cap, sleepFps);
      if (mood === 'idle' && !busy) return Math.min(cap, idleFps);
      return cap;
    },
    [mood, cap, idleFps, sleepFps],
  );

  return (
    <div ref={hostRef} className={className} style={{ position: 'relative', ...style }} role="img" aria-label={`${label}, ${mood}`}>
      <Canvas
        frameloop="never"
        dpr={[1, 2]}
        linear
        flat
        gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
        camera={{ fov: 32, near: 0.1, far: 100, position: [0, 0.35, 10] }}
        style={{ position: 'absolute', inset: 0 }}
        onCreated={(s: RootState) => { shared.current.gl = s.gl as THREE.WebGLRenderer; }}
      >
        <Framing framing={framing} shared={shared} />
        <Driver active={active} rate={rate} shared={shared} />
        <Character
          shared={shared}
          behavior={behavior}
          lookAt={lookAt}
          resolveTarget={resolveTarget}
          followPointer={followPointer}
          onPoke={onPoke}
          calm={reduce}
          particles={particles}
          speakLevel={speakLevel}
          active={active}
        />
      </Canvas>
    </div>
  );
});
