/**
 * Deterministic single-frame renders for the visual tests: the character on three 0.186.1 with a
 * fixed seed and fixed update steps (no clock). window.__lumo.run() advances and renders once.
 */
import * as THREE from 'three';
import { Lumo } from '../src/core/character';

interface Action {
  at: number;
  method: string;
  args?: unknown[];
}
interface RunOptions {
  mood?: string;
  steps?: number;
  dt?: number;
  actions?: Action[];
}

function boot() {
  const stage = document.getElementById('stage')!;
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.NeutralToneMapping;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  const lumo = new Lumo({ calm: new URLSearchParams(location.search).has('calm'), seed: 7 });
  scene.add(lumo);

  const w = stage.clientWidth,
    h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dist = Math.max(5.6 / (2 * tanH), 4.0 / (2 * tanH * camera.aspect));
  camera.position.set(0, 0.5, dist);
  camera.lookAt(0, 0.35, 0);
  camera.updateProjectionMatrix();

  const call = lumo as unknown as Record<string, (...a: unknown[]) => unknown>;
  const api = {
    three: THREE.REVISION as string,
    lumo,
    renderer,
    run({ mood, steps = 90, dt = 1 / 60, actions = [] }: RunOptions = {}) {
      if (mood) lumo.setState(mood);
      for (let i = 0; i < steps; i++) {
        for (const a of actions) if (a.at === i) call[a.method]!.apply(lumo, a.args ?? []);
        lumo.update(dt);
      }
      renderer.render(scene, camera);
      return {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        points: renderer.info.render.points,
        state: lumo.state,
      };
    },
  };
  (window as unknown as { __lumo: typeof api }).__lumo = api;
  document.body.dataset.ready = 'true';
}

try {
  boot();
} catch (e) {
  document.body.dataset.error = String((e as Error)?.stack ?? e);
  throw e;
}
