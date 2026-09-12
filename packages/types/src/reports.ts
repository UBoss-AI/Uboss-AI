import type { Action, CompanyModuleKey } from './authorization.js';
import type { ScopeKind } from './authorization.js';

/**
 * Reporting and management dashboards — Prompt 37.
 *
 * ## The Company Workspace Dashboard is not a report
 *
 * The locked contract, restated here because it is the thing most likely to be eroded by a
 * well-meaning addition:
 *
 * > Exactly one donut/pie chart with two slices only: **Agents** and **Pending Jobs**. Counts use
 * > the logged-in user's backend-authorized scope. Clicking a slice drills into that list. **No**
 * > KPI cards, report tables, cost/token cards, notification lists, hierarchy summaries or
 * > performance details.
 *
 * Everything in this module is therefore a **Reports screen**, reached from the Reports item in
 * the Operations group — never from the dashboard. `DASHBOARD_CONTRACT` states the rule as a value
 * so a test can assert the dashboard endpoint returns two numbers and nothing else.
 *
 * ## Every report is the same three decisions
 *
 * 1. **May this person open it at all** — `reports:View`, held by every role template.
 * 2. **What may they see in it** — their authorized scope, resolved once and applied to every
 *    query. Never a filter the client sends.
 * 3. **May they take it away** — `reports:Export`, held by Manager, Head and CompanyAdmin and
 *    deliberately **not** by Employee or Approver.
 *
 * The third is the one the prompt names explicitly ("export permissions"), and it is a different
 * grant rather than a flag on the first because taking a company's data out of UBoss is a
 * different act from reading it on a screen.
 */

// ---------------------------------------------------------------------------
// The locked dashboard
// ---------------------------------------------------------------------------

/**
 * The Company Workspace Dashboard contract, as a value a test can assert against.
 *
 * Written down because the failure mode is additive: nobody deletes the donut, somebody adds a
 * card beside it. `DASHBOARD_ALLOWED_KEYS` is what the endpoint may return, and a test asserts the
 * response has exactly those keys.
 */
export const DASHBOARD_SLICES = ['agents', 'pendingJobs'] as const;
export type DashboardSlice = (typeof DASHBOARD_SLICES)[number];

export const DASHBOARD_SLICE_LABELS: Record<DashboardSlice, string> = {
  agents: 'Agents',
  pendingJobs: 'Pending Jobs',
};

/** Where each slice drills to. The prompt names both destinations. */
export const DASHBOARD_SLICE_DESTINATIONS: Record<DashboardSlice, string> = {
  agents: '/agents',
  pendingJobs: '/todo',
};

export const DASHBOARD_CONTRACT =
  'The Company Workspace Dashboard shows exactly one donut with exactly two slices — Agents and ' +
  'Pending Jobs — counted in the signed-in person’s own authorized scope. It carries no KPI ' +
  'cards, no report tables, no cost or token cards, no notification list, no hierarchy summary ' +
  'and no performance detail. Those are Reports screens, and the Master Console dashboard is a ' +
  'separate thing that keeps its platform KPI cards.';

export interface DashboardCounts {
  agents: number;
  pendingJobs: number;
}

/** Exactly the keys the dashboard endpoint may return. A third would break the locked contract. */
export const DASHBOARD_ALLOWED_KEYS: readonly string[] = ['agents', 'pendingJobs', 'scope'];

// ---------------------------------------------------------------------------
// The reports
// ---------------------------------------------------------------------------

/**
 * The ten reports, named exactly as the prompt names them.
 *
 * Not nine, not eleven, and not renamed. Each one answers a question somebody actually asks, and
 * the `question` field is what the screen shows under the title — a report nobody can state the
 * purpose of is a table.
 */
