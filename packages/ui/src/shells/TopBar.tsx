'use client';

import { cn } from '../lib/class-names';
import { Icon } from '../primitives/Icon';
import { SearchField } from '../primitives/SearchField';
import { AccountMenu, type AccountMenuItem } from './AccountMenu';
import type { SidebarUser } from './Sidebar';

/**
 * The bar reads `{Section} | {Active Workspace Name}` on company screens.
 *
 * ## What changed, and why it is worth saying
 *
 * It used to read `UBOSS AI AMS | {Active Workspace Name}`, and that wording was a locked rule
 * from the approved reference. The client asked for the product name to give up that slot to the
 * name of the section the person is actually in, because every screen was announcing itself twice
 * — once here and again in the page heading immediately below.
 *
 * The workspace name stays, so the bar still answers "whose data am I looking at". The product
 * name has not left the screen either: the sidebar's header carries `UBOSS AI AMS` above the same
 * workspace name, which is where it now lives.
 *
 * The variant is a discriminated union so it is impossible to render a company header without
 * supplying the active workspace name.
 */
export type TopBarProps = (
  { variant: 'company'; workspaceName: string } | { variant: 'master' }
) & {
  /**
   * The section the person is in — "Dashboard", "Hierarchy", "Agent Builder".
   *
   * Rendered as the page's `h1`, because it is the page's name and a screen needs exactly one.
   * Absent means the caller could not work out where it is, and the bar then shows the workspace
   * name alone rather than an empty slot or a guess.
   */
  sectionName?: string | undefined;
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
  /**
   * What drops out of the bell, rendered by whoever has the notifications.
   *
   * This package has no API and no business knowing what a notification is, so the panel arrives
   * as a node and this component only decides *where* it hangs. `null` means closed — the panel is
   * not in the document at all rather than hidden, so nothing behind it is focusable.
   */
  notificationPanel?: React.ReactNode;
  /** Signed-in identity, shown as the avatar at the end of the bar. */
  user?: SidebarUser | undefined;
  /** Ends the session. Rendered as the separated last entry of the account menu. */
  onSignOut?: (() => void) | undefined;
  /**
   * Entries above the separator in the account menu — Profile, Settings, Appearance, and Switch
   * workspace where the person actually holds more than one membership.
   *
   * The host supplies these because only the host knows which of them exist and where they go.
   * Nothing is offered that does not work: that is the whole point of it being a parameter rather
   * than a fixed list in here.
   */
  accountMenu?: readonly AccountMenuItem[] | undefined;
  /**
   * Runs a workspace-wide search. **Absent means there is none**, and the field renders disabled
   * with a reason rather than accepting text and discarding it.
   *
   * It had no handler at all: a prominent box on every screen, on which you could type "Priya" and
   * press Enter, and nothing whatever happened. There is no cross-entity search endpoint to wire
   * it to — only chat has one — so the field says so until there is.
   */
  onSearch?: ((query: string) => void) | undefined;
  /** Shown only on small screens, to open the off-canvas sidebar. */
  onToggleSidebar?: (() => void) | undefined;
  className?: string | undefined;
};

/**
 * The product name. No longer in the top bar — the sidebar's header renders it — and kept exported
 * because that is where the tests and the design-system page name it from.
 */
export const COMPANY_HEADER_PREFIX = 'UBOSS AI AMS';
export const MASTER_HEADER_LABEL = 'UBoss Master Console';

export function TopBar(props: TopBarProps) {
  const {
    sectionName,
    scopeLabel,
    hasNotifications = false,
    unreadNotifications = 0,
    awaitingAcknowledgement = 0,
    onOpenNotifications,
    notificationPanel,
    onToggleSidebar,
    user,
    onSignOut,
    accountMenu,
    onSearch,
    className,
  } = props;

  // Sign out is always last and always below the separator, whatever the host passes.
  const accountMenuItems: AccountMenuItem[] = [
    ...(accountMenu ?? []),
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
  ];
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
        {/*
          The section name is the page's heading, so it is an h1 and not a styled div.

          Moving the name up here would otherwise have left every screen in the product without a
          top-level heading at all — the page heading below it is the element being removed. There
          is still exactly one per screen, because there is one bar per screen.
        */}
        {sectionName === undefined ? null : <h1 className="uboss-ws-mark-section">{sectionName}</h1>}

        {isMaster && sectionName === undefined ? MASTER_HEADER_LABEL : null}

        {isMaster ? null : (
          <>
            {/* No pipe without something on both sides of it. */}
            {sectionName === undefined ? null : (
              <span className="uboss-ws-mark-pipe" aria-hidden="true">
                |
              </span>
            )}
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
          onSearch === undefined
            ? 'Search is not available yet'
            : isMaster
              ? 'Search companies, users, invoices'
              : 'Search people, objectives, agents'
        }
        disabled={onSearch === undefined}
        {...(onSearch === undefined
          ? {
              title:
                'Workspace-wide search is not built yet. Each screen has its own filter, and people can be looked up on UBoss Profile Search.',
            }
          : {
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                onSearch(event.currentTarget.value.trim());
              },
            })}
      />

      <div className="uboss-top-actions">
        {/*
          The bell and whatever hangs off it, in one positioned box.

          The panel is anchored to the button rather than to the bar, so it stays under the bell at
          every width instead of drifting as the bar's contents reflow.
        */}
        <div className="uboss-bell-anchor">
        <button
          type="button"
          className="uboss-icon-btn"
          onClick={onOpenNotifications}
          aria-haspopup="dialog"
          aria-expanded={notificationPanel != null}
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

        {notificationPanel}
        </div>

        {/*
          The avatar is the account control, and the only way out of the session.

          It used to be a key-icon button sitting beside the notification bell, with the avatar next
          to it as an inert aria-hidden div — so the control that ends your session looked like a
          permissions glyph and was one mis-click from the bell, while the thing that looks like a
          profile did nothing. Sign out now lives below a separator inside the menu.
        */}
        {user ? <AccountMenu user={user} scopeLabel={scopeLabel} items={accountMenuItems} /> : null}
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
