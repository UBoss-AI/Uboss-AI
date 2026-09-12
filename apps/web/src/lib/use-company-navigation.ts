'use client';

import { COMPANY_NAV, filterNavigation, type NavGroup } from '@uboss/ui';

import { useMyAccess } from './use-my-access';

/**
 * The sidebar this person should actually see — Prompt 40A (CR-03) §8.
 *
 * ## Why every page needs this
 *
 * Before CR-03 every company page rendered the full `COMPANY_NAV`, which was harmless while every
 * role held every module. It is not harmless now: a standard Employee holds no `objective` or
 * `agent-builder` grant, so leaving the items in the sidebar would show them two screens that
 * refuse them — the "hidden navigation is presentation only" rule read backwards.
 *
 * ## It follows grants, never role labels
 *
 * `visibleModules` comes from the server and is derived from whichever modules the person actually
 * holds a grant on. There is deliberately **no** `if (role === 'Employee')` anywhere: a second rule
 * would have to be kept in step with the first, and the two would eventually disagree.
 *
 * ## Fail open, and only for the menu
 *
 * A failed or pending request renders the full navigation. Being generous with a *menu* is right —
 * every route is independently guarded, so the worst case is an item that refuses when clicked,
 * against the alternative of a sidebar that flickers to empty on every page load and looks broken.
 *
 * This is why the hook reads `visibleModules` directly rather than going through `can()`, which
 * leans the other way on purpose.
 */
export function useCompanyNavigation(): NavGroup[] {
  const access = useMyAccess();
  return filterNavigation(COMPANY_NAV, access?.visibleModules ?? null);
}
