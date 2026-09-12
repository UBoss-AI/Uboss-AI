import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AGENT_RUN_TYPE_LABELS,
  AGENT_RUN_TYPES,
  AGENT_MEMORY_MODE_LABELS,
  AGENT_MEMORY_MODE_RULES,
  AGENT_MEMORY_MODES,
  ALLOWED_ENGINE_AGENT_TRANSITIONS,
  DEFAULT_AGENT_MEMORY_MODE,
  emptyEngineAgentHealth,
  ENGINE_AGENT_ACTION_LABELS,
  ENGINE_AGENT_ACTIONS,
  engineAgentActionsFor,
  memoryModePersistsBeyondRun,
  versionActivationNeedsApproval,
  behaviourContinuesPastBadData,
  emptyAgentExecutionSetup,
  ENGINE_AGENT_STATUS_LABELS,
  ENGINE_AGENT_STATUS_TONES,
  ENGINE_AGENT_STATUSES,
  FORM3_ACTION_COLUMNS,
  FORM3_JOB_LEVEL_FIELDS,
  mayMoveEngineAgent,
  MISSING_DATA_BEHAVIOUR_LABELS,
  MISSING_DATA_BEHAVIOURS,
  missingSetupFields,
  runTypeNeedsSchedule,
  setupIsComplete,
  type AgentExecutionSetup,
} from './agents.js';

/** A setup with nothing left to ask. The starting point for the zero-question tests. */
function completeSetup(overrides: Partial<AgentExecutionSetup> = {}): AgentExecutionSetup {
  return {
    runType: 'Scheduled',
    triggerOrFrequency: 'Monday 10:30',
    inputConnectionId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    whereWorkHappens: 'UBoss',
    outputDestination: 'SPM — Spain Tenders board',
    missingDataBehaviour: 'RouteForApproval',
    ...overrides,
  };
}

describe('the vocabularies come from the source document', () => {
  it('has the client’s four run types, in the client’s order', () => {
    assert.deepEqual([...AGENT_RUN_TYPES], ['RunOnce', 'Manual', 'Scheduled', 'EventBased']);
  });

  it('has the client’s six missing-data behaviours', () => {
    // "Stop, skip, ask user, retry, alert, or route for approval according to policy."
    assert.deepEqual(
      [...MISSING_DATA_BEHAVIOURS],
      ['Stop', 'Skip', 'AskUser', 'Retry', 'Alert', 'RouteForApproval'],
    );
  });

  it('has the client’s seven Engine Agent statuses', () => {
    assert.deepEqual(
      [...ENGINE_AGENT_STATUSES],
      ['DraftSetup', 'Ready', 'Active', 'Paused', 'NeedsInput', 'Error', 'Archived'],
    );
  });

  it('labels every value, so no screen can show an identifier', () => {
    for (const runType of AGENT_RUN_TYPES) {
      assert.ok(AGENT_RUN_TYPE_LABELS[runType]?.trim(), `${runType} has no label`);
    }
    for (const behaviour of MISSING_DATA_BEHAVIOURS) {
      assert.ok(MISSING_DATA_BEHAVIOUR_LABELS[behaviour]?.trim(), `${behaviour} has no label`);
    }
    for (const status of ENGINE_AGENT_STATUSES) {
      assert.ok(ENGINE_AGENT_STATUS_LABELS[status]?.trim(), `${status} has no label`);
      assert.ok(ENGINE_AGENT_STATUS_TONES[status]?.trim(), `${status} has no tone`);
    }
  });
});

