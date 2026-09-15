'use client';

import { useRouter } from 'next/navigation';

import type { AccountMenuItem } from '@uboss/ui';

import { rememberWorkspace } from './active-workspace';
import type { MeResponse } from './api-client';

/**
 * What the top bar's account menu offers.
 *
 * ## Only destinations that exist
 *
 * The audit brief is explicit: *"Do NOT add functions that do not actually exist."* So each entry
 * here was checked against the routes:
 *
 *   * **My Profile** goes to Settings → General, which is the profile screen. There is no
 *     `/profile` route, and inventing a menu item that 404s would be worse than naming the place
 *     the profile actually lives. `SETTINGS_SECTIONS` even calls that section "My Profile" for a
 *     non-administering role.
 *   * **Settings** and **Appearance** are real sections, reachable by `?section=`.
 *   * **Switch workspace** appears **only when the person holds more than one membership**. It is
 *     genuinely supported — the active workspace is a remembered client-side choice — but an
 *     option that is always present and usually pointless is the kind of thing this audit exists
 *     to remove.
 *
 * Sign out is not here: `TopBar` appends it below the separator, so it is last and separated on
 * every shell whatever this returns.
 */
export function useAccountMenu(me: MeResponse | null): AccountMenuItem[] {
  const router = useRouter();

  const workspaces = me?.workspaces ?? [];
  const isPlatform = me?.user.isPlatformActor ?? false;

  const items: AccountMenuItem[] = [];

  // Platform staff have no company workspace, so the company-scoped settings screens are not
  // theirs to open. Their console is where their own configuration lives.
  if (!isPlatform) {
    items.push(
      {
        key: 'profile',
        label: 'My Profile',
        icon: 'users',
        onSelect: () => router.push('/settings?section=general'),
      },
      {
        key: 'settings',
        label: 'Settings',
        icon: 'gear',
        onSelect: () => router.push('/settings'),
      },
      {
        key: 'appearance',
        label: 'Appearance',
        icon: 'panel',
        detail: 'Light, dark or match this device',
        onSelect: () => router.push('/settings?section=appearance'),
      },
    );
  }

  if (workspaces.length > 1) {
    for (const workspace of workspaces) {
      items.push({
        key: `switch-${workspace.tenantId}`,
        label: `Switch to ${workspace.tenantName}`,
        icon: 'build',
        onSelect: () => {
          rememberWorkspace(workspace.tenantId);
          // A full load rather than a soft push: every screen reads the workspace once, so a
          // client-side transition would leave half the page showing the previous company.
          window.location.assign('/dashboard');
        },
      });
    }
  }

  if (isPlatform) {
    items.push({
      key: 'master',
      label: 'Master Console',
      icon: 'build',
      onSelect: () => router.push('/master/dashboard'),
    });
  }

  return items;
}
