import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ANALYSIS_NODE_KINDS,
  ANALYSIS_RUN_STATUSES,
  ANALYSIS_SCHEMA_VERSION,
  ANALYSIS_STAGE_LABELS,
  ANALYSIS_STAGES,
  analysisStageIndex,
  isAnalysisRunFinished,
  isReadableSchemaVersion,
  mayCancelAnalysis,
  NODE_SHAPE_BY_KIND,
  nodeShapeFor,
  TERMINAL_ANALYSIS_STATUSES,
  incompleteDodFields,
  mayConvertNode,
  upgradeWorkflowDraft,
  validateWorkflowDraft,
  WORKFLOW_EDGE_KIND_LABELS,
  WORKFLOW_EDGE_KINDS,
  type AnalysisNode,
  type WorkflowDraft,
} from './objective-analysis.js';

function node(overrides: Partial<AnalysisNode> = {}): AnalysisNode {
  const kind = overrides.kind ?? 'Human';
  return {
    id: 'step-1',
    kind,
    label: 'Collect evidence',
    shape: nodeShapeFor(kind),
    fromStepPosition: 1,
    ownerUserId: null,
    ownerDesignation: null,
    skillVersionId: null,
    skillName: null,
    dod: {
      expectedOutput: 'An evidence index.',
      criteria: 'Every applicable requirement has a named evidence document.',
      evidence: 'The evidence index, filed against this step.',
      dependencies: [],
      tools: [],
      approval: null,
      failureCondition: 'Evidence cannot be located for a requirement.',
    },
    approvalKind: null,
    triggerEvent: null,
    ...overrides,
  };
}

function draft(overrides: Partial<WorkflowDraft> = {}): WorkflowDraft {
  return {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    goalNodeId: 'goal',
    nodes: [
      node({
        id: 'goal',
        kind: 'Goal',
        label: 'GOAL · Ship the checklist',
        fromStepPosition: null,
      }),
      node(),
    ],
    edges: [{ fromNodeId: 'goal', toNodeId: 'step-1', kind: 'Sequential', condition: null }],
    usage: { minTokens: 100, maxTokens: 200, aiNodeCount: 1, basis: 'Derived from one AI step.' },
    risks: [],
    gaps: [],
    ...overrides,
  };
}

describe('the client’s seven stages', () => {
  it('are the seven named, in order', () => {
    assert.deepEqual(ANALYSIS_STAGES, [
      'UnderstandingObjective',
      'ReadingTeamStructure',
      'DetectingHumanWork',
      'IdentifyingAiWork',
      'MatchingSkills',
      'AssigningOwners',
      'BuildingWorkflow',
    ]);
  });

  it('label every stage', () => {
    for (const stage of ANALYSIS_STAGES) {
      assert.ok(ANALYSIS_STAGE_LABELS[stage].length > 0, `${stage} has no label`);
    }
  });

  it('index a stage by its position in the sequence', () => {
    assert.equal(analysisStageIndex('UnderstandingObjective'), 0);
    assert.equal(analysisStageIndex('BuildingWorkflow'), 6);
  });
});

describe('run statuses', () => {
  it('keep Cancelled and Failed apart', () => {
    // They mean opposite things about the product: one is somebody choosing to stop, the other is
    // the product not working. Collapsing them makes "how often does analysis fail" unanswerable.
    assert.ok(ANALYSIS_RUN_STATUSES.includes('Cancelled'));
    assert.ok(ANALYSIS_RUN_STATUSES.includes('Failed'));
    assert.notEqual('Cancelled', 'Failed');
  });

  it('treat the three endings as finished', () => {
    assert.deepEqual(TERMINAL_ANALYSIS_STATUSES, ['Completed', 'Cancelled', 'Failed']);
    for (const status of TERMINAL_ANALYSIS_STATUSES) {
      assert.ok(isAnalysisRunFinished(status));
      assert.ok(!mayCancelAnalysis(status), `${status} must not be cancellable`);
    }
  });

  it('only let an in-flight run be cancelled', () => {
    assert.ok(mayCancelAnalysis('Queued'));
    assert.ok(mayCancelAnalysis('Running'));
    assert.ok(!isAnalysisRunFinished('Queued'));
  });
});

