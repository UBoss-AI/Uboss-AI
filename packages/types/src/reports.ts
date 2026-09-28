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
 * ## What changed, and why the old rule existed
 *
 * The first contract was: one donut, two slices, nothing beside it. It was written that way
 * because the failure mode was additive — nobody deletes the donut, somebody adds a card — and a
 * dashboard that accumulates cards becomes a report nobody asked for.
 *
 * The client has since asked for the opposite: an orchestration view, where the first screen shows
 * the work areas a person is responsible for. That is a product decision and it is theirs, so the
 * contract changed rather than being quietly worked around.
 *
 * **The discipline it replaces the old rule with is stricter, not looser**, and it is the part that
 * must not erode:
 *
 *   1. **A tile appears only if the server says this person may see that module.** The browser does
 *      not decide, and a tile is never rendered and then hidden.
 *   2. **Every count is a real query in the person's own authorized scope.** No tile carries an
 *      invented number, a projection or a placeholder. A figure that cannot be counted honestly is
 *      omitted and the tile links without one.
 *   3. **No tile carries cost, tokens or money.** Those live in Settings → Tokens & Cost, which is
 *      a different permission.
 *   4. **Nothing here replaces a report.** A tile is a count and a way in; the analysis is in
 *      Reports.
 */
/**
 * The work areas the dashboard can put in front of somebody.
 *
 * Each one is a module that already exists in `COMPANY_MODULES` — this list does not invent a
 * place to go. `performance` and `reports` are here because the client named them, and they are
 * the two that carry no count: there is no single honest number for either, so their tiles are a
 * way in rather than a figure.
 */
/**
 * The orchestration overview — what is actually happening right now, by stage.
 *
 * ## Why this is not more tiles
 *
 * The tiles below answer "how much of each thing is there", which is what somebody landing on the
 * screen wants. This answers a different question, and only an admin asks it: *where has the work
 * got to*. Engine, Sub-Engine and Executor are positions in a sequence, so their numbers only mean
 * something side by side — sixty ready at Engine and nothing at Executor is a company that has not
 * started; the reverse is one that is nearly done. Split across seven tiles that reading is gone.
 *
 * ## Every number here is counted, never projected
 *
 * There is no estimate, no rate and no trend in this shape. A dashboard that guesses is worse than
 * one that is a second stale, because somebody will act on the guess.
 */
export const EXECUTION_STAGE_ORDER = ['Engine', 'SubEngine', 'Executor'] as const;
export type OrchestrationStage = (typeof EXECUTION_STAGE_ORDER)[number];

export const ORCHESTRATION_STAGE_LABELS: Record<OrchestrationStage, string> = {
  Engine: 'Engine',
  SubEngine: 'Sub-Engine',
  Executor: 'Executor',
};

/**
 * What a piece of work is doing, reduced to the four states worth seeing together.
 *
 * `waiting` is the one that matters and the one no existing screen showed: work that exists, has
 * an owner, and cannot be started because something before it is unfinished. Counting it as
 * "not started" hid the difference between a person who has not begun and a person who is not
 * allowed to begin — the second is a queue, and a queue is the admin's problem to clear.
 */
export interface OrchestrationCounts {
  waiting: number;
  ready: number;
  inProgress: number;
  completed: number;
}

export interface OrchestrationStageRow {
  stage: OrchestrationStage;
  /** Work a person does. */
  human: OrchestrationCounts;
  /** Work an agent does. */
  agent: OrchestrationCounts;
}

export interface OrchestrationDepartmentRow {
  departmentId: string;
  name: string;
  activeObjectives: number;
  waiting: number;
  overdue: number;
  completed: number;
}

export interface OrchestrationView {
  /** Live objectives in the reader's scope — the denominator for everything below. */
  activeObjectives: number;
  stages: OrchestrationStageRow[];
  /** Work blocked on an unfinished dependency, across every stage. */
  waitingOnDependency: number;
  /**
   * Null when the reader may not see that module at all.
   *
   * Not zero. Zero is a fact about the company; "not yours to see" is a fact about the reader,
   * and saying the second with the first is a lie that reads as good news.
   */
  approvalsPending: number | null;
  exceptionsOpen: number | null;
  overdue: number;
  departments: OrchestrationDepartmentRow[];
  /**
   * What the reader is looking at, in their own terms.
   *
   * Two admins with different scopes legitimately see different numbers, and a screen that does
   * not say whose work it is counting invites the two of them to argue about which is broken.
   */
  covers: string;
}

