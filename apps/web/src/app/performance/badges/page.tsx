'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import {
  AppShell,
  Banner,
  Button,
  Card,
  CardBody,
  DataTable,
  Icon,
  MedalBadge,
  PageHeader,
  SkeletonText,
  type DataTableColumn,
} from '@uboss/ui';

import {
  ApiError,
  authApi,
  performanceApi,
  type BadgePeriod,
  type MeResponse,
  type PerformanceView,
} from '../../../lib/api-client';

import { useNotificationBell } from '../../../lib/use-notification-bell';
import { useCompanyNavigation } from '../../../lib/use-company-navigation';

interface BadgeRow {
  id: string;
  from: BadgePeriod['level'] | null;
  to: BadgePeriod['level'];
  date: string;
  score: number;
  reason: string;
  isExitSnapshot: boolean;
  isCurrent: boolean;
}

/**
 * Badge history — every level a person has held in this company, and when.
 *
 * ## Matched to the reference's `badgeHistory()`
 *
 * The same six columns in the same order — From, To, Date, Score, Reason, Policy version — and
 * the same closing notice that a previous employer's final snapshot is read-only to later
 * employers.
 *
 * ## From / To are derived from the periods, not stored
 *
 * The ledger stores *periods* (a level with a start and an end), because "what level were they in
 * March" is the question a review asks and a from/to pair cannot answer it. The transition view
 * the reference shows is a reading of consecutive periods, computed here — which also means a
 * gap can never appear between what one row says they left and what the next says they reached.
 */
function BadgeHistoryPageBody() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const router = useRouter();
  const search = useSearchParams();
  const subjectUserId = search.get('userId');

  const [me, setMe] = useState<MeResponse | null>(null);
  const [view, setView] = useState<PerformanceView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tenantId = me?.activeWorkspaceId ?? me?.workspaces[0]?.tenantId ?? null;
  const bell = useNotificationBell(tenantId);

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

    void (
      subjectUserId === null
        ? performanceApi.mine(tenantId)
        : performanceApi.forUser(tenantId, subjectUserId)
    )
      .then(setView)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load the badge history.'),
      );
  }, [subjectUserId, tenantId]);

  useEffect(load, [load]);

  const activeWorkspace = me?.workspaces.find((workspace) => workspace.tenantId === tenantId);

  /**
   * Oldest first, so each row's "From" is the level of the period before it. The table is then
   * reversed for display: a history reads newest first, but it can only be *built* forwards.
   */
  const rows: BadgeRow[] = (() => {
    const periods = [...(view?.badgeHistory ?? [])].sort(
      (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
    );

    return periods
      .map((period, index) => ({
        id: `${period.level}-${period.startedAt}`,
        from: index === 0 ? null : (periods[index - 1]?.level ?? null),
        to: period.level,
        date: period.startedAt,
        score: period.scoreAtChange,
        reason: period.isExitSnapshot
          ? 'Final snapshot on employment exit'
          : index === 0
            ? 'Onboarding baseline'
            : 'Score crossed the configured threshold',
        isExitSnapshot: period.isExitSnapshot,
        isCurrent: period.endedAt === null,
      }))
      .reverse();
  })();

  const columns: DataTableColumn<BadgeRow>[] = [
    {
      key: 'from',
      header: 'From',
      render: (row) => (row.from === null ? '—' : <MedalBadge tier={row.from} />),
    },
    { key: 'to', header: 'To', render: (row) => <MedalBadge tier={row.to} /> },
    {
      key: 'date',
      header: 'Date',
      render: (row) => (
        <span className="uboss-muted">{new Date(row.date).toLocaleDateString()}</span>
      ),
    },
    { key: 'score', header: 'Score', render: (row) => String(row.score) },
    {
      key: 'reason',
      header: 'Reason',
      render: (row) => (
        <>
          {row.reason}
          {row.isCurrent ? <span className="uboss-muted-3"> · current period</span> : null}
        </>
      ),
    },
    {
      key: 'policy',
      header: 'Policy version',
      render: () => (
        // The period does not store a policy version: a level is a reading of the policy active
        // when it is read, and stamping one on a period would imply the level was frozen under
        // it. The *events* carry their version, which is where the points came from.
        <span className="uboss-muted-3">v{view?.policyVersion ?? '—'} (current)</span>
      ),
    },
  ];

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="performance"
      onNavigate={() => undefined}
      {...bell.shellProps}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Performance' }}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Badge history"
        description="Every level held in this company, and what earned it."
        breadcrumbs={[{ label: 'Performance', href: '/performance' }, { label: 'Badges' }]}
        actions={
          <Button
            onClick={() =>
              router.push(
                subjectUserId === null
                  ? '/performance'
                  : `/performance?userId=${encodeURIComponent(subjectUserId)}`,
              )
            }
          >
            <Icon name="back" size={16} /> Back
          </Button>
        }
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      {view === null ? (
        error === null ? (
          <Card>
            <CardBody>
              <SkeletonText lines={5} />
            </CardBody>
          </Card>
        ) : null
      ) : (
        <>
          <DataTable
            caption="Badge history — every level held in this company"
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            emptyTitle="No badge periods yet"
            emptyDescription="One opens as soon as the first governed event is scored."
          />

          <p className="uboss-notice">
            <Icon name="shield" size={14} /> A previous employer&apos;s final snapshot is read-only
            to later employers. A score belongs to the employment that produced it: this history is
            this company&apos;s, it is never transferred to a successor, and offboarding freezes it
            rather than deleting it.
          </p>
        </>
      )}
    </AppShell>
  );
}

/**
 * `useSearchParams` requires a Suspense boundary: Next.js has to be able to render the shell before
 * the request's query string is known. Without one the production build fails outright rather
 * than degrading, so the boundary is the page and the screen is its child.
 */
export default function BadgeHistoryPage() {
  return (
    <Suspense fallback={null}>
      <BadgeHistoryPageBody />
    </Suspense>
  );
}
