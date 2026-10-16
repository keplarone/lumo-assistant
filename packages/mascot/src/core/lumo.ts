/**
 * Lumo, the celestial owl. A line-for-line TypeScript port of the established mascot in
 * docs/reference/lumo-mascot.html (originally three r149). Geometry, shaders, palette, rig
 * targets and easing are unchanged; only types and module structure were added.
 *
 * Deliberate deviation: colors handed to three's built-in materials go through rawColor() so they
 * keep their r149 values under r152+ color management (see rawColor), and additive materials use
 * r149's blend factors (see ADDITIVE). The host renderer must use linear output and no tone mapping.
 *
 * Product behaviors (listening, searching, walking, ...) live in ./companion.ts and are layered
 * on top of this rig, never baked into it.
 */
import * as THREE from 'three';
import {
  BODY_FRAG,
  CRYSTAL_FRAG,
  DISC_FRAG,
  FEATHER_FRAG,
  FEATHER_VERT,
  IRIS_FRAG,
  LID_FRAG,
  LIT_FRAG,
  PARTICLE_FRAG,
  PARTICLE_VERT,
  RING_FRAG,
  VERT,
} from './shaders';

const TAU = Math.PI * 2;
const v3 = (hex: number) =>
  new THREE.Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
/**
 * Color fidelity across three.js versions.
 *
 * The reference was authored on three r149, where color management was off: a hex color such as
 * 0x5566ff went to the GPU as the raw components (0x55/255, ...), the renderer wrote linear output
 * with no tone mapping, and the canvas showed those numbers directly. On three r152+ with
 * ColorManagement enabled, `new THREE.Color(hex)` (and `material.color = hex`) treats hex as sRGB
 * and converts it to the linear working space, so the additive aura, motes, ground glow and pulse
 * ring render noticeably darker than the original.
 *
 * `rawColor()` builds the Color from the raw hex components declared as *linear* values. That is
 * an identity conversion when ColorManagement is on and a no-op when it is off, so the GPU receives
 * exactly the r149 values either way. The renderer must match r149's output as well:
 * `outputColorSpace = LinearSRGBColorSpace` and `toneMapping = NoToneMapping` (in R3F:
 * `<Canvas linear flat>`). ShaderMaterial uniforms already use raw Vector3 values (v3), which
 * three never converts.
 */
export const rawColor = (hex: number) =>
  new THREE.Color().setRGB(
    ((hex >> 16) & 255) / 255,
    ((hex >> 8) & 255) / 255,
    (hex & 255) / 255,
    THREE.LinearSRGBColorSpace,
  );
/**
 * Additive blending exactly as three r149 issued it: gl.blendFunc(SRC_ALPHA, ONE) for color AND
 * alpha. Since r15x, AdditiveBlending uses blendFuncSeparate(SRC_ALPHA, ONE, ONE, ONE), which writes
 * more alpha into a transparent canvas; the browser then lets less of the page background show
 * through the glow, so the aura and ground glow look darker over the stage than the original.
 */
export const ADDITIVE = {
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.SrcAlphaFactor,
  blendDst: THREE.OneFactor,
  blendEquationAlpha: THREE.AddEquation,
  blendSrcAlpha: THREE.SrcAlphaFactor,
  blendDstAlpha: THREE.OneFactor,
} as const;
export const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt));
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export const PALETTE = {
  bodyTop: 0x2c3184,
  bodyBot: 0x0b0d2a,
  rim: 0x7ff3ff,
  gold: 0xffc65c,
  discCenter: 0xf4f0ff,
  discEdge: 0x9f9de6,
  discRing: 0xffc65c,
  irisIn: 0xffe9a0,
  irisOut: 0xff8a3d,
  pupil: 0x04051a,
  sclera: 0x0e1034,
  circuit: 0x8ff6ff,
  lid: 0x262b72,
  beak: 0xffc65c,
  featherRoot: 0x0d1032,
  featherMid: 0x2e3ca6,
  featherEdge: 0x7ff3ff,
  featherTip: 0xffd27a,
  covertRoot: 0x171b4f,
  covertMid: 0x3a3f9e,
  crystalBase: 0xffc65c,
  crystalTip: 0xc4fdff,
  aura: 0x5566ff,
  warm: 0xffb648,
  spark: 0xc4fdff,
} as const;

