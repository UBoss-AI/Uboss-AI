import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HIGH_RISK_TOOL_CATEGORIES, TOOL_ACTION_CATEGORIES } from './connections.js';
import {
  ALLOWED_SKILL_TRANSITIONS,
  autonomyPermittedWithHighRiskTools,
  IMMUTABLE_SKILL_STATUSES,
  isPlatformLayer,
  isSkillContentFrozen,
  mayTransitionSkill,
  PLATFORM_SKILL_LAYERS,
  SKILL_AUTONOMY_LABELS,
  SKILL_AUTONOMY_LEVELS,
  SKILL_CATEGORIES,
  SKILL_IMPACT_DOMAINS,
  SKILL_LAYER_DESCRIPTIONS,
  SKILL_LAYER_LABELS,
  SKILL_LAYERS,
  SKILL_STATUS_LABELS,
  SKILL_STATUS_TONES,
  SKILL_STATUSES,
  USABLE_SKILL_STATUSES,
  validateSkillContent,
  validateSkillGovernance,
  type SkillContent,
} from './skills.js';

const VALID: SkillContent = {
  purpose: 'Screen a tender notice for eligibility.',
  category: 'Research',
  whenToUse: 'When a new notice arrives.',
  whenNotToUse: 'Never to decide pricing.',
  inputs: [{ name: 'noticeReference', description: 'Portal reference.', required: true }],
  rules: [{ when: 'A certification is missing', then: 'Report ineligible.' }],
  steps: [{ order: 1, instruction: 'Read the notice.' }],
  allowedToolCategories: ['Read'],
  outputSchema: '{"type":"object"}',
  validation: 'A person confirms it.',
  failureHandling: 'Escalate to the owner.',
  requiresApproval: true,
  autonomy: 'ProposeForApproval',
  evidenceRequirement: 'Record the notice reference.',
};

test('the client’s three layers and seven statuses, all labelled', () => {
  assert.deepEqual([...SKILL_LAYERS], ['UbossVerified', 'IndustryPack', 'CompanyCustom']);
  assert.deepEqual(
    [...SKILL_STATUSES],
    ['Draft', 'Test', 'Review', 'Approved', 'Published', 'Deprecated', 'Archived'],
  );

  for (const layer of SKILL_LAYERS) {
    assert.ok(SKILL_LAYER_LABELS[layer]?.length > 0, layer);
    assert.ok(SKILL_LAYER_DESCRIPTIONS[layer]?.length > 0, layer);
  }
  for (const status of SKILL_STATUSES) {
    assert.ok(SKILL_STATUS_LABELS[status]?.length > 0, status);
    assert.ok(SKILL_STATUS_TONES[status]?.length > 0, status);
  }
  for (const autonomy of SKILL_AUTONOMY_LEVELS) {
    assert.ok(SKILL_AUTONOMY_LABELS[autonomy]?.length > 0, autonomy);
  }
});

test('only the two UBoss layers are platform-owned', () => {
  assert.deepEqual([...PLATFORM_SKILL_LAYERS], ['UbossVerified', 'IndustryPack']);
  assert.equal(isPlatformLayer('UbossVerified'), true);
  assert.equal(isPlatformLayer('IndustryPack'), true);
  // The only layer a company may author, which is what makes cloning necessary.
  assert.equal(isPlatformLayer('CompanyCustom'), false);
});

test('a published version can never return to draft, and archived is terminal', () => {
  // The locked versioning rule: an authorised edit after publication creates a **new version**.
  assert.equal(mayTransitionSkill('Published', 'Draft'), false);
  assert.equal(mayTransitionSkill('Published', 'Deprecated'), true);
  assert.equal(mayTransitionSkill('Published', 'Archived'), true);

  // Un-archiving would mean a capability silently becoming available again.
  assert.deepEqual([...ALLOWED_SKILL_TRANSITIONS.Archived], []);
  for (const status of SKILL_STATUSES) {
    assert.equal(mayTransitionSkill('Archived', status), false, `Archived → ${status}`);
  }
});

test('a reviewer can send anything reviewable back to draft', () => {
  // A lifecycle where rejection is a dead end gets worked around by cloning.
  assert.equal(mayTransitionSkill('Review', 'Draft'), true);
  assert.equal(mayTransitionSkill('Test', 'Draft'), true);
  assert.equal(mayTransitionSkill('Approved', 'Draft'), true);
});

test('nothing jumps the lifecycle', () => {
  // Draft straight to Published would put unreviewed content in front of live work.
  assert.equal(mayTransitionSkill('Draft', 'Published'), false);
  assert.equal(mayTransitionSkill('Draft', 'Approved'), false);
  assert.equal(mayTransitionSkill('Test', 'Approved'), false);
  assert.equal(mayTransitionSkill('Review', 'Published'), false);
});

test('content freezes at Approved, which is stricter than the client asked', () => {
  // An approval is a decision about specific content. Content that could change afterwards would
  // let somebody get "delete records" approved by having "read records" reviewed.
  assert.deepEqual(
    [...IMMUTABLE_SKILL_STATUSES],
    ['Approved', 'Published', 'Deprecated', 'Archived'],
  );
  assert.equal(isSkillContentFrozen('Approved'), true);
  assert.equal(isSkillContentFrozen('Review'), false);
  assert.equal(isSkillContentFrozen('Test'), false);
  assert.equal(isSkillContentFrozen('Draft'), false);
});