export function emptyOrchestrationCounts(): OrchestrationCounts {
  return { waiting: 0, ready: 0, inProgress: 0, completed: 0 };
}

export const DASHBOARD_TILES = [
  'objectives',
  'tasks',
  'agents',
  'approvals',
  'exceptions',
  'performance',
  'reports',
] as const;
export type DashboardTile = (typeof DASHBOARD_TILES)[number];

/** The module each tile is gated on. The server checks this; the browser never decides. */
export const DASHBOARD_TILE_MODULE: Record<DashboardTile, string> = {
  objectives: 'objective',
  tasks: 'todo',
  agents: 'agents',
  approvals: 'approvals',
  exceptions: 'executor',
  performance: 'performance',
  reports: 'reports',
};

export const DASHBOARD_TILE_LABELS: Record<DashboardTile, string> = {
  objectives: 'Objectives',
  tasks: 'Tasks',
  agents: 'Job Agents',
  approvals: 'Approvals',
  exceptions: 'Exceptions',
  performance: 'Performance',
  reports: 'Reports',
};

/**
 * What each tile's number means, in the words the screen shows under it.
 *
 * Written down rather than left to the component, because a count with no stated meaning is the
 * thing two people read two different ways — and on this screen two people with different scopes
 * legitimately see different numbers.
 */
export const DASHBOARD_TILE_MEASURE: Record<DashboardTile, string | null> = {
  objectives: 'Active in your scope',
  tasks: 'Still needing somebody',
  agents: 'Built and not archived',
  approvals: 'Waiting on a decision',
  exceptions: 'Open and unresolved',
  performance: null,
  reports: null,
};

/** Where each tile goes. Every destination is a route that exists. */
export const DASHBOARD_TILE_DESTINATIONS: Record<DashboardTile, string> = {
  objectives: '/objective',
  tasks: '/todo',
  agents: '/agents',
  approvals: '/approvals',
  exceptions: '/executor',
  performance: '/performance',
  reports: '/reports',
};

/**
 * The two sides of the orchestration view.
 *
 * ## Why the dashboard is split at all
 *
 * The seven tiles are not seven of the same thing. Three of them are where work is created and
 * carried out; four are where it is checked, decided on and reported. Somebody landing on this
 * screen is almost always in one of those two frames of mind, and a single undifferentiated row
 * of tiles makes them read all seven to find the three they came for.
 *
 * ## Why the split lives here and not in the component
 *
 * Same reason the labels do. Which side a work area belongs to is a statement about the product,
 * not about the layout, and a screen that decides it locally is a screen that can disagree with
 * the server about what a module is for.
 */
export const DASHBOARD_LANES = ['execution', 'oversight'] as const;
export type DashboardLane = (typeof DASHBOARD_LANES)[number];

export const DASHBOARD_LANE_LABELS: Record<DashboardLane, string> = {
  execution: 'Execution',
  oversight: 'Oversight',
};

/**
 * What each side is for, in one line.
 *
 * Shown on the screen rather than kept as a comment, because "Execution" and "Oversight" are the
 * kind of words everybody agrees with and nobody can act on until somebody says what falls under
 * them.
 */
export const DASHBOARD_LANE_MEASURE: Record<DashboardLane, string> = {
  execution: 'Where work is defined and carried out',
  oversight: 'Where it is decided on and reviewed',
};

export const DASHBOARD_TILE_LANE: Record<DashboardTile, DashboardLane> = {
  objectives: 'execution',
  tasks: 'execution',
  agents: 'execution',
  approvals: 'oversight',
  exceptions: 'oversight',
  performance: 'oversight',
  reports: 'oversight',
};

export const DASHBOARD_CONTRACT =
  'The Company Workspace Dashboard is an orchestration view: it shows the work areas the ' +
  'signed-in person is authorized to see, each with a count taken in that person’s own ' +
  'backend-authorized scope. A tile appears only because the server permits its module — the ' +
  'browser never decides, and a tile is never rendered and then hidden. Every number is a real ' +
  'query; a figure that cannot be counted honestly is omitted rather than estimated. No tile ' +
  'carries cost, tokens or money, and no tile replaces a report: the analysis lives in Reports. ' +
  'The Master Console dashboard is a separate thing that keeps its platform KPI cards.';

