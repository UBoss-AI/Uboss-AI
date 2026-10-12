import { describe, expect, it } from 'vitest';

import { avatarTint } from './avatar-tint';

/**
 * The avatar colour.
 *
 * Only two things matter about it and neither is the colour itself: the same person must get the
 * same one every time, or it stops being a way to recognise them, and two different people should
 * usually get different ones, or it stops being worth drawing.
 */
describe('avatarTint', () => {
  it('gives one person the same colour every time', () => {
    expect(avatarTint('Aditi Sharma')).toBe(avatarTint('Aditi Sharma'));
  });

  it('returns a colour the browser understands', () => {
    expect(avatarTint('Rajiv Mehta')).toMatch(/^hsl\(\d{1,3} \d{1,3}% \d{1,3}%\)$/);
  });

  it('separates the names actually on the screen', () => {
    /*
     * These four sit in one conversation list locally. A hash on name length or first letter put
     * two of them on the same hue, which is the failure this guards: a palette that collides on
     * the real data is a palette that tells the reader nothing.
     */
    const people = ['Aditi Sharma', 'Aman Singh', 'Rajiv Mehta', 'Neha Verma'];
    expect(new Set(people.map(avatarTint)).size).toBe(people.length);
  });

  it('gives an unnamed participant a colour rather than throwing', () => {
    expect(avatarTint('')).toMatch(/^hsl\(/);
  });
});
