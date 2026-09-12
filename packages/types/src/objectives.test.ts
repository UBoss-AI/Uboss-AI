import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALLOWED_OBJECTIVE_TRANSITIONS,
  EDITABLE_OBJECTIVE_STATUSES,
  form2Field,
  FORM2_OBJECTIVE_FIELDS,
  FORM2_SOURCE_FIELD_KEYS,
  FORM2_WORKFLOW_COLUMN_COUNT,
  FORM2_WORKFLOW_COLUMNS,
  FROZEN_OBJECTIVE_STATUSES,
  isObjectiveContentFrozen,
  isObjectiveDraftEditable,
  mayTransitionObjective,
  OBJECTIVE_STATUS_LABELS,
  OBJECTIVE_STATUSES,
  REWARD_TYPES,
  STEP_APPROVAL_KINDS,
  STEP_ENGINE_KINDS,
  TIME_UNITS,
  validateForm2Objective,
  validateForm2WorkflowSteps,
  validateObjectiveForSubmission,
  validateRewardPanel,
  WORKFLOW_COLUMN_GROUPS,
  type Form2Objective,
  type Form2WorkflowStep,
  type ObjectiveRewardPanel,
  type ObjectiveStatus,
} from './objectives.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validObjective(overrides: Partial<Form2Objective> = {}): Form2Objective {
  return {
    objectiveName: 'GSPR checklist generation for IV Cannula range',
    departmentId: '11111111-1111-4111-8111-111111111111',
    objectiveOwnerUserId: '22222222-2222-4222-8222-222222222222',
    expectedFinalResult: 'A complete Annex I GSPR checklist per variant at 0 critical gaps.',
    currentWorkload: 7,
    unit: 'variants',
    targetCompletionTime: 10,
    timeUnit: 'WorkingDays',
    preparedBy: 'Priya Nair',
    formDate: '2026-09-10',
    responsibleOwnerUserId: '33333333-3333-4333-8333-333333333333',
    executionTeam: 'Regulatory Affairs — Documentation',
    ...overrides,
  };
}

