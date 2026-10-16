import { describe, expect, it } from 'vitest';
import {
  easterEggFor,
  isBirthday,
  KONAMI,
  konamiStep,
  lineFor,
  partOfDay,
  reactionFor,
  shouldSuggestBreak,
} from '../src/lib/companion';

describe('reactionFor', () => {
  it('reads the feeling of a message', () => {
    expect(reactionFor('thank you so much!')).toBe('love');
    expect(reactionFor('I got the job')).toBe('cheer');
    expect(reactionFor('haha that is great')).toBe('laugh');
    expect(reactionFor('Sort my Downloads folder')).toBeNull();
    expect(reactionFor('   ')).toBeNull();
  });
  it('puts concern first, even with thanks in the same message', () => {
    expect(reactionFor('thanks, I just feel so lonely today')).toBe('concern');
    expect(reactionFor('rough day lol')).toBe('concern');
  });
});

describe('easterEggFor', () => {
  it('finds the hidden tricks', () => {
    expect(easterEggFor('do a barrel roll')).toBe('barrel-roll');
    expect(easterEggFor('Party time!')).toBe('party');
    expect(easterEggFor('goodnight lumo')).toBe('goodnight');
    expect(easterEggFor('boop')).toBe('boop');
    expect(easterEggFor('hey Lumo, what is up')).toBe('hello');
  });
  it('leaves ordinary messages alone', () => {
    expect(easterEggFor('good night, see you tomorrow')).toBeNull();
    expect(easterEggFor('write a function that rolls dice')).toBeNull();
  });
});

describe('konamiStep', () => {
  it('completes on the full sequence and restarts on a wrong key', () => {
    let p = 0;
    let done = false;
    for (const k of KONAMI) ({ progress: p, done } = konamiStep(p, k));
    expect(done).toBe(true);
    expect(konamiStep(3, 'x')).toEqual({ progress: 0, done: false });
    expect(konamiStep(3, KONAMI[0]!)).toEqual({ progress: 1, done: false });
  });
});

describe('time and care', () => {
  it('knows his birthday and the part of the day', () => {
    expect(isBirthday(new Date(2026, 9, 16))).toBe(true);
    expect(isBirthday(new Date(2026, 9, 17))).toBe(false);
    expect(partOfDay(new Date(2026, 0, 1, 8))).toBe('morning');
    expect(partOfDay(new Date(2026, 0, 1, 23))).toBe('night');
  });
  it('says something short for every pick', () => {
    for (const pick of [0, 0.5, 0.999999]) {
      const line = lineFor('hello', 'Ada', new Date(2026, 0, 1, 9), pick);
      expect(line.length).toBeGreaterThan(0);
      expect(line.length).toBeLessThan(80);
    }
  });
  it('suggests a break only after a long stretch, and not too often', () => {
    expect(shouldSuggestBreak(30, Infinity)).toBe(false);
    expect(shouldSuggestBreak(120, Infinity)).toBe(true);
    expect(shouldSuggestBreak(120, 10)).toBe(false);
  });
});