/** One tile, as the endpoint returns it. `count` is null where no honest number exists. */
export interface DashboardTileCount {
  tile: DashboardTile;
  count: number | null;
}

export interface DashboardCounts {
  tiles: DashboardTileCount[];
}

/**
 * Exactly the keys the dashboard endpoint may return.
 *
 * Still asserted by a test, and still for the original reason: what keeps this screen honest is
 * that adding to it has to be a decision somebody takes on purpose.
 */
export const DASHBOARD_ALLOWED_KEYS: readonly string[] = ['tiles', 'scope'];

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
  'DependencyWaiting',
  'ExecutorExceptions',
  'ApprovalAging',
  'AiUsageAndCost',
  'AuditActivity',
  'PerformanceAndBadges',
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

/**
 * How a report draws itself, when a picture says it better than the table does.
 *
 * Declared per report rather than guessed by the screen, and deliberately narrow: a chart is
 * built by counting rows that share a value in one column, or by reading two numbers the report
 * already computed. Nothing is interpolated, smoothed or projected — if the report does not
 * already know it, the chart does not show it.
 *
 * `groupBy` counts rows per distinct value: statuses, people, departments. `compare` reads named
 * figures out of the summary the report returned. A report with neither simply has no chart, and
 * that is a better answer than a decorative one.
 */
export type ReportChart =
  /**
   * Count the rows that share a value: statuses, severities, badges.
   *
   * Right only when a row is one *thing* — one objective, one exception, one person. On a report
   * whose rows are already totals, counting them gives every bar a height of one and says
   * nothing, which is why each use below names the row it is counting.
   */
  | { kind: 'groupBy'; column: string; title: string; note?: string }
  /**
   * One bar per row, reading its height out of a column the report already totalled.
   *
   * This is the shape for a report that aggregated before it returned — cost per day, events per
   * action, open items per person. Nothing is summed here that the report did not sum itself.
   */
  | {
      kind: 'series';
      labelColumn: string;
      valueColumn: string;
      title: string;
      note?: string;
      /** Minor units rendered as money. Anything else is a plain count. */
      format?: 'money';
    }
  /**
   * Bin a number the rows carry: how many waited one day, three, a week.
   *
   * `edges` are the lower bounds after the first band, so [1, 3, 7] gives under a day, one to
   * three, three to seven, and seven or more. Aging is the one question a distribution of
   * statuses cannot answer, and it is the question an approvals queue is opened with.
   */
  | {
      kind: 'buckets';
      column: string;
      edges: number[];
      unit: string;
      title: string;
      note?: string;
    };

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
  /**
   * How this report draws itself, when a picture reads better than the table.
   *
   * Absent means no chart, which is the honest answer for a report whose rows are a list of
   * events rather than a distribution of anything.
   */
  chart?: ReportChart;

  /** Whether the report is meaningfully scoped by the reporting tree. */
  scoped: boolean;
}

