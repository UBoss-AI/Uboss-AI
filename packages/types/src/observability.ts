/**
 * Observability, metrics, tracing and the incident workflow — Prompt 39.
 *
 * ## What this prompt adds, and what it extends
 *
 * Three of the seven things asked for already exist and are **extended, not rebuilt**:
 *
 * * **Correlation ids** — `CorrelationIdMiddleware` has propagated one from the browser through
 *   the API since Prompt 5, and both trails carry it. What was missing is the tail of the chain:
 *   the prompt asks for *"browser/API → queue → run → provider/tool → cost settlement"*, and the
 *   id stopped at the run row. `model_gateway_calls` and `cost_ledger_entries` now carry it too,
 *   so one identifier joins a click to the money it spent.
 * * **Incident records** — `service_alerts` gained severity, owner, acknowledgement, customer
 *   impact and mitigation at Prompt 36, which deliberately left the *workflow* here and said so in
 *   `INCIDENT_WORKFLOW_BOUNDARY`. This prompt adds the timeline, the postmortem and the corrective
 *   actions.
 * * **System Health** — built at Prompt 36 from probes. It now also carries measured metrics.
 *
 * What is genuinely new: the metric registry, the alert rules that evaluate it, and the tracing
 * seam.
 *
 * ## The tracing seam is a seam, and says so
 *
 * There is no OpenTelemetry exporter, because there is no collector to export to — no endpoint,
 * no credentials, no backend. A `Tracer` abstraction exists with a working in-process
 * implementation that records spans and propagates the correlation id, and an OTel adapter is one
 * class away. The same honesty rule as `S3StorageAdapter` and the provider adapters: the seam is
 * real, the integration is not claimed. `TRACING_STANCE` says so where a screen can show it.
 */

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * The metrics the prompt names, and nothing invented beside them.
 *
 * Each one is a question an operator asks during an incident. A metric nobody would look at during
 * an outage is a number that costs memory and attention.
 */
