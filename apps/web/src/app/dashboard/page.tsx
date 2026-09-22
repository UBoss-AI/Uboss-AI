'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  DashboardAmbience,
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
import { useAccountMenu } from '../../lib/use-account-menu';
import { useSignedInUser } from '../../lib/use-signed-in-user';
import { RoutedAppShell } from '../../components/RoutedAppShell';
import {
  forgetWorkspace,
  readRememberedWorkspace,
  resolveActiveWorkspace,
} from '../../lib/active-workspace';
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

  const tenantId =
    resolveActiveWorkspace(me?.workspaces, readRememberedWorkspace())?.tenantId ?? null;

  const signedInUser = useSignedInUser(me);

  const accountMenu = useAccountMenu(me);
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
    <RoutedAppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="dashboard"
      user={signedInUser}
      accountMenu={accountMenu}
      {...bell.shellProps}
      onSignOut={() => {
        forgetWorkspace();
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      {/*
        The stage exists so the atmosphere can span the whole workspace rather than sit behind the
        card. It adds no content and carries no data: the ambience is decoration, the contract
        below is unchanged — one donut, two categories — and the layer itself is aria-hidden and
        cannot receive a pointer.

        This is the only screen with it. A field behind a table would be noise.
      */}
      <div className="uboss-dash-stage">
        <DashboardAmbience />

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
                <p className="uboss-dash-scope">{counts.scope}</p>

                {/*
                Why the dashboard is this small, said on the dashboard.

                It is the reference's own sentence, and it was the one thing missing: without it a
                screen holding a single donut reads as unfinished, and the first question in a demo
                is "where is everything else". With it the same screen reads as a decision. The
                modules named here are real and reachable from the navigation.
              */}
                <p className="uboss-dash-note">
                  Your permission-scoped snapshot. Select a slice to drill into the list it counts.
                  Reports, budgets and KPIs live in their own modules — not here.
                </p>

                {/*
                A zero is a starting point, not a gap.

                Aarohan has no activated Engine Agent, so half the donut is empty — and an empty
                half with nothing said about it looks like something failed to load. This names the
                one act that fills it and links to where that act happens. It appears only while
                the count is nought, so a company with agents never sees it.

                No new data: this is rendered from the count the contract already returns.
              */}
                {counts.agents === 0 ? (
                  <div className="uboss-dash-next">
                    <span>
                      No Engine Agents yet. One is built from an approved objective, in Agent
                      Builder.
                    </span>
                    <Button variant="ghost" onClick={() => router.push('/agent-builder')}>
                      Open Agent Builder
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </RoutedAppShell>
  );
}
