'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  DataTable,
  EmptyState,
  Icon,
  PageHeader,
  SkeletonText,
  type DataTableColumn,
} from '@uboss/ui';

import {
  ApiError,
  authApi,
  reportsApi,
  type MeResponse,
  type ReportCatalogue,
  type ReportRunView,
} from '../../lib/api-client';
import { useAccountMenu } from '../../lib/use-account-menu';
import { useSignedInUser } from '../../lib/use-signed-in-user';
import { ReportChart } from '../../components/ReportChart';
import { RoutedAppShell } from '../../components/RoutedAppShell';
import {
  forgetWorkspace,
  readRememberedWorkspace,
  resolveActiveWorkspace,
} from '../../lib/active-workspace';
import { useNotificationBell } from '../../lib/use-notification-bell';
import { useCompanyNavigation } from '../../lib/use-company-navigation';

/**
 * Reports — Prompt 37.
 *
 * ## Reports are here, and never on the dashboard
 *
 * The locked contract puts exactly one donut on the Company Workspace Dashboard and everything
 * else here, reached from the Reports item in the Operations group. This page is where the KPI
 * cards, tables and cost figures the dashboard must not carry actually belong.
 *
 * ## A report the reader cannot open is absent, not empty
 *
 * The catalogue comes from the server already filtered. An empty Approval Aging table would tell a
 * reader there was nothing waiting, which is a different and wrong answer from "you may not see
 * this" — so the list simply does not contain it.
 *
 * ## Export is a button that is sometimes not there
 *
 * `mayExport` comes from the server. A reader who can see a report on screen but not take it away
 * gets no Export button, and the route would refuse them anyway — the button's absence is
 * presentation, the 403 is the control.
 */
/**
 * A report's summary keys arrive as the server's own field names — `objectives`, `onTime`,
 * `slaBreaches` — and were being printed exactly like that. "onTime" is a variable name, not a
 * label, and putting one in front of a customer is the difference between a product and a console.
 *
 * Splitting on the case change and capitalising the first word covers every key these reports
 * actually return, and leaves an already-readable key alone.
 */
