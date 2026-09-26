'use client';

import { Icon, SkeletonText } from '@uboss/ui';
import { useEffect, useRef } from 'react';

import type { NotificationItem } from '../lib/api-client';

/**
 * What drops out of the bell.
 *
 * ## Why a panel and not the page
 *
 * The bell used to navigate. That meant losing whatever somebody was doing to find out whether a
 * notification was worth losing it for — so people stopped pressing it. A panel answers the
 * question in place, and the page is one press further on for the times the answer is "yes, show
 * me everything".
 *
 * ## Every row is real
 *
 * The rows are the server's own notifications: its title, its body, its severity, and the deep
 * link it already carries to the exact resource. Nothing here is composed, summarised or
 * invented — if the API returns nothing, the panel says so rather than showing a placeholder.
 *
 * ## Opening a notification marks it read
 *
 * Because it has been. What it does **not** do is acknowledge it: a critical notification that
 * requires an acknowledgement still requires one after it has been read, and that decision belongs
 * on the notification's own screen where the consequence is stated.
 */

const SEVERITY_TONE: Record<NotificationItem['severity'], string> = {
  Critical: 'uboss-notif-row--critical',
  Warning: 'uboss-notif-row--warning',
  Info: 'uboss-notif-row--info',
};

/** How long ago, in the shortest form that is still unambiguous. */
function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function NotificationDropdown({
  items,
  loading,
  unread,
  onOpenItem,
  onViewAll,
  onClose,
}: {
  items: NotificationItem[];
  loading: boolean;
  unread: number;
  onOpenItem: (item: NotificationItem) => void;
  onViewAll: () => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);

  /*
   * Escape closes it, and a press anywhere outside closes it.
   *
   * Both are what somebody expects of a popover, and without them the only way out is the bell
   * itself — which is the one control the panel is covering the neighbourhood of.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointer = (event: MouseEvent) => {
      const node = panel.current;
      if (node === null) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      // The bell is outside the panel and toggles on its own click; ignoring it here would close
      // and immediately reopen.
      if (node.contains(target) || node.parentElement?.contains(target) === true) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [onClose]);

  return (
    <div
      ref={panel}
      className="uboss-notif-panel"
      role="dialog"
      aria-label="Notifications"
      data-testid="notification-dropdown"
    >
      <div className="uboss-notif-head">
        <span className="uboss-notif-title">Notifications</span>
        {unread > 0 ? <span className="uboss-notif-unread">{unread} unread</span> : null}
      </div>

      <div className="uboss-notif-body">
        {loading ? (
          <div className="uboss-notif-loading">
            <SkeletonText lines={4} />
          </div>
        ) : items.length === 0 ? (
          /*
           * Nothing, said plainly. A panel that shows an illustration and three sentences when
           * there is no news is a panel that wasted the press.
           */
          <p className="uboss-notif-empty">Nothing new. You are up to date.</p>
        ) : (
          <ul className="uboss-notif-list">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`uboss-notif-row ${SEVERITY_TONE[item.severity]}${
                    item.read ? '' : ' uboss-notif-row--unread'
                  }`}
                  onClick={() => onOpenItem(item)}
                >
                  <span className="uboss-notif-dot" aria-hidden="true" />
                  <span className="uboss-notif-row-text">
                    <span className="uboss-notif-row-head">
                      <span className="uboss-notif-row-title">{item.title}</span>
                      <span className="uboss-notif-row-time">{ago(item.occurredAt)}</span>
                    </span>
                    <span className="uboss-notif-row-body">{item.body}</span>
                    <span className="uboss-notif-row-meta">
                      <span className="uboss-notif-kind">{item.kindLabel}</span>
                      {item.requiresAcknowledgement && !item.acknowledged ? (
                        <span className="uboss-notif-ack">Needs acknowledgement</span>
                      ) : null}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button type="button" className="uboss-notif-all" onClick={onViewAll}>
        View all notifications
        <Icon name="arrow" size={14} />
      </button>
    </div>
  );
}
