/**
 * Performance and scale validation — Prompt 43.
 *
 * The pure half: what is measured, what counts as a pass, and how a percentile is computed. The
 * measuring itself needs a database and a clock and lives in `apps/api/perf`; everything here can
 * be tested without either, which matters because **a benchmark whose arithmetic is wrong is worse
 * than no benchmark** — it produces confident numbers that send somebody optimising the wrong thing.
 *
 * ## Why budgets are declared rather than discovered
 *
 * A run that reports "p95 was 412ms" tells nobody anything. A run that reports "p95 was 412ms
 * against a 300ms budget" is a verdict. The budgets below are the product's own claims about what
 * each screen should feel like, written down before the measuring so the measuring cannot quietly
 * become the target.
 *
 * ## What this deliberately does not model
 *
 * Throughput. Requests per second is the number everybody asks for and the one least transferable
 * between a laptop and a cluster — a figure measured here would be a statement about this machine
 * wearing the authority of a capacity plan. Latency percentiles and query plans transfer; a plan
 * that seq-scans at ten thousand rows seq-scans at ten million.
 */

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

/**
 * The nine scenarios Prompt 43 names, as data.
 *
 * `budgetMs` is the p95 each one is held to. The numbers are not aspirations: each is the point at
 * which the interaction stops feeling immediate to the person doing it, which is a different
 * threshold for a list somebody reads and a spike nobody watches.
 */
export const SCALE_SCENARIOS = [
  {
    key: 'HierarchyList',
    label: 'Large tenant hierarchy list',
    what: 'Every employment record in a company, with department, manager and account state.',
    budgetMs: 400,
    why: 'A screen somebody opens and reads. Above this it feels like it is loading rather than open.',
  },
  {
    key: 'HierarchySubtree',
    label: 'Reporting subtree query',
    what: 'The recursive walk that decides whether one person reports to another.',
    budgetMs: 50,
    why: 'Not a screen — an authorization check, on the path of other requests. It has to be cheap.',
  },
  {
    key: 'ConcurrentSessions',
    label: 'Concurrent logins and sessions',
    what: 'Session lookups under simultaneous load.',
    budgetMs: 200,
    why: 'Sign-in is the first impression and the one everybody makes at 9am on the same morning.',
  },
  {
    key: 'ObjectiveList',
    label: 'Objective list and version history',
    what: 'A company objective list, and one objective read back through its versions.',
    budgetMs: 400,
    why: 'Version history grows forever by design, so this is the query that degrades with age.',
  },
  {
    key: 'WorkflowCanvas',
    label: 'Workflow canvas retrieval',
    what: 'A workflow draft graph, loaded whole.',
    budgetMs: 300,
    why: 'One document, fetched to draw a canvas. Slowness here reads as a broken editor.',
  },
  {
    key: 'AuditList',
    label: 'Large notification and audit lists',
    what: 'A page of audit events and a page of notifications in a company with many of both.',
    budgetMs: 400,
    why: 'Both tables only grow. An audit trail nobody can open is an audit trail in name only.',
  },
  {
    key: 'ScheduledAgentSpike',
    label: 'Scheduled Agent spike',
    what: 'Many agents falling due in the same tick.',
    budgetMs: 2000,
    why: 'Nobody is watching. What matters is that the tick finishes and queues everything once.',
  },
  {
    key: 'CreditReservation',
    label: 'Concurrent credit reservations',
    what: 'Simultaneous reservations against one balance.',
    budgetMs: 500,
    why: 'Correctness first — the budget is here so a lock that serialises badly is still visible.',
  },
  {
    key: 'ProviderLatency',
    label: 'Provider latency and failure',
    what: 'A slow or failing model provider, and what the caller does about it.',
    budgetMs: 1000,
    why: 'Measures UBoss’s overhead around the call, not the provider’s own time.',
  },
] as const;

export type ScaleScenarioKey = (typeof SCALE_SCENARIOS)[number]['key'];

export function scenarioFor(key: string): (typeof SCALE_SCENARIOS)[number] | undefined {
  return SCALE_SCENARIOS.find((scenario) => scenario.key === key);
}

// ---------------------------------------------------------------------------
// Percentiles
// ---------------------------------------------------------------------------

/**
 * The p-th percentile of a set of samples, by nearest-rank.
 *
 * Nearest-rank rather than interpolated, and the choice matters at the sample counts a scenario
 * run actually produces. With 20 samples an interpolated p99 is a weighted average of the two
 * slowest — a number that appears in no request anyone made. Nearest-rank returns **an observation**:
 * the p99 is a request that really took that long.
 *
 * Returns null for no samples rather than 0, because "nothing was measured" and "everything was
 * instant" must never look alike in a report.
 */
export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  if (p <= 0) return Math.min(...samples);
  if (p >= 100) return Math.max(...samples);

  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank: ceil(p/100 × N), 1-indexed.
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index] ?? null;
}

export interface ScenarioMeasurement {
  scenario: ScaleScenarioKey;
  /** Every successful sample, in milliseconds. */
  samples: number[];
  /** How many attempts threw. Kept apart from the samples: a failure has no latency. */
  errors: number;
}