describe('node shapes — the locked UI rule', () => {
  it('draws a Human node as a rectangle and an AI node as a diamond', () => {
    // The client's instruction is absolute. Keeping it as data rather than CSS means a restyle
    // cannot quietly make an AI node a rectangle, and this test is why.
    assert.equal(nodeShapeFor('Human'), 'rectangle');
    assert.equal(nodeShapeFor('Ai'), 'diamond');
  });

  it('gives the Goal its own shape, distinct from every other kind', () => {
    const goalShape = nodeShapeFor('Goal');
    assert.equal(goalShape, 'goal');
    for (const kind of ANALYSIS_NODE_KINDS.filter((candidate) => candidate !== 'Goal')) {
      assert.notEqual(nodeShapeFor(kind), goalShape, `${kind} must not look like the Goal`);
    }
  });

  it('never draws a Human node and an AI node the same', () => {
    assert.notEqual(nodeShapeFor('Human'), nodeShapeFor('Ai'));
  });

  it('has a shape for every node kind', () => {
    for (const kind of ANALYSIS_NODE_KINDS) {
      assert.ok(NODE_SHAPE_BY_KIND[kind], `${kind} has no shape`);
    }
  });

  it('keeps Approval and Condition as separate kinds', () => {
    // An approval is a person deciding; a condition is a rule being evaluated. Treating a
    // condition as an approval would put a human gate where the plan intended a branch.
    assert.ok(ANALYSIS_NODE_KINDS.includes('Approval'));
    assert.ok(ANALYSIS_NODE_KINDS.includes('Condition'));
  });
});

describe('schema versioning', () => {
  it('reads only its own version', () => {
    assert.ok(isReadableSchemaVersion(ANALYSIS_SCHEMA_VERSION));
    assert.ok(!isReadableSchemaVersion(ANALYSIS_SCHEMA_VERSION + 1));
    assert.ok(!isReadableSchemaVersion(0));
  });

  it('refuses a draft from a version it does not understand, rather than guessing', () => {
    const problems = validateWorkflowDraft({ ...draft(), schemaVersion: 99 });
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /refused rather than guessed at/);
  });
});

