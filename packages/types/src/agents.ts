/**
 * Agent Builder and Engine Agent identity — Prompt 24.
 *
 * ## Where every value in this file comes from
 *
 * The vocabularies are transcribed from the approved source document, not chosen here:
 *
 *   * **Run Type** — "Run Once, Manual, Scheduled, Event-Based".
 *   * **Missing/Wrong Data** — "Stop, skip, ask user, retry, alert, or route for approval
 *     according to policy".
 *   * **Engine Agent status** — "Draft Setup, Ready, Active, Paused, Needs Input, Error,
 *     Archived".
 *   * **Form 3** — the eight job-level field groups and seventeen detailed action columns, in
 *     the document's own order and wording.
 *
 * Nothing is added to these sets for implementation convenience. A value the client did not name
 * would be a product decision made in a type file.
 *
 * ## The locked lifecycle rule
 *
 * A reusable **Engine Agent** is created once and reused. Recurring work produces **Runs**; it
 * never produces a second Engine Agent for the same job. The client's words: "Recurring work does
 * not create a new Agent every day. Product relationship: reusable Agent → Jobs/Assignments →
 * individual Runs." This file names the agent and its configuration; the run engine is a later
 * prompt, and it hangs off this identity rather than beside it.
 *
 * ## What Agent Builder is for
 *
 * It is **not** a form. Prompt 23 already wrote an `AgentSetupPrefill` for every AI node it
 * assigned, derived from the objective, the workflow and policy. Agent Builder's job is to show
 * what is already known and ask only for what genuinely is not — the ZERO-QUESTION RULE. If the
 * objective, the workflow, policy and the company's approved connections already answer
 * everything, the screen shows *Ready to Test / Activate* and asks nothing at all.
 *
 * `missingSetupFields` is that rule as a function, so the screen and the server cannot disagree
 * about whether a question needs asking.
 */

import type { StepApprovalKind } from './objectives.js';

// ---------------------------------------------------------------------------
// Run type and scheduling
// ---------------------------------------------------------------------------

/** "Run Once, Manual, Scheduled, Event-Based" — the client's four, in the client's order. */
export const AGENT_RUN_TYPES = ['RunOnce', 'Manual', 'Scheduled', 'EventBased'] as const;
export type AgentRunType = (typeof AGENT_RUN_TYPES)[number];

export const AGENT_RUN_TYPE_LABELS: Record<AgentRunType, string> = {
  RunOnce: 'Run once',
  Manual: 'Manual',
  Scheduled: 'Scheduled',
  EventBased: 'Event-based',
};

/**
 * Which run types need a trigger or frequency stated, and which do not.
 *
 * A manual agent is started by a person, so asking it "when?" is one of the unnecessary questions
 * the zero-question rule exists to prevent. A scheduled one is meaningless without an answer, and
 * an event-based one is worse than meaningless — it would sit waiting for an event nobody named.
 */
export function runTypeNeedsSchedule(runType: AgentRunType): boolean {
  return runType === 'Scheduled' || runType === 'EventBased';
}

// ---------------------------------------------------------------------------
// Exception behaviour
// ---------------------------------------------------------------------------

/**
 * "Stop, skip, ask user, retry, alert, or route for approval according to policy."
 *
 * This is what the agent does when its input is missing or wrong. It is asked because it cannot
 * be guessed: the same missing field is a stop in a regulatory job and a skip in a reporting one,
 * and choosing a default here would be choosing on the company's behalf.
 */
export const MISSING_DATA_BEHAVIOURS = [
  'Stop',
  'Skip',
  'AskUser',
  'Retry',
  'Alert',
  'RouteForApproval',
] as const;
export type MissingDataBehaviour = (typeof MISSING_DATA_BEHAVIOURS)[number];

export const MISSING_DATA_BEHAVIOUR_LABELS: Record<MissingDataBehaviour, string> = {
  Stop: 'Stop and raise an exception',
  Skip: 'Skip the item and log it',
  AskUser: 'Ask the assigned person',
  Retry: 'Retry, then escalate',
  Alert: 'Continue and alert the owner',
  RouteForApproval: 'Route for approval',
};