function humanLabel(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export default function ReportsPage(): React.JSX.Element {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();

  const [me, setMe] = useState<MeResponse | null>(null);
  const [catalogue, setCatalogue] = useState<ReportCatalogue | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [range, setRange] = useState<string>('Last30Days');
  const [run, setRun] = useState<ReportRunView | null>(null);
  const [loading, setLoading] = useState(false);
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

  useEffect(() => {
    if (tenantId === null) return;
    reportsApi
      .catalogue(tenantId)
      .then((loaded) => {
        setCatalogue(loaded);
        setRange(loaded.defaultRange);
        setActive((current) => current ?? loaded.reports[0]?.key ?? null);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load reports.'),
      );
  }, [tenantId]);

  const load = useCallback(() => {
    if (tenantId === null || active === null) return;
    setLoading(true);
    setError(null);

    reportsApi
      .run(tenantId, active, { range })
      .then(setRun)
      .catch((caught: unknown) => {
        setRun(null);
        setError(caught instanceof ApiError ? caught.message : 'Could not run that report.');
      })
      .finally(() => setLoading(false));
  }, [active, range, tenantId]);

  useEffect(load, [load]);

  const definition = catalogue?.reports.find((report) => report.key === active) ?? null;

  const columns: DataTableColumn<Record<string, unknown>>[] = (run?.columns ?? []).map(
    (column) => ({
      key: column,
      header: column,
      render: (row) => String(row[column] ?? '—'),
    }),
  );

  return (
    <RoutedAppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="reports"
      user={signedInUser}
      accountMenu={accountMenu}
      {...bell.shellProps}
      onSignOut={() => {
        forgetWorkspace();
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Reports"
        description={catalogue?.scope ?? 'Permission-controlled reporting.'}
        breadcrumbs={[{ label: 'Reports' }]}
        actions={
          <Link href="/dashboard">
            <Button size="sm">
              <Icon name="back" size={16} />
              Dashboard
            </Button>
          </Link>
        }
      />

      {error !== null ? <Banner tone="danger">{error}</Banner> : null}

      {catalogue === null ? (
        <SkeletonText lines={4} />
      ) : catalogue.reports.length === 0 ? (
        <EmptyState
          icon="chart"
          title="No reports in your scope"
          description="Reports you may read appear here. One you cannot read is not shown at all, rather than shown empty."
        />
      ) : (
        <div className="uboss-stack">
          <Card>
            <CardBody>
              <div className="uboss-seg" role="tablist">
                {catalogue.reports.map((report) => (
                  <button
                    key={report.key}
                    type="button"
                    role="tab"
                    className={report.key === active ? 'is-on' : undefined}
                    onClick={() => setActive(report.key)}
                  >
                    {report.label}
                  </button>
                ))}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <div className="uboss-row uboss-row--between">
                <div>
                  <h3>{definition?.label}</h3>
                  {/* The question it answers. A report nobody can state the purpose of is a table. */}
                  <p className="uboss-muted">{definition?.question}</p>
                </div>

                <div className="uboss-actions">
                  <label className="uboss-field">
                    <span>Period</span>
                    <select value={range} onChange={(event) => setRange(event.target.value)}>
                      {catalogue.ranges
                        .filter((option) => option.key !== 'Custom')
                        .map((option) => (
                          <option key={option.key} value={option.key}>
                            {option.label}
                          </option>
                        ))}
                    </select>
                  </label>

                  {/* Absent, not disabled, when the reader holds no export grant. */}
                  {catalogue.mayExport && tenantId !== null && active !== null ? (
                    <a
                      className="uboss-link"
                      href={reportsApi.exportHref(tenantId, active, { range })}
                    >
                      <Button size="sm" variant="navy">
                        Export CSV
                      </Button>
                    </a>
                  ) : null}
                </div>
              </div>

              {loading ? (
                <SkeletonText lines={5} />
              ) : run === null ? null : (
                <>
                  {Object.keys(run.summary).length > 0 ? (
                    <dl className="uboss-definitions">
                      {Object.entries(run.summary).map(([label, value]) => (
                        <div key={label}>
                          <dt>{humanLabel(label)}</dt>
                          <dd>{String(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}

                  {/*
                    The picture, above the rows.

                    A report is opened to answer a question — where is the work, who is
                    overloaded, what is waiting — and the answer used to be a hundred-row table
                    read line by line. The chart is counted from those same rows, so it can never
                    say something the table does not.

                    A report with no chart declares that deliberately, and the reason is written
                    beside it in the catalogue.
                  */}
                  {definition?.chart === undefined ? null : (
                    <ReportChart
                      spec={definition.chart}
                      rows={run.rows as Record<string, string>[]}
                      summary={run.summary}
                      truncated={run.truncated}
                    />
                  )}

                  {run.truncated ? (
                    <Banner tone="warn">
                      This report was cut short at the row limit. Narrow the period to see the rest
                      — the limit is what stops one query scanning everything the company has ever
                      done.
                    </Banner>
                  ) : null}

                  <DataTable
                    caption={definition?.label ?? 'Report'}
                    columns={columns}
                    rows={run.rows}
                    /*
                     * Position first, values second.
                     *
                     * A report row is an aggregate with no id of its own, so the key used to be
                     * the row's values — and two genuinely identical rows then collided. The
                     * approvals report does produce them: two sign-offs with the same title,
                     * type, status, requester and age are different approvals that happen to read
                     * alike, and React dropped one of them with a duplicate-key warning.
                     *
                     * The index alone would be enough for correctness, since a result is replaced
                     * wholesale rather than reordered. The values stay on the end so that a key
                     * still changes when the row does.
                     */
                    rowKey={(row, index) => `${index}:${JSON.stringify(row)}`}
                    emptyTitle="Nothing in this period"
                    emptyDescription="Within your scope and the period you chose, there is nothing to show."
                  />

                  <p className="uboss-muted">
                    <small>{catalogue.stance}</small>
                  </p>
                </>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </RoutedAppShell>
  );
}