test('only a published version may be referenced by work', () => {
  assert.deepEqual([...USABLE_SKILL_STATUSES], ['Published']);
});

test('valid content produces no problems', () => {
  assert.deepEqual(validateSkillContent(VALID), []);
  assert.deepEqual(validateSkillGovernance(VALID), []);
});

test('every field the client lists is required, and all problems are reported at once', () => {
  const problems = validateSkillContent({});
  // Being told one mistake at a time is how a review cycle takes four days.
  assert.ok(problems.length >= 8, `expected several problems, got ${problems.length}`);
  assert.ok(problems.some((problem) => /a purpose/.test(problem)));
  assert.ok(problems.some((problem) => /when \*\*not\*\* to use/.test(problem)));
  assert.ok(problems.some((problem) => /at least one step/.test(problem)));
  assert.ok(problems.some((problem) => /what evidence/.test(problem)));
});

test('a Skill with no procedure is refused, and the message says why', () => {
  const problems = validateSkillContent({ ...VALID, steps: [] });
  assert.ok(problems.some((problem) => /A capability with no procedure is a wish/.test(problem)));
});

test('duplicate step positions and duplicate input names are refused', () => {
  assert.ok(
    validateSkillContent({
      ...VALID,
      steps: [
        { order: 1, instruction: 'a' },
        { order: 1, instruction: 'b' },
      ],
    }).some((problem) => /same position/.test(problem)),
  );

  assert.ok(
    validateSkillContent({
      ...VALID,
      inputs: [
        { name: 'ref', description: 'x', required: true },
        { name: 'REF', description: 'y', required: false },
      ],
    }).some((problem) => /same name/.test(problem)),
  );
});

test('a half-written IF/THEN rule is refused', () => {
  assert.ok(
    validateSkillContent({ ...VALID, rules: [{ when: 'something', then: '  ' }] }).some((problem) =>
      /both halves/.test(problem),
    ),
  );
});

/*
 * The two governance rules below are the reason this file exists rather than a schema check
 * alone. They are the connection between Prompt 16's tool categories and Prompt 17's autonomy,
 * and they are the only place the two meet.
 */

test('a high-risk Skill cannot be fully autonomous, at any category', () => {
  for (const category of HIGH_RISK_TOOL_CATEGORIES) {
    const problems = validateSkillGovernance({
      allowedToolCategories: [category],
      autonomy: 'FullyAutonomous',
      requiresApproval: true,
    });
    assert.equal(problems.length, 1, category);
    assert.match(problems[0] as string, /cannot be fully autonomous/i);
    // The Executor Agent never silently approves high-risk work — the locked rule, quoted where
    // somebody might otherwise reach for it as the answer.
    assert.match(problems[0] as string, /Executor Agent is not a substitute/i);
  }
});

test('a safe Skill may be fully autonomous', () => {
  for (const category of ['Read', 'Write'] as const) {
    assert.deepEqual(
      validateSkillGovernance({
        allowedToolCategories: [category],
        autonomy: 'FullyAutonomous',
        requiresApproval: false,
      }),
      [],
      category,
    );
  }
  assert.equal(autonomyPermittedWithHighRiskTools('ActThenReport'), true);
  assert.equal(autonomyPermittedWithHighRiskTools('FullyAutonomous'), false);
});

test('a high-risk Skill must require approval or only suggest', () => {
  const problems = validateSkillGovernance({
    allowedToolCategories: ['Delete'],
    autonomy: 'ActThenReport',
    requiresApproval: false,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0] as string, /on nobody’s decision/);

  // Suggest-only is acceptable without an approval flag: a suggestion changes nothing by itself.
  assert.deepEqual(
    validateSkillGovernance({
      allowedToolCategories: ['Delete'],
      autonomy: 'SuggestOnly',
      requiresApproval: false,
    }),
    [],
  );
});

test('a Skill declares tool categories from the connection vocabulary', () => {
  // A Skill says what it needs from Prompt 16's list. A human action would be a category error in
  // the most literal sense.
  for (const category of VALID.allowedToolCategories) {
    assert.ok(
      (TOOL_ACTION_CATEGORIES as readonly string[]).includes(category),
      `${category} is not a tool category`,
    );
  }
});

test('every category in the closed set is usable', () => {
  for (const category of SKILL_CATEGORIES) {
    assert.deepEqual(validateSkillContent({ ...VALID, category }), [], category);
  }
  assert.ok(
    validateSkillContent({ ...VALID, category: 'Invented' as never }).some((problem) =>
      /Unknown category/.test(problem),
    ),
  );
});

test('the impact registry names what it cannot count', () => {
  // Three of the five domains arrive with later prompts. An analysis that reported zeroes would
  // be worse than useless: somebody would publish on the strength of it.
  const notImplemented = SKILL_IMPACT_DOMAINS.filter(
    (domain) => domain.status === 'not-implemented',
  );
  assert.equal(notImplemented.length, 3);
  for (const domain of notImplemented) {
    assert.ok(domain.arrivesWith.length > 0, domain.key);
  }

  // Exactly one is countable today: clones.
  const implemented = SKILL_IMPACT_DOMAINS.filter((domain) => domain.status === 'implemented');
  assert.deepEqual(
    implemented.map((domain) => domain.key),
    ['clones'],
  );
});
