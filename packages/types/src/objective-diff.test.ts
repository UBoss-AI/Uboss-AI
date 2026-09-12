import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  diffObjectiveVersions,
  isObjectiveWorkAssignable,
  OBJECTIVE_STATUSES,
  VERSION_ORIGIN_LABELS,
  VERSION_ORIGINS,
  type Form2Objective,
  type Form2WorkflowStep,
} from './objectives.js';

function content(overrides: Partial<Form2Objective> = {}): Form2Objective {
  return {
    objectiveName: 'GSPR checklist generation',
    departmentId: '11111111-1111-4111-8111-111111111111',
    objectiveOwnerUserId: '22222222-2222-4222-8222-222222222222',
    expectedFinalResult: 'Zero critical gaps.',
    currentWorkload: 7,
    unit: 'variants',
    targetCompletionTime: 10,
    timeUnit: 'WorkingDays',
    preparedBy: 'Priya Nair',
    formDate: '2026-09-10',
    responsibleOwnerUserId: '33333333-3333-4333-8333-333333333333',
    executionTeam: 'Regulatory',
    ...overrides,
  };
}

function step(overrides: Partial<Form2WorkflowStep> = {}): Form2WorkflowStep {
  return {
    position: 1,
    whoPersonName: 'Pranav Kulkarni',
    whoDesignation: 'Specialist',
    whoEngine: 'Human',
    whenTrigger: 'Objective start',
    whenFrequency: 'Once',
    whatExactWork: 'Collect evidence',
    inputWhatIsUsed: 'DHF',
    inputReceivedFrom: 'R&D',
    whereWorkIsDone: 'UBoss',
    outputWhatIsProduced: 'Index',
    outputSentTo: 'Reviewer',
    timeTaken: '2h',
    currentProblem: null,
    approval: 'NotRequired',
    ...overrides,
  };
}

describe('employees receive no actionable work during review', () => {
  it('marks only a live version assignable', () => {
    // The client's rule as one function, so the To-do module, the agent runner and any later
    // assigner ask the same question rather than each deciding for itself.
    for (const status of OBJECTIVE_STATUSES) {
      assert.equal(isObjectiveWorkAssignable(status), status === 'Active', `${status} is wrong`);
    }
  });

  it('does not make an approved-but-unpublished version assignable', () => {
    // A plan awaiting publication is not work anybody owes yet.
    assert.equal(isObjectiveWorkAssignable('ReadyForApproval'), false);
  });
});

describe('version origins', () => {
  it('has the three the client implies, and labels each', () => {
    assert.deepEqual(VERSION_ORIGINS, ['Initial', 'Edit', 'Rollback']);
    for (const origin of VERSION_ORIGINS) {
      assert.ok(VERSION_ORIGIN_LABELS[origin].length > 0);
    }
  });
});

