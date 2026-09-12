/**
 * Engine Agent Runs — Prompt 26.
 *
 * ## The locked relationship
 *
 * Agent → Assignment/Job → **Run**. A Run is one execution. Recurring work creates Runs on the
 * agent it already has; it never creates another agent. This file is about the individual
 * execution: what states it can be in, what may follow what, and the policies that decide whether
 * a run happens at all.
 *
 * ## Every state comes from the approved architecture
 *
 * The Technical Architecture lists them as a diagram:
 *
 *     Queued -> Reserved -> Running
 *                       |-> Waiting for Human Input
 *                       |-> Waiting for Approval
 *                       |-> Retrying
 *                       |-> Completed
 *                       |-> Failed
 *                       |-> Cancelled
 *                       |-> Blocked by Budget / Connection / Permission / Provider
 *
 * The four "Blocked by" variants are kept as four separate states rather than one with a reason
 * code, because they are resolved by four different people: a budget block goes to whoever owns
 * the budget, a connection block to the connection's owner, a permission block to an
 * administrator, and a provider block to nobody — it clears itself.
 *
 * ## What a Run is *not*
 *
 * It is not a queue job. The queue is transport; the row is the truth. A durable Run record
 * exists **before** execution, so a crashed worker leaves a run that can be found and resolved
 * rather than work that silently never happened.
 */

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export const RUN_STATES = [
  'Queued',
  'Reserved',
  'Running',
  'WaitingForHumanInput',
  'WaitingForApproval',
  'Retrying',
  'Completed',
  'Failed',
  'Cancelled',
  'BlockedByBudget',
  'BlockedByConnection',
  'BlockedByPermission',
  'BlockedByProvider',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_STATE_LABELS: Record<RunState, string> = {
  Queued: 'Queued',
  Reserved: 'Reserved',
  Running: 'Running',
  WaitingForHumanInput: 'Waiting for human input',
  WaitingForApproval: 'Waiting for approval',
  Retrying: 'Retrying',
  Completed: 'Completed',
  Failed: 'Failed',
  Cancelled: 'Cancelled',
  BlockedByBudget: 'Blocked by budget',
  BlockedByConnection: 'Blocked by connection',
  BlockedByPermission: 'Blocked by permission',
  BlockedByProvider: 'Blocked by provider',
};

export const RUN_STATE_TONES: Record<RunState, string> = {
  Queued: 'grey',
  Reserved: 'blue',
  Running: 'cyan',
  WaitingForHumanInput: 'warn',
  WaitingForApproval: 'purple',
  Retrying: 'warn',
  Completed: 'success',
  Failed: 'danger',
  Cancelled: 'grey',
  BlockedByBudget: 'danger',
  BlockedByConnection: 'danger',
  BlockedByPermission: 'danger',
  BlockedByProvider: 'warn',
};

/** A run in one of these is over. Nothing further happens to it. */
export const TERMINAL_RUN_STATES = ['Completed', 'Failed', 'Cancelled'] as const;

export function isRunFinished(state: RunState): boolean {
  return (TERMINAL_RUN_STATES as readonly string[]).includes(state);
}

/** The four blocked states, which differ by who has to act. */
export const BLOCKED_RUN_STATES = [
  'BlockedByBudget',
  'BlockedByConnection',
  'BlockedByPermission',
  'BlockedByProvider',
] as const;
export type BlockedRunState = (typeof BLOCKED_RUN_STATES)[number];

export function isRunBlocked(state: RunState): boolean {
  return (BLOCKED_RUN_STATES as readonly string[]).includes(state);
}

/**
 * Who resolves each block.
 *
 * The reason the four are separate states. A screen that said only "blocked" would leave every
 * one of these sitting until somebody guessed whose problem it was.
 */
export const BLOCK_OWNER: Record<BlockedRunState, string> = {
  BlockedByBudget: 'Whoever owns the budget it exhausted.',
  BlockedByConnection: 'The connection’s owner, or a company administrator.',
  BlockedByPermission: 'A company administrator: the agent lacks a permission it needs.',
  BlockedByProvider: 'Nobody. The provider is unavailable and this clears itself on retry.',
};

/**
 * Which states may follow which.
 *
 * Read it as the architecture's diagram made total. Three properties worth stating because tests
 * pin them:
 *
 *   * **`Queued` cannot go straight to `Running`.** `Reserved` is where budget is set aside, and
 *     skipping it would let a run start spending before anything checked it could.
 *   * **Every waiting and blocked state can be cancelled.** A run stuck waiting for a person who
 *     has left, or for a connection nobody will fix, must not be un-cancellable.
 *   * **A terminal state leads nowhere.** A retry of a failed run is a *new* run with its own
 *     idempotency key, not a resurrection — otherwise one run's history would describe two
 *     attempts and its provider calls could not be attributed.
 */
export const ALLOWED_RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  Queued: [
    'Reserved',
    'Cancelled',
    'BlockedByBudget',
    'BlockedByConnection',
    'BlockedByPermission',
    'BlockedByProvider',
  ],
  Reserved: [
    'Running',
    'Cancelled',
    'BlockedByBudget',
    'BlockedByConnection',
    'BlockedByPermission',
    'BlockedByProvider',
  ],
  Running: [
    'WaitingForHumanInput',
    'WaitingForApproval',
    'Retrying',
    'Completed',
    'Failed',
    'Cancelled',
    'BlockedByBudget',
    'BlockedByConnection',
    'BlockedByPermission',
    'BlockedByProvider',
  ],
  // Waiting states return to Running once the thing they waited for arrives.
  WaitingForHumanInput: ['Running', 'Cancelled', 'Failed'],
  WaitingForApproval: ['Running', 'Cancelled', 'Failed'],
  // Retrying goes back through Reserved: the previous reservation was released when the attempt
  // failed, so the next attempt has to take one again rather than assume it still holds.
  Retrying: ['Reserved', 'Failed', 'Cancelled'],
  Completed: [],
  Failed: [],
  Cancelled: [],
  // A block clears back to Queued, because whatever was reserved was released when it blocked.
  BlockedByBudget: ['Queued', 'Cancelled', 'Failed'],
  BlockedByConnection: ['Queued', 'Cancelled', 'Failed'],
  BlockedByPermission: ['Queued', 'Cancelled', 'Failed'],
  BlockedByProvider: ['Queued', 'Retrying', 'Cancelled', 'Failed'],
};

