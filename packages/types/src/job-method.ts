/**
 * The Job Method form — download, offline fill, upload — and how UBoss draws Agent boundaries.
 *
 * Prompt 40A (CR-03).
 *
 * ## What this artifact is, and what it deliberately is not
 *
 * It is **not Form 2**. Form 2 is the Objective's workflow — who does what, when, with what input,
 * producing what — and its structure is locked: do not simplify it, do not remove source fields.
 * `Form2WorkflowStep` stays exactly as it is.
 *
 * It is **not a Skill**. `SkillContent` is the governed, versioned AI capability, and `SkillStep`
 * is `{order, instruction}`.
 *
 * The Job Method sits between them, and the reason it has to exist separately is its column set.
 * Five of its thirteen columns have no home in either: **TOOL / SYSTEM / WORKPLACE** (distinct from
 * *where* the work happens), **HOW — the exact method**, **RULE / FORMULA / CHECK**, **AGENT MUST
 * NEVER DO**, and **IF MISSING / WRONG**. Those five are precisely the ones that turn a described
 * business step into something an agent could actually be built from, which is why the client asks
 * for them and why folding this into Form 2 would either lose them or corrupt a locked structure.
 *
 * So: Form 2 **prefills** it, the employee **fills** it offline, and the builder's upload **feeds**
 * the Agent design. Three artifacts, one direction of travel.
 *
 * ## Why the employee fills it without Agent Builder access
 *
 * Because the person who knows how the work is actually done is rarely the person who should be
 * configuring agents. CR-03 makes that explicit: a standard Employee is Operations-only, and the
 * Job Method form is the mechanism by which their knowledge reaches a build they cannot perform.
 * A spreadsheet they can fill on a train is a better answer than granting them a builder role.
 */

// ---------------------------------------------------------------------------
// The columns
// ---------------------------------------------------------------------------

/**
 * The thirteen columns, in the client's exact order and with their exact headings.
 *
 * Held as data, and the headings are transcribed rather than tidied — including the spacing and
 * the capitalisation. A person who filled in one of these offline last month must recognise the
 * one they download today, and an importer that matched a prettier heading would reject their file.
 */
export const JOB_METHOD_COLUMNS = [
  { key: 'step', heading: 'Step' },
  { key: 'whatExactWork', heading: 'WHAT - Exact Work' },
  { key: 'inputExactInput', heading: 'INPUT - Exact Input' },
  { key: 'whereInputSource', heading: 'WHERE - Input Source' },
  { key: 'toolSystemWorkplace', heading: 'TOOL / SYSTEM / WORKPLACE' },
  { key: 'howExactMethod', heading: 'HOW - Exact Method / Agent Action' },
  { key: 'ruleFormulaCheck', heading: 'RULE / FORMULA / CHECK' },
  { key: 'output', heading: 'OUTPUT' },
  { key: 'outputDestination', heading: 'OUTPUT DESTINATION' },
  { key: 'approval', heading: 'APPROVAL' },
  { key: 'agentMustNeverDo', heading: 'AGENT MUST NEVER DO' },
  { key: 'ifMissingOrWrong', heading: 'IF MISSING / WRONG' },
  { key: 'time', heading: 'TIME' },
] as const;

export type JobMethodColumnKey = (typeof JOB_METHOD_COLUMNS)[number]['key'];

export const JOB_METHOD_COLUMN_KEYS: readonly JobMethodColumnKey[] = JOB_METHOD_COLUMNS.map(
  (column) => column.key,
);

/** Heading → key, for an importer reading a returned file. */
export const JOB_METHOD_KEY_BY_HEADING: Record<string, JobMethodColumnKey> = Object.fromEntries(
  JOB_METHOD_COLUMNS.map((column) => [normaliseHeading(column.heading), column.key]),
) as Record<string, JobMethodColumnKey>;

/**
 * Compare headings the way a spreadsheet round-trip actually mangles them.
 *
 * Case, whitespace runs, and the punctuation between words all get changed by Excel, by Google
 * Sheets, by a paste into Word and back, and by anybody who retypes a header. What survives is the
 * letters and digits. Matching on those means a file that has been through three tools still
 * imports, and the alternative — an exact string match — is an importer that rejects correct data
 * for a reason no user can see.
 */
