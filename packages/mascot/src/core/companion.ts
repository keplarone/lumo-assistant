/**
 * Product behaviors for Lumo, layered on the reference rig without changing its look.
 *
 * - New moods are presets of the same 18 rig targets the reference moods use.
 * - Scripted layers (typing taps, a one-wing wave, a celebration hop, an error shake-off, walking,
 *   turning) are applied AFTER the reference update() as small offsets on the same parts the rig
 *   already animates (wing groups, primaries, head, rig root, body scale). The base pose each frame
 *   is still exactly the reference's; layers only add to it and decay to zero.
 * - Lumo has no legs: walking is a short hop-glide with anticipation, wing-assisted hops and a
 *   settle; turning is an eased yaw of the whole group (its star-flecked back was designed to be
 *   seen).
 * - `calm` (prefers-reduced-motion) damps every layer's amplitude and skips hops and turns.
 */
import * as THREE from 'three';
import { Lumo, clamp, damp, registerMood, type LumoOptions } from './lumo';

export const PRODUCT_MOODS = {
  /** Attentive: eyes wide, crest lifted, looking at the person (with small acknowledging nods). */
  listen: {
    wingSpread: 0.08,
    flap: 0.1,
    lidTop: 0.02,
    lidBottom: 0,
    glow: 0.8,
    haloSpeed: 0.5,
    bob: 0.7,
    tilt: 0.1,
    crest: 0.85,
    tailFan: 0.2,
    dilate: 1.12,
    gazeLock: 1,
    gazeX: 0,
    gazeY: 0.05,
  },
  /** Processing a request: halo spins fast, eyes hold up-right with small reading saccades. */
  process: {
    wingSpread: 0.1,
    flap: 0.08,
    lidTop: 0.16,
    lidBottom: 0.1,
    glow: 0.95,
    haloSpeed: 2.4,
    bob: 0.55,
    tilt: 0.08,
    crest: 1.1,
    rise: 0.04,
    tailFan: 0.2,
    dilate: 0.8,
    gazeLock: 1,
    gazeX: 0.1,
    gazeY: 0.45,
  },
  /** Scanning: gaze sweeps side to side (driven by the companion). */
  search: {
    wingSpread: 0.1,
    flap: 0.12,
    lidTop: 0.06,
    glow: 0.9,
    haloSpeed: 1.2,
    bob: 0.7,
    crest: 0.95,
    tailFan: 0.25,
    dilate: 0.85,
  },
  /** Heads-down work: eyes lowered toward the workspace, reading. */
  work: {
    wingSpread: 0.08,
    flap: 0.12,
    lidTop: 0.28,
    lidBottom: 0.05,
    glow: 0.8,
    haloSpeed: 1.0,
    bob: 0.55,
    tilt: 0.06,
    crest: 0.8,
    tailFan: 0.15,
    dilate: 0.8,
    gazeLock: 1,
    gazeX: 0.15,
    gazeY: -0.55,
  },
  /** Typing / coding: head lowered over the workspace, leaning in; wing taps come from the companion. */
  type: {
    wingSpread: 0.06,
    flap: 0.05,
    lidTop: 0.3,
    lidBottom: 0.06,
    glow: 0.82,
    haloSpeed: 1.1,
    bob: 0.45,
    tilt: 0.04,
    crest: 0.8,
    lean: 0.07,
    tailFan: 0.12,
    dilate: 0.85,
    gazeLock: 1,
    gazeX: 0.1,
    gazeY: -0.75,
  },
  /** Unsure: soft tilt that slowly alternates with a small wing shrug, crest lowered. */
  unsure: {
    wingSpread: 0.1,
    flap: 0.05,
    lidTop: 0.18,
    lidBottom: 0.15,
    glow: 0.55,
    haloSpeed: 0.25,
    bob: 0.7,
    tilt: 0.28,
    crest: 0.3,
    tailFan: 0.08,
    dilate: 1.0,
  },
  /** Something failed: light dims and the crest droops, without alarm colors; then a shake-off. */
  recover: {
    wingSpread: 0.02,
    flap: 0.02,
    lidTop: 0.32,
    lidBottom: 0.1,
    glow: 0.35,
    haloSpeed: 0.12,
    bob: 0.4,
    tilt: -0.08,
    crest: 0.2,
    rise: -0.05,
    tailFan: 0.05,
    dilate: 1.1,
  },
  /** Hello: smiling eyes on the person; the one-wing wave is a companion layer. */
  greet: {
    wingSpread: 0.1,
    flap: 0.2,
    lidTop: 0,
    lidBottom: 0.35,
    glow: 1.0,
    haloSpeed: 0.8,
    bob: 1.1,
    tilt: -0.1,
    crest: 1.05,
    rise: 0.06,
    tailFan: 0.4,
    dilate: 1.1,
    gazeLock: 1,
    gazeX: 0,
    gazeY: 0.05,
  },
} as const;
for (const [k, v] of Object.entries(PRODUCT_MOODS)) registerMood(k, v);

