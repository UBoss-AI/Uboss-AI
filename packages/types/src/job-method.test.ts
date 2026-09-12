import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AGENT_BOUNDARY_FACTORS,
  AUTOMATION_STANCE,
  BUILD_FLOW_STAGES,
  COLUMNS_THE_EMPLOYEE_MUST_ANSWER,
  EXPORTABLE_CONTEXT_FIELDS,
  exportLeaks,
  FORM2_PREFILL,
  formVersionIsReadable,
  IMPORT_PROBLEM_KINDS,
  IMPORT_STAGES,
  JOB_METHOD_CELL_MAX,
  JOB_METHOD_COLUMN_KEYS,
  JOB_METHOD_COLUMNS,
  JOB_METHOD_FORM_VERSION,
  JOB_METHOD_KEY_BY_HEADING,
  looksLikeApprovalRequired,
  mayMerge,
  NEVER_IN_AN_EXPORTED_FORM,
  normaliseHeading,
  readRow,
  stageIsRequired,
  suggestAgentGroups,
  validateFormEnvelope,
  type ImportProblem,
  type JobMethodForm,
  type JobMethodRow,
} from './job-method.js';

const CONTEXT: JobMethodForm['context'] = {
  formVersion: JOB_METHOD_FORM_VERSION,
  objectiveId: 'obj-1',
  objectiveVersionId: 'ver-1',
  objectiveName: 'Quarterly filing',
  aiWorkAssignmentId: 'asn-1',
  assignmentTitle: 'Prepare the return',
  assignedToEmployeeRef: 'EMP-0042',
  downloadedAt: '2026-09-16T09:00:00.000Z',
};

const form = (rows: JobMethodRow[]): JobMethodForm => ({
  context: CONTEXT,
  columns: JOB_METHOD_COLUMNS,
  rows,
});

describe('the thirteen columns are the client’s thirteen', () => {
  it('has them in the document’s order with the document’s headings', () => {
    assert.deepEqual(
      JOB_METHOD_COLUMNS.map((column) => column.heading),
      [
        'Step',
        'WHAT - Exact Work',
        'INPUT - Exact Input',
        'WHERE - Input Source',
        'TOOL / SYSTEM / WORKPLACE',
        'HOW - Exact Method / Agent Action',
        'RULE / FORMULA / CHECK',
        'OUTPUT',
        'OUTPUT DESTINATION',
        'APPROVAL',
        'AGENT MUST NEVER DO',
        'IF MISSING / WRONG',
        'TIME',
      ],
    );
  });

  it('gives every column a distinct key', () => {
    assert.equal(new Set(JOB_METHOD_COLUMN_KEYS).size, JOB_METHOD_COLUMN_KEYS.length);
  });

  it('matches a heading through whatever a spreadsheet did to it', () => {
    // Case, spacing and punctuation all get changed by Excel, by Sheets, by a paste into Word and
    // back, and by anybody retyping a header. What survives is the letters and digits — and an
    // exact string match would reject correct data for a reason no user can see.
    for (const spelling of [
      'WHAT - Exact Work',
      'what - exact work',
      'WHAT — EXACT WORK',
      '  What  -  Exact   Work  ',
      'WHAT_EXACT_WORK',
    ]) {
      assert.equal(
        JOB_METHOD_KEY_BY_HEADING[normaliseHeading(spelling)],
        'whatExactWork',
        spelling,
      );
    }
  });

  it('does not collapse two different headings into one key', () => {
    // The check that makes separator-stripping safe. If `OUTPUT` and `OUTPUT DESTINATION`
    // normalised to the same thing, an importer would silently overwrite one with the other.
    const normalised = JOB_METHOD_COLUMNS.map((column) => normaliseHeading(column.heading));
    assert.equal(new Set(normalised).size, normalised.length);
  });
});

describe('prefilling from Form 2', () => {
  it('leaves exactly the five columns Form 2 cannot answer', () => {
    // The reason the form is sent out at all. A prefill that guessed any of these would be UBoss
    // inventing a business fact and showing it to the person least likely to challenge it.
    assert.deepEqual([...COLUMNS_THE_EMPLOYEE_MUST_ANSWER].sort(), [
      'agentMustNeverDo',
      'howExactMethod',
      'ifMissingOrWrong',
      'ruleFormulaCheck',
      'toolSystemWorkplace',
    ]);
  });

  it('maps the input source from where the input comes, not from where the work happens', () => {
    // Two different questions. Conflating them would put a plausible wrong answer in front of
    // somebody who would probably accept it.
    assert.equal(FORM2_PREFILL.whereInputSource, 'inputReceivedFrom');
    assert.notEqual(FORM2_PREFILL.whereInputSource, 'whereWorkIsDone');
  });

  it('never prefills a column it has no source for', () => {
    for (const key of COLUMNS_THE_EMPLOYEE_MUST_ANSWER) {
      assert.equal(FORM2_PREFILL[key], undefined, `${key} is prefilled from somewhere`);
    }
  });
});