describe('validateWorkflowDraft', () => {
  it('accepts a well-formed draft', () => {
    assert.deepEqual(validateWorkflowDraft(draft()), []);
  });

  it('refuses a draft with no nodes', () => {
    const problems = validateWorkflowDraft({ ...draft(), nodes: [] });
    assert.ok(problems.some((problem) => problem.includes('at least one node')));
  });

  it('refuses two nodes sharing an id', () => {
    const problems = validateWorkflowDraft({
      ...draft(),
      nodes: [node({ id: 'goal', kind: 'Goal', fromStepPosition: null }), node({ id: 'goal' })],
    });
    assert.ok(problems.some((problem) => problem.includes('share the id')));
  });

  it('refuses a node whose shape contradicts its kind', () => {
    // The locked rule enforced on the data, not trusted to the renderer.
    const problems = validateWorkflowDraft({
      ...draft(),
      nodes: [
        node({ id: 'goal', kind: 'Goal', fromStepPosition: null }),
        node({ kind: 'Ai', shape: 'rectangle' }),
      ],
    });
    assert.ok(
      problems.some((problem) => problem.includes('always drawn as "diamond"')),
      'an AI node drawn as a rectangle must be refused',
    );
  });

  it('refuses a draft with no Goal, or with two', () => {
    const none = validateWorkflowDraft({ ...draft(), nodes: [node()], goalNodeId: 'step-1' });
    assert.ok(none.some((problem) => problem.includes('exactly one Goal node')));

    const two = validateWorkflowDraft({
      ...draft(),
      nodes: [
        node({ id: 'goal', kind: 'Goal', fromStepPosition: null }),
        node({ id: 'goal-2', kind: 'Goal', fromStepPosition: null }),
      ],
    });
    assert.ok(two.some((problem) => problem.includes('exactly one Goal node')));
  });

  it('refuses a goalNodeId that does not name the Goal', () => {
    const problems = validateWorkflowDraft({ ...draft(), goalNodeId: 'step-1' });
    assert.ok(problems.some((problem) => problem.includes('does not name the Goal node')));
  });

  it('refuses a node with no label', () => {
    for (const field of ['label'] as const) {
      const problems = validateWorkflowDraft({
        ...draft(),
        nodes: [
          node({ id: 'goal', kind: 'Goal', fromStepPosition: null }),
          node({ [field]: '  ' } as Partial<AnalysisNode>),
        ],
      });
      assert.ok(problems.length > 0, `a node with no ${field} must be refused`);
    }
  });

  it('refuses an edge naming a node that is not in the draft', () => {
    const problems = validateWorkflowDraft({
      ...draft(),
      edges: [{ fromNodeId: 'goal', toNodeId: 'nowhere', kind: 'Sequential', condition: null }],
    });
    assert.ok(problems.some((problem) => problem.includes('not a node in this draft')));
  });

  it('refuses an edge pointing at itself', () => {
    const problems = validateWorkflowDraft({
      ...draft(),
      edges: [{ fromNodeId: 'goal', toNodeId: 'goal', kind: 'Sequential', condition: null }],
    });
    assert.ok(problems.some((problem) => problem.includes('points at itself')));
  });

  it('refuses a usage range that ends below where it starts', () => {
    const problems = validateWorkflowDraft({
      ...draft(),
      usage: { minTokens: 500, maxTokens: 100, aiNodeCount: 1, basis: 'x' },
    });
    assert.ok(problems.some((problem) => problem.includes('below where it starts')));
  });

  it('refuses a negative usage estimate', () => {
    const problems = validateWorkflowDraft({
      ...draft(),
      usage: { minTokens: -1, maxTokens: 100, aiNodeCount: 1, basis: 'x' },
    });
    assert.ok(problems.some((problem) => problem.includes('cannot be negative')));
  });

  it('demands that a usage estimate says what it came from', () => {
    // A number next to real money with no stated basis reads as a quote.
    const problems = validateWorkflowDraft({
      ...draft(),
      usage: { minTokens: 1, maxTokens: 2, aiNodeCount: 1, basis: '   ' },
    });
    assert.ok(problems.some((problem) => problem.includes('what it was derived from')));
  });

  it('demands a risk list and a gap list, even empty ones', () => {
    // A draft with no gap list is indistinguishable from one whose gaps were dropped.
    // The keys are omitted rather than set to `undefined`: `exactOptionalPropertyTypes` treats
    // those as different things, and omission is what a real malformed document would look like.
    const { risks: _risks, ...withoutRisks } = draft();
    assert.ok(validateWorkflowDraft(withoutRisks).some((problem) => problem.includes('risk list')));

    const { gaps: _gaps, ...withoutGaps } = draft();
    assert.ok(validateWorkflowDraft(withoutGaps).some((problem) => problem.includes('gap list')));
  });

  it('accepts a draft that records its own gaps', () => {
    // The normal case, not an error state: an analysis that hid its blind spots would look
    // complete and be wrong.
    const problems = validateWorkflowDraft({
      ...draft(),
      gaps: ['No approved Skill matches step 2.'],
      risks: [{ nodeId: 'step-1', severity: 'High', summary: 'No Skill behind this step.' }],
    });
    assert.deepEqual(problems, []);
  });
});

// ---------------------------------------------------------------------------
// Prompt 22 — the manager's edits
// ---------------------------------------------------------------------------

