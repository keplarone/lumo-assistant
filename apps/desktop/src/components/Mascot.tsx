import type { LumoMascotHandle } from '@lumo/mascot/react';
import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
  type Ref,
} from 'react';
import { useApp } from '../state/app';
import { chirp, mascotBus, useMascotOutput } from '../state/mascot';

const LumoMascot = lazy(() => import('@lumo/mascot/react').then((m) => ({ default: m.LumoMascot })));

/** Lumo's static mark (his face and ears): used when the mascot is off, while it loads, or without WebGL. */
export function LumoMark({ size = 20, label }: { size?: number; label?: string }) {
  return (
    <svg
      className="lm-mark"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <g className="lm-mark-ears">
        <ellipse
          cx="20"
          cy="17"
          rx="7.5"
          ry="15"
          transform="rotate(-14 20 17)"
          fill="#fff"
          stroke="#c9d6f5"
        />
        <ellipse cx="20" cy="18" rx="3.6" ry="10" transform="rotate(-14 20 18)" fill="#ffc6d9" />
        <ellipse cx="44" cy="17" rx="7.5" ry="15" transform="rotate(14 44 17)" fill="#fff" stroke="#c9d6f5" />
        <ellipse cx="44" cy="18" rx="3.6" ry="10" transform="rotate(14 44 18)" fill="#ffc6d9" />
      </g>
      <circle cx="32" cy="40" r="21" fill="#fff" stroke="#c9d6f5" />
      <ellipse cx="24.5" cy="38" rx="3.6" ry="4.6" fill="#18213d" />
      <ellipse cx="39.5" cy="38" rx="3.6" ry="4.6" fill="#18213d" />
      <circle cx="23.5" cy="36.4" r="1.3" fill="#fff" />
      <circle cx="38.5" cy="36.4" r="1.3" fill="#fff" />
      <ellipse cx="19" cy="45" rx="3.2" ry="2" fill="#ffb3c9" opacity="0.8" />
      <ellipse cx="45" cy="45" rx="3.2" ry="2" fill="#ffb3c9" opacity="0.8" />
      <path d="M29.5 44.5q2.5 2.4 5 0" fill="none" stroke="#3b2440" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

class WebGLBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export type MascotSize = 'hero' | 'small' | 'tiny' | 'nest' | 'buddy';

const FRAMING: Record<MascotSize, number> = { hero: 5.6, small: 5.0, tiny: 4.6, nest: 4.4, buddy: 4.4 };
const PARTICLES: Record<MascotSize, number> = { hero: 180, small: 40, tiny: 24, nest: 60, buddy: 140 };

/** Clicks this close together count toward making him dizzy. */
const DIZZY_CLICKS = 7;
const DIZZY_WINDOW_MS = 2500;

/** The Lumo character, driven by this window's mascot machine. Clicking him boops him. */
export function Mascot({
  size,
  className,
  handle,
  ground = true,
  onPoke,
  label,
}: {
  size: MascotSize;
  className?: string;
  handle?: Ref<LumoMascotHandle | null>;
  ground?: boolean;
  onPoke?: () => void;
  label?: string;
}) {
  const { settings } = useApp();
  const behavior = useMascotOutput();
  const inner = useRef<LumoMascotHandle>(null);
  useImperativeHandle(handle, () => inner.current as LumoMascotHandle, []);
  const clicks = useRef<number[]>([]);

  // One-shots requested anywhere in this window.
  useEffect(
    () =>
      mascotBus.onAct((a) => {
        const h = inner.current;
        if (!h) return;
        if (a.kind === 'celebrate') h.celebrate();
        else if (a.kind === 'boop') h.boop();
        else if (a.kind === 'wave') h.wave('right');
        else if (a.kind === 'spin') h.boop('spin');
      }),
    [],
  );

  const poke = () => {
    const now = performance.now();
    clicks.current = [...clicks.current.filter((t) => now - t < DIZZY_WINDOW_MS), now];
    if (clicks.current.length >= DIZZY_CLICKS) {
      // Hidden: boop him too many times and he gets dizzy.
      clicks.current = [];
      inner.current?.boop('spin');
      mascotBus.send({ type: 'agent', phase: 'uncertain' });
      setTimeout(
        () => mascotBus.phase === 'uncertain' && mascotBus.send({ type: 'agent', phase: 'idle' }),
        2600,
      );
      chirp('question');
    } else {
      chirp(Math.random() < 0.5 ? 'boop' : 'giggle');
    }
    mascotBus.send({ type: 'activity' });
    onPoke?.();
  };

  const markSize = size === 'hero' ? 72 : size === 'small' || size === 'nest' ? 28 : 18;
  const fallback = (
    <div className={`lm-mascot lm-mascot-${size} lm-mascot-static ${className ?? ''}`}>
      <LumoMark size={markSize} label={label ?? `Lumo, ${behavior.mood}`} />
    </div>
  );
  if (!settings.mascotEnabled) return fallback;
  return (
    <WebGLBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <LumoMascot
          ref={inner}
          className={`lm-mascot lm-mascot-${size} ${className ?? ''}`}
          behavior={behavior}
          reducedMotion={settings.reducedMotion ? true : undefined}
          framing={FRAMING[size]}
          particles={PARTICLES[size]}
          ground={ground}
          followPointer={size === 'hero' || size === 'buddy'}
          fps={size === 'hero' || size === 'buddy' || size === 'nest' ? 60 : 30}
          idleFps={size === 'hero' || size === 'buddy' ? 30 : 20}
          onPoke={poke}
          label={label}
        />
      </Suspense>
    </WebGLBoundary>
  );
}
