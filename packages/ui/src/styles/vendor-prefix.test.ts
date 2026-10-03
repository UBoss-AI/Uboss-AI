import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Hand-written vendor prefixes, and the way they fail.
 *
 * The build adds prefixes itself from the browserslist targets. Writing one by hand as well does
 * not merely duplicate the work — `backdrop-filter: blur(3px)` followed by
 * `-webkit-backdrop-filter: blur(3px)` in the same rule caused the optimiser to drop *both*, so
 * the dialog scrim shipped with no blur at all. Nothing failed: the stylesheet compiled, the page
 * rendered, the rule was served with the declaration simply missing. It was only found by reading
 * the applied rules out of a real browser.
 *
 * Prefixed properties with no unprefixed equivalent — `-webkit-font-smoothing`,
 * `-webkit-overflow-scrolling`, the `::-webkit-scrollbar` pseudo-elements — are not the problem
 * and stay allowed. The rule is narrow on purpose: never write both spellings of one property.
 */
const stylesDir = resolve(process.cwd(), 'src/styles');
const sheets = readdirSync(stylesDir)
  .filter((name) => name.endsWith('.css'))
  .map((name) => ({ name, css: readFileSync(resolve(stylesDir, name), 'utf8') }));

/** Every declared property name, by stylesheet, with the line it was declared on. */
const declarations = sheets.flatMap(({ name, css }) =>
  css.split('\n').flatMap((line, index) => {
    const text = line.trim();
    const colon = text.indexOf(':');
    if (colon <= 0) return [];
    const property = text.slice(0, colon).trim();
    // Property names only: no selectors, no at-rules, no custom properties.
    if (!/^-?[a-z][a-z0-9-]*$/.test(property) || property.startsWith('--')) return [];
    return [{ name, line: index + 1, property }];
  }),
);

describe('vendor prefixes', () => {
  it('finds declarations to check', () => {
    expect(declarations.length).toBeGreaterThan(500);
  });

  it('never writes both the prefixed and unprefixed spelling of a property', () => {
    const prefixed = declarations.filter(({ property }) => /^-(webkit|moz|ms|o)-/.test(property));
    const unprefixedNames = new Set(
      declarations
        .filter(({ property }) => !property.startsWith('-'))
        .map(({ property }) => property),
    );

    const collisions = prefixed
      .filter(({ property }) => unprefixedNames.has(property.replace(/^-(webkit|moz|ms|o)-/, '')))
      .map(({ name, line, property }) => `${name}:${line}  ${property}`);

    expect(collisions).toEqual([]);
  });
});
