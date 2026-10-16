/**
 * "Your companion" island. Server-rendered as a still of Lumo plus a list of its states (each with
 * its own still), so it reads fully without JavaScript. In the browser the list becomes a set of
 * toggle buttons; with WebGL (and without a reduced-motion preference, unless the visitor opts in)
 * the stage shows the live mascot driven by the real behavior machine.
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { hasWebGL, useMounted, useNearViewport, usePrefersReducedMotion } from './env';
import type { CompanionState } from './CompanionLive';

const CompanionLive = lazy(() => import('./CompanionLive'));

export interface CompanionItem {
  id: CompanionState;
  title: string;
  text: string;
  still: string;
  /** Small render of the same mood for the list. */
  thumb: string;
  alt: string;
}

export default function CompanionStage({ items, width, height }: { items: CompanionItem[]; width: number; height: number }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const mounted = useMounted();
  const reduce = usePrefersReducedMotion();
  const near = useNearViewport(stageRef);
  const [optIn, setOptIn] = useState(false);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<CompanionState>(items[0]!.id);
  const [replay, setReplay] = useState(0);

  const webgl = mounted && hasWebGL();
  const wantLive = webgl && near && (!reduce || optIn);
  const showLive = wantLive && ready;
  useEffect(() => {
    if (!wantLive) setReady(false);
  }, [wantLive]);

  const current = items.find((i) => i.id === state) ?? items[0]!;

  return (
    <div className="companion">
      <div ref={stageRef} className="stage companion-stage" data-live={showLive ? 'true' : 'false'}>
        <img className="stage-still" src={current.still} alt={showLive ? '' : current.alt} width={width} height={height} loading="lazy" decoding="async" />
        {wantLive && (
          <Suspense fallback={null}>
            <CompanionLive state={state} replay={replay} calm={reduce} onReady={() => setReady(true)} />
          </Suspense>
        )}
        <div className="stage-controls">
          {webgl && reduce && !optIn && (
            <button type="button" className="stage-chip" onClick={() => setOptIn(true)}>
              Show Lumo live (calm motion)
            </button>
          )}
        </div>
        <p className="stage-caption" aria-live="polite">
          {current.title}
        </p>
      </div>
      <ul className="companion-states" aria-label="Lumo’s states">
        {items.map((item) => {
          const body = (
            <>
              <img className="companion-thumb" src={item.thumb} alt="" width={64} height={64} loading="lazy" decoding="async" />
              <span className="companion-text">
                <span className="companion-title">{item.title}</span>
                <span className="companion-desc">{item.text}</span>
              </span>
            </>
          );
          return (
            <li key={item.id}>
              {mounted ? (
                <button
                  type="button"
                  className="companion-item"
                  aria-pressed={state === item.id}
                  onClick={() => {
                    setState(item.id);
                    setReplay((n) => n + 1);
                  }}
                >
                  {body}
                </button>
              ) : (
                <div className="companion-item">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
