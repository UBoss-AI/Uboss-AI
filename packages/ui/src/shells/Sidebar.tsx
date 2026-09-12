'use client';

import { cn } from '../lib/class-names';
import { initials } from '../lib/initials';
import type { NavGroup } from '../navigation/navigation-model';
import { Icon } from '../primitives/Icon';

export interface SidebarUser {
  name: string;
  /** Role label, e.g. "Company Admin" or "Platform Admin". */
  role: string;
}

export interface SidebarProps {
  /** Brand line. Company workspaces show "UBOSS AI AMS"; the Master Console shows "UBoss". */
  brand: string;
  /** Secondary brand line: the workspace name, or "Master Console". */
  brandSub: string;
  groups: readonly NavGroup[];
  /** Key of the active nav item. */
  activeKey: string;
  onNavigate: (key: string) => void;
  user: SidebarUser;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Ends the session. The reference's sidebar footer carries a Sign out action. */
  onSignOut?: (() => void) | undefined;
  /** Open state on small screens, where the sidebar becomes an off-canvas drawer. */
  open?: boolean;
  className?: string;
}

/**
 * The application sidebar, shared by both shells.
 *
 * Navigation is presentation only: the items a user sees are chosen server-side from their
 * permitted modules, and every route is separately guarded. Hiding an item is never the
 * access control.
 */
export function Sidebar({
  brand,
  brandSub,
  groups,
  activeKey,
  onNavigate,
  user,
  collapsed = false,
  onToggleCollapse,
  onSignOut,
  open = false,
  className,
}: SidebarProps) {
  return (
    // A <nav> landmark, not <aside>: this is the primary navigation, so it must expose the
    // navigation role to assistive technology rather than "complementary".
    <nav
      className={cn('uboss-sidebar', open && 'uboss-sidebar--open', className)}
      aria-label="Primary"
    >
      <div className="uboss-side-brand">
        <div className="uboss-side-logo" aria-hidden="true">
          U
        </div>
        <div className="uboss-side-brand-text">
          <b>{brand}</b>
          <span>{brandSub}</span>
        </div>
        {onToggleCollapse ? (
          <button
            type="button"
            className="uboss-sidebar-toggle"
            onClick={onToggleCollapse}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-pressed={collapsed}
          >
            <Icon name="panel" size={16} />
          </button>
        ) : null}
      </div>

      <div className="uboss-side-scroll">
        {groups.map((group) => (
          <div key={group.group}>
            <div className="uboss-nav-group">{group.group}</div>
            {group.items.map((item) => {
              const active = item.key === activeKey;

              return (
                <button
                  key={item.key}
                  type="button"
                  className={cn('uboss-nav-item', active && 'uboss-nav-item--active')}
                  aria-current={active ? 'page' : undefined}
                  // The label is hidden when collapsed, so keep it as the accessible name.
                  title={item.label}
                  aria-label={collapsed ? item.label : undefined}
                  onClick={() => onNavigate(item.key)}
                >
                  <span className="uboss-nav-icon">
                    <Icon name={item.icon} size={18} />
                  </span>
                  <span className="uboss-nav-label">{item.label}</span>
                  {item.badge !== undefined && item.badge > 0 ? (
                    <span className="uboss-nav-badge">
                      {item.badge}
                      <span className="uboss-sr-only"> pending</span>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="uboss-side-foot">
        <div className="uboss-avatar" aria-hidden="true">
          {initials(user.name)}
        </div>
        <div className="uboss-stack uboss-side-foot-stack">
          <b className="uboss-side-foot-name">{user.name}</b>
          {/* The reference's footer puts a sign-out control on this second line; the role it
              shows there instead is carried by the top bar's scope pill. */}
          {onSignOut ? (
            <button type="button" className="uboss-side-foot-signout" onClick={onSignOut}>
              Sign out
            </button>
          ) : (
            <span className="uboss-side-foot-role">{user.role}</span>
          )}
        </div>
      </div>
    </nav>
  );
}