describe('Form 3 is the canonical job method, transcribed', () => {
  it('has the document’s eight job-level field groups, in order', () => {
    assert.deepEqual(
      FORM3_JOB_LEVEL_FIELDS.map((field) => field.label),
      [
        'Objective Name / Department',
        'Job ID / Name',
        'Job Owner / Current Person / Role',
        'Trigger / Frequency',
        'High-Level Work',
        'Job Start Requirement',
        'Job Completion Evidence',
        'Normal Completion Time / Time Unit',
      ],
    );
  });

  it('marks exactly the four groups the document asterisks as required', () => {
    assert.deepEqual(
      FORM3_JOB_LEVEL_FIELDS.filter((field) => field.required).map((field) => field.key),
      ['jobIdName', 'jobOwnerCurrentPersonRole', 'triggerFrequency', 'highLevelWork'],
    );
  });

  it('has the document’s seventeen action columns', () => {
    assert.equal(FORM3_ACTION_COLUMNS.length, 17);
    assert.equal(FORM3_ACTION_COLUMNS[0], 'Step');
    assert.equal(FORM3_ACTION_COLUMNS[FORM3_ACTION_COLUMNS.length - 1], 'Time');
  });

  it('keeps the WHERE columns distinct, because they mean different things', () => {
    // "WHERE — Input Is Found" and "WHERE — Work Is Performed" are two separate facts, and
    // collapsing them would lose where a file came from or where the work actually ran.
    assert.ok(FORM3_ACTION_COLUMNS.includes('WHERE — Input Is Found'));
    assert.ok(FORM3_ACTION_COLUMNS.includes('WHERE — Work Is Performed'));
  });

  it('has no duplicate column headings', () => {
    assert.equal(new Set(FORM3_ACTION_COLUMNS).size, FORM3_ACTION_COLUMNS.length);
  });
});

describe('runTypeNeedsSchedule', () => {
  it('demands a schedule only where one is meaningful', () => {
    assert.equal(runTypeNeedsSchedule('Scheduled'), true);
    assert.equal(runTypeNeedsSchedule('EventBased'), true);
  });

  it('does not ask a manual or run-once agent when it runs', () => {
    // Asking is the unnecessary question the zero-question rule exists to prevent: a person
    // starts a manual agent, so "when?" is already answered by them pressing the button.
    assert.equal(runTypeNeedsSchedule('Manual'), false);
    assert.equal(runTypeNeedsSchedule('RunOnce'), false);
  });
});

describe('missingSetupFields — the ZERO-QUESTION RULE', () => {
  it('asks nothing when everything is already known', () => {
    // The client's requirement, stated exactly: show Ready to Test / Activate and ask nothing.
    assert.deepEqual(missingSetupFields(completeSetup(), true), []);
    assert.equal(setupIsComplete(completeSetup(), true), true);
  });

  it('asks every question for a brand-new builder', () => {
    const missing = missingSetupFields(emptyAgentExecutionSetup(), true);
    assert.deepEqual(
      missing.map((entry) => entry.field),
      [
        'runType',
        'inputConnectionId',
        'whereWorkHappens',
        'outputDestination',
        'missingDataBehaviour',
      ],
    );
  });

  it('does not ask for a trigger until the run type is known', () => {
    // Asking "when does it run?" before knowing whether it runs on a schedule at all produces a
    // question the person cannot sensibly answer.
    const missing = missingSetupFields(emptyAgentExecutionSetup(), true);
    assert.equal(
      missing.some((entry) => entry.field === 'triggerOrFrequency'),
      false,
    );
  });

  it('asks for a trigger once the run type needs one', () => {
    const missing = missingSetupFields(
      completeSetup({ runType: 'Scheduled', triggerOrFrequency: null }),
      true,
    );
    assert.deepEqual(
      missing.map((entry) => entry.field),
      ['triggerOrFrequency'],
    );
  });

  it('never asks a manual agent for a trigger, even with none recorded', () => {
    assert.deepEqual(
      missingSetupFields(completeSetup({ runType: 'Manual', triggerOrFrequency: null }), true),
      [],
    );
  });

  it('does not ask for a connection when the work needs no tools', () => {
    // A step whose Definition of Done lists no tool categories reads and writes nothing outside
    // UBoss. There is nothing to connect, so there is nothing to ask.
    assert.deepEqual(missingSetupFields(completeSetup({ inputConnectionId: null }), false), []);
  });

  it('does ask for a connection when the work does need tools', () => {
    const missing = missingSetupFields(completeSetup({ inputConnectionId: null }), true);
    assert.deepEqual(
      missing.map((entry) => entry.field),
      ['inputConnectionId'],
    );
  });

  it('treats whitespace as unanswered', () => {
    // What a form leaves behind when somebody tabs through it. Counting it as an answer would let
    // an unconfigured agent report itself ready to activate.
    for (const field of ['triggerOrFrequency', 'whereWorkHappens', 'outputDestination'] as const) {
      const missing = missingSetupFields(completeSetup({ [field]: '   ' }), true);
      assert.deepEqual(
        missing.map((entry) => entry.field),
        [field],
        `${field} accepted whitespace`,
      );
    }
  });

  it('never assumes what to do about bad data', () => {
    // The same missing field is a stop in a regulatory job and a skip in a reporting one. A
    // default here would be choosing on the company's behalf.
    const missing = missingSetupFields(completeSetup({ missingDataBehaviour: null }), true);
    assert.deepEqual(
      missing.map((entry) => entry.field),
      ['missingDataBehaviour'],
    );
  });

  it('gives every question a label and a reason', () => {
    for (const entry of missingSetupFields(emptyAgentExecutionSetup(), true)) {
      assert.ok(entry.label.trim() !== '', `${entry.field} has no label`);
      assert.ok(entry.why.trim() !== '', `${entry.field} does not say why it is being asked`);
    }
  });

  it('reports questions in a stable order, so the screen does not reshuffle', () => {
    const first = missingSetupFields(emptyAgentExecutionSetup(), true).map((entry) => entry.field);
    const second = missingSetupFields(emptyAgentExecutionSetup(), true).map((entry) => entry.field);
    assert.deepEqual(first, second);
  });

  it('starts a new builder with nothing pre-answered', () => {
    const setup = emptyAgentExecutionSetup();
    assert.deepEqual(Object.values(setup), [null, null, null, null, null, null]);
  });
});

