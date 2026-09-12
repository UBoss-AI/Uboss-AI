'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';

import { cn } from '../lib/class-names';
import type { NavGroup } from '../navigation/navigation-model';
import { Sidebar, type SidebarUser } from './Sidebar';
import { TopBar } from './TopBar';

interface AppShellCommonProps {
  groups: readonly NavGroup[];
  activeKey: string;
  onNavigate: (key: string) => void;
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
    children,
    className,
  } = props;

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

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
        onNavigate={(key) => {
          // Selecting an item on a small screen should also dismiss the off-canvas drawer.
          setMobileOpen(false);
          onNavigate(key);
        }}
        user={user}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((value) => !value)}
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
            onToggleSidebar={() => setMobileOpen((value) => !value)}
          />
        )}

        <main className="uboss-content">{children}</main>
      </div>
    </div>
  );
}
