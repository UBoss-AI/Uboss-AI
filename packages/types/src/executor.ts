/**
 * The Executor Agent and the Exception Center — Prompt 27.
 *
 * ## What the Executor is, and what it must never be
 *
 * An **oversight layer**. The source document: "Executor Agent is an oversight layer. It monitors
 * Human tasks and Engine Agent runs, checks evidence and timing, applies configured validation,
 * then routes exceptions to the right person. It must not silently replace required Human
 * approvals."
 *
 * That last sentence is a locked rule, and it is enforced structurally here rather than trusted to
 * a reviewer. `resolutionsFor` never offers an approving resolution on a high-risk exception, and
 * `executorMayResolve` refuses one outright. The Executor can detect, route, escalate, retry and
 * annotate. It cannot decide, and it cannot stand in for a manager who has to.
 *
 * ## Expectations and exceptions are different things
 *
 * Prompt 23 registered `ExecutorExpectation` rows: what the Executor is *watching for* — a task
 * due at a time, an approval that should arrive, a connection a step will need. This file is about
 * what it *raised* when something went wrong. Keeping them apart matters because a company needs
 * both answers separately: "what are we monitoring?" and "what needs somebody now?"
 */

// ---------------------------------------------------------------------------
// The ten exception types
// ---------------------------------------------------------------------------

/**
 * The client's ten, in the source document's order.
 *
 * Nothing is added and nothing is merged. Two of these look similar — `ValidationFailed` and
 * `MissingEvidence` — and they are separate because the first means the work produced the wrong
 * thing and the second means it produced nothing to check, which are different conversations with
 * different people.
 */
