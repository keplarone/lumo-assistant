/**
 * Deterministic single-frame renders for the visual tests.
 *
 *   render.html?impl=ref        original reference code (sliced from the HTML) on three r149
 *   render.html?impl=port       src/core/lumo.ts on three 0.186.1
 *   render.html?impl=companion  src/core/companion.ts (product layers) on three 0.186.1
 *
 * Both renderers use the reference page's setup: antialias + alpha canvas over the stage gradient,
 * DPR 1, the camera framing from the reference's resize(), and the character's update(dt) driven by
 * fixed steps (no clock), with a seeded Math.random. window.__lumo.run() advances and renders once.
 */
import { installSeededRandom } from './seeded';

installSeededRandom();

type Impl = 'ref' | 'port' | 'companion';
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
  set?: Record<string, unknown>;
}

const impl = (new URLSearchParams(location.search).get('impl') ?? 'port') as Impl;

async function boot() {
  let THREE: any;

  let LumoCtor: new (opts: Record<string, unknown>) => any;
  if (impl === 'ref') {
    THREE = await import('three-r149');
    const { createLumoFactory } = await import('virtual:lumo-reference');
    LumoCtor = createLumoFactory(THREE).Lumo;
  } else {
    THREE = await import('three');
    LumoCtor =
      impl === 'companion'
        ? (await import('../src/core/companion')).LumoCompanion
        : (await import('../src/core/lumo')).Lumo;
  }

  const stage = document.getElementById('stage')!;
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  if (impl !== 'ref') {
    // r149 defaults, stated explicitly for r152+ (see rawColor in src/core/lumo.ts).
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
  }
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  const lumo = new LumoCtor({
    pixelRatio: renderer.getPixelRatio(),
    calm: new URLSearchParams(location.search).has('calm'),
  });
  scene.add(lumo);

  // Verbatim framing rule from the reference page's resize().
  const w = stage.clientWidth,
    h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dist = Math.max(5.5 / (2 * tanH), 5.9 / (2 * tanH * camera.aspect));
  camera.position.set(0, 0.35, dist);
  camera.lookAt(0, 0.2, 0);
  camera.updateProjectionMatrix();

  const api = {
    impl,
    three: THREE.REVISION as string,
    lumo,
    renderer,
    run({ mood, steps = 90, dt = 1 / 60, actions = [], set }: RunOptions = {}) {
      if (mood) lumo.setState(mood);
      if (set) lumo.set(set);
      for (let i = 0; i < steps; i++) {
        for (const a of actions) if (a.at === i) lumo[a.method](...(a.args ?? []));
        lumo.update(dt);
      }
      renderer.render(scene, camera);
      return {
        calls: renderer.info.render.calls as number,
        triangles: renderer.info.render.triangles as number,
        points: renderer.info.render.points as number,
        state: lumo.state as string,
      };
    },
  };
  (window as unknown as { __lumo: typeof api }).__lumo = api;
  document.body.dataset.ready = 'true';
}

boot().catch((e) => {
  document.body.dataset.error = String(e?.stack ?? e);
  throw e;
});
