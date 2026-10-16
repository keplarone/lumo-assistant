/**
 * Swift page changes with motion blur: the new page whooshes in from the side, blurred along its
 * direction of travel (an SVG horizontal blur that fades as it lands), with a small overshoot.
 * Reduced motion: a quick fade.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';

let blurId = 0;

export function PageTransition({
  routeKey,
  children,
  direction = 1,
  className = 'lm-view',
}: {
  routeKey: string;
  children: ReactNode;
  /** 1 = forward (comes in from the right), -1 = back. */
  direction?: number;
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const id = useRef(`lm-mblur-${++blurId}`);
  const blur = useRef<SVGFEGaussianBlurElement>(null);

  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const node = el.current;
    if (!node || typeof node.animate !== 'function') return;
    const reduced =
      document.documentElement.hasAttribute('data-reduced-motion') ||
      (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (reduced) {
      node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });
      return;
    }
    const anim = node.animate(
      [
        { transform: `translateX(${64 * direction}px) scaleX(1.03)`, opacity: 0 },
        { transform: `translateX(${-4 * direction}px) scaleX(0.995)`, opacity: 1, offset: 0.7 },
        { transform: 'translateX(0) scaleX(1)', opacity: 1 },
      ],
      { duration: 380, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
    // Motion blur that follows the speed of the slide.
    node.style.filter = `url(#${id.current})`;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / 300);
      blur.current?.setAttribute('stdDeviation', `${(14 * Math.pow(1 - k, 2)).toFixed(2)} 0`);
      if (k < 1) raf = requestAnimationFrame(tick);
      else node.style.filter = '';
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      anim.cancel();
      node.style.filter = '';
    };
    // Only a new key animates; direction is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  return (
    <div className={className} ref={el}>
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
        <filter id={id.current} x="-10%" y="0" width="120%" height="100%">
          <feGaussianBlur ref={blur} stdDeviation="0 0" />
        </filter>
      </svg>
      {children}
    </div>
  );
}
