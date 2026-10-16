/**
 * Lumo's companion instincts on the app side: small, local and instant (no model call).
 *
 * - reactionFor: a feeling about what the person just wrote, so his face answers before his words
 *   do (thanks → hearts, good news → a cheer, a joke → a giggle, a hard day → quiet concern).
 * - easterEggFor: hidden tricks that phrases unlock.
 * - lineFor: what he says in his speech bubble on the desktop, by moment and time of day.
 *
 * Pure functions (time and randomness are passed in), unit tested in test/companion.test.ts. Lines
 * are short and warm, never pushy; care nudges are rate limited by the caller.
 */
import type { Reaction } from '@lumo/mascot';

const has = (text: string, words: RegExp) => words.test(text);

const CONCERN =
  /\b(sad|lonely|anxious|anxiety|stress(ed|ful)?|overwhelm(ed|ing)?|exhausted|burn(ed|t)? ?out|depress(ed|ing)?|grief|griev\w*|cry(ing)?|hurt(s|ing)?|scared|afraid|awful day|bad day|rough day|can'?t sleep|panic\w*|miss (him|her|them)|broke up|passed away|died)\b/i;
const LOVE = /\b(thank(s| you)|ty|love (you|u|it|this)|you'?re (the best|amazing|awesome|great)|appreciate|so (sweet|cute|kind)|good (bot|boy|job lumo))\b|❤|♥|🥰|😍|💙/i;
const CHEER =
  /\b(yay|woo+|hooray|we did it|i did it|got the job|passed|promotion|engaged|it worked|finally|great news|good news|congrat\w*|celebrat\w*|nailed it|let'?s go+)\b|🎉|🥳/i;
const LAUGH = /\b(ha(ha)+|lol+|lmao|rofl|hehe+|that'?s (funny|hilarious))\b|😂|🤣|😆/i;

/** A feeling about the person's message, or null. Concern wins over everything else. */
export function reactionFor(text: string): Reaction | null {
  const t = text.trim();
  if (!t) return null;
  if (has(t, CONCERN)) return 'concern';
  if (has(t, CHEER) || /!{3,}/.test(t)) return 'cheer';
  if (has(t, LOVE)) return 'love';
  if (has(t, LAUGH)) return 'laugh';
  return null;
}

export type EasterEgg = 'barrel-roll' | 'party' | 'goodnight' | 'boop' | 'dance' | 'hello';

/** Hidden tricks. They only change what Lumo does on screen; the message is sent as usual. */
export function easterEggFor(text: string): EasterEgg | null {
  const t = text.trim().toLowerCase();
  if (/\b(do a )?barrel roll\b|\bdo a flip\b|\bbackflip\b/.test(t)) return 'barrel-roll';
  if (/\b(party time|let'?s party|🎉{2,})/.test(t)) return 'party';
  if (/\b(good ?night|nighty night|sweet dreams|time for bed)\b/.test(t) && /\blumo\b/.test(t)) return 'goodnight';
  if (/^boop\b/.test(t)) return 'boop';
  if (/\bdance\b/.test(t) && /\blumo\b/.test(t)) return 'dance';
  if (/^(hi|hey|hello|yo|hiya) lumo\b/.test(t)) return 'hello';
  return null;
}

/** Up up down down left right left right b a. */
export const KONAMI = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'b',
  'a',
];

/** Feed keys in; returns true when the sequence completes. */
export function konamiStep(progress: number, key: string): { progress: number; done: boolean } {
  const want = KONAMI[progress];
  if (key.toLowerCase() === want?.toLowerCase()) {
    const next = progress + 1;
    return next === KONAMI.length ? { progress: 0, done: true } : { progress: next, done: false };
  }
  return { progress: key === KONAMI[0] ? 1 : 0, done: false };
}

/** Lumo's birthday: the day he first shipped. */
export function isBirthday(d: Date) {
  return d.getMonth() === 9 && d.getDate() === 16;
}

export type Moment =
  | 'hello'
  | 'done'
  | 'failed'
  | 'approval'
  | 'question'
  | 'break'
  | 'late'
  | 'idle'
  | 'poke'
  | 'dizzy'
  | 'birthday'
  | 'working';

export function partOfDay(d: Date): 'morning' | 'afternoon' | 'evening' | 'night' {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}

const LINES: Record<Moment, (name: string, d: Date) => string[]> = {
  hello: (n, d) => {
    const part = partOfDay(d);
    const hi = n ? `, ${n}` : '';
    return part === 'night'
      ? [`Hi${hi}! Up late?`, `Hey${hi}. I'm here if you need me.`]
      : [`Good ${part}${hi}!`, `Hi${hi}! What are we doing today?`, `Hey${hi}, I'm right here.`];
  },
  done: (n) => ['All done!', `Finished${n ? `, ${n}` : ''}!`, 'Done. That was fun.', 'Ta-da!'],
  failed: () => ["Hmm, that didn't work.", 'Oops. Want me to try another way?', "That one tripped me up."],
  approval: () => ['I need your OK for this one.', 'Can you check this before I go on?'],
  question: () => ['Quick question for you!', 'I need a little help deciding.'],
  break: (n) => [
    `You've been at it a while${n ? `, ${n}` : ''}. Stretch with me?`,
    'Water break? I will guard the screen.',
    'Rest your eyes for a minute? Look at something far away.',
  ],
  late: () => ["It's getting late. Don't forget to rest.", 'Night owl mode? Remember to sleep soon.'],
  idle: () => ['*hums quietly*', 'Just floating around.', 'I like your desktop.', 'Boop me if you need anything.'],
  poke: () => ['Hehe!', 'Boop!', 'That tickles!', 'Hi!'],
  dizzy: () => ['Whoa... the room is spinning.', 'Okay okay, I am dizzy now.'],
  birthday: () => ["It's my birthday today!", 'Party time! I turned one today.'],
  working: () => ['On it!', 'Working on it...', 'Give me a moment.'],
};

/** A line for the moment. `pick` is 0..1 (pass a random number). */
export function lineFor(moment: Moment, name: string | null, now: Date, pick: number): string {
  const options = LINES[moment](name?.trim() ?? '', now);
  return options[Math.min(options.length - 1, Math.floor(pick * options.length))]!;
}

/** Whether to suggest a break: after 90 minutes of activity, at most once an hour. */
export function shouldSuggestBreak(activeMinutes: number, minutesSinceLastNudge: number) {
  return activeMinutes >= 90 && minutesSinceLastNudge >= 60;
}