export function mayMoveRun(from: RunState, to: RunState): boolean {
  return ALLOWED_RUN_TRANSITIONS[from].includes(to);
}

/** States a run can be cancelled from. Everything that has not already finished. */
export function mayCancelRun(state: RunState): boolean {
  return mayMoveRun(state, 'Cancelled');
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** How a run came to exist. Mirrors the agent's run type, plus the system's own retries. */
export const RUN_TRIGGERS = ['Manual', 'OneTime', 'Scheduled', 'Event', 'Retry'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const RUN_TRIGGER_LABELS: Record<RunTrigger, string> = {
  Manual: 'Started by a person',
  OneTime: 'One-time',
  Scheduled: 'Scheduled',
  Event: 'Event',
  Retry: 'Retry of an earlier run',
};

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

/**
 * Whether a failure is worth trying again.
 *
 * Classification matters more than the backoff curve: retrying a permission error wastes
 * attempts and delays the exception that a person actually needs to see, while *not* retrying a
 * provider timeout turns a blip into a failed job.
 */
export const RETRYABILITY = ['Retryable', 'Terminal', 'NeedsIntervention'] as const;
export type Retryability = (typeof RETRYABILITY)[number];

/** The default ceiling. Bounded, because unbounded retries are how a queue eats itself. */
export const DEFAULT_MAX_RUN_ATTEMPTS = 3;

/**
 * Exponential backoff with a cap.
 *
 * @param attempt 1 for the first retry.
 * @returns Delay in milliseconds.
 */
export function retryDelayMs(attempt: number, baseMs = 30_000, capMs = 15 * 60_000): number {
  if (attempt < 1) return baseMs;
  const delay = baseMs * 2 ** (attempt - 1);
  return Math.min(delay, capMs);
}

/** Whether another attempt is permitted. */
export function mayRetryRun(input: {
  retryability: Retryability;
  attempt: number;
  maxAttempts: number;
}): { allowed: boolean; reason: string } {
  if (input.retryability === 'Terminal') {
    return {
      allowed: false,
      reason: 'This failure will not succeed on a retry, so retrying would only delay the report.',
    };
  }
  if (input.retryability === 'NeedsIntervention') {
    return {
      allowed: false,
      reason: 'Somebody has to act before this can succeed. It is raised as an exception instead.',
    };
  }
  if (input.attempt >= input.maxAttempts) {
    return {
      allowed: false,
      reason: `All ${input.maxAttempts} attempts are used. It goes to the dead-letter path.`,
    };
  }
  return { allowed: true, reason: 'Retryable, and attempts remain.' };
}

// ---------------------------------------------------------------------------
// Missed runs and overlap
// ---------------------------------------------------------------------------

/**
 * What to do about a scheduled run whose moment passed while nothing was running.
 *
 * "Configurable per Agent/company", per the architecture. There is no safe universal default: a
 * daily reconciliation almost certainly wants to catch up, and an hourly notification sweep
 * almost certainly does not want twelve of them at once after an outage.
 */
export const MISSED_RUN_POLICIES = ['RunOnce', 'RunAll', 'Skip'] as const;
export type MissedRunPolicy = (typeof MISSED_RUN_POLICIES)[number];

export const MISSED_RUN_POLICY_LABELS: Record<MissedRunPolicy, string> = {
  RunOnce: 'Run once to catch up',
  RunAll: 'Run every missed occurrence',
  Skip: 'Skip what was missed',
};

/** What to do when a run is due and the previous one has not finished. */
export const OVERLAP_POLICIES = ['Skip', 'Queue', 'Allow'] as const;
export type OverlapPolicy = (typeof OVERLAP_POLICIES)[number];

export const OVERLAP_POLICY_LABELS: Record<OverlapPolicy, string> = {
  Skip: 'Skip this occurrence',
  Queue: 'Queue it behind the running one',
  Allow: 'Run them concurrently',
};

/**
 * The conservative defaults.
 *
 * `Skip` on both, because the failure modes point that way. Catching up every missed occurrence
 * after an outage can flood a provider and spend a budget in minutes; running concurrently can
 * produce two agents writing the same output. Both are recoverable by configuring the agent, and
 * neither surprise is one a company would choose to discover in production.
 */
export const DEFAULT_MISSED_RUN_POLICY: MissedRunPolicy = 'Skip';
export const DEFAULT_OVERLAP_POLICY: OverlapPolicy = 'Skip';

/** Whether a due occurrence may start, given what is already in flight. */
export function overlapDecision(input: { policy: OverlapPolicy; unfinishedRuns: number }): {
  start: boolean;
  queue: boolean;
  reason: string;
} {
  if (input.unfinishedRuns === 0) {
    return { start: true, queue: false, reason: 'Nothing is in flight.' };
  }

  switch (input.policy) {
    case 'Allow':
      return { start: true, queue: false, reason: 'Concurrent runs are permitted for this agent.' };
    case 'Queue':
      return {
        start: false,
        queue: true,
        reason: `${input.unfinishedRuns} run(s) still in flight; this one waits behind them.`,
      };
    case 'Skip':
    default:
      return {
        start: false,
        queue: false,
        reason: `${input.unfinishedRuns} run(s) still in flight, and this agent skips overlaps.`,
      };
  }
}

// ---------------------------------------------------------------------------
// Working days and holidays
// ---------------------------------------------------------------------------

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Monday to Friday. Stated rather than assumed, and overridable per company. */
export const DEFAULT_WORKING_DAYS: readonly Weekday[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
];

/**
 * The company's calendar, as the scheduler needs it.
 *
 * `holidays` are `YYYY-MM-DD` strings in the company's timezone, not instants — a holiday is a
 * date in a place, and storing it as a UTC instant makes it the wrong day for half the world.
 */
export interface BusinessCalendar {
  timezone: string;
  workingDays: readonly Weekday[];
  holidays: readonly string[];
}

/** The weekday of an instant, in a named timezone. */
export function weekdayIn(at: Date, timezone: string): Weekday {
  const name = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: timezone }).format(at);
  const found = WEEKDAYS.find((day) => day === name);
  // `Intl` returns one of exactly these seven for `en-US`, so this cannot happen — but throwing
  // beats returning a wrong day silently.
  if (!found) throw new Error(`Unrecognised weekday "${name}" for timezone "${timezone}".`);
  return found;
}

