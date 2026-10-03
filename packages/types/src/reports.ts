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

/**
 * Every work area the dashboard can offer.
 *
 * ## Why it is now all twelve and not seven
 *
 * The sidebar reaches twelve places and the dashboard carried seven, so Hierarchy, Agent Builder,
 * Workspace Chat and Settings were reachable only from the rail. The client's instruction is that
 * the dashboard is the shortcut to everything — a person should be able to start their day on one
 * screen and get anywhere from it.
 *
 * Adding a tile does not widen anybody's access. Each one is gated on its own module below, and
 * the server only ever returns the tiles that person already holds a grant on.
 */
export const DASHBOARD_TILES = [
  'objectives',
  'tasks',
  'agents',
  'hierarchy',
  'agent-builder',
  'chat',
  'approvals',
  'exceptions',
  'performance',
  'reports',
  'settings',
  'stage',
] as const;
export type DashboardTile = (typeof DASHBOARD_TILES)[number];

/** The module each tile is gated on. The server checks this; the browser never decides. */
export const DASHBOARD_TILE_MODULE: Record<DashboardTile, string> = {
  objectives: 'objective',
  tasks: 'todo',
  agents: 'agents',
  hierarchy: 'hierarchy',
  'agent-builder': 'agent-builder',
  // Chat is open to everybody in a company — the sidebar entry carries `module: null` for the
  // same reason. There is no `chat` module to gate it on, and inventing one here would be a
  // permission the authorization engine has never heard of.
  chat: 'dashboard',
  approvals: 'approvals',
  exceptions: 'executor',
  performance: 'performance',
  reports: 'reports',
  settings: 'settings',
  // The stage overview is objective work, so it is gated exactly as objectives are.
  stage: 'objective',
};

/**
 * The words on each tile, which are the words in the sidebar.
 *
 * `agents` reads **Engine Agents**, not *Job Agents*: the sidebar, the screen's own heading and
 * its breadcrumb all say Engine Agents, and the dashboard was the one place calling the same
 * thing something else. A shortcut whose label does not match its destination is a shortcut
 * somebody checks twice.
 */
export const DASHBOARD_TILE_LABELS: Record<DashboardTile, string> = {
  objectives: 'Objectives',
  tasks: 'Tasks',
  agents: 'Engine Agents',
  hierarchy: 'Hierarchy',
  'agent-builder': 'Agent Builder',
  chat: 'Workspace Chat',
  approvals: 'Approvals',
  exceptions: 'Exceptions',
  performance: 'Performance',
  reports: 'Reports',
  settings: 'Settings',
  stage: 'Where the work is',
};

/**
 * What each tile's number means, in the words the screen shows under it.
 *
 * Written down rather than left to the component, because a count with no stated meaning is the
 * thing two people read two different ways — and on this screen two people with different scopes
 * legitimately see different numbers.
 */
export const DASHBOARD_TILE_MEASURE: Record<DashboardTile, string | null> = {
  objectives: 'Live, in your scope',
  tasks: 'Assigned and not finished',
  agents: 'Published and running',
  'agent-builder': 'Waiting to be built',
  approvals: 'Waiting on a decision',
  exceptions: 'Open and unresolved',
  // No count, so nothing to measure. What these areas *are* is `DASHBOARD_TILE_DESCRIPTION`.
  hierarchy: null,
  chat: null,
  performance: null,
  reports: null,
  settings: null,
  stage: null,
};

/**
 * What is behind each door, for the areas that have no number.
 *
 * ## Why this is not the same field as the measure
 *
 * Because they answer different questions. A measure explains a figure — *45 what?* — and only a
 * tile with a figure has one. A description explains a destination, and every tile has one of
 * those. Putting both in one field is how Performance and Reports ended up reading *"Everything
 * this area holds"*: a fallback sentence, identical on both, which told a reader nothing about
 * either and was the first thing the client noticed.
 *
 * Counted tiles have a description too. It is simply not what the screen shows them, because the
 * measure is the more useful of the two when there is a number above it.
 */