/** Every value the rig eases toward each frame. */
export interface RigTargets {
  wingSpread: number;
  flap: number;
  lidTop: number;
  lidBottom: number;
  glow: number;
  haloSpeed: number;
  bob: number;
  breath: number;
  tilt: number;
  talk: number;
  crest: number;
  rise: number;
  lean: number;
  tailFan: number;
  dilate: number;
  gazeLock: number;
  gazeX: number;
  gazeY: number;
}

// Every state lists the full set of rig targets. Values are eased toward, never snapped.
export const BASE: RigTargets = {
  wingSpread: 0.05,
  flap: 0.15,
  lidTop: 0.1,
  lidBottom: 0,
  glow: 0.65,
  haloSpeed: 0.35,
  bob: 1,
  breath: 1,
  tilt: 0,
  talk: 0,
  crest: 0.45,
  rise: 0,
  lean: 0,
  tailFan: 0.1,
  dilate: 1,
  gazeLock: 0,
  gazeX: 0,
  gazeY: 0,
};

/** The six moods of the reference rig. */
export const CORE_MOODS = {
  idle: {},
  think: {
    wingSpread: 0.12,
    flap: 0.08,
    lidTop: 0.2,
    lidBottom: 0.12,
    glow: 0.85,
    haloSpeed: 1.8,
    bob: 0.6,
    tilt: 0.2,
    crest: 1.05,
    rise: 0.05,
    tailFan: 0.2,
    dilate: 0.75,
    gazeLock: 1,
    gazeX: -0.5,
    gazeY: 0.6,
  },
  speak: {
    wingSpread: 0.16,
    flap: 0.3,
    lidTop: 0.1,
    lidBottom: 0.04,
    glow: 0.85,
    haloSpeed: 0.75,
    bob: 0.9,
    tilt: 0.04,
    talk: 1,
    crest: 0.75,
    tailFan: 0.25,
    dilate: 1.05,
  },
  happy: {
    wingSpread: 0.34,
    flap: 1,
    lidTop: 0,
    lidBottom: 0.45,
    glow: 1.05,
    haloSpeed: 0.95,
    bob: 1.5,
    tilt: -0.12,
    crest: 0.95,
    rise: 0.12,
    tailFan: 0.6,
    dilate: 1.15,
  },
  majestic: {
    wingSpread: 1,
    flap: 0.22,
    lidTop: 0,
    glow: 1.4,
    haloSpeed: 0.55,
    bob: 0.5,
    crest: 1.35,
    rise: 0.32,
    lean: -0.08,
    tailFan: 1,
    dilate: 0.9,
  },
  sleep: {
    wingSpread: 0,
    flap: 0,
    lidTop: 1,
    lidBottom: 0.12,
    glow: 0.22,
    haloSpeed: 0.06,
    bob: 0.45,
    breath: 0.45,
    tilt: 0.28,
    crest: 0.15,
    rise: -0.08,
    lean: 0.1,
    tailFan: 0,
    dilate: 1.3,
    gazeLock: 1,
    gazeX: 0,
    gazeY: -0.3,
  },
} satisfies Record<string, Partial<RigTargets>>;

export type CoreMood = keyof typeof CORE_MOODS;

/**
 * Mood registry. Starts with the reference moods; companion.ts registers product moods built from
 * the same rig targets. Entries are always complete (BASE merged in).
 */
export const STATES: Record<string, RigTargets> = {};
export function registerMood(name: string, targets: Partial<RigTargets>) {
  STATES[name] = Object.assign({}, BASE, targets);
}
for (const [k, v] of Object.entries(CORE_MOODS)) registerMood(k, v);

