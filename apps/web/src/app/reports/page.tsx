'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  REPORT_COLUMNS_HIDDEN_FROM_COMPANY,
  REPORT_MONEY_COLUMNS,
  REPORT_OVERVIEW,
  reportColumnLabel,
} from '@uboss/types';

import {
  ApiError,
  authApi,
  formatMinor,
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
 * ## Answers first, reports underneath
 *
 * This screen used to open on eleven tabs, and whoever opened it had to already know which of them
 * held the thing they came to find out. That is a filing cabinet. It now opens on an overview that
 * answers the handful of questions people actually arrive with — what is it costing, how much of
 * the work are the agents doing, who is carrying too much, what cannot move, are the agents
 * working — and each panel opens the report it was drawn from, over the same period.
 *
 * The panels are not a second source of truth. Each one runs a report the reader's own permissions
 * already allow, through the same route, and draws the rows it returned. A panel the reader may not
 * see is absent, exactly as its tab is absent.
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
  const named = SUMMARY_LABELS[key];
  if (named !== undefined) return named;
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Summary keys whose split-on-the-case-change name is wrong rather than merely plain.
 *
 * `totalMinor` became "Total minor", which is not a smaller version of the right words — it is a
 * different thing entirely. The number beside it, `2596`, is ₹25.96 in minor units, so the tile
 * read "TOTAL MINOR 2596" and anybody would take that for two and a half thousand rupees.
 */
const SUMMARY_LABELS: Record<string, string> = {
  totalMinor: 'Total cost',
  aiSharePercent: 'Done by AI',
  oldestPendingDays: 'Longest wait',
  oldestWaitingSince: 'Waiting since',
  distinctActions: 'Kinds of change',
  skillVersions: 'Skill versions',
  stillOpen: 'Still open',
};

/** Summary tiles a company never sees. Same reason as the token columns — see the shared types. */
const SUMMARY_HIDDEN_FROM_COMPANY: readonly string[] = [
  'totalTokens',
  // Not hidden for secrecy: it is the unit of the amount beside it, and belongs *in* that value
  // rather than standing alone as a tile reading "CURRENCY INR".
  'currency',
];

/** What the screen is showing: the overview, or one report. */
type View = { kind: 'overview' } | { kind: 'report'; key: string };

const OVERVIEW: View = { kind: 'overview' };

export default function ReportsPage(): React.JSX.Element {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();

  const [me, setMe] = useState<MeResponse | null>(null);
  const [catalogue, setCatalogue] = useState<ReportCatalogue | null>(null);
  const [view, setView] = useState<View>(OVERVIEW);
  const [range, setRange] = useState<string>('Last30Days');
  const [run, setRun] = useState<ReportRunView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Each panel's own run, keyed by report. `null` while it is still in flight. */
  const [panels, setPanels] = useState<Record<string, ReportRunView | null>>({});
  const panelsLoadedFor = useRef<string | null>(null);

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
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load reports.'),
      );
  }, [tenantId]);

  /*
   * The panels this reader gets.
   *
   * Intersected with the catalogue, which the server filtered by their grants — so an Employee
   * without `settings:Administer` has no cost panel, for the same reason and by the same rule that
   * gives them no cost tab. There is no second permission check here because there is no second
   * source of data: each panel runs a report.
   */
  const visiblePanels = useMemo(
    () =>
      catalogue === null
        ? []
        : REPORT_OVERVIEW.filter((panel) =>
            catalogue.reports.some((report) => report.key === panel.report),
          ),
    [catalogue],
  );

  /*
   * A reader with none of the overview's five reports lands on their first report instead.
   *
   * Somebody whose only grant is `performance:View` would otherwise be shown an overview with
   * nothing in it — an empty answer to questions that were never theirs to ask. The tab is not
   * offered to them either.
   */
  useEffect(() => {
    if (catalogue === null || visiblePanels.length > 0) return;
    const first = catalogue.reports[0];
    if (first !== undefined) setView({ kind: 'report', key: first.key });
  }, [catalogue, visiblePanels]);

  const load = useCallback(() => {
    if (tenantId === null || view.kind !== 'report') return;
    setLoading(true);
    setError(null);

    reportsApi
      .run(tenantId, view.key, { range })
      .then(setRun)
      .catch((caught: unknown) => {
        setRun(null);
        setError(caught instanceof ApiError ? caught.message : 'Could not run that report.');
      })
      .finally(() => setLoading(false));
  }, [range, tenantId, view]);

  useEffect(load, [load]);

  /*
   * The overview's reports, run together.
   *
   * Five requests rather than one, and deliberately: a single overview endpoint would be a second
   * path to the same data, with its own authorization and its own scoping, and the day those two
   * drift is the day a manager sees the whole company on a panel. This way there is one route, one
   * set of permissions, one definition of the reporting tree — and a panel that cannot disagree
   * with the report it opens, because it *is* that report.
   *
   * Loaded once per company and period. Coming back from a report does not re-run them: nothing
   * about a closed period changes while somebody reads it, and five reports re-running on every
   * Back is how a screen starts to feel broken.
   *
   * `allSettled`, because one report failing is not the overview failing — the other four still
   * answer, and the one that could not is left showing nothing rather than a wrong figure.
   */
  useEffect(() => {
    if (tenantId === null || visiblePanels.length === 0) return;
    const signature = `${tenantId}:${range}`;
    if (panelsLoadedFor.current === signature) return;
    panelsLoadedFor.current = signature;

    setPanels(Object.fromEntries(visiblePanels.map((panel) => [panel.report, null])));

    let current = true;
    void Promise.allSettled(
      visiblePanels.map((panel) =>
        reportsApi.run(tenantId, panel.report, { range }).then((result) => {
          if (current) setPanels((known) => ({ ...known, [panel.report]: result }));
        }),
      ),
    );

    return () => {
      current = false;
    };
  }, [range, tenantId, visiblePanels]);

  const definition =
    view.kind === 'report'
      ? (catalogue?.reports.find((report) => report.key === view.key) ?? null)
      : null;

  /*
   * The columns, named and formatted for a person.
   *
   * Three things were wrong, and all three showed on every report:
   *
   *   * **The heading was the column key.** A manager read `slaOutcome`, `lastRunAt`,
   *     `waitingSince`, `resourceType` — the names a programmer gave the database. About fifty of
   *     them across eleven reports, on the one screen somebody shows their own boss.
   *   * **Money was printed in minor units.** `amountMinor` rendered `2596`, which is ₹25.96.
   *     Anybody reading it sees two and a half thousand rupees.
   *   * **Token counts reached a company.** They were taken out of the cost drill-down and the
   *     ledger for a reason — a customer who has them can divide the charge by the tokens, read
   *     off a per-million rate and match it to a public price list — and this report was missed.
   *
   * The keys are untouched: they are what a row is looked up by and what the CSV export writes.
   */
  const currency =
    typeof run?.summary?.['currency'] === 'string' ? (run.summary['currency'] as string) : 'INR';

  const columns: DataTableColumn<Record<string, unknown>>[] = (run?.columns ?? [])
    .filter((column) => !REPORT_COLUMNS_HIDDEN_FROM_COMPANY.includes(column))
    .map((column) => ({
      key: column,
      header: reportColumnLabel(column),
      numeric: REPORT_MONEY_COLUMNS.includes(column),
      render: (row) => {
        const value = row[column];
        if (value === null || value === undefined || value === '') return '—';
        if (REPORT_MONEY_COLUMNS.includes(column)) {
          return formatMinor(Number(value), currency);
        }
        return String(value);
      },
    }));

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
              <div className="uboss-seg uboss-seg--wrap" role="tablist">
                {visiblePanels.length === 0 ? null : (
                  <button
                    type="button"
                    role="tab"
                    className={view.kind === 'overview' ? 'is-on' : undefined}
                    onClick={() => setView(OVERVIEW)}
                  >
                    Overview
                  </button>
                )}
                {catalogue.reports.map((report) => (
                  <button
                    key={report.key}
                    type="button"
                    role="tab"
                    className={
                      view.kind === 'report' && report.key === view.key ? 'is-on' : undefined
                    }
                    onClick={() => setView({ kind: 'report', key: report.key })}
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
                  <h3>{view.kind === 'overview' ? 'Overview' : definition?.label}</h3>
                  {/* The question it answers. A report nobody can state the purpose of is a table. */}
                  <p className="uboss-muted">
                    {view.kind === 'overview'
                      ? 'The questions this company is asked every day. Open any one of them for the whole report behind it.'
                      : definition?.question}
                  </p>
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

                  {/*
                    Absent, not disabled, when the reader holds no export grant — and absent on the
                    overview, which is five reports at once rather than a file.
                  */}
                  {catalogue.mayExport && tenantId !== null && view.kind === 'report' ? (
                    <a
                      className="uboss-link"
                      href={reportsApi.exportHref(tenantId, view.key, { range })}
                    >
                      <Button size="sm" variant="navy">
                        Export CSV
                      </Button>
                    </a>
                  ) : null}
                </div>
              </div>

              {view.kind === 'overview' ? (
                <div className="uboss-overview">
                  {visiblePanels.map((panel) => {
                    const result = panels[panel.report];
                    const label =
                      catalogue.reports.find((report) => report.key === panel.report)?.label ??
                      'the full report';
                    const open = (): void => setView({ kind: 'report', key: panel.report });

                    return (
                      /*
                        The card follows the pointer; the question is what the keyboard reaches.

                        A whole card as one button announces the entire chart as its label, which
                        is unusable. So the heading is the control — one tab stop, reading "What
                        cannot start yet, button" — and the card's own click is a convenience on
                        top of that rather than the only way in.
                      */
                      <section
                        key={panel.key}
                        className="uboss-overview-panel"
                        onClick={open}
                        data-testid={`overview-panel-${panel.key}`}
                      >
                        <h3 className="uboss-overview-question">
                          <button type="button" onClick={open}>
                            {panel.question}
                          </button>
                        </h3>

                        {result === undefined || result === null ? (
                          <SkeletonText lines={3} />
                        ) : (
                          <ReportChart
                            spec={panel.chart}
                            rows={result.rows as Record<string, string>[]}
                            summary={result.summary}
                            truncated={result.truncated}
                            compact
                          />
                        )}

                        <p className="uboss-overview-open">{`Open ${label} →`}</p>
                      </section>
                    );
                  })}
                </div>
              ) : loading ? (
                <SkeletonText lines={5} />
              ) : run === null ? null : (
                <>
                  {Object.keys(run.summary).length > 0 ? (
                    <dl className="uboss-definitions">
                      {Object.entries(run.summary)
                        .filter(([key]) => !SUMMARY_HIDDEN_FROM_COMPANY.includes(key))
                        .map(([label, value]) => (
                          <div key={label}>
                            <dt>{humanLabel(label)}</dt>
                            <dd>
                              {/* Money as an amount, never as the integer it is stored in. */}
                              {label === 'totalMinor'
                                ? formatMinor(Number(value), currency)
                                : String(value)}
                            </dd>
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
