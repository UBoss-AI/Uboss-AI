import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every `uboss-` class the application writes is a class the stylesheets define.
 *
 * ## The failure this exists to catch
 *
 * A file input is hidden with a class, and the class was `uboss-visually-hidden`. The design
 * system defines `uboss-sr-only`. Nothing matched, so the browser drew its own
 * "Choose File / No file chosen" at full size beside the styled Upload Excel button — 253x28
 * pixels of control nobody designed, on the Objective form and on the Hierarchy import.
 *
 * Nothing failed. Not the build, not the types, not a test: a class name is a string, and a string
 * that matches no rule is simply a string. It was reported by the client as the upload being
 * broken, and the same wrong name had been sitting in two files.
 *
 * ## Why a crude scan is the right shape here
 *
 * This does not parse CSS or JSX. It reads the class names out of `className` strings and asks
 * whether each one appears as a selector somewhere in the stylesheets. That is exactly the
 * question that went unasked, and anything cleverer would need a real CSS parser to answer a
 * question whose answer is a substring search.
 *
 * A name built at runtime — `uboss-btn--${tone}` — cannot be checked this way and is skipped on
 * purpose: a test that guessed at those would fail on correct code, and a test that fails on
 * correct code gets deleted.
 */
describe('the classes the application writes exist in the design system', () => {
  const WEB = path.join(process.cwd(), 'src');
  const UI = path.join(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'styles');

  const read = (file: string): string => readFileSync(file, 'utf8');

  const walk = (dir: string, match: RegExp): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        out.push(...walk(full, match));
      } else if (match.test(entry)) {
        out.push(full);
      }
    }
    return out;
  };

  /** Everything the stylesheets define, as one haystack. */
  const stylesheets = [...walk(UI, /\.css$/), path.join(WEB, 'app', 'globals.css')]
    .map(read)
    .join('\n');

  /** Every literal `uboss-…` class written into a `className`, and the file that wrote it. */
  const used = new Map<string, string[]>();
  for (const file of walk(WEB, /\.(tsx|ts)$/)) {
    if (/\.test\.(tsx|ts)$/.test(file)) continue;
    const source = read(file);
    // className="…" and className={'…'} / `…` — the literal forms. A template with a hole in it
    // is skipped below.
    for (const found of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
      const literal = found[1] ?? found[2] ?? found[3] ?? '';
      if (literal.includes('${')) continue;
      for (const name of literal.split(/\s+/)) {
        if (!name.startsWith('uboss-')) continue;
        used.set(name, [...(used.get(name) ?? []), path.relative(WEB, file)]);
      }
    }
  }

  /**
   * The ones that were already like this when the check was written.
   *
   * Switching the file inputs to a class that exists turned this check up, and it found sixteen
   * more: names written into `className` that no stylesheet defines, each one a piece of styling
   * that has never done anything. Several are near-misses — `uboss-inline` beside
   * `.uboss-inline-edit`, `uboss-page` beside `.uboss-page-head`, `uboss-field-label` beside
   * `.uboss-field-label-row` — and `uboss-button` is almost certainly `uboss-btn`.
   *
   * They are listed rather than fixed because each one is a question about what the element was
   * meant to look like, and guessing sixteen answers in one go is how a layout quietly changes in
   * places nobody was looking at. Listed rather than ignored because an invisible defect that
   * nobody has written down is the thing that cost a client report in the first place.
   *
   * **Taking one off this list is the fix.** Adding one is not: a new name here means a new piece
   * of dead styling, and the whole point of the check is that it fails the moment that happens.
   */
  const KNOWN_UNSTYLED = new Set([
    'uboss-bordered',
    'uboss-button',
    'uboss-field-label',
    'uboss-grid-3',
    'uboss-inline',
    'uboss-line-area',
    'uboss-linkish',
    'uboss-mt-4',
    'uboss-page',
    'uboss-page-status',
    'uboss-pick-row',
    'uboss-readiness-finding',
    'uboss-row-actions',
    'uboss-select',
    'uboss-subhead',
    'uboss-textarea',
  ]);

  it('finds classes to check, so a silent zero cannot pass', () => {
    expect(used.size).toBeGreaterThan(40);
  });

  it('defines every one of them', () => {
    const undefinedClasses: string[] = [];
    for (const [name, files] of used) {
      if (KNOWN_UNSTYLED.has(name)) continue;
      // As a selector: `.uboss-card` followed by anything that ends a class name.
      if (!new RegExp(`\\.${name}(?![\\w-])`).test(stylesheets)) {
        undefinedClasses.push(`${name} — used in ${[...new Set(files)].join(', ')}`);
      }
    }

    expect(
      undefinedClasses,
      'These class names are written into className but no stylesheet defines them, so they ' +
        'style nothing and fail in silence:\n  ' +
        undefinedClasses.join('\n  '),
    ).toEqual([]);
  });

  it('keeps the known list honest, so a fixed one cannot sit here forever', () => {
    // A name that has since been defined, or is no longer used anywhere, does not belong on the
    // list — otherwise it grows into a place where real failures hide.
    const stale = [...KNOWN_UNSTYLED].filter(
      (name) => !used.has(name) || new RegExp(`\\.${name}(?![\\w-])`).test(stylesheets),
    );

    expect(
      stale,
      'These are on the known-unstyled list but no longer belong there — either they are now ' +
        'defined, or nothing uses them. Remove them from the list:\n  ' +
        stale.join('\n  '),
    ).toEqual([]);
  });
});