export const EXCEPTION_KINDS = [
  'NeedsHumanInput',
  'CredentialOrConnectionExpired',
  'PermissionDenied',
  'BudgetOrTokenLimit',
  'ProviderOrToolUnavailable',
  'ValidationFailed',
  'ApprovalPending',
  'RepeatedFailure',
  'HumanTaskOverdue',
  'MissingEvidence',
  /**
   * A run has been queued far longer than it should be — Prompt 40.
   *
   * The counterpart to `HumanTaskOverdue`, and it exists because of fairness. Round-robin ordering
   * and a per-company ceiling mean a busy company queues behind others rather than ahead of them,
   * which is correct — but a run that waits *indefinitely* has stopped being fairly queued and
   * started being starved, and nothing else would surface that to the company it belongs to.
   * Prompt 39's `queue-stuck` alert tells UBoss; this tells the customer.
   *
   * Deliberately **not** raised for an ordinary deferral. An exception for normal queueing would
   * train people to ignore the exception list, which is the failure mode every alert and exception
   * in this product is designed against.
   */
  'AgentRunOverdue',
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

/**
 * The ten the approved source document lists, in the document's order.
 *
 * Held separately from `EXCEPTION_KINDS` so that a later prompt adding a kind cannot quietly
 * change what "the client's ten" means. The test asserts these are the **first ten**, in order,
 * which catches a removal or a reorder exactly as before — and forces anything new to appear in
 * `EXCEPTION_KINDS_ADDED_SINCE` with a reason beside it rather than blending in.
 */
export const SOURCE_DOCUMENT_EXCEPTION_KINDS = [
  'NeedsHumanInput',
  'CredentialOrConnectionExpired',
  'PermissionDenied',
  'BudgetOrTokenLimit',
  'ProviderOrToolUnavailable',
  'ValidationFailed',
  'ApprovalPending',
  'RepeatedFailure',
  'HumanTaskOverdue',
  'MissingEvidence',
] as const;

/**
 * Kinds added after the source document, each with the prompt that added it and why.
 *
 * A kind is not a free addition: it needs a label, a default owner, a default severity, a place in
 * the enumerating database CHECK, and a reason somebody will accept. This list is where that reason
 * lives.
 */
export const EXCEPTION_KINDS_ADDED_SINCE: readonly {
  kind: ExceptionKind;
  prompt: string;
  why: string;
}[] = [
  {
    kind: 'AgentRunOverdue',
    prompt: '40A (CR-03)',
    why:
      'Queue fairness means a company waits behind other companies, and a company at its ' +
      'concurrency ceiling waits behind itself. Both are correct and both are invisible to the ' +
      'person who asked for the work. Past half an hour the run is starved rather than queued, ' +
      'and it has to become somebody’s problem.',
  },
];

export const EXCEPTION_KIND_LABELS: Record<ExceptionKind, string> = {
  NeedsHumanInput: 'Needs human input',
  CredentialOrConnectionExpired: 'Credential / connection expired',
  PermissionDenied: 'Permission denied',
  BudgetOrTokenLimit: 'Budget / token limit',
  ProviderOrToolUnavailable: 'Provider / tool unavailable',
  ValidationFailed: 'Validation failed',
  ApprovalPending: 'Approval pending',
  RepeatedFailure: 'Repeated failure',
  HumanTaskOverdue: 'Human task overdue',
  AgentRunOverdue: 'Agent run waiting too long',
  MissingEvidence: 'Missing evidence',
};

/**
 * The default response and owner for each, transcribed from the source document.
 *
 * These are the document's words, kept as text rather than turned into a resolver, because they
 * describe a *policy intent* that a company's own roles and delegation rules then realise. The
 * screen shows this so the person looking at an exception knows whose it is by default even when
 * the routing could not name an individual.
 */
export const EXCEPTION_DEFAULT_OWNER: Record<ExceptionKind, string> = {
  NeedsHumanInput: 'Assigned employee/owner.',
  CredentialOrConnectionExpired: 'Connection owner or company admin.',
  PermissionDenied: 'Manager/admin depending on policy.',
  BudgetOrTokenLimit: 'Manager or authorized budget approver.',
  ProviderOrToolUnavailable: 'Retry/pause policy + owner/manager notification.',
  ValidationFailed: 'Owner first, then manager if unresolved.',
  ApprovalPending: 'Named approver; escalate by aging policy.',
  RepeatedFailure: 'Manager / Head based on threshold.',
  HumanTaskOverdue: 'Employee reminder then manager escalation.',
  // The agent's owner, like every other run-sourced exception: they chose the schedule, and
  // they are the person who can decide whether this work still needs doing.
  AgentRunOverdue: 'Agent owner, then their manager.',
  MissingEvidence: 'Task/Agent owner.',
};

/**
 * Which exceptions clear themselves, given time.
 *
 * Only one does: a provider outage. Everything else needs somebody to act, and marking any of them
 * as self-clearing would be how an exception quietly ages out of a queue without anyone deciding
 * anything.
 */
export const SELF_CLEARING_EXCEPTIONS: readonly ExceptionKind[] = ['ProviderOrToolUnavailable'];

export function exceptionClearsItself(kind: ExceptionKind): boolean {
  return SELF_CLEARING_EXCEPTIONS.includes(kind);
}

// ---------------------------------------------------------------------------
// Severity and state
// ---------------------------------------------------------------------------

export const EXCEPTION_SEVERITIES = ['Low', 'Medium', 'High'] as const;
export type ExceptionSeverity = (typeof EXCEPTION_SEVERITIES)[number];

export const EXCEPTION_SEVERITY_TONES: Record<ExceptionSeverity, string> = {
  Low: 'grey',
  Medium: 'warn',
  High: 'danger',
};

/**
 * The default severity of each kind.
 *
 * Reasoned rather than ranked by how alarming the name sounds. `High` is reserved for the three
 * that mean *the company is exposed right now*: a permission the agent should not have been
 * attempting, a budget it has already hit, and a failure that has repeated past its threshold. A
 * provider outage is `Medium` however dramatic it looks, because it clears itself.
 */
export const EXCEPTION_DEFAULT_SEVERITY: Record<ExceptionKind, ExceptionSeverity> = {
  NeedsHumanInput: 'Low',
  CredentialOrConnectionExpired: 'Medium',
  PermissionDenied: 'High',
  BudgetOrTokenLimit: 'High',
  ProviderOrToolUnavailable: 'Medium',
  ValidationFailed: 'Medium',
  ApprovalPending: 'Low',
  RepeatedFailure: 'High',
  HumanTaskOverdue: 'Medium',
  // `Medium`, not `High`: the work is queued, not lost, and the usual cause is a company
  // asking for more concurrent work than its ceiling allows — a capacity conversation rather
  // than an incident.
  AgentRunOverdue: 'Medium',
  MissingEvidence: 'Medium',
};

export const EXCEPTION_STATES = [
  'Open',
  'Acknowledged',
  'Escalated',
  'Resolved',
  'Dismissed',
] as const;
export type ExceptionState = (typeof EXCEPTION_STATES)[number];

export const EXCEPTION_STATE_LABELS: Record<ExceptionState, string> = {
  Open: 'Open',
  Acknowledged: 'Acknowledged',
  Escalated: 'Escalated',
  Resolved: 'Resolved',
  Dismissed: 'Dismissed',
};

export const EXCEPTION_STATE_TONES: Record<ExceptionState, string> = {
  Open: 'danger',
  Acknowledged: 'warn',
  Escalated: 'purple',
  Resolved: 'success',
  Dismissed: 'grey',
};

export const TERMINAL_EXCEPTION_STATES = ['Resolved', 'Dismissed'] as const;

export function isExceptionClosed(state: ExceptionState): boolean {
  return (TERMINAL_EXCEPTION_STATES as readonly string[]).includes(state);
}

/**
 * Which state moves are permitted.
 *
 * `Escalated` can go back to `Acknowledged`: escalation is not a one-way street, and a manager who
 * hands something back to its owner is a normal outcome rather than a reversal to be prevented.
 *
 * A closed exception leads nowhere. Re-opening one would rewrite a resolution somebody recorded;
 * the honest move is a new exception, which is also what the detector will raise if the condition
 * recurs.
 */
export const ALLOWED_EXCEPTION_TRANSITIONS: Record<ExceptionState, readonly ExceptionState[]> = {
  Open: ['Acknowledged', 'Escalated', 'Resolved', 'Dismissed'],
  Acknowledged: ['Escalated', 'Resolved', 'Dismissed'],
  Escalated: ['Acknowledged', 'Resolved', 'Dismissed'],
  Resolved: [],
  Dismissed: [],
};

export function mayMoveException(from: ExceptionState, to: ExceptionState): boolean {
  return ALLOWED_EXCEPTION_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// The validation order
// ---------------------------------------------------------------------------

/**
 * The client's validation order, as a sequence rather than a paragraph.
 *
 * "1 deterministic/schema/business checks. 2 AI evaluator where suitable. 3 Human approval for
 * configured high-risk actions."
 *
 * The order is the substance. Running the AI evaluator before the deterministic checks would spend
 * a model call deciding something a schema already refused, and — worse — would let a plausible AI
 * judgement override a definite rule. Running either *instead of* the human step on a high-risk
 * action is the thing the locked rule forbids outright.
 */
export const VALIDATION_STAGES = ['Deterministic', 'AiEvaluator', 'HumanApproval'] as const;
export type ValidationStage = (typeof VALIDATION_STAGES)[number];

export const VALIDATION_STAGE_LABELS: Record<ValidationStage, string> = {
  Deterministic: 'Deterministic, schema and business checks',
  AiEvaluator: 'AI evaluator, where suitable',
  HumanApproval: 'Human approval, for configured high-risk actions',
};

/** One stage's verdict. */
export interface ValidationStageResult {
  stage: ValidationStage;
  /** `Passed`, `Failed`, or `NotApplicable` when this stage had nothing to judge. */
  outcome: 'Passed' | 'Failed' | 'NotApplicable' | 'Deferred';
  detail: string;
  /**
   * False whenever an AI stage ran against the mock gateway. Null for stages no model touched, so
   * "no model was involved" and "a mock was" are never the same value.
   */
  producedByRealModel: boolean | null;
}

/**
 * What the whole pipeline concluded.
 *
 * `Deferred` is a first-class outcome, not a failure: a high-risk action whose human approval has
 * not happened yet is neither passed nor failed, and reporting it as either would be a lie in one
 * direction or the other.
 */
export interface ValidationOutcome {
  verdict: 'Passed' | 'Failed' | 'Deferred';
  stages: ValidationStageResult[];
  /** Set when the verdict is `Failed` or `Deferred`. */
  exceptionKind: ExceptionKind | null;
  summary: string;
}

/**
 * Run the stages in order, stopping at the first that settles the matter.
 *
 * Deliberately a pure function over stage results, so the ordering rule is testable without a
 * model, a database or a run. The callers supply what each stage concluded; this decides what the
 * pipeline as a whole concluded, and it is where the locked rule lives:
 *
 *   * A **failed deterministic check ends it.** The AI evaluator is not consulted, because a
 *     definite rule has already answered and asking a model to second-guess it is how a schema
 *     violation becomes a matter of opinion.
 *   * A **high-risk action is never passed by the first two stages.** If human approval is
 *     required and has not been given, the verdict is `Deferred` — never `Passed` — however
 *     confidently the deterministic and AI stages agreed.
 */
export function concludeValidation(input: {
  deterministic: ValidationStageResult;
  aiEvaluator?: ValidationStageResult | undefined;
  /** True when policy requires a human decision on this action. */
  humanApprovalRequired: boolean;
  /** True only when that decision has actually been recorded. */
  humanApprovalGiven: boolean;
}): ValidationOutcome {
  const stages: ValidationStageResult[] = [input.deterministic];

  if (input.deterministic.outcome === 'Failed') {
    return {
      verdict: 'Failed',
      stages,
      exceptionKind: 'ValidationFailed',
      summary:
        `A deterministic check failed: ${input.deterministic.detail} The AI evaluator was not ` +
        'consulted — a definite rule has already answered.',
    };
  }

  if (input.aiEvaluator !== undefined) {
    stages.push(input.aiEvaluator);
    if (input.aiEvaluator.outcome === 'Failed') {
      return {
        verdict: 'Failed',
        stages,
        exceptionKind: 'ValidationFailed',
        summary: `The AI evaluator rejected this: ${input.aiEvaluator.detail}`,
      };
    }
  }

  if (input.humanApprovalRequired) {
    const given = input.humanApprovalGiven;
    stages.push({
      stage: 'HumanApproval',
      outcome: given ? 'Passed' : 'Deferred',
      detail: given
        ? 'A person approved this.'
        : 'This is a configured high-risk action and no person has approved it.',
      producedByRealModel: null,
    });

    if (!given) {
      return {
        verdict: 'Deferred',
        stages,
        exceptionKind: 'ApprovalPending',
        summary:
          'This is a configured high-risk action awaiting a human decision. The Executor does ' +
          'not make it, and does not pass the work in the meantime.',
      };
    }
  }

  return {
    verdict: 'Passed',
    stages,
    exceptionKind: null,
    summary: 'Every applicable check passed.',
  };
}

// ---------------------------------------------------------------------------
// Resolutions, and what the Executor may do on its own
// ---------------------------------------------------------------------------

export const RESOLUTION_ACTIONS = [
  'Acknowledge',
  'Reassign',
  'Escalate',
  'Retry',
  'PauseAgent',
  'RequestApproval',
  'Resolve',
  'Dismiss',
] as const;
export type ResolutionAction = (typeof RESOLUTION_ACTIONS)[number];

export const RESOLUTION_ACTION_LABELS: Record<ResolutionAction, string> = {
  Acknowledge: 'Acknowledge',
  Reassign: 'Reassign to somebody else',
  Escalate: 'Escalate',
  Retry: 'Retry the work',
  PauseAgent: 'Pause the agent',
  RequestApproval: 'Request the approval it needs',
  Resolve: 'Mark resolved',
  Dismiss: 'Dismiss',
};

/**
 * Which resolutions the **Executor Agent itself** may take without a person.
 *
 * This is the locked rule as a data structure. The Executor may route, escalate, retry a
 * transient fault, pause an agent that is misbehaving, and ask for an approval. It may not
 * `Resolve` or `Dismiss` anything, ever — those are judgements that something is finished or did
 * not matter, and an oversight layer that could make them would be able to close the very
 * exceptions it exists to surface.
 */
export const EXECUTOR_PERMITTED_ACTIONS: readonly ResolutionAction[] = [
  'Acknowledge',
  'Reassign',
  'Escalate',
  'Retry',
  'PauseAgent',
  'RequestApproval',
];

/**
 * Whether the Executor may take an action by itself on a given exception.
 *
 * Two refusals, and both matter:
 *
 *   * **Never `Resolve` or `Dismiss`.** Closing an exception is deciding it is dealt with.
 *   * **Never anything on a high-risk exception except routing it.** On a `PermissionDenied` or a
 *     `BudgetOrTokenLimit`, even a retry would be the Executor pressing on with work a control
 *     has just refused — so it may only acknowledge, reassign, escalate or request an approval.
 */
export function executorMayResolve(input: { action: ResolutionAction; kind: ExceptionKind }): {
  allowed: boolean;
  reason: string;
} {
  if (!EXECUTOR_PERMITTED_ACTIONS.includes(input.action)) {
    return {
      allowed: false,
      reason:
        `The Executor Agent cannot ${RESOLUTION_ACTION_LABELS[input.action].toLowerCase()}. ` +
        'Deciding that an exception is dealt with is a person’s judgement, and an oversight layer ' +
        'that could close its own findings would not be oversight.',
    };
  }

  const highRisk: ExceptionKind[] = ['PermissionDenied', 'BudgetOrTokenLimit'];
  if (
    highRisk.includes(input.kind) &&
    (input.action === 'Retry' || input.action === 'PauseAgent')
  ) {
    return {
      allowed: false,
      reason:
        `A ${EXCEPTION_KIND_LABELS[input.kind].toLowerCase()} exception means a control refused ` +
        'this work. Acting on it — even retrying — would be the Executor pressing on past that ' +
        'refusal. It may only route the exception to whoever owns the decision.',
    };
  }

  return { allowed: true, reason: 'Permitted: this routes or retries rather than decides.' };
}

/** Which resolutions a **person** may take, given the exception's kind and state. */
export function resolutionsFor(input: {
  kind: ExceptionKind;
  state: ExceptionState;
}): ResolutionAction[] {
  if (isExceptionClosed(input.state)) return [];

  const actions: ResolutionAction[] = ['Reassign', 'Escalate', 'Resolve', 'Dismiss'];
  if (input.state === 'Open') actions.unshift('Acknowledge');

  // A retry only makes sense where trying again could plausibly work.
  if (
    input.kind === 'ProviderOrToolUnavailable' ||
    input.kind === 'ValidationFailed' ||
    input.kind === 'RepeatedFailure'
  ) {
    actions.push('Retry');
  }

  if (input.kind === 'RepeatedFailure' || input.kind === 'CredentialOrConnectionExpired') {
    actions.push('PauseAgent');
  }

  if (input.kind === 'ApprovalPending' || input.kind === 'BudgetOrTokenLimit') {
    actions.push('RequestApproval');
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/**
 * How long an exception may sit before it escalates, by severity, in hours.
 *
 * Severity-based rather than kind-based, because the question "how long can this wait?" is about
 * consequence, not category. A company can override the window through settings; these are the
 * starting points.
 */
export const DEFAULT_ESCALATION_HOURS: Record<ExceptionSeverity, number> = {
  High: 4,
  Medium: 24,
  Low: 72,
};

/**
 * Whether an exception is due to escalate.
 *
 * An acknowledged exception still escalates. Acknowledging is not fixing, and letting an
 * acknowledgement stop the clock would make "I have seen it" a way to hold something for ever —
 * which is exactly how an aging queue becomes a queue nobody reads.
 */
export function escalationDue(input: {
  state: ExceptionState;
  severity: ExceptionSeverity;
  openedAt: Date;
  now: Date;
  escalationHours?: number | undefined;
}): { due: boolean; hoursOpen: number; reason: string } {
  const hoursOpen = (input.now.getTime() - input.openedAt.getTime()) / 3_600_000;
  const window = input.escalationHours ?? DEFAULT_ESCALATION_HOURS[input.severity];

  if (isExceptionClosed(input.state)) {
    return { due: false, hoursOpen, reason: 'It is closed.' };
  }
  if (input.state === 'Escalated') {
    return { due: false, hoursOpen, reason: 'It has already escalated.' };
  }
  if (hoursOpen < window) {
    return {
      due: false,
      hoursOpen,
      reason: `Open ${hoursOpen.toFixed(1)}h of its ${window}h window.`,
    };
  }

  return {
    due: true,
    hoursOpen,
    reason: `Open ${hoursOpen.toFixed(1)}h, past the ${window}h window for ${input.severity} severity.`,
  };
}
