'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import {
  AppShell,
  Banner,
  Card,
  CardBody,
  DonutDashboard,
  PageHeader,
  SkeletonText,
} from '@uboss/ui';

import {
  ApiError,
  authApi,
  dashboardApi,
  type DashboardMeta,
  type DashboardView,
  type MeResponse,
} from '../../lib/api-client';
import { useNotificationBell } from '../../lib/use-notification-bell';
import { useCompanyNavigation } from '../../lib/use-company-navigation';

/**
 * The Company Workspace Dashboard — Prompt 37, and a locked contract.
 *
 * > Exactly one donut/pie chart with **two slices only**: Agents and Pending Jobs. Counts must use
 * > the logged-in user's backend-authorized scope. Click Agents → Engine Agent detail/list. Click
 * > Pending Jobs → permitted pending work detail. Detail screens provide a clear return to
 * > Dashboard. **Do not** show KPI cards, report tables, cost/token cards, notification lists,
 * > hierarchy summaries or performance details.
 *
 * ## What is deliberately not on this page
 *
 * Everything else. There is no `MetricCard` here, no table, no cost figure and no notification
 * list — and this comment exists because the way this screen erodes is that somebody adds one
 * useful thing at a time, each defensible on its own. The Reports section in the Operations group
 * is where all of that lives, and the Master Console dashboard is a separate screen that keeps its
 * platform KPI cards.
 *
 * The one piece of text under the donut is the **scope sentence** from the server: "Your own work
 * only", "You and everyone who reports to you", "The whole company". It is not a KPI; it is the
 * legend. Without it a manager and an employee see two different numbers with no way to tell why.
 *
 * ## The counts come from the server, scoped there
 *
 * `GET /dashboard` resolves the signed-in person's authorized scope and counts within it. This
 * page sends no filter, because there is no filter it could send that the server would honour.
 */
export default function DashboardPage(): React.JSX.Element {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const router = useRouter();

  const [me, setMe] = useState<MeResponse | null>(null);
  const [counts, setCounts] = useState<DashboardView | null>(null);
  const [meta, setMeta] = useState<DashboardMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tenantId = me?.activeWorkspaceId ?? me?.workspaces[0]?.tenantId ?? null;
  const activeWorkspace = me?.workspaces.find((workspace) => workspace.tenantId === tenantId);
  const bell = useNotificationBell(tenantId);

  useEffect(() => {
    authApi
      .me()
      .then(setMe)
      .catch(() => window.location.assign('/login'));
  }, []);

  const load = useCallback(() => {
    if (tenantId === null) return;
    setError(null);

    Promise.all([dashboardApi.counts(tenantId), dashboardApi.meta(tenantId)])
      .then(([loadedCounts, loadedMeta]) => {
        setCounts(loadedCounts);
        setMeta(loadedMeta);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load your dashboard.'),
      );
  }, [tenantId]);

  useEffect(load, [load]);

  const hrefFor = (key: string): string =>
    meta?.slices.find((slice) => slice.key === key)?.href ?? '/';

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="dashboard"
      onNavigate={() => undefined}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Dashboard' }}
      {...bell.shellProps}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader title="Dashboard" breadcrumbs={[{ label: 'Dashboard' }]} />

      {error !== null ? <Banner tone="danger">{error}</Banner> : null}

      <Card>
        <CardBody>
          {counts === null ? (
            <SkeletonText lines={3} />
          ) : (
            <>
              {/*
                One donut, two slices, and each one drills into the list it counts. The
                destinations come from the server so this screen and the contract cannot drift.
              */}
              <DonutDashboard
                agents={counts.agents}
                pendingJobs={counts.pendingJobs}
                onSelectAgents={() => router.push(hrefFor('agents'))}
                onSelectPendingJobs={() => router.push(hrefFor('pendingJobs'))}
              />

              {/*
                The legend, not a KPI. Without it a manager and an employee see two different
                numbers with no way to tell why they differ.
              */}
              <p className="uboss-muted">{counts.scope}</p>
            </>
          )}
        </CardBody>
      </Card>
    </AppShell>
  );
}
