/**
 * Objective Builder — the approved **Form 2**, as data.
 *
 * ## Why the field list is code
 *
 * The client's locked instruction is that Form 2 is preserved *exactly*: no source field dropped,
 * renamed, merged or reordered, and the workflow grid kept whole. That is an easy promise to make
 * and a very easy one to break by accident — someone folds `Unit` and `Time Unit` into one input
 * because two number-and-unit pairs look redundant, someone drops `Current Problem` because it is
 * usually blank, someone renames `INPUT Received From` to `Source` because it is shorter. Each of
 * those is a one-line change in a form component and none of them would fail a test.
 *
 * So the field list lives here, as a closed array, and both the API and the screen derive from it.
 * A dropped field becomes a compile error or a failing invariant test rather than a quiet loss of
 * the client's form. `FORM2_OBJECTIVE_FIELDS` and `FORM2_WORKFLOW_COLUMNS` are the source of
 * truth; the migration, the DTOs, the grid header and the validation all read them.
 *
 * ## What is *not* Form 2
 *
 * Two things sit next to Form 2 without being part of it, and the separation is the client's:
 *
 *   * **UBoss routing controls** — Responsible Owner / Send To, Execution Team. The approved UI
 *     puts these in their own card, captioned "separate from source Form 2", because they are how
 *     UBoss routes the objective rather than fields the business form ever had. They are still
 *     objective-level fields (the prompt lists them as such), so they are in
 *     `FORM2_OBJECTIVE_FIELDS` carrying `section: 'UbossRouting'`. The section is what keeps the
 *     canonical source list identifiable inside the wider set.
 *   * **The Performance & Reward panel** — optional, attached to the objective, and explicitly
 *     *outside* the canonical field list. See `ObjectiveRewardPanel`.
 *
 * Neither may ever be moved into the source section, and nothing in the source section may be
 * moved out of it.
 */

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * The client's objective states, in their order.
 *
 * The names are shortened where the source document gives a slash pair — `Submitted/Under Review`
 * becomes `UnderReview`, `Published/Active` becomes `Active` — and `OBJECTIVE_STATUS_LABELS`
 * carries the full approved wording for display. The stored value is a single token because a
 * slash in an enum member is a recurring source of mismatched strings; the label is what a person
 * reads.
 */
export const OBJECTIVE_STATUSES = [
  'Draft',
  'UnderReview',
  'AiAnalysis',
  'WorkflowDraft',
  'ReadyForApproval',
  'Active',
  // Prompt 34. `Paused` is a *live* objective held deliberately — not a step towards closure, which
  // is why it sits beside `Active` rather than after `Completed`. The three closure states follow
  // §27.1's exact chain: "Completed -> Outcome Review -> Closed -> Archived".
  'Paused',
  'Completed',
  'OutcomeReview',
  'Closed',
  'Archived',
] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

export const OBJECTIVE_STATUS_LABELS: Record<ObjectiveStatus, string> = {
  Draft: 'Draft',
  UnderReview: 'Submitted / Under Review',
  AiAnalysis: 'AI Analysis',
  WorkflowDraft: 'Workflow Draft',
  ReadyForApproval: 'Ready for Approval',
  Active: 'Published / Active',
  Paused: 'Paused',
  Completed: 'Completed',
  OutcomeReview: 'Outcome Review',
  Closed: 'Closed',
  Archived: 'Archived',
};

/**
 * Tones for `StatusBadge`. `Active` is the only success tone: an objective that is live and being
 * worked is the good state, and a draft is neither good nor bad.
 */
export const OBJECTIVE_STATUS_TONES: Record<ObjectiveStatus, string> = {
  Draft: 'grey',
  UnderReview: 'warn',
  AiAnalysis: 'purple',
  WorkflowDraft: 'cyan',
  ReadyForApproval: 'warn',
  Active: 'success',
  // `warn`, not `grey`: a paused objective is live work that has stopped, and a company should
  // see that it is paused rather than read it as a quiet state.
  Paused: 'warn',
  Completed: 'blue',
  // The review is something somebody has to do, so it reads as outstanding.
  OutcomeReview: 'purple',
  Closed: 'blue',
  Archived: 'grey',
};

