import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The auth routes, and the two rules they have always had to obey — Prompt 42.
 *
 * Both of these were **checked by hand at Prompt 2** and written into `TEST_MATRIX.md` as a manual
 * verification. A manual check is a fact about one afternoon; forty prompts later nothing had
 * re-checked either, which is precisely the kind of gap this prompt exists to close.
 *
 * ## Why this reads the source rather than rendering
 *
 * These pages fetch on mount — a rendering test would need the whole auth client mocked to assert
 * the presence of a link, and the mock would then be the thing under test. Reading the source is
 * narrower and honest about what it proves: **the link is written**. It cannot prove the link is
 * reachable in every branch, and the comment below says so rather than implying otherwise.
 *
 * The signup rule is different and the static form is actually the stronger one: the claim is that
 * a route to public signup exists **nowhere in the auth surface**, and absence is exactly what a
 * scan can establish and a render cannot.
 */

const APP = path.join(process.cwd(), 'src', 'app');

/** The pages a signed-out person can reach. */
const AUTH_ROUTES = [
  { route: '/login', file: 'login/page.tsx', isSignIn: true, isHelp: false },
  { route: '/activate', file: 'activate/page.tsx', isSignIn: false, isHelp: false },
  { route: '/access-help', file: 'access-help/page.tsx', isSignIn: false, isHelp: true },
];

const read = (file: string) => readFileSync(path.join(APP, file), 'utf8');

describe('auth routes — a person is never stranded', () => {
  it('reads the pages it claims to be checking', () => {
    // A path that silently resolved to nothing would pass every assertion below.
    for (const { file } of AUTH_ROUTES) {
      expect(read(file).length).toBeGreaterThan(500);
    }
  });

  it.each(AUTH_ROUTES.filter((entry) => !entry.isSignIn))(
    'offers a way back to sign in from $route',
    ({ file }) => {
      const source = read(file);
      expect(source).toContain('href="/login"');
    },
  );

  it.each(AUTH_ROUTES.filter((entry) => !entry.isSignIn && !entry.isHelp))(
    'offers the help route from $route, so a blocked person has somewhere to go',
    ({ file }) => {
      // The forward half. Somebody whose activation link expired needs more than "back to sign in",
      // which is where they just failed.
      expect(read(file)).toContain('href="/access-help"');
    },
  );

  it('offers help from the sign-in page itself', () => {
    expect(read('login/page.tsx')).toContain('/access-help');
  });
});

describe('auth routes — no public company signup', () => {
  /**
   * The locked rule: UBoss companies are provisioned, never self-served. The only permitted mention
   * is the disclaimer that says so.
   */
  it.each(AUTH_ROUTES)('has no link to a signup route from $route', ({ file }) => {
    const source = read(file);

    const links = [...source.matchAll(/href=["'`]([^"'`]+)["'`]/g)].map((match) => match[1] ?? '');
    const offenders = links.filter((href) => /sign-?up|register|create-account|join/i.test(href));

    expect(offenders).toEqual([]);
  });

  it('mentions signup only to deny it', () => {
    const source = read('login/page.tsx');
    const mentions = [...source.matchAll(/[^\n]*sign-?up[^\n]*/gi)].map((match) => match[0].trim());

    expect(mentions.length).toBeGreaterThan(0);

    /*
     * Compared with the punctuation and casing removed, because the disclaimer reaches this
     * file as the identifier `noPublicSignupNotice` rather than as a sentence. Matching on
     * prose would have reported the one correct mention in the codebase as a violation.
     */
    for (const mention of mentions) {
      const flattened = mention.toLowerCase().replace(/[^a-z]/g, '');
      expect(flattened).toMatch(/nopublic|notavailable|provisioned|contact/);
    }
  });
});
