/**
 * Lumo: a small, round moon-bunny with floppy ears, a star on an antenna and two short blue wings.
 *
 * Everything is procedural three.js (no model files). The character is a THREE.Group that a host
 * adds to a scene and advances with update(dt). Motion is layered:
 *
 * - a mood (see moods.ts) sets pose targets that every part eases or springs toward;
 * - secondary motion: ears, antenna and feet are damped springs driven by the body's acceleration,
 *   so every hop, turn and wingbeat ripples through them;
 * - one-shots (blink, wave, boop, celebration backflip, shake-off, pulse) add to the pose and decay;
 * - wings: a fast hummingbird flutter while hovering, big strokes when he climbs or takes off, a
 *   held glide on fast flights, folded flat when he lands or sleeps. The body bobs with each beat.
 * - flight: walkTo() flies him sideways; setFlight() lets a host that moves the whole window
 *   (the desktop overlay) tell him how fast he is really going, so he banks, beats harder or glides,
 *   and leaves a sparkly wind trail from his wingtips.
 *
 * Deterministic for a given seed and sequence of update() steps, so screenshots are reproducible.
 * `calm` (reduced motion) damps every amplitude and skips flips and spins.
 */
import * as THREE from 'three';
import { BASE_POSE, moodOf, type Effect, type Mood, type Pose } from './moods';
import { makeTextures, type LumoTextures } from './textures';

export const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt));
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const PI = Math.PI;
const TAU = PI * 2;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t: number) => 1 + 2.4 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2);

/** Small seeded PRNG so a given seed always produces the same performance. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A damped spring (semi-implicit Euler, sub-stepped for stability). */
export class Spring {
  v = 0;
  constructor(public x = 0) {}
  step(target: number, k: number, c: number, dt: number) {
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (k * (target - this.x) - c * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  kick(v: number) {
    this.v += v;
  }
}

export const PALETTE = {
  body: 0xfdfcfa,
  sheen: 0xcfe0ff,
  earInner: 0xffc6d9,
  eye: 0x18213d,
  eyeShine: 0x6fb6ff,
  mouth: 0x3b2440,
  tongue: 0xff8fae,
  wing: 0xeef4ff,
  feather: 0x8db6ff,
  featherDeep: 0x2f6bff,
  star: 0xffd257,
  trail: 0xa9cbff,
  trailBright: 0x7cc4ff,
  dots: [0x5b9cff, 0x8ab8ff, 0xb9d3ff],
  sparkles: [0xffd257, 0x5b9cff, 0xff9cc0, 0x7fe0ff],
} as const;

export type ArmSide = 'left' | 'right';
export type BoopKind = 'giggle' | 'spin' | 'jump';

export interface LumoOptions {
  pixelRatio: number;
  /** Reduced motion: damped amplitudes, no flips or spins. */
  calm: boolean;
  /** Particle budget (exhaust and sparkles), for small surfaces. */
  particles: number;
  seed: number;
  /** Draw a soft ground shadow (off when floating over the desktop). */
  ground: boolean;
  /** Include the scene lights (turn off if the host lights the scene itself). */
  lights: boolean;
}

const DEFAULTS: LumoOptions = {
  pixelRatio: 1,
  calm: false,
  particles: 150,
  seed: 7,
  ground: true,
  lights: true,
};

// Body ellipsoid radii; face features sit on this surface.
const RX = 1,
  RY = 0.93,
  RZ = 0.96;

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _z = new THREE.Vector3(0, 0, 1);
const _col = new THREE.Color();

/** Place obj on the body surface at (x, y), facing out along the surface normal. */
function onSurface(obj: THREE.Object3D, x: number, y: number, lift = 0, front = true) {
  const k = 1 - (x * x) / (RX * RX) - (y * y) / (RY * RY);
  const z = RZ * Math.sqrt(Math.max(0, k)) * (front ? 1 : -1);
  _n.set(x / (RX * RX), y / (RY * RY), z / (RZ * RZ)).normalize();
  obj.position.set(x, y, z).addScaledVector(_n, lift);
  obj.quaternion.copy(_q.setFromUnitVectors(_z, _n));
}

interface EarParts {
  root: THREE.Group;
  seg1: THREE.Group;
  seg2: THREE.Group;
  roll: Spring;
  pitch: Spring;
  roll2: Spring;
  sign: number;
}

interface EyeParts {
  group: THREE.Group;
  lid: THREE.Group;
  smileArc: THREE.Mesh;
  closedArc: THREE.Mesh;
  home: THREE.Vector3;
}

interface Pool {
  points: THREE.Points;
  pos: Float32Array;
  vel: Float32Array;
  life: Float32Array;
  max: Float32Array;
  size: Float32Array;
  alpha: Float32Array;
  color: Float32Array;
  grow: Float32Array;
  n: number;
  next: number;
}

interface Floater {
  sprite: THREE.Sprite;
  t: number;
  life: number;
  vx: number;
  vy: number;
  phase: number;
  scale: number;
}

const POINTS_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vA;
varying vec3 vC;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uScale / max(0.001, -mv.z);
  vA = aAlpha;
  vC = aColor;
}`;
const POINTS_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying float vA;
varying vec3 vC;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a * vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vC, a);
  #include <colorspace_fragment>
}`;

export class Lumo extends THREE.Group {
  readonly opts: LumoOptions;
  /** Anchor at the middle of his face (for gaze math in the host). */
  readonly head: THREE.Object3D;
  /** 0..1 voice level to drive the mouth while speaking; null = natural rhythm. */
  speakLevel: number | null = null;

  private rng: () => number;
  private tex: LumoTextures;
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];

  // structure
  private rig = new THREE.Group();
  private squashG = new THREE.Group();
  private face = new THREE.Group();
  private eyes: EyeParts[] = [];
  private cheeks: THREE.Mesh[] = [];
  private smileMesh!: THREE.Mesh;
  private openMouth!: THREE.Group;
  private ears: EarParts[] = [];
  private antenna = new THREE.Group();
  private starG = new THREE.Group();
  private starGlow!: THREE.Sprite;
  private starMat!: THREE.MeshStandardMaterial;
  private arms: Record<ArmSide, THREE.Group> = { left: new THREE.Group(), right: new THREE.Group() };
  private feet: THREE.Mesh[] = [];
  /** Shoulder pivots (left, right); each holds a wing and a tip marker for the trail. */
  private wings: { pivot: THREE.Group; tip: THREE.Object3D; side: number }[] = [];
  private flapPhase = 0;
  private flapAmp = 0;
  private flapRate = 0;
  private glideK = 0;
  private foldK = 0;
  private shadow: THREE.Mesh | null = null;
  private ring!: THREE.Mesh;
  private bubble!: THREE.Mesh;
  private dots: THREE.Mesh[] = [];
  private dotsG = new THREE.Group();
  private scan!: THREE.Mesh;
  private panel!: THREE.Mesh;
  private question!: THREE.Sprite;
  private exhaust!: Pool;
  private sparkles!: Pool;
  private hearts: Floater[] = [];
  private zees: Floater[] = [];