describe('what may leave the building', () => {
  it('carries only the declared context fields', () => {
    assert.deepEqual(Object.keys(CONTEXT).sort(), [...EXPORTABLE_CONTEXT_FIELDS].sort());
  });

  it('passes a clean form', () => {
    assert.deepEqual(exportLeaks(form([{ step: 1, whatExactWork: 'File the return' }])), []);
  });

  it('catches a secret however it is spelled', () => {
    // Separators stripped on both sides, for the same reason Prompt 39's forbidden-log-field check
    // needed it: `api_key`, `apiKey` and `API-KEY` are one word wearing three hats, and that exact
    // gap let `API_KEY` through once already.
    for (const spelling of ['apiKey', 'api_key', 'API-KEY', 'Api Key']) {
      const leaks = exportLeaks(
        form([{ step: 1, howExactMethod: `Use the ${spelling} from the vault` }]),
      );
      assert.ok(leaks.length > 0, `"${spelling}" was not caught`);
    }
  });

  it('catches a secret in the context as well as in a cell', () => {
    const leaked: JobMethodForm = {
      ...form([{ step: 1 }]),
      context: { ...CONTEXT, objectiveName: 'Rotate the client credential' },
    };
    assert.ok(exportLeaks(leaked).length > 0);
  });

  it('names the offending word rather than only failing', () => {
    // A failure that only said "something leaked" would send somebody hunting through thirteen
    // columns.
    const leaks = exportLeaks(form([{ step: 1, output: 'The system prompt, verbatim' }]));
    assert.ok(leaks.includes('systemprompt') || leaks.includes('system_prompt'));
  });

  it('forbids Aadhaar in a form that gets emailed around', () => {
    assert.ok(NEVER_IN_AN_EXPORTED_FORM.includes('aadhaar'));
    assert.ok(exportLeaks(form([{ step: 1, inputExactInput: 'Their Aadhaar number' }])).length > 0);
  });

  it('carries no portable cross-company identifier', () => {
    // The employee *reference* is the company's own Employee ID. A UBoss Unique ID in a file that
    // gets forwarded would travel with it — exactly what Prompt 37A was careful about.
    assert.equal(CONTEXT.assignedToEmployeeRef, 'EMP-0042');
    assert.equal(EXPORTABLE_CONTEXT_FIELDS.includes('ubossUniqueId' as never), false);
  });
});

