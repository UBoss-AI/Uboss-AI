import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ALLOWED_CANDIDATE_TRANSITIONS,
  CANDIDATE_STATUSES,
  compareVersions,
  EVALUATION_ASSERTIONS,
  evaluateOutput,
  mayTransitionCandidate,
  meaningfulWords,
  REGRESSION_VERDICTS,
  ROUTER_MAX_RESULTS,
  ROUTER_MIN_CONFIDENCE,
  routeSkills,
  scoreSkillForContext,
  type RoutableSkillVersion,
  type SkillRouterContext,
} from './skill-router.js';

const CONTEXT: SkillRouterContext = {
  aiTask: 'Screen an incoming tender notice for eligibility against our registrations',
  availableInputs: ['noticeReference'],
  allowedToolCategories: ['Read', 'Write'],
  requiresApproval: true,
  category: 'Research',
};

const PUBLISHED: RoutableSkillVersion = {
  skillId: 'skill-1',
  skillVersionId: 'version-1',
  skillKey: 'tender-screen',
  skillName: 'Tender eligibility screen',
  layer: 'UbossVerified',
  industry: null,
  status: 'Published',
  category: 'Research',
  purpose: 'Screen a tender notice for eligibility against registrations',
  whenToUse: 'When a new tender notice arrives and somebody must decide whether to bid',
  whenNotToUse: 'Never for pricing decisions',
  declaredInputs: [{ name: 'noticeReference', required: true }],
  allowedToolCategories: ['Read'],
  requiresApproval: true,
  autonomy: 'ProposeForApproval',
  outputSchema: '{"type":"object","properties":{"eligible":{"type":"boolean"}}}',
};

/*
 * The first four tests are the two client rules. Everything else is ranking quality, which
 * matters less than these: a badly ranked list is a nuisance, and an unapproved Skill reaching
 * production is a governance failure.
 */

test('an unpublished version is disqualified, never merely ranked lower', () => {
  for (const status of ['Draft', 'Test', 'Review', 'Approved', 'Deprecated', 'Archived']) {
    const outcome = scoreSkillForContext(CONTEXT, { ...PUBLISHED, status });
    assert.ok('disqualifier' in outcome, status);
    assert.match(
      (outcome as { disqualifier: string }).disqualifier,
      /a draft is a proposal, not a capability/i,
    );
  }

  // Only Published survives.
  assert.ok(!('disqualifier' in scoreSkillForContext(CONTEXT, PUBLISHED)));
});

test('routing an empty catalogue reports a missing capability rather than a best guess', () => {
  const result = routeSkills(CONTEXT, []);
  assert.equal(result.matches.length, 0);
  assert.equal(result.capabilityMissing, true);
  assert.match(result.note, /Raise a Skill Candidate/);
  assert.match(result.note, /never selects an unapproved version/);
});

test('routing a catalogue of drafts also reports missing, and says why each was rejected', () => {
  const result = routeSkills(CONTEXT, [
    { ...PUBLISHED, status: 'Draft' },
    { ...PUBLISHED, skillVersionId: 'version-2', status: 'Approved' },
  ]);

  assert.equal(result.capabilityMissing, true);
  assert.equal(result.rejected.length, 2);
  // "Why was our Skill not used" is the question this design exists to answer.
  for (const rejection of result.rejected) {
    assert.ok(rejection.disqualifier.length > 0);
  }
});

test('a policy ceiling on autonomy disqualifies, and says it is not a preference', () => {
  const outcome = scoreSkillForContext(
    { ...CONTEXT, maxAutonomy: 'SuggestOnly' },
    { ...PUBLISHED, autonomy: 'ActThenReport' },
  );
  assert.ok('disqualifier' in outcome);
  assert.match(
    (outcome as { disqualifier: string }).disqualifier,
    /not a preference to rank lower/i,
  );
});

test('a Skill needing a tool the work does not permit is disqualified', () => {
  const outcome = scoreSkillForContext(CONTEXT, {
    ...PUBLISHED,
    allowedToolCategories: ['Read', 'Delete'],
  });
  assert.ok('disqualifier' in outcome);
  assert.match((outcome as { disqualifier: string }).disqualifier, /Delete/);
  // Failing part-way through an external action is worse than not being selected.
  assert.match((outcome as { disqualifier: string }).disqualifier, /fail part-way/i);
});

