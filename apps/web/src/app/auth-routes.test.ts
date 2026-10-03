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

/*
 * The sign-in form itself.
 *
 * It used to be inside `login/page.tsx`. Both front doors — the customer login and the platform
 * console login — now render one shared flow, so the route files are thin and the markup these
 * checks are about lives here. The route list above is still the list of pages a signed-out person
 * can reach; only the place the form is written has moved.
 */
const SIGN_IN_FLOW = path.join(process.cwd(), 'src', 'components', 'SignInFlow.tsx');
const readSignInFlow = () => readFileSync(SIGN_IN_FLOW, 'utf8');

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
    expect(readSignInFlow()).toContain('/access-help');
  });

  /*
   * Both doors, not just the customer one. A member of UBoss staff who cannot get in needs the
   * same way forward as a customer, and the shared flow is what guarantees they get it.
   */
  it.each(['login/page.tsx', 'internal/login/page.tsx'])(
    '%s renders the shared sign-in flow',
    (file) => {
      expect(read(file)).toContain('SignInFlow');
    },
  );
});

describe('auth routes — nobody adds themselves to an existing company', () => {
  /**
   * The rule this once held was "UBoss companies are provisioned, never self-served", and it was
   * right until self-serve registration shipped. Loosening a test to match new behaviour is
   * usually how a guarantee dies quietly, so what replaces it is the half that did **not**
   * change, and it is the half that matters:
   *
   *   * a person cannot create an identity inside a company that already exists — they are
   *     invited, and `/activate` enables what somebody else created;
   *   * a **company** may start its own workspace at `/start`, having proved a work address and
   *     control of a domain, which admits nobody to anybody else's company.
   *
   * The first is an access-control claim. The second is a commercial decision the owner made.
   * Only the first belongs in a test, and it is the one asserted here.
   */
  it.each(AUTH_ROUTES)('has no route that creates an account from $route', ({ file }) => {
    const source = read(file);

    const links = [...source.matchAll(/href=["'`]([^"'`]+)["'`]/g)].map((match) => match[1] ?? '');
    // `/start` is deliberately absent from this list: it creates a company, not a membership.
    const offenders = links.filter((href) => /sign-?up|register|create-account|join/i.test(href));

    expect(offenders).toEqual([]);
  });

  it('tells a visitor they are invited rather than inviting them to join', () => {
    /*
     * Read from the component rather than the page, because that is where the sentence lives and
     * three screens share it. The claim is about what a person is *told*: the one notice on these
     * screens must say somebody invites you, and must not promise a way in that does not exist.
     */
    const notice = readFileSync(
      path.join(
        process.cwd(),
        '..',
        '..',
        'packages',
        'ui',
        'src',
        'shells',
        'LoginPresentation.tsx',
      ),
      'utf8',
    );

    // A window after the declaration rather than up to the first `}`, which lands inside the JSX
    // long before the sentence does.
    const start = notice.indexOf('export function NoPublicSignupNotice');
    expect(start).toBeGreaterThan(-1);
    const sentence = notice.slice(start, start + 700);

    expect(sentence).toMatch(/cannot add yourself|invites you/i);
    // What this exists to prevent: the notice going back to flatly denying a signup the product
    // now has. It renders on `/activate`, where a stranger reads it.
    expect(sentence).not.toMatch(/no public signup/i);
  });

  it('offers starting a workspace, which is the door that does exist', () => {
    // The other half of the same screen, so the two cannot drift apart again: if the link goes,
    // the notice above should be revisited, and this failing is how somebody finds out.
    expect(readSignInFlow()).toContain('href="/start"');
  });
});