export const REPORT_KEYS = [
  'ObjectiveProgress',
  'HumanVsAiWorkMix',
  'EmployeeWorkload',
  'EngineAgentHealth',
  'SkillUsageAndQuality',
  'ExecutorExceptions',
  'ApprovalAging',
  'AiUsageAndCost',
  'AuditActivity',
  'PerformanceAndBadges',
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export interface ReportDefinition {
  key: ReportKey;
  label: string;
  /** The question it answers, shown under the title. */
  question: string;
  /**
   * The permission this report needs **in addition to** `reports:View`.
   *
   * Two grants, not one, and this is the decision worth defending: a report is a view onto another
   * module's data, so somebody who cannot see Approvals must not be able to read Approval Aging.
   * Gating only on `reports:View` would have made Reports a way around every other module's
   * permissions — the single most likely leak in an enterprise reporting feature.
   *
   * **The action is named, not assumed to be `View`.** An earlier version of this file carried
   * only a module and implied `View`, which handed an Employee the company's AI spend and its
   * audit trail — because `settings:View` is what lets anybody open Settings and see their own
   * profile. The assumption was the bug; naming the action is the fix.
   *
   * Null when the report needs nothing beyond `reports:View`, because its data is the reports
   * module's own aggregate rather than another module's rows.
   */
  sourcePermission: { module: CompanyModuleKey; action: Action } | null;
  /** Whether the report is meaningfully scoped by the reporting tree. */
  scoped: boolean;
}

export const REPORTS: readonly ReportDefinition[] = [
  {
    key: 'ObjectiveProgress',
    label: 'Objective Progress / Outcome / SLA',
    question:
      'Which objectives are on track, how did the finished ones turn out, and were they on time?',
    sourcePermission: { module: 'objective', action: 'View' },
    scoped: true,
  },
  {
    key: 'HumanVsAiWorkMix',
    label: 'Human vs AI Work Mix',
    question: 'How much of the work is being done by people and how much by agents?',
    sourcePermission: null,
    scoped: true,
  },
  {
    key: 'EmployeeWorkload',
    label: 'Employee Workload',
    question: 'Who is carrying how much, and who is overdue?',
    sourcePermission: { module: 'todo', action: 'View' },
    scoped: true,
  },
  {
    key: 'EngineAgentHealth',
    label: 'Engine Agent Health',
    question: 'Which agents are succeeding, which are failing, and which have stopped being used?',
    sourcePermission: { module: 'agents', action: 'View' },
    scoped: true,
  },
  {
    key: 'SkillUsageAndQuality',
    label: 'Skill Usage & Quality',
    question: 'Which Skills are actually used, and what do reviewers say about what they produce?',
    sourcePermission: { module: 'agents', action: 'View' },
    scoped: false,
  },
  {
    key: 'ExecutorExceptions',
    label: 'Executor Agent Exceptions',
    question: 'What did the Executor Agent stop, escalate or flag, and is any of it still open?',
    sourcePermission: { module: 'executor', action: 'View' },
    scoped: true,
  },
  {
    key: 'ApprovalAging',
    label: 'Approval Aging',
    question: 'What is waiting for a decision, and how long has it been waiting?',
    sourcePermission: { module: 'approvals', action: 'View' },
    scoped: true,
  },
  {
    key: 'AiUsageAndCost',
    label: 'AI Usage & Cost',
    question: 'What has AI work cost, and where did it go?',
    sourcePermission: { module: 'settings', action: 'Administer' },
    scoped: false,
  },
  {
    key: 'AuditActivity',
    label: 'Audit Activity',
    question: 'What changed in this company, who changed it, and when?',
    sourcePermission: { module: 'settings', action: 'Audit' },
    scoped: false,
  },
  {
    key: 'PerformanceAndBadges',
    label: 'Performance / Badge History',
    question: 'How have people scored over time, and what have they earned?',
    sourcePermission: { module: 'performance', action: 'View' },
    scoped: true,
  },
];

const REPORT_BY_KEY = new Map(REPORTS.map((report) => [report.key, report]));

export function reportDefinition(key: string): ReportDefinition | undefined {
  return REPORT_BY_KEY.get(key as ReportKey);
}

/**
 * The two permissions a report read requires.
 *
 * Both, always. `reports:View` says the person may open the Reports section at all; the source
 * module's `View` says they may see *this* data. A person with `reports:View` and no
 * `approvals:View` gets the Reports screen with Approval Aging absent — not an empty table, which
 * would imply there was nothing waiting.
 */
export function permissionsForReport(
  report: ReportDefinition,
): { module: CompanyModuleKey; action: Action }[] {
  const required: { module: CompanyModuleKey; action: Action }[] = [
    { module: 'reports', action: 'View' },
  ];
  if (report.sourcePermission !== null) {
    required.push(report.sourcePermission);
  }
  return required;
}

/** Exporting any report is one grant. Taking data out is a different act from reading it. */
export const REPORT_EXPORT_PERMISSION: { module: CompanyModuleKey; action: Action } = {
  module: 'reports',
  action: 'Export',
};

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * The windows a report may be run over.
 *
 * A closed set rather than two free dates, because an unbounded range over a year of audit events
 * is a denial-of-service somebody will type by accident. `Custom` exists and is bounded by
 * `MAX_REPORT_RANGE_DAYS`.
 */
export const REPORT_RANGES = ['Last7Days', 'Last30Days', 'Last90Days', 'Custom'] as const;
export type ReportRange = (typeof REPORT_RANGES)[number];

export const REPORT_RANGE_LABELS: Record<ReportRange, string> = {
  Last7Days: 'Last 7 days',
  Last30Days: 'Last 30 days',
  Last90Days: 'Last 90 days',
  Custom: 'A range you choose',
};

export const DEFAULT_REPORT_RANGE: ReportRange = 'Last30Days';

/** A year. Long enough for an annual review, short enough that one query cannot scan everything. */
export const MAX_REPORT_RANGE_DAYS = 366;

export const REPORT_RANGE_DAYS: Record<Exclude<ReportRange, 'Custom'>, number> = {
  Last7Days: 7,
  Last30Days: 30,
  Last90Days: 90,
};

export interface ReportWindow {
  from: Date;
  to: Date;
}

export type WindowResolution = { ok: true; window: ReportWindow } | { ok: false; reason: string };

/**
 * Turn a range into two instants.
 *
 * `now` is a parameter rather than read inside, for the reason Prompt 31 learned the hard way: a
 * function with its own clock cannot be tested against a boundary, and two calls in one request
 * can straddle midnight.
 */
export function resolveWindow(input: {
  range: ReportRange;
  now: Date;
  from?: Date | undefined;
  to?: Date | undefined;
}): WindowResolution {
  if (input.range !== 'Custom') {
    const days = REPORT_RANGE_DAYS[input.range];
    return {
      ok: true,
      window: {
        from: new Date(input.now.getTime() - days * 86_400_000),
        to: input.now,
      },
    };
  }

  if (input.from === undefined || input.to === undefined) {
    return { ok: false, reason: 'A custom range needs both a start and an end.' };
  }
  if (input.from.getTime() >= input.to.getTime()) {
    return { ok: false, reason: 'The start of the range has to come before the end.' };
  }

  const days = (input.to.getTime() - input.from.getTime()) / 86_400_000;
  if (days > MAX_REPORT_RANGE_DAYS) {
    return {
      ok: false,
      reason:
        `A report covers at most ${MAX_REPORT_RANGE_DAYS} days. A longer range is an export, ` +
        'and an unbounded one is a query that scans everything this company has ever done.',
    };
  }

  return { ok: true, window: { from: input.from, to: input.to } };
}

/** How many rows a report returns before it asks the reader to narrow the question. */
export const REPORT_ROW_LIMIT = 500;

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * What a person may see in a report, resolved from their role scope.
 *
 * **`userIds: null` means "everybody in this company"**, and is only ever produced by a
 * `WholeCompany` or `Department`-wide grant. A list means exactly those people. The distinction is
 * explicit rather than "an empty list means everybody", because that is the single most dangerous
 * default a reporting layer can have: a bug that produced an empty list would silently widen every
 * report to the whole company instead of narrowing it to nobody.
 */
export interface ReportScope {
  kind: ScopeKind;
  /** Null means unrestricted within the company. A list is exhaustive. */
  userIds: readonly string[] | null;
  /** Null means unrestricted. */
  departmentIds: readonly string[] | null;
  /** One sentence the screen shows, so a reader knows what they are looking at. */
  description: string;
}

/**
 * Whether a scope permits seeing anything at all.
 *
 * An empty (not null) user list is a real outcome — a manager with nobody reporting to them — and
 * it must produce an empty report rather than an unfiltered one.
 */
export function scopeIsEmpty(scope: ReportScope): boolean {
  return scope.userIds !== null && scope.userIds.length === 0;
}

export const SCOPE_DESCRIPTIONS: Record<ScopeKind, string> = {
  OwnWork: 'Your own work only.',
  SelectedResource: 'The specific records you were given access to.',
  TeamSubtree: 'You and everyone who reports to you, at any depth.',
  Department: 'Your department.',
  MultipleDepartments: 'The departments you cover.',
  WholeCompany: 'The whole company.',
};

/**
 * The rule a leakage test asserts.
 *
 * Stated as a value because "reports must not widen anybody's access" is the kind of requirement
 * that is obviously true, easy to break, and invisible when broken.
 */
export const REPORT_SCOPE_STANCE =
  'A report never widens what somebody may see. Its rows are filtered to the same scope the ' +
  'authorization engine would apply to the underlying records, the filter is resolved on the ' +
  'server from the signed-in person’s roles, and no filter a client sends can widen it — only ' +
  'narrow it further.';

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const EXPORT_FORMATS = ['Csv', 'Json'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * CSV injection, and why the export escapes rather than trusts.
 *
 * A cell beginning `=`, `+`, `-` or `@` is executed as a formula by Excel and Google Sheets when
 * the file is opened. Company data reaches these reports from free-text fields — an objective
 * title, a ticket subject, somebody's display name — so a cell can be attacker-controlled.
 * Prefixing with an apostrophe is the accepted mitigation and it is applied to every cell rather
 * than to the ones somebody thought of.
 */
export function csvCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ''
      : value instanceof Date
        ? value.toISOString()
        : String(value);

  const neutralised = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${neutralised.replaceAll('"', '""')}"`;
}

export function toCsv(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
): string {
  const header = columns.map((column) => csvCell(column)).join(',');
  const body = rows.map((row) => columns.map((column) => csvCell(row[column])).join(','));
  return [header, ...body].join('\r\n');
}
