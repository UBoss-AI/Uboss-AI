'use client';

import { SCOPE_KIND_LABELS, type ScopeKind } from '@uboss/types';

import type { MeResponse } from './api-client';
import { useMyAccess } from './use-my-access';

/** What the shell shows about the person using it. */
export interface SignedInUser {
  name: string;
  role: string;
}

/**
 * The signed-in person, for the sidebar footer and the top bar.
 *
 * ## What this replaces
 *
 * Every company screen built this inline, identically and wrongly:
 *
 * ```
 * user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Reports' }}
 * ```
 *
 * Two separate mistakes, repeated twenty-six times. The **name** was the UBoss unique ID — the
 * sidebar footer read `UB-6MYH-E62C` for a person called Priya Nair — because `/auth/me` did not
 * return a display name, so the nearest available string was used. And the **role** was the title
 * of the page you happened to be on, so the same person was a "Dashboard" on one screen and a
 * "To-do List" on the next.
 *
 * ## What it shows instead
 *
 * The person's name, and the breadth of what they can see — "Whole Company", "Team / Subtree",
 * "Own Work". That is a real fact about them that stays the same as they move around, which is what
 * a role line is for.
 *
 * The scope arrives a moment after the name, because it comes from `/my-access`. It falls back to
 * "Signed in" rather than to a guess: an identity line that states something untrue is worse than
 * one that states less.
 */
export function useSignedInUser(me: MeResponse | null): SignedInUser {
  const access = useMyAccess();

  const scope = access?.assignedScope as ScopeKind | undefined;
  const role =
    scope !== undefined && scope in SCOPE_KIND_LABELS ? SCOPE_KIND_LABELS[scope] : 'Signed in';

  return {
    name: me?.user.displayName ?? me?.user.ubossUniqueId ?? 'Signed in',
    role,
  };
}