/**
 * Behaviours that let the agent carry on past bad input.
 *
 * Kept as a named set because it is a governance question rather than a cosmetic one: an agent
 * that continues past data it knows is wrong is the case a reviewer must see, and the Executor
 * Agent's monitoring expectations are set from it.
 */
export const BEHAVIOURS_THAT_CONTINUE: readonly MissingDataBehaviour[] = ['Skip', 'Alert'];

export function behaviourContinuesPastBadData(behaviour: MissingDataBehaviour): boolean {
  return BEHAVIOURS_THAT_CONTINUE.includes(behaviour);
}

// ---------------------------------------------------------------------------
// Engine Agent status
// ---------------------------------------------------------------------------

/** "Draft Setup, Ready, Active, Paused, Needs Input, Error, Archived." */
export const ENGINE_AGENT_STATUSES = [
  'DraftSetup',
  'Ready',
  'Active',
  'Paused',
  'NeedsInput',
  'Error',
  'Archived',
] as const;
export type EngineAgentStatus = (typeof ENGINE_AGENT_STATUSES)[number];

export const ENGINE_AGENT_STATUS_LABELS: Record<EngineAgentStatus, string> = {
  DraftSetup: 'Draft setup',
  Ready: 'Ready',
  Active: 'Active',
  Paused: 'Paused',
  NeedsInput: 'Needs input',
  Error: 'Error',
  Archived: 'Archived',
};

export const ENGINE_AGENT_STATUS_TONES: Record<EngineAgentStatus, string> = {
  DraftSetup: 'grey',
  Ready: 'blue',
  Active: 'success',
  Paused: 'warn',
  NeedsInput: 'warn',
  Error: 'danger',
  Archived: 'grey',
};

/**
 * Which status moves are permitted.
 *
 * Prompt 24 only needs `DraftSetup → Ready → Active`; the rest of the table is stated here because
 * the statuses are stated here, and a half-declared lifecycle invites a second, disagreeing copy
 * in whichever module first needs `Paused`. The registry prompt adds the screens that drive these
 * moves — it does not get to redefine them.
 */
export const ALLOWED_ENGINE_AGENT_TRANSITIONS: Record<
  EngineAgentStatus,
  readonly EngineAgentStatus[]
> = {
  DraftSetup: ['Ready', 'Archived'],
  Ready: ['Active', 'DraftSetup', 'Archived'],
  Active: ['Paused', 'NeedsInput', 'Error', 'Archived'],
  Paused: ['Active', 'Archived'],
  NeedsInput: ['Active', 'Paused', 'Error', 'Archived'],
  Error: ['NeedsInput', 'Paused', 'Active', 'Archived'],
  // Terminal. Reviving an archived agent would resurrect an identity the company retired, with
  // its history attached; a new agent is the honest answer.
  Archived: [],
};

