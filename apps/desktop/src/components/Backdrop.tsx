/**
 * The app's living white-marble backdrop (three.js, @lumo/mascot MarbleBackground). Lazy-loaded,
 * drawn at half resolution and a low frame rate, still under reduced motion, and dark-veined in the
 * dark theme. Without WebGL the plain background color shows instead.
 */
import { useEffect, useRef } from 'react';
import { useApp } from '../state/app';

export function Backdrop() {
  const host = useRef<HTMLDivElement>(null);
  const { settings } = useApp();
  const marble = useRef<{ setDark(d: boolean): void; setStill(s: boolean): void; dispose(): void } | null>(
    null,
  );

  const dark = () => document.documentElement.getAttribute('data-theme') === 'dark';
  const still = () =>
    settings.reducedMotion ||
    (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    let live = true;
    void import('@lumo/mascot')
      .then(({ MarbleBackground }) => {
        if (!live || !host.current) return;
        try {
          marble.current = new MarbleBackground(host.current, { dark: dark(), still: still() });
        } catch {
          /* no WebGL: the CSS background stays */
        }
      })
      .catch(() => {});
    const mo = new MutationObserver(() => marble.current?.setDark(dark()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      live = false;
      mo.disconnect();
      marble.current?.dispose();
      marble.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    marble.current?.setStill(still());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.reducedMotion]);

  return <div className="lm-backdrop" ref={host} aria-hidden="true" />;
}
