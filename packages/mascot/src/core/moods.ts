/**
 * Lumo's moods. Every mood is a complete set of pose targets the character eases toward each frame,
 * plus which effects it shows. Values are eased (or sprung), never snapped, so any mood can follow
 * any other.
 */

export interface Pose {
  /** Height above the resting spot, in body radii. 0 = standing on the ground. */
  hover: number;
  /** Wing effort, 0 (folded, landed) to ~1.4 (beating hard). */
  thrust: number;
  /** Idle float amplitude and speed multipliers. */
  bob: number;
  bobSpeed: number;
  /** Breathing amplitude. */
  breath: number;
  /** Head roll (radians, + = toward his left shoulder as seen by the viewer). */
  tilt: number;
  /** Pitch forward (+) or back (-), radians. */
  lean: number;
  /** Ears: 0 = drooped, 1 = perked straight up. */
  ears: number;
  /** Ears spread outward, radians. */
  earSplay: number;
  /** Eye openness, 0..1.15. */
  eyeOpen: number;
  /** 0 = round eyes, 1 = smiling arcs (^ ^). */
  eyeSmile: number;
  /** Pupil size multiplier. */
  pupil: number;
  /** Mouth curve: -1 worried, 0 flat, 1 big smile. */
  smile: number;
  /** Mouth open, 0..1. */
  mouth: number;
  /** Cheek blush, 0..1. */
  blush: number;
  /** Antenna star brightness, 0..1.5. */
  star: number;
  /** Both arms raised, 0 (down) .. 1 (up, cheering). */
  arms: number;
  /** Body squash (+) or stretch (-), small. */
  squash: number;
  /** Eyes held at gazeX/gazeY instead of following the pointer, 0..1. */
  gazeLock: number;
  gazeX: number;
  gazeY: number;
}

export type Effect =
  | 'dots' // thinking dots orbiting above the head
  | 'scan' // a scanning beam from the antenna star
  | 'panel' // a holographic keyboard in front of him
  | 'zzz' // sleeping Zs and a nose bubble
  | 'question' // a floating question mark
  | 'sparkles' // twinkling stars around him
  | 'hearts'; // little hearts floating up

export interface Mood {
  pose: Pose;
  effects: readonly Effect[];
  /** Arm layer: what the arms do on top of `arms`. */
  hands?: 'chin' | 'type' | 'wave' | 'hug' | 'shrug';
}

export const BASE_POSE: Pose = {
  hover: 0.28,
  thrust: 0.42,
  bob: 1,
  bobSpeed: 1,
  breath: 1,
  tilt: 0,
  lean: 0,
  ears: 0.62,
  earSplay: 0.18,
  eyeOpen: 1,
  eyeSmile: 0,
  pupil: 1,
  smile: 0.55,
  mouth: 0,
  blush: 0.45,
  star: 0.7,
  arms: 0.08,
  squash: 0,
  gazeLock: 0,
  gazeX: 0,
  gazeY: 0,
};

const mood = (pose: Partial<Pose>, effects: Effect[] = [], hands?: Mood['hands']): Mood => ({
  pose: { ...BASE_POSE, ...pose },
  effects,
  hands,
});