/**
 * The closed transition table.
 *
 * ## Why the whole table is here and not one prompt's slice of it
 *
 * The states above are the client's complete list, given as one set. Defining only the two edges
 * the Objective Builder itself uses would mean a second table appearing in the review-routing
 * service, and then a third in the publish path — and once there are two tables they disagree.
 * That has already happened twice in this codebase (the Skill transition table and the Skill
 * Candidate one), so the table is declared once, complete, here.
 *
 * ## What this table does and does not decide
 *
 * It decides which state *may follow* which. It says nothing about **who** may make the move —
 * that is the authorization check at the call site, and the answers differ per edge (submitting is
 * `objective:EditDraft` by the owner, confirming a review is `objective:Approve` by the
 * responsible manager, publishing is `objective:Publish`). An edge existing here is not a
 * permission; every mover is checked separately.
 *
 * `Draft -> AiAnalysis` and `UnderReview -> AiAnalysis` both exist because the approved UI offers
 * "Analyze & Generate Workflow" from the form itself, and the review flow can also send an
 * objective into analysis after confirming the execution team.
 */
export const ALLOWED_OBJECTIVE_TRANSITIONS: Record<ObjectiveStatus, readonly ObjectiveStatus[]> = {
  Draft: ['UnderReview', 'AiAnalysis', 'Archived'],
  // Send back / request changes is the return edge to Draft.
  //
  // `UnderReview -> ReadyForApproval` exists because the client's strict versioning rule states
  // the chain as `Draft -> Review -> Approved -> Published -> LIVE`, with no AI step in it. AI
  // analysis is an **optional detour** that a company may take, not the only route to approval —
  // so an objective reviewed and accepted as written must be able to go straight to the decision.
  UnderReview: ['ReadyForApproval', 'Draft', 'AiAnalysis', 'Archived'],
  AiAnalysis: ['WorkflowDraft', 'Draft', 'Archived'],
  WorkflowDraft: ['ReadyForApproval', 'Draft', 'AiAnalysis', 'Archived'],
  ReadyForApproval: ['Active', 'WorkflowDraft', 'Draft', 'Archived'],
  // A live objective is not editable in place. Any authorized edit opens a new Draft version, and
  // that is a different objective *version*, not a backwards move of this one.
  //
  // `Paused` is new at Prompt 34: §27.1's "controlled Pause/Resume" on a *live* objective. It is
  // reversible and it is not a step towards closure — which is why `Paused` does not reach
  // `Completed` directly. Finishing work that is currently stopped means resuming it first, so
  // nobody closes an objective whose remaining work was never restarted.
  Active: ['Paused', 'Completed', 'Archived'],
  Paused: ['Active', 'Archived'],
  // §27.1's chain, exactly: Completed -> Outcome Review -> Closed -> Archived. `Completed` may
  // still be archived directly, because a company that wants no review of a finished objective
  // should not be forced through one — but it cannot skip to `Closed`, because closure is what
  // the review produces.
  Completed: ['OutcomeReview', 'Archived'],
  // Back to `Completed` is the "this review was started by mistake" edge. There is deliberately
  // **no edge to `Active`**: reopening work is a new Draft version under the versioning rule, not
  // a resurrection of the live version that has already been reviewed (ADR-189).
  OutcomeReview: ['Closed', 'Completed'],
  Closed: ['Archived'],
  // Terminal. Nothing leaves the archive; a company that wants the work again starts a new draft.
  Archived: [],
};

export function mayTransitionObjective(from: ObjectiveStatus, to: ObjectiveStatus): boolean {
  return ALLOWED_OBJECTIVE_TRANSITIONS[from].includes(to);
}

/**
 * States in which the Form 2 content may no longer be edited in place.
 *
 * From `Active` onwards the version is what running work references, so editing it would change
 * the plan under people who are already executing it. The versioning rule handles the legitimate
 * case: an authorized edit after Live creates a new Draft version and leaves this one alone.
 *
 * **`Paused` is frozen too**, and that is worth stating because it is the one people assume
 * otherwise: pausing stops the work, it does not reopen the plan. An objective paused to be
 * rethought is rethought as a new Draft version, which is the same rule as every other edit after
 * Live — otherwise "pause" would be a way round the versioning rule.
 */
export const FROZEN_OBJECTIVE_STATUSES = [
  'Active',
  'Paused',
  'Completed',
  'OutcomeReview',
  'Closed',
  'Archived',
] as const;

export function isObjectiveContentFrozen(status: ObjectiveStatus): boolean {
  return (FROZEN_OBJECTIVE_STATUSES as readonly ObjectiveStatus[]).includes(status);
}

/**
 * States from which a person may still edit the draft content.
 *
 * Deliberately *not* the complement of `FROZEN_OBJECTIVE_STATUSES`: an objective sitting in
 * `UnderReview` or `ReadyForApproval` is waiting on somebody else's decision, and letting the
 * author change the content underneath a reviewer is how a reviewer ends up approving something
 * they never read. Editing those requires the send-back edge first.
 */
