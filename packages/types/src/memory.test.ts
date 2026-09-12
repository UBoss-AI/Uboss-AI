import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT_MEMORY_MODES } from './agents.js';
import {
  classificationAllowed,
  DATA_CLASSIFICATIONS,
  DEFAULT_DATA_CLASSIFICATION,
  isSensitiveClassification,
  strictestClassification,
} from './classification.js';
import {
  decideMemoryWrite,
  DEFAULT_MEMORY_POLICIES,
  everyModeHasACoherentDefault,
  expiredMemoryIds,
  MAX_MEMORY_RETENTION_DAYS,
  MEMORY_MODE_MAX_VISIBILITY,
  memoryPolicyProblems,
  memoryReadable,
  offboardingOutcome,
  visibilityWithinMode,
  type MemoryPolicy,
  type MemoryRecordScope,
} from './memory.js';

const now = new Date('2026-09-11T12:00:00.000Z');

const policy = (overrides: Partial<MemoryPolicy> = {}): MemoryPolicy => ({
  ...DEFAULT_MEMORY_POLICIES.AgentMemory,
  ...overrides,
});

const record = (overrides: Partial<MemoryRecordScope> = {}): MemoryRecordScope => ({
  mode: 'AgentMemory',
  visibility: 'SameAgent',
  runId: 'run-1',
  objectiveId: 'obj-1',
  engineAgentId: 'agent-1',
  ownerUserId: 'user-1',
  expiresAt: null,
  deletedAt: null,
  ...overrides,
});

describe('data classification', () => {
  it('orders the four classes by increasing sensitivity', () => {
    assert.deepEqual(
      [...DATA_CLASSIFICATIONS],
      ['Public', 'Internal', 'Confidential', 'Restricted'],
    );
  });

  it('defaults to Internal rather than Public', () => {
    // An unlabelled document is one nobody thought about. Treating it as safe to leave the
    // company is the wrong way to be wrong.
    assert.equal(DEFAULT_DATA_CLASSIFICATION, 'Internal');
  });

  it('compares against a ceiling, not a floor', () => {
    assert.equal(classificationAllowed('Internal', 'Confidential'), true);
    assert.equal(classificationAllowed('Confidential', 'Confidential'), true);
    assert.equal(classificationAllowed('Restricted', 'Confidential'), false);
  });

  it('treats Confidential and above as sensitive', () => {
    assert.equal(isSensitiveClassification('Public'), false);
    assert.equal(isSensitiveClassification('Internal'), false);
    assert.equal(isSensitiveClassification('Confidential'), true);
    assert.equal(isSensitiveClassification('Restricted'), true);
  });

  it('never weakens when two policies apply', () => {
    assert.equal(strictestClassification('Public', 'Restricted'), 'Restricted');
    assert.equal(strictestClassification('Confidential', 'Internal'), 'Confidential');
  });
});

describe('memory policy defaults', () => {
  it('has a policy for every mode', () => {
    for (const mode of AGENT_MEMORY_MODES) {
      assert.ok(DEFAULT_MEMORY_POLICIES[mode] !== undefined, mode);
      assert.equal(DEFAULT_MEMORY_POLICIES[mode].mode, mode);
    }
  });

  it('has coherent defaults, by its own validator', () => {
    // A default the product would refuse if a company entered it is not a default.
    assert.equal(everyModeHasACoherentDefault(), true);
  });

  it('expires everything but approved long-term memory', () => {
    assert.equal(DEFAULT_MEMORY_POLICIES.CurrentRunOnly.retentionDays, 1);
    assert.equal(DEFAULT_MEMORY_POLICIES.ObjectiveMemory.retentionDays, 90);
    assert.equal(DEFAULT_MEMORY_POLICIES.AgentMemory.retentionDays, 180);
    assert.equal(DEFAULT_MEMORY_POLICIES.ApprovedLongTermMemory.retentionDays, null);
  });

  it('requires an approval for the mode whose name says approved', () => {
    assert.equal(DEFAULT_MEMORY_POLICIES.ApprovedLongTermMemory.requiresApproval, true);
    assert.equal(DEFAULT_MEMORY_POLICIES.AgentMemory.requiresApproval, false);
  });

  it('persists no Restricted data by default, in any mode', () => {
    // §19 makes classification the control over persistence, and the strictest class is where a
    // company should have to decide deliberately rather than inherit.
    for (const mode of AGENT_MEMORY_MODES) {
      assert.notEqual(DEFAULT_MEMORY_POLICIES[mode].maxClassification, 'Restricted', mode);
    }
  });

  it('lets only the ephemeral and approved modes hold confidential data', () => {
    assert.equal(DEFAULT_MEMORY_POLICIES.CurrentRunOnly.maxClassification, 'Confidential');
    assert.equal(DEFAULT_MEMORY_POLICIES.ApprovedLongTermMemory.maxClassification, 'Confidential');
    assert.equal(DEFAULT_MEMORY_POLICIES.ObjectiveMemory.maxClassification, 'Internal');
    assert.equal(DEFAULT_MEMORY_POLICIES.AgentMemory.maxClassification, 'Internal');
  });

  it('allows cross-user reading only in the company-wide mode', () => {
    for (const mode of AGENT_MEMORY_MODES) {
      if (mode === 'ApprovedLongTermMemory') continue;
      assert.equal(DEFAULT_MEMORY_POLICIES[mode].allowCrossUser, false, mode);
    }
  });
});