export interface ScenarioResult {
  scenario: ScaleScenarioKey;
  label: string;
  runs: number;
  errors: number;
  errorRate: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  budgetMs: number;
  withinBudget: boolean;
  verdict: 'Pass' | 'OverBudget' | 'Failed' | 'NotMeasured';
}

/**
 * Turn raw samples into a verdict.
 *
 * Three rules worth stating, because each is a way a benchmark lies:
 *
 *   * **A failed attempt is not a fast attempt.** An error contributes to `errorRate` and never to
 *     the samples, so a scenario that throws instantly cannot report an excellent p95.
 *   * **Any error at all fails the scenario**, whatever the latency was. A fast wrong answer is not
 *     a pass, and a benchmark that averages errors away is how a broken path ships.
 *   * **No samples is `NotMeasured`, never `Pass`.** A scenario that did not run must not look like
 *     one that ran well.
 */
export function summarise(
  measurement: ScenarioMeasurement,
  budgets: readonly (typeof SCALE_SCENARIOS)[number][] = SCALE_SCENARIOS,
): ScenarioResult {
  const scenario = budgets.find((entry) => entry.key === measurement.scenario);
  const budgetMs = scenario?.budgetMs ?? 0;
  const runs = measurement.samples.length + measurement.errors;

  const p50 = percentile(measurement.samples, 50);
  const p95 = percentile(measurement.samples, 95);
  const p99 = percentile(measurement.samples, 99);

  const errorRate = runs === 0 ? 0 : measurement.errors / runs;
  const withinBudget = p95 !== null && p95 <= budgetMs;

  let verdict: ScenarioResult['verdict'];
  if (measurement.samples.length === 0) verdict = 'NotMeasured';
  else if (measurement.errors > 0) verdict = 'Failed';
  else if (!withinBudget) verdict = 'OverBudget';
  else verdict = 'Pass';

  return {
    scenario: measurement.scenario,
    label: scenario?.label ?? measurement.scenario,
    runs,
    errors: measurement.errors,
    errorRate,
    p50,
    p95,
    p99,
    budgetMs,
    withinBudget,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Query plans — the evidence that transfers
// ---------------------------------------------------------------------------

/**
 * Does this `EXPLAIN` plan contain a sequential scan over a table that will keep growing?
 *
 * The reason this is the assertion rather than a latency threshold: **a millisecond figure measured
 * on one laptop says nothing about a production cluster, and a query plan says everything.** A plan
 * that seq-scans ten thousand rows will seq-scan ten million, and that is true regardless of the
 * hardware it was observed on.
 *
 * Small tables are exempt because scanning them is correct — the planner choosing a seq scan over
 * a forty-row table is the planner being right, and an index there would be ignored.
 */
export function planSeqScansLargeTable(
  plan: string,
  options: { largeTables: readonly string[] },
): string[] {
  const found: string[] = [];

  for (const table of options.largeTables) {
    // `Seq Scan on employment_records e` — the table name follows the keyword.
    const pattern = new RegExp(`Seq Scan on (?:public\\.)?"?${table}"?\\b`, 'i');
    if (pattern.test(plan)) found.push(table);
  }

  return found;
}

/** The tables that grow without bound, and therefore must never be scanned. */
export const UNBOUNDED_TABLES = [
  'audit_events',
  'audit_trail_entries',
  'notifications',
  'agent_runs',
  'agent_run_events',
  'employment_records',
  'objective_versions',
  'chat_messages',
  'security_events',
] as const;

// ---------------------------------------------------------------------------
// What a run is allowed to claim
// ---------------------------------------------------------------------------

export const SCALE_CLAIM_STANCE =
  'These figures were measured on a single developer machine against one PostgreSQL container. ' +
  'They are evidence that a query plan is sound and that no scenario regressed; they are not a ' +
  'capacity plan, and UBoss must not be described as validated to any particular user count on ' +
  'the strength of them. What transfers between this machine and a cluster is the query plan. ' +
  'What does not transfer is the millisecond.';

/** Named so a report cannot quietly imply the opposite. */
export const NOT_MEASURED_HERE: readonly { item: string; why: string }[] = [
  {
    item: 'Throughput (requests per second)',
    why: 'Entirely a property of the hardware and the connection pool. A number from here would mislead.',
  },
  {
    item: 'Multi-node behaviour',
    why: 'One API process, one database. Nothing here exercises a load balancer or a replica.',
  },
  {
    item: 'WebSocket fan-out at scale',
    why:
      'The gateway is in-process and the transport is not bound in this environment, so a fan-out ' +
      'measurement would be measuring an event emitter.',
  },
  {
    item: 'Redis saturation',
    why:
      'The queue selects its inline fallback without REDIS_URL, which is what the suite runs. ' +
      'Broker saturation needs the broker.',
  },
  {
    item: 'Sustained load over hours',
    why: 'Connection leaks, cache drift and table bloat appear over time, and these runs are seconds.',
  },
];