export const EDITABLE_OBJECTIVE_STATUSES = ['Draft', 'AiAnalysis', 'WorkflowDraft'] as const;

export function isObjectiveDraftEditable(status: ObjectiveStatus): boolean {
  return (EDITABLE_OBJECTIVE_STATUSES as readonly ObjectiveStatus[]).includes(status);
}

// ---------------------------------------------------------------------------
// Form 2 — objective-level fields
// ---------------------------------------------------------------------------

/**
 * Which card a field belongs to.
 *
 * `SourceForm2` is the canonical business form, preserved exactly. `UbossRouting` is how UBoss
 * routes the objective — the approved UI shows it in its own captioned card so nobody mistakes a
 * platform control for a source field.
 */
export const FORM2_SECTIONS = ['SourceForm2', 'UbossRouting'] as const;
export type Form2Section = (typeof FORM2_SECTIONS)[number];

export const FORM2_SECTION_LABELS: Record<Form2Section, string> = {
  SourceForm2: 'Form 2 — Objective definition (source fields)',
  UbossRouting: 'UBoss routing controls (separate from source Form 2)',
};

/** How a field is captured. Drives the control the form renders and the validation applied. */
export type Form2FieldKind = 'text' | 'longText' | 'integer' | 'date' | 'reference' | 'choice';

export interface Form2FieldDefinition {
  /** The stored property name. */
  readonly key: string;
  /** The client's exact label. Never paraphrased. */
  readonly label: string;
  readonly section: Form2Section;
  readonly kind: Form2FieldKind;
  readonly required: boolean;
  /** Character ceiling for text fields, so the DTO and the column agree. */
  readonly maxLength?: number;
}

/**
 * The objective-level fields, **in the source document's order**.
 *
 * The approved UI renders them in a slightly different visual order — it lifts `Prepared By` up
 * beside `Objective Owner` so the two person fields pair — and that is fine: the locked rule is
 * about the *form's* fields, and the reference UI is the approved presentation of them. This array
 * is the canonical list; the screen is the canonical layout. The divergence is recorded in
 * `docs/UX_MAP.md`.
 *
 * `Unit` and `Time Unit` are separate entries and must stay separate. The approved UI carries a
 * notice saying so, because collapsing a quantity's unit into a duration's unit is the specific
 * simplification the client called out.
 */
export const FORM2_OBJECTIVE_FIELDS: readonly Form2FieldDefinition[] = [
  {
    key: 'objectiveName',
    label: 'Objective Name',
    section: 'SourceForm2',
    kind: 'text',
    required: true,
    maxLength: 200,
  },
  {
    key: 'departmentId',
    label: 'Department',
    section: 'SourceForm2',
    kind: 'reference',
    required: true,
  },
  {
    key: 'objectiveOwnerUserId',
    label: 'Objective Owner',
    section: 'SourceForm2',
    kind: 'reference',
    required: true,
  },
  {
    key: 'expectedFinalResult',
    label: 'Expected Final Result',
    section: 'SourceForm2',
    kind: 'longText',
    required: true,
    maxLength: 4000,
  },
  {
    key: 'currentWorkload',
    label: 'Current Workload',
    section: 'SourceForm2',
    kind: 'integer',
    required: false,
  },
  {
    key: 'unit',
    label: 'Unit',
    section: 'SourceForm2',
    kind: 'text',
    required: false,
    maxLength: 60,
  },
  {
    key: 'targetCompletionTime',
    label: 'Target Completion Time',
    section: 'SourceForm2',
    kind: 'integer',
    required: false,
  },
  {
    key: 'timeUnit',
    label: 'Time Unit',
    section: 'SourceForm2',
    kind: 'choice',
    required: false,
  },
  {
    key: 'preparedBy',
    label: 'Prepared By',
    section: 'SourceForm2',
    kind: 'text',
    required: false,
    maxLength: 160,
  },
  { key: 'formDate', label: 'Date', section: 'SourceForm2', kind: 'date', required: false },
  {
    key: 'responsibleOwnerUserId',
    label: 'Responsible Owner / Send To',
    section: 'UbossRouting',
    kind: 'reference',
    required: false,
  },
  {
    key: 'executionTeam',
    label: 'Execution Team',
    section: 'UbossRouting',
    kind: 'text',
    required: false,
    maxLength: 200,
  },
];

/** The canonical source-form field keys, for the invariant test and for the read-only view. */
export const FORM2_SOURCE_FIELD_KEYS: readonly string[] = FORM2_OBJECTIVE_FIELDS.filter(
  (field) => field.section === 'SourceForm2',
).map((field) => field.key);