export function normaliseHeading(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * One row of the form, as filled.
 *
 * Every cell optional except the step number, because a **partially filled form is the normal
 * case**. The employee filling it may not know the tool, or there may be no approval. An importer
 * that required all thirteen would push people into typing "n/a" thirteen times, and "n/a" is
 * worse than an empty cell: it is indistinguishable from a real answer.
 */
export interface JobMethodRow {
  step: number;
  whatExactWork?: string | undefined;
  inputExactInput?: string | undefined;
  whereInputSource?: string | undefined;
  toolSystemWorkplace?: string | undefined;
  howExactMethod?: string | undefined;
  ruleFormulaCheck?: string | undefined;
  output?: string | undefined;
  outputDestination?: string | undefined;
  approval?: string | undefined;
  agentMustNeverDo?: string | undefined;
  ifMissingOrWrong?: string | undefined;
  time?: string | undefined;
}

/** The most a single cell may carry. Long enough for a real method, short enough to store. */
export const JOB_METHOD_CELL_MAX = 2_000;

/** The most rows one form may carry. A job with more than this is more than one job. */
export const JOB_METHOD_MAX_ROWS = 200;

// ---------------------------------------------------------------------------
// The form version
// ---------------------------------------------------------------------------

/**
 * The version of the form's *shape*.
 *
 * Bumped when a column is added, removed or renamed — never for a wording change in the
 * instructions. It is written into every download and checked on every upload, because the
 * alternative is silent misalignment: a form downloaded before a column was added, filled in over
 * a fortnight, and uploaded afterwards would have its cells read into the wrong fields. A version
 * check turns that into a clear refusal with a clear instruction.
 */
export const JOB_METHOD_FORM_VERSION = 1;

/** Versions this build can still read. */
export const JOB_METHOD_READABLE_VERSIONS: readonly number[] = [1];

export function formVersionIsReadable(version: unknown): boolean {
  return typeof version === 'number' && JOB_METHOD_READABLE_VERSIONS.includes(version);
}

// ---------------------------------------------------------------------------
// What may leave the building
// ---------------------------------------------------------------------------

/**
 * The only linkage metadata a downloaded form may carry.
 *
 * A closed list, because a download is a file that leaves UBoss and comes back. Everything here is
 * an identifier or a label the employee already knows; nothing here is a secret, and nothing here
 * would tell a reader how the system works.
 */
export const EXPORTABLE_CONTEXT_FIELDS = [
  'formVersion',
  'objectiveId',
  'objectiveVersionId',
  'objectiveName',
  'aiWorkAssignmentId',
  'assignmentTitle',
  'assignedToEmployeeRef',
  'downloadedAt',
] as const;
export type ExportableContextField = (typeof EXPORTABLE_CONTEXT_FIELDS)[number];

/**
 * Words that must never appear in an exported form, checked rather than trusted.
 *
 * The prompt says *"Never export secrets, credentials, system prompts or API keys"*, and a rule
 * like that is kept by a test that greps the produced file — not by the care of whoever writes the
 * exporter next. The same shape as `NEVER_IN_A_PORTABLE_PROFILE` at Prompt 37A, and for the same
 * reason: a prohibition with no assertion behind it is a comment.
 */
export const NEVER_IN_AN_EXPORTED_FORM: readonly string[] = [
  'apikey',
  'api_key',
  'secret',
  'credential',
  'password',
  'token',
  'systemprompt',
  'system_prompt',
  'bearer',
  'privatekey',
  'aadhaar',
  'connectionstring',
];

/** Context written into a downloaded form. Exactly `EXPORTABLE_CONTEXT_FIELDS`, nothing more. */
export interface JobMethodFormContext {
  formVersion: number;
  objectiveId: string;
  objectiveVersionId: string;
  objectiveName: string;
  aiWorkAssignmentId: string;
  assignmentTitle: string;
  /**
   * The company's own Employee ID or the assignment reference — **never** a UBoss Unique ID and
   * never an email. This file may be forwarded; a portable cross-company identifier in it would
   * travel with it.
   */
  assignedToEmployeeRef: string | null;
  downloadedAt: string;
}

/**
 * Everything a download contains: the context, the headings, and the prefilled rows.
 *
 * Serialised as a workbook by the API. The shape is declared here so a test can assert what a
 * download contains without parsing a spreadsheet.
 */
export interface JobMethodForm {
  context: JobMethodFormContext;
  columns: typeof JOB_METHOD_COLUMNS;
  rows: JobMethodRow[];
}

/**
 * Does this form carry anything it must not?
 *
 * Scans every context value and every cell. Returns the offending words rather than a boolean, so
 * a failure says *what* leaked — a test that only knew "something leaked" would send somebody
 * hunting through thirteen columns.
 */
export function exportLeaks(form: JobMethodForm): string[] {
  const haystack = [
    ...Object.values(form.context).map((value) => String(value ?? '')),
    ...form.rows.flatMap((row) => Object.values(row).map((value) => String(value ?? ''))),
  ]
    .join(' ')
    .toLowerCase()
    // Separators stripped for the same reason `logFieldIsForbidden` strips them: `api_key`,
    // `apiKey` and `API-KEY` are one word wearing three hats, and at Prompt 39 that exact gap let
    // `API_KEY` through a forbidden-field check.
    .replace(/[^a-z0-9]/g, '');

  return NEVER_IN_AN_EXPORTED_FORM.filter((word) =>
    haystack.includes(word.replace(/[^a-z0-9]/g, '')),
  );
}

// ---------------------------------------------------------------------------
// Prefilling from Form 2
// ---------------------------------------------------------------------------

/**
 * Which Form 2 fields safely prefill which Job Method columns.
 *
 * Only where the two genuinely mean the same thing. **Five columns are deliberately left blank**
 * — `toolSystemWorkplace`, `howExactMethod`, `ruleFormulaCheck`, `agentMustNeverDo` and
 * `ifMissingOrWrong` — because Form 2 has no field that means any of them, and a prefill that
 * guessed would be UBoss inventing a business fact and presenting it as the company's own answer.
 * The whole point of sending the form out is to collect those five.
 *
 * `whereInputSource` maps from `inputReceivedFrom` and **not** from `whereWorkIsDone`: the column
 * asks where the *input* comes from, and Form 2's `whereWorkIsDone` is where the work happens.
 * Those are different questions and conflating them would put a plausible wrong answer in front of
 * the person least likely to challenge it.
 */
export const FORM2_PREFILL: Readonly<Partial<Record<JobMethodColumnKey, string>>> = {
  whatExactWork: 'whatExactWork',
  inputExactInput: 'inputWhatIsUsed',
  whereInputSource: 'inputReceivedFrom',
  output: 'outputWhatIsProduced',
  outputDestination: 'outputSentTo',
  approval: 'approval',
  time: 'timeTaken',
};

/** The columns nothing prefills, stated positively so the set is testable. */
export const COLUMNS_THE_EMPLOYEE_MUST_ANSWER: readonly JobMethodColumnKey[] =
  JOB_METHOD_COLUMN_KEYS.filter((key) => key !== 'step' && FORM2_PREFILL[key] === undefined);

// ---------------------------------------------------------------------------
// The import pipeline
// ---------------------------------------------------------------------------

/**
 * The pipeline, as the prompt states it, in order.
 *
 * Declared as data so the API can report which stage a file stopped at, and so the order cannot
 * quietly change. The order is the safety property: linkage is verified **before** anything is
 * parsed, and nothing is saved until a person has seen the review.
 */
export const IMPORT_STAGES = [
  'ValidateFile',
  'VerifyLinkage',
  'ParseRows',
  'MapFields',
  'FlagProblems',
  'Review',
  'MergeIntoDraft',
] as const;
export type ImportStage = (typeof IMPORT_STAGES)[number];

export const IMPORT_STAGE_LABELS: Record<ImportStage, string> = {
  ValidateFile: 'Check the file and its version',
  VerifyLinkage: 'Check it belongs to this objective and assignment',
  ParseRows: 'Read the rows',
  MapFields: 'Match the columns to fields',
  FlagProblems: 'Flag anything missing, invalid or unclear',
  Review: 'Show the import review',
  MergeIntoDraft: 'Save into the draft',
};

/**
 * What can be wrong with an imported row or file.
 *
 * `Ambiguous` and `Unmapped` are separate from `Invalid` on purpose. Invalid means UBoss knows the
 * value is wrong. Ambiguous means UBoss cannot tell — two readings are possible. Unmapped means a
 * column arrived that UBoss has no field for, which is usually a person adding a column because
 * the form did not ask what they needed to say. All three need a human; collapsing them into one
 * "error" would hide the fact that the third is feedback about the form rather than a mistake.
 */
export const IMPORT_PROBLEM_KINDS = ['Missing', 'Invalid', 'Ambiguous', 'Unmapped'] as const;
export type ImportProblemKind = (typeof IMPORT_PROBLEM_KINDS)[number];

export const IMPORT_PROBLEM_LABELS: Record<ImportProblemKind, string> = {
  Missing: 'Not filled in',
  Invalid: 'Not usable as written',
  Ambiguous: 'Could mean more than one thing',
  Unmapped: 'A column UBoss has no field for',
};

export interface ImportProblem {
  kind: ImportProblemKind;
  /** 1-based row number as the person filling it in would count, or null for a whole-file problem. */
  row: number | null;
  column: string | null;
  /** What is wrong, in words the builder can act on without opening the file. */
  detail: string;
}

/**
 * Where a value came from.
 *
 * The prompt asks to *"preserve source provenance"*, and this is why it matters: after a merge, a
 * draft contains some cells the company typed offline and some UBoss prefilled from Form 2. Six
 * weeks later, "did we decide this or did the system?" is unanswerable without it — and that is
 * exactly the question asked when an agent does something unexpected.
 */
export const VALUE_SOURCES = ['UploadedForm', 'Form2Prefill', 'BuilderEdit'] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];

