/**
 * Assignment vocabulary — what a published workflow turns into.
 *
 * Prompt 23 is the transactional boundary between a plan and actual work. Once it commits, three
 * kinds of thing exist that did not before: **Human To-do tasks**, **AI work assignments** and
 * **approval requests**. This file is the shared vocabulary for all three, plus the expectations
 * the Executor Agent is told to watch for.
 *
 * ## Where these words come from
 *
 * Not invented here. The task types and statuses are the approved UI's own — its Pending Jobs
 * table shows a `Type` of Human, Approval or Agent, and statuses including "Needs input",
 * "Waiting Approval" and "Blocked". The approval types are the ones the Approval Engine prompt
 * lists. The executor expectations are named after that prompt's own exception types, so it
 * consumes these rather than inventing a parallel set.
 */

// ---------------------------------------------------------------------------
// What kind of work item this is
// ---------------------------------------------------------------------------

/** The approved UI's `Type` column on Pending Jobs. */
export const WORK_ITEM_TYPES = ['Human', 'Approval', 'Agent'] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

// ---------------------------------------------------------------------------
// Human To-do tasks
// ---------------------------------------------------------------------------

/**
 * The states a human task moves through.
 *
 * **`Waiting` is not something a person chooses.** It is the state of a step whose dependencies
 * have not finished yet: the plan says this cannot start until something else is done, so it is
 * not offered to anybody. It is separate from `Blocked` on purpose. `Blocked` is a person saying
 * "I cannot proceed, here is why", and they can lift it themselves — which is exactly right for a
 * reason they know about and wrong for a dependency, because a step that unlocks itself is not a
 * dependency at all. Only completing what it waits on moves it, and only the server does that.
 *
 * **`Overdue` is deliberately not here.** The approved UI shows it as a status, but it is derived
 * from the due time — a task can be both "waiting on somebody else" and late, and storing one
 * status would lose the real state. `humanTaskDisplayStatus` is what the screen shows;
 * `isHumanTaskOverdue` is what the Executor Agent's "Human Task Overdue" exception asks.
 */
export const HUMAN_TASK_STATUSES = [
  'Waiting',
  'Assigned',
  'InProgress',
  'Blocked',
  'NeedsInput',
  'WaitingApproval',
  'Submitted',
  'Completed',
  'Cancelled',
] as const;
export type HumanTaskStatus = (typeof HUMAN_TASK_STATUSES)[number];

export const HUMAN_TASK_STATUS_LABELS: Record<HumanTaskStatus, string> = {
  Waiting: 'Waiting',
  Assigned: 'Assigned',
  InProgress: 'In progress',
  Blocked: 'Blocked',
  NeedsInput: 'Needs input',
  WaitingApproval: 'Waiting approval',
  Submitted: 'Submitted',
  Completed: 'Completed',
  Cancelled: 'Cancelled',
};

/** Tones from the shared `StatusTone` set, so two screens cannot colour one status differently. */
export const HUMAN_TASK_STATUS_TONES: Record<HumanTaskStatus, string> = {
  Waiting: 'grey',
  Assigned: 'blue',
  InProgress: 'cyan',
  Blocked: 'danger',
  NeedsInput: 'warn',
  WaitingApproval: 'purple',
  Submitted: 'blue',
  Completed: 'success',
  Cancelled: 'grey',
};

export const TERMINAL_HUMAN_TASK_STATUSES = ['Completed', 'Cancelled'] as const;

export function isHumanTaskFinished(status: HumanTaskStatus): boolean {
  return (TERMINAL_HUMAN_TASK_STATUSES as readonly HumanTaskStatus[]).includes(status);
}

/**
 * Which moves are permitted.
 *
 * Read the shape rather than the list: work can always go back to `InProgress` from a waiting
 * state, because the thing it was waiting for can arrive. `Submitted` can return to `InProgress`
 * — a submission sent back for more work is an ordinary event, not an error. Nothing leaves a
 * terminal state; a completed task that turns out to be wrong is re-assigned, not re-opened,
 * because the evidence and timestamps on it are what a performance record reads.
 */
