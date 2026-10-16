/** Lumo's companion reactions and hidden tricks, wired to the mascot in this window. */
import { useEffect } from 'react';
import { easterEggFor, isBirthday, konamiStep, reactionFor } from '../lib/companion';
import { chirp, mascotBus } from './mascot';

/** Called after the person sends a message: his face answers first, and phrases unlock tricks. */
export function reactToMessage(text: string) {
  const egg = easterEggFor(text);
  switch (egg) {
    case 'barrel-roll':
      mascotBus.act({ kind: 'celebrate' });
      chirp('whoosh');
      return;
    case 'party':
      party();
      return;
    case 'goodnight':
      chirp('yawn');
      mascotBus.send({ type: 'react', reaction: 'love' });
      return;
    case 'boop':
      mascotBus.act({ kind: 'boop' });
      chirp('giggle');
      return;
    case 'dance':
      mascotBus.act({ kind: 'spin' });
      setTimeout(() => mascotBus.act({ kind: 'spin' }), 900);
      chirp('happy');
      return;
    case 'hello':
      mascotBus.act({ kind: 'wave' });
      chirp('hello');
      return;
  }
  const reaction = reactionFor(text);
  if (reaction) mascotBus.send({ type: 'react', reaction });
  else chirp('boop');
}

/** Confetti, a backflip and a happy tune. */
export function party() {
  mascotBus.send({ type: 'react', reaction: 'cheer' });
  mascotBus.act({ kind: 'celebrate' });
  document.documentElement.setAttribute('data-party', '');
  setTimeout(() => document.documentElement.removeAttribute('data-party'), 4000);
  chirp('happy');
}

/** Hidden: the Konami code throws a party. On his birthday he throws one on his own. */
export function useHiddenTricks() {
  useEffect(() => {
    let progress = 0;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const r = konamiStep(progress, e.key);
      progress = r.progress;
      if (r.done) party();
    };
    window.addEventListener('keydown', onKey);
    let birthday: ReturnType<typeof setTimeout> | undefined;
    if (isBirthday(new Date())) birthday = setTimeout(party, 2500);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(birthday);
    };
  }, []);
}
