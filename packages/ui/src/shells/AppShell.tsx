'use client';

import type { MouseEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { cn } from '../lib/class-names';
import type { NavGroup } from '../navigation/navigation-model';
import type { AccountMenuItem } from './AccountMenu';
import { Sidebar, type SidebarUser } from './Sidebar';
import { TopBar } from './TopBar';

/** Where the collapsed preference lives. One key for both shells: it is the same person. */
const COLLAPSE_KEY = 'uboss.sidebar.collapsed';

interface AppShellCommonProps {
  groups: readonly NavGroup[];
  activeKey: string;
  /**
   * Optional. Navigation happens through each item's `href`; this reports the choice and hands
   * over the event, so a router can take the transition over. See `SidebarProps.onNavigate`.
   */
  onNavigate?:
    ((key: string, href: string | undefined, event: MouseEvent<HTMLElement>) => void) | undefined;
  user: SidebarUser;
  /** Role and scope pill, e.g. "Company Admin · Whole company". */
  scopeLabel?: string;
  /** Ends the session. Rendered in both the sidebar footer and the top bar, as the reference does. */
  onSignOut?: () => void;
  hasNotifications?: boolean;
  /** Unread count, rendered as a badge on the bell. */
  unreadNotifications?: number;
  /** How many need acknowledging — a state an unread count of zero cannot express. */
  awaitingAcknowledgement?: number;
  onOpenNotifications?: () => void;
  /** Entries above the separator in the top bar account menu. See TopBarProps.accountMenu. */
  accountMenu?: readonly AccountMenuItem[] | undefined;
  /** Runs a workspace-wide search. Absent renders the field disabled. See TopBarProps.onSearch. */
  onSearch?: ((query: string) => void) | undefined;
  children: ReactNode;
  className?: string;
}

/**
 * The two UBoss application shells.
 *
 * `company` renders the Company Workspace shell and requires the active workspace name, because
 * every authenticated company screen must display `UBOSS AI AMS | {Active Workspace Name}`.
 * `master` renders the UBoss Master Console shell, a separate platform control plane with its
 * own dark treatment and no tenant workspace name.
 */
export type AppShellProps = AppShellCommonProps &
  ({ variant: 'company'; workspaceName: string } | { variant: 'master' });

export function AppShell(props: AppShellProps) {
  const {
    groups,
    activeKey,
    onNavigate,
    user,
    scopeLabel,
    onSignOut,
    hasNotifications,
    unreadNotifications,
    awaitingAcknowledgement,
    onOpenNotifications,
    accountMenu,
    onSearch,
    children,
    className,
  } = props;

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Remember whether the sidebar was collapsed. Read after mount rather than in the initial state,
  // because this component server-renders: seeding from localStorage there would hydrate a
  // different tree than the server sent. A blocked or empty store simply leaves it expanded.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(COLLAPSE_KEY) === '1') setCollapsed(true);
    } catch {
      // Private window, or site data blocked. The preference is a convenience, not state.
    }
  }, []);

  const toggleCollapse = () => {
    setCollapsed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // As above — the sidebar still collapses, it just will not be remembered.
      }
      return next;
    });
  };

  const isMaster = props.variant === 'master';
  // The sidebar footer gives its second line to Sign out, so the role falls back to the scope
  // pill rather than disappearing from the shell.
  const pill = scopeLabel ?? user.role;

  return (
    <div
      className={cn(
        'uboss-shell',
        isMaster && 'uboss-shell--master',
        collapsed && 'uboss-shell--collapsed',
        className,
      )}
    >
      <Sidebar
        brand={isMaster ? 'UBoss' : 'UBOSS AI AMS'}
        brandSub={isMaster ? 'Master Console' : props.workspaceName}
        groups={groups}
        activeKey={activeKey}
        onNavigate={(key, href, event) => {
          // Selecting an item on a small screen should also dismiss the off-canvas drawer.
          setMobileOpen(false);
          onNavigate?.(key, href, event);
        }}
        user={user}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
        onSignOut={onSignOut}
        open={mobileOpen}
      />

      <div className="uboss-main">
        {isMaster ? (
          <TopBar
            variant="master"
            scopeLabel={pill}
            user={user}
            onSignOut={onSignOut}
            hasNotifications={hasNotifications}
            unreadNotifications={unreadNotifications}
            awaitingAcknowledgement={awaitingAcknowledgement}
            onOpenNotifications={onOpenNotifications}
            accountMenu={accountMenu}
            onSearch={onSearch}
            onToggleSidebar={() => setMobileOpen((value) => !value)}
          />
        ) : (
          <TopBar
            variant="company"
            workspaceName={props.workspaceName}
            scopeLabel={pill}
            user={user}
            onSignOut={onSignOut}
            hasNotifications={hasNotifications}
            unreadNotifications={unreadNotifications}
            awaitingAcknowledgement={awaitingAcknowledgement}
            onOpenNotifications={onOpenNotifications}
            accountMenu={accountMenu}
            onSearch={onSearch}
            onToggleSidebar={() => setMobileOpen((value) => !value)}
          />
        )}

        <main className="uboss-content">{children}</main>
      </div>
    </div>
  );
}
