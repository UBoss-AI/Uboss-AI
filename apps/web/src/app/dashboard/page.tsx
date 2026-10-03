'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Banner, Card, CardBody, DashboardAmbience, PageHeader, SkeletonText } from '@uboss/ui';

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
import { TileDetail } from '../../components/TileDetail';
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

  /**
   * Which work area's card is open under the map.
   *
   * Held here rather than inside the map, because the card is a sibling of the map and not a part
   * of it: the map is a picture of what exists, the card is what one of those things holds, and
   * the two are stacked rather than nested.
   */
  const [selected, setSelected] = useState<string | null>(null);

  /*
   * The selected area, resolved against what the server actually returned.
   *
   * Looked up rather than trusted. `selected` is a string this screen set, and resolving it
   * through `meta.tiles` means a selection can only ever name an area the server permitted — so
   * there is no path, including a stale value left behind by a permission change, that opens a
   * card for something this person may not see.
   */
  const selectedTile = useMemo(() => {
    if (selected === null || meta === null) return null;
    const entry = meta.tiles.find((tile) => tile.key === selected);
    if (entry === undefined) return null;
    if (!counts?.tiles.some((tile) => tile.tile === selected)) return null;
    return entry;
  }, [counts, meta, selected]);

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
              <>
                <OrchestrationMap
                  tiles={counts.tiles}
                  meta={meta}
                  scope={counts.scope}
                  selected={selected}
                  onSelect={setSelected}
                />

                {/*
                  The card for whichever area was pressed, under the map it came from.

                  Pressing a tile used to leave this screen at once. The client's instruction is
                  that it opens here instead, so four areas can be looked at in four clicks
                  without losing the screen you started on — and going in is the second,
                  deliberate click on the card's own Open button.

                  Rendered only when a tile is selected and only when the tile is one the server
                  returned, so a stale selection cannot resurrect an area this person may not see.
                */}
                {/*
                  Where the work has got to, as a card like every other.

                  It used to sit permanently under the map: a figure row, a stage table and a
                  department table, open on arrival whether or not anybody had asked for it — so
                  the dashboard opened with three tables under a diagram and the diagram was the
                  part people came for. It is now the "Where the work is" tile, and it opens where
                  the others open, when it is pressed.

                  Absent rather than empty when the server refused it: an employee seeing an
                  orchestration table of zeroes would read it as "the company has nothing on",
                  which is a claim about everybody else's work they are not entitled to make.
                */}
                {selectedTile?.key === 'stage' ? (
                  orchestration === null ? null : (
                    <StageOverview view={orchestration} onClose={() => setSelected(null)} />
                  )
                ) : selectedTile === null || tenantId === null ? null : (
                  <TileDetail
                    tile={selectedTile.key}
                    label={selectedTile.label}
                    measure={selectedTile.measures}
                    href={selectedTile.href}
                    tenantId={tenantId}
                    onOpen={(href) => router.push(href)}
                    onClose={() => setSelected(null)}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>
    </RoutedAppShell>
  );
}
