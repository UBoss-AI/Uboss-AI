'use client';

import { useRouter } from 'next/navigation';

import { Button, EmptyState, Icon, StatusBadge } from '@uboss/ui';

import { SEVERITY_LABELS, SEVERITY_TONES } from '@uboss/types';

import type { NotificationItem } from '../lib/api-client';

export interface NotificationListProps {
  items: NotificationItem[];
  /** Called after a row is opened, so the caller can mark it read and refresh its counts. */
  onOpen: (item: NotificationItem) => void;
  onAcknowledge: (item: NotificationItem) => void;
  emptyTitle: string;
  emptyDescription: string;
}

/** `3 minutes ago`. Relative, because "when" is the only thing a notification list is sorted by. */
function relative(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  return new Date(iso).toLocaleDateString();
}

/**
 * The list of notifications, shared by the bell's drawer and the full centre page.
 *
 * One component because the two surfaces show the same rows with the same behaviour, and two
 * implementations would drift — the drawer would end up missing the acknowledgement control, and
 * the acknowledgement control is the whole reason a critical alert exists.
 *
 * ## The whole row is the link
 *
 * A notification's deep link is its point. "Something needs you" with no route to it is worse
 * than silence, so the row navigates and opening it marks it read — which is the natural reading
 * of having opened something.
 *
 * ## Acknowledgement is a separate, deliberate act
 *
 * A critical item keeps its **Acknowledge** button until somebody presses it, and reading it does
 * not clear it. That is the client's rule and it is also the only honest design: a person who
 * scrolled past an alert has not seen it.
 */
export function NotificationList({
  items,
  onOpen,
  onAcknowledge,
  emptyTitle,
  emptyDescription,
}: NotificationListProps) {
  const router = useRouter();

  if (items.length === 0) {
    return <EmptyState icon="bell" title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div>
      {items.map((item) => {
        const urgent = item.requiresAcknowledgement && !item.acknowledged;

        return (
          <div key={item.id}>
            <button
              type="button"
              className={[
                'uboss-notice-row',
                item.read ? '' : 'uboss-notice-row--unread',
                urgent ? 'uboss-notice-row--urgent' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => {
                onOpen(item);
                router.push(item.deepLink);
              }}
            >
              <span aria-hidden="true">
                <Icon name={item.severity === 'Critical' ? 'alert' : 'bell'} size={16} />
              </span>

              <span className="uboss-notice-row-main">
                <span className="uboss-notice-row-title">{item.title}</span>
                <span className="uboss-notice-row-body">{item.body}</span>

                <span className="uboss-notice-row-meta">
                  <StatusBadge
                    status={SEVERITY_LABELS[item.severity]}
                    tone={SEVERITY_TONES[item.severity]}
                  />
                  <span>{item.kindLabel}</span>
                  <span>·</span>
                  <span>{relative(item.occurredAt)}</span>
                  {item.isAssignedToRecipient ? (
                    <StatusBadge status="Assigned to you" tone="blue" dot={false} />
                  ) : null}
                  {item.escalated ? (
                    // The original, after it was escalated. Still theirs, and still visible:
                    // escalating tells somebody else, it does not take the item away.
                    <StatusBadge status="Escalated" tone="warn" dot={false} />
                  ) : null}
                  {item.escalatedFromId !== null ? (
                    <StatusBadge status="Escalated to you" tone="purple" dot={false} />
                  ) : null}
                  {item.isMandatory ? (
                    <span className="uboss-muted-3">Cannot be turned off</span>
                  ) : null}
                  {!item.read ? <StatusBadge status="Unread" tone="blue" /> : null}
                </span>
              </span>
            </button>

            {urgent ? (
              <div className="uboss-actions" style={{ margin: '-2px 0 10px 14px' }}>
                <Button variant="primary" onClick={() => onAcknowledge(item)}>
                  Acknowledge
                </Button>
                <span className="uboss-muted-3" style={{ fontSize: 12 }}>
                  Reading this does not clear it — somebody has to say they have seen it.
                </span>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
