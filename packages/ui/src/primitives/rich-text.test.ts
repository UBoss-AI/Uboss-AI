import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { hasWords, sanitiseRichText } from './rich-text';

/**
 * The browser's half of the Vision and Mission filter.
 *
 * The API sanitises before it stores, so in the ordinary case nothing dangerous reaches this. It
 * runs anyway, because "in the ordinary case" is not a security property: a row written before
 * the API knew how, a restore from an old backup, or a future endpoint that forgets, each puts
 * unfiltered markup on the first screen every employee opens.
 */
describe('the browser filter', () => {
  it('removes a script and keeps the sentence around it', () => {
    const cleaned = sanitiseRichText('<p>Our mission</p><script>alert(1)</script>');
    expect(cleaned).not.toMatch(/script|alert/i);
    expect(cleaned).toMatch(/Our mission/);
  });

  it('removes a handler from a tag that is otherwise allowed', () => {
    expect(sanitiseRichText('<p onclick="alert(1)">Our mission</p>')).not.toMatch(/onclick/i);
  });

  it('keeps the formatting the toolbar produces', () => {
    const cleaned = sanitiseRichText(
      '<p><b>Bold</b></p><ul><li>one</li></ul>' +
        '<span style="color: #ff0000; font-size: 18px">red</span>',
    );
    for (const kept of ['<b>', '<ul>', '<li>', 'color', 'font-size']) {
      expect(cleaned).toContain(kept);
    }
  });

  it('drops a style that would cover the page', () => {
    const cleaned = sanitiseRichText(
      '<span style="position: fixed; top: 0; width: 100vw; color: #111">x</span>',
    );
    expect(cleaned).not.toMatch(/position|100vw/i);
    expect(cleaned).toContain('color');
  });

  it('keeps an image from this product and removes one from anywhere else', () => {
    const ours =
      '/api/tenants/01a0a8fb-8f67-71cb-99f8-f9fdedde810d/organization/company-images/01a10c00-1111-2222-3333-444455556666';
    expect(sanitiseRichText(`<img src="${ours}" alt="chart">`)).toMatch(/<img/);
    expect(sanitiseRichText('<img src="https://evil.example/p.gif">')).not.toMatch(/img|evil/i);
    expect(sanitiseRichText('<img src="data:image/svg+xml;base64,PHN2Zz4=">')).not.toMatch(/img/i);
  });

  it('knows markup with no words in it from markup with some', () => {
    expect(hasWords('<p></p>')).toBe(false);
    expect(hasWords('<p>&nbsp;</p>')).toBe(false);
    expect(hasWords(null)).toBe(false);
    expect(hasWords('<p><b>a</b></p>')).toBe(true);
  });
});

/**
 * The two filters are one policy written twice, and a policy that disagrees with itself is worse
 * than either half.
 *
 * A tag allowed here but not in the API is formatting that survives the editor, is stripped on
 * save, and vanishes when the page reloads — which looks like the editor losing work. A tag
 * allowed in the API but not here is markup that is stored and then silently not drawn.
 *
 * So the lists are compared directly, by reading both files. Crude on purpose: the alternative is
 * a shared package for two arrays, and the thing that actually goes wrong is somebody adding a
 * tag to one file and not the other.
 */
describe('the two filters agree', () => {
  const read = (relative: string): string => readFileSync(join(process.cwd(), relative), 'utf8');

  const listOf = (source: string, name: string): string[] => {
    const start = source.indexOf(`const ${name} = `);
    expect(start, `${name} is not declared the way this test reads it`).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('];', start));
    return [...body.matchAll(/'([a-z-]+)'/g)].map((found) => found[1] as string).sort();
  };

  const setOf = (source: string, name: string): string[] => {
    const start = source.indexOf(`const ${name} = new Set(`);
    expect(start, `${name} is not declared the way this test reads it`).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf(']);', start));
    return [...body.matchAll(/'([a-z-]+)'/g)].map((found) => found[1] as string).sort();
  };

  const browser = read(join('src', 'primitives', 'rich-text.ts'));
  const api = read(join('..', '..', 'apps', 'api', 'src', 'organization', 'rich-text.ts'));

  it('allows the same tags', () => {
    expect(listOf(browser, 'ALLOWED_TAGS')).toEqual(listOf(api, 'ALLOWED_TAGS'));
  });

  it('allows the same style properties', () => {
    expect(setOf(browser, 'ALLOWED_CSS')).toEqual(setOf(api, 'ALLOWED_CSS'));
  });

  it('accepts images from the same one place', () => {
    const pattern = (source: string): string => {
      const start = source.indexOf('const IMAGE_SRC = new RegExp(');
      expect(start, 'IMAGE_SRC is not declared the way this test reads it').toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf(');', start));
      return (body.match(/'([^']+)'/) ?? [])[1] ?? '';
    };
    expect(pattern(browser)).toBe(pattern(api));
    expect(pattern(browser)).not.toBe('');
  });
});
