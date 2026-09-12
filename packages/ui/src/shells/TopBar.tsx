'use client';

import { cn } from '../lib/class-names';
import { initials } from '../lib/initials';
import { Icon } from '../primitives/Icon';
import { SearchField } from '../primitives/SearchField';
import type { SidebarUser } from './Sidebar';

/**
 * Company workspaces MUST show `UBOSS AI AMS | {Active Workspace Name}` in the header
 * (locked rule). The Master Console is a separate platform control plane and shows its own
 * identity instead of a tenant name.
 *
 * The variant is a discriminated union so it is impossible to render a company header without
 * supplying the active workspace name.
 */
export type TopBarProps = (
  { variant: 'company'; workspaceName: string } | { variant: 'master' }
) & {
  /** Role and scope, shown as a pill, e.g. "Company Admin · Whole company". */
  scopeLabel?: string | undefined;
  /** Unread notification indicator. Kept for the case where only "something is waiting" is known. */
  hasNotifications?: boolean | undefined;
  /**
   * How many are unread. Rendered as a **badge**, never concatenated into the label — a locked
   * UI rule, and "Notifications 4" read aloud by a screen reader is worse than either.
   */
  unreadNotifications?: number | undefined;
  /**
   * How many need acknowledging. Shown as a distinct marker because a critical alert is not
   * cleared by being looked at, so an unread count of zero can still mean somebody must act.
   */
  awaitingAcknowledgement?: number | undefined;
  onOpenNotifications?: (() => void) | undefined;
  /** Signed-in identity, shown as the avatar at the end of the bar. */
  user?: SidebarUser | undefined;
  /** Ends the session. The reference puts a sign-out control here as well as in the sidebar. */
  onSignOut?: (() => void) | undefined;
  /** Shown only on small screens, to open the off-canvas sidebar. */
  onToggleSidebar?: (() => void) | undefined;
  className?: string | undefined;
};

export const COMPANY_HEADER_PREFIX = 'UBOSS AI AMS';
export const MASTER_HEADER_LABEL = 'UBoss Master Console';

export function TopBar(props: TopBarProps) {
  const {
    scopeLabel,
    hasNotifications = false,
    unreadNotifications = 0,
    awaitingAcknowledgement = 0,
    onOpenNotifications,
    onToggleSidebar,
    user,
    onSignOut,
    className,
  } = props;
  const isMaster = props.variant === 'master';

  return (
    <header className={cn('uboss-topbar', className)}>
      {onToggleSidebar ? (
        <button
          type="button"
          className="uboss-icon-btn uboss-menu-btn"
          onClick={onToggleSidebar}
          aria-label="Open navigation"
        >
          <Icon name="list" size={18} />
        </button>
      ) : null}

      <div className="uboss-ws-mark">
        {isMaster ? (
          MASTER_HEADER_LABEL
        ) : (
          <>
            {COMPANY_HEADER_PREFIX}
            <span className="uboss-ws-mark-pipe" aria-hidden="true">
              |
            </span>
            <span className="uboss-ws-mark-name">{props.workspaceName}</span>
          </>
        )}
      </div>

      {scopeLabel ? (
        <span className="uboss-scope-pill">
          <Icon name="shield" size={12} /> {scopeLabel}
        </span>
      ) : null}

      <SearchField
        label={isMaster ? 'Search companies, users, invoices' : 'Search people, objectives, agents'}
        placeholder={
          isMaster ? 'Search companies, users, invoices' : 'Search people, objectives, agents'
        }
      />

      <div className="uboss-top-actions">
        <button
          type="button"
          className="uboss-icon-btn"
          onClick={onOpenNotifications}
          aria-label={notificationLabel(
            unreadNotifications,
            awaitingAcknowledgement,
            hasNotifications,
          )}
        >
          <Icon name="bell" size={18} />
          {unreadNotifications > 0 ? (
            <span
              className={cn(
                'uboss-icon-btn-count',
                awaitingAcknowledgement > 0 && 'uboss-icon-btn-count--urgent',
              )}
              aria-hidden="true"
            >
              {unreadNotifications > 99 ? '99+' : unreadNotifications}
            </span>
          ) : awaitingAcknowledgement > 0 || hasNotifications ? (
            // Nothing unread, but something still needs acknowledging — or the caller only knows
            // that something is waiting. A dot rather than a "0", which would read as "nothing".
            <span className="uboss-icon-btn-dot" aria-hidden="true" />
          ) : null}
        </button>

        {onSignOut ? (
          <button
            type="button"
            className="uboss-icon-btn"
            onClick={onSignOut}
            title="Sign out"
            aria-label="Sign out"
          >
            <Icon name="key" size={18} />
          </button>
        ) : null}

        {user ? (
          <div className="uboss-avatar" title={user.name} aria-hidden="true">
            {initials(user.name)}
          </div>
        ) : null}
      </div>
    </header>
  );
}

/**
 * The bell's accessible name.
 *
 * The count is a visual badge, so the number has to reach a screen reader some other way — and
 * "needs acknowledgement" has to be sayable, because that is the state a person must act on even
 * when nothing is unread.
 */
function notificationLabel(unread: number, awaiting: number, hasSomething: boolean): string {
  const parts: string[] = [];
  if (unread > 0) {
    parts.push(`${unread} unread`);
  }
  if (awaiting > 0) {
    parts.push(`${awaiting} needing acknowledgement`);
  }
  if (parts.length === 0) {
    return hasSomething ? 'Notifications, unread' : 'Notifications';
  }
  return `Notifications: ${parts.join(', ')}`;
}
