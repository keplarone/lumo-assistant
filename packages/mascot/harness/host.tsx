/**
 * Mount/unmount harness for the R3F host (Playwright: test/visual/host.spec.ts).
 * window.__host.mount(mood) / unmount() / stats(); counts requestAnimationFrame callbacks so a test
 * can prove no loop survives unmount or keeps running while hidden.
 */
import { createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { LumoMascot, type LumoMascotHandle } from '../src/react';
import type { MascotOutput } from '../src/behavior/machine';
import type { WebGLRenderer } from 'three';

let rafCalls = 0;
const nativeRaf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (cb) => nativeRaf((t) => { rafCalls++; cb(t); });

const out = (mood: string): MascotOutput => ({ mood, gaze: null, attend: null, pulses: 0, locomotion: { x: 0, facing: 'viewer' } });

let root: Root | null = null;
let handle = createRef<LumoMascotHandle>();
let renderer: WebGLRenderer | null = null;

function render(mood: string, props: Record<string, unknown>) {
  root!.render(<LumoMascot ref={handle} behavior={out(mood)} followPointer={false} style={{ position: 'absolute', inset: 0 }} {...props} />);
}

const api = {
  mount(mood = 'think', props: Record<string, unknown> = {}, size?: [number, number]) {
    const el = document.getElementById('mount')!;
    el.style.width = size ? `${size[0]}px` : '';
    el.style.height = size ? `${size[1]}px` : '';
    handle = createRef<LumoMascotHandle>();
    root = createRoot(document.getElementById('mount')!);
    flushSync(() => render(mood, props));
  },
  setMood(mood: string, props: Record<string, unknown> = {}) { flushSync(() => render(mood, props)); },
  unmount() {
    renderer = handle.current?.renderer ?? renderer;
    root?.unmount();
    root = null;
  },
  /** Renderer stats; after unmount, read from the renderer captured just before unmounting. */
  stats() {
    const h = handle.current;
    if (h) { renderer = h.renderer ?? renderer; return { mounted: true, ...h.stats() }; }
    const info = renderer?.info;
    return { mounted: false, geometries: info?.memory.geometries ?? -1, textures: info?.memory.textures ?? -1, programs: info?.programs?.length ?? -1 };
  },
  rafCalls: () => rafCalls,
  canvases: () => document.querySelectorAll('canvas').length,
};
(window as unknown as { __host: typeof api }).__host = api;
document.body.dataset.ready = 'true';
