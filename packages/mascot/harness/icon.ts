/**
 * Renders Lumo for the app icon and the live (animated) icons: a close, square framing with his
 * wings and ears in view. Deterministic (fixed seed, fixed steps). scripts/render-icons.mjs drives it.
 */
import * as THREE from 'three';
import { Lumo } from '../src/core/character';

const params = new URLSearchParams(location.search);
const tile = document.getElementById('tile')!;
if (params.has('plain')) tile.dataset.plain = '';
const size = Number(params.get('size') ?? 512);
tile.style.width = tile.style.height = `${size}px`;
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Number(params.get('dpr') ?? 2));
renderer.setSize(size, size, false);
renderer.toneMapping = THREE.NeutralToneMapping;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
const lumo = new Lumo({ seed: 7, ground: false, particles: 60 });
scene.add(lumo);
const span = Number(params.get('span') ?? 4.0);
const dist = span / (2 * Math.tan(THREE.MathUtils.degToRad(15)));
camera.position.set(0, 0.55, dist);
camera.lookAt(0, 0.5, 0);

const call = lumo as unknown as Record<string, (...a: unknown[]) => unknown>;
const api = {
  setup(mood: string, warm = 120) {
    lumo.setState(mood);
    for (let i = 0; i < warm; i++) lumo.update(1 / 60);
    renderer.render(scene, camera);
  },
  act(method: string, ...args: unknown[]) {
    call[method]!.apply(lumo, args);
  },
  step(steps: number, dt = 1 / 120) {
    for (let i = 0; i < steps; i++) lumo.update(dt);
    renderer.render(scene, camera);
  },
};
(window as unknown as { __icon: typeof api }).__icon = api;
document.body.dataset.ready = 'true';
