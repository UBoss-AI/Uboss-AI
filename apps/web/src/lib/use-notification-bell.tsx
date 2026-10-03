'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { NotificationDropdown } from '../components/NotificationDropdown';
import { notificationsApi, type NotificationCounts, type NotificationItem } from './api-client';

/**
 * How many rows the panel holds.
 *
 * The client asked for "approximately the latest 15–20". Eighteen is enough to cover a busy day
 * without the panel becoming a page — and the page is one press away for the times it is not.
 */
const PANEL_ROWS = 18;

/**
 * How often the counts are re-read while somebody is actually looking at the screen.
 *
 * A minute, and only on a visible tab. The count is usually zero and a notification is not a
 * trading price: a minute late is invisible to a person and costs one small request, where a
 * five-second poll across a company's open tabs is real load for the same answer.
 */
const COUNT_REFRESH_MS = 60_000;

export interface NotificationBell {
  counts: NotificationCounts | null;
  /** Spread onto `AppShell` — supplies the badge, the click behaviour and the panel. */
  shellProps: {
    unreadNotifications?: number;
    awaitingAcknowledgement?: number;
    onOpenNotifications: () => void;
    notificationPanel: React.ReactNode;
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
 *
 * ## The rows are fetched when the panel opens, not before
 *
 * The bell is on every screen and is pressed on almost none of them. Loading eighteen
 * notifications on every navigation to have them ready would be a request per screen for data
 * nobody asked to see. Opening the panel is the moment somebody asked.
 */
export function useNotificationBell(tenantId: string | null): NotificationBell {
  const router = useRouter();
  const [counts, setCounts] = useState<NotificationCounts | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(false);

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

  // Fetch when it opens, and only then.
  useEffect(() => {
    if (!open || tenantId === null) return;
    setLoading(true);
    void notificationsApi
      .center(tenantId, { take: PANEL_ROWS })
      .then((center) => {
        setItems(center.items);
        /*
         * Opening the bell is reading them, so the badge goes.
         *
         * It used to stay. Somebody opened the panel, read what was there, closed it, and the
         * same number was still sitting on the bell — so the number stopped meaning "there is
         * something new" and started meaning "this company has had notifications", which nobody
         * can act on. A count that never reaches zero is a count people stop looking at.
         *
         * Marked after the rows have arrived, never before: if the panel could not load, nothing
         * was shown and nothing may be called read.
         *
         * `markAllRead` rather than only the rows on screen. The panel holds eighteen and a busy
         * week can have more, and clearing to a remainder would leave a badge that the person
         * cannot clear by any action the panel offers. Nothing is lost by it — the notifications
         * themselves stay, on their own page, under All.
         *
         * What this does **not** touch is `awaitingAcknowledgement`. A critical alert that needs
         * acknowledging still needs it after it has been read, and that decision belongs on the
         * screen that states its consequence. Reading is not acknowledging, which is the entire
         * reason the bell carries two numbers.
         */
        if (center.items.some((item) => !item.read)) {
          void notificationsApi
            .markAllRead(tenantId)
            .then(refresh)
            .catch(() => undefined);
        }
      })
      // A panel that could not load says "nothing new" rather than putting an error on a screen
      // the person was not asking about. The page is still there and will show the failure.
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [open, refresh, tenantId]);

  /*
   * The count comes back when something new arrives, without needing a navigation.
   *
   * There is still no polling loop in the old sense: this re-reads when the tab becomes visible
   * or the window regains focus, which is the moment somebody looks at the screen again, and
   * otherwise once a minute while they are actually looking at it. A hidden tab asks for nothing.
   *
   * Without this, clearing the badge on open made the bell worse rather than better: it would
   * read zero for the rest of the session no matter what happened, because the only thing that
   * refreshed the count was changing screens.
   */
  useEffect(() => {
    if (tenantId === null) return;

    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, COUNT_REFRESH_MS);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
      clearInterval(timer);
    };
  }, [refresh, tenantId]);

  const openItem = useCallback(
    (item: NotificationItem) => {
      setOpen(false);
      /*
       * Marked read because it has been. Not acknowledged: a notification that requires an
       * acknowledgement still requires one, and that decision belongs on its own screen where the
       * consequence is stated.
       */
      if (tenantId !== null && !item.read) {
        void notificationsApi
          .markRead(tenantId, [item.id])
          .then(refresh)
          .catch(() => undefined);
      }
      router.push(item.deepLink);
    },
    [refresh, router, tenantId],
  );

  return {
    counts,
    shellProps: {
      ...(counts === null
        ? {}
        : {
            unreadNotifications: counts.unread,
            awaitingAcknowledgement: counts.awaitingAcknowledgement,
          }),
      onOpenNotifications: () => setOpen((value) => !value),
      notificationPanel: open ? (
        <NotificationDropdown
          items={items}
          loading={loading}
          unread={counts?.unread ?? 0}
          onOpenItem={openItem}
          onViewAll={() => {
            setOpen(false);
            router.push('/notifications');
          }}
          onClose={() => setOpen(false)}
        />
      ) : null,
    },
    refresh,
  };
}
