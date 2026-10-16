/** A standalone moving preview of Lumo on the marble backdrop (also bundled into a single file). */
import * as THREE from 'three';
import { Lumo } from '../src/core/character';
import { MarbleBackground } from '../src/core/marble';

const dark = matchMedia('(prefers-color-scheme: dark)');
const marble = new MarbleBackground(document.getElementById('bg')!, { scale: 0.6, dark: dark.matches });
dark.addEventListener('change', () => marble.setDark(dark.matches));

const stage = document.getElementById('stage')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.toneMapping = THREE.NeutralToneMapping;
stage.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
const lumo = new Lumo({ particles: 180 });
scene.add(lumo);

function resize() {
  const w = stage.clientWidth,
    h = stage.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  const tanH = Math.tan(THREE.MathUtils.degToRad(16));
  const dist = Math.max(6.4 / (2 * tanH), 4.2 / (2 * tanH * camera.aspect));
  camera.position.set(0, 0.5, dist);
  camera.lookAt(0, 0.35, 0);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

type Step = { label: string; run: () => void };
const STEPS: Step[] = [
  { label: 'Hello', run: () => lumo.setState('greet') },
  { label: 'Idle', run: () => lumo.setState('idle') },
  { label: 'Listening', run: () => lumo.setState('listen') },
  { label: 'Thinking', run: () => lumo.setState('think') },
  { label: 'Searching', run: () => lumo.setState('search') },
  { label: 'Typing', run: () => lumo.setState('type') },
  { label: 'Talking', run: () => lumo.setState('speak') },
  { label: 'Unsure', run: () => lumo.setState('unsure') },
  { label: 'Love', run: () => lumo.setState('love') },
  { label: 'Happy', run: () => lumo.setState('happy') },
  { label: 'Backflip', run: () => (lumo.setState('happy'), lumo.celebrate()) },
  { label: 'Fly over', run: () => (lumo.setState('idle'), lumo.walkTo(lumo.walkTarget > 0 ? -1.6 : 1.6)) },
  { label: 'Show jetpack', run: () => lumo.turnAround() },
  { label: 'Oops', run: () => lumo.setState('recover') },
  { label: 'Sleep', run: () => lumo.setState('sleep') },
];
const nav = document.getElementById('moods')!;
let auto = true;
let current = 0;
const buttons = STEPS.map((s, i) => {
  const b = document.createElement('button');
  b.textContent = s.label;
  b.onclick = () => {
    auto = false;
    play(i);
  };
  nav.appendChild(b);
  return b;
});
function play(i: number) {
  current = i;
  buttons.forEach((b, k) => b.classList.toggle('on', k === i));
  STEPS[i]!.run();
}
play(0);
setInterval(() => {
  if (!auto) return;
  if (lumo.yawTarget !== 0) lumo.turnTo(0);
  if (lumo.walkTarget !== 0 && STEPS[current]!.label !== 'Fly over') lumo.walkTo(0);
  play((current + 1) % STEPS.length);
}, 3600);

const ray = new THREE.Raycaster();
stage.addEventListener('pointermove', (e) => {
  const r = stage.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 2 - 1;
  const y = -(((e.clientY - r.top) / r.height) * 2 - 1);
  lumo.gaze(x * 1.3, y * 1.2);
});
stage.addEventListener('pointerleave', () => lumo.gaze(null));
stage.addEventListener('click', (e) => {
  const r = stage.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1)), camera);
  if (ray.intersectObject(lumo, true).length) lumo.boop();
});

const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
  timer.update();
  lumo.update(timer.getDelta());
  renderer.render(scene, camera);
});
(window as unknown as { __lumo: Lumo; __stopTour: () => void }).__lumo = lumo;
(window as unknown as { __stopTour: () => void }).__stopTour = () => (auto = false);