describe('the form version', () => {
  it('reads the versions it knows and refuses the rest', () => {
    assert.equal(formVersionIsReadable(JOB_METHOD_FORM_VERSION), true);
    assert.equal(formVersionIsReadable(99), false);
    assert.equal(formVersionIsReadable('1'), false);
    assert.equal(formVersionIsReadable(undefined), false);
  });

  it('refuses a file from a version whose columns may have moved, before reading a cell', () => {
    const outcome = validateFormEnvelope({
      formVersion: 99,
      objectiveVersionId: 'ver-1',
      aiWorkAssignmentId: 'asn-1',
      expected: { objectiveVersionId: 'ver-1', aiWorkAssignmentId: 'asn-1' },
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.stage, 'ValidateFile');
    // Says what to do, because the person holding the file cannot fix a version number.
    assert.match(outcome.reason, /download a fresh form/i);
  });
});

describe('verifying the linkage before anything is parsed', () => {
  it('accepts a file for the right assignment and version', () => {
    assert.deepEqual(
      validateFormEnvelope({
        formVersion: 1,
        objectiveVersionId: 'ver-1',
        aiWorkAssignmentId: 'asn-1',
        expected: { objectiveVersionId: 'ver-1', aiWorkAssignmentId: 'asn-1' },
      }),
      { ok: true },
    );
  });

  it('refuses a file downloaded for different work', () => {
    const outcome = validateFormEnvelope({
      formVersion: 1,
      objectiveVersionId: 'ver-1',
      aiWorkAssignmentId: 'asn-OTHER',
      expected: { objectiveVersionId: 'ver-1', aiWorkAssignmentId: 'asn-1' },
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.stage, 'VerifyLinkage');
    assert.match(outcome.reason, /different piece of assigned work/i);
  });

  it('refuses a file from a superseded objective version', () => {
    const outcome = validateFormEnvelope({
      formVersion: 1,
      objectiveVersionId: 'ver-OLD',
      aiWorkAssignmentId: 'asn-1',
      expected: { objectiveVersionId: 'ver-1', aiWorkAssignmentId: 'asn-1' },
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.reason, /has since changed/i);
  });

  it('checks the file before the linkage', () => {
    // The order is the safety property: a file whose columns may have moved must be refused
    // before its cells are read into fields, because after that a wrong mapping looks exactly
    // like a filled-in form.
    const both = validateFormEnvelope({
      formVersion: 99,
      aiWorkAssignmentId: 'asn-WRONG',
      objectiveVersionId: 'ver-WRONG',
      expected: { objectiveVersionId: 'ver-1', aiWorkAssignmentId: 'asn-1' },
    });
    assert.equal(both.ok, false);
    if (both.ok) return;
    assert.equal(both.stage, 'ValidateFile');
    assert.equal(IMPORT_STAGES.indexOf('ValidateFile') < IMPORT_STAGES.indexOf('VerifyLinkage'), true);
  });
});

describe('reading a row without inventing anything', () => {
  it('reads what is there and trims it', () => {
    const { row, problems } = readRow({
      step: 1,
      cells: { whatExactWork: '  File the return  ', time: '2 hours' },
    });
    assert.equal(row.whatExactWork, 'File the return');
    assert.equal(row.time, '2 hours');
    assert.deepEqual(problems, []);
  });

  it('leaves a blank cell blank and does not default it', () => {
    // A partially filled form is the normal case. Defaulting would put an answer in the company's
    // mouth; "n/a" would be indistinguishable from a real one.
    const { row } = readRow({ step: 1, cells: { whatExactWork: 'Something' } });
    assert.equal(row.toolSystemWorkplace, undefined);
    assert.equal('toolSystemWorkplace' in row, false);
  });

  it('flags the one column a row cannot do without', () => {
    const { problems } = readRow({ step: 3, cells: {} });
    assert.equal(problems.length, 1);
    assert.equal(problems[0]?.kind, 'Missing');
    assert.equal(problems[0]?.row, 3);
    assert.match(problems[0]?.detail ?? '', /nothing to build from/i);
  });

  it('refuses an over-long cell rather than truncating it', () => {
    // Truncating would store a sentence ending mid-word as though the company had written it that
    // way, and they would never know.
    const { row, problems } = readRow({
      step: 1,
      cells: { whatExactWork: 'x'.repeat(JOB_METHOD_CELL_MAX + 1) },
    });
    assert.equal(problems[0]?.kind, 'Invalid');
    assert.match(problems[0]?.detail ?? '', /shorten it/i);
    assert.equal(row.whatExactWork, undefined, 'the over-long value was stored anyway');
  });

  it('flags a cell that is not text', () => {
    const { problems } = readRow({
      step: 1,
      cells: { whatExactWork: 'Fine', approval: { nested: true } },
    });
    assert.equal(problems.some((problem) => problem.kind === 'Invalid'), true);
  });

  it('accepts a number, because a spreadsheet produces them', () => {
    const { row } = readRow({ step: 1, cells: { whatExactWork: 'Fine', time: 90 } });
    assert.equal(row.time, '90');
  });
});

describe('deciding whether to merge', () => {
  const problem = (kind: ImportProblem['kind']): ImportProblem => ({
    kind,
    row: 1,
    column: 'WHAT - Exact Work',
    detail: 'x',
  });

  it('merges an incomplete form, flags and all', () => {
    // An incomplete form is still worth having in a draft, and the flags travel with it.
    assert.equal(mayMerge([problem('Missing')]), true);
    assert.equal(mayMerge([problem('Ambiguous')]), true);
    assert.equal(mayMerge([problem('Unmapped')]), true);
  });

  it('refuses to write a value it knows is wrong', () => {
    assert.equal(mayMerge([problem('Invalid')]), false);
  });

  it('keeps the four problem kinds distinct', () => {
    // Only one of them is a mistake: `Unmapped` is feedback about the *form*, and collapsing them
    // into one "error" would hide that.
    assert.deepEqual([...IMPORT_PROBLEM_KINDS], [
      'Missing',
      'Invalid',
      'Ambiguous',
      'Unmapped',
    ]);
  });

  it('says plainly that an import activates nothing', () => {
    assert.match(AUTOMATION_STANCE, /never tests/i);
    assert.match(AUTOMATION_STANCE, /never activates/i);
  });
});

describe('drawing agent boundaries', () => {
  it('does not make one agent per row', () => {
    // The client says so explicitly. Thirteen rows of a month-end close are not thirteen agents.
    const rows: JobMethodRow[] = [
      { step: 1, toolSystemWorkplace: 'SAP', approval: 'No' },
      { step: 2, toolSystemWorkplace: 'SAP', approval: 'No' },
      { step: 3, toolSystemWorkplace: 'SAP', approval: 'No' },
    ];
    const { groups } = suggestAgentGroups(rows);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]?.steps, [1, 2, 3]);
  });

  it('splits on a different tool, because a broken connection should stop only its own work', () => {
    const { groups } = suggestAgentGroups([
      { step: 1, toolSystemWorkplace: 'SAP' },
      { step: 2, toolSystemWorkplace: 'Salesforce' },
    ]);
    assert.equal(groups.length, 2);
  });

  it('splits on approval, so an unapproved step cannot ride along with an approved one', () => {
    const { groups } = suggestAgentGroups([
      { step: 1, toolSystemWorkplace: 'SAP', approval: 'Head of Finance' },
      { step: 2, toolSystemWorkplace: 'SAP', approval: 'No' },
    ]);
    assert.equal(groups.length, 2);
  });

  it('explains each group, because a builder will be asked why', () => {
    const { groups } = suggestAgentGroups([{ step: 1, toolSystemWorkplace: 'SAP' }]);
    assert.ok((groups[0]?.because ?? '').length > 60);
  });

  it('is deterministic and orders groups by their first step', () => {
    const rows: JobMethodRow[] = [
      { step: 3, toolSystemWorkplace: 'B' },
      { step: 1, toolSystemWorkplace: 'A' },
      { step: 2, toolSystemWorkplace: 'B' },
    ];
    const once = suggestAgentGroups(rows).groups.map((group) => group.steps);
    const twice = suggestAgentGroups(rows).groups.map((group) => group.steps);
    assert.deepEqual(once, twice);
    assert.deepEqual(once, [[1], [2, 3]]);
  });

  it('handles an empty set', () => {
    assert.deepEqual(suggestAgentGroups([]).groups, []);
  });

  it('names the eight factors with a reason each, including failure isolation', () => {
    const keys = AGENT_BOUNDARY_FACTORS.map((factor) => factor.key);
    assert.equal(keys.length, 8);
    // The one people forget: if step nine fails, should one to eight be redone? If not, nine
    // belongs to a different agent — otherwise every retry redoes work that already succeeded.
    assert.ok(keys.includes('RetryAndFailureIsolation'));
    for (const factor of AGENT_BOUNDARY_FACTORS) {
      assert.ok(factor.why.length > 40, `${factor.key} has no argument`);
    }
  });
});

describe('reading a free-text approval cell', () => {
  it('treats a recognisable no as no', () => {
    for (const value of ['No', 'none', 'Not required', 'n/a', 'NA', 'nil', '-', '']) {
      assert.equal(looksLikeApprovalRequired(value), false, value);
    }
    assert.equal(looksLikeApprovalRequired(undefined), false);
  });

  it('treats anything else as requiring approval', () => {
    // The costs are not symmetric. Guessing "no approval" would let an agent act where the company
    // said a person must decide; guessing the other way asks somebody an unnecessary question.
    for (const value of ['Head of Finance', 'Manager sign-off', 'yes', 'probably', 'ask Priya']) {
      assert.equal(looksLikeApprovalRequired(value), true, value);
    }
  });
});

describe('the build flow', () => {
  it('tests before approving and approves before activating', () => {
    // Approving something nobody has tested is approving a description of it, and activating
    // before approval is what the Approval Engine exists to prevent.
    const order = [...BUILD_FLOW_STAGES];
    assert.ok(order.indexOf('Test') < order.indexOf('Approval'));
    assert.ok(order.indexOf('Approval') < order.indexOf('Activate'));
    assert.ok(order.indexOf('JobMethod') < order.indexOf('AgentDesign'));
  });

  it('makes approval the only conditional stage', () => {
    for (const stage of BUILD_FLOW_STAGES) {
      assert.equal(stageIsRequired(stage), stage !== 'Approval', stage);
    }
  });
});