export interface ImportOutcome {
  stage: ImportStage;
  accepted: boolean;
  rows: JobMethodRow[];
  problems: ImportProblem[];
  /** Per row, per column, where the value came from. */
  provenance: Record<string, ValueSource>;
  /** Set when the file was refused outright, in words a person can act on. */
  refusedBecause: string | null;
}

export function provenanceKey(row: number, column: JobMethodColumnKey): string {
  return `${row}:${column}`;
}

/**
 * Check a file's header and version before anything is read from it.
 *
 * Deliberately separate from row parsing and deliberately first. A file for a different assignment,
 * or from a form version whose columns have moved, must be refused **before** its cells are read
 * into fields — because once they are read, a wrong mapping looks exactly like a filled-in form.
 */
export function validateFormEnvelope(input: {
  formVersion: unknown;
  objectiveVersionId: unknown;
  aiWorkAssignmentId: unknown;
  expected: { objectiveVersionId: string; aiWorkAssignmentId: string };
}): { ok: true } | { ok: false; stage: ImportStage; reason: string } {
  if (!formVersionIsReadable(input.formVersion)) {
    return {
      ok: false,
      stage: 'ValidateFile',
      reason:
        `This file is version ${String(input.formVersion ?? 'unknown')} of the Job Method form, ` +
        `and this build reads version ${JOB_METHOD_READABLE_VERSIONS.join(' or ')}. Download a ` +
        'fresh form and copy the answers across — reading it anyway could put answers in the ' +
        'wrong columns.',
    };
  }

  if (input.aiWorkAssignmentId !== input.expected.aiWorkAssignmentId) {
    return {
      ok: false,
      stage: 'VerifyLinkage',
      reason:
        'This file was downloaded for a different piece of assigned work, so its answers describe ' +
        'a different job. Open the assignment it belongs to, or download the form for this one.',
    };
  }

  if (input.objectiveVersionId !== input.expected.objectiveVersionId) {
    return {
      ok: false,
      stage: 'VerifyLinkage',
      reason:
        'This file was downloaded from an earlier version of the Objective, which has since ' +
        'changed. Download the current form so the answers line up with the workflow in force.',
    };
  }

  return { ok: true };
}