export const ALLOWED_HUMAN_TASK_TRANSITIONS: Record<HumanTaskStatus, readonly HumanTaskStatus[]> = {
  /*
   * Cancelled and nothing else.
   *
   * Not an omission. Every other move out of Waiting would be somebody starting work the plan
   * says is not startable, and the release to Assigned is deliberately absent here because it is
   * not a move anybody is allowed to ask for — see `mayReleaseHumanTask`.
   */
  Waiting: ['Cancelled'],
  Assigned: ['InProgress', 'Blocked', 'NeedsInput', 'Cancelled'],
  InProgress: ['Blocked', 'NeedsInput', 'WaitingApproval', 'Submitted', 'Cancelled'],
  Blocked: ['InProgress', 'NeedsInput', 'Cancelled'],
  NeedsInput: ['InProgress', 'Blocked', 'Cancelled'],
  WaitingApproval: ['InProgress', 'Submitted', 'Cancelled'],
  Submitted: ['InProgress', 'WaitingApproval', 'Completed', 'Cancelled'],
  Completed: [],
  Cancelled: [],
};

export function mayMoveHumanTask(from: HumanTaskStatus, to: HumanTaskStatus): boolean {
  return ALLOWED_HUMAN_TASK_TRANSITIONS[from].includes(to);
}

/**
 * Whether the server may release a task from `Waiting`.
 *
 * Kept out of `ALLOWED_HUMAN_TASK_TRANSITIONS` rather than added to it, because that table
 * answers "may this person ask for this?" and the answer for this move is always no. This one
 * answers a different question — "has the plan been satisfied?" — and only the code that just
 * finished a step calls it.
 */
export function mayReleaseHumanTask(status: HumanTaskStatus): boolean {
  return status === 'Waiting';
}

/**
 * Whether every step this one waits on has finished.
 *
 * `finishedNodeIds` is what the caller considers done, which differs by node kind: a human step
 * is done when its task is Completed, an AI step when its assignment has run. A dependency naming
 * a node that produced no work item at all counts as satisfied — an empty plan step is not
 * something to wait on forever, and the alternative is a task nothing can ever release.
 */
export function dependenciesSatisfied(
  dependsOnNodeIds: readonly string[],
  finishedNodeIds: ReadonlySet<string>,
  plannedNodeIds: ReadonlySet<string>,
): boolean {
  return dependsOnNodeIds.every(
    (nodeId) => !plannedNodeIds.has(nodeId) || finishedNodeIds.has(nodeId),
  );
}

/**
 * Whether a task is late.
 *
 * A task with no due time is never overdue — plenty of real work is triggered by an event rather
 * than a clock, and reporting "overdue" against a date nobody set would be noise. A finished task
 * is never overdue either, however late it was: that belongs to its completion record, not to a
 * list of things needing attention now.
 *
 * **Nor is a task that is still `Waiting`.** The product refuses to let that person start it, so
 * calling them late for not having started is blaming somebody for obeying a rule the product
 * enforced. The objective may well be running late, and that is a fact about the objective and
 * about whoever is holding the step in front — both of which are visible where the delay actually
 * is. This is the individual's record, and it stays truthful.
 */
export function isHumanTaskOverdue(
  task: { status: HumanTaskStatus; dueAt: Date | string | null },
  now: Date = new Date(),
): boolean {
  if (task.dueAt === null) return false;
  if (isHumanTaskFinished(task.status)) return false;
  if (task.status === 'Waiting') return false;
  return new Date(task.dueAt).getTime() < now.getTime();
}

/**
 * What the list shows in the Status column.
 *
 * The approved UI shows "Overdue" as a status, and it is right to: for somebody scanning their
 * work, late is the most important fact about a task. So it is shown as a status and stored as a
 * date — the display layer decides, the record stays truthful.
 */