test('a Skill needing an input that is not available is disqualified', () => {
  const outcome = scoreSkillForContext(CONTEXT, {
    ...PUBLISHED,
    declaredInputs: [
      { name: 'noticeReference', required: true },
      { name: 'priorBidHistory', required: true },
    ],
  });
  assert.ok('disqualifier' in outcome);
  assert.match((outcome as { disqualifier: string }).disqualifier, /priorBidHistory/);
});

test('an optional input that is missing does not disqualify', () => {
  const outcome = scoreSkillForContext(CONTEXT, {
    ...PUBLISHED,
    declaredInputs: [
      { name: 'noticeReference', required: true },
      { name: 'priorBidHistory', required: false },
    ],
  });
  assert.ok(!('disqualifier' in outcome));
});

test('work that must be approved will not use a Skill that needs no approval', () => {
  const outcome = scoreSkillForContext(CONTEXT, { ...PUBLISHED, requiresApproval: false });
  assert.ok('disqualifier' in outcome);
  assert.match((outcome as { disqualifier: string }).disqualifier, /nobody having decided/i);
});

test('the "when not to use it" field actually excludes', () => {
  // This is why that field is mandatory. A Skill that says "never for pricing" must not be
  // selected for pricing work merely because it scored well on everything else.
  const outcome = scoreSkillForContext(
    {
      ...CONTEXT,
      aiTask: 'Decide the pricing strategy and pricing floor for this tender pricing submission',
    },
    {
      ...PUBLISHED,
      whenNotToUse: 'Never for pricing strategy, pricing floors or pricing submissions',
    },
  );
  assert.ok('disqualifier' in outcome);
  assert.match((outcome as { disqualifier: string }).disqualifier, /when not to use/i);
});

test('a single incidental overlap with the exclusion text does not exclude', () => {
  // Conservative in the safe direction, but not so blunt that one shared word blocks a match.
  const outcome = scoreSkillForContext(CONTEXT, {
    ...PUBLISHED,
    whenNotToUse: 'Never for pricing',
  });
  assert.ok(!('disqualifier' in outcome));
});

test('a wrong-category Skill is disqualified when the caller names a category', () => {
  const outcome = scoreSkillForContext(CONTEXT, { ...PUBLISHED, category: 'Drafting' });
  assert.ok('disqualifier' in outcome);
  assert.match((outcome as { disqualifier: string }).disqualifier, /Drafting/);
});

test('a match carries reasons, and the reasons name the signals', () => {
  const outcome = scoreSkillForContext(CONTEXT, PUBLISHED);
  assert.ok(!('disqualifier' in outcome));

  const scored = outcome as { confidence: number; reasons: string[] };
  assert.ok(scored.confidence >= ROUTER_MIN_CONFIDENCE);
  assert.ok(scored.reasons.length >= 2);
  assert.ok(scored.reasons.some((reason) => /Same category/.test(reason)));
  assert.ok(scored.reasons.some((reason) => /when to use/.test(reason)));
  // Least privilege, achieved by choice.
  assert.ok(scored.reasons.some((reason) => /fewer tools/.test(reason)));
});

test('a company’s own Skill outranks an otherwise identical platform one', () => {
  const platform = scoreSkillForContext(CONTEXT, PUBLISHED) as { confidence: number };
  const own = scoreSkillForContext(CONTEXT, {
    ...PUBLISHED,
    skillVersionId: 'version-2',
    layer: 'CompanyCustom',
  }) as { confidence: number };

  // Somebody here wrote, reviewed and approved it for this company's way of working.
  assert.ok(own.confidence > platform.confidence);
});

test('an industry pack for another industry is usable but ranked lower', () => {
  const matching = scoreSkillForContext(
    { ...CONTEXT, industry: 'Medical Devices' },
    { ...PUBLISHED, layer: 'IndustryPack', industry: 'Medical Devices' },
  ) as { confidence: number; reasons: string[] };

  const other = scoreSkillForContext(
    { ...CONTEXT, industry: 'Medical Devices' },
    { ...PUBLISHED, layer: 'IndustryPack', industry: 'Construction' },
  ) as { confidence: number; reasons: string[] };

  assert.ok(matching.confidence > other.confidence);
  // Not disqualified: refusing it outright would leave the company with nothing.
  assert.ok(!('disqualifier' in other));
  assert.ok(other.reasons.some((reason) => /usable, but ranked lower/.test(reason)));
});