/**
 * Read one row, reporting what is wrong rather than repairing it.
 *
 * **Nothing is invented and nothing is defaulted.** A blank cell is reported `Missing` and stays
 * blank; an over-long cell is reported `Invalid` and is *not* truncated. Truncating would store a
 * sentence that ends mid-word as though the company had written it that way, and the company would
 * never know. The prompt's rule — *"do not silently invent business facts"* — is enforced by
 * refusing to write anything the file did not say.
 */
export function readRow(input: {
  step: number;
  cells: Partial<Record<JobMethodColumnKey, unknown>>;
  /** Columns that must be answered for a row to be usable at all. */
  required?: readonly JobMethodColumnKey[];
}): { row: JobMethodRow; problems: ImportProblem[] } {
  const problems: ImportProblem[] = [];
  const row: JobMethodRow = { step: input.step };
  const required = input.required ?? (['whatExactWork'] as const);

  for (const key of JOB_METHOD_COLUMN_KEYS) {
    if (key === 'step') continue;

    const raw = input.cells[key];
    const heading = JOB_METHOD_COLUMNS.find((column) => column.key === key)?.heading ?? key;

    if (raw === undefined || raw === null || String(raw).trim() === '') {
      if (required.includes(key)) {
        problems.push({
          kind: 'Missing',
          row: input.step,
          column: heading,
          detail: `Row ${input.step} does not say what the work is, so there is nothing to build from.`,
        });
      }
      continue;
    }

    if (typeof raw !== 'string' && typeof raw !== 'number') {
      problems.push({
        kind: 'Invalid',
        row: input.step,
        column: heading,
        detail: `Row ${input.step} has something in "${heading}" that is not text.`,
      });
      continue;
    }

    const value = String(raw).trim();
    if (value.length > JOB_METHOD_CELL_MAX) {
      problems.push({
        kind: 'Invalid',
        row: input.step,
        column: heading,
        detail:
          `Row ${input.step} has ${value.length} characters in "${heading}", and the limit is ` +
          `${JOB_METHOD_CELL_MAX}. Shorten it rather than letting UBoss cut it off mid-sentence.`,
      });
      continue;
    }

    row[key] = value;
  }

  return { row, problems };
}

