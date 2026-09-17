import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * The global motion rule, enforced.
 *
 * Every duration and curve in the product comes from the scale in `tokens.css`. That is not
 * tidiness for its own sake: a dropdown that opens in 240ms beside a drawer that opens in 200ms
 * reads as a bug nobody can name, and the only way that drift ever gets in is one rule at a time,
 * each of them individually reasonable. Eight had already accumulated before this test existed.
 *
 * Resolved from the package root rather than `import.meta.url`: under the jsdom environment that
 * is not a file URL.
 */
const stylesDir = resolve(process.cwd(), 'src/styles');
const sheets = readdirSync(stylesDir)
  .filter((name) => name.endsWith('.css'))
  .map((name) => ({ name, css: readFileSync(resolve(stylesDir, name), 'utf8') }));

/**
 * Every `transition:` / `animation:` declaration, with its line number and whether it sits inside
 * a `prefers-reduced-motion` block.
 *
 * That last flag matters. The global reduced-motion rule uses `0.01ms !important`, not `0s`, and
 * that is deliberate — a true zero can stop `transitionend` firing and strand any JavaScript
 * waiting on it. So it is exempt from the scale by what it *is*, rather than by loosening the
 * number pattern, which would also stop catching a stray `0.15s` somewhere else.
 */
const motionDeclarations = sheets.flatMap(({ name, css }) => {
  let depth = 0;
  let reducedFrom: number | null = null;

  return css.split('\n').flatMap((line, index) => {
    const text = line.trim();
    if (reducedFrom === null && /@media[^{]*prefers-reduced-motion/.test(text)) reducedFrom = depth;
    depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
    const inReduced = reducedFrom !== null;
    if (reducedFrom !== null && depth <= reducedFrom) reducedFrom = null;

    return /^(transition|animation)(-duration|-timing-function)?:/.test(text)
      ? [{ name, line: index + 1, text, reducedMotion: inReduced }]
      : [];
  });
});

const listed = (declarations: typeof motionDeclarations) =>
  declarations.map(({ name, line, text }) => `${name}:${line}  ${text}`);

describe('the motion scale governs every stylesheet', () => {
  it('finds motion declarations to check at all', () => {
    // Guards the guard: a regex that silently stopped matching would make everything below pass.
    expect(motionDeclarations.length).toBeGreaterThan(30);
    expect(sheets.map((s) => s.name)).toContain('components.css');
    expect(motionDeclarations.some((d) => d.reducedMotion)).toBe(true);
    expect(motionDeclarations.some((d) => !d.reducedMotion)).toBe(true);
  });

  it('declares no duration outside the token scale', () => {
    const offScale = motionDeclarations.filter(
      // A bare `0s`/`0ms` is "no motion", not a duration off the scale.
      ({ text, reducedMotion }) => !reducedMotion && /(?<![\w.-])(?!0m?s)\d*\.?\d+m?s/.test(text),
    );

    expect(listed(offScale)).toEqual([]);
  });

  it('declares no easing curve outside the token scale', () => {
    // `linear` stays legal — it is what an indeterminate spinner needs, and it is not a curve
    // anyone can get subtly wrong.
    const offScale = motionDeclarations.filter(({ text }) => /cubic-bezier\(/.test(text));

    expect(listed(offScale)).toEqual([]);
  });

  it('keeps the interaction scale and the looping scale separate', () => {
    const tokens = sheets.find((s) => s.name === 'tokens.css')?.css ?? '';

    // Loops are the one place a long duration is correct, so they are named rather than inlined.
    for (const loop of ['spin', 'pulse', 'shimmer']) {
      expect(tokens).toMatch(new RegExp(`--uboss-motion-loop-${loop}:`));
    }

    // And nothing on the interaction scale may repeat: an idle screen is idle.
    const interactionLoops = motionDeclarations.filter(
      ({ text }) => /infinite/.test(text) && !/--uboss-motion-loop-/.test(text),
    );
    expect(listed(interactionLoops)).toEqual([]);
  });
});

describe('motion tokens resolve', () => {
  /*
   * A misspelled custom property is the quietest failure in CSS. `var(--uboss-mtoin-small)` makes
   * the whole `transition` declaration invalid, the element simply stops animating, and nothing
   * anywhere reports it — no console warning, no build error, no failing test. The only way to
   * notice is to look at the right screen at the right moment.
   */
  /*
   * Every `--uboss-*` reference in every stylesheet, not just the motion ones. The first version
   * of this check collected only `var(--uboss-motion…)` and `var(--uboss-ease…)`, which meant a
   * typo anywhere but the end of the name — `var(--uboss-mtoin-small)` — was invisible to it. A
   * check that cannot fail is not a check, so it now looks at the whole namespace.
   */
  const declared = new Set(
    sheets.flatMap(({ css }) =>
      [...css.matchAll(/^ *(--uboss-[\w-]+) *:/gm)]
        .map((match) => match[1])
        .filter((name): name is string => name !== undefined),
    ),
  );

  /** Custom properties set inline by a component rather than declared in a stylesheet. */
  const setInJs = new Set(['--uboss-arc']);

  const referenced = sheets.flatMap(({ name, css }) =>
    css.split('\n').flatMap((line, index) =>
      [...line.matchAll(/var\( *(--uboss-[\w-]+)/g)].map((match) => ({
        name,
        line: index + 1,
        token: match[1] as string,
      })),
    ),
  );

  it('finds token references to check', () => {
    expect(declared.size).toBeGreaterThan(20);
    expect(referenced.length).toBeGreaterThan(100);
  });

  it('declares every token the stylesheets reference', () => {
    const dangling = referenced
      .filter(({ token }) => !declared.has(token) && !setInJs.has(token))
      .map(({ name, line, token }) => `${name}:${line}  var(${token})`);

    expect(dangling).toEqual([]);
  });

  it('keeps the legacy names as aliases rather than a second scale', () => {
    const tokens = sheets.find((s) => s.name === 'tokens.css')?.css ?? '';

    for (const legacy of [
      '--uboss-motion-fast',
      '--uboss-motion',
      '--uboss-motion-slow',
      '--uboss-ease',
    ]) {
      // Spaces spelled out rather than a backslash class: tokens.css indents with plain spaces,
      // and this avoids an escape that is easy to lose when the file is edited by a script.
      const pattern = new RegExp('^ *' + legacy + ': *([^;]+);', 'm');
      const declaration = tokens.match(pattern)?.[1]?.trim();
      expect(declaration, `${legacy} should alias the scale`).toMatch(
        /^var\(--uboss-(motion|ease)-/,
      );
    }
  });
});