describe('policy validation', () => {
  it('refuses a visibility wider than the mode permits', () => {
    // §19 sets Objective Memory's rule as "visible only to same Objective scope". A policy field
    // that could contradict the approved document would make the document advisory.
    const problems = memoryPolicyProblems(
      policy({ mode: 'ObjectiveMemory', visibility: 'CompanyWide', allowCrossUser: false }),
    );
    assert.ok(problems.some((problem) => /widest permitted visibility/.test(problem)));
  });

  it('accepts a narrower visibility than the mode permits', () => {
    assert.deepEqual(
      memoryPolicyProblems(
        policy({ mode: 'AgentMemory', visibility: 'SameObjective', allowCrossObjective: false }),
      ),
      [],
    );
  });

  it('records the ceiling for every mode', () => {
    assert.equal(MEMORY_MODE_MAX_VISIBILITY.CurrentRunOnly, 'SameRun');
    assert.equal(MEMORY_MODE_MAX_VISIBILITY.ObjectiveMemory, 'SameObjective');
    assert.equal(MEMORY_MODE_MAX_VISIBILITY.AgentMemory, 'SameAgent');
    assert.equal(MEMORY_MODE_MAX_VISIBILITY.ApprovedLongTermMemory, 'CompanyWide');
    assert.equal(visibilityWithinMode('CurrentRunOnly', 'SameObjective'), false);
  });

  it('refuses an unexpiring policy on any mode but approved long-term', () => {
    const problems = memoryPolicyProblems(policy({ retentionDays: null }));
    assert.ok(problems.some((problem) => /must expire/.test(problem)));
  });

  it('refuses a retention longer than ten years', () => {
    const problems = memoryPolicyProblems(policy({ retentionDays: MAX_MEMORY_RETENTION_DAYS + 1 }));
    assert.ok(problems.some((problem) => /cannot exceed/.test(problem)));
  });

  it('refuses a fractional or zero retention', () => {
    assert.ok(memoryPolicyProblems(policy({ retentionDays: 0 })).length > 0);
    assert.ok(memoryPolicyProblems(policy({ retentionDays: 1.5 })).length > 0);
  });

  it('refuses turning ephemeral memory into something else under the same name', () => {
    const problems = memoryPolicyProblems(
      policy({ mode: 'CurrentRunOnly', visibility: 'SameRun', retentionDays: 90 }),
    );
    assert.ok(problems.some((problem) => /a different mode under the same name/.test(problem)));
  });

  it('refuses approved long-term memory that needs no approval', () => {
    const problems = memoryPolicyProblems(
      policy({
        ...DEFAULT_MEMORY_POLICIES.ApprovedLongTermMemory,
        requiresApproval: false,
      }),
    );
    assert.ok(problems.some((problem) => /requires an approval/.test(problem)));
  });

  it('refuses cross-user reading on a narrowly scoped record', () => {
    // This is §19's "never unrestricted cross-user memory" expressed as a policy check.
    const problems = memoryPolicyProblems(
      policy({ mode: 'AgentMemory', visibility: 'SameAgent', allowCrossUser: true }),
    );
    assert.ok(problems.some((problem) => /Cross-user reading needs company-wide/.test(problem)));
  });

  it('refuses a contradiction between Objective visibility and cross-Objective reading', () => {
    const problems = memoryPolicyProblems(
      policy({ mode: 'ObjectiveMemory', visibility: 'SameObjective', allowCrossObjective: true }),
    );
    assert.ok(
      problems.some((problem) => /cannot also be readable across Objectives/.test(problem)),
    );
  });

  it('reports every problem at once', () => {
    // So a settings screen does not make somebody fix them one at a time.
    const problems = memoryPolicyProblems(
      policy({ mode: 'ObjectiveMemory', visibility: 'CompanyWide', retentionDays: 0 }),
    );
    assert.ok(problems.length >= 2);
  });
});

