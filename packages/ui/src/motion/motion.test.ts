import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { DURATION, EASE, prefersReducedMotion, stagger, transition } from './motion';

// Resolved from the package root rather than `import.meta.url`: under the jsdom environment that
// is not a file URL, and the point of this file is to read the real stylesheet.
const tokensCss = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');

/** The value of a custom property as `tokens.css` declares it on `:root`. */
const cssToken = (name: string): string => {
  const match = tokensCss.match(new RegExp(`^\\s*--${name}:\\s*([^;]+);`, 'm'));
  if (match?.[1] === undefined) throw new Error(`--${name} is not declared in tokens.css`);
  return match[1].trim();
};

describe('the motion scale', () => {
  /*
   * The point of this file. Motion needs the durations as numbers and CSS needs them as tokens, so
   * the scale exists twice — and two copies of a number are two numbers until something checks.
   * Without this, a duration changed in one place shows up as a dropdown closing at a different
   * speed from the drawer beside it, which is the drift the tokens were introduced to stop.
   */
  it.each([
    ['micro', 'uboss-motion-micro'],
    ['small', 'uboss-motion-small'],
    ['panel', 'uboss-motion-panel'],
    ['large', 'uboss-motion-large'],
    ['signature', 'uboss-motion-signature'],
  ] as const)('%s matches its CSS token', (key, token) => {
    const ms = Number.parseFloat(cssToken(token).replace('ms', ''));
    expect(DURATION[key]).toBeCloseTo(ms / 1000, 5);
  });

  it.each([
    ['standard', 'uboss-ease-standard'],
    ['enter', 'uboss-ease-enter'],
    ['exit', 'uboss-ease-exit'],
    ['emphasized', 'uboss-ease-emphasized'],
  ] as const)('%s easing matches its CSS curve', (key, token) => {
    const numbers = [...cssToken(token).matchAll(/-?\d*\.?\d+/g)].map((m) => Number(m[0]));
    expect(numbers).toEqual([...EASE[key]]);
  });

  // The legacy names are aliases now. If one were given its own value the product would have two
  // scales again, which is the situation this replaced.
  it.each(['uboss-motion-fast', 'uboss-motion', 'uboss-motion-slow'])(
    '%s is an alias rather than a second scale',
    (token) => {
      expect(cssToken(token)).toMatch(/^var\(--uboss-motion-/);
    },
  );
});

describe('reduced motion', () => {
  const withMatchMedia = (matches: boolean) => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  };

  it('is false when the browser cannot be asked', () => {
    vi.unstubAllGlobals();
    // jsdom provides no matchMedia by default. Answering "false" is the safe direction: the
    // animation is defined normally and simply does not run before hydration.
    expect(prefersReducedMotion()).toBe(false);
  });

  it('collapses a transition to zero rather than removing it', () => {
    withMatchMedia(true);
    const reduced = transition('large', 'enter');

    // Duration goes, the curve stays: the end state has to be identical, only the travel
    // disappears. Dropping the transition entirely would change what the interface settles on.
    expect(reduced.duration).toBe(0);
    expect(reduced.ease).toEqual(EASE.enter);
    vi.unstubAllGlobals();
  });

  it('keeps the real duration when motion is welcome', () => {
    withMatchMedia(false);
    expect(transition('large').duration).toBe(DURATION.large);
    vi.unstubAllGlobals();
  });

  it('removes stagger entirely', () => {
    withMatchMedia(true);
    expect(stagger(7, 12)).toBe(0);
    vi.unstubAllGlobals();
  });
});

describe('stagger', () => {
  it('does not delay a single item', () => {
    expect(stagger(0, 1)).toBe(0);
  });

  it('spaces a short list at the full per-item delay', () => {
    expect(stagger(2, 5)).toBeCloseTo(0.08, 5);
  });

  /*
   * The cap is the point. Forty nodes at 40ms each would take 1.6s to finish appearing, which
   * stops being a reveal and becomes a wait — so the per-item delay shrinks as the list grows and
   * the whole sequence stays inside the signature budget.
   */
  it('keeps a long list inside the signature budget', () => {
    const count = 40;
    const last = stagger(count - 1, count);
    expect(last).toBeLessThanOrEqual(DURATION.signature);
    expect(last).toBeLessThan(stagger(count - 1, 4));
  });
});
