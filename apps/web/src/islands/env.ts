/**
 * Shared progressive-enhancement helpers for the 3D islands. Nothing here imports three.js, so the
 * islands can decide whether to load the mascot at all before any 3D code is fetched.
 */
import { useEffect, useState, type RefObject } from 'react';

let webglCache: boolean | null = null;

/** True when a WebGL context can be created. The probe context is released immediately. */
export function hasWebGL(): boolean {
  if (webglCache !== null) return webglCache;
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    webglCache = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webglCache = false;
  }
  return webglCache;
}

/** Reads the preference synchronously in the browser so a live scene never starts and then stops. */
export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() =>
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)').matches : false,
  );
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    setReduce(mq.matches);
    const on = () => setReduce(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduce;
}

/** True once mounted in the browser (false during SSR and the hydration pass). */
export function useMounted(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

/**
 * True while the element is on or near the screen. Used to mount a live canvas only when it is
 * close to view, so a page with two mascot stages far apart holds at most one WebGL context.
 */
export function useNearViewport(ref: RefObject<Element | null>, margin = '35% 0px'): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), {
      rootMargin: margin,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, margin]);
  return near;
}
