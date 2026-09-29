import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Every `backwards` fill must be switched off, not merely shortened, under reduced motion.
 *
 * The global rule in base.css collapses every duration to 0.01ms, which is the right default for
 * a transition. It is not sufficient for an entrance animation with a `backwards` fill: that fill
 * paints the opening frame from the moment the element exists until the animation's *first tick*,
 * and a zero-length animation that has not ticked yet still shows `opacity: 0`. The sign-in card
 * measured blank for 570ms under load — for the one person who explicitly asked for less motion.
 *
 * So each selector carrying a backwards fill has to appear in a `prefers-reduced-motion` block
 * with `animation: none`. This is checked rather than remembered because the two declarations are
 * hundreds of lines apart, and the failure is invisible unless you happen to be testing with the
 * preference on.
 */
const stylesDir = resolve(process.cwd(), 'src/styles');
const sheets = readdirSync(stylesDir)
  .filter((name) => name.endsWith('.css'))
  .map((name) => ({ name, css: readFileSync(resolve(stylesDir, name), 'utf8') }));

/**
 * Selectors declaring an `animation` with a backwards fill, and selectors turned off for reduced
 * motion.
 *
 * Selector lists span several lines in this stylesheet, so they are accumulated until the line
 * that opens the block. The first version of this read only the last line before the brace, which
 * made it report four selectors as unsilenced when they were listed directly above the one it did
 * see — a parser bug that looked exactly like a real finding.
 */
const collect = (css: string) => {
  const stripped = css.replace(/\/[*][\s\S]*?[*]\//g, '');
  const backwards = new Set<string>();
  const silenced = new Set<string>();
  let depth = 0;
  let reducedFrom: number | null = null;
  let pending = '';
  let selector = '';
  let inDeclaration = false;

  for (const line of stripped.split('\n')) {
    const text = line.trim();

    /*
     * A declaration can span lines — prettier wraps any long `calc()` — and its continuation
     * lines look exactly like selector fragments. Without this the parser read
     * `min(var(--uboss-row,` as a selector and reported it as an unsilenced animation, which is
     * the second time a bug in this parser has produced something that looked like a finding.
     */
    if (inDeclaration) {
      if (text.includes(';')) inDeclaration = false;
      depth += (line.match(/[{]/g) ?? []).length - (line.match(/[}]/g) ?? []).length;
      continue;
    }
    if (text.includes(':') && !text.includes(';') && !text.endsWith('{')) {
      inDeclaration = true;
      depth += (line.match(/[{]/g) ?? []).length - (line.match(/[}]/g) ?? []).length;
      continue;
    }

    if (
      reducedFrom === null &&
      text.includes('@media') &&
      text.includes('prefers-reduced-motion')
    ) {
      reducedFrom = depth;
    }

    if (text.endsWith('{')) {
      const head = (pending + ' ' + text.slice(0, -1)).trim();
      if (!head.startsWith('@')) selector = head;
      pending = '';
    } else if (text.endsWith(',') || (text !== '' && !text.includes(':') && !text.endsWith('}'))) {
      // Part of a selector list that has not reached its brace yet.
      pending = (pending + ' ' + text).trim();
    }

    if (/^animation:/.test(text)) {
      for (const one of selector
        .split(',')
        .map((s) => s.trim().replace(/ +/g, ' '))
        .filter(Boolean)) {
        if (text.includes('backwards')) backwards.add(one);
        if (reducedFrom !== null && /animation: *none/.test(text)) silenced.add(one);
      }
    }

    depth += (line.match(/[{]/g) ?? []).length - (line.match(/[}]/g) ?? []).length;
    if (reducedFrom !== null && depth <= reducedFrom) reducedFrom = null;
  }
  return { backwards, silenced };
};

describe('reduced motion switches entrance animations off', () => {
  it('finds backwards fills to check', () => {
    // Guards the guard: a parser that stopped matching would make the assertion below vacuous.
    const total = sheets.reduce((n, s) => n + collect(s.css).backwards.size, 0);
    expect(total).toBeGreaterThan(4);
  });

  it.each(sheets.map((s) => s.name))('%s silences every backwards fill it declares', (name) => {
    const sheet = sheets.find((s) => s.name === name);
    const { backwards, silenced } = collect(sheet?.css ?? '');

    const unsilenced = [...backwards].filter((sel) => !silenced.has(sel));
    expect(unsilenced).toEqual([]);
  });
});
