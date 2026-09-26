'use client';

import { motion } from 'motion/react';
import type { MouseEvent } from 'react';

import { cn } from '../lib/class-names';
import { transition } from '../motion/motion';
import { initials } from '../lib/initials';
import type { NavGroup } from '../navigation/navigation-model';
import { Icon } from '../primitives/Icon';

export interface SidebarUser {
  name: string;
  /** Role label, e.g. "Company Admin" or "Platform Admin". */
  role: string;
}

export interface SidebarProps {
  /** Brand line. Company workspaces show "UBOSS AI Chief Agent"; the Master Console shows "UBoss". */
  brand: string;
  /** Secondary brand line: the workspace name, or "Master Console". */
  brandSub: string;
  groups: readonly NavGroup[];
  /** Key of the active nav item. */
  activeKey: string;
  /**
   * Told which item was chosen, with the event so a host can take the navigation over — a router
   * calls `preventDefault()` and pushes, turning the link into a client-side transition.
   *
   * Optional, and deliberately **not** how navigation happens: an item with an `href` is a real
   * link and still works if this is absent, missing, or throws. The worst case is a full page load
   * instead of a soft one, rather than a control that silently does nothing.
   */
  onNavigate?:
    ((key: string, href: string | undefined, event: MouseEvent<HTMLElement>) => void) | undefined;
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

              const inner = (
                <>
                  {/*
                    The selected state, as one element that moves between items rather than one
                    that switches off here and on there. `layoutId` is what makes the highlight
                    travel: Motion measures where it was, where it is now, and animates between
                    them, so choosing a different screen reads as the selection moving rather than
                    as two separate things blinking.

                    It sits behind the label and is `aria-hidden` — the fact that carries meaning
                    is `aria-current="page"` on the item, which is unaffected by any of this.
                  */}
                  {active ? (
                    <motion.span
                      layoutId="uboss-nav-selected"
                      className="uboss-nav-indicator"
                      aria-hidden="true"
                      transition={transition('panel', 'standard')}
                    />
                  ) : null}
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
                </>
              );

              const shared = {
                className: cn('uboss-nav-item', active && 'uboss-nav-item--active'),
                'aria-current': active ? ('page' as const) : undefined,
                // The label is hidden when collapsed, so keep it as the accessible name.
                title: item.label,
                'aria-label': collapsed ? item.label : undefined,
              };

              // An item that knows where it goes is a link, and has to be a real one. A <button>
              // cannot be opened in a new tab, middle-clicked, copied, or reached by a screen
              // reader's link list, and — as this product demonstrated — it silently does nothing
              // at all if the host forgets to wire `onNavigate`. A missing href on an <a> is a
              // visible defect; a no-op click handler is an invisible one.
              return item.href !== undefined ? (
                <a
                  key={item.key}
                  href={item.href}
                  {...shared}
                  // Still announced, so a host that needs to react — closing the mobile drawer —
                  // can, without the navigation itself depending on it.
                  onClick={(event) => onNavigate?.(item.key, item.href, event)}
                >
                  {inner}
                </a>
              ) : (
                <button
                  key={item.key}
                  type="button"
                  {...shared}
                  onClick={(event) => onNavigate?.(item.key, item.href, event)}
                >
                  {inner}
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
