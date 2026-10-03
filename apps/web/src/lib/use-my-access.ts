'use client';

import { useEffect, useState } from 'react';

import { readRememberedWorkspace, resolveActiveWorkspace } from './active-workspace';
import { authApi, myAccessApi } from './api-client';

/** What `/my-access` answers about the signed-in person, once it has answered. */
export interface MyAccess {
  userId: string;
  userType: string;
  assignedScope: string;
  visibleModules: string[];
  /**
   * Navigation entries the engine refuses despite the module grant, because their landing request
   * names a row the scope layer cannot place. Optional: an older server omits it, and an omitted
   * list means "nothing known to be refused" rather than "everything is fine".
   */
  unavailableNavKeys?: string[];
  granted: Record<string, string[]>;
  note: string;
}

/**
 * The answer, kept between pages.
 *
 * ## The flicker this exists to stop
 *
 * Every company page builds its own shell, so every navigation mounted this hook afresh, starting
 * at `null` and making two requests before it could say anything. Meanwhile the sidebar — which
 * fails open on purpose, because an empty menu looks broken — rendered the **whole** navigation.
 *
 * For an administrator that was invisible. For an Employee it was the thing they saw most: opening
 * any section flashed the full admin sidebar — Hierarchy, Objective Optimization, Agent Builder,
 * Executor Agent — and then those items vanished as the real answer arrived. Every single
 * navigation, twice a second apart. The product looked like it was losing its own menu.
 *
 * Holding the answer here means the second page mount starts with it. The first load is unchanged;
 * everything after renders the right sidebar immediately and asks nobody.
 *
 * ## Keyed by company, and gone when the session is
 *
 * Someone who switches workspace is a different person as far as grants are concerned, so the key
 * is the tenant and a different one clears what is held.
 *
 * Sign-out needs no wiring here, and it is worth saying why rather than leaving it to be
 * rediscovered: every sign-out ends in `window.location.assign('/login')`, a full document load,
 * which destroys this module along with everything else in the page. A cached grant cannot outlive
 * a session on a shared machine because the cache cannot outlive the document. If sign-out ever
 * becomes a client-side route change, that stops being true and this must be cleared explicitly.
 *
 * ## One request, however many hooks
 *
 * Several components on a page call this. Without the shared promise each would issue its own pair
 * of requests, which is the second half of what made navigation slow.
 */
let cachedFor: string | null = null;
let cached: MyAccess | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<(access: MyAccess | null) => void>();

/** Drop everything. Called on sign-out and on a workspace switch. */
export function forgetMyAccess(): void {
  cachedFor = null;
  cached = null;
  inFlight = null;
  for (const listener of listeners) listener(null);
}

async function load(tenantId: string): Promise<void> {
  try {
    const mine = await myAccessApi.mine(tenantId);
    cachedFor = tenantId;
    cached = mine;
    for (const listener of listeners) listener(mine);
  } catch {
    // Left unknown. Every caller handles "not yet" already, and a failure is the same situation
    // one moment later — with one difference: nothing is cached, so the next page tries again.
  } finally {
    inFlight = null;
  }
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
  /*
   * Seeded from the cache, which is what removes the flash.
   *
   * `useState` takes the value at first render — before anything paints — so a page reached by
   * navigation draws the correct sidebar in its first frame rather than drawing the full one and
   * correcting itself.
   */
  const [access, setAccess] = useState<MyAccess | null>(cached);

  useEffect(() => {
    let cancelled = false;
    const listener = (value: MyAccess | null) => {
      if (!cancelled) setAccess(value);
    };
    listeners.add(listener);

    void (async () => {
      try {
        const identity = await authApi.me();
        // `activeWorkspaceId` is always null on this endpoint — see `active-workspace.ts`. Reading
        // it alone is why this hook never resolved, and why module visibility and every `can()`
        // check were silently inert in the running application.
        const workspace = resolveActiveWorkspace(identity.workspaces, readRememberedWorkspace());
        if (workspace === null) return;

        // Somebody switched company: what is held is about the previous one.
        if (cachedFor !== null && cachedFor !== workspace.tenantId) forgetMyAccess();

        if (cached !== null && cachedFor === workspace.tenantId) {
          if (!cancelled) setAccess(cached);
          return;
        }

        // One request however many components asked, and however many of them mounted at once.
        inFlight ??= load(workspace.tenantId);
        await inFlight;
      } catch {
        // Left null, as above.
      }
    })();

    return () => {
      cancelled = true;
      listeners.delete(listener);
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
export function can(access: MyAccess | null, module: string, action: string): boolean {
  return access?.granted[module]?.includes(action) ?? false;
}
