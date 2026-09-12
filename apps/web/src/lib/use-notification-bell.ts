'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { notificationsApi, type NotificationCounts } from './api-client';

export interface NotificationBell {
  counts: NotificationCounts | null;
  /** Spread onto `AppShell` — supplies the badge and the click behaviour. */
  shellProps: {
    unreadNotifications?: number;
    awaitingAcknowledgement?: number;
    onOpenNotifications: () => void;
  };
  /** Re-read the counts, for a screen that has just changed them. */
  refresh: () => void;
}

/**
 * The top-bar bell: its two counts, and where it goes.
 *
 * One hook rather than the same three lines on every screen, because the bell is on **every**
 * authenticated company screen and a per-screen copy would drift — one screen would show a stale
 * count, another would forget the acknowledgement number, and the number that mattered would be
 * the one somebody had not updated.
 *
 * ## Two counts, not one
 *
 * A critical alert is not cleared by being read, so an unread count of zero can still mean
 * somebody must act. The bell shows the unread number as a badge and turns it red while anything
 * is awaiting acknowledgement.
 *
 * ## No polling
 *
 * The counts are read once per screen and again when a screen says they changed. There is no
 * timer and no socket: a poll every few seconds across every open tab is real load for a number
 * that is usually zero, and live push is its own piece of work (Prompts 38–42 own the transport).
 * The consequence is honest and small — a notification raised while somebody sits on one screen
 * appears on their next navigation.
 */
export function useNotificationBell(tenantId: string | null): NotificationBell {
  const router = useRouter();
  const [counts, setCounts] = useState<NotificationCounts | null>(null);

  const refresh = useCallback(() => {
    if (!tenantId) {
      return;
    }
    // A failure is swallowed: a bell that could not load its count must not put an error banner
    // on an unrelated screen.
    void notificationsApi
      .counts(tenantId)
      .then(setCounts)
      .catch(() => undefined);
  }, [tenantId]);

  useEffect(refresh, [refresh]);

  return {
    counts,
    shellProps: {
      ...(counts === null
        ? {}
        : {
            unreadNotifications: counts.unread,
            awaitingAcknowledgement: counts.awaitingAcknowledgement,
          }),
      onOpenNotifications: () => router.push('/notifications'),
    },
    refresh,
  };
}