export const REPORTS: readonly ReportDefinition[] = [
  {
    key: 'ObjectiveProgress',
    chart: {
      kind: 'groupBy',
      column: 'status',
      title: 'Where the objectives are',
      note: 'Every objective in this period, counted by the state it is in now.',
    },
    label: 'Objective Progress / Outcome / SLA',
    question:
      'Which objectives are on track, how did the finished ones turn out, and were they on time?',
    sourcePermission: { module: 'objective', action: 'View' },
    scoped: true,
  },
  {
    key: 'HumanVsAiWorkMix',
    chart: {
      kind: 'series',
      labelColumn: 'kind',
      valueColumn: 'completed',
      title: 'Work finished, by who finished it',
      note: 'Completed items only. The table beside it carries what failed and what is still running.',
    },
    label: 'Human vs AI Work Mix',
    question: 'How much of the work is being done by people and how much by agents?',
    sourcePermission: null,
    scoped: true,
  },
  {
    key: 'EmployeeWorkload',
    chart: {
      kind: 'series',
      labelColumn: 'person',
      valueColumn: 'open',
      title: 'How the work is spread',
      note: 'Open items per person. One tall bar beside short ones is the queue to look at.',
    },
    label: 'Employee Workload',
    question: 'Who is carrying how much, and who is overdue?',
    sourcePermission: { module: 'todo', action: 'View' },
    scoped: true,
  },
  {
    key: 'EngineAgentHealth',
    chart: {
      kind: 'groupBy',
      column: 'status',
      title: 'Agents by state',
    },
    label: 'Engine Agent Health',
    question: 'Which agents are succeeding, which are failing, and which have stopped being used?',
    sourcePermission: { module: 'agents', action: 'View' },
    scoped: true,
  },
  {
    key: 'SkillUsageAndQuality',
    chart: {
      kind: 'groupBy',
      column: 'status',
      title: 'Skill versions by state',
      note: 'One bar per state. How many are published and running, and how many never left draft.',
    },
    label: 'Skill Usage & Quality',
    question: 'Which Skills are actually used, and what do reviewers say about what they produce?',
    sourcePermission: { module: 'agents', action: 'View' },
    scoped: false,
  },
  {
    key: 'DependencyWaiting',
    chart: {
      kind: 'groupBy',
      column: 'objective',
      title: 'What is waiting, by objective',
      note: 'Steps that cannot start because something before them is unfinished.',
    },
    label: 'Waiting on a dependency',
    question: 'What cannot start yet, what is it waiting for, and who is holding it up?',
    /*
     * `todo:View`, because the rows are people's tasks.
     *
     * Scoped, and that matters more here than on most reports: the answer to "who is holding this
     * up" is a named person, and a report that hands every reader the whole company's list of
     * people-blocking-people is a report that gets used for something other than unblocking work.
     */
    sourcePermission: { module: 'todo', action: 'View' },
    scoped: true,
  },
  {
    key: 'ExecutorExceptions',
    chart: {
      kind: 'groupBy',
      column: 'severity',
      title: 'Exceptions by severity',
    },
    label: 'Executor Agent Exceptions',
    question: 'What did the Executor Agent stop, escalate or flag, and is any of it still open?',
    sourcePermission: { module: 'executor', action: 'View' },
    scoped: true,
  },
  {
    key: 'ApprovalAging',
    chart: {
      kind: 'buckets',
      column: 'waitingDays',
      edges: [1, 3, 7, 14],
      unit: 'day',
      title: 'How long approvals have waited',
      note: 'The last band is the one somebody has been blocked behind the longest.',
    },
    label: 'Approval Aging',
    question: 'What is waiting for a decision, and how long has it been waiting?',
    sourcePermission: { module: 'approvals', action: 'View' },
    scoped: true,
  },
  {
    key: 'AiUsageAndCost',
    /*
     * Cost per day, which is what the rows already are.
     *
     * The report groups its ledger by day before returning it, so each bar is a day's total
     * rather than a charge — the one reading that does not turn a list of charges into a
     * trend it never measured.
     */
    chart: {
      kind: 'series',
      labelColumn: 'day',
      valueColumn: 'amountMinor',
      format: 'money',
      title: 'What AI work cost, by day',
      note: 'One bar per day in the period.',
    },
    label: 'AI Usage & Cost',
    question: 'What has AI work cost, and where did it go?',
    sourcePermission: { module: 'settings', action: 'Administer' },
    scoped: false,
  },
  {
    key: 'AuditActivity',
    /*
     * Events per action, which the report has already counted.
     *
     * This does not attempt to picture the trail itself — a sequence of distinct events has no
     * shape worth drawing. It answers the narrower question the rows do support: which kinds of
     * change happened most in this period.
     */
    chart: {
      kind: 'series',
      labelColumn: 'action',
      valueColumn: 'events',
      title: 'What kinds of change happened most',
    },
    label: 'Audit Activity',
    question: 'What changed in this company, who changed it, and when?',
    sourcePermission: { module: 'settings', action: 'Audit' },
    scoped: false,
  },
  {
    key: 'PerformanceAndBadges',
    chart: {
      kind: 'groupBy',
      column: 'currentBadge',
      title: 'People by badge',
      note: 'Each person counted once, under the badge they hold now.',
    },
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