export const MOODS: Record<string, Mood> = {
  idle: mood({}),
  /** Attentive: ears perked, eyes wide on the person, a small head tilt. */
  listen: mood({ ears: 1, earSplay: 0.08, eyeOpen: 1.1, pupil: 1.15, tilt: 0.14, lean: 0.06, smile: 0.7 }),
  /** Thinking: eyes up and to the side, paw on chin, thought dots orbiting. */
  think: mood(
    {
      ears: 0.7,
      eyeOpen: 0.92,
      pupil: 0.9,
      tilt: 0.2,
      smile: 0.1,
      star: 1.1,
      gazeLock: 1,
      gazeX: -0.55,
      gazeY: 0.7,
    },
    ['dots'],
    'chin',
  ),
  /** Processing a request: dots spin fast, the star pulses. */
  process: mood(
    {
      ears: 0.8,
      eyeOpen: 0.95,
      pupil: 0.85,
      tilt: 0.08,
      smile: 0.3,
      star: 1.35,
      gazeLock: 1,
      gazeX: 0.2,
      gazeY: 0.6,
    },
    ['dots'],
  ),
  /** Searching: the star sweeps a beam while his eyes scan. */
  search: mood(
    { ears: 0.95, earSplay: 0.3, eyeOpen: 1.08, pupil: 0.85, smile: 0.35, star: 1.3, lean: 0.05 },
    ['scan'],
  ),
  /** Heads-down work at his holographic keyboard. */
  work: mood(
    {
      ears: 0.6,
      eyeOpen: 0.85,
      smile: 0.4,
      lean: 0.12,
      star: 1,
      arms: 0.2,
      gazeLock: 1,
      gazeX: 0.05,
      gazeY: -0.65,
    },
    ['panel'],
    'type',
  ),
  /** Typing: leaning in, tapping fast. */
  type: mood(
    {
      ears: 0.7,
      eyeOpen: 0.9,
      smile: 0.5,
      lean: 0.16,
      star: 1.05,
      arms: 0.22,
      gazeLock: 1,
      gazeX: 0,
      gazeY: -0.75,
    },
    ['panel'],
    'type',
  ),
  /** Talking: mouth follows the voice (or a natural rhythm). */
  speak: mood({ ears: 0.75, eyeOpen: 1.02, smile: 0.7, mouth: 0.15, tilt: 0.05, arms: 0.15 }),
  /** Unsure: one ear flops, worried little mouth, a question mark. */
  unsure: mood(
    { ears: 0.4, earSplay: 0.35, eyeOpen: 0.95, pupil: 1.1, tilt: 0.3, smile: -0.35, blush: 0.3, star: 0.5 },
    ['question'],
    'shrug',
  ),
  /** Delighted: smiling eyes, arms up, sparkles. */
  happy: mood(
    {
      hover: 0.42,
      thrust: 0.75,
      bob: 1.6,
      bobSpeed: 1.6,
      ears: 0.95,
      earSplay: 0.3,
      eyeSmile: 1,
      smile: 1,
      mouth: 0.35,
      blush: 0.9,
      star: 1.4,
      arms: 0.85,
      squash: 0.02,
    },
    ['sparkles'],
  ),
  /** Something went wrong: ears droop, a sad little face; then he shakes it off. */
  recover: mood({
    hover: 0.16,
    thrust: 0.22,
    bob: 0.5,
    ears: 0.12,
    earSplay: 0.4,
    eyeOpen: 0.78,
    pupil: 1.2,
    smile: -0.6,
    blush: 0.25,
    star: 0.35,
    tilt: -0.1,
    lean: 0.08,
  }),
  /** Hello: big smile and a wave. */
  greet: mood(
    {
      hover: 0.36,
      thrust: 0.6,
      bob: 1.3,
      ears: 1,
      earSplay: 0.2,
      eyeSmile: 0.85,
      smile: 1,
      mouth: 0.25,
      blush: 0.8,
      star: 1.2,
      tilt: -0.12,
    },
    ['sparkles'],
    'wave',
  ),
  /** Asleep: landed, wings folded, eyes closed, Zs and a nose bubble. */
  sleep: mood(
    {
      hover: 0,
      thrust: 0,
      bob: 0.25,
      bobSpeed: 0.5,
      breath: 1.8,
      ears: 0.05,
      earSplay: 0.5,
      eyeOpen: 0,
      smile: 0.25,
      blush: 0.55,
      star: 0.2,
      tilt: 0.22,
      lean: 0.12,
      arms: 0,
      gazeLock: 1,
      gazeY: -0.3,
    },
    ['zzz'],
  ),
  /** Warmth: hugging himself, hearts floating up. */
  love: mood(
    { hover: 0.34, thrust: 0.5, ears: 0.9, eyeSmile: 1, smile: 0.9, blush: 1.15, star: 1.1, tilt: 0.16 },
    ['hearts'],
    'hug',
  ),
  /** Gentle concern: soft eyes, ears lowered, close and quiet. */
  concern: mood({
    hover: 0.22,
    thrust: 0.3,
    bob: 0.6,
    bobSpeed: 0.7,
    ears: 0.3,
    earSplay: 0.3,
    eyeOpen: 0.95,
    pupil: 1.25,
    smile: -0.2,
    blush: 0.4,
    star: 0.6,
    tilt: 0.18,
    lean: 0.06,
  }),
};

export const MOOD_NAMES = Object.keys(MOODS);

export function moodOf(name: string): Mood {
  return MOODS[name] ?? MOODS.idle!;
}