describe('diffObjectiveVersions', () => {
  it('reports two identical versions as identical', () => {
    // Reachable and load-bearing: a minor edit still creates a version, so a version identical to
    // its parent is a legitimate record and the compare view must say so rather than hide it.
    const diff = diffObjectiveVersions(
      { content: content(), steps: [step()] },
      { content: content(), steps: [step()] },
    );
    assert.equal(diff.identical, true);
    assert.deepEqual(diff.fields, []);
    assert.deepEqual(diff.steps, []);
    assert.match(diff.summary, /Nothing changed/);
  });

  it('reports a changed objective-level field with both values', () => {
    const diff = diffObjectiveVersions(
      { content: content(), steps: [] },
      { content: content({ objectiveName: 'Revised' }), steps: [] },
    );
    assert.equal(diff.identical, false);
    assert.equal(diff.fields.length, 1);
    assert.equal(diff.fields[0]?.key, 'objectiveName');
    assert.equal(diff.fields[0]?.label, 'Objective Name');
    assert.equal(diff.fields[0]?.before, 'GSPR checklist generation');
    assert.equal(diff.fields[0]?.after, 'Revised');
  });

  it('carries the section, so a routing change is distinguishable from a Form 2 change', () => {
    const diff = diffObjectiveVersions(
      { content: content(), steps: [] },
      { content: content({ executionTeam: 'Exports' }), steps: [] },
    );
    assert.equal(diff.fields[0]?.section, 'UbossRouting');
  });

  it('treats null and empty string as the same "not set"', () => {
    // Otherwise clearing a field one way would look different from clearing it the other, and
    // every save would appear to change something.
    const diff = diffObjectiveVersions(
      { content: content({ unit: null }), steps: [] },
      { content: content({ unit: '' }), steps: [] },
    );
    assert.equal(diff.identical, true);
  });

  it('reports a cleared field as a change', () => {
    const diff = diffObjectiveVersions(
      { content: content({ unit: 'variants' }), steps: [] },
      { content: content({ unit: null }), steps: [] },
    );
    assert.equal(diff.fields[0]?.key, 'unit');
    assert.equal(diff.fields[0]?.after, null);
  });

  it('walks the shared field list, so a field missing from one side still shows', () => {
    // Driven by FORM2_OBJECTIVE_FIELDS rather than Object.keys: a comparison over the objects'
    // own keys would silently skip a field one version does not carry.
    const diff = diffObjectiveVersions(
      { content: {}, steps: [] },
      { content: content(), steps: [] },
    );
    assert.equal(diff.fields.length, 12);
  });

  it('reports an added step', () => {
    const diff = diffObjectiveVersions(
      { content: content(), steps: [step()] },
      { content: content(), steps: [step(), step({ position: 2 })] },
    );
    assert.equal(diff.steps.length, 1);
    assert.equal(diff.steps[0]?.kind, 'Added');
    assert.equal(diff.steps[0]?.position, 2);
  });

  it('reports a removed step', () => {
    const diff = diffObjectiveVersions(
      { content: content(), steps: [step(), step({ position: 2 })] },
      { content: content(), steps: [step()] },
    );
    assert.equal(diff.steps[0]?.kind, 'Removed');
    assert.equal(diff.steps[0]?.position, 2);
  });

  it('reports a changed cell and names the column', () => {
    const diff = diffObjectiveVersions(
      { content: content(), steps: [step()] },
      { content: content(), steps: [step({ whatExactWork: 'Collect revised evidence' })] },
    );
    assert.equal(diff.steps[0]?.kind, 'Changed');
    assert.equal(diff.steps[0]?.cells.length, 1);
    assert.equal(diff.steps[0]?.cells[0]?.key, 'whatExactWork');
    assert.equal(diff.steps[0]?.cells[0]?.label, 'Exact Work');
  });

  it('reports every changed cell in a row, not just the first', () => {
    const diff = diffObjectiveVersions(
      { content: content(), steps: [step()] },
      {
        content: content(),
        steps: [step({ whoEngine: 'Engine', approval: 'Head', timeTaken: '8 min' })],
      },
    );
    const keys = diff.steps[0]?.cells.map((cell) => cell.key) ?? [];
    assert.ok(keys.includes('whoEngine'));
    assert.ok(keys.includes('approval'));
    assert.ok(keys.includes('timeTaken'));
  });

  it('never reports the Step column as changed, because it is the position', () => {
    const diff = diffObjectiveVersions(
      { content: content(), steps: [step()] },
      { content: content(), steps: [step({ whatExactWork: 'Other' })] },
    );
    const keys = diff.steps[0]?.cells.map((cell) => cell.key) ?? [];
    assert.ok(!keys.includes('step'));
  });

  it('is directional', () => {
    const before = { content: content(), steps: [step()] };
    const after = { content: content({ objectiveName: 'Revised' }), steps: [] };

    const forward = diffObjectiveVersions(before, after);
    const backward = diffObjectiveVersions(after, before);

    assert.equal(forward.fields[0]?.after, 'Revised');
    assert.equal(backward.fields[0]?.after, 'GSPR checklist generation');
    assert.equal(forward.steps[0]?.kind, 'Removed');
    assert.equal(backward.steps[0]?.kind, 'Added');
  });

  it('summarises how much differs', () => {
    const diff = diffObjectiveVersions(
      { content: content(), steps: [step()] },
      {
        content: content({ objectiveName: 'Revised', unit: 'units' }),
        steps: [step({ whatExactWork: 'Other' })],
      },
    );
    assert.match(diff.summary, /2 fields and 1 workflow step differ/);
  });

  it('uses singular wording for a single difference', () => {
    const diff = diffObjectiveVersions(
      { content: content(), steps: [] },
      { content: content({ unit: 'units' }), steps: [] },
    );
    assert.match(diff.summary, /1 field and 0 workflow steps differ/);
  });
});