export const DASHBOARD_TILE_DESCRIPTION: Record<DashboardTile, string> = {
  objectives: 'Business intent, its workflow and its outcome',
  tasks: 'The work that is yours to do',
  agents: 'Published AI workers and their runs',
  hierarchy: 'Departments, reporting lines and people',
  'agent-builder': 'Turn assigned AI work into an agent',
  chat: 'Conversations and department workshops',
  approvals: 'Decisions waiting on somebody',
  exceptions: 'What the Executor could not resolve',
  performance: 'Scores, badges and how work turned out',
  reports: 'Objectives, cost, agents and the audit trail',
  settings: 'Company rules, people, roles and billing',
  stage: 'Stage, department and what is waiting',
};

/** Where each tile goes. Every destination is a route that exists. */
export const DASHBOARD_TILE_DESTINATIONS: Record<DashboardTile, string> = {
  objectives: '/objective',
  tasks: '/todo',
  agents: '/agents',
  hierarchy: '/hierarchy',
  'agent-builder': '/agent-builder',
  chat: '/chat',
  approvals: '/approvals',
  exceptions: '/executor',
  performance: '/performance',
  reports: '/reports',
  settings: '/settings',
  // It has no screen of its own: the card under the map is the whole of it.
  stage: '/dashboard',
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
  execution: 'Execution & Setup',
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
  execution: 'Where work is set up and carried out',
  oversight: 'Where it is decided on and reviewed',
};

/**
 * Which side each area belongs to.
 *
 * The third lane exists because *setting something up* is neither doing the work nor reviewing it.
 * Hierarchy, Agent Builder and Settings are things somebody configures once and returns to rarely;
 * putting them beside the daily queues made both harder to find. Workspace Chat sits with them
 * because it is where a change gets asked for, which is the step before it is set up.
 */