describe('behaviourContinuesPastBadData', () => {
  it('flags the two behaviours that carry on past input known to be wrong', () => {
    assert.equal(behaviourContinuesPastBadData('Skip'), true);
    assert.equal(behaviourContinuesPastBadData('Alert'), true);
  });

  it('does not flag the behaviours that halt or hand over', () => {
    for (const behaviour of ['Stop', 'AskUser', 'Retry', 'RouteForApproval'] as const) {
      assert.equal(behaviourContinuesPastBadData(behaviour), false, behaviour);
    }
  });
});

describe('the Engine Agent lifecycle', () => {
  it('walks a new agent from draft setup to active', () => {
    assert.equal(mayMoveEngineAgent('DraftSetup', 'Ready'), true);
    assert.equal(mayMoveEngineAgent('Ready', 'Active'), true);
  });

  it('refuses to activate an agent that was never made ready', () => {
    // Activation is what puts an agent in front of real work. Skipping Ready would skip the
    // readiness check that Ready represents.
    assert.equal(mayMoveEngineAgent('DraftSetup', 'Active'), false);
  });

  it('never revives an archived agent', () => {
    // Reviving one resurrects an identity the company retired, with its history attached. A new
    // agent is the honest answer.
    assert.deepEqual([...ALLOWED_ENGINE_AGENT_TRANSITIONS.Archived], []);
    for (const status of ENGINE_AGENT_STATUSES) {
      assert.equal(mayMoveEngineAgent('Archived', status), false, `Archived → ${status}`);
    }
  });

  it('lets every live status be archived', () => {
    for (const status of ENGINE_AGENT_STATUSES) {
      if (status === 'Archived') continue;
      assert.equal(mayMoveEngineAgent(status, 'Archived'), true, `${status} cannot be archived`);
    }
  });

  it('has a transition list for every status, and names only real statuses', () => {
    for (const status of ENGINE_AGENT_STATUSES) {
      const next = ALLOWED_ENGINE_AGENT_TRANSITIONS[status];
      assert.ok(next !== undefined, `${status} has no transition list`);
      for (const target of next) {
        assert.ok(ENGINE_AGENT_STATUSES.includes(target), `${status} → unknown ${target}`);
      }
    }
  });

  it('never lets a status move to itself', () => {
    for (const status of ENGINE_AGENT_STATUSES) {
      assert.equal(mayMoveEngineAgent(status, status), false, `${status} → itself`);
    }
  });

  it('lets a paused or failing agent come back', () => {
    // An operational hiccup must not be terminal, or the lifecycle rule breaks: the company would
    // have to create a second Engine Agent for work the first one already owns.
    assert.equal(mayMoveEngineAgent('Paused', 'Active'), true);
    assert.equal(mayMoveEngineAgent('Error', 'Active'), true);
    assert.equal(mayMoveEngineAgent('NeedsInput', 'Active'), true);
  });
});

