import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { STATUS_TONE_NAMES } from '@uboss/types';

import { STATUS_TONES, type StatusTone } from '../primitives/StatusBadge';

/*
 * A tone is only real if the stylesheet draws it.
 *
 * `StatusBadge` turns a tone into a class name — `uboss-badge--teal` — and an unknown word
 * produces a class nothing matches. Nothing throws, nothing logs: the badge simply renders as
 * bare text beside neighbours that have a coloured pill, which is the one failure mode that
 * survives a code review and a test suite and reaches a customer.
 *
 * It did. Five statuses across five maps carried `'cyan'`, a colour no stylesheet has ever
 * defined, among them `Running` — the status people look at most. Three separate things that
 * should have caught it did not: the maps were typed `Record<Status, string>`, the screens cast
 * the value on the way in with `as StatusTone`, and the test asserted the tone was a non-empty
 * string.
 *
 * So the check is the one nobody had written: that every tone in the vocabulary has a rule in the
 * CSS, and that the union and the stylesheet agree in both directions.
 */

const css = readFileSync(resolve(process.cwd(), 'src/styles/components.css'), 'utf8');

/** Every `uboss-badge--x` class the stylesheet actually defines. */
const tonesInStylesheet = new Set(
  Array.from(css.matchAll(/\.uboss-badge--([a-z]+)\b/g), (match) => match[1] as string),
);

describe('status tones', () => {
  it('draws every tone the vocabulary allows', () => {
    const undrawn = STATUS_TONE_NAMES.filter((tone) => !tonesInStylesheet.has(tone));
    expect(undrawn, 'these tones have no rule in components.css').toEqual([]);
  });

  it('defines no badge colour the vocabulary does not name', () => {
    // The other direction: a rule nobody can reach is dead CSS, and a tone somebody added to the
    // stylesheet without adding it here is one the compiler will still refuse.
    const unreachable = [...tonesInStylesheet].filter(
      (tone) => !(STATUS_TONE_NAMES as readonly string[]).includes(tone),
    );
    expect(unreachable, 'these badge colours are not in the tone vocabulary').toEqual([]);
  });

  it('keeps this package’s union identical to the shared one', () => {
    /*
     * The two are deliberately not one import. The stylesheet lives here and the maps live in
     * `@uboss/types`, so each package names the vocabulary it owns a side of — and this asserts
     * they have not drifted, which is the thing that actually matters.
     */
    const here: StatusTone[] = ['success', 'blue', 'teal', 'warn', 'danger', 'purple', 'grey'];
    expect([...here].sort()).toEqual([...STATUS_TONE_NAMES].sort());
  });

  it('gives every status in the canonical vocabulary a tone that exists', () => {
    const wrong = Object.entries(STATUS_TONES).filter(
      ([, tone]) => !tonesInStylesheet.has(tone as string),
    );
    expect(wrong, 'these statuses resolve to a colour the stylesheet does not draw').toEqual([]);
  });
});
