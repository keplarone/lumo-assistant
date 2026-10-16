/**
 * Hero stage island. Server-rendered as a still image on the stage gradient, so the hero is complete
 * without JavaScript or WebGL. In the browser it upgrades to the live mascot when:
 * - WebGL is available, and
 * - the stage is on or near the screen (the canvas unmounts when it is far away), and
 * - the visitor has not asked for reduced motion (if they have, a button offers a calm live view).
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { hasWebGL, useMounted, useNearViewport, usePrefersReducedMotion } from './env';
import type { LiveHandle } from './HeroLive';

const HeroLive = lazy(() => import('./HeroLive'));

export interface StageProps {
  still: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
}

export default function HeroStage({ still, alt, width, height, className }: StageProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const live = useRef<LiveHandle>(null);
  const mounted = useMounted();
  const reduce = usePrefersReducedMotion();
  const near = useNearViewport(stageRef);
  const [optIn, setOptIn] = useState(false);
  const [ready, setReady] = useState(false);

  const webgl = mounted && hasWebGL();
  const wantLive = webgl && near && (!reduce || optIn);
  const showLive = wantLive && ready;
  useEffect(() => {
    if (!wantLive) setReady(false);
  }, [wantLive]);

  return (
    <div
      ref={stageRef}
      className={`stage ${className ?? ''}`}
      data-live={showLive ? 'true' : 'false'}
      data-webgl={mounted ? String(webgl) : undefined}
    >
      <img className="stage-still" src={still} alt={showLive ? '' : alt} width={width} height={height} fetchPriority="high" decoding="async" />
      {wantLive && (
        <Suspense fallback={null}>
          <HeroLive stageRef={stageRef} calm={reduce} onReady={() => setReady(true)} handle={live} />
        </Suspense>
      )}
      <div className="stage-controls">
        {showLive && (
          <button type="button" className="stage-chip" onClick={() => live.current?.poke()}>
            Wave at Lumo
          </button>
        )}
        {webgl && reduce && !optIn && (
          <button type="button" className="stage-chip" onClick={() => setOptIn(true)}>
            Show Lumo live (calm motion)
          </button>
        )}
      </div>
    </div>
  );
}