describe('edge kinds — the client’s reorder/reconnect vocabulary', () => {
  it('covers the four kinds the client named', () => {
    // "sequential/parallel", "IF/ELSE condition", "failure branch".
    assert.deepEqual([...WORKFLOW_EDGE_KINDS], ['Sequential', 'Parallel', 'Condition', 'Failure']);
  });

  it('labels every kind, so a diagram never shows an identifier', () => {
    for (const kind of WORKFLOW_EDGE_KINDS) {
      const label = WORKFLOW_EDGE_KIND_LABELS[kind];
      assert.ok(label !== undefined && label.trim() !== '', kind + ' has no label');
    }
  });

  it('refuses an edge kind it does not know', () => {
    const problems = validateWorkflowDraft(
      draft({
        edges: [
          { fromNodeId: 'goal', toNodeId: 'step-1', kind: 'Whenever' as never, condition: null },
        ],
      }),
    );
    assert.ok(
      problems.some((problem) => problem.includes('Whenever')),
      problems.join('; '),
    );
  });

  it('demands that an IF/ELSE edge says which outcome it is', () => {
    // A condition edge with no condition is a branch nobody can read: two arrows leave the same
    // node and nothing says when each one is taken.
    const problems = validateWorkflowDraft(
      draft({
        edges: [{ fromNodeId: 'goal', toNodeId: 'step-1', kind: 'Condition', condition: null }],
      }),
    );
    assert.ok(problems.length > 0, 'a condition edge with no condition was accepted');
  });

  it('accepts an IF/ELSE edge that states its condition', () => {
    assert.deepEqual(
      validateWorkflowDraft(
        draft({
          edges: [
            {
              fromNodeId: 'goal',
              toNodeId: 'step-1',
              kind: 'Condition',
              condition: 'A critical gap was found',
            },
          ],
        }),
      ),
      [],
    );
  });
});

describe('the Trigger node', () => {
  it('is drawn as a gate, like the other non-work nodes', () => {
    assert.equal(NODE_SHAPE_BY_KIND.Trigger, 'gate');
  });

  it('must say what event starts it', () => {
    const problems = validateWorkflowDraft(
      draft({
        goalNodeId: 'goal',
        nodes: [
          node({ id: 'goal', kind: 'Goal', label: 'GOAL · Ship it', fromStepPosition: null }),
          node({ id: 'trigger-1', kind: 'Trigger', label: 'On intake', triggerEvent: null }),
        ],
        edges: [{ fromNodeId: 'trigger-1', toNodeId: 'goal', kind: 'Sequential', condition: null }],
        usage: { minTokens: 0, maxTokens: 0, aiNodeCount: 0, basis: 'No AI steps.' },
      }),
    );
    assert.ok(problems.length > 0, 'a trigger with no event was accepted');
  });
});

describe('incompleteDodFields — what the Pre-Publish Summary counts', () => {
  it('reports nothing for a complete Definition of Done', () => {
    assert.deepEqual(incompleteDodFields(node().dod), []);
  });

  it('names every missing part when there is no Definition of Done at all', () => {
    assert.deepEqual(incompleteDodFields(null), [
      'expected output',
      'criteria',
      'evidence',
      'failure condition',
    ]);
  });

  it('treats whitespace as missing', () => {
    // A field holding a space is what a form leaves behind when someone tabs through it. Counting
    // it as filled would let an empty plan report itself ready.
    assert.deepEqual(incompleteDodFields({ ...node().dod, criteria: '   ' }), ['criteria']);
  });

  it('does not demand dependencies, tools or an approval', () => {
    // A step can legitimately need none of those. Only the four narrative parts are required, or
    // every plain step would report itself incomplete for ever.
    assert.deepEqual(
      incompleteDodFields({ ...node().dod, dependencies: [], tools: [], approval: null }),
      [],
    );
  });

  it('reports the parts in a stable order, so the screen does not reshuffle', () => {
    assert.deepEqual(
      incompleteDodFields({
        expectedOutput: '',
        criteria: '',
        evidence: '',
        dependencies: [],
        tools: [],
        approval: null,
        failureCondition: '',
      }),
      ['expected output', 'criteria', 'evidence', 'failure condition'],
    );
  });
});