function canvasTex(draw: (g: CanvasRenderingContext2D, size: number) => void, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}
const glowTex = () =>
  canvasTex((g, s) => {
    const r = s / 2,
      gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.22, 'rgba(255,255,255,0.5)');
    gr.addColorStop(0.55, 'rgba(255,255,255,0.12)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  });
const ringTex = () =>
  canvasTex((g, s) => {
    const r = s / 2,
      gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.72, 'rgba(255,255,255,0)');
    gr.addColorStop(0.86, 'rgba(255,255,255,1)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  }, 256);

function featherGeometry(len: number, width: number, bend = 0.12, segs = 28) {
  const shape = new THREE.Shape();
  const xs: [number, number][] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    xs.push([width * Math.sin(Math.PI * Math.pow(t, 0.62)), -t * len]);
  }
  shape.moveTo(0, 0);
  for (let i = 1; i <= segs; i++) shape.lineTo(xs[i]![0], xs[i]![1]);
  for (let i = segs - 1; i >= 1; i--) shape.lineTo(-xs[i]![0], xs[i]![1]);
  shape.lineTo(0, 0);
  const g = new THREE.ShapeGeometry(shape, 1);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const ts = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i),
      y = pos.getY(i),
      t = -y / len;
    ts[i * 2] = t;
    ts[i * 2 + 1] = x / width;
    pos.setZ(i, -bend * t * t * len);
  }
  g.setAttribute('aTS', new THREE.BufferAttribute(ts, 2));
  g.computeVertexNormals();
  return g;
}

type Uniform<T> = { value: T };
interface EyeParts {
  socket: THREE.Group;
  ball: THREE.Mesh;
  lidTop: THREE.Mesh;
  lidBottom: THREE.Mesh;
  shine: [THREE.Mesh, THREE.Mesh];
}
interface WingParts {
  group: THREE.Group;
  primaries: THREE.Mesh[];
  coverts: THREE.Mesh[];
  side: number;
}
export interface LumoParts {
  rig: THREE.Group;
  body: THREE.Group;
  bodyMesh: THREE.Mesh;
  head: THREE.Group;
  eyes: { left: EyeParts; right: EyeParts };
  beak: { group: THREE.Group; upper: THREE.Mesh; jaw: THREE.Group };
  crest: { group: THREE.Group; tufts: THREE.Group[]; gem: THREE.Mesh };
  wings: { left: WingParts; right: WingParts };
  tail: { group: THREE.Group; feathers: THREE.Mesh[] };
  halo: THREE.Group;
  aura: { cool: THREE.Sprite; warm: THREE.Sprite };
  ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  particles: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  pulse: THREE.Sprite;
}

export interface LumoOptions {
  /** Number of drifting light motes. */
  particles: number;
  pixelRatio: number;
  /** Damp ambient motion amplitude (used for prefers-reduced-motion). */
  calm: boolean;
}

export interface LumoEventMap extends THREE.Object3DEventMap {
  statechange: { state: string; previous: string };
}

export class Lumo extends THREE.Group<LumoEventMap> {
  opts: LumoOptions;
  state = 'idle';
  targets: RigTargets;
  params: RigTargets;
  time = 0;
  /** 0..1 audio level that drives the beak (e.g. from a TTS analyser). null = automatic talk wave. */
  speakLevel: number | null = null;
  parts!: LumoParts;
  protected _gaze: THREE.Vector2 | null = null;
  protected _look = new THREE.Vector2();
  protected _nextBlink = 1.5 + Math.random() * 2;
  protected _blinkT = -1;
  protected _pulseT = -1;
  protected _flapPhase = 0;
  protected _haloPhase = 0;
  protected _reactT = 0;
  protected _reactPrev = 'idle';
  protected _disposables: { dispose(): void }[] = [];
  private _u!: {
    time: Uniform<number>;
    glow: Uniform<number>;
    pulse: Uniform<number>;
    dilate: Uniform<number>;
  };
  private _rings!: THREE.Mesh<THREE.TorusGeometry, THREE.ShaderMaterial>[];
  private _motes!: THREE.Group;

  static STATES = STATES;
  static PALETTE = PALETTE;

  constructor(opts: Partial<LumoOptions> = {}) {
    super();
    this.name = 'Lumo';
    this.opts = Object.assign({ particles: 150, pixelRatio: 1, calm: false }, opts);
    this.targets = Object.assign({}, STATES.idle!);
    this.params = Object.assign({}, STATES.idle!);
    this._build();
  }

  private _mat(
    frag: string,
    uniforms: Record<string, Uniform<unknown>>,
    extra: THREE.ShaderMaterialParameters = {},
  ) {
    const m = new THREE.ShaderMaterial(
      Object.assign({ vertexShader: VERT, fragmentShader: frag, uniforms }, extra),
    );
    this._disposables.push(m);
    return m;
  }

  private _build() {
    const P = PALETTE;
    const U = (this._u = {
      time: { value: 0 },
      glow: { value: 0.65 },
      pulse: { value: 0.45 },
      dilate: { value: 1 },
    });
    const tex = { glow: glowTex(), ring: ringTex() };
    this._disposables.push(tex.glow, tex.ring);

    const rig = new THREE.Group();
    rig.name = 'rig';
    this.add(rig);
    const sphere = new THREE.SphereGeometry(1, 96, 64);
    this._disposables.push(sphere);

    // Aura behind everything
    const spriteMat = (color: number, opacity: number, map: THREE.Texture = tex.glow) => {
      const m = new THREE.SpriteMaterial({
        map,
        color: rawColor(color),
        transparent: true,
        opacity,
        ...ADDITIVE,
        depthWrite: false,
      });
      this._disposables.push(m);
      return m;
    };
    const aura = new THREE.Sprite(spriteMat(P.aura, 0.3));
    aura.position.set(0, 0.15, -1.1);
    aura.scale.setScalar(6);
    const warm = new THREE.Sprite(spriteMat(P.warm, 0.18));
    warm.position.set(0, 0.55, -0.8);
    warm.scale.setScalar(3.2);
    rig.add(aura, warm);

    // Halo: a slow orbit ring plus a finely ticked outer ring
    const halo = new THREE.Group();
    halo.name = 'halo';
    halo.position.set(0, 0.32, -0.75);
    halo.rotation.x = -0.1;
    const ringMat = (color: number, mode: number) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: RING_FRAG,
        transparent: true,
        ...ADDITIVE,
        depthWrite: false,
        uniforms: {
          uColor: { value: v3(color) },
          uPhase: { value: 0 },
          uIntensity: { value: 1 },
          uMode: { value: mode },
        },
      });
      this._disposables.push(m);
      return m;
    };
    const ringA = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.014, 8, 220), ringMat(P.gold, 0));
    const ringB = new THREE.Mesh(new THREE.TorusGeometry(1.64, 0.007, 6, 260), ringMat(P.rim, 1));
    this._disposables.push(ringA.geometry, ringB.geometry);
    const motes = new THREE.Group();
    for (let i = 0; i < 9; i++) {
      const s = new THREE.Sprite(spriteMat(i % 3 ? P.spark : P.warm, 0.9));
      const a = (i / 9) * TAU;
      s.position.set(Math.cos(a) * 1.5, Math.sin(a) * 1.5, 0);
      s.scale.setScalar(i % 3 ? 0.13 : 0.22);
      motes.add(s);
    }
    halo.add(ringA, ringB, motes);
    rig.add(halo);
    this._rings = [ringA, ringB];
    this._motes = motes;

    // Body
    const bodyGroup = new THREE.Group();
    bodyGroup.name = 'body';
    const body = new THREE.Mesh(
      sphere,
      this._mat(BODY_FRAG, {
        uTime: U.time,
        uGlow: U.glow,
        uTop: { value: v3(P.bodyTop) },
        uBot: { value: v3(P.bodyBot) },
        uRim: { value: v3(P.rim) },
        uGold: { value: v3(P.gold) },
        uSpark: { value: v3(P.spark) },
      }),
    );
    body.scale.set(1, 1.12, 0.95);
    bodyGroup.add(body);
    rig.add(bodyGroup);

    // Head (pivots at body centre so features glide over the surface)
    const head = new THREE.Group();
    head.name = 'head';
    rig.add(head);
    const discMat = this._mat(DISC_FRAG, {
      uCenter: { value: v3(P.discCenter) },
      uEdge: { value: v3(P.discEdge) },
      uRing: { value: v3(P.discRing) },
      uGlow: U.glow,
    });
    const irisMat = this._mat(IRIS_FRAG, {
      uIn: { value: v3(P.irisIn) },
      uOut: { value: v3(P.irisOut) },
      uPupil: { value: v3(P.pupil) },
      uSclera: { value: v3(P.sclera) },
      uCircuit: { value: v3(P.circuit) },
      uDilate: U.dilate,
      uGlow: U.glow,
      uTime: U.time,
    });
    const lidMat = this._mat(
      LID_FRAG,
      { uColor: { value: v3(P.lid) }, uLine: { value: v3(P.gold) }, uRim: { value: v3(P.rim) } },
      { side: THREE.DoubleSide },
    );
    const shineMat = new THREE.MeshBasicMaterial({ color: rawColor(0xffffff) });
    this._disposables.push(shineMat);
    const topLidGeo = new THREE.SphereGeometry(1, 40, 20, 0, TAU, 0, Math.PI / 2);
    const botLidGeo = new THREE.SphereGeometry(1, 40, 20, 0, TAU, Math.PI / 2, Math.PI / 2);
    const smallSphere = new THREE.SphereGeometry(1, 20, 12);
    this._disposables.push(topLidGeo, botLidGeo, smallSphere);

    const eyes = {} as LumoParts['eyes'];
    for (const side of [-1, 1]) {
      const disc = new THREE.Mesh(sphere, discMat);
      disc.scale.set(0.37, 0.39, 0.16);
      disc.position.set(side * 0.31, 0.32, 0.79);
      head.add(disc);
      const socket = new THREE.Group();
      socket.name = side < 0 ? 'eyeL' : 'eyeR';
      socket.position.set(side * 0.31, 0.35, 0.85);
      const ball = new THREE.Mesh(sphere, irisMat);
      ball.scale.setScalar(0.19);
      ball.name = 'eyeball';
      const top = new THREE.Mesh(topLidGeo, lidMat);
      top.scale.setScalar(0.205);
      top.name = 'lidTop';
      const bot = new THREE.Mesh(botLidGeo, lidMat);
      bot.scale.setScalar(0.203);
      bot.name = 'lidBottom';
      const s1 = new THREE.Mesh(smallSphere, shineMat);
      s1.scale.setScalar(0.034);
      s1.position.set(-0.065, 0.085, 0.16);
      const s2 = new THREE.Mesh(smallSphere, shineMat);
      s2.scale.setScalar(0.016);
      s2.position.set(0.07, -0.05, 0.175);
      socket.add(ball, top, bot, s1, s2);
      head.add(socket);
      eyes[side < 0 ? 'left' : 'right'] = { socket, ball, lidTop: top, lidBottom: bot, shine: [s1, s2] };
    }

    // Beak
    const beakMat = this._mat(LIT_FRAG, {
      uColor: { value: v3(P.beak) },
      uRim: { value: v3(0xffffff) },
      uRimAmt: { value: 0.3 },
      uEmissive: { value: v3(0x3a2400) },
    });
    const upperGeo = new THREE.ConeGeometry(0.075, 0.24, 24);
    const lowerGeo = new THREE.ConeGeometry(0.05, 0.13, 20);
    this._disposables.push(upperGeo, lowerGeo);
    const beak = new THREE.Group();
    beak.name = 'beak';
    const upper = new THREE.Mesh(upperGeo, beakMat);
    upper.position.set(0, 0.11, 0.96);
    upper.rotation.x = Math.PI + 0.32;
    upper.scale.z = 0.8;
    const jaw = new THREE.Group();
    jaw.position.set(0, 0.06, 0.93);
    const lower = new THREE.Mesh(lowerGeo, beakMat);
    lower.position.set(0, -0.05, 0);
    lower.rotation.x = Math.PI + 0.2;
    lower.scale.z = 0.8;
    jaw.add(lower);
    beak.add(upper, jaw);
    head.add(beak);

    // Crest: crystal ear-tufts and a floating crown gem
    const shardGeo = new THREE.OctahedronGeometry(1, 0);
    shardGeo.translate(0, 1, 0);
    this._disposables.push(shardGeo);
    const crystalMat = this._mat(CRYSTAL_FRAG, {
      uBase: { value: v3(P.crystalBase) },
      uTip: { value: v3(P.crystalTip) },
      uPulse: U.pulse,
      uTime: U.time,
    });
    const crest = new THREE.Group();
    crest.name = 'crest';
    const tufts: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const tuft = new THREE.Group();
      tuft.position.set(side * 0.4, 0.9, 0.18);
      tuft.rotation.z = -side * 0.5;
      tuft.rotation.x = -0.18;
      (
        [
          [-0.07, 0.3, 0.32],
          [0, 0.52, 0],
          [0.07, 0.36, -0.36],
        ] as const
      ).forEach(([x, L, rz]) => {
        const m = new THREE.Mesh(shardGeo, crystalMat);
        m.position.x = side * x;
        m.rotation.z = side * rz;
        m.scale.set(0.07, L / 2, 0.07);
        m.userData.baseL = L / 2;
        tuft.add(m);
      });
      crest.add(tuft);
      tufts.push(tuft);
    }
    const gem = new THREE.Mesh(shardGeo, crystalMat);
    gem.scale.set(0.07, 0.085, 0.07);
    gem.position.set(0, 1.3, 0.05);
    crest.add(gem);
    head.add(crest);

    // Wings
    const featherMat = (root: number, mid: number) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: FEATHER_VERT,
        fragmentShader: FEATHER_FRAG,
        side: THREE.DoubleSide,
        uniforms: {
          uRoot: { value: v3(root) },
          uMid: { value: v3(mid) },
          uEdge: { value: v3(P.featherEdge) },
          uTip: { value: v3(P.featherTip) },
          uTime: U.time,
          uGlow: U.glow,
        },
      });
      this._disposables.push(m);
      return m;
    };
    const primMat = featherMat(P.featherRoot, P.featherMid);
    const covMat = featherMat(P.covertRoot, P.covertMid);
    const wings = {} as LumoParts['wings'];
    const NP = 8,
      NC = 6;
    for (const side of [1, -1]) {
      // +1 = left (screen-left), -1 = right
      const wing = new THREE.Group();
      wing.name = side > 0 ? 'wingL' : 'wingR';
      wing.position.set(-side * 0.86, 0.16, -0.02);
      const primaries: THREE.Mesh[] = [],
        coverts: THREE.Mesh[] = [];
      for (let i = 0; i < NP; i++) {
        const L = 0.95 + 0.42 * Math.sin((Math.PI * (i + 0.6)) / NP);
        const g = featherGeometry(L, 0.135);
        this._disposables.push(g);
        const f = new THREE.Mesh(g, primMat);
        f.position.z = -i * 0.006;
        f.userData.i = i;
        wing.add(f);
        primaries.push(f);
      }
      for (let i = 0; i < NC; i++) {
        const L = 0.5 + 0.12 * Math.sin((Math.PI * (i + 0.5)) / NC);
        const g = featherGeometry(L, 0.16, 0.06);
        this._disposables.push(g);
        const f = new THREE.Mesh(g, covMat);
        f.position.z = 0.03 + i * 0.004;
        f.userData.i = i;
        wing.add(f);
        coverts.push(f);
      }
      rig.add(wing);
      wings[side > 0 ? 'left' : 'right'] = { group: wing, primaries, coverts, side };
    }

    // Tail
    const tail = new THREE.Group();
    tail.name = 'tail';
    tail.position.set(0, -0.78, -0.5);
    const tailFeathers: THREE.Mesh[] = [];
    for (let i = 0; i < 5; i++) {
      const L = 0.78 + 0.16 * Math.sin((Math.PI * (i + 0.5)) / 5);
      const g = featherGeometry(L, 0.12, 0.2);
      this._disposables.push(g);
      const f = new THREE.Mesh(g, primMat);
      f.position.z = -Math.abs(i - 2) * 0.01;
      tail.add(f);
      tailFeathers.push(f);
    }
    rig.add(tail);

    // Pulse ring (majestic burst)
    const pulse = new THREE.Sprite(spriteMat(P.spark, 0, tex.ring));
    pulse.position.set(0, 0.3, 0.2);
    pulse.visible = false;
    rig.add(pulse);

    // Ground glow
    const groundMat = new THREE.MeshBasicMaterial({
      map: tex.glow,
      color: rawColor(P.aura),
      transparent: true,
      opacity: 0.3,
      ...ADDITIVE,
      depthWrite: false,
    });
    const plane = new THREE.PlaneGeometry(1, 1);
    this._disposables.push(groundMat, plane);
    const ground = new THREE.Mesh(plane, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.85;
    ground.scale.set(3.6, 3.6, 1);
    this.add(ground);

    // Drifting motes of light
    const n = this.opts.particles;
    const pg = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3),
      seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU,
        r = 0.9 + Math.random() * 1.7;
      pos[i * 3] = Math.cos(a) * r * 1.2;
      pos[i * 3 + 1] = -1.9 + Math.random() * 4.4;
      pos[i * 3 + 2] = Math.sin(a) * r * 0.7 - 0.3;
      seed[i] = Math.random();
    }
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const pm = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      ...ADDITIVE,
      uniforms: {
        uTime: U.time,
        uSize: { value: 7 },
        uPR: { value: this.opts.pixelRatio },
        uA: { value: v3(P.spark) },
        uB: { value: v3(P.warm) },
        uOpacity: { value: 0.8 },
      },
    });
    const points = new THREE.Points(pg, pm);
    points.frustumCulled = false;
    points.name = 'particles';
    this.add(points);
    this._disposables.push(pg, pm);

    this.parts = {
      rig,
      body: bodyGroup,
      bodyMesh: body,
      head,
      eyes,
      beak: { group: beak, upper, jaw },
      crest: { group: crest, tufts, gem },
      wings,
      tail: { group: tail, feathers: tailFeathers },
      halo,
      aura: { cool: aura, warm },
      ground,
      particles: points,
      pulse,
    };
  }

  /** Switch to a named mood (see STATES). Unknown names are ignored. */
  setState(name: string) {
    if (!STATES[name]) return this;
    this._reactT = 0;
    this._apply(name);
    return this;
  }
  protected _apply(name: string) {
    const prev = this.state;
    this.state = name;
    Object.assign(this.targets, STATES[name]);
    if (name === 'majestic' && prev !== 'majestic') this.pulse();
    this.dispatchEvent({ type: 'statechange', state: name, previous: prev });
  }
  /** Play a mood for `seconds`, then return to the one before. */
  react(name: string, seconds = 1.6) {
    if (!STATES[name]) return this;
    if (this._reactT <= 0) this._reactPrev = this.state;
    this._apply(name);
    this._reactT = seconds;
    return this;
  }
  /** Override any rig target, e.g. set({ wingSpread: 0.6, glow: 1.2 }). Eased like everything else. */
  set(values: Partial<RigTargets>) {
    Object.assign(this.targets, values);
    return this;
  }
  /** Point the eyes and head. x, y in -1..1 (screen-like). Pass null to let Lumo wander. */
  gaze(x: number | null, y = 0) {
    this._gaze = x == null ? null : new THREE.Vector2(clamp(x, -1, 1), clamp(y, -1, 1));
    return this;
  }
  blink() {
    this._blinkT = 0;
    this._nextBlink = 2.2 + Math.random() * 4;
    return this;
  }
  pulse() {
    this._pulseT = 0;
    this.parts.pulse.visible = true;
    return this;
  }
  setPixelRatio(pr: number) {
    this.parts.particles.material.uniforms.uPR!.value = pr;
  }

  update(dt: number) {
    dt = Math.min(Math.max(dt, 0), 0.05);
    this.time += dt;
    const t = this.time,
      P = this.params,
      T = this.targets,
      parts = this.parts;
    const calm = this.opts.calm ? 0.4 : 1;

    for (const k in T) {
      const key = k as keyof RigTargets;
      const rate =
        k === 'lidTop' || k === 'lidBottom' ? 9 : k === 'flap' ? 3 : k === 'wingSpread' ? 2.6 : 3.6;
      P[key] = damp(P[key], T[key], rate, dt);
    }
    if (this._reactT > 0) {
      this._reactT -= dt;
      if (this._reactT <= 0) this._apply(this._reactPrev);
    }

    // blink
    this._nextBlink -= dt;
    if (this._nextBlink <= 0 && P.lidTop < 0.7) this.blink();
    let blinkAmt = 0;
    if (this._blinkT >= 0) {
      this._blinkT += dt;
      const b = this._blinkT / 0.17;
      if (b >= 1) this._blinkT = -1;
      else blinkAmt = Math.sin(b * Math.PI);
    }

    // gaze
    let lx: number, ly: number;
    if (this._gaze && P.gazeLock < 0.5) {
      lx = this._gaze.x;
      ly = this._gaze.y;
    } else {
      lx = Math.sin(t * 0.37) * 0.45 + Math.sin(t * 0.91) * 0.18;
      ly = Math.sin(t * 0.29 + 1.3) * 0.22;
    }
    lx = mix(lx, T.gazeX, P.gazeLock);
    ly = mix(ly, T.gazeY, P.gazeLock);
    this._look.x = damp(this._look.x, lx, 5, dt);
    this._look.y = damp(this._look.y, ly, 5, dt);
    const lk = this._look;

    // shared uniforms
    const talkWave = Math.max(0, Math.sin(t * 11) * 0.6 + Math.sin(t * 4.3) * 0.5 + Math.sin(t * 23) * 0.2);
    const mouth = this.speakLevel != null ? clamp(this.speakLevel, 0, 1) : Math.min(1, talkWave) * P.talk;
    this._u.time.value = t;
    this._u.glow.value = P.glow + mouth * 0.25;
    this._u.pulse.value = P.crest;
    this._u.dilate.value = P.dilate;

    // rig motion
    this._flapPhase += dt * (2.4 + P.flap * 7.5);
    const bounce = Math.abs(Math.sin(t * 5.5)) * 0.07 * Math.max(0, P.flap - 0.5) * 2;
    parts.rig.position.y = (Math.sin(t * 1.3 * P.breath) * 0.07 + bounce) * P.bob * calm + P.rise;
    parts.rig.rotation.x = P.lean + Math.sin(t * 0.8) * 0.02 * calm;
    parts.rig.rotation.z = Math.sin(t * 0.7) * 0.03 * calm;
    parts.rig.rotation.y = lk.x * 0.12;
    const br = Math.sin(t * 1.6 * P.breath) * 0.018;
    parts.body.scale.set(1 + br * 0.5, 1 + br, 1 + br * 0.5);

    // head & eyes
    parts.head.rotation.y = lk.x * 0.36;
    parts.head.rotation.x = -lk.y * 0.2;
    parts.head.rotation.z = P.tilt + Math.sin(t * 0.6) * 0.02 * calm;
    const top = clamp(P.lidTop + blinkAmt, 0, 1);
    for (const k of ['left', 'right'] as const) {
      const e = parts.eyes[k];
      e.ball.rotation.y = lk.x * 0.42;
      e.ball.rotation.x = -lk.y * 0.38;
      e.lidTop.rotation.x = mix(-0.85, 1.52, top);
      e.lidBottom.rotation.x = mix(0.78, -0.95, clamp(P.lidBottom + blinkAmt * 0.15, 0, 1));
      e.shine[0].visible = e.shine[1].visible = top < 0.82;
    }
    parts.beak.jaw.rotation.x = -mouth * 0.75;

    // crest
    parts.crest.tufts.forEach((tuft, i) => {
      tuft.children.forEach((m, j) => {
        m.scale.y = (m.userData.baseL as number) * (0.92 + 0.12 * P.crest + Math.sin(t * 2.2 + j + i) * 0.03);
      });
      tuft.rotation.z = (i ? -1 : 1) * (0.5 + Math.sin(t * 1.4 + i) * 0.04 * calm);
    });
    parts.crest.gem.rotation.y += dt * (0.6 + P.haloSpeed * 1.5);
    parts.crest.gem.position.y = 1.3 + Math.sin(t * 1.8) * 0.04 + P.crest * 0.06;

    // wings
    const flap = Math.sin(this._flapPhase) * P.flap * 0.28 * calm;
    for (const k of ['left', 'right'] as const) {
      const w = parts.wings[k],
        s = w.side,
        g = w.group;
      g.rotation.y = -s * (1.15 - P.wingSpread * 0.88);
      g.rotation.z = -s * (0.05 + P.wingSpread * 0.78 + flap);
      g.rotation.x = -0.05 + P.wingSpread * 0.08;
      const fan = 0.035 + P.wingSpread * 0.205;
      w.primaries.forEach((f, i) => {
        f.rotation.z = -s * (i * fan + Math.sin(t * 2 + i * 0.5) * 0.012 * calm);
      });
      w.coverts.forEach((f, i) => {
        f.rotation.z = -s * (0.05 + i * fan * 1.15);
      });
    }

    // tail
    parts.tail.group.rotation.x = 0.5 + P.lean * 0.5 + P.tailFan * 0.25;
    parts.tail.feathers.forEach((f, i) => {
      f.rotation.z = (i - 2) * (0.1 + P.tailFan * 0.22) + Math.sin(t * 1.7 + i) * 0.035 * calm;
    });

    // halo & light
    this._haloPhase += dt * P.haloSpeed * 1.5;
    parts.halo.rotation.z = this._haloPhase * 0.08;
    this._motes.rotation.z = this._haloPhase * 0.45;
    this._rings[0]!.material.uniforms.uPhase!.value = this._haloPhase * 2;
    this._rings[1]!.material.uniforms.uPhase!.value = this._haloPhase;
    this._rings[0]!.material.uniforms.uIntensity!.value = 0.25 + 0.6 * P.glow;
    this._rings[1]!.material.uniforms.uIntensity!.value = 0.2 + 0.55 * P.glow;
    this._motes.children.forEach((m, i) => {
      (m as THREE.Sprite).material.opacity = (0.35 + 0.5 * P.glow) * (0.6 + 0.4 * Math.sin(t * 2 + i * 1.7));
    });
    parts.aura.cool.material.opacity = 0.24 * P.glow;
    parts.aura.warm.material.opacity = 0.16 * P.glow;
    parts.aura.cool.scale.setScalar(6 * (1 + br * 2));
    parts.ground.material.opacity = 0.32 * P.glow * clamp(1 - P.rise * 1.2, 0.2, 1.2);
    parts.particles.material.uniforms.uOpacity!.value = 0.45 + 0.45 * P.glow;

    if (this._pulseT >= 0) {
      this._pulseT += dt;
      const k = this._pulseT / 1.3;
      const p = parts.pulse;
      if (k >= 1) {
        this._pulseT = -1;
        p.visible = false;
      } else {
        p.scale.setScalar(1 + k * 7);
        p.material.opacity = Math.pow(1 - k, 2) * 0.9;
      }
    }
  }

  override dispose() {
    this._disposables.forEach((d) => d.dispose && d.dispose());
    this._disposables.length = 0;
    this.removeFromParent();
  }
}
