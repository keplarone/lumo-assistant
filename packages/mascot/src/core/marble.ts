/**
 * A living white-marble backdrop: domain-warped noise makes soft grey and blue veins that drift very
 * slowly, with a pearly sheen that follows the pointer. One full-screen triangle, rendered at reduced
 * resolution and a low frame rate (it moves slowly), paused while the page is hidden. With reduced
 * motion it renders once and stays still.
 */
import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec2 uRes;
uniform vec2 uPointer;
uniform vec3 uBase;
uniform vec3 uVein;
uniform vec3 uVeinBlue;
uniform float uDark;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 6; i++) { v += a * noise(p); p = r * p * 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = vUv;
  vec2 p = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0) * 2.4;
  float t = uTime * 0.018;
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3 - t)));
  vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + t), fbm(p + 3.0 * q + vec2(8.3, 2.8) - t));
  float f = fbm(p + 2.6 * r);

  // Long, thin veins: where a warped stripe field crosses zero.
  float stripe = sin((p.x * 1.3 + p.y * 0.7) * 2.2 + f * 9.0);
  float vein = pow(1.0 - abs(stripe), 18.0);
  float fine = pow(1.0 - abs(sin((p.x * -0.6 + p.y * 1.4) * 4.0 + f * 14.0)), 40.0) * 0.6;
  float blue = smoothstep(0.45, 0.85, fbm(p * 0.7 + r * 1.5 + 11.0));

  vec3 col = uBase;
  col -= (f - 0.5) * 0.06;                  // cloudy depth
  col = mix(col, uVein, (vein * 0.55 + fine * 0.35) * (1.0 - blue));
  col = mix(col, uVeinBlue, (vein * 0.75 + fine * 0.4) * blue);
  col += 0.025 * blue;

  // Pearly sheen that follows the pointer.
  vec2 d = uv - uPointer;
  d.x *= uRes.x / uRes.y;
  float sheen = exp(-dot(d, d) * 2.2);
  col += mix(vec3(0.05, 0.06, 0.09), vec3(0.04, 0.06, 0.12), uDark) * sheen;

  // Soft vignette.
  float vig = smoothstep(1.2, 0.2, length((uv - 0.5) * vec2(1.1, 1.3)));
  col *= mix(0.94, 1.0, vig);

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export interface MarbleOptions {
  /** Render scale relative to CSS pixels (the image is soft, so 0.5 looks the same and costs a quarter). */
  scale?: number;
  fps?: number;
  /** Render once and stay still. */
  still?: boolean;
  dark?: boolean;
}

const LIGHT = { base: 0xf7f9fd, vein: 0xb9c2d3, blue: 0x3d7bff };
const DARK = { base: 0x10141f, vein: 0x2d3446, blue: 0x3d7bff };

export class MarbleBackground {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private mat: THREE.ShaderMaterial;
  private geo: THREE.BufferGeometry;
  private raf = 0;
  private last = -Infinity;
  private start = performance.now();
  private pointer = new THREE.Vector2(0.3, 0.75);
  private pointerTarget = new THREE.Vector2(0.3, 0.75);
  private opts: Required<MarbleOptions>;
  private ro: ResizeObserver | null = null;

  constructor(
    private host: HTMLElement,
    opts: MarbleOptions = {},
  ) {
    this.opts = { scale: 0.5, fps: 24, still: false, dark: false, ...opts };
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
    host.prepend(this.canvas);
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'low-power',
    });
    this.renderer.setPixelRatio(this.opts.scale);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      uniforms: {
        uTime: { value: 0 },
        uRes: { value: new THREE.Vector2(1, 1) },
        uPointer: { value: this.pointer },
        uBase: { value: new THREE.Color() },
        uVein: { value: new THREE.Color() },
        uVeinBlue: { value: new THREE.Color() },
        uDark: { value: 0 },
      },
    });
    this.setDark(this.opts.dark);
    const mesh = new THREE.Mesh(this.geo, this.mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(host);
    }
    window.addEventListener('pointermove', this.onPointer, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.play();
  }

  setDark(dark: boolean) {
    const c = dark ? DARK : LIGHT;
    const u = this.mat.uniforms;
    (u.uBase!.value as THREE.Color).setHex(c.base);
    (u.uVein!.value as THREE.Color).setHex(c.vein);
    (u.uVeinBlue!.value as THREE.Color).setHex(c.blue);
    u.uDark!.value = dark ? 1 : 0;
    this.renderOnce();
  }

  setStill(still: boolean) {
    this.opts.still = still;
    this.play();
  }

  private onPointer = (e: PointerEvent) => {
    const r = this.host.getBoundingClientRect();
    this.pointerTarget.set((e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height);
    if (this.opts.still) {
      this.pointer.copy(this.pointerTarget);
      this.renderOnce();
    }
  };

  private onVisibility = () => this.play();

  private resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    (this.mat.uniforms.uRes!.value as THREE.Vector2).set(w, h);
    this.renderOnce();
  }

  private renderOnce() {
    this.renderer.render(this.scene, this.camera);
  }

  private play() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.opts.still || document.hidden) {
      this.renderOnce();
      return;
    }
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      if (now - this.last < 1000 / this.opts.fps - 2) return;
      this.last = now;
      this.pointer.lerp(this.pointerTarget, 0.08);
      this.mat.uniforms.uTime!.value = (now - this.start) / 1000;
      this.renderOnce();
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    window.removeEventListener('pointermove', this.onPointer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.geo.dispose();
    this.mat.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