// ---------------------------------------------------------------------------
// Prompt 25 — the registry, memory mode and versioning
// ---------------------------------------------------------------------------

describe('memory modes come from the Technical Architecture', () => {
  it('has the document’s four modes, in its order', () => {
    assert.deepEqual(
      [...AGENT_MEMORY_MODES],
      ['CurrentRunOnly', 'ObjectiveMemory', 'AgentMemory', 'ApprovedLongTermMemory'],
    );
  });

  it('carries the document’s technical rule for each, not just a label', () => {
    // Shown wherever a mode is chosen, so nobody picks one without seeing what it commits the
    // company to.
    for (const mode of AGENT_MEMORY_MODES) {
      assert.ok(AGENT_MEMORY_MODE_LABELS[mode]?.trim(), `${mode} has no label`);
      assert.ok(AGENT_MEMORY_MODE_RULES[mode]?.trim(), `${mode} has no technical rule`);
    }
  });

  it('defaults to the only mode that persists nothing', () => {
    // Prompt 33 enforces retention, visibility, deletion and sharing. Until it exists, an agent
    // must not be able to keep anything — so the default cannot leak what nobody governed yet.
    assert.equal(DEFAULT_AGENT_MEMORY_MODE, 'CurrentRunOnly');
    assert.equal(memoryModePersistsBeyondRun(DEFAULT_AGENT_MEMORY_MODE), false);
  });

  it('knows which modes keep something after the run', () => {
    assert.equal(memoryModePersistsBeyondRun('CurrentRunOnly'), false);
    for (const mode of ['ObjectiveMemory', 'AgentMemory', 'ApprovedLongTermMemory'] as const) {
      assert.equal(memoryModePersistsBeyondRun(mode), true, mode);
    }
  });
});

describe('the registry action set', () => {
  it('is the client’s seven, in the document’s order', () => {
    assert.deepEqual(
      [...ENGINE_AGENT_ACTIONS],
      ['View', 'RunNow', 'Pause', 'Resume', 'OpenRuns', 'CreateNewVersion', 'Archive'],
    );
  });

  it('labels every action', () => {
    for (const action of ENGINE_AGENT_ACTIONS) {
      assert.ok(ENGINE_AGENT_ACTION_LABELS[action]?.trim(), `${action} has no label`);
    }
  });

  it('offers Run now only on an agent that is actually in service', () => {
    // A paused agent that could still be triggered by hand would not be paused.
    assert.ok(engineAgentActionsFor('Active').includes('RunNow'));
    for (const status of [
      'DraftSetup',
      'Ready',
      'Paused',
      'NeedsInput',
      'Error',
      'Archived',
    ] as const) {
      assert.ok(!engineAgentActionsFor(status).includes('RunNow'), `${status} offered Run now`);
    }
  });

  it('offers Pause exactly where pausing is a legal move', () => {
    // Derived from the lifecycle rather than listed twice, so a screen cannot offer a button the
    // service will refuse.
    for (const status of ENGINE_AGENT_STATUSES) {
      assert.equal(
        engineAgentActionsFor(status).includes('Pause'),
        mayMoveEngineAgent(status, 'Paused'),
        `${status} disagrees about Pause`,
      );
    }
  });

  it('offers Resume on a paused or failing agent, and not on an active one', () => {
    for (const status of ['Paused', 'NeedsInput', 'Error'] as const) {
      assert.ok(engineAgentActionsFor(status).includes('Resume'), status);
    }
    assert.ok(!engineAgentActionsFor('Active').includes('Resume'));
  });

  it('never offers anything but View and Open runs on an archived agent', () => {
    // Its history is the reason it is archived rather than deleted, so reading stays available —
    // but a version edit must not be a back door around a terminal status.
    assert.deepEqual(engineAgentActionsFor('Archived'), ['View', 'OpenRuns']);
  });

  it('always offers View and Open runs', () => {
    for (const status of ENGINE_AGENT_STATUSES) {
      const actions = engineAgentActionsFor(status);
      assert.ok(actions.includes('View'), status);
      assert.ok(actions.includes('OpenRuns'), status);
    }
  });

  it('names only actions in the vocabulary', () => {
    for (const status of ENGINE_AGENT_STATUSES) {
      for (const action of engineAgentActionsFor(status)) {
        assert.ok(
          (ENGINE_AGENT_ACTIONS as readonly string[]).includes(action),
          `${status} offered unknown ${action}`,
        );
      }
    }
  });
});