export const METRIC_KEYS = [
  'request_latency_ms',
  'request_errors',
  'queue_depth',
  'queue_oldest_age_ms',
  'run_outcomes',
  'provider_errors',
  'tool_errors',
  'connection_health',
  'credit_reservation_drift',
  'notification_failures',
  // ---- Prompt 40 ----
  'rate_limit_refusals',
  'run_admission_deferrals',
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export const METRIC_LABELS: Record<MetricKey, string> = {
  request_latency_ms: 'Request latency',
  request_errors: 'Request errors',
  queue_depth: 'Queue depth',
  queue_oldest_age_ms: 'Oldest queued job',
  run_outcomes: 'Run outcomes',
  provider_errors: 'Provider errors',
  tool_errors: 'Tool and connection errors',
  connection_health: 'Connection health',
  credit_reservation_drift: 'Credit reservation drift',
  notification_failures: 'Notification failures',
  rate_limit_refusals: 'Rate-limited requests',
  run_admission_deferrals: 'Runs held back for fairness',
};

export const METRIC_QUESTIONS: Record<MetricKey, string> = {
  request_latency_ms: 'Is the API slow?',
  request_errors: 'Is the API failing?',
  queue_depth: 'Is work piling up?',
  queue_oldest_age_ms: 'Has something been stuck?',
  run_outcomes: 'Are agent runs succeeding?',
  provider_errors: 'Is an AI provider failing us?',
  tool_errors: 'Are customer integrations failing?',
  connection_health: 'How many customer connections are unhealthy?',
  credit_reservation_drift:
    'Has money been reserved and never settled or released? Drift means the ledger and the ' +
    'wallets disagree.',
  notification_failures: 'Are people not being told things?',
  rate_limit_refusals:
    'Is anybody being throttled, and at which layer? A sustained figure is either abuse or a ' +
    'customer integration retrying in a loop — both worth knowing, and neither visible from a ' +
    'success rate.',
  run_admission_deferrals:
    'Is fairness actually biting? A high figure means companies are queueing behind each other ' +
    'rather than one starving the rest — the control working, and also the signal that more ' +
    'workers are needed.',
};

/**
 * What kind of number each metric is.
 *
 * A counter only goes up and is read as a rate; a gauge is a reading at an instant; a histogram
 * summarises a distribution. Getting this wrong makes a dashboard lie — a latency *counter* would
 * show a number that grows forever and means nothing.
 */
export const METRIC_KINDS = ['counter', 'gauge', 'histogram'] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

export const METRIC_KIND: Record<MetricKey, MetricKind> = {
  request_latency_ms: 'histogram',
  request_errors: 'counter',
  queue_depth: 'gauge',
  queue_oldest_age_ms: 'gauge',
  run_outcomes: 'counter',
  provider_errors: 'counter',
  tool_errors: 'counter',
  connection_health: 'gauge',
  credit_reservation_drift: 'gauge',
  notification_failures: 'counter',
  rate_limit_refusals: 'counter',
  run_admission_deferrals: 'counter',
};

/**
 * Label names permitted on each metric.
 *
 * A closed set, because **an unbounded label is how a metrics system falls over**. A `tenant_id`
 * label on a per-request metric multiplies every series by the number of customers; a `user_id`
 * label multiplies it by every person. Neither appears here, and `metricLabelsArePermitted`
 * refuses them — the tenant dimension belongs in the audit trail, which is queryable and bounded.
 */
export const METRIC_LABELS_ALLOWED: Record<MetricKey, readonly string[]> = {
  request_latency_ms: ['route', 'method'],
  request_errors: ['route', 'method', 'status'],
  queue_depth: ['queue'],
  queue_oldest_age_ms: ['queue'],
  run_outcomes: ['outcome'],
  // The *logical* profile, never the provider's name — the locked rule is that provider names do
  // not leave the Model Gateway, and a metric label is a place they would leak into a dashboard.
  provider_errors: ['profile', 'reason'],
  tool_errors: ['connector', 'reason'],
  connection_health: ['state'],
  credit_reservation_drift: [],
  notification_failures: ['kind', 'reason'],
  rate_limit_refusals: ['scope'],
  run_admission_deferrals: ['reason'],
};

export function metricLabelsArePermitted(key: MetricKey, labels: Record<string, string>): boolean {
  const allowed = METRIC_LABELS_ALLOWED[key];
  return Object.keys(labels).every((label) => allowed.includes(label));
}

/**
 * Label values a metric must never carry, whatever anybody adds later.
 *
 * Checked by a unit test against `METRIC_LABELS_ALLOWED`. High-cardinality identifiers turn a
 * metric into a per-row index, and `tenant` in particular would make a shared dashboard a
 * cross-tenant disclosure.
 */
export const FORBIDDEN_METRIC_LABELS: readonly string[] = [
  'tenant',
  'tenantId',
  'tenant_id',
  'user',
  'userId',
  'user_id',
  'email',
  'runId',
  'run_id',
  'provider',
];

export const METRIC_CARDINALITY_STANCE =
  'A metric label is a dimension every series is multiplied by, so the permitted labels are a ' +
  'closed set with no tenant, user, run or provider in it. "Which customer was affected" is an ' +
  'audit-trail question, answered by the correlation id — not a dashboard dimension that would ' +
  'turn one metric into one series per company.';

/** Histogram buckets in milliseconds. Chosen around what a person notices, not round numbers. */
export const LATENCY_BUCKETS_MS: readonly number[] = [5, 25, 100, 250, 1_000, 5_000, 30_000];

// ---------------------------------------------------------------------------
// Alert rules
// ---------------------------------------------------------------------------

/**
 * An alert rule: a metric, a comparison, a threshold and a severity.
 *
 * Declared as data rather than as code, so "what will page somebody" is a list a person can read
 * and argue with — which is the only way an alert set stays trustworthy.
 */
export interface AlertRule {
  key: string;
  metric: MetricKey;
  /** The service name the raised alert is filed against. */
  service: string;
  comparison: 'above' | 'below';
  threshold: number;
  /** Maps onto `ServiceAlertSeverity`. */
  severity: 'Info' | 'Warning' | 'Critical';
  /** What the alert says when it fires, in words an operator reads at 3am. */
  summary: string;
  /** Why this threshold and not another. An unexplained threshold gets tuned to silence. */
  rationale: string;
}

export const ALERT_RULES: readonly AlertRule[] = [
  {
    key: 'queue-backed-up',
    metric: 'queue_depth',
    service: 'run-queue',
    comparison: 'above',
    threshold: 500,
    severity: 'Warning',
    summary: 'The run queue is backing up.',
    rationale:
      'Five hundred waiting runs is more than a transient burst and less than a broken worker. ' +
      'Below it the queue drains on its own; above it somebody should look before customers do.',
  },
  {
    key: 'queue-stuck',
    metric: 'queue_oldest_age_ms',
    service: 'run-queue',
    comparison: 'above',
    threshold: 15 * 60_000,
    severity: 'Critical',
    summary: 'A run has been waiting more than fifteen minutes.',
    rationale:
      'Depth can be healthy while one job is wedged. Age catches the stuck worker that depth ' +
      'misses, and fifteen minutes is past any legitimate retry backoff.',
  },
  {
    key: 'provider-failing',
    metric: 'provider_errors',
    service: 'model-gateway',
    comparison: 'above',
    threshold: 20,
    severity: 'Warning',
    summary: 'An AI provider is returning errors.',
    rationale:
      'Providers fail transiently and the gateway retries. Twenty in a window is a pattern rather ' +
      'than noise, and it is the point at which fallback routing is worth checking.',
  },
  {
    key: 'connections-unhealthy',
    metric: 'connection_health',
    service: 'connections',
    comparison: 'above',
    threshold: 10,
    severity: 'Warning',
    summary: 'Several customer connections are failing their checks.',
    rationale:
      'One failing connection is a customer’s credential; ten at once is usually ours. The ' +
      'threshold is deliberately about *our* problem, not theirs.',
  },
  {
    /**
     * The one that would otherwise go unnoticed for months.
     *
     * Reservation drift means money was set aside and neither settled nor released — the ledger
     * and the wallets disagree. It does not fail a request, so nothing surfaces it, and by the
     * time somebody reconciles a quarter it is a large number with no explanation.
     */
    key: 'reservation-drift',
    metric: 'credit_reservation_drift',
    service: 'cost-engine',
    comparison: 'above',
    threshold: 0,
    severity: 'Critical',
    summary: 'Reserved credit has not been settled or released.',
    rationale:
      'Any drift at all. This is the only rule with a zero threshold, because drift is never ' +
      'normal: every reservation is either settled or released, and one that is neither is a bug ' +
      'that quietly costs a customer money.',
  },
  {
    key: 'notifications-failing',
    metric: 'notification_failures',
    service: 'notifications',
    comparison: 'above',
    threshold: 5,
    severity: 'Warning',
    summary: 'Notifications are failing to send.',
    rationale:
      'A person not told that work is waiting for them is a silent failure — the whole point of ' +
      'a notification is that its absence is invisible.',
  },
  {
    /**
     * Prompt 40. Deliberately **Warning** rather than Critical: a rate limit refusing requests is
     * the control working, not a failure. What is worth a person's attention is the *volume* —
     * either somebody is attacking us or a customer's integration is retrying in a loop, and in
     * both cases the customer is having a bad time while every other metric looks healthy.
     */
    key: 'abuse-suspected',
    metric: 'rate_limit_refusals',
    service: 'api',
    comparison: 'above',
    threshold: 200,
    severity: 'Warning',
    summary: 'An unusual number of requests are being rate-limited.',
    rationale:
      'A person working normally never reaches the limit, so a handful of refusals is one broken ' +
      'script and two hundred is a pattern. Not Critical, because nothing is broken — the ' +
      'refusals are the protection doing its job, and paging for them would train operators to ' +
      'ignore the rule.',
  },
  {
    key: 'api-erroring',
    metric: 'request_errors',
    service: 'api',
    comparison: 'above',
    threshold: 50,
    severity: 'Critical',
    summary: 'The API is returning errors at an elevated rate.',
    rationale:
      'Counts 5xx only — a 403 is the authorization engine working. Fifty in a window is past ' +
      'any single customer’s bad afternoon.',
  },
];

export type AlertEvaluation = {
  rule: AlertRule;
  value: number;
  firing: boolean;
};

export function evaluateRule(rule: AlertRule, value: number): AlertEvaluation {
  const firing = rule.comparison === 'above' ? value > rule.threshold : value < rule.threshold;
  return { rule, value, firing };
}

// ---------------------------------------------------------------------------
// The incident workflow
// ---------------------------------------------------------------------------

/**
 * What happened, in order.
 *
 * §30 asks for a *"timeline"*, and a timeline is a list of entries somebody wrote — not a
 * reconstruction from state changes. State changes are already in the audit trail; a timeline is
 * the operator's narrative, which is the thing a postmortem is written from and the thing an
 * audit trail cannot produce.
 */
export const TIMELINE_KINDS = [
  'Detected',
  'Investigating',
  'Update',
  'Mitigated',
  'Resolved',
  'Note',
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export const TIMELINE_KIND_LABELS: Record<TimelineKind, string> = {
  Detected: 'Detected',
  Investigating: 'Investigating',
  Update: 'Update',
  Mitigated: 'Mitigated',
  Resolved: 'Resolved',
  Note: 'Note',
};

/**
 * Whether an incident is ready for a postmortem.
 *
 * §30 asks for a postmortem and corrective actions. A postmortem on an unresolved incident is a
 * guess, so it is refused — and one with no timeline is a document written from memory, which is
 * how the same incident happens twice.
 */
export type PostmortemReadiness =
  | { ready: true }
  | { ready: false; reasons: string[] };

export function postmortemReadiness(input: {
  state: string;
  timelineEntries: number;
  severity: string | null;
}): PostmortemReadiness {
  const reasons: string[] = [];

  if (input.severity === null) {
    reasons.push('This alert has not been declared an incident.');
  }
  if (input.state !== 'Resolved') {
    reasons.push(
      'The incident is not resolved yet. A postmortem written during an incident is a guess.',
    );
  }
  if (input.timelineEntries === 0) {
    reasons.push(
      'There is no timeline. A postmortem written from memory is how the same incident happens ' +
        'twice — record what happened first.',
    );
  }

  return reasons.length === 0 ? { ready: true } : { ready: false, reasons };
}

/**
 * Whether a P0 or P1 may be closed without a postmortem.
 *
 * It may not. §30 lists postmortem and corrective action as part of the incident, and the whole
 * value of a severity scale is that the serious ones get treated differently. A P2 may be closed
 * with a mitigation note alone — most are a configuration fix nobody needs to read about.
 */
export const SEVERITIES_REQUIRING_POSTMORTEM: readonly string[] = ['P0', 'P1'];

export function postmortemIsRequired(severity: string | null): boolean {
  return severity !== null && SEVERITIES_REQUIRING_POSTMORTEM.includes(severity);
}

/**
 * A corrective action from a postmortem.
 *
 * **Owned and dated, or it is a wish.** The single most common failure of an incident process is a
 * postmortem full of actions nobody owns, so both fields are mandatory and a check constraint
 * enforces it.
 */
export const CORRECTIVE_ACTION_STATES = ['Open', 'Done', 'Dropped'] as const;
export type CorrectiveActionState = (typeof CORRECTIVE_ACTION_STATES)[number];

export const CORRECTIVE_ACTION_STATE_LABELS: Record<CorrectiveActionState, string> = {
  Open: 'Open',
  Done: 'Done',
  Dropped: 'Dropped — decided against',
};

export const CORRECTIVE_ACTION_STANCE =
  'A corrective action has an owner and a due date, or it is a wish. An action may be dropped ' +
  'deliberately — with a reason — but it cannot be left ownerless, because the commonest failure ' +
  'of an incident process is a postmortem full of actions nobody agreed to do.';

// ---------------------------------------------------------------------------
// Logging and tracing
// ---------------------------------------------------------------------------

/**
 * Field names a structured log line must never carry.
 *
 * The same list shape the audit trail's `redactMetadata` uses, restated for logs because logs go
 * somewhere else — a log shipper, a file, a third party's console — and the audit trail's
 * protection does not travel with them.
 */
export const FORBIDDEN_LOG_FIELDS: readonly string[] = [
  'password',
  'passphrase',
  'secret',
  'token',
  'credential',
  'authorization',
  'cookie',
  'aadhaar',
  'privateKey',
  'apiKey',
];

/**
 * Whether a field name could carry a secret.
 *
 * **Separators are stripped from both sides**, so `apiKey`, `api_key`, `API-KEY` and `api key`
 * all match one entry. The first version compared lowercased strings and missed `API_KEY`
 * entirely — log fields are written in every casing convention a codebase has ever had, and a
 * redaction list that only catches one of them is a redaction list that leaks.
 */
export function logFieldIsForbidden(field: string): boolean {
  const normalise = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalised = normalise(field);
  return FORBIDDEN_LOG_FIELDS.some((forbidden) => normalised.includes(normalise(forbidden)));
}

/**
 * Strip forbidden fields from a log payload.
 *
 * Replaced with a marker rather than deleted, so a reader can see that something was withheld —
 * a silently absent field looks like a bug in the producer.
 */
export function redactLogFields(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(payload)) {
    out[field] = logFieldIsForbidden(field) ? '[redacted]' : value;
  }
  return out;
}

/** The stages a correlation id must reach, which a test asserts end to end. */
export const CORRELATION_CHAIN = [
  'request',
  'queue',
  'run',
  'provider',
  'settlement',
] as const;
export type CorrelationStage = (typeof CORRELATION_CHAIN)[number];

export const CORRELATION_STANCE =
  'One identifier links a click to the money it spent. It is generated at the edge, travels on ' +
  'the queue job, is stored on the run, is written onto the model-gateway call and onto the cost ' +
  'ledger entry that settles it — so "what did this request actually do" is one query rather ' +
  'than five joins and a guess.';

export const TRACING_STANCE =
  'UBoss records spans in process and propagates the correlation id through them. **No ' +
  'OpenTelemetry exporter is configured**: there is no collector endpoint, no credentials and no ' +
  'backend, so nothing is exported and nothing claims to be. The tracer is an abstraction with ' +
  'one working in-process implementation; wiring a real exporter is one class, not a refactor.';