  // state
  private _mood = 'idle';
  private moodDef: Mood = moodOf('idle');
  private pose: Pose = { ...BASE_POSE };
  private fx: Record<Effect, number> = {
    dots: 0,
    scan: 0,
    panel: 0,
    zzz: 0,
    question: 0,
    sparkles: 0,
    hearts: 0,
  };
  private hands: Record<NonNullable<Mood['hands']>, number> = { chin: 0, type: 0, wave: 0, hug: 0, shrug: 0 };
  private t = 0;
  private stateT = 0;
  private gx = 0;
  private gy = 0;
  private gazeTarget: { x: number; y: number } | null = null;
  private glance: { x: number; y: number; until: number } | null = null;
  private nextGlance = 3;
  private blinkT = -1;
  private nextBlink = 2.2;
  private doubleBlink = false;

  private xSpring = new Spring(0);
  private _walkTarget = 0;
  private yawSpring = new Spring(0);
  private _yawTarget = 0;
  private hoverSpring = new Spring(BASE_POSE.hover);
  private squashSpring = new Spring(0);
  private antennaSpring = new Spring(0);
  private footSpring = new Spring(0);
  private lastRigY = 0;
  private rigVy = 0;
  private flight = { vx: 0, vy: 0 };
  private flightSmooth = { vx: 0, vy: 0 };

  private flipT = -1;
  private spinT = -1;
  private waveT = -1;
  private waveSide: ArmSide = 'right';
  private boopT = -1;
  private boopKind: BoopKind = 'giggle';
  private shakeT = -1;
  private pulseT = -1;
  private tapT = 0;
  private tapSide = 0;
  private emitAcc = 0;
  private sparkAcc = 0;
  private heartAcc = 0;
  private zeeAcc = 0;
  private bubbleT = 0;
  private _gazeLock = 0;

  constructor(opts: Partial<LumoOptions> = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
    this.rng = mulberry32(this.opts.seed);
    this.tex = makeTextures();
    this.name = 'Lumo';
    this.head = new THREE.Object3D();
    this.build();
  }

  // ---------------------------------------------------------------------------------------------
  // Construction

  private g<T extends THREE.BufferGeometry>(geo: T): T {
    this.geos.push(geo);
    return geo;
  }
  private m<T extends THREE.Material>(mat: T): T {
    this.mats.push(mat);
    return mat;
  }

  private build() {
    const P = PALETTE;
    if (this.opts.lights) {
      const hemi = new THREE.HemisphereLight(0xffffff, 0xd9e6ff, 1.5);
      const key = new THREE.DirectionalLight(0xffffff, 2.3);
      key.position.set(-2.5, 4, 5);
      const rim = new THREE.DirectionalLight(0x8fb8ff, 2.6);
      rim.position.set(3.5, 2.5, -4);
      const fill = new THREE.DirectionalLight(0xfff3ea, 0.7);
      fill.position.set(3, -1.5, 3);
      this.add(hemi, key, rim, fill);
    }

    if (this.opts.ground) {
      this.shadow = new THREE.Mesh(
        this.g(new THREE.PlaneGeometry(2.4, 2.4)),
        this.m(new THREE.MeshBasicMaterial({ map: this.tex.shadow, transparent: true, depthWrite: false })),
      );
      this.shadow.rotation.x = -PI / 2;
      this.shadow.position.y = -1.02;
      this.shadow.renderOrder = -1;
      this.add(this.shadow);
    }

    this.add(this.rig);
    this.rig.add(this.squashG);

    // Body: one soft, squishy mochi (head and body in one).
    const bodyMat = this.m(
      new THREE.MeshPhysicalMaterial({
        color: P.body,
        roughness: 0.6,
        sheen: 1,
        sheenRoughness: 0.42,
        sheenColor: new THREE.Color(P.sheen),
        clearcoat: 0.12,
        clearcoatRoughness: 0.55,
      }),
    );
    const body = new THREE.Mesh(this.g(new THREE.SphereGeometry(1, 64, 48)), bodyMat);
    body.scale.set(RX, RY, RZ);
    this.squashG.add(body);
    this.head.position.set(0, 0.15, 0.9);
    this.squashG.add(this.head);
    this.squashG.add(this.face);

    this.buildFace();
    this.buildEars(bodyMat);
    this.buildAntenna();
    this.buildLimbs(bodyMat);
    this.buildWings();
    this.buildFx();
  }