describe('health reports absence rather than inventing a figure', () => {
  it('has a null success rate until something has run', () => {
    // A 0% success rate on an agent that has never run reads as failure. Null reads as "no data",
    // which is the truth.
    const health = emptyEngineAgentHealth('No runs yet.');
    assert.equal(health.hasRunData, false);
    assert.equal(health.successRate, null);
    assert.equal(health.totalRuns, 0);
    assert.equal(health.lastRunAt, null);
    assert.equal(health.nextRunAt, null);
    assert.ok(health.note.trim() !== '');
  });
});

describe('versionActivationNeedsApproval — the prompt’s "where required"', () => {
  const base = { addedToolCategories: [], memoryModeWidens: false, affectedObjectiveCount: 1 };

  it('needs no approval for a change that widens nothing', () => {
    const outcome = versionActivationNeedsApproval(base);
    assert.equal(outcome.required, false);
    assert.deepEqual(outcome.reasons, []);
  });

  it('needs approval when the agent gains a tool category it cannot use today', () => {
    const outcome = versionActivationNeedsApproval({ ...base, addedToolCategories: ['Delete'] });
    assert.equal(outcome.required, true);
    assert.match(outcome.reasons.join(' '), /Delete/);
  });

  it('needs approval when memory starts outliving the run', () => {
    const outcome = versionActivationNeedsApproval({ ...base, memoryModeWidens: true });
    assert.equal(outcome.required, true);
    assert.match(outcome.reasons.join(' '), /beyond the run/);
  });

  it('needs approval when more than one objective relies on the agent', () => {
    // Changing an agent only its own objective uses is a local decision. Changing one several
    // rely on is not.
    const outcome = versionActivationNeedsApproval({ ...base, affectedObjectiveCount: 3 });
    assert.equal(outcome.required, true);
    assert.match(outcome.reasons.join(' '), /3 objectives/);
  });

  it('does not need approval for a narrowing change', () => {
    // Requiring permission to reduce an agent's reach would discourage exactly the edits a
    // company should be free to make immediately.
    const outcome = versionActivationNeedsApproval({
      addedToolCategories: [],
      memoryModeWidens: false,
      affectedObjectiveCount: 1,
    });
    assert.equal(outcome.required, false);
  });

  it('gives a reason for every trigger it fires', () => {
    const outcome = versionActivationNeedsApproval({
      addedToolCategories: ['FinancialChange'],
      memoryModeWidens: true,
      affectedObjectiveCount: 4,
    });
    assert.equal(outcome.required, true);
    assert.equal(outcome.reasons.length, 3);
    for (const reason of outcome.reasons) assert.ok(reason.trim() !== '');
  });

  it('needs no approval for an agent nothing relies on yet', () => {
    const outcome = versionActivationNeedsApproval({ ...base, affectedObjectiveCount: 0 });
    assert.equal(outcome.required, false);
  });
});
