'use client';

/**
 * Which company workspace the person is currently working in.
 *
 * ## Why this exists at all
 *
 * `/auth/me` returns `activeWorkspaceId`, and every screen was reading it. It is **always null**,
 * and structurally cannot be anything else: the server derives it from `isTenantActor(actor)`, and
 * an actor only becomes a tenant actor inside a `/tenants/:tenantId/...` route, which `/auth/me` is
 * not. Sessions carry no tenant — the `sessions` table has no such column — because the tenant is
 * addressed in the URL of every tenant-scoped call.
 *
 * So the active workspace is a **client-side** fact: which of the memberships the server already
 * returned is this person looking at. That is what this module holds.
 *
 * ## Why it is remembered, and why that is not a security decision
 *
 * The choice survives a reload because being thrown back to a picker on every navigation is not an
 * enterprise product. It is stored in `localStorage`, which is per-browser and readable by the
 * person it belongs to — which is fine, because it grants nothing. Every tenant-scoped request
 * names its tenant in the path and is independently authorized; a remembered id that the person
 * has no membership for is refused by the server exactly as any other would be.
 *
 * It is still validated against the membership list before use, so a stale id from a company
 * somebody has left resolves to one they are actually in rather than to a wall of 403s.
 */

const WORKSPACE_KEY = 'uboss.workspace.active';

export interface WorkspaceSummary {
  tenantId: string;
  tenantName: string;
}

/** The remembered choice, or null when there is none or the store is unavailable. */
export function readRememberedWorkspace(): string | null {
  try {
    return window.localStorage.getItem(WORKSPACE_KEY);
  } catch {
    // Private window, or site data blocked. Falls back to the first membership.
    return null;
  }
}

/** Records the chosen workspace. Failing to store it must never fail the navigation. */
export function rememberWorkspace(tenantId: string): void {
  try {
    window.localStorage.setItem(WORKSPACE_KEY, tenantId);
  } catch {
    // The session still works; the choice just will not survive a reload.
  }
}

/** Clears the choice. Called on sign-out so the next person is not dropped into someone else's company. */
export function forgetWorkspace(): void {
  try {
    window.localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    // Nothing to do — an unreadable store is also an unwritable one.
  }
}

/**
 * The workspace to show, given what the server says this person belongs to.
 *
 * Order: the remembered one if it is still a membership, otherwise the first. Null only when the
 * person belongs to no company at all, which the login screen already reports honestly.
 */
export function resolveActiveWorkspace<T extends WorkspaceSummary>(
  workspaces: readonly T[] | undefined,
  remembered: string | null,
): T | null {
  if (workspaces === undefined || workspaces.length === 0) return null;
  if (remembered !== null) {
    const match = workspaces.find((workspace) => workspace.tenantId === remembered);
    if (match !== undefined) return match;
  }
  return workspaces[0] ?? null;
}
