import type { LumoMascotHandle } from '@lumo/mascot/react';
import { Component, lazy, Suspense, type ReactNode, type Ref } from 'react';
import { useApp } from '../state/app';
import { useMascotOutput } from '../state/mascot';

const LumoMascot = lazy(() => import('@lumo/mascot/react').then((m) => ({ default: m.LumoMascot })));

/** Lumo's static mark: used when the mascot is turned off, while it loads, or without WebGL. */
export function LumoMark({ size = 20, label }: { size?: number; label?: string }) {
  return (
    <span
      className="lm-mark"
      style={{ width: size, height: size }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <span />
    </span>
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

export type MascotSize = 'hero' | 'small' | 'tiny';

const FRAMING: Record<MascotSize, number> = { hero: 5.4, small: 5.2, tiny: 5.0 };
const PARTICLES: Record<MascotSize, number> = { hero: 150, small: 40, tiny: 24 };

/** The Lumo character, driven by this window's mascot machine. */
export function Mascot({
  size,
  className,
  handle,
}: {
  size: MascotSize;
  className?: string;
  handle?: Ref<LumoMascotHandle>;
}) {
  const { settings } = useApp();
  const behavior = useMascotOutput();
  const markSize = size === 'hero' ? 56 : size === 'small' ? 18 : 14;
  const fallback = (
    <div className={`lm-mascot lm-mascot-${size} lm-mascot-static ${className ?? ''}`}>
      <LumoMark size={markSize} label={`Lumo, ${behavior.mood}`} />
    </div>
  );
  if (!settings.mascotEnabled) return fallback;
  return (
    <WebGLBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <LumoMascot
          ref={handle}
          className={`lm-mascot lm-mascot-${size} ${className ?? ''}`}
          behavior={behavior}
          reducedMotion={settings.reducedMotion ? true : undefined}
          framing={FRAMING[size]}
          particles={PARTICLES[size]}
          followPointer={size === 'hero'}
          fps={size === 'hero' ? 60 : 30}
          idleFps={size === 'hero' ? 30 : 15}
        />
      </Suspense>
    </WebGLBoundary>
  );
}
