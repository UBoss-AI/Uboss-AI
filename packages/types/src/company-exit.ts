/**
 * Company exit and data portability — Prompt 38.
 *
 * ## The instruction, and what it rules out
 *
 * *"Implement contract-end lifecycle **without silently erasing accountability**."*
 *
 * That sentence forbids the obvious implementation. A `DELETE FROM ... WHERE tenant_id = $1` over
 * every tenant-owned table would satisfy "delete eligible tenant content" and destroy the audit
 * trail, the financial record and every person's employment history along with it — and nothing
 * would remain to show what was deleted or on whose authority.
 *
 * So the design turns on one classification: **which tables hold the company's work, which hold
 * accountability, and which hold records that belong to a person rather than to the company.**
 * `TABLE_DISPOSITION` answers that for every tenant-scoped table in the schema, and a test asserts
 * it is exhaustive against the live database — so a table added by a later prompt fails the test
 * until somebody decides what happens to it on exit. Nothing else in this codebase reminds you.
 *
 * ## The seven steps, and where each one already lived
 *
 * The prompt numbers seven. Three of them were built at Prompt 11 and are **reused, not rebuilt**:
 * the `ReadOnly` lifecycle state is step 3, `tenant_lifecycle_transitions.effectiveAt` is the
 * scheduled date, and `applyDueTransitions` is the sweep that applies it. What this module adds is
 * the request/approval wrapper around them, the export package, the retention window, the selective
 * deletion and the deletion certificate.
 */

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

/**
 * Where a company's exit has got to.
 *
 * `Requested -> Approved -> ReadOnly -> RetentionHold -> Deleted`, with `Cancelled` reachable from
 * the first four and **not** from `Deleted`.
 *
 * `RetentionHold` is the step the prompt calls the *"retention/legal-hold window"* and it is a
 * state rather than a flag, because it is the last point at which an exit can be cancelled. A
 * window expressed as a date on the `Approved` record would make "can we still stop this?" a
 * calculation; as a state it is a question with an answer.
 */
export const EXIT_STATES = [
  'Requested',
  'Approved',
  'ReadOnly',
  'RetentionHold',
  'Deleted',
  'Cancelled',
] as const;
export type ExitState = (typeof EXIT_STATES)[number];

export const EXIT_STATE_LABELS: Record<ExitState, string> = {
  Requested: 'Requested',
  Approved: 'Approved, not yet started',
  ReadOnly: 'Read-only period',
  RetentionHold: 'Retention and legal-hold window',
  Deleted: 'Content deleted',
  Cancelled: 'Cancelled',
};

export const EXIT_STATE_DESCRIPTIONS: Record<ExitState, string> = {
  Requested: 'Somebody has asked to end the contract. Nothing has changed yet.',
  Approved:
    'The request is approved and dated. The company still works normally until the read-only ' +
    'period begins.',
  ReadOnly:
    'People can still sign in and read everything, and export it. Nothing new can be created.',
  RetentionHold:
    'Access has ended and the retention window is running. This is the **last point at which the ' +
    'exit can be cancelled** — after it, the content is gone.',
  Deleted:
    'Eligible content has been deleted. The audit trail, the financial record and each person’s ' +
    'employment history remain, under policy.',
  Cancelled: 'The exit was stopped. Nothing was deleted.',
};

export const ALLOWED_EXIT_TRANSITIONS: Record<ExitState, readonly ExitState[]> = {
  Requested: ['Approved', 'Cancelled'],
  Approved: ['ReadOnly', 'Cancelled'],
  // Straight to the retention hold, or cancelled. There is no path back to `Approved`: undoing a
  // read-only period is cancelling the exit, not rewinding it.
  ReadOnly: ['RetentionHold', 'Cancelled'],
  RetentionHold: ['Deleted', 'Cancelled'],
  // Terminal, and the only genuinely irreversible state in the product.
  Deleted: [],
  Cancelled: [],
};

export function mayMoveExit(from: ExitState, to: ExitState): boolean {
  return ALLOWED_EXIT_TRANSITIONS[from].includes(to);
}