export const DASHBOARD_TILE_LANE: Record<DashboardTile, DashboardLane> = {
  objectives: 'execution',
  tasks: 'execution',
  agents: 'execution',
  hierarchy: 'execution',
  'agent-builder': 'execution',
  chat: 'execution',
  settings: 'execution',
  stage: 'oversight',
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
  'AgentRunsPerDay',
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

/**
 * How a report draws itself, when a picture says it better than the table does.
 *
 * Declared per report rather than guessed by the screen, and every kind is built out of the rows
 * the report already returned: counting them, reading a column they already carry, or binning a
 * number they already hold. Nothing is interpolated, smoothed or projected — if the report does
 * not already know it, the chart does not show it.
 *
 * **The kind is chosen by the question, not by habit.** Every report here used to draw the same
 * bar chart, which is how a screen ends up with eleven pictures that all look alike and only two
 * of them mean anything: a distribution wants bars, a proportion wants one bar cut up, days want a
 * line, a single figure wants to be read as a figure, and a handful of things with states want
 * their states. A report whose data suits none of these has no chart, and that is a better answer
 * than a decorative one.
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
    }
  /**
   * A total per step of time, drawn as a line.
   *
   * The one shape where a line is honest, and the distinction is the whole reason this kind
   * exists: a line between two categories invents a journey from one to the other, but a line
   * across days is drawn along the axis the rows are already ordered by. The report grouped its
   * own rows into days before returning them, so each point is a day's real total and the segment
   * between two points says only "this came after that" — which is true.
   *
   * Rows are drawn in the order the report returned them. Nothing is re-sorted: the order *is*
   * the axis, and sorting a time series by height would destroy it.
   */
  | {
      kind: 'line';
      labelColumn: string;
      valueColumn: string;
      title: string;
      note?: string;
      /** Minor units rendered as money. Anything else is a plain count. */
      format?: 'money';
    }
  /**
   * One bar, cut into the parts that make it up.
   *
   * For the question that is about proportion rather than size — how much of the work is done by
   * people and how much by agents. Two bars side by side answer it only after the reader does the
   * division; one bar split in two answers it before they have finished reading the title.
   *
   * Right only for a handful of parts that genuinely sum to a meaningful whole. Sixteen
   * departments in one bar is a stripe, not an answer.
   */
  | {
      kind: 'share';
      labelColumn: string;
      valueColumn: string;
      title: string;
      note?: string;
    }
  /**
   * One number, because one number is the entire answer.
   *
   * "What cannot start yet" is a count. Drawing it as a bar chart of one bar, or as a bar per
   * objective, buries the only figure that matters inside a picture of itself — and three of these
   * reports return a single row, where a chart is not a summary of the table but a slower copy of
   * it.
   *
   * The number is the rows the report returned; `detail` reads a second figure out of the summary
   * the report already computed. Neither is derived from anything else.
   */
  | {
      kind: 'tally';
      title: string;
      /** What one row is, in words. Pluralised by the screen. */
      unit: string;
      /** A second line, read from a key of the report's own summary. */
      detail?: { key: string; label: string };
      /**
       * At or above this count, the figure is something to act on rather than to note.
       *
       * It changes the colour and nothing else. No threshold is invented for a report that did
       * not name one — an absent `concernAt` means every count is drawn plainly, because a number
       * the product has no opinion about must not be coloured as though it had.
       */
      concernAt?: number;
      note?: string;
    }
  /**
   * Parts of one whole, as a ring.
   *
   * The question this answers is "how is it divided", where every row belongs to exactly one part
   * and the parts together are everything — objectives by state, exceptions by severity. Bars
   * answer "which is biggest"; a ring answers "how much of it is that", and the difference is the
   * one a manager is actually asking when they look at a status breakdown.
   *
   * Wrong wherever the parts do not make a whole. Cost per day is not parts of anything, and a
   * ring of days would invite a reader to think of Tuesday as a share of the week's budget.
   *
   * Not the dashboard's donut, which is a locked two-slice contract for one screen and stays that
   * way. This is a general reading of a report's own rows.
   */
  | { kind: 'donut'; column: string; title: string; note?: string }
  /**
   * A chip per row, coloured by how that row is doing.
   *
   * For a report whose rows are *things with a state* rather than a distribution — the agents, in
   * practice. This company has one agent, so the bar chart of agents-by-status was a single bar of
   * height one: a picture that took a quarter of the screen to say nothing the row beneath it did
   * not already say.
   *
   * The tone is read from the columns named here and from nothing else: anything that failed is
   * bad, anything that never ran is unproven, everything else is well. There is no health score
   * and no judgement the rows do not contain.
   */
  | {
      kind: 'status';
      labelColumn: string;
      totalColumn: string;
      failedColumn: string;
      /** What is being counted — a run, an evaluation. Pluralised by the screen. */
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
      kind: 'donut',
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
    /*
     * One bar cut in two, because the question is a proportion.
     *
     * Two bars side by side made a reader compare two lengths and do the division themselves to
     * reach the number they came for. The split bar is the answer: the share is the width.
     */
    chart: {
      kind: 'share',
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
    /*
     * The agents themselves, each with how it is doing.
     *
     * Counting agents by status was a bar chart of one bar in every company that has one agent,
     * and of three identical bars in a company whose agents are all Active — the status column
     * says whether somebody switched an agent on, which is not the same question as whether it is
     * working. Failures and disuse are, and they are in the rows already.
     */
    chart: {
      kind: 'status',
      labelColumn: 'agent',
      totalColumn: 'runs',
      failedColumn: 'failed',
      unit: 'run',
      title: 'How each agent is doing',
      note: 'Runs in this period. An agent that has not run at all is unproven rather than well.',
    },
    label: 'Engine Agent Health',
    question: 'Which agents are succeeding, which are failing, and which have stopped being used?',
    sourcePermission: { module: 'agents', action: 'View' },
    scoped: true,
  },
  {
    key: 'SkillUsageAndQuality',
    chart: {
      kind: 'donut',
      column: 'status',
      title: 'Skill versions by state',
      note: 'How many are published and running, and how many never left draft.',
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
      kind: 'donut',
      column: 'severity',
      title: 'Exceptions by severity',
      note: 'Each exception counted once. How much of what the Executor stopped was serious.',
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
     * Cost per day, as a line, because days are an axis.
     *
     * The report groups its ledger by day before returning it, so each point is a day's real
     * total rather than a charge. Drawn as bars sorted tallest-first — which is what every chart
     * on this screen used to do — the days came out of order, and the one thing a cost chart is
     * opened for is whether the spend is climbing.
     */
    chart: {
      kind: 'line',
      labelColumn: 'day',
      valueColumn: 'amountMinor',
      format: 'money',
      title: 'What AI work cost, by day',
      note: 'One point per day in the period.',
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
  {
    key: 'AgentRunsPerDay',
    /*
     * How much AI work this company actually did, by day.
     *
     * A line, because days are an axis and the question is a direction: is the product doing more
     * for us this month than last. Bars sorted by height would answer "which day was busiest",
     * which nobody asks — and would put the days out of order, which is the one thing that makes
     * a trend unreadable.
     *
     * It is a count of runs, not of successes: a day with forty runs of which ten failed is a busy
     * day with a problem, and splitting that into two lines here would answer the health question
     * badly when Engine Agent Health answers it properly. The table beside the chart carries the
     * split, so the number is never just a total with nothing behind it.
     */
    chart: {
      kind: 'line',
      labelColumn: 'day',
      valueColumn: 'runs',
      title: 'Agent runs, by day',
      note: 'One point per day in the period. Every run, whatever it ended as.',
    },
    label: 'Agent Runs per Day',
    question: 'How many agent runs happen each day, and is that going up?',
    /*
     * `agents: View` — the same permission that reads an agent's own history.
     *
     * Not `settings: Administer` like the cost report: how much work the company's agents did is
     * operational rather than commercial, and the people who run agents are the people who should
     * see whether they are running. What it costs is a different question with a different answer.
     */
    sourcePermission: { module: 'agents', action: 'View' },
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

// ---------------------------------------------------------------------------
// What a column is called on screen
// ---------------------------------------------------------------------------

/**
 * A readable heading for every report column.
 *
 * ## Why this exists
 *
 * The report screens rendered the column *key* as the heading, so a manager reading a report saw
 * `slaOutcome`, `lastRunAt`, `waitingSince`, `resourceType` and `amountMinor` — the names a
 * programmer gave the database. Across eleven reports that is about fifty headings, and a report
 * is the one screen somebody shows their own boss.
 *
 * ## Labels here rather than renaming the keys
 *
 * The key is what a row is looked up by and what the CSV export writes, so renaming it would
 * change the data's shape for anyone who already builds on the export. The key stays; the screen
 * gains a name.
 *
 * ## Written as the question a person would ask
 *
 * `waitingOn` is "Waiting for", not "Waiting On" — title-casing the key is the same mistake in a
 * nicer font. Where a column is ambiguous on its own the label says which thing it counts:
 * `events` in the audit report is "Times it happened", and in the performance report it is
 * "Scored events".
 */
export const REPORT_COLUMN_LABELS: Record<string, string> = {
  action: 'What happened',
  agent: 'Agent',
  // Money is stored in minor units and must never be *shown* in them — see `formatReportCell`.
  amountMinor: 'Cost',
  badgeChanges: 'Badge changes',
  closedAt: 'Closed',
  completed: 'Completed',
  currentBadge: 'Badge now',
  day: 'Day',
  dueAt: 'Due',
  entries: 'Charges',
  evaluations: 'Reviews',
  events: 'Times',
  failed: 'Failed',
  inFlight: 'In progress',
  inputTokens: 'Input tokens',
  kind: 'Kind',
  lastAt: 'Last seen',
  lastRunAt: 'Last run',
  objective: 'Objective',
  open: 'Open',
  openedAt: 'Raised',
  outputTokens: 'Output tokens',
  overdue: 'Overdue',
  owner: 'Owner',
  passed: 'Passed',
  person: 'Person',
  points: 'Points',
  requestedBy: 'Asked by',
  resourceType: 'What it was about',
  runs: 'Runs',
  severity: 'Severity',
  skill: 'Skill',
  slaOutcome: 'On time?',
  state: 'State',
  status: 'Status',
  step: 'Step',
  succeeded: 'Succeeded',
  title: 'What',
  type: 'Type',
  verdict: 'Verdict',
  version: 'Version',
  waitingDays: 'Waiting (days)',
  waitingOn: 'Waiting for',
  waitingSince: 'Waiting since',
};

/**
 * The heading for a column, falling back to the key split into words.
 *
 * A key with no label is a column somebody added without naming it. Splitting `someNewField`
 * into "Some new field" is better than printing it raw, and it stays obviously unfinished — which
 * is the point: the fallback should not be comfortable enough to live with.
 */
export function reportColumnLabel(column: string): string {
  const known = REPORT_COLUMN_LABELS[column];
  if (known !== undefined) return known;
  const spaced = column.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Columns holding money in minor units. Shown as an amount, never as the integer. */
export const REPORT_MONEY_COLUMNS: readonly string[] = ['amountMinor'];

/**
 * Columns a **company** must not be shown.
 *
 * Token counts are a provider's unit of account. A customer who has them can divide the charge by
 * the tokens, read off a per-million rate and match it against a public price list — which names
 * the provider as surely as printing its name would, and shows the margin besides. They were
 * removed from the cost drill-down and the ledger; this report was missed.
 *
 * The columns stay in the data, and the platform plane reads them.
 */
export const REPORT_COLUMNS_HIDDEN_FROM_COMPANY: readonly string[] = [
  'inputTokens',
  'outputTokens',
];

/**
 * The overview: the four or five questions somebody opens this section to answer.
 *
 * ## Why a layer above the reports at all
 *
 * Eleven reports behind eleven tabs is a filing cabinet, not a screen. Whoever opens Reports is
 * not looking for the Dependency Waiting report — they are looking to find out whether anything
 * is stuck, and they have to already know which drawer that lives in before the product will tell
 * them. So the first thing the screen does now is answer, and the reports are what the answers
 * open into.
 *
 * ## Each panel reads one report, and that is not a limitation
 *
 * A panel is a compact drawing of rows the reader's own permissions already allowed them to run.
 * Nothing here is a new query, a new aggregate or a new number: the cost panel runs the AI Usage &
 * Cost report and draws the days it returned. The consequences matter more than the tidiness —
 *
 *   * **A panel a reader may not see is absent.** The catalogue is filtered by the server, so an
 *     Employee without `settings:Administer` gets no cost panel, exactly as they get no cost tab.
 *     Building the overview from its own endpoint would have meant a second authorization path
 *     over the same data, which is the shape of every reporting leak.
 *   * **The scope is the reader's scope.** Each report applies the reporting tree itself, so a
 *     manager's workload panel is their own people, not the company's.
 *   * **The panel and the report can never disagree**, because clicking the panel runs the same
 *     report over the same period the panel was drawn from.
 *
 * ## Why these five
 *
 * They are the questions asked daily rather than the reports that were easiest to summarise:
 * what it is costing, how much of it the agents are doing, who is carrying too much, what cannot
 * move, and whether the agents are working at all. Objectives are deliberately not here — the
 * Dashboard already carries them, and the locked contract puts exactly one picture of objectives
 * in this product.
 */
export interface ReportOverviewPanel {
  key: string;
  /** The question, in the words somebody would use to ask it out loud. */
  question: string;
  /** The report this panel draws, and the one a click opens in full. */
  report: ReportKey;
  /**
   * How the panel draws — usually a more compact reading than the report's own chart.
   *
   * The workload report draws a bar per person; the panel draws the same bars but only the few at
   * the top, because "who is carrying the most" is answered by the top of that list and the rest
   * is the report's job.
   */
  chart: ReportChart;
}

export const REPORT_OVERVIEW: readonly ReportOverviewPanel[] = [
  {
    key: 'cost',
    question: 'What is AI work costing?',
    report: 'AiUsageAndCost',
    chart: {
      kind: 'line',
      labelColumn: 'day',
      valueColumn: 'amountMinor',
      format: 'money',
      title: 'Cost by day',
    },
  },
  {
    key: 'mix',
    question: 'How much of the work is AI doing?',
    report: 'HumanVsAiWorkMix',
    chart: {
      kind: 'share',
      labelColumn: 'kind',
      valueColumn: 'completed',
      title: 'Finished work',
    },
  },
  {
    key: 'load',
    question: 'Who is carrying the most?',
    report: 'EmployeeWorkload',
    chart: {
      kind: 'series',
      labelColumn: 'person',
      valueColumn: 'open',
      title: 'Open items',
    },
  },
  {
    key: 'stuck',
    question: 'What cannot start yet?',
    report: 'DependencyWaiting',
    /*
     * A number, not a picture.
     *
     * The answer is a count and a date — how many steps are held, and how long the oldest has
     * been held. Charting a count of one against a count of nothing is a bar chart that says
     * "one", in a space that could have said "one step, waiting since the 4th".
     */
    chart: {
      kind: 'tally',
      title: 'Held by something earlier',
      unit: 'step',
      detail: { key: 'oldestWaitingSince', label: 'Longest wait since' },
      concernAt: 1,
    },
  },
  {
    key: 'agents',
    question: 'Are the agents working?',
    report: 'EngineAgentHealth',
    chart: {
      kind: 'status',
      labelColumn: 'agent',
      totalColumn: 'runs',
      failedColumn: 'failed',
      unit: 'run',
      title: 'Each agent',
    },
  },
];