export function form2Field(key: string): Form2FieldDefinition | undefined {
  return FORM2_OBJECTIVE_FIELDS.find((field) => field.key === key);
}

/**
 * The duration units the approved UI offers, in its order.
 *
 * `WorkingDays` first because it is the default the reference selects, and because a regulatory
 * target measured in calendar days when the team meant working days is a real planning error.
 */
export const TIME_UNITS = ['WorkingDays', 'CalendarDays', 'Hours', 'Weeks'] as const;
export type TimeUnit = (typeof TIME_UNITS)[number];

export const TIME_UNIT_LABELS: Record<TimeUnit, string> = {
  WorkingDays: 'Working days',
  CalendarDays: 'Calendar days',
  Hours: 'Hours',
  Weeks: 'Weeks',
};

// ---------------------------------------------------------------------------
// Form 2 — the workflow grid
// ---------------------------------------------------------------------------

/**
 * The grouped headers of the source grid, in order.
 *
 * The empty-group columns (`Step`, `Time Taken`, `Current Problem`, `Approval`) sit under no
 * banner in the approved UI — they span both header rows. Groups exist because the source
 * spreadsheet groups them; flattening the header would lose the reading of "WHO / WHEN / WHAT /
 * INPUT / WHERE / OUTPUT" that makes a fifteen-column grid legible.
 */
export const WORKFLOW_COLUMN_GROUPS = ['WHO', 'WHEN', 'WHAT', 'INPUT', 'WHERE', 'OUTPUT'] as const;
export type WorkflowColumnGroup = (typeof WORKFLOW_COLUMN_GROUPS)[number];

export interface WorkflowColumnDefinition {
  readonly key: string;
  /** The sub-header text. */
  readonly label: string;
  /** Null for the four columns that sit under no group banner. */
  readonly group: WorkflowColumnGroup | null;
  readonly kind: 'step' | 'text' | 'longText' | 'engine' | 'approval';
  /** Minimum column width in the approved grid, in pixels. */
  readonly width: number;
  readonly maxLength?: number;
}

/**
 * The fifteen columns of the source grid, in the source order.
 *
 * Fifteen is not a coincidence and not a target — it is what the approved form has, and the
 * invariant test asserts the count so that a future edit cannot quietly become fourteen. `Step` is
 * derived (it is the row's position, not a stored value) and is why the column list and the stored
 * field list are not the same length.
 */
export const FORM2_WORKFLOW_COLUMNS: readonly WorkflowColumnDefinition[] = [
  { key: 'step', label: 'Step', group: null, kind: 'step', width: 42 },
  {
    key: 'whoPersonName',
    label: 'Person Name',
    group: 'WHO',
    kind: 'text',
    width: 150,
    maxLength: 160,
  },
  {
    key: 'whoDesignation',
    label: 'Designation',
    group: 'WHO',
    kind: 'text',
    width: 150,
    maxLength: 160,
  },
  {
    key: 'whoEngine',
    label: 'Engine / Sub-Engine / Executor',
    group: 'WHO',
    kind: 'engine',
    width: 170,
  },
  {
    key: 'whenTrigger',
    label: 'Trigger',
    group: 'WHEN',
    kind: 'text',
    width: 140,
    maxLength: 200,
  },
  {
    key: 'whenFrequency',
    label: 'Frequency',
    group: 'WHEN',
    kind: 'text',
    width: 120,
    maxLength: 120,
  },
  {
    key: 'whatExactWork',
    label: 'Exact Work',
    group: 'WHAT',
    kind: 'longText',
    width: 220,
    maxLength: 2000,
  },
  {
    key: 'inputWhatIsUsed',
    label: 'What Is Used',
    group: 'INPUT',
    kind: 'text',
    width: 150,
    maxLength: 400,
  },
  {
    key: 'inputReceivedFrom',
    label: 'Received From',
    group: 'INPUT',
    kind: 'text',
    width: 140,
    maxLength: 200,
  },
  {
    key: 'whereWorkIsDone',
    label: 'Work Is Done',
    group: 'WHERE',
    kind: 'text',
    width: 140,
    maxLength: 200,
  },
  {
    key: 'outputWhatIsProduced',
    label: 'What Is Produced',
    group: 'OUTPUT',
    kind: 'text',
    width: 170,
    maxLength: 400,
  },
  {
    key: 'outputSentTo',
    label: 'Sent To',
    group: 'OUTPUT',
    kind: 'text',
    width: 140,
    maxLength: 200,
  },
  { key: 'timeTaken', label: 'Time Taken', group: null, kind: 'text', width: 110, maxLength: 60 },
  {
    key: 'currentProblem',
    label: 'Current Problem',
    group: null,
    kind: 'longText',
    width: 170,
    maxLength: 2000,
  },
  { key: 'approval', label: 'Approval', group: null, kind: 'approval', width: 150 },
];