/**
 * The point of no return.
 *
 * Everything up to and including `RetentionHold` can be cancelled; `Deleted` cannot. Stated as a
 * function rather than a comparison at each call site, because "is it too late to stop?" is asked
 * by the service, the screen and the notification, and three copies of it would drift.
 */
export function exitIsCancellable(state: ExitState): boolean {
  return state !== 'Deleted' && state !== 'Cancelled';
}

export function exitIsFinished(state: ExitState): boolean {
  return state === 'Deleted' || state === 'Cancelled';
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * How long the read-only period lasts by default, in days.
 *
 * Thirty. Long enough for a company to notice, export what they need and raise a dispute; short
 * enough that UBoss is not hosting a departed customer's data indefinitely. The approved documents
 * state no number, so this is configuration with a documented default and the request carries the
 * value that was in force when it was approved.
 */
export const DEFAULT_READ_ONLY_DAYS = 30;

/**
 * How long the retention window lasts by default, in days.
 *
 * Another thirty after read-only ends, so sixty days from the start of the exit before anything is
 * deleted. **Deliberately generous**: the cost of too long is storage, and the cost of too short
 * is a customer who changed their mind on day thirty-five and cannot be helped.
 */
export const DEFAULT_RETENTION_DAYS = 30;

export const MAX_EXIT_WINDOW_DAYS = 365;

export interface ExitSchedule {
  readOnlyFrom: Date;
  retentionFrom: Date;
  deletionEligibleFrom: Date;
}

/**
 * The three dates, computed from one approval instant and two windows.
 *
 * Computed once and **stored**, not recomputed on read. A company told "your data is deleted on
 * 14 March" must not see that date move because somebody changed a default.
 */
export function exitSchedule(input: {
  approvedAt: Date;
  readOnlyDays: number;
  retentionDays: number;
}): ExitSchedule {
  const readOnlyFrom = new Date(input.approvedAt.getTime());
  const retentionFrom = new Date(readOnlyFrom.getTime() + input.readOnlyDays * 86_400_000);
  const deletionEligibleFrom = new Date(retentionFrom.getTime() + input.retentionDays * 86_400_000);
  return { readOnlyFrom, retentionFrom, deletionEligibleFrom };
}

export function windowProblems(input: { readOnlyDays: number; retentionDays: number }): string[] {
  const problems: string[] = [];
  for (const [name, value] of [
    ['The read-only period', input.readOnlyDays],
    ['The retention window', input.retentionDays],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      problems.push(`${name} must be a whole number of days, or zero.`);
    } else if (value > MAX_EXIT_WINDOW_DAYS) {
      problems.push(`${name} cannot exceed ${MAX_EXIT_WINDOW_DAYS} days.`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// What happens to each table
// ---------------------------------------------------------------------------

/**
 * What exit does to one tenant-scoped table.
 *
 * Three dispositions, and the third is the one worth arguing about.
 */
export const DISPOSITIONS = ['Content', 'Accountability', 'PersonRecord'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const DISPOSITION_LABELS: Record<Disposition, string> = {
  Content: 'The company’s work — deleted',
  Accountability: 'Accountability record — preserved under policy',
  PersonRecord: 'Belongs to a person, not the company — preserved',
};

export const DISPOSITION_DESCRIPTIONS: Record<Disposition, string> = {
  Content:
    'What the company made while it was a customer: objectives, tasks, agents, runs, files, ' +
    'knowledge, settings, notifications. Deleted once the retention window ends.',
  Accountability:
    'What must survive so that "what happened here, and on whose authority" stays answerable: ' +
    'the audit trail, the security trail, break-glass sessions, lifecycle transitions, the ' +
    'financial record and the exit itself. Deleting these is what "silently erasing ' +
    'accountability" means, and it is the one thing the prompt forbids by name.',
  PersonRecord:
    'Records about a person that the person carries between employers — their employment dates ' +
    'and designation, and the performance history their portable profile reads. A company ' +
    'leaving UBoss does not get to erase somebody’s career.',
};

/**
 * Every tenant-scoped table in the schema, and what exit does to it.
 *
 * **Exhaustive, and asserted to be.** An e2e test reads every table with a `tenant_id` column out
 * of `information_schema` and fails if any is missing here — so a table added by a later prompt
 * cannot default into either bucket. A silent default would be the bug: into `Content` it deletes
 * something legally required, into `Accountability` it retains a departed customer's data forever.
 */
export const TABLE_DISPOSITION: Record<string, Disposition> = {
  // ---- Accountability: what happened, and on whose authority ----
  audit_events: 'Accountability',
  security_events: 'Accountability',
  break_glass_requests: 'Accountability',
  tenant_lifecycle_transitions: 'Accountability',
  company_setting_changes: 'Accountability',
  bulk_operations: 'Accountability',
  bulk_operation_rows: 'Accountability',
  offboardings: 'Accountability',
  // The exit itself. **The certificate has to survive the deletion it describes** — one that was
  // deleted along with the data would be worthless. Caught by the exhaustiveness test on its
  // first run, against this very table.
  company_exits: 'Accountability',
  // Who held what authority, and who decided. An access review after the fact needs these.
  role_assignments: 'Accountability',
  custom_roles: 'Accountability',
  policy_rules: 'Accountability',
  separation_of_duties_policies: 'Accountability',
  approval_requests: 'Accountability',
  approval_decisions: 'Accountability',
  approval_delegations: 'Accountability',
  // The financial record. A closed account still has to reconcile.
  tenant_subscriptions: 'Accountability',
  commercial_change_requests: 'Accountability',
  cost_ledger_entries: 'Accountability',
  credit_grants: 'Accountability',
  credit_requests: 'Accountability',
  budget_wallets: 'Accountability',
  // Support history with UBoss, which is a record of the relationship rather than of the work.
  support_tickets: 'Accountability',
  support_ticket_notes: 'Accountability',
  // The policy a score was earned under. `performance_events.policy_id` is NOT NULL, so this was
  // forced — but it is also correct: a score cannot be interpreted without the policy that
  // produced it, which is exactly the argument ADR-215 makes about sharing scores between
  // companies.
  performance_policies: 'Accountability',

  // ---- PersonRecord: the person's, not the company's ----
  //
  // These are what a portable profile reads (Prompt 37A). A company leaving UBoss does not get to
  // erase a person's verifiable employment history, and `badge_history.is_exit_snapshot` exists
  // precisely so the badge somebody left with survives their leaving.
  employment_records: 'PersonRecord',
  badge_history: 'PersonRecord',
  performance_events: 'PersonRecord',
  /// A preserved employment record says "Analyst in Delivery". Deleting Delivery would leave it
  /// pointing at nothing, so the department names survive with the employment they describe. The
  /// foreign key forced this, and it is the right answer anyway.
  departments: 'PersonRecord',

  // ---- Content: the company's work ----
  objectives: 'Content',
  objective_versions: 'Content',
  objective_workflow_steps: 'Content',
  objective_workflow_drafts: 'Content',
  objective_analysis_runs: 'Content',
  objective_outcome_reviews: 'Content',
  objective_pauses: 'Content',
  objective_rewards: 'Content',
  /// **Deleted, reluctantly.** A reward award's `objective_id` and `objective_reward_id` are both
  /// NOT NULL, so it cannot be detached from the objective it was earned against, and preserving
  /// every objective to keep it would defeat the whole exercise. The consequence is stated rather
  /// than hidden: a departed company's reward count no longer reaches a portable profile, though
  /// the badge and the performance score still do.
  reward_awards: 'Content',
  human_tasks: 'Content',
  human_task_notes: 'Content',
  human_task_evidence: 'Content',
  ai_work_assignments: 'Content',
  engine_agents: 'Content',
  engine_agent_versions: 'Content',
  agent_runs: 'Content',
  /// Prompt 40. A 24-hour cache of responses to the company's own mutating requests, so it holds
  /// their content and goes with it. By the time an exit completes the sweep has almost certainly
  /// emptied it already — classified anyway, because 'it is probably empty' is not a disposition.
  idempotency_records: 'Content',

  // ---- Prompt 40A (CR-03) ----
  //
  /// All `Content`, and the one worth arguing about is the photo.
  ///
  /// A photo is personal data, which might suggest `PersonRecord` — the bucket that survives an
  /// exit. But `PersonRecord` means "belongs to the person, not the company", and it exists for
  /// things a person carries between employers: their UBoss identity, their employment history.
  /// A photo uploaded by one employer is **that employer's** record of their staff, it is not part
  /// of the portable profile Prompt 37A defined, and keeping it after the contract ends would mean
  /// retaining a photograph of somebody for a company that no longer exists. It goes.
  employee_photos: 'Content',
  /// Who could operate which agent. Deleted with the agents themselves.
  engine_agent_operators: 'Content',
  /// How the company said its work is done — their own description of their own process.
  job_methods: 'Content',
  job_method_rows: 'Content',
  /// The record of a form arriving. Tempting to call accountability, but it is accountability
  /// *within* the company — nobody outside needs to know that a spreadsheet was rejected in March.
  job_method_imports: 'Content',
  /// Conversations, and everything hanging off them.
  chat_conversations: 'Content',
  chat_participants: 'Content',
  chat_messages: 'Content',
  chat_message_attachments: 'Content',
  chat_context_refs: 'Content',
  agent_run_events: 'Content',
  ai_output_feedback: 'Content',
  memory_records: 'Content',
  memory_policies: 'Content',
  executor_exceptions: 'Content',
  executor_exception_events: 'Content',
  executor_expectations: 'Content',
  skills: 'Content',
  skill_versions: 'Content',
  skill_transitions: 'Content',
  skill_candidates: 'Content',
  skill_evaluation_cases: 'Content',
  skill_evaluation_runs: 'Content',
  skill_regression_comparisons: 'Content',
  files: 'Content',
  knowledge_sources: 'Content',
  knowledge_source_files: 'Content',
  company_knowledge_policies: 'Content',
  connections: 'Content',
  connection_secrets: 'Content',
  connection_checks: 'Content',
  connection_tool_grants: 'Content',
  user_groups: 'Content',
  user_group_members: 'Content',
  tenant_memberships: 'Content',
  invitations: 'Content',
  notifications: 'Content',
  notification_preferences: 'Content',
  company_settings: 'Content',
  tenant_ai_settings: 'Content',
  tenant_ai_budget_policies: 'Content',
  tenant_auth_policies: 'Content',
  company_credit_policies: 'Content',
  company_setup_tasks: 'Content',
  budget_reservations: 'Content',
  budget_reservation_holds: 'Content',
  model_gateway_calls: 'Content',
  logical_model_routes: 'Content',
  provider_profiles: 'Content',
  provider_models: 'Content',
  pricing_versions: 'Content',
  sso_connections: 'Content',
  sso_auth_requests: 'Content',
  domain_verifications: 'Content',
  scim_clients: 'Content',
  tcsion_mappings: 'Content',
  outbox_messages: 'Content',
};

/**
 * Foreign-key columns on **preserved** rows that point at content being deleted.
 *
 * Nulled before the deletion runs. The record of what was decided and by whom survives; the
 * pointer to a row that no longer exists does not — which is the honest outcome, because a
 * dangling reference would be worse than an absent one.
 *
 * Every column here is nullable by design. A NOT NULL foreign key from a preserved table into
 * content has no detach available, and the table has to be classified `Content` instead —
 * `reward_awards` is the one case, and its comment says so.
 */
export const DETACH_BEFORE_DELETE: readonly { table: string; column: string }[] = [
  // An approval keeps its title, its decision and its decider. It loses the link to the objective
  // that is gone.
  { table: 'approval_requests', column: 'objective_id' },
  { table: 'approval_requests', column: 'objective_version_id' },
  // A ledger entry keeps the money. It loses the link to the reservation that produced it.
  { table: 'cost_ledger_entries', column: 'reservation_id' },
];

export function dispositionOf(table: string): Disposition | undefined {
  return TABLE_DISPOSITION[table];
}

export function tablesWithDisposition(disposition: Disposition): string[] {
  return Object.entries(TABLE_DISPOSITION)
    .filter(([, value]) => value === disposition)
    .map(([table]) => table)
    .sort();
}

// ---------------------------------------------------------------------------
// Cancellation and confirmation
// ---------------------------------------------------------------------------

export type CancellationDecision =
  | { mayCancel: true }
  | { mayCancel: false; reason: string };

/**
 * Whether an exit can still be stopped.
 *
 * The prompt says *"cancellation before destructive point where policy allows"*, and the
 * destructive point is `Deleted`. Everything before it is reversible, which is why the retention
 * window is generous.
 */
export function decideCancellation(state: ExitState): CancellationDecision {
  if (state === 'Deleted') {
    return {
      mayCancel: false,
      reason:
        'The content has already been deleted. That cannot be undone — it is the one genuinely ' +
        'irreversible step in UBoss, which is why the retention window exists before it.',
    };
  }
  if (state === 'Cancelled') {
    return { mayCancel: false, reason: 'This exit was already cancelled.' };
  }
  return { mayCancel: true };
}

/**
 * What somebody has to type to confirm the deletion.
 *
 * The company's own slug. A typed confirmation is the standard control for an irreversible
 * destructive action, and it is the **slug rather than a fixed word** because "type DELETE" is
 * muscle memory — a person who has done it once will do it again on the wrong company. Typing the
 * name of the company you are about to erase is a moment of attention that "DELETE" is not.
 */
export function deletionConfirmationFor(tenantSlug: string): string {
  return tenantSlug;
}

export function confirmationIsCorrect(input: { typed: string; tenantSlug: string }): boolean {
  return input.typed.trim() === input.tenantSlug;
}

export const DESTRUCTIVE_CONFIRMATION_STANCE =
  'Deleting a company’s content is the one irreversible action in UBoss. It requires the exit to ' +
  'have reached the end of its retention window, a second person’s approval on the original ' +
  'request, and the company’s own identifier typed out in full. Nothing about it is a single ' +
  'click.';

// ---------------------------------------------------------------------------
// The export package
// ---------------------------------------------------------------------------

/**
 * What the export package contains.
 *
 * §Prompt 38 asks for a *"permitted data export package"*, and "permitted" is the operative word:
 * an export is still subject to the classification ceilings Prompt 35 set. A company leaving does
 * not thereby gain the right to export material its own policy refused to export yesterday.
 */
export const EXPORT_SECTIONS = [
  'Company',
  'People',
  'Objectives',
  'Tasks',
  'Agents',
  'Knowledge',
  'Approvals',
  'Performance',
  'AuditTrail',
] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];

export const EXPORT_SECTION_LABELS: Record<ExportSection, string> = {
  Company: 'Company profile and settings',
  People: 'People, employment records and roles',
  Objectives: 'Objectives and their published versions',
  Tasks: 'Human tasks and their history',
  Agents: 'Engine Agents, versions and run history',
  Knowledge: 'Knowledge sources and file metadata',
  Approvals: 'Approval requests and decisions',
  Performance: 'Performance events and badge history',
  AuditTrail: 'The audit trail',
};

/**
 * What the package deliberately does **not** contain.
 *
 * Stated as a value because a customer reading the manifest is entitled to know what is missing
 * and why, rather than discovering it when they open the archive.
 */
export const EXPORT_EXCLUSIONS: readonly { what: string; why: string }[] = [
  {
    what: 'File contents',
    why:
      'The package carries each file’s metadata and its classification. The bytes are downloaded ' +
      'individually through the files screen, which applies the scan and export-ceiling checks ' +
      'that a bulk archive would bypass.',
  },
  {
    what: 'Connection credentials',
    why: 'A secret is held outside the database and never leaves UBoss in any export.',
  },
  {
    what: 'The security trail',
    why:
      'It contains cross-tenant identity events and coarse client hints belonging to the ' +
      'platform’s security plane, not to one company.',
  },
  {
    what: 'Anybody’s Aadhaar',
    why: 'UBoss holds a one-way match key and a masked fragment, and neither is exportable.',
  },
];

export const EXPORT_STANCE =
  'The export package is what a company needs to carry its own records elsewhere: its people, ' +
  'its objectives, its work, its decisions and its audit trail, as structured data. It is not a ' +
  'raw database dump — a dump would carry another company’s identifiers through shared platform ' +
  'tables, and secrets that never leave UBoss at all.';