describe('deciding whether to remember', () => {
  const request = {
    mode: 'AgentMemory' as const,
    classification: 'Internal' as const,
    runId: 'run-1',
    objectiveId: 'obj-1',
    engineAgentId: 'agent-1',
    ownerUserId: 'user-1',
    approvalRequestId: null,
  };

  it('persists an ordinary record and dates its expiry from the policy', () => {
    const decision = decideMemoryWrite(request, DEFAULT_MEMORY_POLICIES.AgentMemory, now);
    assert.equal(decision.persist, true);
    if (!decision.persist) return;
    assert.equal(decision.expiresAt?.toISOString(), '2027-03-10T12:00:00.000Z');
    assert.equal(decision.visibility, 'SameAgent');
  });

  it('refuses data too sensitive for the mode, and says the run may still use it', () => {
    // §19: classification controls whether a record can be *persisted*. It does not stop the run
    // working with the data, and the message has to make that difference clear.
    const decision = decideMemoryWrite(
      { ...request, classification: 'Restricted' },
      DEFAULT_MEMORY_POLICIES.AgentMemory,
      now,
    );
    assert.equal(decision.persist, false);
    if (decision.persist) return;
    assert.match(decision.reason, /refuses to \*remember\* it/);
  });

  it('refuses Objective memory with no Objective', () => {
    const decision = decideMemoryWrite(
      { ...request, mode: 'ObjectiveMemory', objectiveId: null },
      DEFAULT_MEMORY_POLICIES.ObjectiveMemory,
      now,
    );
    assert.equal(decision.persist, false);
  });

  it('refuses approved long-term memory with no approval', () => {
    const decision = decideMemoryWrite(
      { ...request, mode: 'ApprovedLongTermMemory' },
      DEFAULT_MEMORY_POLICIES.ApprovedLongTermMemory,
      now,
    );
    assert.equal(decision.persist, false);
    if (decision.persist) return;
    assert.match(decision.reason, /needs an approval/);
  });

  it('persists approved long-term memory with a verified approval, and never expires it', () => {
    const decision = decideMemoryWrite(
      { ...request, mode: 'ApprovedLongTermMemory', approvalRequestId: 'approval-1' },
      DEFAULT_MEMORY_POLICIES.ApprovedLongTermMemory,
      now,
    );
    assert.equal(decision.persist, true);
    if (!decision.persist) return;
    assert.equal(decision.expiresAt, null);
  });

  it('refuses a policy that does not govern the requested mode', () => {
    // A mismatch here would apply Agent Memory's ceilings to a long-term record.
    const decision = decideMemoryWrite(
      { ...request, mode: 'ApprovedLongTermMemory', approvalRequestId: 'approval-1' },
      DEFAULT_MEMORY_POLICIES.AgentMemory,
      now,
    );
    assert.equal(decision.persist, false);
  });

  it('keeps the ephemeral mode to a single day', () => {
    const decision = decideMemoryWrite(
      { ...request, mode: 'CurrentRunOnly' },
      DEFAULT_MEMORY_POLICIES.CurrentRunOnly,
      now,
    );
    assert.equal(decision.persist, true);
    if (!decision.persist) return;
    assert.equal(decision.expiresAt?.toISOString(), '2026-09-12T12:00:00.000Z');
  });
});

