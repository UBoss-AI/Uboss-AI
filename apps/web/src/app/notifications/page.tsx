'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  AppShell,
  Banner,
  Button,
  Card,
  CardBody,
  PageHeader,
  SkeletonText,
  Tabs,
} from '@uboss/ui';

import { NOTIFICATION_KIND_DEFINITIONS } from '@uboss/types';

import { NotificationList } from '../../components/NotificationList';
import { useCompanyNavigation } from '../../lib/use-company-navigation';
import {
  ApiError,
  authApi,
  notificationsApi,
  type MeResponse,
  type NotificationCenter,
  type NotificationItem,
} from '../../lib/api-client';

/** The four views the client's list of required features implies. */
const TABS = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'assigned', label: 'Assigned to me' },
  { id: 'acknowledge', label: 'Needs acknowledgement' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/**
 * The Notification Center.
 *
 * ## There is no counterpart in the approved reference
 *
 * The prototype's bell navigates to the To-do list — one of its orphaned-screen defects, since it
 * defines no notification screen at all. The pack requires a centre page and a drawer, so this
 * screen is built from the required feature list in the pack, using the approved design system
 * rather than inventing a look: `AppShell`, `Tabs`, `Card`, `StatusBadge`, and the medal-free
 * severity tones already in the tokens.
 *
 * ## Four tabs, because there are four questions
 *
 * "What is new", "what have I not read", "what is waiting on **me**", and "what must I
 * acknowledge". The last two are genuinely different: an alert can need acknowledging when
 * nothing is unread, because reading does not clear it — which is exactly why the bell carries
 * two numbers.
 *
 * ## History is the default view
 *
 * "All" includes what has been read and acknowledged, because the client requires history. A
 * centre that emptied as you read it would answer "what happened last Tuesday" with silence.
 */
export default function NotificationCenterPage() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [tab, setTab] = useState<TabId>('all');
  const [center, setCenter] = useState<NotificationCenter | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const tenantId = me?.activeWorkspaceId ?? me?.workspaces[0]?.tenantId ?? null;

  useEffect(() => {
    authApi
      .me()
      .then(setMe)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load your workspaces.'),
      );
  }, []);

  const load = useCallback(() => {
    if (!tenantId) {
      return;
    }
    setError(null);

    void notificationsApi
      .center(tenantId, {
        ...(tab === 'unread' ? { unread: true } : {}),
        ...(tab === 'assigned' ? { assignedToMe: true } : {}),
        ...(tab === 'acknowledge' ? { awaitingAcknowledgement: true } : {}),
        take: 100,
      })
      .then(setCenter)
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError ? caught.message : 'Could not load your notifications.',
        ),
      );
  }, [tab, tenantId]);

  useEffect(load, [load]);

  const open = useCallback(
    (item: NotificationItem) => {
      if (!tenantId || item.read) {
        return;
      }
      // Marked read on open, then the counts refresh. Not awaited: navigation should not wait on
      // a housekeeping write, and a failure here costs an unread badge, not the notification.
      void notificationsApi.markRead(tenantId, [item.id]).catch(() => undefined);
    },
    [tenantId],
  );

  const acknowledge = useCallback(
    (item: NotificationItem) => {
      if (!tenantId) {
        return;
      }
      void notificationsApi
        .acknowledge(tenantId, item.id)
        .then(() => {
          setNotice('Acknowledged.');
          load();
        })
        .catch((caught: unknown) =>
          setError(caught instanceof ApiError ? caught.message : 'Could not acknowledge that.'),
        );
    },
    [load, tenantId],
  );

  const markAllRead = useCallback(() => {
    if (!tenantId) {
      return;
    }
    void notificationsApi
      .markAllRead(tenantId)
      .then((result) => {
        setNotice(result.note);
        load();
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not mark those read.'),
      );
  }, [load, tenantId]);

  const activeWorkspace = me?.workspaces.find((workspace) => workspace.tenantId === tenantId);
  const counts = center?.counts;

  /** Kinds that cannot fire yet, named rather than implied to be live. */
  const notYetProduced = NOTIFICATION_KIND_DEFINITIONS.filter(
    (definition) => !definition.producedBy.startsWith('live'),
  );

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="dashboard"
      onNavigate={() => undefined}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Notifications' }}
      {...(counts === undefined
        ? {}
        : {
            unreadNotifications: counts.unread,
            awaitingAcknowledgement: counts.awaitingAcknowledgement,
          })}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Notifications"
        description="Everything waiting on you, and everything you have been told."
        breadcrumbs={[{ label: 'Notifications' }]}
        actions={
          <Button onClick={markAllRead} disabled={(counts?.unread ?? 0) === 0}>
            Mark all read
          </Button>
        }
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="ok">{notice}</Banner> : null}

      {counts !== undefined && counts.awaitingAcknowledgement > 0 ? (
        <Banner tone="warn">
          {counts.awaitingAcknowledgement} critical alert
          {counts.awaitingAcknowledgement === 1 ? '' : 's'} need acknowledging. These cannot be
          turned off and are not cleared by being read.
        </Banner>
      ) : null}

      <Card>
        <CardBody>
          <Tabs
            label="Notification views"
            items={TABS.map((item) => ({ id: item.id, label: item.label }))}
            activeId={tab}
            onChange={(id) => setTab(id as TabId)}
          />

          {center === null ? (
            error === null ? (
              <SkeletonText lines={6} />
            ) : null
          ) : (
            <NotificationList
              items={center.items}
              onOpen={open}
              onAcknowledge={acknowledge}
              emptyTitle={
                tab === 'acknowledge'
                  ? 'Nothing needs acknowledging'
                  : tab === 'assigned'
                    ? 'Nothing is assigned to you'
                    : tab === 'unread'
                      ? 'Nothing unread'
                      : 'No notifications yet'
              }
              emptyDescription={
                tab === 'all'
                  ? 'Invitations, approvals waiting on you, overdue work, connection expiry, ' +
                    'budget thresholds and security alerts appear here.'
                  : 'Switch to All to see everything, including what you have already read.'
              }
            />
          )}
        </CardBody>
      </Card>

      {notYetProduced.length > 0 ? (
        <Card>
          <CardBody>
            <div className="uboss-section-label">Sources not yet producing notifications</div>
            <ul className="uboss-muted-3">
              {notYetProduced.map((definition) => (
                <li key={definition.kind}>
                  <b>{definition.label}</b> — the engine is complete and these will appear as soon
                  as the module that raises them exists ({definition.producedBy}). Their preference
                  controls already work.
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </AppShell>
  );
}
