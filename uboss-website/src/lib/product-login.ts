/**
 * Where the product's sign-in lives, when it is known.
 *
 * The product is deployed separately from this marketing site, so the address is a build-time
 * setting: `NEXT_PUBLIC_PRODUCT_LOGIN_URL`.
 *
 * ## Why there is no fallback address any more
 *
 * There was one — `/login`, which assumed a reverse proxy routing the product under this same
 * domain. Anywhere that assumption did not hold, and it held nowhere by default, the Sign In
 * button in the header of every page redirected to a path this site does not serve, and the
 * visitor got a 404. A default that is right in one deployment and silently broken in all the
 * others is worse than no default: the broken case looks configured.
 *
 * So the question is now answerable — `PRODUCT_LOGIN_IS_CONFIGURED` — and the sign-in page decides
 * what to do rather than redirecting into the dark. Where it is set, it redirects; where it is
 * not, it explains.
 */

const CONFIGURED = process.env.NEXT_PUBLIC_PRODUCT_LOGIN_URL?.trim() ?? '';

/** True when a deployment has told this site where the product's sign-in actually is. */
export const PRODUCT_LOGIN_IS_CONFIGURED = CONFIGURED !== '';

/** The product's sign-in address. Only meaningful when `PRODUCT_LOGIN_IS_CONFIGURED`. */
export const PRODUCT_LOGIN_URL = CONFIGURED;

/**
 * Where a company with no workspace starts one.
 *
 * Derived from the sign-in address rather than configured separately, because the two are the
 * same deployment and a second setting is a second thing to get wrong — the failure mode being a
 * site that can sign people in and cannot sign anybody up.
 *
 * It exists because every route through this site used to end at the demo form. The product has
 * self-serve registration, and a visitor who has read the pricing page and decided to begin
 * should be able to, without waiting for somebody to call them back.
 */
export const PRODUCT_START_URL =
  CONFIGURED === '' ? '' : CONFIGURED.replace(/\/login\/?$/, '/start');