describe('mayConvertNode — "Human ↔ AI conversion where allowed"', () => {
  it('always allows AI → Human', () => {
    // Taking work back from an agent is never the risky direction.
    assert.equal(
      mayConvertNode({ from: 'Ai', to: 'Human', hasApprovedSkill: false }).allowed,
      true,
    );
  });

  it('allows Human → AI when an approved Skill exists', () => {
    assert.equal(mayConvertNode({ from: 'Human', to: 'Ai', hasApprovedSkill: true }).allowed, true);
  });

  it('refuses Human → AI with no approved Skill, and says why', () => {
    const outcome = mayConvertNode({ from: 'Human', to: 'Ai', hasApprovedSkill: false });
    assert.equal(outcome.allowed, false);
    assert.match(outcome.reason, /Skill/);
  });

  it('refuses to convert the Goal in either direction', () => {
    assert.equal(
      mayConvertNode({ from: 'Goal', to: 'Human', hasApprovedSkill: true }).allowed,
      false,
    );
    assert.equal(
      mayConvertNode({ from: 'Human', to: 'Goal', hasApprovedSkill: true }).allowed,
      false,
    );
  });

  it('refuses to convert an approval, a condition or a trigger', () => {
    for (const kind of ['Approval', 'Condition', 'Trigger'] as const) {
      assert.equal(
        mayConvertNode({ from: kind, to: 'Ai', hasApprovedSkill: true }).allowed,
        false,
        kind + ' was convertible',
      );
      assert.equal(
        mayConvertNode({ from: 'Human', to: kind, hasApprovedSkill: true }).allowed,
        false,
        'a Human node could become ' + kind,
      );
    }
  });

  it('refuses a conversion to the kind the node already is', () => {
    assert.equal(mayConvertNode({ from: 'Ai', to: 'Ai', hasApprovedSkill: true }).allowed, false);
  });

  it('always gives a reason, whichever way it answers', () => {
    for (const from of ANALYSIS_NODE_KINDS) {
      for (const to of ANALYSIS_NODE_KINDS) {
        const outcome = mayConvertNode({ from, to, hasApprovedSkill: true });
        assert.ok(outcome.reason.trim() !== '', from + ' → ' + to + ' gave no reason');
      }
    }
  });
});

