'use client';

import { useEffect, useState } from 'react';

import { authApi, myAccessApi } from './api-client';

/** What `/my-access` answers about the signed-in person, once it has answered. */
export interface MyAccess {
  userId: string;
  userType: string;
  assignedScope: string;
  visibleModules: string[];
  granted: Record<string, string[]>;
  note: string;
}

/**
 * The signed-in person's own grants — Prompt 40A (CR-03).
 *
 * ## Why a screen needs this at all
 *
 * Backend authorization stays authoritative: every route refuses on its own. But a screen that
 * offers an action the route will refuse is a screen that teaches people their software is broken,
 * so the *presentation* needs the same facts the guard uses. This is the one endpoint that answers
 * them for yourself — `authorizationApi` is platform-only and answers about other people.
 *
 * ## Null means "not yet", never "nothing"
 *
 * The hook returns `null` until the response lands and if the request fails. Callers must decide
 * which way to lean for their own case, because the right direction differs:
 *
 *   * a **menu** leans open — see `useCompanyNavigation`, where a flickering empty sidebar is worse
 *     than an item that refuses when clicked;
 *   * an **editing control** leans shut, because offering Remove and then failing is worse than a
 *     control that appears a moment late.
 *
 * `can()` below leans shut, which is why the menu does not use it.
 */
export function useMyAccess(): MyAccess | null {
  const [access, setAccess] = useState<MyAccess | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const identity = await authApi.me();
        const tenantId = identity.activeWorkspaceId;
        if (tenantId === null) return;

        const mine = await myAccessApi.mine(tenantId);
        if (!cancelled) setAccess(mine);
      } catch {
        // Left null. Every caller has to handle "not yet" anyway, and a failure is the same
        // situation one moment later.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return access;
}

/**
 * Does this person hold this grant?
 *
 * False while the answer is unknown, so a control that depends on it appears when the grant is
 * confirmed rather than disappearing once it is denied.
 */
export function can(
  access: MyAccess | null,
  module: string,
  action: string,
): boolean {
  return access?.granted[module]?.includes(action) ?? false;
}
