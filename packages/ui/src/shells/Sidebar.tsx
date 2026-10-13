'use client';

import { motion } from 'motion/react';
import type { MouseEvent } from 'react';

import { cn } from '../lib/class-names';
import { transition } from '../motion/motion';
import { initials } from '../lib/initials';
import type { NavGroup } from '../navigation/navigation-model';
import { Icon } from '../primitives/Icon';
import { AccountMenu, type AccountMenuItem } from './AccountMenu';

export interface SidebarUser {
  name: string;
  /** Role label, e.g. "Company Admin" or "Platform Admin". */
  role: string;
}

export interface SidebarProps {
  /** Brand line. Company workspaces show "CXO"; the Master Console shows "UBoss". */
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
  /**
   * Settings, as an icon beside the person rather than an item in the menu.
   *
   * It was the only entry left in its own navigation group — a heading above a single line —
   * and it is not work the way the entries above it are: nobody opens Settings as a task, they
   * open it to change something about themselves or the company. That is the same place the
   * name and Sign out already live, so it sits there, at the size of a control rather than a
   * destination.
   *
   * Icon only, with the word in a tooltip: the footer has room for one line of text and the
   * person's name has the better claim on it.
   */
  settings?: { href: string; label: string } | undefined;
  /**
   * The person's own menu, behind the footer avatar.
   *
   * The same list the top bar's avatar opens — passed rather than rebuilt, because two menus
   * claiming to be "your account" that drift apart is worse than either of them. When it is
   * given, it replaces the footer's name, Sign out and Settings gear: all three live inside it.
   *
   * Omitted by a shell that builds its own chrome, and then the footer renders as it always did.
   */
  accountMenu?: readonly AccountMenuItem[] | undefined;
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
  settings,
  accountMenu,
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
            {/*
              A group of one is not a group.

              The sidebar is built from what each person may actually see, so a group often
              collapses to a single item — and an Employee, who may see one thing under
              Operations, was shown the heading "OPERATIONS" with "To-do List" underneath it: two
              names, one on top of the other, for one place. It reads as a category that failed to
              load the rest of itself.

              Hidden by count rather than by naming the groups, because which groups collapse
              depends entirely on the reader's grants. The heading comes back by itself the moment
              a second item does.
            */}
            {group.items.length > 1 ? <div className="uboss-nav-group">{group.group}</div> : null}
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

      {/*
        One profile control, with everything that belongs to a person inside it.

        It used to be three things in a row: an avatar that was decoration, the name with Sign out
        under it, and a gear at the far end — a second way to reach Settings, which the account
        menu in the top bar has always had. Collapsed, the name and Sign out are hidden and the
        avatar and the gear were left squeezed into a 56px rail, which is what was reported.

        The avatar is the control now, and it opens the same menu the top bar's does: My Profile,
        Settings, Appearance, workspaces and Sign out, from the same list. So the gear is gone
        rather than hidden — the duplicate was the problem, not its position — and collapsed there
        is one round avatar where there were two half-fitting controls.

        The caller passes the items. Where it does not — the Master Console builds its own
        chrome — the footer stays as it was, which is why the old markup is still here below.
      */}
      <div className="uboss-side-foot">
        {accountMenu !== undefined && accountMenu.length > 0 ? (
          <AccountMenu
            className="uboss-side-foot-account"
            user={user}
            {...(user.role === undefined ? {} : { scopeLabel: user.role })}
            /*
              Sign out appended here, exactly as the top bar does it.

              The host's list deliberately leaves it out — "Sign out is not here: TopBar appends
              it" — so a menu that only spread the host's items would offer Profile, Settings and
              Appearance and no way to leave. Last and below the separator, which is what the
              audit brief asks for: the one control that ends a session should not sit a pixel
              from the one that changes a theme.
            */
            items={[
              ...accountMenu,
              ...(onSignOut
                ? [
                    {
                      key: 'sign-out',
                      label: 'Sign out',
                      icon: 'key' as const,
                      onSelect: onSignOut,
                      separated: true,
                    },
                  ]
                : []),
            ]}
          />
        ) : (
          <>
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

            {settings === undefined ? null : (
              <a
                className="uboss-side-foot-settings"
                href={settings.href}
                title={settings.label}
                aria-label={settings.label}
                onClick={(event) => onNavigate?.('settings', settings.href, event)}
              >
                <Icon name="gear" size={17} />
              </a>
            )}
          </>
        )}
      </div>
    </nav>
  );
}