/** How many columns the source grid has. Asserted, not assumed. */
export const FORM2_WORKFLOW_COLUMN_COUNT = FORM2_WORKFLOW_COLUMNS.length;

/**
 * Who or what performs a step.
 *
 * `Human` and three machine kinds. The locked naming rule applies: an **Engine Agent** is the
 * reusable AI worker and an **Executor Agent** is the monitoring / validation / escalation layer,
 * so a step marked `Executor` is a checking step, never a doing-the-work step. `SubEngine` is a
 * component the source form distinguishes and we keep.
 */
export const STEP_ENGINE_KINDS = ['Human', 'Engine', 'SubEngine', 'Executor'] as const;
export type StepEngineKind = (typeof STEP_ENGINE_KINDS)[number];

export const STEP_ENGINE_LABELS: Record<StepEngineKind, string> = {
  Human: 'Human',
  Engine: 'Engine',
  SubEngine: 'Sub-Engine',
  Executor: 'Executor',
};

/**
 * What approval a step needs, in the approved UI's order.
 *
 * `FourEyes` is a second approver, distinct from `Head`: four-eyes means two people, not one more
 * senior person, and the separation-of-duties rules already in the authorization layer are what
 * enforce it when the approval actually runs.
 */
export const STEP_APPROVAL_KINDS = ['NotRequired', 'Manager', 'Head', 'FourEyes'] as const;
export type StepApprovalKind = (typeof STEP_APPROVAL_KINDS)[number];

export const STEP_APPROVAL_LABELS: Record<StepApprovalKind, string> = {
  NotRequired: 'Not required',
  Manager: 'Manager',
  Head: 'Head',
  FourEyes: 'Four-eyes',
};

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The objective-level content of one version. Keys match `FORM2_OBJECTIVE_FIELDS`. */
export interface Form2Objective {
  objectiveName: string;
  departmentId: string;
  objectiveOwnerUserId: string;
  expectedFinalResult: string;
  currentWorkload: number | null;
  unit: string | null;
  targetCompletionTime: number | null;
  timeUnit: TimeUnit | null;
  preparedBy: string | null;
  formDate: string | null;
  responsibleOwnerUserId: string | null;
  executionTeam: string | null;
}

/**
 * One row of the workflow grid.
 *
 * There is no `step` property: the row's position *is* its step number, and storing both invites
 * the two to disagree after a reorder. `position` is the stored ordinal; `Step` is rendered from
 * it.
 */
export interface Form2WorkflowStep {
  position: number;
  whoPersonName: string | null;
  whoDesignation: string | null;
  whoEngine: StepEngineKind;
  whenTrigger: string | null;
  whenFrequency: string | null;
  whatExactWork: string;
  inputWhatIsUsed: string | null;
  inputReceivedFrom: string | null;
  whereWorkIsDone: string | null;
  outputWhatIsProduced: string | null;
  outputSentTo: string | null;
  timeTaken: string | null;
  currentProblem: string | null;
  approval: StepApprovalKind;
}

// ---------------------------------------------------------------------------
// The Performance & Reward panel
// ---------------------------------------------------------------------------

/**
 * Reward kinds.
 *
 * The source names "Amount/Points" as one field, which is what tells us both a monetary and a
 * points reward exist; `Recognition` and `Other` cover the non-quantified cases so that a company
 * recording "named in the monthly review" does not have to invent a rupee value for it. The
 * eligibility and approval *workflow* for each of these is not here — it is the reward lifecycle,
 * and it deliberately does not exist yet.
 */
export const REWARD_TYPES = ['Cash', 'Points', 'Recognition', 'Other'] as const;
export type RewardType = (typeof REWARD_TYPES)[number];

export const REWARD_TYPE_LABELS: Record<RewardType, string> = {
  Cash: 'Cash / Bonus',
  Points: 'Points',
  Recognition: 'Recognition',
  Other: 'Other',
};