function validStep(overrides: Partial<Form2WorkflowStep> = {}): Form2WorkflowStep {
  return {
    position: 1,
    whoPersonName: 'Pranav Kulkarni',
    whoDesignation: 'Reg. Doc Specialist',
    whoEngine: 'Human',
    whenTrigger: 'Objective start',
    whenFrequency: 'Once per variant',
    whatExactWork: 'Collect DHF + predicate evidence',
    inputWhatIsUsed: 'DHF workbook',
    inputReceivedFrom: 'R&D / DHF',
    whereWorkIsDone: 'UBoss + Drive',
    outputWhatIsProduced: 'Evidence index',
    outputSentTo: 'GSPR Drafter',
    timeTaken: '2h',
    currentProblem: 'Scattered evidence',
    approval: 'NotRequired',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Form 2 is preserved exactly
// ---------------------------------------------------------------------------

describe('Form 2 field list', () => {
  it('keeps every objective-level source field the client named', () => {
    // The client's list, verbatim, in the source document's order. This test is the reason a
    // future edit cannot quietly drop or rename one of them.
    assert.deepEqual(FORM2_SOURCE_FIELD_KEYS, [
      'objectiveName',
      'departmentId',
      'objectiveOwnerUserId',
      'expectedFinalResult',
      'currentWorkload',
      'unit',
      'targetCompletionTime',
      'timeUnit',
      'preparedBy',
      'formDate',
    ]);
  });

  it('keeps the four starred fields required and the rest optional', () => {
    const required = FORM2_OBJECTIVE_FIELDS.filter((field) => field.required).map((f) => f.key);
    assert.deepEqual(required, [
      'objectiveName',
      'departmentId',
      'objectiveOwnerUserId',
      'expectedFinalResult',
    ]);
  });

  it('keeps Unit and Time Unit as two separate fields', () => {
    // The specific simplification the client called out. One field carrying both would satisfy a
    // careless reading of "the form has a unit".
    const unit = form2Field('unit');
    const timeUnit = form2Field('timeUnit');
    assert.ok(unit, 'Unit must exist as its own field');
    assert.ok(timeUnit, 'Time Unit must exist as its own field');
    assert.notEqual(unit.key, timeUnit.key);
    assert.equal(unit.label, 'Unit');
    assert.equal(timeUnit.label, 'Time Unit');
  });

  it('puts the two UBoss routing controls outside the source section', () => {
    const routing = FORM2_OBJECTIVE_FIELDS.filter((field) => field.section === 'UbossRouting').map(
      (field) => field.key,
    );
    assert.deepEqual(routing, ['responsibleOwnerUserId', 'executionTeam']);
    assert.ok(!FORM2_SOURCE_FIELD_KEYS.includes('responsibleOwnerUserId'));
    assert.ok(!FORM2_SOURCE_FIELD_KEYS.includes('executionTeam'));
  });

  it('carries the client’s exact labels, not paraphrases', () => {
    assert.equal(form2Field('expectedFinalResult')?.label, 'Expected Final Result');
    assert.equal(form2Field('currentWorkload')?.label, 'Current Workload');
    assert.equal(form2Field('targetCompletionTime')?.label, 'Target Completion Time');
    assert.equal(form2Field('preparedBy')?.label, 'Prepared By');
    assert.equal(form2Field('formDate')?.label, 'Date');
    assert.equal(form2Field('responsibleOwnerUserId')?.label, 'Responsible Owner / Send To');
    assert.equal(form2Field('executionTeam')?.label, 'Execution Team');
  });

  it('has no duplicate keys', () => {
    const keys = FORM2_OBJECTIVE_FIELDS.map((field) => field.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('Form 2 workflow grid', () => {
  it('has exactly fifteen columns', () => {
    // Not a target — what the approved form has. Asserted so it cannot become fourteen.
    assert.equal(FORM2_WORKFLOW_COLUMN_COUNT, 15);
    assert.equal(FORM2_WORKFLOW_COLUMNS.length, 15);
  });

  it('keeps every source column, in the source order', () => {
    assert.deepEqual(
      FORM2_WORKFLOW_COLUMNS.map((column) => column.key),
      [
        'step',
        'whoPersonName',
        'whoDesignation',
        'whoEngine',
        'whenTrigger',
        'whenFrequency',
        'whatExactWork',
        'inputWhatIsUsed',
        'inputReceivedFrom',
        'whereWorkIsDone',
        'outputWhatIsProduced',
        'outputSentTo',
        'timeTaken',
        'currentProblem',
        'approval',
      ],
    );
  });

  it('keeps the six grouped headers', () => {
    assert.deepEqual(WORKFLOW_COLUMN_GROUPS, ['WHO', 'WHEN', 'WHAT', 'INPUT', 'WHERE', 'OUTPUT']);
  });

  it('groups the columns the way the source spreadsheet does', () => {
    const grouped: Record<string, string[]> = {};
    for (const column of FORM2_WORKFLOW_COLUMNS) {
      const key = column.group ?? '(none)';
      grouped[key] = [...(grouped[key] ?? []), column.key];
    }
    assert.deepEqual(grouped['WHO'], ['whoPersonName', 'whoDesignation', 'whoEngine']);
    assert.deepEqual(grouped['WHEN'], ['whenTrigger', 'whenFrequency']);
    assert.deepEqual(grouped['WHAT'], ['whatExactWork']);
    assert.deepEqual(grouped['INPUT'], ['inputWhatIsUsed', 'inputReceivedFrom']);
    assert.deepEqual(grouped['WHERE'], ['whereWorkIsDone']);
    assert.deepEqual(grouped['OUTPUT'], ['outputWhatIsProduced', 'outputSentTo']);
    // The four that sit under no banner and span both header rows.
    assert.deepEqual(grouped['(none)'], ['step', 'timeTaken', 'currentProblem', 'approval']);
  });

  it('keeps Current Problem, which is the column most likely to be dropped as usually blank', () => {
    assert.ok(FORM2_WORKFLOW_COLUMNS.some((column) => column.key === 'currentProblem'));
  });

  it('names Step as derived rather than stored', () => {
    const step = FORM2_WORKFLOW_COLUMNS.find((column) => column.key === 'step');
    assert.equal(step?.kind, 'step');
  });

  it('offers Human plus the three machine kinds, and Executor is one of them', () => {
    assert.deepEqual(STEP_ENGINE_KINDS, ['Human', 'Engine', 'SubEngine', 'Executor']);
  });

  it('offers the four approval kinds with four-eyes distinct from Head', () => {
    assert.deepEqual(STEP_APPROVAL_KINDS, ['NotRequired', 'Manager', 'Head', 'FourEyes']);
  });

  it('offers the four duration units', () => {
    assert.deepEqual(TIME_UNITS, ['WorkingDays', 'CalendarDays', 'Hours', 'Weeks']);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('objective lifecycle', () => {
  it('carries the client’s states with their full approved wording', () => {
    // Eight at Prompt 19; eleven from Prompt 34, which added §27.1's controlled pause and its
    // "Completed -> Outcome Review -> Closed -> Archived" closure chain. The authoring states keep
    // their original order and wording — a reordering would break every screen that reads the
    // list as a progression.
    assert.deepEqual(OBJECTIVE_STATUSES, [
      'Draft',
      'UnderReview',
      'AiAnalysis',
      'WorkflowDraft',
      'ReadyForApproval',
      'Active',
      'Paused',
      'Completed',
      'OutcomeReview',
      'Closed',
      'Archived',
    ]);
    assert.equal(OBJECTIVE_STATUS_LABELS.UnderReview, 'Submitted / Under Review');
    assert.equal(OBJECTIVE_STATUS_LABELS.Active, 'Published / Active');
    assert.equal(OBJECTIVE_STATUS_LABELS.OutcomeReview, 'Outcome Review');
  });

  it('has a transition entry for every state', () => {
    for (const status of OBJECTIVE_STATUSES) {
      assert.ok(
        Array.isArray(ALLOWED_OBJECTIVE_TRANSITIONS[status]),
        `${status} has no transition entry`,
      );
    }
  });

  it('never permits a transition to an unknown state', () => {
    for (const status of OBJECTIVE_STATUSES) {
      for (const next of ALLOWED_OBJECTIVE_TRANSITIONS[status]) {
        assert.ok(OBJECTIVE_STATUSES.includes(next), `${status} -> ${next} is not a known state`);
      }
    }
  });

  it('never permits a state to transition to itself', () => {
    for (const status of OBJECTIVE_STATUSES) {
      assert.ok(
        !ALLOWED_OBJECTIVE_TRANSITIONS[status].includes(status),
        `${status} transitions to itself`,
      );
    }
  });

  it('lets a draft be submitted and sent back', () => {
    assert.ok(mayTransitionObjective('Draft', 'UnderReview'));
    assert.ok(mayTransitionObjective('UnderReview', 'Draft'));
  });

  it('refuses to move a live version backwards into a draft state', () => {
    // The versioning rule: an authorised edit after Live creates a NEW draft version. Moving the
    // live one back would be exactly the overwrite the rule forbids.
    assert.ok(!mayTransitionObjective('Active', 'Draft'));
    assert.ok(!mayTransitionObjective('Active', 'UnderReview'));
    assert.ok(!mayTransitionObjective('Active', 'WorkflowDraft'));
    assert.ok(!mayTransitionObjective('Active', 'ReadyForApproval'));
  });

  it('lets a live version complete and archive', () => {
    assert.ok(mayTransitionObjective('Active', 'Completed'));
    assert.ok(mayTransitionObjective('Completed', 'Archived'));
  });

  it('makes Archived terminal', () => {
    assert.deepEqual(ALLOWED_OBJECTIVE_TRANSITIONS.Archived, []);
  });

  it('never republishes a completed objective', () => {
    assert.ok(!mayTransitionObjective('Completed', 'Active'));
  });

  it('reaches Active for the first time only through ReadyForApproval', () => {
    // Two states reach `Active`, and only one of them is a publication. `Paused -> Active` is a
    // resume of work that was already approved and published — the objective never left the live
    // side of the lifecycle — so it is not a second route past the approval gate. The test pins
    // both, because a third entry appearing here *would* be a way to go live without approval.
    const routes = OBJECTIVE_STATUSES.filter((status) =>
      ALLOWED_OBJECTIVE_TRANSITIONS[status].includes('Active'),
    );
    assert.deepEqual(routes, ['ReadyForApproval', 'Paused']);

    // And nothing in the authoring half of the lifecycle can jump the gate.
    for (const status of ['Draft', 'UnderReview', 'AiAnalysis', 'WorkflowDraft'] as const) {
      assert.equal(ALLOWED_OBJECTIVE_TRANSITIONS[status].includes('Active'), false, status);
    }
  });

  it('freezes content from Active onwards, pause included', () => {
    // `Paused` is the one people assume is editable: the work has stopped, so surely the plan can
    // be changed? No — pausing stops the work and does not reopen the plan, or "pause" would be a
    // way round the versioning rule. Rethinking a paused objective is a new Draft version, which
    // is the same rule as every other edit after Live.
    assert.deepEqual(FROZEN_OBJECTIVE_STATUSES, [
      'Active',
      'Paused',
      'Completed',
      'OutcomeReview',
      'Closed',
      'Archived',
    ]);
    assert.ok(isObjectiveContentFrozen('Active'));
    assert.ok(isObjectiveContentFrozen('Paused'));
    assert.ok(isObjectiveContentFrozen('Completed'));
    assert.ok(isObjectiveContentFrozen('OutcomeReview'));
    assert.ok(isObjectiveContentFrozen('Closed'));
    assert.ok(isObjectiveContentFrozen('Archived'));
    assert.ok(!isObjectiveContentFrozen('Draft'));
  });

  it('does not let an author edit while somebody is reviewing', () => {
    // Deliberately not the complement of frozen: changing content under a reviewer is how a
    // reviewer ends up approving something they never read.
    assert.deepEqual(EDITABLE_OBJECTIVE_STATUSES, ['Draft', 'AiAnalysis', 'WorkflowDraft']);
    assert.ok(!isObjectiveDraftEditable('UnderReview'));
    assert.ok(!isObjectiveDraftEditable('ReadyForApproval'));
    assert.ok(isObjectiveDraftEditable('Draft'));
  });

  it('never marks a frozen state editable', () => {
    for (const status of FROZEN_OBJECTIVE_STATUSES) {
      assert.ok(!isObjectiveDraftEditable(status as ObjectiveStatus));
    }
  });
});

// ---------------------------------------------------------------------------
// Objective-level validation
// ---------------------------------------------------------------------------

describe('validateForm2Objective', () => {
  it('accepts a complete form', () => {
    assert.deepEqual(validateForm2Objective(validObjective()), []);
  });

  it('accepts a form with every optional field empty', () => {
    // Drafting is permissive on purpose: a form that refuses to save is a form people keep in a
    // spreadsheet instead.
    assert.deepEqual(
      validateForm2Objective(
        validObjective({
          currentWorkload: null,
          unit: null,
          targetCompletionTime: null,
          timeUnit: null,
          preparedBy: null,
          formDate: null,
          responsibleOwnerUserId: null,
          executionTeam: null,
        }),
      ),
      [],
    );
  });

  it('names each missing required field by its client label', () => {
    const problems = validateForm2Objective({});
    assert.ok(problems.some((problem) => problem.includes('Objective Name is required')));
    assert.ok(problems.some((problem) => problem.includes('Department is required')));
    assert.ok(problems.some((problem) => problem.includes('Objective Owner is required')));
    assert.ok(problems.some((problem) => problem.includes('Expected Final Result is required')));
  });

  it('treats a blank required field as missing', () => {
    const problems = validateForm2Objective(validObjective({ objectiveName: '   ' }));
    assert.ok(problems.some((problem) => problem.includes('Objective Name is required')));
  });

  it('refuses a target with no time unit', () => {
    const problems = validateForm2Objective(
      validObjective({ targetCompletionTime: 10, timeUnit: null }),
    );
    assert.ok(problems.some((problem) => problem.includes('needs a Time Unit')));
  });

  it('accepts a workload unit without a time unit', () => {
    // The two pairs are independent. Requiring a Time Unit because a Unit was given would be the
    // collapse the client forbade, arriving through validation instead of through the form.
    assert.deepEqual(
      validateForm2Objective(
        validObjective({ unit: 'variants', targetCompletionTime: null, timeUnit: null }),
      ),
      [],
    );
  });

  it('refuses a negative workload and a negative target', () => {
    assert.ok(
      validateForm2Objective(validObjective({ currentWorkload: -1 })).some((problem) =>
        problem.includes('Current Workload'),
      ),
    );
    assert.ok(
      validateForm2Objective(validObjective({ targetCompletionTime: -5 })).some((problem) =>
        problem.includes('Target Completion Time'),
      ),
    );
  });

  it('refuses a fractional workload', () => {
    assert.ok(
      validateForm2Objective(validObjective({ currentWorkload: 2.5 })).some((problem) =>
        problem.includes('whole number'),
      ),
    );
  });

  it('refuses an unknown time unit', () => {
    const problems = validateForm2Objective(validObjective({ timeUnit: 'Fortnights' as never }));
    assert.ok(problems.some((problem) => problem.includes('Unknown Time Unit')));
  });

  it('refuses over-long text against the same ceiling the column has', () => {
    const problems = validateForm2Objective(validObjective({ unit: 'x'.repeat(61) }));
    assert.ok(problems.some((problem) => problem.includes('longer than 60')));
  });
});

// ---------------------------------------------------------------------------
// Grid validation
// ---------------------------------------------------------------------------

describe('validateForm2WorkflowSteps', () => {
  it('accepts an empty grid while drafting', () => {
    // An objective is routinely named before its steps are known.
    assert.deepEqual(validateForm2WorkflowSteps([]), []);
  });

  it('accepts a contiguous grid', () => {
    assert.deepEqual(
      validateForm2WorkflowSteps([validStep({ position: 1 }), validStep({ position: 2 })]),
      [],
    );
  });

  it('does not cap the row count', () => {
    // The approved UI states the row count is not fixed.
    const many = Array.from({ length: 120 }, (_unused, index) =>
      validStep({ position: index + 1 }),
    );
    assert.deepEqual(validateForm2WorkflowSteps(many), []);
  });

  it('refuses two steps at the same position', () => {
    const problems = validateForm2WorkflowSteps([
      validStep({ position: 1 }),
      validStep({ position: 1 }),
    ]);
    assert.ok(problems.some((problem) => problem.includes('share the same position')));
  });

  it('refuses a gap in the positions', () => {
    const problems = validateForm2WorkflowSteps([
      validStep({ position: 1 }),
      validStep({ position: 3 }),
    ]);
    assert.ok(problems.some((problem) => problem.includes('no gaps')));
  });

  it('refuses a step with no work', () => {
    const problems = validateForm2WorkflowSteps([validStep({ whatExactWork: '  ' })]);
    assert.ok(problems.some((problem) => problem.includes('Exact Work is required')));
  });

  it('refuses an unknown engine kind and an unknown approval', () => {
    assert.ok(
      validateForm2WorkflowSteps([validStep({ whoEngine: 'Robot' as never })]).some((problem) =>
        problem.includes('unknown Engine kind'),
      ),
    );
    assert.ok(
      validateForm2WorkflowSteps([validStep({ approval: 'Board' as never })]).some((problem) =>
        problem.includes('unknown Approval'),
      ),
    );
  });

  it('permits a human step with nobody named while drafting', () => {
    assert.deepEqual(validateForm2WorkflowSteps([validStep({ whoPersonName: null })]), []);
  });

  it('names the step a problem is in', () => {
    const problems = validateForm2WorkflowSteps([
      validStep({ position: 1 }),
      validStep({ position: 2, whatExactWork: '' }),
    ]);
    assert.ok(problems.some((problem) => problem.startsWith('Step 2:')));
  });

  it('refuses over-long cell text against the column ceiling', () => {
    const problems = validateForm2WorkflowSteps([validStep({ timeTaken: 'x'.repeat(61) })]);
    assert.ok(problems.some((problem) => problem.includes('Time Taken is longer than 60')));
  });
});

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

describe('validateObjectiveForSubmission', () => {
  it('accepts a coherent objective', () => {
    assert.deepEqual(validateObjectiveForSubmission(validObjective(), [validStep()]), []);
  });

  it('refuses submission with no steps', () => {
    const problems = validateObjectiveForSubmission(validObjective(), []);
    assert.ok(problems.some((problem) => problem.includes('at least one workflow step')));
  });

  it('refuses submission with no Responsible Owner', () => {
    const problems = validateObjectiveForSubmission(
      validObjective({ responsibleOwnerUserId: null }),
      [validStep()],
    );
    assert.ok(
      problems.some((problem) => problem.includes('Responsible Owner / Send To is required')),
    );
  });

  it('refuses a human step with nobody named', () => {
    // Permitted while drafting, refused at submit — the commonest way a workflow becomes
    // unassignable.
    const problems = validateObjectiveForSubmission(validObjective(), [
      validStep({ whoEngine: 'Human', whoPersonName: null }),
    ]);
    assert.ok(problems.some((problem) => problem.includes('needs a Person Name')));
  });

  it('does not demand a person for a machine step', () => {
    assert.deepEqual(
      validateObjectiveForSubmission(validObjective(), [
        validStep({ whoEngine: 'Engine', whoPersonName: null }),
      ]),
      [],
    );
  });

  it('still applies the ordinary field validation', () => {
    const problems = validateObjectiveForSubmission({ objectiveName: 'Only a name' }, []);
    assert.ok(problems.some((problem) => problem.includes('Department is required')));
  });
});

// ---------------------------------------------------------------------------
// The reward panel
// ---------------------------------------------------------------------------

describe('validateRewardPanel', () => {
  const complete: ObjectiveRewardPanel = {
    applicable: true,
    rewardType: 'Cash',
    amountMinorUnits: 500_000,
    eligibilityCondition: 'Zero critical gaps, accepted by the Head',
    completionDeadline: '2026-10-15',
    evidence: 'Signed checklist in the technical file',
    approverUserId: '44444444-4444-4444-8444-444444444444',
  };

  it('offers the four reward kinds', () => {
    assert.deepEqual(REWARD_TYPES, ['Cash', 'Points', 'Recognition', 'Other']);
  });

  it('accepts a complete applicable panel', () => {
    assert.deepEqual(validateRewardPanel(complete), []);
  });

  it('accepts a panel recording that no reward applies', () => {
    assert.deepEqual(validateRewardPanel({ applicable: false }), []);
  });

  it('demands a type, a condition and an approver once applicable', () => {
    const problems = validateRewardPanel({ applicable: true });
    assert.ok(problems.some((problem) => problem.includes('needs a Reward Type')));
    assert.ok(problems.some((problem) => problem.includes('needs an Eligibility Condition')));
    assert.ok(problems.some((problem) => problem.includes('needs a named Approver')));
  });

  it('demands an amount for Cash and for Points', () => {
    for (const rewardType of ['Cash', 'Points'] as const) {
      const problems = validateRewardPanel({
        ...complete,
        rewardType,
        amountMinorUnits: null,
      });
      assert.ok(
        problems.some((problem) => problem.includes('needs an Amount / Points')),
        `${rewardType} should require an amount`,
      );
    }
  });

  it('does not demand an amount for Recognition', () => {
    // Demanding one would push people into entering a fake number.
    assert.deepEqual(
      validateRewardPanel({ ...complete, rewardType: 'Recognition', amountMinorUnits: null }),
      [],
    );
  });

  it('refuses a negative or fractional amount', () => {
    assert.ok(
      validateRewardPanel({ ...complete, amountMinorUnits: -1 }).some((problem) =>
        problem.includes('whole number'),
      ),
    );
    assert.ok(
      validateRewardPanel({ ...complete, amountMinorUnits: 12.5 }).some((problem) =>
        problem.includes('whole number'),
      ),
    );
  });

  it('refuses an unknown reward type', () => {
    const problems = validateRewardPanel({ ...complete, rewardType: 'Holiday' as never });
    assert.ok(problems.some((problem) => problem.includes('Unknown Reward Type')));
  });

  it('validates an amount even on an inapplicable panel', () => {
    // A stored negative amount would be wrong whether or not the panel is switched on.
    const problems = validateRewardPanel({ applicable: false, amountMinorUnits: -5 });
    assert.ok(problems.some((problem) => problem.includes('whole number')));
  });

  it('has no vocabulary for approving, settling or paying a reward', () => {
    // The client's rule is that nothing auto-pays on completion. The panel's shape is what
    // enforces it: there is no field to ask for it, in the type or in the validation.
    const keys = Object.keys(complete);
    for (const forbidden of ['approved', 'settled', 'paid', 'payout', 'disbursed', 'status']) {
      assert.ok(
        !keys.some((key) => key.toLowerCase().includes(forbidden)),
        `the reward panel must not carry a "${forbidden}" field`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The reward panel is not Form 2
// ---------------------------------------------------------------------------

describe('the reward panel stays outside Form 2', () => {
  it('shares no field key with the Form 2 field list', () => {
    const rewardKeys = [
      'applicable',
      'rewardType',
      'amountMinorUnits',
      'eligibilityCondition',
      'completionDeadline',
      'evidence',
      'approverUserId',
    ];
    const form2Keys = FORM2_OBJECTIVE_FIELDS.map((field) => field.key);
    const overlap = rewardKeys.filter((key) => form2Keys.includes(key));
    assert.deepEqual(overlap, []);
  });

  it('shares no field key with the workflow grid', () => {
    const rewardKeys = ['applicable', 'rewardType', 'amountMinorUnits', 'approverUserId'];
    const gridKeys = FORM2_WORKFLOW_COLUMNS.map((column) => column.key);
    assert.deepEqual(
      rewardKeys.filter((key) => gridKeys.includes(key)),
      [],
    );
  });
});