export function humanTaskDisplayStatus(
  task: { status: HumanTaskStatus; dueAt: Date | string | null },
  now: Date = new Date(),
): { status: string; tone: string } {
  if (isHumanTaskOverdue(task, now)) {
    return { status: 'Overdue', tone: 'danger' };
  }
  return {
    status: HUMAN_TASK_STATUS_LABELS[task.status],
    tone: HUMAN_TASK_STATUS_TONES[task.status],
  };
}

/** The two things a person adds to a task besides finishing it. */
export const TASK_NOTE_KINDS = ['Comment', 'Clarification'] as const;
export type TaskNoteKind = (typeof TASK_NOTE_KINDS)[number];

/**
 * Whether a task may be submitted.
 *
 * The evidence rule is the point: the client requires evidence per node, and the Executor Agent
 * has a "Missing Completion Evidence" exception. Refusing the submission is better than accepting
 * it and raising an exception afterwards — the person is right there, and can attach the file.
 */
export function validateTaskSubmission(task: {
  status: HumanTaskStatus;
  evidenceRequirement: string;
  evidenceCount: number;
  blockedReason: string | null;
}): string[] {
  const problems: string[] = [];

  if (!mayMoveHumanTask(task.status, 'Submitted')) {
    problems.push(
      `A task that is ${HUMAN_TASK_STATUS_LABELS[task.status]} cannot be submitted. ` +
        `Permitted from here: ${ALLOWED_HUMAN_TASK_TRANSITIONS[task.status]
          .map((status) => HUMAN_TASK_STATUS_LABELS[status])
          .join(', ')}.`,
    );
  }

  if (task.evidenceRequirement.trim() !== '' && task.evidenceCount === 0) {
    problems.push(
      'This task requires evidence and none has been attached. What the step required: ' +
        `"${task.evidenceRequirement.trim()}"`,
    );
  }

  if (task.blockedReason !== null && task.blockedReason.trim() !== '') {
    problems.push(
      'This task still records a blocker. Clear it first, or the submission would contradict ' +
        `the reason given: "${task.blockedReason.trim()}"`,
    );
  }

  return problems;
}

// ---------------------------------------------------------------------------
// AI work assignments
// ---------------------------------------------------------------------------

/**
 * What happened to an AI node at publish.
 *
 * The client's instruction is "AI nodes -> assigned Agent Builder setup **OR** existing approved
 * reusable Engine Agent mapping", and the locked rule behind it matters more than either branch:
 * recurring work creates Runs, never a new Engine Agent per occurrence. So an assignment either
 * points at an Engine Agent that already exists, or records that setup is still needed. It never
 * creates an agent itself.
 */
export const AI_ASSIGNMENT_STATUSES = [
  'AwaitingAgentSetup',
  'MappedToEngineAgent',
  'Cancelled',
] as const;
export type AiAssignmentStatus = (typeof AI_ASSIGNMENT_STATUSES)[number];

export const AI_ASSIGNMENT_STATUS_LABELS: Record<AiAssignmentStatus, string> = {
  AwaitingAgentSetup: 'Awaiting Agent Builder setup',
  MappedToEngineAgent: 'Mapped to an existing Engine Agent',
  Cancelled: 'Cancelled',
};

/**
 * The prefill an Agent Builder screen reads.
 *
 * The next prompt's ZERO-QUESTION RULE is only possible if publish records what it already knew.
 * Anything absent here is a genuine question for a person, not a value to invent.
 */
export interface AgentSetupPrefill {
  /** Suggested name. A person may change it; it is a starting point, not an identity. */
  suggestedAgentName: string;
  objectiveCode: string;
  objectiveName: string;
  /** The workflow node's label — "Assigned AI Work" on the Agent Builder screen. */
  assignedWork: string;
  /** Who is accountable. Null when the plan named nobody, which is a question to ask. */
  ownerUserId: string | null;
  /** Approved, published Skill versions this work uses. */
  skillVersionIds: string[];
  /** Tool categories the step needs, from its Definition of Done. */
  toolCategories: string[];
  /** Derived by policy, per the next prompt — recorded so it is not asked again. */
  approvalRequired: boolean;
  completionEvidence: string;
}

