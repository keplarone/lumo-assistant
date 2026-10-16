/**
 * Product behaviors for Lumo, layered on the reference rig without changing its look.
 *
 * - New moods are presets of the same 18 rig targets the reference moods use.
 * - Scripted gaze (a sweeping "search" look, a gentle uncertain head tilt) writes the same gaze and
 *   tilt channels the rig already eases.
 * - Locomotion moves the whole character: Lumo has no legs, so "walking" is a short hop-glide with
 *   a little wing assist, and turning is an eased yaw of the group (its star-flecked back was
 *   designed to be seen).
 */
import * as THREE from 'three';
import { Lumo, clamp, damp, registerMood, type LumoOptions } from './lumo';

export const PRODUCT_MOODS = {
  /** Attentive: eyes wide, crest lifted, looking at the person. */
  listen: { wingSpread: 0.08, flap: 0.1, lidTop: 0.02, lidBottom: 0, glow: 0.8, haloSpeed: 0.5, bob: 0.7, tilt: 0.1, crest: 0.85, tailFan: 0.2, dilate: 1.12, gazeLock: 1, gazeX: 0, gazeY: 0.05 },
  /** Busy thinking: like think, but the halo spins faster and the gaze holds steady. */
  process: { wingSpread: 0.1, flap: 0.08, lidTop: 0.16, lidBottom: 0.1, glow: 0.95, haloSpeed: 2.4, bob: 0.55, tilt: 0.08, crest: 1.1, rise: 0.04, tailFan: 0.2, dilate: 0.8, gazeLock: 1, gazeX: 0.1, gazeY: 0.45 },
  /** Scanning: gaze sweeps side to side (driven by the companion). */
  search: { wingSpread: 0.1, flap: 0.12, lidTop: 0.06, glow: 0.9, haloSpeed: 1.2, bob: 0.7, crest: 0.95, tailFan: 0.25, dilate: 0.85 },
  /** Heads-down work: eyes lowered toward the workspace. */
  work: { wingSpread: 0.08, flap: 0.12, lidTop: 0.28, lidBottom: 0.05, glow: 0.8, haloSpeed: 1.0, bob: 0.55, tilt: 0.06, crest: 0.8, tailFan: 0.15, dilate: 0.8, gazeLock: 1, gazeX: 0.15, gazeY: -0.55 },
  /** Unsure: soft tilt that slowly alternates, crest lowered. */
  unsure: { wingSpread: 0.1, flap: 0.05, lidTop: 0.18, lidBottom: 0.15, glow: 0.55, haloSpeed: 0.25, bob: 0.7, tilt: 0.28, crest: 0.3, tailFan: 0.08, dilate: 1.0 },
  /** Something failed: light dims and the crest droops, without alarm colors. */
  recover: { wingSpread: 0.02, flap: 0.02, lidTop: 0.32, lidBottom: 0.1, glow: 0.35, haloSpeed: 0.12, bob: 0.4, tilt: -0.08, crest: 0.2, rise: -0.05, tailFan: 0.05, dilate: 1.1 },
  /** Hello: a friendly half-spread wing wave. */
  greet: { wingSpread: 0.55, flap: 0.8, lidTop: 0, lidBottom: 0.35, glow: 1.1, haloSpeed: 0.8, bob: 1.2, tilt: -0.1, crest: 1.1, rise: 0.1, tailFan: 0.5, dilate: 1.1 },
} as const;
for (const [k, v] of Object.entries(PRODUCT_MOODS)) registerMood(k, v);

export type ProductMood = keyof typeof PRODUCT_MOODS;

export class LumoCompanion extends Lumo {
  /** Horizontal position the character glides to (scene units). */
  walkTarget = 0;
  /** Yaw the character turns to (radians, 0 = facing the viewer). */
  yawTarget = 0;
  /** Extra yaw from the user dragging the character; springs back to 0. */
  dragYaw = 0;
  private _x = 0;
  private _yaw = 0;
  private _hop = 0;
  private _scriptedGaze = false;

  constructor(opts: Partial<LumoOptions> = {}) {
    super(opts);
  }

  /** Glide to x (scene units). */
  walkTo(x: number) { this.walkTarget = x; return this; }
  /** Turn to a yaw angle. turnAround() faces away; turnTo(0) faces the viewer. */
  turnTo(yaw: number) { this.yawTarget = yaw; return this; }
  turnAround() { return this.turnTo(this.yawTarget === 0 ? Math.PI : 0); }
  get isWalking() { return Math.abs(this.walkTarget - this._x) > 0.02; }

  override update(dt: number) {
    dt = Math.min(Math.max(dt, 0), 0.05);
    const calm = this.opts.calm ? 0.4 : 1;
    const t = this.time + dt;

    // Scripted gaze and tilt layers for the product moods.
    if (this.state === 'search') {
      this._gaze = new THREE.Vector2(Math.sin(t * 1.25) * 0.8, 0.1 + Math.sin(t * 0.6) * 0.15);
      this._scriptedGaze = true;
    } else if (this._scriptedGaze) {
      this._gaze = null;
      this._scriptedGaze = false;
    }
    if (this.state === 'unsure') {
      this.targets.tilt = 0.26 * Math.sign(Math.sin(t * 0.55)) || 0.26;
    }

    super.update(dt);

    // Locomotion: hop-glide toward walkTarget.
    const before = this._x;
    this._x = damp(this._x, this.walkTarget, 2.2, dt);
    const speed = dt > 0 ? (this._x - before) / dt : 0;
    const moving = clamp(Math.abs(speed) / 1.2, 0, 1);
    this._hop += dt * 9 * moving;
    this.position.x = this._x;
    const hop = Math.abs(Math.sin(this._hop)) * 0.12 * moving * calm;
    this.parts.rig.position.y += hop;
    this.parts.rig.rotation.z += -Math.sign(speed) * 0.12 * moving;
    if (moving > 0.05) this.params.flap = Math.max(this.params.flap, 0.5 * moving);

    // Turning: eased yaw plus any drag offset.
    this._yaw = damp(this._yaw, this.yawTarget, 3, dt);
    this.dragYaw = damp(this.dragYaw, 0, 0.9, dt);
    this.rotation.y = this._yaw + this.dragYaw;
  }
}