  private buildFace() {
    const P = PALETTE;
    const eyeMat = this.m(
      new THREE.MeshPhysicalMaterial({
        color: P.eye,
        roughness: 0.2,
        clearcoat: 1,
        clearcoatRoughness: 0.06,
      }),
    );
    const white = this.m(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
    const shine = this.m(
      new THREE.MeshBasicMaterial({ color: P.eyeShine, transparent: true, opacity: 0.65, toneMapped: false }),
    );
    const arcMat = this.m(new THREE.MeshBasicMaterial({ color: P.eye, side: THREE.DoubleSide }));
    const eyeGeo = this.g(new THREE.SphereGeometry(1, 32, 24));
    const glintBig = this.g(new THREE.CircleGeometry(0.046, 20));
    const glintSmall = this.g(new THREE.CircleGeometry(0.022, 16));
    const shineGeo = this.g(new THREE.CircleGeometry(0.08, 24));
    const arcGeo = this.g(new THREE.TorusGeometry(0.105, 0.026, 8, 28, PI));

    for (const side of [-1, 1]) {
      const group = new THREE.Group();
      onSurface(group, side * 0.34, 0.1, -0.02);
      const lid = new THREE.Group();
      group.add(lid);
      const ball = new THREE.Mesh(eyeGeo, eyeMat);
      ball.scale.set(0.168, 0.222, 0.078);
      lid.add(ball);
      const s = new THREE.Mesh(shineGeo, shine);
      s.position.set(0, -0.095, 0.074);
      s.scale.set(1, 0.5, 1);
      lid.add(s);
      const g1 = new THREE.Mesh(glintBig, white);
      g1.position.set(-0.045, 0.07, 0.08);
      const g2 = new THREE.Mesh(glintSmall, white);
      g2.position.set(0.05, -0.04, 0.08);
      lid.add(g1, g2);
      const smileArc = new THREE.Mesh(arcGeo, arcMat);
      smileArc.position.z = 0.04;
      smileArc.position.y = -0.04;
      const closedArc = new THREE.Mesh(arcGeo, arcMat);
      closedArc.rotation.z = PI;
      closedArc.position.set(0, 0.03, 0.04);
      group.add(smileArc, closedArc);
      this.face.add(group);
      this.eyes.push({ group, lid, smileArc, closedArc, home: group.position.clone() });
    }

    const blushMat = this.m(
      new THREE.MeshBasicMaterial({
        map: this.tex.blush,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    const blushGeo = this.g(new THREE.PlaneGeometry(0.34, 0.22));
    for (const side of [-1, 1]) {
      const c = new THREE.Mesh(blushGeo, blushMat.clone());
      this.mats.push(c.material as THREE.Material);
      onSurface(c, side * 0.6, -0.12, 0.012);
      this.face.add(c);
      this.cheeks.push(c);
    }

    const mouth = new THREE.Group();
    onSurface(mouth, 0, -0.17, 0.004);
    this.face.add(mouth);
    const mouthMat = this.m(new THREE.MeshBasicMaterial({ color: P.mouth, side: THREE.DoubleSide }));
    this.smileMesh = new THREE.Mesh(this.g(new THREE.TorusGeometry(0.075, 0.02, 8, 22, PI)), mouthMat);
    this.smileMesh.rotation.z = PI;
    this.smileMesh.position.y = 0.035;
    mouth.add(this.smileMesh);
    this.openMouth = new THREE.Group();
    const open = new THREE.Mesh(this.g(new THREE.CircleGeometry(0.08, 28)), mouthMat);
    const tongue = new THREE.Mesh(
      this.g(new THREE.CircleGeometry(0.048, 20)),
      this.m(new THREE.MeshBasicMaterial({ color: PALETTE.tongue })),
    );
    tongue.position.set(0, -0.035, 0.002);
    tongue.scale.y = 0.7;
    this.openMouth.add(open, tongue);
    this.openMouth.position.y = -0.005;
    mouth.add(this.openMouth);
  }

  private buildEars(bodyMat: THREE.Material) {
    const inner = this.m(new THREE.MeshStandardMaterial({ color: PALETTE.earInner, roughness: 0.75 }));
    // Leaf-shaped ears: two overlapping ellipsoids per ear so the joint bends without a gap.
    const sphere = this.g(new THREE.SphereGeometry(1, 28, 20));
    for (const sign of [-1, 1]) {
      const root = new THREE.Group();
      root.position.set(sign * 0.34, 0.76, -0.04);
      const seg1 = new THREE.Group();
      const m1 = new THREE.Mesh(sphere, bodyMat);
      m1.scale.set(0.2, 0.4, 0.11);
      m1.position.y = 0.34;
      const n1 = new THREE.Mesh(sphere, inner);
      n1.scale.set(0.11, 0.3, 0.05);
      n1.position.set(0, 0.38, 0.07);
      seg1.add(m1, n1);
      const seg2 = new THREE.Group();
      seg2.position.y = 0.6;
      const m2 = new THREE.Mesh(sphere, bodyMat);
      m2.scale.set(0.19, 0.34, 0.1);
      m2.position.y = 0.22;
      const n2 = new THREE.Mesh(sphere, inner);
      n2.scale.set(0.1, 0.25, 0.045);
      n2.position.set(0, 0.22, 0.065);
      seg2.add(m2, n2);
      seg1.add(seg2);
      root.add(seg1);
      this.squashG.add(root);
      this.ears.push({
        root,
        seg1,
        seg2,
        roll: new Spring(0),
        pitch: new Spring(0),
        roll2: new Spring(0),
        sign,
      });
    }
  }

  private buildAntenna() {
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0.02, 0.3, 0),
      new THREE.Vector3(0.13, 0.48, 0),
    );
    const stalk = new THREE.Mesh(
      this.g(new THREE.TubeGeometry(curve, 16, 0.024, 8, false)),
      this.m(new THREE.MeshStandardMaterial({ color: PALETTE.feather, roughness: 0.4 })),
    );
    this.antenna.position.set(0, 0.86, 0.02);
    this.antenna.add(stalk);
    const shape = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const a = PI / 2 + (i * PI) / 5;
      const r = i % 2 === 0 ? 0.14 : 0.065;
      if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    const starGeo = this.g(
      new THREE.ExtrudeGeometry(shape, {
        depth: 0.04,
        bevelEnabled: true,
        bevelThickness: 0.025,
        bevelSize: 0.022,
        bevelSegments: 3,
      }),
    );
    starGeo.center();
    this.starMat = this.m(
      new THREE.MeshStandardMaterial({
        color: PALETTE.star,
        emissive: PALETTE.star,
        emissiveIntensity: 0.5,
        roughness: 0.35,
      }),
    );
    this.starG.add(new THREE.Mesh(starGeo, this.starMat));
    this.starGlow = new THREE.Sprite(
      this.m(
        new THREE.SpriteMaterial({
          map: this.tex.glow,
          color: 0xffd86b,
          transparent: true,
          depthWrite: false,
          opacity: 0.5,
          toneMapped: false,
        }),
      ),
    );
    this.starGlow.scale.setScalar(0.7);
    this.starG.add(this.starGlow);
    this.starG.position.set(0.13, 0.5, 0);
    this.antenna.add(this.starG);
    this.squashG.add(this.antenna);
  }

  private buildLimbs(bodyMat: THREE.Material) {
    const armGeo = this.g(new THREE.CapsuleGeometry(0.125, 0.2, 6, 14));
    armGeo.translate(0, -0.2, 0);
    for (const side of ['left', 'right'] as const) {
      const sx = side === 'right' ? 1 : -1;
      const pivot = this.arms[side];
      pivot.position.set(sx * 0.84, -0.18, 0.14);
      pivot.add(new THREE.Mesh(armGeo, bodyMat));
      this.squashG.add(pivot);
    }
    const footGeo = this.g(new THREE.SphereGeometry(0.2, 20, 14));
    for (const sx of [-1, 1]) {
      const f = new THREE.Mesh(footGeo, bodyMat);
      f.scale.set(1, 0.58, 1.3);
      f.position.set(sx * 0.34, -0.88, 0.16);
      this.squashG.add(f);
      this.feet.push(f);
    }
  }

  private buildWings() {
    const P = PALETTE;
    // A short, round wing: rounded leading edge up top, three soft feather scallops along the back.
    const outline = (k: number) => {
      const sh = new THREE.Shape();
      sh.moveTo(0, -0.1 * k);
      sh.bezierCurveTo(0.05 * k, 0.28 * k, 0.4 * k, 0.46 * k, 0.78 * k, 0.36 * k);
      sh.bezierCurveTo(0.9 * k, 0.32 * k, 0.88 * k, 0.16 * k, 0.76 * k, 0.12 * k);
      sh.bezierCurveTo(0.8 * k, 0.0, 0.66 * k, -0.1 * k, 0.56 * k, -0.06 * k);
      sh.bezierCurveTo(0.56 * k, -0.18 * k, 0.4 * k, -0.24 * k, 0.32 * k, -0.16 * k);
      sh.bezierCurveTo(0.26 * k, -0.28 * k, 0.08 * k, -0.28 * k, 0, -0.1 * k);
      return sh;
    };
    const extrude = (k: number, depth: number) => {
      const geo = new THREE.ExtrudeGeometry(outline(k), {
        depth,
        bevelEnabled: true,
        bevelThickness: depth * 0.6,
        bevelSize: 0.035,
        bevelSegments: 4,
        curveSegments: 18,
      });
      geo.translate(0, 0, -depth / 2);
      return this.g(geo);
    };
    const wingGeo = extrude(1, 0.04);
    const featherGeo = extrude(0.66, 0.03);
    const wingMat = this.m(
      new THREE.MeshPhysicalMaterial({
        color: P.wing,
        roughness: 0.45,
        sheen: 1,
        sheenColor: new THREE.Color(P.sheen),
        clearcoat: 0.3,
      }),
    );
    const featherMat = this.m(
      new THREE.MeshPhysicalMaterial({
        color: P.feather,
        roughness: 0.35,
        clearcoat: 0.6,
        clearcoatRoughness: 0.2,
      }),
    );
    const tipMat = this.m(new THREE.MeshStandardMaterial({ color: P.featherDeep, roughness: 0.4 }));
    const dotGeo = this.g(new THREE.SphereGeometry(0.045, 12, 10));
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.42, 0.2, -0.8);
      const wing = new THREE.Group();
      wing.scale.set(side * 1.45, 1.45, 1.45);
      const main = new THREE.Mesh(wingGeo, wingMat);
      const feather = new THREE.Mesh(featherGeo, featherMat);
      feather.position.set(0.04, 0.02, 0.045);
      // Three little blue feather dots along the scallops.
      [
        [0.66, 0.0],
        [0.45, -0.12],
        [0.24, -0.17],
      ].forEach(([x, y]) => {
        const d = new THREE.Mesh(dotGeo, tipMat);
        d.position.set(x!, y!, 0.05);
        d.scale.set(1, 1, 0.5);
        wing.add(d);
      });
      wing.add(main, feather);
      pivot.add(wing);
      const tip = new THREE.Object3D();
      tip.position.set(side * 1.16, 0.4, 0);
      pivot.add(tip);
      this.squashG.add(pivot);
      this.wings.push({ pivot, tip, side });
    }
  }