describe('reading it back', () => {
  const context = {
    runId: 'run-1',
    objectiveId: 'obj-1',
    engineAgentId: 'agent-1',
    onBehalfOfUserId: 'user-1',
    now,
  };

  it('confines run-scoped memory to its own run', () => {
    const scoped = record({ visibility: 'SameRun', mode: 'CurrentRunOnly' });
    assert.equal(memoryReadable(scoped, context, DEFAULT_MEMORY_POLICIES.CurrentRunOnly), true);
    assert.equal(
      memoryReadable(
        scoped,
        { ...context, runId: 'run-2' },
        DEFAULT_MEMORY_POLICIES.CurrentRunOnly,
      ),
      false,
    );
  });

  it('confines Objective memory to its own Objective', () => {
    const scoped = record({ visibility: 'SameObjective', mode: 'ObjectiveMemory' });
    assert.equal(memoryReadable(scoped, context, DEFAULT_MEMORY_POLICIES.ObjectiveMemory), true);
    assert.equal(
      memoryReadable(
        scoped,
        { ...context, objectiveId: 'obj-2' },
        DEFAULT_MEMORY_POLICIES.ObjectiveMemory,
      ),
      false,
    );
  });

  it('never treats two nulls as the same Objective', () => {
    // Treating null as a matching value is how a scoped read silently becomes a company-wide one.
    const scoped = record({ visibility: 'SameObjective', objectiveId: null });
    assert.equal(
      memoryReadable(
        scoped,
        { ...context, objectiveId: null },
        DEFAULT_MEMORY_POLICIES.ObjectiveMemory,
      ),
      false,
    );
  });

  it('confines agent memory to its own agent', () => {
    const scoped = record({ visibility: 'SameAgent' });
    assert.equal(memoryReadable(scoped, context, DEFAULT_MEMORY_POLICIES.AgentMemory), true);
    assert.equal(
      memoryReadable(
        scoped,
        { ...context, engineAgentId: 'agent-2' },
        DEFAULT_MEMORY_POLICIES.AgentMemory,
      ),
      false,
    );
  });

  it('refuses another person’s memory unless the policy allows it', () => {
    const scoped = record({ ownerUserId: 'someone-else' });
    assert.equal(memoryReadable(scoped, context, DEFAULT_MEMORY_POLICIES.AgentMemory), false);
    assert.equal(
      memoryReadable(scoped, context, {
        ...DEFAULT_MEMORY_POLICIES.AgentMemory,
        visibility: 'CompanyWide',
        allowCrossUser: true,
      }),
      true,
    );
  });

  it('checks the cross-user rule before the scope', () => {
    // §19's "never unrestricted cross-user memory" holds however narrow the scope is, so a
    // same-agent record owned by somebody else is still refused.
    const scoped = record({ visibility: 'SameAgent', ownerUserId: 'someone-else' });
    assert.equal(memoryReadable(scoped, context, DEFAULT_MEMORY_POLICIES.AgentMemory), false);
  });

  it('refuses an expired record', () => {
    const scoped = record({ expiresAt: new Date(now.getTime() - 1) });
    assert.equal(memoryReadable(scoped, context, DEFAULT_MEMORY_POLICIES.AgentMemory), false);
  });

  it('refuses a deleted record', () => {
    const scoped = record({ deletedAt: now });
    assert.equal(memoryReadable(scoped, context, DEFAULT_MEMORY_POLICIES.AgentMemory), false);
  });

  it('reads company-wide memory anywhere in the company', () => {
    const scoped = record({
      visibility: 'CompanyWide',
      mode: 'ApprovedLongTermMemory',
      runId: 'another-run',
      objectiveId: 'another-objective',
      engineAgentId: 'another-agent',
      ownerUserId: 'another-person',
    });
    assert.equal(
      memoryReadable(scoped, context, DEFAULT_MEMORY_POLICIES.ApprovedLongTermMemory),
      true,
    );
  });

  it('keeps agent memory inside its Objective unless the policy widens it', () => {
    const scoped = record({ visibility: 'SameAgent', objectiveId: 'obj-1' });
    assert.equal(
      memoryReadable(
        scoped,
        { ...context, objectiveId: 'obj-2' },
        DEFAULT_MEMORY_POLICIES.AgentMemory,
      ),
      false,
    );
    assert.equal(
      memoryReadable(
        scoped,
        { ...context, objectiveId: 'obj-2' },
        { ...DEFAULT_MEMORY_POLICIES.AgentMemory, allowCrossObjective: true },
      ),
      true,
    );
  });
});

describe('expiry and offboarding', () => {
  it('sweeps only what has actually expired', () => {
    const ids = expiredMemoryIds(
      [
        { id: 'a', expiresAt: new Date(now.getTime() - 1), deletedAt: null },
        { id: 'b', expiresAt: new Date(now.getTime() + 1), deletedAt: null },
        { id: 'c', expiresAt: null, deletedAt: null },
        { id: 'd', expiresAt: new Date(now.getTime() - 1), deletedAt: now },
      ],
      now,
    );
    assert.deepEqual(ids, ['a']);
  });

  it('deletes, transfers or anonymises as the policy says', () => {
    assert.deepEqual(
      offboardingOutcome({ ...policy(), offboardingBehaviour: 'DeleteOnOffboarding' }, 'heir'),
      { action: 'Delete' },
    );
    assert.deepEqual(
      offboardingOutcome({ ...policy(), offboardingBehaviour: 'TransferToSuccessor' }, 'heir'),
      { action: 'Transfer', toUserId: 'heir' },
    );
    assert.deepEqual(
      offboardingOutcome({ ...policy(), offboardingBehaviour: 'RetainAnonymised' }, null),
      { action: 'Anonymise' },
    );
  });

  it('deletes rather than leaving a record owned by somebody who has left', () => {
    // Prompt 13 makes a successor optional. A record owned by a departed person is access nobody
    // reviews, so the fallback is the stricter of the two.
    assert.deepEqual(
      offboardingOutcome({ ...policy(), offboardingBehaviour: 'TransferToSuccessor' }, null),
      { action: 'Delete' },
    );
  });
});
