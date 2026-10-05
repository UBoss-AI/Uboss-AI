import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
});

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