describe('upgradeWorkflowDraft — a version 1 draft is still readable', () => {
  /** What the Prompt 21 build stored: flat strings, no edge kinds, no Trigger. */
  const storedV1 = {
    schemaVersion: 1,
    goalNodeId: 'goal',
    nodes: [
      {
        id: 'goal',
        kind: 'Goal',
        label: 'GOAL · Ship the checklist',
        shape: 'goal',
        fromStepPosition: null,
        ownerUserId: null,
        ownerDesignation: null,
        skillVersionId: null,
        skillName: null,
        definitionOfDone: 'Checklists issued for every variant.',
        evidenceRequired: 'The issued checklists.',
        toolNeeds: [],
      },
      {
        id: 'step-1',
        kind: 'Ai',
        label: 'Draft the checklist',
        shape: 'diamond',
        fromStepPosition: 1,
        ownerUserId: null,
        ownerDesignation: null,
        skillVersionId: 'skill-v6',
        skillName: 'gspr-checklist',
        definitionOfDone: 'A drafted checklist per variant.',
        evidenceRequired: 'The draft files.',
        toolNeeds: ['DocumentWrite'],
      },
    ],
    edges: [{ fromNodeId: 'goal', toNodeId: 'step-1', condition: null }],
    usage: { minTokens: 100, maxTokens: 200, aiNodeCount: 1, basis: 'One AI step.' },
    risks: [],
    gaps: [],
  };

  it('lifts it to the current version', () => {
    const upgraded = upgradeWorkflowDraft(storedV1);
    assert.equal(upgraded?.schemaVersion, ANALYSIS_SCHEMA_VERSION);
  });

  it('moves the flat strings into the parts they correspond to', () => {
    const upgraded = upgradeWorkflowDraft(storedV1);
    const step = upgraded?.nodes.find((candidate) => candidate.id === 'step-1');
    assert.equal(step?.dod.expectedOutput, 'A drafted checklist per variant.');
    assert.equal(step?.dod.evidence, 'The draft files.');
    assert.deepEqual(step?.dod.tools, ['DocumentWrite']);
  });

  it('leaves the parts version 1 never recorded BLANK, rather than inventing them', () => {
    // The important half of the upgrade. Version 1 genuinely had no criteria and no failure
    // condition; filling them with plausible text would make the Pre-Publish Summary report a
    // plan as ready when a manager has never said when the step is done or when it has failed.
    const upgraded = upgradeWorkflowDraft(storedV1);
    const step = upgraded?.nodes.find((candidate) => candidate.id === 'step-1');
    assert.equal(step?.dod.criteria, '');
    assert.equal(step?.dod.failureCondition, '');
  });

  it('so the Pre-Publish Summary reports those nodes as incomplete', () => {
    const upgraded = upgradeWorkflowDraft(storedV1);
    const step = upgraded?.nodes.find((candidate) => candidate.id === 'step-1');
    assert.deepEqual(incompleteDodFields(step?.dod ?? null), ['criteria', 'failure condition']);
  });

  it('drops the flat version 1 fields, so the same fact is not stored twice', () => {
    const upgraded = upgradeWorkflowDraft(storedV1);
    const step = upgraded?.nodes.find((candidate) => candidate.id === 'step-1') as
      Record<string, unknown> | undefined;
    assert.equal(step?.['definitionOfDone'], undefined);
    assert.equal(step?.['evidenceRequired'], undefined);
    assert.equal(step?.['toolNeeds'], undefined);
  });

  it('gives every version 1 edge the plain sequential kind it meant', () => {
    const upgraded = upgradeWorkflowDraft(storedV1);
    assert.deepEqual(
      upgraded?.edges.map((edge) => edge.kind),
      ['Sequential'],
    );
  });

  it('normalises approvalKind and triggerEvent to null rather than leaving them undefined', () => {
    // The declared type is `string | null`. An upgraded node holding `undefined` would be a third
    // state nothing downstream is written to expect.
    const upgraded = upgradeWorkflowDraft(storedV1);
    for (const candidate of upgraded?.nodes ?? []) {
      assert.equal(candidate.approvalKind, null);
      assert.equal(candidate.triggerEvent, null);
    }
  });

  it('produces a draft that passes current validation', () => {
    // The whole point of the readable-versions list: an old draft opens, it does not error.
    const upgraded = upgradeWorkflowDraft(storedV1);
    assert.notEqual(upgraded, null);
    assert.deepEqual(validateWorkflowDraft(upgraded as WorkflowDraft), []);
  });

  it('returns the draft unchanged when it is already current', () => {
    const current = draft();
    assert.equal(upgradeWorkflowDraft(current), current);
  });

  it('refuses a version it cannot read, rather than guessing', () => {
    assert.equal(upgradeWorkflowDraft({ ...storedV1, schemaVersion: 99 }), null);
    assert.equal(upgradeWorkflowDraft({ ...storedV1, schemaVersion: 0 }), null);
  });

  it('refuses a draft with no schema version at all', () => {
    const { schemaVersion: _dropped, ...noVersion } = storedV1;
    assert.equal(upgradeWorkflowDraft(noVersion), null);
  });

  it('refuses something that is not a draft', () => {
    assert.equal(upgradeWorkflowDraft(null), null);
    assert.equal(upgradeWorkflowDraft('a draft'), null);
    assert.equal(upgradeWorkflowDraft(7), null);
  });
});

describe('the Definition of Done is validated as a structure', () => {
  it('refuses a node with no Definition of Done', () => {
    const problems = validateWorkflowDraft(
      draft({
        nodes: [
          node({ id: 'goal', kind: 'Goal', label: 'GOAL · Ship it', fromStepPosition: null }),
          { ...node(), dod: undefined as never },
        ],
      }),
    );
    assert.ok(problems.length > 0, 'a node with no Definition of Done was accepted');
  });

  it('refuses a dependency naming a node that is not in the draft', () => {
    const problems = validateWorkflowDraft(
      draft({
        nodes: [
          node({ id: 'goal', kind: 'Goal', label: 'GOAL · Ship it', fromStepPosition: null }),
          node({ dod: { ...node().dod, dependencies: ['step-99'] } }),
        ],
      }),
    );
    assert.ok(
      problems.some((problem) => problem.includes('step-99')),
      problems.join('; '),
    );
  });

  it('refuses a node that depends on itself', () => {
    const problems = validateWorkflowDraft(
      draft({
        nodes: [
          node({ id: 'goal', kind: 'Goal', label: 'GOAL · Ship it', fromStepPosition: null }),
          node({ dod: { ...node().dod, dependencies: ['step-1'] } }),
        ],
      }),
    );
    assert.ok(problems.length > 0, 'a self-dependency was accepted');
  });
});