/**
 * Is this import safe to merge?
 *
 * `Missing`, `Ambiguous` and `Unmapped` do **not** block: an incomplete form is still worth having
 * in a draft, and the flags travel with it so the builder sees the gaps. `Invalid` blocks, because
 * a value UBoss knows is wrong should not be written at all.
 *
 * Either way the answer is a **draft**. Nothing here activates anything — see `AUTOMATION_STANCE`.
 */
export function mayMerge(problems: readonly ImportProblem[]): boolean {
  return !problems.some((problem) => problem.kind === 'Invalid');
}

export const AUTOMATION_STANCE =
  'Uploading a completed Job Method form saves into a draft and nothing else. It never tests the ' +
  'agent and never activates it. A file is a statement of how work is done, not an instruction to ' +
  'start doing it — and an upload that activated something would let a spreadsheet put an agent ' +
  'into production without anybody deciding to.';

// ---------------------------------------------------------------------------
// Agent boundaries
// ---------------------------------------------------------------------------

/**
 * The eight factors that decide where one Engine Agent ends and the next begins.
 *
 * **One Job Method row is not one Engine Agent**, and the client says so explicitly. Thirteen rows
 * describing a month-end close are not thirteen agents; they may be two. The factors below are the
 * client's own list, held as data with the argument for each, because "why is this two agents and
 * not one?" is a question a builder will be asked and should not have to answer from instinct.
 */
export const AGENT_BOUNDARY_FACTORS = [
  {
    key: 'Responsibility',
    label: 'One responsibility',
    why:
      'An agent that does two unrelated jobs cannot be paused for one of them, and its failures ' +
      'cannot be read. "What is this for?" should have one answer.',
  },
  {
    key: 'ToolsAndConnections',
    label: 'The tools and connections it needs',
    why:
      'Steps needing different systems become different agents, because a connection that expires ' +
      'should stop the work that depends on it and nothing else.',
  },
  {
    key: 'Permissions',
    label: 'The permissions it runs with',
    why:
      'Merging a step that needs a sensitive grant with one that does not would run the harmless ' +
      'step at the higher privilege for no reason. Least privilege is a boundary, not a setting.',
  },
  {
    key: 'TriggerAndFrequency',
    label: 'When and how often it runs',
    why:
      'Hourly work and month-end work are not one agent. Forcing them together means either the ' +
      'hourly work waits or the monthly work runs 720 times.',
  },
  {
    key: 'SecurityAndApproval',
    label: 'Whether a human must approve it',
    why:
      'A step requiring approval must not be able to carry an unapproved step through with it. ' +
      'Splitting is what keeps the approval meaningful.',
  },
  {
    key: 'DataBoundary',
    label: 'What data it can see',
    why:
      'Steps touching different classifications become different agents, so a restricted input ' +
      'does not widen the reach of everything in the same run.',
  },
  {
    key: 'ExecutionContext',
    label: 'Where it executes',
    why: 'Different environments have different limits, latencies and failure modes.',
  },
  {
    key: 'RetryAndFailureIsolation',
    label: 'What a failure should take down with it',
    why:
      'The one people forget. If step nine fails, should steps one to eight be repeated? If the ' +
      'answer is no, step nine belongs to a different agent — otherwise every retry redoes work ' +
      'that already succeeded, and at cost.',
  },
] as const;