  private buildFx() {
    const P = PALETTE;
    // Pulse ring
    this.ring = new THREE.Mesh(
      this.g(new THREE.RingGeometry(0.92, 1.0, 64)),
      this.m(
        new THREE.MeshBasicMaterial({
          color: 0x5b9cff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      ),
    );
    this.ring.visible = false;
    this.rig.add(this.ring);

    // Nose bubble (sleep)
    this.bubble = new THREE.Mesh(
      this.g(new THREE.SphereGeometry(0.1, 20, 14)),
      this.m(
        new THREE.MeshPhysicalMaterial({
          color: 0xcfe6ff,
          roughness: 0.05,
          transparent: true,
          opacity: 0.45,
          clearcoat: 1,
          depthWrite: false,
        }),
      ),
    );
    onSurface(this.bubble, 0.1, -0.08, 0.06);
    this.bubble.visible = false;
    this.squashG.add(this.bubble);

    // Thinking dots
    const dotGeo = this.g(new THREE.SphereGeometry(0.075, 16, 12));
    P.dots.forEach((c) => {
      const d = new THREE.Mesh(
        dotGeo,
        this.m(
          new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.35, roughness: 0.3 }),
        ),
      );
      this.dotsG.add(d);
      this.dots.push(d);
    });
    this.dotsG.position.set(0, 1.62, 0);
    this.rig.add(this.dotsG);

    // Scan beam from the star
    const beamGeo = this.g(new THREE.ConeGeometry(0.55, 2.2, 32, 1, true));
    beamGeo.translate(0, -1.1, 0);
    this.scan = new THREE.Mesh(
      beamGeo,
      this.m(
        new THREE.MeshBasicMaterial({
          color: 0x7cc4ff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      ),
    );
    this.scan.rotation.x = -1.1;
    this.scan.visible = false;
    this.starG.add(this.scan);

    // Holographic keyboard
    this.panel = new THREE.Mesh(
      this.g(new THREE.PlaneGeometry(1.5, 1.5)),
      this.m(
        new THREE.MeshBasicMaterial({
          map: this.tex.keyboard,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        }),
      ),
    );
    this.panel.position.set(0, -0.62, 1.15);
    this.panel.rotation.x = -1.15;
    this.panel.visible = false;
    this.rig.add(this.panel);

    // Question mark
    this.question = new THREE.Sprite(
      this.m(
        new THREE.SpriteMaterial({
          map: this.tex.question,
          transparent: true,
          depthWrite: false,
          opacity: 0,
        }),
      ),
    );
    this.question.position.set(0.95, 1.25, 0.2);
    this.question.visible = false;
    this.rig.add(this.question);

    const budget = clamp(Math.round(this.opts.particles), 16, 260);
    this.exhaust = this.makePool(Math.round(budget * 0.75), this.tex.soft);
    this.sparkles = this.makePool(Math.max(12, Math.round(budget * 0.35)), this.tex.sparkle);
    this.exhaust.points.renderOrder = 1;
    this.add(this.exhaust.points, this.sparkles.points);

    const fl = (map: THREE.Texture, n: number, list: Floater[]) => {
      for (let i = 0; i < n; i++) {
        const s = new THREE.Sprite(
          this.m(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, opacity: 0 })),
        );
        s.visible = false;
        this.add(s);
        list.push({ sprite: s, t: 0, life: 0, vx: 0, vy: 0, phase: 0, scale: 0.3 });
      }
    };
    fl(this.tex.heart, 6, this.hearts);
    fl(this.tex.zee, 4, this.zees);
  }