// ---------------------------------------------------------------------------
// Approval requests — the generic queue
// ---------------------------------------------------------------------------

/**
 * Approval types, as the Approval Engine prompt lists them.
 *
 * Defined here in full, at the prompt that first needs the queue, precisely so there is never a
 * second approvals table. The client's own words: notifications and approvals "without
 * duplicating separate approval tables per module". The Approval Engine prompt adds delegation,
 * separation-of-duties wiring, aging and the queue UI **to this same table**.
 */
export const APPROVAL_REQUEST_TYPES = [
  'ObjectiveReview',
  'WorkflowPublish',
  'AgentActivation',
  'HighRiskAction',
  'OutputApproval',
  'BudgetOverride',
  'GuestAccess',
  'WorkflowStepApproval',
  'ChangeRequest',
] as const;
export type ApprovalRequestType = (typeof APPROVAL_REQUEST_TYPES)[number];

// ---------------------------------------------------------------------------
// Change requests
// ---------------------------------------------------------------------------

/**
 * The kinds of change somebody can ask for.
 *
 * The client's own list. `Other` is last and deliberately present: a closed list with no escape
 * teaches people to file everything under whichever option is nearest, and then the list describes
 * nothing. What `Other` costs is a category somebody has to read; what it buys is that the other
 * five stay meaningful.
 */
export const CHANGE_REQUEST_KINDS = [
  'Hierarchy',
  'Objective',
  'WorkReassignment',
  'AgentCorrection',
  'Access',
  'Other',
] as const;
export type ChangeRequestKind = (typeof CHANGE_REQUEST_KINDS)[number];

export const CHANGE_REQUEST_KIND_LABELS: Record<ChangeRequestKind, string> = {
  Hierarchy: 'A hierarchy change',
  Objective: 'An objective change',
  WorkReassignment: 'Work reassignment',
  AgentCorrection: 'An agent correction',
  Access: 'An access problem',
  Other: 'Something else',
};

/** How short a reason may be before it is not a reason. */
export const MIN_CHANGE_REQUEST_REASON = 10;
export const MAX_CHANGE_REQUEST_REASON = 4_000;

/**
 * Whether a change request can be filed as written.
 *
 * ## Why the reason has a floor
 *
 * A request reaches an Admin who has to decide it, and "please fix" is not something anybody can
 * decide. The floor is short on purpose — ten characters refuses an empty box and a shrug without
 * pretending to judge whether the words are any good, which is not a thing software can tell.
 *
 * Asking for a change never grants it. That is enforced where the decision is made, not here: the
 * request is an `ApprovalRequest` like every other, and it changes nothing until somebody who
 * holds the authority decides it.
 */
export function changeRequestProblems(input: { kind: string; reason: string }): string[] {
  const problems: string[] = [];

  if (!(CHANGE_REQUEST_KINDS as readonly string[]).includes(input.kind)) {
    problems.push(`"${input.kind}" is not a kind of change this asks about.`);
  }

  const reason = input.reason.trim();
  if (reason.length < MIN_CHANGE_REQUEST_REASON) {
    problems.push(
      'Say what needs changing and why. Somebody has to decide this, and they can only decide ' +
        'what you tell them.',
    );
  } else if (reason.length > MAX_CHANGE_REQUEST_REASON) {
    problems.push(`A reason is at most ${MAX_CHANGE_REQUEST_REASON} characters.`);
  }

  return problems;
}

export const APPROVAL_REQUEST_TYPE_LABELS: Record<ApprovalRequestType, string> = {
  ChangeRequest: 'Change request',
  ObjectiveReview: 'Objective review',
  WorkflowPublish: 'Workflow publish',
  AgentActivation: 'Agent activation',
  HighRiskAction: 'High-risk action',
  OutputApproval: 'Output approval',
  BudgetOverride: 'Budget override',
  GuestAccess: 'Guest access',
  WorkflowStepApproval: 'Workflow step approval',
};