test('a Skill matching only on category is not offered', () => {
  /*
   * The birthday Skill shares the context's category and needs fewer tools, which together came
   * to exactly the confidence floor — so it was being offered for tender screening with nothing
   * about the task matching. A category is a filter, not a reason, and the router now says so.
   */
  const result = routeSkills(CONTEXT, [
    {
      ...PUBLISHED,
      category: 'Research',
      purpose: 'Compose a birthday message',
      whenToUse: 'When somebody has a birthday',
      whenNotToUse: 'Never for anything else',
      outputSchema: '{}',
    },
  ]);

  assert.equal(result.matches.length, 0);
  assert.equal(result.capabilityMissing, true);
  assert.match(
    result.rejected[0]?.disqualifier ?? '',
    /Nothing about this task matches what it says it is for/,
  );
  assert.match(
    result.rejected[0]?.disqualifier ?? '',
    /a category is a filter rather than a reason/,
  );
});

test('a weakly relevant Skill falls below the confidence floor', () => {
  // Relevant enough to be considered, not enough to be suggested. The floor still does its job
  // for the cases the relevance rule lets through.
  const result = routeSkills({ ...CONTEXT, category: undefined, allowedToolCategories: ['Read'] }, [
    {
      ...PUBLISHED,
      category: 'Drafting',
      purpose: 'Draft a notice of some kind',
      whenToUse: 'When a notice is needed',
      whenNotToUse: 'Never for anything numeric',
      outputSchema: '{}',
    },
  ]);

  assert.equal(result.matches.length, 0);
  assert.match(
    result.rejected[0]?.disqualifier ?? '',
    /below the ${ROUTER_MIN_CONFIDENCE}|below the/,
  );
});

test('the router returns a small set, highest confidence first', () => {
  const many: RoutableSkillVersion[] = Array.from({ length: 12 }, (_, index) => ({
    ...PUBLISHED,
    skillId: `skill-${index}`,
    skillVersionId: `version-${index}`,
    // Later ones match more of the task, so ordering is observable.
    whenToUse:
      index % 2 === 0
        ? 'When a new tender notice arrives and somebody must decide whether to bid on it'
        : 'When a tender arrives',
  }));

  const result = routeSkills(CONTEXT, many);
  assert.equal(result.matches.length, ROUTER_MAX_RESULTS);

  for (let index = 1; index < result.matches.length; index += 1) {
    assert.ok(
      (result.matches[index - 1]?.confidence ?? 0) >= (result.matches[index]?.confidence ?? 0),
      'matches must be ordered by confidence',
    );
  }
});

test('a long whenToUse cannot win by volume', () => {
  const padded = scoreSkillForContext(CONTEXT, {
    ...PUBLISHED,
    whenToUse: `${PUBLISHED.whenToUse} ${'tender notice eligibility registrations bid decide '.repeat(20)}`,
  }) as { confidence: number };

  // Capped, so a Skill cannot be written to game the router.
  assert.ok(padded.confidence <= 100);
  const normal = scoreSkillForContext(CONTEXT, PUBLISHED) as { confidence: number };
  assert.ok(padded.confidence - normal.confidence <= 20);
});

test('meaningfulWords drops filler and duplicates', () => {
  const words = meaningfulWords('The tender and the tender notice is in the notice');
  assert.deepEqual([...words].sort(), ['notice', 'tender']);
});

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

test('the three assertion kinds behave as described', () => {
  assert.deepEqual([...EVALUATION_ASSERTIONS], ['ExactMatch', 'ContainsAll', 'HumanJudged']);

  assert.equal(
    evaluateOutput({ assertion: 'ExactMatch', expected: '{"a":1}', actual: ' {"a":1} ' }),
    true,
  );
  assert.equal(
    evaluateOutput({ assertion: 'ExactMatch', expected: '{"a":1}', actual: '{"a":2}' }),
    false,
  );

  assert.equal(
    evaluateOutput({
      assertion: 'ContainsAll',
      expected: 'eligible\nregistration',
      actual: 'The notice is eligible under our registration.',
    }),
    true,
  );
  assert.equal(
    evaluateOutput({
      assertion: 'ContainsAll',
      expected: 'eligible\nregistration',
      actual: 'The notice is eligible.',
    }),
    false,
  );
});

