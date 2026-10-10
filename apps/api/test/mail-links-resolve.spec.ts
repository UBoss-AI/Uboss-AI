import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * Every link the product puts in an email goes to a page that exists.
 *
 * ## The failure this exists to prevent
 *
 * Two of them did not. `IdentityMailService` sent password resets to `/login/reset` and
 * registration confirmations to `/register/confirm`, and **neither page has ever been built**.
 * Both were found on the production stack, by the person who needed them:
 *
 *   * the reset link 404ed for somebody locked out of the console, who by definition had no
 *     other way in;
 *   * the confirmation link 404ed in the middle of self-serve signup, so a company could start
 *     registering and could not finish.
 *
 * Nothing caught it. The API tested that an email was *sent* and with what token; the web app
 * tested its own routes; no test crossed the gap between them, which is exactly where the two
 * halves disagreed about a name.
 *
 * ## Why this reads the source instead of rendering
 *
 * The claim is narrow and structural — *the path in this string is a route the web app serves* —
 * and that is a fact about two files, not about a running browser. A rendering test would need
 * the whole mail stack and would still not prove the route exists.
 *
 * It fails loudly if it stops finding links to check, because a scan that silently matches
 * nothing is the other way this kind of test rots.
 */
describe('every emailed link points at a page the web app serves', () => {
  /*
   * From the working directory, not from this file: the suite runs the compiled copy out of
   * `dist-test/test/`, so anything relative to the module lands two directories deeper than the
   * source it is trying to read. `node --test` is run from `apps/api`.
   */
  const MAIL_SERVICE = path.join(process.cwd(), 'src', 'auth', 'identity-mail.service.ts');
  const WEB_APP = path.join(process.cwd(), '..', 'web', 'src', 'app');

  /** Paths that are real routes without a `page.tsx` of their own. None today. */
  const SERVED_WITHOUT_A_PAGE: readonly string[] = [];

  it('finds the links it claims to be checking', () => {
    assert.ok(existsSync(MAIL_SERVICE), 'the mail service moved');
    assert.ok(existsSync(WEB_APP), 'the web app moved');
    assert.ok(linksIn(readFileSync(MAIL_SERVICE, 'utf8')).length >= 3, 'no links found to check');
  });

  it('serves a page for each of them', () => {
    const missing: string[] = [];

    for (const link of linksIn(readFileSync(MAIL_SERVICE, 'utf8'))) {
      if (SERVED_WITHOUT_A_PAGE.includes(link)) continue;
      const page = path.join(WEB_APP, link, 'page.tsx');
      if (!existsSync(page)) missing.push(link);
    }

    assert.deepEqual(
      missing,
      [],
      'these are emailed to people and answer 404: ' +
        `${missing.map((link) => `/${link}`).join(', ')}. A link in an email is the one ` +
        'the reader cannot work around.',
    );
  });

  /*
   * The same check, for the other half of the product that puts links in email.
   *
   * `IdentityMailService` is not the only sender. Every notification carries a `deepLink`, the
   * dispatcher turns it into an absolute URL, and it goes out as the one thing the message asks
   * the reader to press. That path was never checked here, and it was wrong in three places:
   *
   *   * `/settings/security` — a 404, found by an administrator following a security alert. The
   *     worst landing a message can have, because the whole point of that mail is "go and look".
   *   * `/settings?category=tokens`, twice — the page reads `?section=`, so this quietly opened
   *     General instead. Not a 404, which is why nobody reported it.
   *
   * Settings has three routes of its own and a dozen panels addressed by `?section=`, so both
   * halves of such a link have to be real: the path, and the key.
   */
  const NAV_MODEL = path.join(
    process.cwd(),
    '..',
    '..',
    'packages',
    'ui',
    'src',
    'navigation',
    'navigation-model.ts',
  );

  it('finds the deep links and the section keys it claims to be checking', () => {
    assert.ok(existsSync(NAV_MODEL), 'the navigation model moved');
    assert.ok(deepLinks().length >= 5, 'no notification deep links found to check');
    assert.ok(settingsSectionKeys().length >= 8, 'no settings section keys found to check');
  });

  it('serves a page for every notification deep link', () => {
    const missing = deepLinks()
      .map((link) => link.split('?')[0]!.replace(/^\/+/, '').replace(/\/+$/, ''))
      .filter((route) => route !== '' && !SERVED_WITHOUT_A_PAGE.includes(route))
      .filter((route) => !existsSync(path.join(WEB_APP, route, 'page.tsx')));

    assert.deepEqual(
      [...new Set(missing)],
      [],
      'these are emailed as the one thing to press, and answer 404: ' +
        `${[...new Set(missing)].map((link) => `/${link}`).join(', ')}`,
    );
  });

  it('names a settings panel that exists, on every link that names one', () => {
    const keys = settingsSectionKeys();
    const wrong: string[] = [];

    for (const link of deepLinks()) {
      const query = link.split('?')[1];
      if (query === undefined) continue;

      const section = new URLSearchParams(query).get('section');
      // A link carrying some other parameter is not this test's business; one carrying none to
      // `/settings` is the General panel, which is a real answer.
      if (section !== null && !keys.includes(section)) wrong.push(link);

      // The parameter the page actually reads. Anything else opens General and says nothing.
      if (section === null && /\b(category|panel|tab)=/.test(query)) wrong.push(link);
    }

    assert.deepEqual(
      wrong,
      [],
      `these open the wrong settings panel without failing: ${wrong.join(', ')}. ` +
        `The page reads ?section=, and the keys are: ${keys.join(', ')}.`,
    );
  });
});

/** Every `deepLink: '…'` the API sets, which is every link a notification email carries. */
function deepLinks(): string[] {
  const found = new Set<string>();

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // `generated` is the Prisma client: megabytes of code that sets no deep links.
      if (entry.isDirectory()) {
        if (entry.name !== 'generated') walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;

      for (const match of readFileSync(full, 'utf8').matchAll(/deepLink:\s*'([^']+)'/g)) {
        found.add(match[1]!);
      }
    }
  };

  walk(path.join(process.cwd(), 'src'));
  return [...found].sort();
}

/**
 * The `?section=` values Settings will actually honour.
 *
 * Read from the navigation model's source rather than imported: `@uboss/ui` is a React package
 * the API does not depend on, and adding that dependency to check a dozen strings would be a
 * worse trade than reading the file. The test above fails if this finds nothing, which is the
 * failure mode a source scan has.
 */
function settingsSectionKeys(): string[] {
  const source = readFileSync(
    path.join(
      process.cwd(),
      '..',
      '..',
      'packages',
      'ui',
      'src',
      'navigation',
      'navigation-model.ts',
    ),
    'utf8',
  );

  const start = source.indexOf('SETTINGS_SECTIONS');
  if (start === -1) return [];

  const keys = new Set<string>();
  for (const match of source.slice(start).matchAll(/^\s{4}key: '([a-z-]+)',/gm)) {
    keys.add(match[1]!);
  }
  return [...keys].sort();
}

/**
 * The path of each `${webBaseUrl}/…` link, without its query string.
 *
 * Template literals, because that is how every one of them is written — a base from config, a
 * literal path, then the parameters. The path is whatever sits between the closing brace and the
 * first `?`, backtick or newline.
 */
function linksIn(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/\$\{this\.config\.webBaseUrl\}([^`?\n]*)/g)) {
    const route = (match[1] ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
    // A bare `${webBaseUrl}` with no path is the application's own root, which always exists.
    if (route !== '') found.add(route);
  }
  return [...found].sort();
}