/** The calendar date of an instant, in a named timezone, as `YYYY-MM-DD`. */
export function dateIn(at: Date, timezone: string): string {
  // `en-CA` formats as YYYY-MM-DD, which is the shape holidays are stored in.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Whether work may run at this instant, by the company's calendar.
 *
 * Both halves are checked in the company's timezone, which is the whole point: "Monday" and "the
 * 26th of January" mean the company's, not the server's.
 */
export function isWorkingMoment(
  at: Date,
  calendar: BusinessCalendar,
): { working: boolean; reason: string } {
  const day = weekdayIn(at, calendar.timezone);
  if (!calendar.workingDays.includes(day)) {
    return { working: false, reason: `${day} is not a working day for this company.` };
  }

  const date = dateIn(at, calendar.timezone);
  if (calendar.holidays.includes(date)) {
    return { working: false, reason: `${date} is a company holiday.` };
  }

  return { working: true, reason: `${day} ${date} is a working day.` };
}

/**
 * The next working moment at or after an instant.
 *
 * Advances a day at a time, up to a bounded horizon. Bounded on purpose: a company that has
 * marked every day a holiday, or configured no working days at all, would otherwise send this
 * into an unbounded loop inside a scheduler tick. Returning null lets the caller say so instead.
 */
export function nextWorkingMoment(
  from: Date,
  calendar: BusinessCalendar,
  horizonDays = 366,
): Date | null {
  if (calendar.workingDays.length === 0) return null;

  let candidate = from;
  for (let day = 0; day <= horizonDays; day += 1) {
    if (isWorkingMoment(candidate, calendar).working) return candidate;
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * The key that stops one occurrence becoming two runs.
 *
 * Built from the agent, the assignment and *what makes this occurrence distinct* — the scheduled
 * instant for a scheduled run, the event id for an event, a nonce for a manual start. Two
 * scheduler ticks that both notice the same due moment therefore compute the same key, and the
 * unique index refuses the second.
 *
 * A manual start deliberately gets a fresh nonce: a person pressing the button twice means they
 * want it twice, and deduplicating that would silently ignore an instruction.
 */
export function runIdempotencyKey(input: {
  engineAgentId: string;
  assignmentId: string | null;
  trigger: RunTrigger;
  /** The scheduled instant, the event id, or a nonce — whatever makes this occurrence distinct. */
  occurrence: string;
}): string {
  return [
    input.engineAgentId,
    input.assignmentId ?? 'no-assignment',
    input.trigger,
    input.occurrence,
  ].join(':');
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * One live progress update.
 *
 * Carried over WebSockets, and never the source of truth: the architecture is explicit that
 * "WebSockets carry live updates but never replace durable API state". Every field here is
 * derived from the run row, so a client that missed a message can re-read the run and lose
 * nothing but the animation.
 */
export interface RunProgressEvent {
  runId: string;
  engineAgentId: string;
  state: RunState;
  /** 0-100, or null when the work cannot report a fraction honestly. */
  percent: number | null;
  message: string;
  attempt: number;
  at: string;
  correlationId: string;
}