export function mayMoveEngineAgent(from: EngineAgentStatus, to: EngineAgentStatus): boolean {
  return ALLOWED_ENGINE_AGENT_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// The Agent Builder setup
// ---------------------------------------------------------------------------

/**
 * The execution setup an agent needs before it can run.
 *
 * Every field is nullable, and that is the point: null means "not yet known", which is exactly
 * what `missingSetupFields` reports and the screen asks about. A field with a plausible default
 * baked in would be a question silently answered on the company's behalf — and the ones here are
 * not safe to answer that way. Where the output goes and what happens to bad data are decisions
 * with consequences outside UBoss.
 */
export interface AgentExecutionSetup {
  runType: AgentRunType | null;
  /** Free text, because a schedule expression and "when a tender is published" are both valid. */
  triggerOrFrequency: string | null;
  /** A company or user connection id. Never a credential — see the note on this module. */
  inputConnectionId: string | null;
  /** The approved system, tool or workspace the work happens in. */
  whereWorkHappens: string | null;
  /** Where the result must be delivered. */
  outputDestination: string | null;
  missingDataBehaviour: MissingDataBehaviour | null;
}

/** An empty setup, for a newly opened builder. Written out so no caller has to remember the keys. */
export function emptyAgentExecutionSetup(): AgentExecutionSetup {
  return {
    runType: null,
    triggerOrFrequency: null,
    inputConnectionId: null,
    whereWorkHappens: null,
    outputDestination: null,
    missingDataBehaviour: null,
  };
}

/** One question the builder still has to ask, and why it cannot be answered from what is known. */
export interface MissingSetupField {
  field: keyof AgentExecutionSetup;
  label: string;
  /** What the screen says under the control. */
  why: string;
}

const SETUP_FIELD_LABELS: Record<keyof AgentExecutionSetup, string> = {
  runType: 'Run Type',
  triggerOrFrequency: 'Trigger / Frequency',
  inputConnectionId: 'Input Source / Connection',
  whereWorkHappens: 'Where Work Happens',
  outputDestination: 'Output Destination',
  missingDataBehaviour: 'Missing / Wrong Data',
};

/**
 * The ZERO-QUESTION RULE, as a function.
 *
 * Returns the questions that genuinely still need answering. An empty result means the screen
 * shows *Ready to Test / Activate* and asks nothing — which is the client's requirement stated
 * exactly: "if Objective + workflow + policy + approved connections already provide all required
 * setup, show Ready to Test / Activate and ask nothing extra".
 *
 * Two judgements are encoded here, both narrow:
 *
 *   * **A trigger is only demanded when the run type needs one.** Asking a manual agent when it
 *     runs is precisely the unnecessary question the rule forbids.
 *   * **A connection is only demanded when the work needs a tool.** A step whose Definition of
 *     Done lists no tool categories reads and writes nothing outside UBoss, so there is nothing
 *     to connect and nothing to ask.
 *
 * @param needsConnection Whether the assigned work uses any tool category at all. Taken from the
 *   node's Definition of Done rather than assumed, so a self-contained step asks nothing.
 */
export function missingSetupFields(
  setup: AgentExecutionSetup,
  needsConnection: boolean,
): MissingSetupField[] {
  const missing: MissingSetupField[] = [];

  const ask = (field: keyof AgentExecutionSetup, why: string) => {
    missing.push({ field, label: SETUP_FIELD_LABELS[field], why });
  };

  const blank = (value: string | null) => value === null || value.trim() === '';

  if (setup.runType === null) {
    ask(
      'runType',
      'The objective did not say whether this runs once, on demand, on a schedule or on an event.',
    );
  } else if (runTypeNeedsSchedule(setup.runType) && blank(setup.triggerOrFrequency)) {
    ask(
      'triggerOrFrequency',
      `A ${AGENT_RUN_TYPE_LABELS[setup.runType].toLowerCase()} agent needs to know when it runs.`,
    );
  }

  if (needsConnection && setup.inputConnectionId === null) {
    ask(
      'inputConnectionId',
      'This work reads or writes outside UBoss, and no approved connection has been chosen for it.',
    );
  }

  if (blank(setup.whereWorkHappens)) {
    ask(
      'whereWorkHappens',
      'The approved system or workspace the work happens in is not recorded.',
    );
  }

  if (blank(setup.outputDestination)) {
    ask(
      'outputDestination',
      'Where the result must be delivered is not recorded, and a result nobody receives is not a result.',
    );
  }

  if (setup.missingDataBehaviour === null) {
    ask(
      'missingDataBehaviour',
      'What to do about missing or wrong input has consequences the company owns, so it is never assumed.',
    );
  }

  return missing;
}

/** True when nothing is left to ask — the state that shows *Ready to Test / Activate*. */
export function setupIsComplete(setup: AgentExecutionSetup, needsConnection: boolean): boolean {
  return missingSetupFields(setup, needsConnection).length === 0;
}

// ---------------------------------------------------------------------------
// Form 3 — the canonical job method
// ---------------------------------------------------------------------------

/**
 * Form 3, exactly as the approved source document defines it.
 *
 * The document is explicit about what this is: "the complete job-definition **view** for
 * authorized users. It is not a blank form every employee must re-enter." So it composes data
 * that already exists — Form 2, the workflow node, the Skill, the agent's setup — rather than
 * introducing another form to fill in. The simplified Agent Builder stays the normal employee
 * experience, and this is the advanced authorized read of the same facts.
 *
 * The field list is transcribed, including the asterisks marking the document's required fields
 * and its inconsistent spacing in one column heading, so a later reader can diff it against the
 * source without having to guess what was tidied.
 */
export const FORM3_JOB_LEVEL_FIELDS = [
  { key: 'objectiveNameDepartment', label: 'Objective Name / Department', required: false },
  { key: 'jobIdName', label: 'Job ID / Name', required: true },
  { key: 'jobOwnerCurrentPersonRole', label: 'Job Owner / Current Person / Role', required: true },
  { key: 'triggerFrequency', label: 'Trigger / Frequency', required: true },
  { key: 'highLevelWork', label: 'High-Level Work', required: true },
  { key: 'jobStartRequirement', label: 'Job Start Requirement', required: false },
  { key: 'jobCompletionEvidence', label: 'Job Completion Evidence', required: false },
  { key: 'normalCompletionTime', label: 'Normal Completion Time / Time Unit', required: false },
] as const;

export type Form3JobLevelFieldKey = (typeof FORM3_JOB_LEVEL_FIELDS)[number]['key'];

/** The document's seventeen detailed action columns, in its order and wording. */
export const FORM3_ACTION_COLUMNS = [
  'Step',
  'WHO — Person Name',
  'WHO — Role',
  'Who — Engine / Sub Engine / Executor',
  'WHEN — Trigger',
  'WHEN — Frequency',
  'WHAT — Exact Work',
  'INPUT — Exact Input',
  'WHERE — Input Is Found',
  'HOW — Exact Method',
  'WHERE — Work Is Performed',
  'Rule / Formula / Check',
  'Output',
  'Output Destination',
  'Approval',
  'If Missing / Wrong',
  'Time',
] as const;

export type Form3ActionColumn = (typeof FORM3_ACTION_COLUMNS)[number];

/** One row of the Form 3 action grid, composed from work that already exists. */
export interface Form3ActionRow {
  step: number;
  whoPersonName: string | null;
  whoRole: string | null;
  /** "Engine", "Sub Engine", "Executor" or a person — the document keeps these in one column. */
  whoEngine: string;
  whenTrigger: string | null;
  whenFrequency: string | null;
  whatExactWork: string;
  inputExactInput: string | null;
  whereInputIsFound: string | null;
  howExactMethod: string | null;
  whereWorkIsPerformed: string | null;
  ruleFormulaCheck: string | null;
  output: string | null;
  outputDestination: string | null;
  approval: StepApprovalKind | null;
  ifMissingOrWrong: string | null;
  time: string | null;
}

/**
 * The complete Form 3 view.
 *
 * `composedFrom` is not decoration. This view is assembled from four records, and an authorized
 * reader looking at a canonical job method needs to know which parts are the manager's Form 2,
 * which are the workflow the manager edited, and which are the employee's execution setup —
 * otherwise it reads as a single authored document that nobody actually wrote.
 */
export interface Form3View {
  jobLevel: Record<Form3JobLevelFieldKey, string | null>;
  actions: Form3ActionRow[];
  composedFrom: {
    objectiveVersionId: string;
    workflowDraftId: string;
    aiWorkAssignmentId: string | null;
    engineAgentId: string | null;
  };
  note: string;
}

// ---------------------------------------------------------------------------
// Memory mode — Prompt 25 declares it, Prompt 33 enforces it
// ---------------------------------------------------------------------------

/**
 * The four governed memory modes, transcribed from the approved Technical Architecture.
 *
 * Prompt 25 records which mode an agent declares. Prompt 33 is what enforces retention,
 * visibility, deletion, cross-user and cross-objective sharing limits, sensitive-data
 * restrictions and offboarding behaviour — so until then the only honest default is the mode that
 * persists nothing.
 *
 * One rule spans all four and is not negotiable: never unrestricted cross-tenant or cross-user
 * memory.
 */
export const AGENT_MEMORY_MODES = [
  'CurrentRunOnly',
  'ObjectiveMemory',
  'AgentMemory',
  'ApprovedLongTermMemory',
] as const;
export type AgentMemoryMode = (typeof AGENT_MEMORY_MODES)[number];

export const AGENT_MEMORY_MODE_LABELS: Record<AgentMemoryMode, string> = {
  CurrentRunOnly: 'Current run only',
  ObjectiveMemory: 'Objective memory',
  AgentMemory: 'Agent memory',
  ApprovedLongTermMemory: 'Approved long-term memory',
};

/** The document's technical rule for each mode, shown wherever a mode is chosen. */
export const AGENT_MEMORY_MODE_RULES: Record<AgentMemoryMode, string> = {
  CurrentRunOnly: 'Ephemeral context, deleted or expired after the run retention window.',
  ObjectiveMemory: 'Visible only to the same Objective scope and authorized Agent versions.',
  AgentMemory: 'Reusable by the same Engine Agent under tenant, user and data policy.',
  ApprovedLongTermMemory:
    'Explicit governance, retention, classification, visibility and deletion controls.',
};

/**
 * The safest mode, and the default for a newly activated agent.
 *
 * Chosen rather than left unset because an agent with no declared memory mode would have no rule
 * to enforce once Prompt 33 arrives. `CurrentRunOnly` persists nothing, so defaulting to it
 * cannot leak anything a company has not asked for — the other three all imply retention the
 * governance controls do not exist for yet.
 */
export const DEFAULT_AGENT_MEMORY_MODE: AgentMemoryMode = 'CurrentRunOnly';

/** Modes that keep anything after the run ends, and therefore need retention governance. */
export function memoryModePersistsBeyondRun(mode: AgentMemoryMode): boolean {
  return mode !== 'CurrentRunOnly';
}

// ---------------------------------------------------------------------------
// The registry's action set
// ---------------------------------------------------------------------------

/** The client's action set for the Engine Agent registry, in the document's order. */
export const ENGINE_AGENT_ACTIONS = [
  'View',
  'RunNow',
  'Pause',
  'Resume',
  'OpenRuns',
  'CreateNewVersion',
  'Archive',
] as const;
export type EngineAgentAction = (typeof ENGINE_AGENT_ACTIONS)[number];

export const ENGINE_AGENT_ACTION_LABELS: Record<EngineAgentAction, string> = {
  View: 'View',
  RunNow: 'Run now',
  Pause: 'Pause',
  Resume: 'Resume',
  OpenRuns: 'Open runs',
  CreateNewVersion: 'Create new version',
  Archive: 'Archive',
};

/**
 * Which actions a status permits.
 *
 * Derived from the status lifecycle rather than stated twice: `Pause` is offered exactly where
 * `Active → Paused` is a legal move, and so on. Keeping them in step means a screen cannot offer
 * a button the service will refuse.
 *
 * `View` and `OpenRuns` are always available — including on an archived agent, because its
 * history is the reason it is archived rather than deleted.
 */
export function engineAgentActionsFor(status: EngineAgentStatus): EngineAgentAction[] {
  const actions: EngineAgentAction[] = ['View', 'OpenRuns'];

  // Running is doing the work, so it needs an agent that is actually in service. A paused agent
  // deliberately does not run on demand: pausing that could still be triggered by hand would not
  // be a pause.
  if (status === 'Active') actions.push('RunNow');

  if (mayMoveEngineAgent(status, 'Paused')) actions.push('Pause');
  if (status !== 'Active' && mayMoveEngineAgent(status, 'Active')) actions.push('Resume');

  // A new version can be drafted from any live agent. Not from an archived one: the company
  // retired that identity, and reviving it through a version edit would be a back door around
  // the terminal status.
  if (status !== 'Archived') actions.push('CreateNewVersion');

  if (mayMoveEngineAgent(status, 'Archived')) actions.push('Archive');

  return actions;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * The registry's health summary.
 *
 * Every count is nullable-free but the whole summary is honest about having no data: an agent that
 * has never run reports zeroes and `hasRunData: false`, so a screen can say "no runs yet" instead
 * of rendering a 0% success rate that reads as failure.
 */
export interface EngineAgentHealth {
  hasRunData: boolean;
  totalRuns: number;
  succeeded: number;
  failed: number;
  openExceptions: number;
  /** Null until a run has actually finished. Never a fabricated figure. */
  successRate: number | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  /** Says in words what the numbers do and do not cover. */
  note: string;
}

/** An agent with no runs yet. Stated once so no caller invents a different empty shape. */
export function emptyEngineAgentHealth(note: string): EngineAgentHealth {
  return {
    hasRunData: false,
    totalRuns: 0,
    succeeded: 0,
    failed: 0,
    openExceptions: 0,
    successRate: null,
    lastRunAt: null,
    nextRunAt: null,
    note,
  };
}

// ---------------------------------------------------------------------------
// Version impact analysis
// ---------------------------------------------------------------------------

/**
 * What changes when a new agent version is drafted.
 *
 * The prompt requires "impact analysis/test/approval before activation where required", and this
 * is the analysis half. It exists because an agent version is not a private edit: objectives are
 * relying on the current one, and a reviewer needs to know what would move underneath them.
 */
export interface AgentVersionImpact {
  /** Which parts of the configuration differ from the version in force. */
  changedFields: string[];
  /** Objectives currently relying on this agent. */
  affectedObjectiveIds: string[];
  /** Skill versions the new draft would use that the live one does not. */
  addedSkillVersionIds: string[];
  removedSkillVersionIds: string[];
  /** Tool categories the new draft would need that the live one does not. */
  addedToolCategories: string[];
  /** True when the change alters what the agent may reach or remember. */
  widensReach: boolean;
  /**
   * Whether activating this draft needs an approval rather than just the owner's say-so.
   *
   * The prompt's "where required" — and this is what makes it concrete rather than a maybe.
   */
  approvalRequired: boolean;
  reasons: string[];
}

/**
 * Whether a drafted change needs approval before it can be activated.
 *
 * Two triggers, both about reach rather than taste:
 *
 *   * **It widens what the agent can reach** — a new tool category, or a memory mode that starts
 *     persisting what used to be ephemeral. Widening reach without review is how an agent quietly
 *     acquires a capability nobody signed off.
 *   * **Other objectives depend on it.** Changing an agent that only its own objective uses is a
 *     local decision; changing one that several rely on is not.
 *
 * A narrowing change — fewer tools, a stricter memory mode — needs no approval. Requiring one
 * would discourage exactly the edits a company should be free to make immediately.
 */
export function versionActivationNeedsApproval(input: {
  addedToolCategories: readonly string[];
  memoryModeWidens: boolean;
  affectedObjectiveCount: number;
}): { required: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (input.addedToolCategories.length > 0) {
    reasons.push(
      `It would let the agent perform ${input.addedToolCategories.join(', ')}, which it cannot ` +
        'do today.',
    );
  }
  if (input.memoryModeWidens) {
    reasons.push('It would let the agent keep information beyond the run it was gathered in.');
  }
  if (input.affectedObjectiveCount > 1) {
    reasons.push(
      `${input.affectedObjectiveCount} objectives rely on this agent, so the change is not local ` +
        'to one of them.',
    );
  }

  return { required: reasons.length > 0, reasons };
}