/**
 * The optional panel that hangs off an objective.
 *
 * ## It is outside Form 2, structurally
 *
 * Not "shown in a separate card while living in the same record" — a separate record, with its own
 * table, reachable only through its own endpoint. That is what makes "never inside the canonical
 * Form 2 field list" something a future change cannot undo by adding a column to the wrong table.
 *
 * ## Recording a reward is not awarding one
 *
 * `amountMinorUnits` is a *declared* amount and nothing pays it. The client's rule is explicit:
 * no auto-pay on completion, and eligibility and approval are decided by the reward workflow that
 * comes later. So this panel has no approved / settled state and no link to the performance
 * ledger; saving it produces no performance event and no payable. The eligibility condition and
 * the named approver are recorded here precisely so that the later workflow has something to
 * evaluate rather than having to ask again.
 */
export interface ObjectiveRewardPanel {
  /** The client's "Reward/Bonus Applicable". When false the rest is a record of a decision not to. */
  applicable: boolean;
  rewardType: RewardType | null;
  /** Integer minor units for `Cash`, whole points for `Points`. Never a float. */
  amountMinorUnits: number | null;
  eligibilityCondition: string | null;
  /** Date only — the reward deadline is a business date, not an instant. */
  completionDeadline: string | null;
  /** What proof closes it out. Text, because the evidence is a description at this stage. */
  evidence: string | null;
  approverUserId: string | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate the objective-level fields.
 *
 * Returns human-readable problems rather than throwing, so the same function can back the form's
 * inline errors and the server's refusal and the two cannot disagree about what is valid.
 */
export function validateForm2Objective(content: Partial<Form2Objective>): string[] {
  const problems: string[] = [];

  for (const field of FORM2_OBJECTIVE_FIELDS) {
    const value = (content as Record<string, unknown>)[field.key];

    if (field.required) {
      const missing = value === undefined || value === null || String(value).trim() === '';
      if (missing) {
        problems.push(`${field.label} is required.`);
        continue;
      }
    }

    if (value === undefined || value === null) continue;

    if (
      field.maxLength !== undefined &&
      typeof value === 'string' &&
      value.length > field.maxLength
    ) {
      problems.push(`${field.label} is longer than ${field.maxLength} characters.`);
    }

    if (field.kind === 'integer' && typeof value === 'number') {
      if (!Number.isInteger(value) || value < 0) {
        problems.push(`${field.label} must be a whole number of zero or more.`);
      }
    }
  }

  if (content.timeUnit !== undefined && content.timeUnit !== null) {
    if (!TIME_UNITS.includes(content.timeUnit)) {
      problems.push(`Unknown Time Unit. One of: ${TIME_UNITS.join(', ')}.`);
    }
  }

  // A target with no unit is not a target anyone can act on, and a unit with no target is a stray
  // word. The pair is optional; half of it is a mistake.
  if (
    content.targetCompletionTime !== undefined &&
    content.targetCompletionTime !== null &&
    (content.timeUnit === undefined || content.timeUnit === null)
  ) {
    problems.push('Target Completion Time needs a Time Unit.');
  }

  return problems;
}

/**
 * Validate the workflow grid.
 *
 * The row count is deliberately **not** fixed — the approved UI says so in as many words, and a
 * company whose process has nineteen steps must be able to record nineteen. What is checked is
 * that each row says what work it is, that positions are a clean sequence, and that the two
 * closed-vocabulary columns hold known values.
 */
export function validateForm2WorkflowSteps(steps: readonly Partial<Form2WorkflowStep>[]): string[] {
  const problems: string[] = [];

  if (steps.length === 0) {
    // Not an error while drafting — an objective is often named before its steps are known.
    return problems;
  }

  const positions = steps.map((step) => step.position);
  if (new Set(positions).size !== positions.length) {
    problems.push('Two workflow steps share the same position.');
  }

  const sorted = [...positions].sort((a, b) => (a ?? 0) - (b ?? 0));
  const contiguous = sorted.every((value, index) => value === index + 1);
  if (!contiguous) {
    problems.push('Workflow step positions must run 1, 2, 3 with no gaps.');
  }

  steps.forEach((step, index) => {
    const where = `Step ${step.position ?? index + 1}`;

    if (typeof step.whatExactWork !== 'string' || step.whatExactWork.trim() === '') {
      problems.push(`${where}: Exact Work is required — a step with no work is not a step.`);
    }

    if (step.whoEngine !== undefined && !STEP_ENGINE_KINDS.includes(step.whoEngine)) {
      problems.push(`${where}: unknown Engine kind. One of: ${STEP_ENGINE_KINDS.join(', ')}.`);
    }

    if (step.approval !== undefined && !STEP_APPROVAL_KINDS.includes(step.approval)) {
      problems.push(`${where}: unknown Approval. One of: ${STEP_APPROVAL_KINDS.join(', ')}.`);
    }

    // A human step with nobody named is the commonest way a workflow becomes unassignable. It is
    // permitted while drafting and refused at submit — see `validateObjectiveForSubmission`.
    for (const column of FORM2_WORKFLOW_COLUMNS) {
      if (column.maxLength === undefined) continue;
      const value = (step as Record<string, unknown>)[column.key];
      if (typeof value === 'string' && value.length > column.maxLength) {
        problems.push(`${where}: ${column.label} is longer than ${column.maxLength} characters.`);
      }
    }
  });

  return problems;
}

/**
 * The extra checks that only apply when an objective is submitted for review.
 *
 * Drafting is permissive on purpose — people save half-finished forms, and a form that refuses to
 * save is a form people keep in a spreadsheet instead. Submitting is where the objective becomes
 * somebody else's problem, so this is where it has to be coherent.
 */
export function validateObjectiveForSubmission(
  content: Partial<Form2Objective>,
  steps: readonly Partial<Form2WorkflowStep>[],
): string[] {
  const problems = [...validateForm2Objective(content), ...validateForm2WorkflowSteps(steps)];

  if (steps.length === 0) {
    problems.push('An objective needs at least one workflow step before it can be reviewed.');
  }

  if (
    content.responsibleOwnerUserId === undefined ||
    content.responsibleOwnerUserId === null ||
    content.responsibleOwnerUserId === ''
  ) {
    problems.push('Responsible Owner / Send To is required to submit for review.');
  }

  steps.forEach((step, index) => {
    if (
      step.whoEngine === 'Human' &&
      (step.whoPersonName === undefined ||
        step.whoPersonName === null ||
        step.whoPersonName.trim() === '')
    ) {
      problems.push(
        `Step ${step.position ?? index + 1}: a human step needs a Person Name before review.`,
      );
    }
  });

  return problems;
}

/**
 * Validate the reward panel.
 *
 * The shape of the rule is "if it is applicable, say what it is" — an applicable reward with no
 * type and no condition is the case that later becomes an argument about what was promised.
 */
export function validateRewardPanel(panel: Partial<ObjectiveRewardPanel>): string[] {
  const problems: string[] = [];

  if (panel.rewardType !== undefined && panel.rewardType !== null) {
    if (!REWARD_TYPES.includes(panel.rewardType)) {
      problems.push(`Unknown Reward Type. One of: ${REWARD_TYPES.join(', ')}.`);
    }
  }

  if (panel.amountMinorUnits !== undefined && panel.amountMinorUnits !== null) {
    if (!Number.isInteger(panel.amountMinorUnits) || panel.amountMinorUnits < 0) {
      problems.push('Amount / Points must be a whole number of zero or more.');
    }
  }

  if (panel.applicable !== true) {
    return problems;
  }

  if (panel.rewardType === undefined || panel.rewardType === null) {
    problems.push('An applicable reward needs a Reward Type.');
  }

  if (
    panel.eligibilityCondition === undefined ||
    panel.eligibilityCondition === null ||
    panel.eligibilityCondition.trim() === ''
  ) {
    problems.push('An applicable reward needs an Eligibility Condition.');
  }

  if (
    panel.approverUserId === undefined ||
    panel.approverUserId === null ||
    panel.approverUserId === ''
  ) {
    problems.push('An applicable reward needs a named Approver.');
  }

  // Cash and Points are quantified kinds; Recognition and Other are not, and demanding an amount
  // for them would push people into entering a fake number.
  const quantified = panel.rewardType === 'Cash' || panel.rewardType === 'Points';
  if (quantified && (panel.amountMinorUnits === undefined || panel.amountMinorUnits === null)) {
    problems.push(`A ${panel.rewardType} reward needs an Amount / Points.`);
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Prompt 20 — review routing and strict versioning
// ---------------------------------------------------------------------------

/**
 * Whether an objective's workflow steps may be handed to people as actionable work.
 *
 * **Only `Active`.** The client's rule is that employees receive no actionable work during
 * review, and this is the single function that answers it — so the To-do module, the Engine Agent
 * runner and any later assigner all ask the same question rather than each deciding for itself.
 *
 * `ReadyForApproval` is deliberately not assignable: a plan awaiting a decision is not a plan, and
 * work handed out before the decision would have to be recalled if the answer were no.
 */
export function isObjectiveWorkAssignable(status: ObjectiveStatus): boolean {
  return status === 'Active';
}

/**
 * Why a new version exists.
 *
 * `Edit` covers the client's "any later edit by any authorized user automatically creates V2
 * Draft copied from V1" — including a **minor** edit, which gets no exemption. `Rollback` is the
 * client's "rollback creates a new version based on an older version": it is a forward-moving new
 * draft, never a resurrection of the old row, so the history stays append-only.
 */
export const VERSION_ORIGINS = ['Initial', 'Edit', 'Rollback'] as const;
export type VersionOrigin = (typeof VERSION_ORIGINS)[number];

export const VERSION_ORIGIN_LABELS: Record<VersionOrigin, string> = {
  Initial: 'First version',
  Edit: 'Edited from an earlier version',
  Rollback: 'Rolled back from an earlier version',
};

// ---------------------------------------------------------------------------
// The compare view
// ---------------------------------------------------------------------------

/** One changed objective-level field. */
export interface Form2FieldChange {
  key: string;
  label: string;
  section: Form2Section;
  before: string | null;
  after: string | null;
}

export type StepChangeKind = 'Added' | 'Removed' | 'Changed';

/** One changed grid row, with the cells that differ. */
export interface WorkflowStepChange {
  position: number;
  kind: StepChangeKind;
  cells: { key: string; label: string; before: string | null; after: string | null }[];
}

export interface ObjectiveVersionDiff {
  fields: Form2FieldChange[];
  steps: WorkflowStepChange[];
  /**
   * True when the two versions are identical.
   *
   * Reachable, and that matters: the client's rule is that **minor edits also create a new
   * version**, so a version whose content happens to match its parent is a legitimate record of
   * somebody having saved it. The compare view says "nothing changed" rather than pretending the
   * version does not exist.
   */
  identical: boolean;
  summary: string;
}

/** Render a stored value for comparison. `null` and `''` are both "not set". */
function displayOf(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

/**
 * Field-by-field comparison of two Form 2 versions.
 *
 * Walks `FORM2_OBJECTIVE_FIELDS` and `FORM2_WORKFLOW_COLUMNS` rather than the objects' own keys,
 * for the same reason everything else here does: a field the arrays know about but an object is
 * missing is a real difference and must appear, and a comparison driven by `Object.keys` would
 * silently skip it.
 *
 * Steps are matched by **position**, which is what the grid means by a row. A reorder therefore
 * shows as changed rows rather than as a move — honest, because the grid has no row identity: the
 * client's `Step` column *is* the position.
 */
export function diffObjectiveVersions(
  before: { content: Partial<Form2Objective>; steps: readonly Partial<Form2WorkflowStep>[] },
  after: { content: Partial<Form2Objective>; steps: readonly Partial<Form2WorkflowStep>[] },
): ObjectiveVersionDiff {
  const fields: Form2FieldChange[] = [];

  for (const field of FORM2_OBJECTIVE_FIELDS) {
    const from = displayOf((before.content as Record<string, unknown>)[field.key]);
    const to = displayOf((after.content as Record<string, unknown>)[field.key]);
    if (from !== to) {
      fields.push({
        key: field.key,
        label: field.label,
        section: field.section,
        before: from,
        after: to,
      });
    }
  }

  const steps: WorkflowStepChange[] = [];
  const highest = Math.max(before.steps.length, after.steps.length);

  for (let index = 0; index < highest; index += 1) {
    const position = index + 1;
    const from = before.steps.find((step) => step.position === position);
    const to = after.steps.find((step) => step.position === position);

    if (from === undefined && to === undefined) continue;

    if (from === undefined) {
      steps.push({ position, kind: 'Added', cells: [] });
      continue;
    }
    if (to === undefined) {
      steps.push({ position, kind: 'Removed', cells: [] });
      continue;
    }

    const cells: WorkflowStepChange['cells'] = [];
    for (const column of FORM2_WORKFLOW_COLUMNS) {
      if (column.kind === 'step') continue;
      const cellBefore = displayOf((from as Record<string, unknown>)[column.key]);
      const cellAfter = displayOf((to as Record<string, unknown>)[column.key]);
      if (cellBefore !== cellAfter) {
        cells.push({
          key: column.key,
          label: column.label,
          before: cellBefore,
          after: cellAfter,
        });
      }
    }

    if (cells.length > 0) {
      steps.push({ position, kind: 'Changed', cells });
    }
  }

  const identical = fields.length === 0 && steps.length === 0;

  return {
    fields,
    steps,
    identical,
    summary: identical
      ? 'Nothing changed between these two versions.'
      : `${fields.length} field${fields.length === 1 ? '' : 's'} and ` +
        `${steps.length} workflow step${steps.length === 1 ? '' : 's'} differ.`,
  };
}