export const APPROVAL_REQUEST_STATUSES = [
  'Pending',
  'Approved',
  'Rejected',
  'SentBack',
  'Cancelled',
] as const;
export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

export const APPROVAL_REQUEST_STATUS_LABELS: Record<ApprovalRequestStatus, string> = {
  Pending: 'Pending',
  Approved: 'Approved',
  Rejected: 'Rejected',
  SentBack: 'Sent back',
  Cancelled: 'Cancelled',
};

export const APPROVAL_REQUEST_STATUS_TONES: Record<ApprovalRequestStatus, string> = {
  Pending: 'warn',
  Approved: 'success',
  Rejected: 'danger',
  SentBack: 'purple',
  Cancelled: 'grey',
};

/**
 * `SentBack` returns to `Pending` because sending back asks for changes, not a refusal — the work
 * comes round again. `Rejected` is terminal: a rejection that could be quietly re-decided would
 * make the record meaningless.
 */
export const ALLOWED_APPROVAL_TRANSITIONS: Record<
  ApprovalRequestStatus,
  readonly ApprovalRequestStatus[]
> = {
  Pending: ['Approved', 'Rejected', 'SentBack', 'Cancelled'],
  SentBack: ['Pending', 'Cancelled'],
  Approved: [],
  Rejected: [],
  Cancelled: [],
};

export function mayMoveApproval(from: ApprovalRequestStatus, to: ApprovalRequestStatus): boolean {
  return ALLOWED_APPROVAL_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Executor Agent monitoring expectations
// ---------------------------------------------------------------------------

/**
 * What publish tells the Executor Agent to watch.
 *
 * Named after the Executor Agent prompt's own exception types, so that prompt reads these rather
 * than deriving its own list from the workflow a second time. Registering the expectation at
 * publish — rather than having the Executor infer it later — is what makes an unmet expectation
 * detectable at all: a task nobody recorded a due time for cannot be reported as overdue.
 *
 * Only the four a publish can genuinely know are here. The rest of that prompt's exceptions —
 * permission denied, budget limits, provider unavailability, repeated failure — are runtime
 * conditions, and inventing publish-time expectations for them would be guesswork.
 */
export const EXECUTOR_EXPECTATION_KINDS = [
  'HumanTaskOverdue',
  'MissingCompletionEvidence',
  'ApprovalPending',
  'ConnectionRequired',
] as const;
export type ExecutorExpectationKind = (typeof EXECUTOR_EXPECTATION_KINDS)[number];

export const EXECUTOR_EXPECTATION_LABELS: Record<ExecutorExpectationKind, string> = {
  HumanTaskOverdue: 'Human task overdue',
  MissingCompletionEvidence: 'Missing completion evidence',
  ApprovalPending: 'Approval pending',
  ConnectionRequired: 'Connection required',
};

// ---------------------------------------------------------------------------
// The publish gate
// ---------------------------------------------------------------------------

/** One reason Approve & Assign refused. */
export interface AssignmentRefusal {
  /** Which of the client's named checks failed. */
  check: AssignmentCheck;
  nodeId: string | null;
  reason: string;
}

/** The checks the client requires before publish, in the order they are listed. */
export const ASSIGNMENT_CHECKS = [
  'WorkflowSchemaVersion',
  'OwnersAndAssignees',
  'Permissions',
  'RequiredApprovals',
  'ConnectionReadiness',
  'BudgetEstimatePolicy',
  'NoProhibitedHighRiskPath',
] as const;
export type AssignmentCheck = (typeof ASSIGNMENT_CHECKS)[number];

export const ASSIGNMENT_CHECK_LABELS: Record<AssignmentCheck, string> = {
  WorkflowSchemaVersion: 'Workflow schema and version',
  OwnersAndAssignees: 'Owners and assignees',
  Permissions: 'Permissions',
  RequiredApprovals: 'Required approvals',
  ConnectionReadiness: 'Missing config / connection readiness',
  BudgetEstimatePolicy: 'Budget estimate policy',
  NoProhibitedHighRiskPath: 'No prohibited high-risk path',
};
