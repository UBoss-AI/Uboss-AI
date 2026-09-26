'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Card,
  CardBody,
  DashboardAmbience,
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
import type { OrchestrationView } from '@uboss/types';
import { OrchestrationMap } from '../../components/OrchestrationMap';
import { StageOverview } from '../../components/StageOverview';
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
  const [orchestration, setOrchestration] = useState<OrchestrationView | null>(null);
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

  /*
   * Where the work has got to, read on its own.
   *
   * Deliberately not part of `load`. The server refuses this to anybody who may not see
   * Objectives, which is most of the company — and a refusal is the right answer rather than a
   * failure. Putting it in the same `Promise.all` as the tiles would turn one correct refusal
   * into "could not load your dashboard" for every employee.
   */
  useEffect(() => {
    if (tenantId === null) return;
    let current = true;
    void dashboardApi
      .orchestration(tenantId)
      .then((view) => {
        if (current) setOrchestration(view);
      })
      .catch(() => {
        if (current) setOrchestration(null);
      });
    return () => {
      current = false;
    };
  }, [tenantId]);

  useEffect(load, [load]);

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

        {counts === null ? (
          <Card>
            <CardBody>
              <SkeletonText lines={4} />
            </CardBody>
          </Card>
        ) : (
          <>
            {/*
              The work areas this person is authorized to see.

              `counts.tiles` already holds only what the server permits — a tile somebody may not
              see never arrives here, so this screen has nothing to filter and nothing to hide.
              That is the whole reason the payload is shaped this way.
            */}
            {counts.tiles.length === 0 ? (
              <Card>
                <CardBody>
                  <p className="uboss-muted">
                    No work areas are available to you yet. An administrator grants access in
                    Settings → Users &amp; Access.
                  </p>
                </CardBody>
              </Card>
            ) : (
              <OrchestrationMap
                tiles={counts.tiles}
                meta={meta}
                scope={counts.scope}
                onOpen={(href) => router.push(href)}
              />
            )}

            {/*
              Under the tiles, and only for somebody entitled to it.

              Absent rather than empty when the server refused: an employee seeing an orchestration
              table of zeroes would read it as "the company has nothing on", which is a claim about
              everybody else's work that they are not entitled to make.
            */}
            {orchestration === null ? null : <StageOverview view={orchestration} />}
          </>
        )}
      </div>
    </RoutedAppShell>
  );
}