test('a human-judged case cannot be computed, and does not default to passing', () => {
  // A case that silently passed because nobody judged it would be worse than one left open.
  assert.equal(
    evaluateOutput({ assertion: 'HumanJudged', expected: 'anything', actual: 'anything' }),
    null,
  );
});

test('ContainsAll with no fragments is a failure, not a vacuous pass', () => {
  assert.equal(evaluateOutput({ assertion: 'ContainsAll', expected: '   ', actual: 'x' }), false);
});

// ---------------------------------------------------------------------------
// Regression comparison
// ---------------------------------------------------------------------------

test('a regression is reported separately from a mixed result', () => {
  // "Eight better, one worse" is a decision; "one thing that used to work no longer does" is a
  // blocker. Collapsing them would hide the second inside the first.
  const regressed = compareVersions([
    { caseId: 'a', currentPassed: true, candidatePassed: false },
    { caseId: 'b', currentPassed: true, candidatePassed: true },
  ]);
  assert.equal(regressed.verdict, 'Regressed');
  assert.deepEqual(regressed.regressions, ['a']);

  const mixed = compareVersions([
    { caseId: 'a', currentPassed: true, candidatePassed: false },
    { caseId: 'b', currentPassed: false, candidatePassed: true },
  ]);
  assert.equal(mixed.verdict, 'Mixed');
  assert.deepEqual(mixed.regressions, ['a']);
  assert.deepEqual(mixed.improvements, ['b']);
});

test('improved and unchanged are distinguished', () => {
  assert.equal(
    compareVersions([{ caseId: 'a', currentPassed: false, candidatePassed: true }]).verdict,
    'Improved',
  );
  assert.equal(
    compareVersions([{ caseId: 'a', currentPassed: true, candidatePassed: true }]).verdict,
    'NoChange',
  );
  assert.equal(
    compareVersions([{ caseId: 'a', currentPassed: false, candidatePassed: false }]).verdict,
    'NoChange',
  );
});

test('an unjudged case counts as neither, and cannot produce a verdict on its own', () => {
  const result = compareVersions([
    { caseId: 'a', currentPassed: null, candidatePassed: true },
    { caseId: 'b', currentPassed: true, candidatePassed: null },
  ]);

  // Treating either as a pass would let a comparison report Improved on cases nobody looked at.
  assert.equal(result.verdict, 'Inconclusive');
  assert.equal(result.casesCompared, 0);
  assert.deepEqual([...result.unjudged].sort(), ['a', 'b']);
});

test('an empty comparison is inconclusive, not clean', () => {
  const result = compareVersions([]);
  assert.equal(result.verdict, 'Inconclusive');
  assert.equal(result.casesCompared, 0);
});

test('unjudged cases do not stop a verdict being reached on the rest', () => {
  const result = compareVersions([
    { caseId: 'a', currentPassed: true, candidatePassed: false },
    { caseId: 'b', currentPassed: null, candidatePassed: null },
  ]);
  assert.equal(result.verdict, 'Regressed');
  assert.equal(result.casesCompared, 1);
  assert.deepEqual(result.unjudged, ['b']);
});

test('every verdict in the closed set is reachable or explicitly not', () => {
  assert.deepEqual(
    [...REGRESSION_VERDICTS],
    ['Improved', 'NoChange', 'Regressed', 'Mixed', 'Inconclusive'],
  );
});

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

test('a Candidate has no path to published, and both endings are final', () => {
  // The client's rule, expressed as the absence of a value: there is no `Published` status a
  // Candidate could be given.
  assert.deepEqual([...CANDIDATE_STATUSES], ['Suggested', 'UnderReview', 'Accepted', 'Rejected']);
  assert.equal((CANDIDATE_STATUSES as readonly string[]).includes('Published'), false);

  // A re-openable Candidate would be a second, weaker lifecycle beside the real one.
  assert.deepEqual([...ALLOWED_CANDIDATE_TRANSITIONS.Accepted], []);
  assert.deepEqual([...ALLOWED_CANDIDATE_TRANSITIONS.Rejected], []);

  assert.equal(mayTransitionCandidate('Suggested', 'Accepted'), true);
  assert.equal(mayTransitionCandidate('UnderReview', 'Rejected'), true);
  assert.equal(mayTransitionCandidate('Accepted', 'Rejected'), false);
  assert.equal(mayTransitionCandidate('Rejected', 'UnderReview'), false);
});