export type ProductMood = keyof typeof PRODUCT_MOODS;
export type WingSide = 'left' | 'right';

const PI = Math.PI;
const smooth = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};
/** 0 -> 1 -> 0 over [a, d], flat at 1 between b and c. */
const plateau = (t: number, a: number, b: number, c: number, d: number) =>
  t <= a || t >= d ? 0 : t < b ? smooth((t - a) / (b - a)) : t <= c ? 1 : 1 - smooth((t - c) / (d - c));
const easeInOutSine = (u: number) => 0.5 - 0.5 * Math.cos(PI * clamp(u, 0, 1));
const easeInOutCubic = (u: number) => {
  const x = clamp(u, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Per-wing additive offsets, reset every frame. Positive lift raises the wing outward. */
interface WingOffset {
  lift: number;
  open: number;
  pitch: number;
  fan: number;
}
const zeroWing = (): WingOffset => ({ lift: 0, open: 0, pitch: 0, fan: 0 });

interface Walk {
  from: number;
  to: number;
  phase: 'anticipate' | 'travel' | 'settle';
  t: number;
  dur: number;
  hops: number;
}
interface Turn {
  from: number;
  to: number;
  t: number;
  dur: number;
}

export class LumoCompanion extends Lumo {
  /** Extra yaw from the user dragging the character; springs back to 0. */
  dragYaw = 0;
  /** Probability that a natural blink is followed by a second one. */
  doubleBlinkChance = 0.16;

  private _x = 0;
  private _walkTarget = 0;
  private _walk: Walk | null = null;
  private _travelYaw = 0;
  private _yaw = 0;
  private _yawTarget = 0;
  private _turn: Turn | null = null;
  private _scriptedGaze = false;
  private _stateT = 0;
  private _doubleIn = -1;
  // typing rhythm
  private _typeW = 0;
  private _tapT = -1;
  private _tapSide: WingSide = 'left';
  private _tapWait = 0.3;
  private _burst = 0;
  // one-shots
  private _waveT = -1;
  private _waveSide: WingSide = 'right';
  private _celebrateT = -1;
  private _recoverT = -1;
  private _shrugT = -1;
  private _lastTiltSign = 1;
  private _nodT = -1;
  private _nodWait = 2.5;
  private _saccadeWait = 0.6;
  private _wing: Record<WingSide, WingOffset> = { left: zeroWing(), right: zeroWing() };

  constructor(opts: Partial<LumoOptions> = {}) {
    super(opts);
  }

  // ---- public API ---------------------------------------------------------------------------

  /** Hop-glide to x (scene units), with anticipation and a settle at the end. */
  walkTo(x: number) {
    if (Math.abs(x - this._walkTarget) < 1e-3 && this._walk) return this;
    this._walkTarget = x;
    const dist = Math.abs(x - this._x);
    if (dist < 0.02) {
      this._walk = null;
      return this;
    }
    const moving = this._walk?.phase === 'travel';
    this._walk = {
      from: this._x,
      to: x,
      phase: moving ? 'travel' : 'anticipate',
      t: 0,
      dur: clamp(dist / 1.4, 0.55, 2.6),
      hops: Math.max(1, Math.round(dist / 0.5)),
    };
    return this;
  }
  get walkTarget() {
    return this._walkTarget;
  }
  get x() {
    return this._x;
  }
  get isWalking() {
    return this._walk != null;
  }

  /** Turn to a yaw angle (radians, 0 = facing the viewer). Skipped in calm mode. */
  turnTo(yaw: number) {
    if (this.opts.calm || Math.abs(yaw - this._yawTarget) < 1e-3) return this;
    this._yawTarget = yaw;
    const span = Math.abs(yaw - this._yaw);
    this._turn = { from: this._yaw, to: yaw, t: 0, dur: clamp(0.35 + span * 0.2, 0.45, 1.0) };
    return this;
  }
  /** Face away (showing the back), or back toward the viewer. */
  turnAround() {
    return this.turnTo(Math.abs(this._yawTarget) < 0.5 ? PI : 0);
  }
  get yawTarget() {
    return this._yawTarget;
  }
  get yaw() {
    return this._yaw;
  }

  /** One-wing wave. `side` is the screen side of the waving wing. Plays automatically on greet. */
  wave(side: WingSide = 'right') {
    this._waveT = 0;
    this._waveSide = side;
    return this;
  }

  /** Celebrate: a light pulse, a small hop and one brief wing flourish, then settle. */
  celebrate() {
    this.pulse();
    this._celebrateT = 0;
    return this;
  }

  /** Natural blink scheduling (and occasional double blinks) on top of the reference blink. */
  override blink() {
    super.blink();
    // Human-like intervals: a floor plus an exponential tail, quicker while typing or concentrating.
    const quick = this.state === 'type' || this.state === 'work';
    const floor = quick ? 1.1 : 1.8,
      mean = quick ? 1.4 : 2.8;
    this._nextBlink = Math.min(floor + -Math.log(1 - Math.random() * 0.98) * mean, quick ? 5 : 9);
    if (this._doubleIn < 0 && Math.random() < this.doubleBlinkChance * (quick ? 1.5 : 1))
      this._doubleIn = rand(0.2, 0.32);
    return this;
  }

  // ---- internals ------------------------------------------------------------------------------

  protected override _apply(name: string) {
    const prev = this.state;
    super._apply(name);
    if (name === prev) return;
    this._stateT = 0;
    if (name === 'greet') this.wave('right');
    if (name === 'recover') this._recoverT = 0;
    if (name === 'listen') {
      this._nodT = -1;
      this._nodWait = rand(1.2, 2.4);
    }
  }

  override update(dt: number) {
    dt = Math.min(Math.max(dt, 0), 0.05);
    const calm = this.opts.calm ? 0.4 : 1;
    const t = this.time + dt;
    this._stateT += dt;

    this._preTargets(t, dt);

    // Double blink: a second quick blink right after the first one ends.
    if (this._doubleIn >= 0) {
      this._doubleIn -= dt;
      if (this._doubleIn < 0 && this._blinkT < 0 && this.params.lidTop < 0.7) this._blinkT = 0;
    }

    super.update(dt);

    const parts = this.parts;
    this._wing.left = zeroWing();
    this._wing.right = zeroWing();
    let rigY = 0,
      rigZ = 0,
      rigX = 0,
      headX = 0,
      headY = 0,
      squash = 0;

    // Typing: alternating small wing taps in bursts, head lowered toward the workspace.
    this._typeW = damp(this._typeW, this.state === 'type' ? 1 : 0, 4, dt);
    if (this._typeW > 0.01) {
      if (this._tapT >= 0) {
        this._tapT += dt;
        if (this._tapT > 0.14) this._tapT = -1;
      }
      this._tapWait -= dt;
      if (this._tapWait <= 0 && this.state === 'type') {
        this._tapT = 0;
        if (Math.random() > 0.2) this._tapSide = this._tapSide === 'left' ? 'right' : 'left';
        if (this._burst <= 0) this._burst = Math.floor(rand(3, 10));
        this._burst--;
        this._tapWait = this._burst > 0 ? rand(0.12, 0.21) : rand(0.4, 1.4);
      }
      const w = this._typeW;
      if (this._tapT >= 0) {
        const u = this._tapT / 0.14;
        const e = (u < 0.3 ? smooth(u / 0.3) : 1 - smooth((u - 0.3) / 0.7)) * w * calm;
        const o = this._wing[this._tapSide];
        o.lift -= 0.07 * e;
        o.pitch -= 0.16 * e;
        o.open += 0.1 * e;
        headX += 0.015 * e;
      }
      headX += 0.08 * w; // head lowered a little further than the gaze alone gives
      for (const s of ['left', 'right'] as const) this._wing[s].open += 0.12 * w; // wings slightly forward, "at the keys"
    }

    // Greeting: one-wing wave (raise, three waves, lower).
    if (this._waveT >= 0) {
      this._waveT += dt;
      const D = calm < 1 ? 1.3 : 1.7;
      const tt = this._waveT;
      if (tt >= D) this._waveT = -1;
      else {
        const env = plateau(tt, 0, 0.35, D - 0.4, D);
        const osc = Math.sin(Math.max(0, tt - 0.3) * 2 * PI * 2.4) * smooth((tt - 0.25) / 0.2);
        const o = this._wing[this._waveSide];
        o.lift += env * (1.7 * (calm < 1 ? 0.6 : 1)) + env * osc * 0.24 * calm;
        o.open += env * 0.8;
        o.fan += env * 0.05;
        o.pitch -= env * 0.12;
        rigZ += (this._waveSide === 'right' ? 1 : -1) * 0.035 * env * calm; // lean away from the raised wing
      }
    }

    // Celebration: anticipation dip, small hop with a wing flourish, settle.
    if (this._celebrateT >= 0) {
      this._celebrateT += dt;
      const c = this._celebrateT;
      if (c >= 1.1) this._celebrateT = -1;
      else {
        const hop = this.opts.calm ? 0 : 1;
        const dip = -0.05 * plateau(c, 0, 0.1, 0.12, 0.2) - 0.035 * plateau(c, 0.58, 0.66, 0.68, 0.9);
        const air = c > 0.16 && c < 0.6 ? Math.sin((PI * (c - 0.16)) / 0.44) : 0;
        rigY += (dip + 0.16 * air) * hop;
        squash +=
          (-0.03 * plateau(c, 0, 0.1, 0.12, 0.22) + 0.02 * air - 0.025 * plateau(c, 0.58, 0.64, 0.66, 0.85)) *
          hop;
        const fl = plateau(c, 0.1, 0.36, 0.42, 0.95) * calm;
        for (const s of ['left', 'right'] as const) {
          const o = this._wing[s];
          o.lift += 0.6 * fl;
          o.open += 0.5 * fl;
          o.fan += 0.035 * fl;
        }
      }
    }

    // Error recovery: droop, then a short shake-off and the light comes back.
    if (this._recoverT >= 0) {
      this._recoverT += dt;
      const r = this._recoverT;
      if (this.state !== 'recover' && r > 2.3) this._recoverT = -1;
      const droop = plateau(r, 0, 0.5, 1.2, 1.5);
      headX += 0.1 * droop;
      for (const s of ['left', 'right'] as const) this._wing[s].lift -= 0.04 * droop;
      if (r > 1.25 && r < 2.0) {
        const u = (r - 1.25) / 0.75;
        const decay = Math.sin(PI * u) * (1 - u * 0.5);
        const shake = Math.sin(u * 2 * PI * 3.5) * decay * calm * (calm < 1 ? 0.5 : 1);
        headY += 0.17 * shake;
        rigZ += 0.03 * shake;
        squash += 0.03 * decay * calm; // feathers fluff up
        for (const s of ['left', 'right'] as const) this._wing[s].lift += 0.09 * Math.abs(shake);
      }
      if (r >= 1.9 && r - dt < 1.9 && this.state === 'recover') {
        // Shaken off: the light and crest come back up while the mood plays out.
        this.set({ glow: 0.62, crest: 0.5, lidTop: 0.12, tilt: 0, rise: 0, flap: 0.12, wingSpread: 0.05 });
      }
    }

    // Uncertain: a small wing shrug each time the head tilt changes side.
    if (this._shrugT >= 0) {
      this._shrugT += dt;
      const e = plateau(this._shrugT, 0, 0.18, 0.3, 0.7) * calm;
      if (this._shrugT > 0.7) this._shrugT = -1;
      for (const s of ['left', 'right'] as const) {
        this._wing[s].lift += 0.1 * e;
        this._wing[s].open += 0.06 * e;
      }
      rigY += 0.015 * e;
    }

    // Listening: a slight acknowledging nod now and then.
    if (this.state === 'listen') {
      this._nodWait -= dt;
      if (this._nodWait <= 0 && this._nodT < 0) {
        this._nodT = 0;
        this._nodWait = rand(2.4, 5);
      }
    }
    if (this._nodT >= 0) {
      this._nodT += dt;
      headX += 0.07 * Math.sin(PI * clamp(this._nodT / 0.45, 0, 1)) * calm;
      if (this._nodT > 0.45) this._nodT = -1;
    }

    // Locomotion and turning.
    const loco = this._locomotion(dt, calm);
    rigY += loco.rigY;
    rigZ += loco.rigZ;
    rigX += loco.rigX;
    squash += loco.squash;

    // Apply layers on top of the reference pose.
    parts.rig.position.y += rigY;
    parts.rig.rotation.z += rigZ;
    parts.rig.rotation.x += rigX;
    parts.head.rotation.x += headX;
    parts.head.rotation.y += headY;
    if (squash !== 0) {
      parts.body.scale.y *= 1 + squash;
      parts.body.scale.x *= 1 - squash * 0.5;
      parts.body.scale.z *= 1 - squash * 0.5;
    }
    for (const k of ['left', 'right'] as const) {
      const o = this._wing[k];
      if (!o.lift && !o.open && !o.pitch && !o.fan) continue;
      const w = parts.wings[k],
        s = w.side,
        g = w.group;
      g.rotation.z += -s * o.lift;
      g.rotation.y += s * o.open;
      g.rotation.x += o.pitch;
      if (o.fan)
        w.primaries.forEach((f, i) => {
          f.rotation.z += -s * i * o.fan;
        });
    }
  }

  /** Mood-specific target scripting, before the reference update eases toward targets. */
  private _preTargets(t: number, dt: number) {
    const T = this.targets;
    if (this.state === 'search') {
      this._gaze = new THREE.Vector2(Math.sin(t * 1.25) * 0.8, 0.1 + Math.sin(t * 0.6) * 0.15);
      this._scriptedGaze = true;
    } else if (this._scriptedGaze) {
      this._gaze = null;
      this._scriptedGaze = false;
    }
    if (this.state === 'unsure') {
      const sign = Math.sign(Math.sin(t * 0.55)) || 1;
      T.tilt = 0.26 * sign;
      if (sign !== this._lastTiltSign) {
        this._lastTiltSign = sign;
        this._shrugT = 0;
      }
    }
    if (this.state === 'process') {
      // Reading saccades: small hops of the eyes around the held point.
      this._saccadeWait -= dt;
      if (this._saccadeWait <= 0) {
        this._saccadeWait = rand(0.35, 0.9);
        T.gazeX = 0.1 + rand(-0.14, 0.14);
        T.gazeY = 0.45 + rand(-0.06, 0.06);
      }
    }
    if (this.state === 'type') {
      // Eyes follow the line being written.
      T.gazeX = 0.1 + Math.sin(t * 1.7) * 0.12 + Math.sin(t * 0.43) * 0.06;
    }
  }

  private _locomotion(dt: number, calm: number) {
    const out = { rigY: 0, rigZ: 0, rigX: 0, squash: 0 };
    const hopOK = !this.opts.calm;
    const walk = this._walk;
    let travelYawTarget = 0;
    if (walk) {
      walk.t += dt;
      const dir = Math.sign(walk.to - walk.from) || 1;
      if (walk.phase === 'anticipate') {
        const A = 0.2;
        const e = smooth(walk.t / A);
        out.rigY -= 0.05 * e * calm;
        out.squash -= 0.03 * e * calm;
        out.rigZ -= dir * 0.04 * e * calm;
        for (const s of ['left', 'right'] as const) this._wing[s].lift += 0.12 * e * calm;
        travelYawTarget = hopOK ? dir * 0.45 : 0;
        if (walk.t >= A) {
          walk.phase = 'travel';
          walk.t = 0;
        }
      } else if (walk.phase === 'travel') {
        const u = clamp(walk.t / walk.dur, 0, 1);
        this._x = walk.from + (walk.to - walk.from) * easeInOutSine(u);
        // Speed profile peaks mid-travel; lean and assist scale with it.
        const sp = Math.sin(PI * u);
        out.rigZ -= dir * (hopOK ? 0.09 : 0.03) * (0.4 + 0.6 * sp);
        out.rigX += 0.04 * sp * calm;
        if (hopOK) {
          const hu = (u * walk.hops) % 1;
          const arc = Math.sin(PI * hu);
          out.rigY += 0.11 * arc * (u < 1 ? 1 : 0);
          out.squash += 0.02 * arc - 0.02 * (1 - arc) * sp;
          for (const s of ['left', 'right'] as const) {
            this._wing[s].lift += (0.12 + 0.22 * Math.sin(PI * Math.min(1, hu * 1.6))) * sp;
            this._wing[s].open += 0.12 * sp;
          }
        }
        travelYawTarget = hopOK ? dir * 0.45 : 0;
        if (u >= 1) {
          walk.phase = 'settle';
          walk.t = 0;
          this._x = walk.to;
        }
      } else {
        const S = 0.45;
        const u = walk.t / S;
        const dip = Math.sin(PI * clamp(u * 1.4, 0, 1)) * (1 - u * 0.6);
        out.rigY -= 0.04 * dip * calm;
        out.squash -= 0.028 * dip * calm;
        out.rigZ += dir * 0.025 * Math.sin(PI * clamp(u * 1.8, 0, 1)) * calm; // small overshoot back
        if (walk.t >= S) this._walk = null;
      }
    }
    this.position.x = this._x;

    // Turning: eased tween with a small lift at mid-turn.
    const turn = this._turn;
    if (turn) {
      turn.t += dt;
      const u = clamp(turn.t / turn.dur, 0, 1);
      this._yaw = turn.from + (turn.to - turn.from) * easeInOutCubic(u);
      const mid = Math.sin(PI * u);
      out.rigY += 0.05 * mid;
      for (const s of ['left', 'right'] as const) this._wing[s].lift += 0.1 * mid;
      if (u >= 1) {
        this._yaw = turn.to;
        this._turn = null;
      }
    }
    this._travelYaw = damp(this._travelYaw, travelYawTarget, 6, dt);
    this.dragYaw = damp(this.dragYaw, 0, 0.9, dt);
    this.rotation.y = this._yaw + this._travelYaw + this.dragYaw;
    return out;
  }

  /** True while a scripted layer is playing (walking, turning, a one-shot, a pulse ring). */
  get busy() {
    return (
      this._walk != null ||
      this._turn != null ||
      this._waveT >= 0 ||
      this._celebrateT >= 0 ||
      (this._recoverT >= 0 && this._recoverT < 2.1) ||
      this._pulseT >= 0 ||
      Math.abs(this.dragYaw) > 0.01
    );
  }

  /**
   * Free every GPU resource without detaching or forgetting them. Safe to call repeatedly (React
   * StrictMode runs effect cleanups twice): three.js re-uploads a disposed geometry, material or
   * texture if it is rendered again.
   */
  releaseGpu() {
    for (const d of this._disposables) d.dispose();
    // Sprites share one module-level geometry in three.js that nothing ever disposes; release its
    // GPU buffers too so the renderer's memory returns to zero (three re-uploads it if reused).
    this.parts?.pulse.geometry.dispose();
  }

  override dispose() {
    this.releaseGpu();
    super.dispose();
  }
}