export type AgentBoundaryFactorKey = (typeof AGENT_BOUNDARY_FACTORS)[number]['key'];

/**
 * The path from an Objective to a running agent.
 *
 * Held as data so a screen can show where a piece of work has got to, and so nothing can quietly
 * skip a stage. **`Test` precedes `Approval` precedes `Activate`**, and that order is the product
 * rule: approving something nobody has tested is approving a description of it, and activating
 * before approval is the thing the Approval Engine exists to prevent.
 */
export const BUILD_FLOW_STAGES = [
  'Objective',
  'AiWorkAssignment',
  'JobMethod',
  'AgentDesign',
  'Review',
  'Test',
  'Approval',
  'Activate',
] as const;
export type BuildFlowStage = (typeof BUILD_FLOW_STAGES)[number];

export const BUILD_FLOW_LABELS: Record<BuildFlowStage, string> = {
  Objective: 'Objective agreed',
  AiWorkAssignment: 'AI work assigned',
  JobMethod: 'Job Method captured',
  AgentDesign: 'Agent designed',
  Review: 'Reviewed',
  Test: 'Tested',
  Approval: 'Approved',
  Activate: 'Live',
};

/** Approval is conditional; every other stage is not. */
export const CONDITIONAL_STAGES: readonly BuildFlowStage[] = ['Approval'];

export function stageIsRequired(stage: BuildFlowStage): boolean {
  return !CONDITIONAL_STAGES.includes(stage);
}

/**
 * How many Engine Agents this Job Method suggests, and why.
 *
 * A **suggestion**, never a decision — the name says `suggest` for that reason. It groups rows that
 * agree on the factors a boundary is drawn from, and hands the builder the grouping with its
 * reasoning so they can accept it, merge groups or split further.
 *
 * It is deliberately not clever. Grouping on the declared tool, the approval requirement and the
 * stated prohibitions catches the distinctions that matter most often, and anything subtler is a
 * judgement UBoss should not be making on a company's behalf. A confident automatic answer here
 * would be worse than an obvious rough one, because nobody checks a confident answer.
 */
export function suggestAgentGroups(rows: readonly JobMethodRow[]): {
  groups: { key: string; steps: number[]; because: string }[];
} {
  const groups = new Map<string, { steps: number[]; because: string }>();

  for (const row of rows) {
    const tool = (row.toolSystemWorkplace ?? '').trim().toLowerCase() || 'unspecified-tool';
    const needsApproval = looksLikeApprovalRequired(row.approval) ? 'approved' : 'unapproved';
    const restricted = (row.agentMustNeverDo ?? '').trim() === '' ? 'open' : 'restricted';
    const key = `${tool}|${needsApproval}|${restricted}`;

    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        steps: [row.step],
        because:
          `These steps share a tool or workplace (${tool === 'unspecified-tool' ? 'not stated' : tool}), ` +
          `the same approval requirement (${needsApproval}) and the same prohibitions ` +
          `(${restricted}). Splitting them would create agents that fail and retry together for ` +
          'no reason; merging them with others would widen what a failure takes down.',
      });
    } else {
      existing.steps.push(row.step);
    }
  }

  return {
    groups: [...groups.entries()]
      .map(([key, value]) => ({
        key,
        steps: value.steps.sort((a, b) => a - b),
        because: value.because,
      }))
      // Deterministic, so a screen and a test see the same order twice.
      .sort((left, right) => (left.steps[0] ?? 0) - (right.steps[0] ?? 0)),
  };
}

/**
 * Does this approval cell mean "a person must approve"?
 *
 * A free-text cell filled in by whoever had the form, so the reading is deliberately cautious:
 * anything that is not recognisably a "no" is treated as **requiring** approval. Getting this
 * wrong in the permissive direction would let an agent act where the company said a person must
 * decide; getting it wrong the other way asks somebody an unnecessary question. Those costs are
 * not symmetric.
 */
export function looksLikeApprovalRequired(cell: string | undefined): boolean {
  const value = (cell ?? '').trim().toLowerCase();
  if (value === '') return false;
  const negatives = ['no', 'none', 'not required', 'n/a', 'na', 'nil', '-', 'no approval'];
  return !negatives.includes(value);
}