  private makePool(n: number, map: THREE.Texture): Pool {
    const geo = this.g(new THREE.BufferGeometry());
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const alpha = new Float32Array(n);
    const color = new Float32Array(n * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 50);
    const mat = this.m(
      new THREE.ShaderMaterial({
        vertexShader: POINTS_VERT,
        fragmentShader: POINTS_FRAG,
        transparent: true,
        depthWrite: false,
        uniforms: { uMap: { value: map }, uScale: { value: 400 } },
      }),
    );
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    const size2 = new THREE.Vector2();
    points.onBeforeRender = (renderer, _scene, camera) => {
      const h = renderer.getDrawingBufferSize(size2).y;
      const fov = (camera as THREE.PerspectiveCamera).fov ?? 32;
      mat.uniforms.uScale!.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2)));
    };
    return {
      points,
      pos,
      vel: new Float32Array(n * 3),
      life: new Float32Array(n),
      max: new Float32Array(n),
      size,
      alpha,
      color,
      grow: new Float32Array(n),
      n,
      next: 0,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Public API

  get state() {
    return this._mood;
  }
  /** Gaze lock of the current mood (1 = the mood decides where he looks). */
  get moodGazeLock() {
    return this.moodDef.pose.gazeLock;
  }
  /** Override: 0 lets the host's gaze win even in moods that hold their own gaze. */
  set gazeLock(v: number) {
    this._gazeLock = v;
  }
  get gazeLock() {
    return this._gazeLock;
  }

  setState(name: string) {
    if (name === this._mood) return this;
    const prev = this._mood;
    this._mood = name;
    this.moodDef = moodOf(name);
    this.stateT = 0;
    this._gazeLock = this.moodDef.pose.gazeLock;
    if (name === 'greet') this.wave('right');
    if (name === 'recover') this.shakeT = -1;
    if (name === 'happy' && prev !== 'happy') this.burst(14);
    if (prev === 'sleep') {
      // Waking up: a little jolt, ears pop up.
      this.squashSpring.kick(-1.2);
      for (const e of this.ears) e.pitch.kick(-5);
    }
    return this;
  }

  /** Look toward x, y in -1..1 (null = free to look around). */
  gaze(x: number | null, y = 0) {
    this.gazeTarget = x == null ? null : { x: clamp(x, -1.2, 1.2), y: clamp(y, -1.2, 1.2) };
    return this;
  }

  blink() {
    this.blinkT = 0;
    return this;
  }

  /** A ring of light from his body. */
  pulse() {
    this.pulseT = 0;
    return this;
  }

  /** Celebrate: a backflip on full thrust with a burst of sparkles (a hop in calm mode). */
  celebrate() {
    this.pulse();
    this.burst(26);
    if (this.opts.calm) this.squashSpring.kick(-1.5);
    else this.flipT = 0;
    return this;
  }

  /** Wave with one arm (screen side). */
  wave(side: ArmSide = 'right') {
    this.waveT = 0;
    this.waveSide = side;
    return this;
  }

  /** Respond to a click or tap. */
  boop(kind?: BoopKind) {
    const kinds: BoopKind[] = this.opts.calm ? ['giggle'] : ['giggle', 'giggle', 'spin', 'jump'];
    this.boopKind = kind ?? kinds[Math.floor(this.rng() * kinds.length)]!;
    this.boopT = 0;
    this.squashSpring.kick(this.boopKind === 'jump' ? -2.2 : 2.6);
    if (this.boopKind === 'spin') this.spinT = 0;
    if (this.boopKind === 'jump') this.hoverSpring.kick(3.2);
    this.spawnHeart(0.3);
    if (this.boopKind === 'giggle') this.spawnHeart(-0.3);
    for (const e of this.ears) e.pitch.kick(4);
    return this;
  }

  /** Fly sideways to x (scene units). */
  walkTo(x: number) {
    this._walkTarget = x;
    return this;
  }
  get walkTarget() {
    return this._walkTarget;
  }
  get x() {
    return this.xSpring.x;
  }

  /** Turn to a yaw angle (0 = facing the viewer, PI = showing his wings). Skipped in calm mode. */
  turnTo(yaw: number) {
    if (this.opts.calm) return this;
    this._yawTarget = yaw;
    return this;
  }
  turnAround() {
    return this.turnTo(Math.abs(this._yawTarget) < 0.5 ? PI : 0);
  }
  get yawTarget() {
    return this._yawTarget;
  }

  /**
   * How fast the host is really moving him (scene units per second), e.g. when the desktop overlay
   * window flies across the screen. He banks into it, burns harder and leaves a trail.
   */
  setFlight(vx: number, vy: number) {
    this.flight.vx = vx;
    this.flight.vy = vy;
    return this;
  }

  setPixelRatio(_pr: number) {
    // Point sizes follow the drawing buffer each frame; nothing to do.
    return this;
  }

  /** True while something is in motion that wants full frame rate. */
  get busy() {
    return (
      Math.abs(this.xSpring.v) > 0.02 ||
      Math.abs(this._walkTarget - this.xSpring.x) > 0.02 ||
      Math.abs(this.yawSpring.v) > 0.02 ||
      Math.abs(this._yawTarget - this.yawSpring.x) > 0.02 ||
      this.flipT >= 0 ||
      this.spinT >= 0 ||
      this.waveT >= 0 ||
      this.boopT >= 0 ||
      this.pulseT >= 0 ||
      Math.hypot(this.flight.vx, this.flight.vy) > 0.05
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Frame update

  update(rawDt: number) {
    const dt = clamp(rawDt, 0, 1 / 15);
    this.t += dt;
    this.stateT += dt;
    const t = this.t;
    const calm = this.opts.calm;
    const amp = calm ? 0.45 : 1;
    const mood = this.moodDef;

    // Ease pose and effects toward the mood.
    const target = mood.pose;
    for (const k of Object.keys(this.pose) as (keyof Pose)[]) {
      this.pose[k] = damp(this.pose[k], target[k], k === 'eyeSmile' || k === 'eyeOpen' ? 9 : 5, dt);
    }
    for (const k of Object.keys(this.fx) as Effect[]) {
      this.fx[k] = damp(this.fx[k], mood.effects.includes(k) ? 1 : 0, 4, dt);
    }
    for (const k of Object.keys(this.hands) as (keyof typeof this.hands)[]) {
      this.hands[k] = damp(this.hands[k], mood.hands === k ? 1 : 0, 6, dt);
    }
    const p = this.pose;

    // One-shot timers
    const flip = this.advance('flipT', dt, 1.05);
    const spin = this.advance('spinT', dt, 0.8);
    const wave = this.advance('waveT', dt, 1.9);
    const boop = this.advance('boopT', dt, 1.1);
    const pulse = this.advance('pulseT', dt, 1.1);
    if (this._mood === 'recover' && this.stateT > 1.4 && this.shakeT < 0 && !calm) this.shakeT = 0;
    const shake = this.shakeT >= 0 && this.shakeT < 0.9 ? this.shakeT / 0.9 : -1;
    if (this.shakeT >= 0) this.shakeT += dt;

    // Flight from the host (overlay) and from walkTo.
    this.flightSmooth.vx = damp(this.flightSmooth.vx, this.flight.vx, 6, dt);
    this.flightSmooth.vy = damp(this.flightSmooth.vy, this.flight.vy, 6, dt);
    const fvx = this.flightSmooth.vx,
      fvy = this.flightSmooth.vy;
    this.xSpring.step(this._walkTarget, 10, 6.5, dt);
    this.position.x = this.xSpring.x;
    const vx = this.xSpring.v + fvx;
    const speed = Math.hypot(vx, fvy);

    // Effort (how hard the wings work): mood + movement + climbing + flips.
    let thrust = p.thrust + Math.min(0.7, speed * 0.25) + Math.max(0, fvy) * 0.25;
    if (flip >= 0) thrust += Math.sin(flip * PI) * 1.0;
    if (boop >= 0 && this.boopKind === 'jump') thrust += (1 - boop) * 0.6;

    // Hover with bob, sprung so changes feel weighty.
    const moving = Math.min(1, speed * 0.6);
    let hoverT = p.hover + moving * 0.15;
    if (flip >= 0) hoverT += Math.sin(flip * PI) * 0.9;
    this.hoverSpring.step(hoverT, 30, 9, dt);
    // Wings: flutter while hovering, beat harder with effort, glide on fast level flight, fold when landed.
    const power = clamp(thrust, 0, 1.6);
    this.foldK = damp(this.foldK, p.thrust < 0.05 && speed < 0.2 && flip < 0 ? 1 : 0, 5, dt);
    this.glideK = damp(this.glideK, clamp((speed - 1.2) * 0.8, 0, 1) * (fvy > 0.6 ? 0.3 : 1), 3, dt);
    const rateT = calm ? 2.2 + power * 1.5 : 5.5 + power * 6.5;
    this.flapRate = damp(this.flapRate, rateT * (1 - this.glideK * 0.7), 4, dt);
    this.flapAmp = damp(
      this.flapAmp,
      (0.32 + power * 0.42) * (1 - this.glideK * 0.8) * (1 - this.foldK) * amp,
      6,
      dt,
    );
    this.flapPhase += dt * this.flapRate * TAU;
    const beat = Math.sin(this.flapPhase);
    const bob =
      Math.sin(t * 1.9 * p.bobSpeed) * 0.07 * p.bob * amp - Math.cos(this.flapPhase) * 0.012 * this.flapAmp;
    const rigY = this.hoverSpring.x + bob;
    this.rig.position.y = rigY;
    const vy = (rigY - this.lastRigY) / Math.max(dt, 1e-4);
    const ay = (vy - this.rigVy) / Math.max(dt, 1e-4);
    this.rigVy = vy;
    this.lastRigY = rigY;

    // Gaze: mood lock > explicit target > glances.
    if (!this.gazeTarget && !calm && t > this.nextGlance) {
      this.glance = {
        x: (this.rng() - 0.5) * 1.4,
        y: (this.rng() - 0.4) * 0.6,
        until: t + 0.7 + this.rng() * 0.6,
      };
      this.nextGlance = t + 2.5 + this.rng() * 4;
    }
    if (this.glance && t > this.glance.until) this.glance = null;
    let gxT = this.gazeTarget?.x ?? this.glance?.x ?? 0;
    let gyT = this.gazeTarget?.y ?? this.glance?.y ?? 0;
    if (this._mood === 'search') {
      gxT = Math.sin(t * 1.6) * 0.85;
      gyT = 0.05 + Math.sin(t * 0.9) * 0.15;
    }
    const lock = clamp(this._gazeLock, 0, 1);
    gxT = mix(gxT, p.gazeX, lock);
    gyT = mix(gyT, p.gazeY, lock);
    if (this._mood === 'think' || this._mood === 'process') {
      gxT += Math.sin(t * 3.1) * 0.06; // small reading saccades
    }
    this.gx = damp(this.gx, gxT, 10, dt);
    this.gy = damp(this.gy, gyT, 10, dt);

    // Rig orientation
    const yaw = this.yawSpring.step(this._yawTarget, 40, 11, dt);
    let rotY = yaw + this.gx * 0.3 * amp;
    if (spin >= 0) rotY += easeInOut(spin) * TAU;
    if (shake >= 0) rotY += Math.sin(shake * PI * 7) * 0.35 * (1 - shake);
    this.rig.rotation.y = rotY;
    const bank = clamp(-vx * 0.16, -0.55, 0.55) * amp;
    this.rig.rotation.z = p.tilt * amp + bank + Math.sin(t * 0.9) * 0.03 * amp;
    let pitch = p.lean - this.gy * 0.14 + clamp(-fvy * 0.06, -0.3, 0.3) + Math.abs(vx) * 0.05;
    if (flip >= 0) pitch -= easeInOut(flip) * TAU;
    this.rig.rotation.x = pitch;

    // Squash and stretch + breathing
    let squashT = p.squash;
    if (flip >= 0 && flip < 0.15) squashT += 0.12;
    const sq = this.squashSpring.step(squashT, 160, 9, dt) - ay * 0.0009 * amp;
    const breath = Math.sin(t * 2.2 * (this._mood === 'sleep' ? 0.55 : 1)) * 0.012 * p.breath;
    const s = clamp(sq, -0.25, 0.25);
    this.squashG.scale.set(1 + s + breath * 0.5, 1 - s + breath, 1 + s + breath * 0.5);

    // Eyes
    if (t > this.nextBlink && this.blinkT < 0 && p.eyeOpen > 0.3) {
      this.blink();
      this.doubleBlink = this.rng() < 0.16;
      this.nextBlink = t + 1.8 + -Math.log(1 - this.rng() * 0.95) * 2.2;
    }
    let blinkF = 1;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const b = this.blinkT / 0.15;
      blinkF = b < 0.5 ? 1 - b * 2 : (b - 0.5) * 2;
      if (b >= 1) {
        if (this.doubleBlink) {
          this.doubleBlink = false;
          this.blinkT = 0;
        } else this.blinkT = -1;
      }
    }
    let eyeSmile = p.eyeSmile;
    if (boop >= 0 && this.boopKind === 'giggle')
      eyeSmile = Math.max(eyeSmile, Math.sin(Math.min(1, boop * 1.4) * PI));
    let eyeOpen = p.eyeOpen;
    if (boop >= 0 && this.boopKind === 'jump') eyeOpen = Math.max(eyeOpen, 1.2 * (1 - boop) + eyeOpen * boop);
    const round = clamp(eyeOpen * clamp(blinkF, 0, 1), 0, 1.2) * (1 - clamp(eyeSmile, 0, 1));
    for (const e of this.eyes) {
      e.lid.visible = round > 0.08;
      e.lid.scale.set(1 + (p.pupil - 1) * 0.25, Math.max(0.001, round), 1);
      e.lid.position.set(this.gx * 0.05, this.gy * 0.045, 0);
      const sm = clamp(eyeSmile, 0, 1);
      e.smileArc.visible = sm > 0.05;
      e.smileArc.scale.setScalar(Math.max(0.001, sm));
      e.closedArc.visible = round <= 0.08 && sm < 0.5;
      e.group.position.copy(e.home);
    }

    // Cheeks
    const blush = clamp(p.blush + (boop >= 0 ? (1 - boop) * 0.6 : 0), 0, 1.2);
    for (const c of this.cheeks) (c.material as THREE.MeshBasicMaterial).opacity = blush * 0.85;

    // Mouth
    let smile = p.smile;
    let mouthOpen = p.mouth;
    if (this._mood === 'speak') {
      mouthOpen +=
        this.speakLevel ?? Math.max(0, Math.sin(t * 13.5) * 0.5 + Math.sin(t * 8.7 + 1) * 0.45) * 0.6;
    }
    if (boop >= 0 && this.boopKind === 'jump') mouthOpen = Math.max(mouthOpen, (1 - boop) * 0.8);
    if (boop >= 0 && this.boopKind === 'giggle') {
      smile = 1;
      mouthOpen = Math.max(mouthOpen, Math.abs(Math.sin(boop * PI * 6)) * 0.5 * (1 - boop));
    }
    const sy = Math.sign(smile || 1) * Math.max(0.18, Math.abs(smile));
    this.smileMesh.scale.set(1, sy, 1);
    this.smileMesh.visible = mouthOpen < 0.45;
    const mo = clamp(mouthOpen, 0, 1);
    this.openMouth.visible = mo > 0.04;
    this.openMouth.scale.set(0.65 + mo * 0.35, Math.max(0.001, mo * 0.9), 1);

    // Ears: springs toward the mood pose, kicked by vertical acceleration and banking.
    for (const e of this.ears) {
      const droop = 1 - p.ears;
      let rollT = e.sign * (p.earSplay + droop * 1.35);
      if (this._mood === 'unsure' && e.sign > 0) rollT += 0.9; // one floppy ear
      if (wave >= 0) rollT += e.sign * Math.sin(wave * PI) * 0.15;
      let pitchT = -0.12 + droop * 0.25;
      if (shake >= 0) pitchT += Math.sin(shake * PI * 7 + e.sign) * 0.6 * (1 - shake);
      e.roll.step(rollT - bank * 0.6, 70, 7, dt);
      e.pitch.kick(clamp(ay * 0.002, -0.6, 0.6) * amp);
      e.pitch.step(pitchT, 60, 6, dt);
      e.roll2.step(e.sign * droop * 1.1 + (e.roll.x - rollT) * 0.8, 50, 5, dt);
      e.seg1.rotation.set(e.pitch.x, 0, -e.roll.x);
      e.seg2.rotation.set(e.pitch.x * 0.8 + Math.sin(t * 2 + e.sign) * 0.04 * amp, 0, -e.roll2.x);
    }

    // Antenna wobble and star
    this.antennaSpring.kick(-bank * dt * 3 + ay * 0.0006);
    this.antennaSpring.step(0, 55, 4, dt);
    this.antenna.rotation.z = this.antennaSpring.x;
    const starPow =
      p.star *
      (this._mood === 'process'
        ? 0.8 + 0.4 * Math.sin(t * 8)
        : this._mood === 'think'
          ? 0.85 + 0.25 * Math.sin(t * 3)
          : 1);
    this.starMat.emissiveIntensity = 0.25 + starPow * 0.6;
    (this.starGlow.material as THREE.SpriteMaterial).opacity = clamp(starPow * 0.55, 0, 0.9);
    this.starGlow.scale.setScalar(0.45 + starPow * 0.45);
    this.starG.rotation.z = Math.sin(t * 1.3) * 0.15 + (this._mood === 'process' ? t * 2.5 : 0);
    this.starG.rotation.y = Math.sin(t * 0.7) * 0.4;

    // Arms
    this.updateArms(dt, wave, amp);

    // Feet dangle while flying
    this.footSpring.step(clamp(vx * 0.25 - fvy * 0.1, -0.6, 0.6), 30, 5, dt);
    const fh = clamp(this.hoverSpring.x * 2, 0, 1);
    this.feet.forEach((f, i) => {
      f.rotation.x = (this.footSpring.x + Math.sin(t * 3 + i * 1.7) * 0.15 * fh) * amp;
      f.position.y = -0.88 - fh * 0.03 + (i ? 1 : -1) * Math.sin(t * 3 + i) * 0.015 * fh;
    });

    // Wing pose: z raises/lowers (the beat), y sweeps them back (folded), x tilts them in a glide.
    for (const w of this.wings) {
      const spread = 0.3 - this.foldK * 0.7 + this.glideK * 0.1;
      w.pivot.rotation.set(
        this.glideK * 0.25,
        w.side * (0.32 + this.foldK * 0.95 - this.glideK * 0.2),
        w.side * (spread + beat * this.flapAmp),
      );
    }

    // Shadow
    if (this.shadow) {
      const h = clamp(this.hoverSpring.x, 0, 2);
      this.shadow.scale.setScalar(1 - h * 0.28);
      (this.shadow.material as THREE.MeshBasicMaterial).opacity = clamp(1 - h * 0.55, 0.15, 1);
    }

    // Pulse ring
    this.ring.visible = pulse >= 0;
    if (pulse >= 0) {
      const e = 1 - Math.pow(1 - pulse, 3);
      this.ring.scale.setScalar(1 + e * 1.6);
      (this.ring.material as THREE.MeshBasicMaterial).opacity = (1 - pulse) * 0.4;
    }

    this.updateEffects(dt, power, fvx, fvy, vx, speed, beat);
  }

  /** Advance a one-shot timer; returns progress 0..1, or -1 when not playing. */
  private advance(key: 'flipT' | 'spinT' | 'waveT' | 'boopT' | 'pulseT', dt: number, dur: number) {
    if (this[key] < 0) return -1;
    this[key] += dt;
    if (this[key] >= dur) {
      this[key] = -1;
      return -1;
    }
    return this[key] / dur;
  }

  private updateArms(dt: number, wave: number, amp: number) {
    const p = this.pose;
    const h = this.hands;
    const t = this.t;
    // Typing rhythm: alternating taps with occasional pauses.
    if (h.type > 0.1) {
      this.tapT -= dt;
      if (this.tapT <= 0) {
        this.tapSide = 1 - this.tapSide;
        this.tapT = this.rng() < 0.08 ? 0.45 : 0.09 + this.rng() * 0.08;
        if (this.fx.panel > 0.5 && this.rng() < 0.35)
          this.spawnSparkle(this.tapSide ? 0.35 : -0.35, -0.55, 1.2, 0.12);
      }
    }
    for (const side of ['left', 'right'] as const) {
      const sx = side === 'right' ? 1 : -1;
      const arm = this.arms[side];
      const lift = p.arms + (wave >= 0 && side === this.waveSide ? 0 : 0);
      let rz = sx * (0.3 + lift * 2.2) + Math.sin(t * 1.9 + sx) * 0.05 * amp;
      let rx = 0;
      // Hands layers (weights blend smoothly between moods).
      rx += h.type * -1.2;
      rz = mix(rz, sx * 0.35, h.type);
      const tap =
        h.type * (this.tapSide === (sx > 0 ? 1 : 0) ? Math.sin(clamp(this.tapT / 0.12, 0, 1) * PI) : 0);
      rx += tap * 0.35 * amp;
      if (side === 'right') {
        // Paw to chin
        rz = mix(rz, -0.9, h.chin);
        rx = mix(rx, -1.25, h.chin);
      }
      rz = mix(rz, sx * -0.55, h.hug);
      rx = mix(rx, -1.1, h.hug);
      const shrug = Math.max(0, Math.sin(t * 1.4)) ** 3;
      rz = mix(rz, sx * (1.0 + shrug * 0.4), h.shrug);
      if (side === this.waveSide && (wave >= 0 || h.wave > 0.05)) {
        const w = wave >= 0 ? Math.sin(Math.min(1, wave * 1.2) * PI) : 0;
        const ww = Math.max(w, wave >= 0 ? 0 : 0);
        rz = mix(rz, sx * (2.5 + Math.sin(t * 16) * 0.35 * amp), ww);
        rx = mix(rx, -0.2, ww);
      }
      arm.rotation.set(rx, 0, rz);
    }
  }

  private updateEffects(
    dt: number,
    power: number,
    fvx: number,
    fvy: number,
    vx: number,
    speed: number,
    beat: number,
  ) {
    const t = this.t;
    const fx = this.fx;

    // Thinking dots orbit above the head
    this.dotsG.visible = fx.dots > 0.02;
    if (this.dotsG.visible) {
      const sp = this._mood === 'process' ? 4.5 : 2;
      this.dots.forEach((d, i) => {
        const a = t * sp + (i * TAU) / 3;
        d.position.set(Math.cos(a) * 0.45, Math.sin(t * 3 + i) * 0.06, Math.sin(a) * 0.25);
        d.scale.setScalar(fx.dots * (0.75 + 0.25 * Math.sin(t * 5 + i * 2)));
      });
    }

    // Scan beam
    this.scan.visible = fx.scan > 0.02;
    if (this.scan.visible) {
      (this.scan.material as THREE.MeshBasicMaterial).opacity = fx.scan * (0.16 + 0.05 * Math.sin(t * 9));
      this.scan.rotation.z = Math.sin(t * 1.6) * 0.9;
    }

    // Holographic keyboard
    this.panel.visible = fx.panel > 0.02;
    if (this.panel.visible) {
      (this.panel.material as THREE.MeshBasicMaterial).opacity = fx.panel * (0.85 + 0.08 * Math.sin(t * 6));
      this.panel.position.y = -0.62 + (1 - fx.panel) * -0.3;
    }

    // Question mark
    this.question.visible = fx.question > 0.02;
    if (this.question.visible) {
      (this.question.material as THREE.SpriteMaterial).opacity = fx.question;
      this.question.scale.setScalar(0.5 * easeOutBack(clamp(fx.question, 0, 1)));
      this.question.position.y = 1.25 + Math.sin(t * 2.4) * 0.06;
      this.question.material.rotation = Math.sin(t * 1.7) * 0.2;
    }

    // Nose bubble while asleep
    this.bubble.visible = fx.zzz > 0.3;
    if (this.bubble.visible) {
      this.bubbleT += dt;
      const cyc = (this.bubbleT % 3.2) / 3.2;
      const sc = cyc < 0.92 ? 0.3 + Math.sin(cyc * PI) * 1.1 : 0.001;
      this.bubble.scale.setScalar(Math.max(0.001, sc * fx.zzz));
    }

    // Wind trail from the wingtips: a few puffs on strong downstrokes, a streak when flying fast.
    const ex = this.exhaust;
    const trail = clamp(speed * 0.5, 0, 1.5) + (beat < -0.7 ? power * 0.6 : 0);
    if (trail > 0.12 && this.foldK < 0.5) {
      this.emitAcc += dt * (6 + trail * 40) * (ex.n / 110);
      while (this.emitAcc >= 1) {
        this.emitAcc -= 1;
        for (const w of this.wings) {
          w.tip.getWorldPosition(_v);
          this.worldToLocal(_v);
          const i = this.spawn(ex);
          ex.pos[i * 3] = _v.x + (this.rng() - 0.5) * 0.05;
          ex.pos[i * 3 + 1] = _v.y + (this.rng() - 0.5) * 0.05;
          ex.pos[i * 3 + 2] = _v.z + (this.rng() - 0.5) * 0.05;
          ex.vel[i * 3] = (this.rng() - 0.5) * 0.3 - fvx * 0.7 - (vx - fvx) * 0.6;
          ex.vel[i * 3 + 1] = -0.25 - power * 0.35 - fvy * 0.6;
          ex.vel[i * 3 + 2] = (this.rng() - 0.5) * 0.3;
          ex.max[i] = 0.35 + this.rng() * 0.35;
          ex.size[i] = 0.05 + this.rng() * 0.05;
          ex.grow[i] = 0.3 + this.rng() * 0.3;
          _col.setHex(this.rng() < 0.75 ? PALETTE.trail : PALETTE.sparkles[Math.floor(this.rng() * 4)]!);
          ex.color.set([_col.r, _col.g, _col.b], i * 3);
        }
      }
    }
    this.stepPool(ex, dt, (i, k) => {
      ex.alpha[i] = Math.pow(1 - k, 1.4) * 0.55;
      ex.vel[i * 3]! *= 1 - dt * 2;
      ex.vel[i * 3 + 1]! *= 1 - dt * 2.5;
      ex.vel[i * 3 + 1]! += dt * 0.6; // puffs drift back up a little as they slow
    });

    // Sparkles
    if (fx.sparkles > 0.3) {
      this.sparkAcc += dt * 6 * fx.sparkles;
      while (this.sparkAcc >= 1) {
        this.sparkAcc -= 1;
        const a = this.rng() * TAU;
        const r = 1.2 + this.rng() * 0.5;
        this.spawnSparkle(Math.cos(a) * r, this.rig.position.y + Math.sin(a) * r * 0.9 + 0.2, 0.3, 0);
      }
    }
    const sp = this.sparkles;
    this.stepPool(sp, dt, (i, k) => {
      sp.alpha[i] = Math.sin(k * PI) * (0.75 + 0.25 * Math.sin(t * 20 + i));
      sp.vel[i * 3 + 1]! -= dt * 0.8 * sp.grow[i]!;
    });

    // Hearts
    if (fx.hearts > 0.3) {
      this.heartAcc += dt * 1.6;
      if (this.heartAcc >= 1) {
        this.heartAcc = 0;
        this.spawnHeart((this.rng() - 0.5) * 1.2);
      }
    }
    for (const h of this.hearts) this.stepFloater(h, dt, 0.35);

    // Zzz
    if (fx.zzz > 0.5) {
      this.zeeAcc += dt;
      if (this.zeeAcc > 1.1) {
        this.zeeAcc = 0;
        const z = this.zees.find((f) => f.life <= 0);
        if (z) {
          z.t = 0;
          z.life = 2.6;
          z.vx = 0.25;
          z.vy = 0.35;
          z.phase = this.rng() * TAU;
          z.scale = 0.28;
          z.sprite.position.set(0.55, this.rig.position.y + 0.9, 0.3);
          z.sprite.visible = true;
        }
      }
    }
    for (const z of this.zees) this.stepFloater(z, dt, 0.55);
  }

  private spawn(pool: Pool) {
    const i = pool.next;
    pool.next = (pool.next + 1) % pool.n;
    pool.life[i] = 0;
    return i;
  }

  private stepPool(pool: Pool, dt: number, each: (i: number, k: number) => void) {
    for (let i = 0; i < pool.n; i++) {
      const max = pool.max[i]!;
      if (max <= 0) {
        pool.alpha[i] = 0;
        continue;
      }
      pool.life[i]! += dt;
      const k = pool.life[i]! / max;
      if (k >= 1) {
        pool.max[i] = 0;
        pool.alpha[i] = 0;
        continue;
      }
      pool.pos[i * 3]! += pool.vel[i * 3]! * dt;
      pool.pos[i * 3 + 1]! += pool.vel[i * 3 + 1]! * dt;
      pool.pos[i * 3 + 2]! += pool.vel[i * 3 + 2]! * dt;
      pool.size[i]! += pool.grow[i]! * dt * 0.5;
      each(i, k);
    }
    const geo = pool.points.geometry;
    for (const name of ['position', 'aSize', 'aAlpha', 'aColor']) geo.getAttribute(name).needsUpdate = true;
  }

  private spawnSparkle(x: number, y: number, z: number, speed: number) {
    const sp = this.sparkles;
    const i = this.spawn(sp);
    sp.pos.set([x, y, z], i * 3);
    const a = this.rng() * TAU;
    sp.vel.set([Math.cos(a) * speed, Math.sin(a) * speed + 0.25, 0], i * 3);
    sp.max[i] = 0.7 + this.rng() * 0.7;
    sp.size[i] = 0.16 + this.rng() * 0.16;
    sp.grow[i] = 0;
    _col.setHex(PALETTE.sparkles[Math.floor(this.rng() * PALETTE.sparkles.length)]!);
    sp.color.set([_col.r, _col.g, _col.b], i * 3);
  }

  /** A burst of sparkles flying outward (celebrations). */
  private burst(n: number) {
    const sp = this.sparkles;
    const y = this.rig.position.y;
    for (let k = 0; k < n; k++) {
      const i = this.spawn(sp);
      const a = this.rng() * TAU;
      const sp0 = 1.6 + this.rng() * 1.6;
      sp.pos.set([Math.cos(a) * 0.5, y + Math.sin(a) * 0.5, 0.4], i * 3);
      sp.vel.set([Math.cos(a) * sp0, Math.sin(a) * sp0 + 0.8, (this.rng() - 0.5) * 0.8], i * 3);
      sp.max[i] = 0.9 + this.rng() * 0.6;
      sp.size[i] = 0.18 + this.rng() * 0.2;
      sp.grow[i] = 1.5;
      _col.setHex(PALETTE.sparkles[k % PALETTE.sparkles.length]!);
      sp.color.set([_col.r, _col.g, _col.b], i * 3);
    }
  }

  private spawnHeart(x: number) {
    const h = this.hearts.find((f) => f.life <= 0) ?? this.hearts[0]!;
    h.t = 0;
    h.life = 1.8;
    h.vx = x * 0.3;
    h.vy = 0.7;
    h.phase = this.rng() * TAU;
    h.scale = 0.26 + this.rng() * 0.1;
    h.sprite.position.set(x, this.rig.position.y + 0.8, 0.6);
    h.sprite.visible = true;
  }

  private stepFloater(f: Floater, dt: number, sway: number) {
    if (f.life <= 0) {
      f.sprite.visible = false;
      return;
    }
    f.t += dt;
    const k = f.t / f.life;
    if (k >= 1) {
      f.life = 0;
      f.sprite.visible = false;
      return;
    }
    f.sprite.position.x += (f.vx + Math.sin(f.t * 3 + f.phase) * sway) * dt;
    f.sprite.position.y += f.vy * dt;
    const pop = easeOutBack(clamp(f.t / 0.35, 0, 1));
    f.sprite.scale.setScalar(f.scale * pop * (1 + k * 0.4));
    const mat = f.sprite.material as THREE.SpriteMaterial;
    mat.opacity = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
    mat.rotation = Math.sin(f.t * 2 + f.phase) * 0.25;
  }

  // ---------------------------------------------------------------------------------------------
  // Lifetime

  /**
   * Free every GPU resource without detaching anything. Safe to call twice (React StrictMode runs
   * effect cleanups twice); three.js re-uploads disposed resources if they are rendered again.
   */
  releaseGpu() {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.tex.all) t.dispose();
    // Sprites share one module-level geometry that nothing else disposes.
    this.question.geometry.dispose();
  }

  override dispose() {
    this.releaseGpu();
    this.removeFromParent();
  }
}
