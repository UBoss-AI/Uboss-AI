import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ACTIONS, COMPANY_MODULES } from './authorization.js';
import {
  evaluationEligibility,
  FEEDBACK_GIVE_ACTION,
  FEEDBACK_PROMOTE_ACTION,
  FEEDBACK_PROMOTE_MODULE,
  FEEDBACK_RATING_DESCRIPTIONS,
  FEEDBACK_RATING_LABELS,
  FEEDBACK_RATINGS,
  FEEDBACK_TRAINING_STANCE,
  feedbackEligibility,
  feedbackProblems,
  MIN_CORRECTION_LENGTH,
  ratingIsPositive,
  ratingRequiresCorrection,
  summariseQuality,
} from './feedback.js';

const eligible = {
  hasOutput: true,
  producedByRealModel: true,
  alreadyRatedByReviewer: false,
  sameTenant: true,
};

describe('the ratings', () => {
  it('has the client’s four, in the order §27.1 names them', () => {
    assert.deepEqual(
      [...FEEDBACK_RATINGS],
      ['Correct', 'NeedsCorrection', 'Incorrect', 'Incomplete'],
    );
  });

  it('labels and explains every rating', () => {
    // Three negative ratings a reviewer cannot tell apart produce a dataset of noise.
    for (const rating of FEEDBACK_RATINGS) {
      assert.ok(FEEDBACK_RATING_LABELS[rating].length > 0, rating);
      assert.ok(FEEDBACK_RATING_DESCRIPTIONS[rating].length > 0, rating);
    }
  });

  it('treats only Correct as positive', () => {
    assert.equal(ratingIsPositive('Correct'), true);
    for (const rating of FEEDBACK_RATINGS.filter((candidate) => candidate !== 'Correct')) {
      assert.equal(ratingIsPositive(rating), false, rating);
    }
  });

  it('requires a correction for every rating but Correct', () => {
    assert.equal(ratingRequiresCorrection('Correct'), false);
    assert.equal(ratingRequiresCorrection('NeedsCorrection'), true);
    assert.equal(ratingRequiresCorrection('Incorrect'), true);
    assert.equal(ratingRequiresCorrection('Incomplete'), true);
  });
});

describe('the permission model', () => {
  it('uses actions that already exist', () => {
    // Nothing here invents an action; `ACTIONS` is a closed set.
    assert.ok((ACTIONS as readonly string[]).includes(FEEDBACK_GIVE_ACTION));
    assert.ok((ACTIONS as readonly string[]).includes(FEEDBACK_PROMOTE_ACTION));
  });

  it('gates promotion on a module a company user can actually hold', () => {
    // **The test that catches an unreachable route.** The first cut gated promotion on
    // `skills:EditDraft`, and `skills` is a *platform* module — the reference puts Skills & AI
    // inside Settings — so no company user could ever hold it and nobody could promote anything.
    assert.ok(
      (COMPANY_MODULES as readonly string[]).includes(FEEDBACK_PROMOTE_MODULE),
      `${FEEDBACK_PROMOTE_MODULE} is not a company module, so no company user can hold a grant on it`,
    );
  });

  it('separates having something to say from changing what UBoss tests', () => {
    // An Employee holds `agents:Comment`. Turning a rating into a permanent regression case is a
    // different decision and a different grant — the same one Prompt 17 uses for every other
    // change to a company Skill.
    assert.equal(FEEDBACK_GIVE_ACTION, 'Comment');
    assert.equal(FEEDBACK_PROMOTE_ACTION, 'Administer');
    assert.equal(FEEDBACK_PROMOTE_MODULE, 'settings');
  });
});

describe('whether feedback may be given at all', () => {
  it('permits feedback on a real output', () => {
    assert.deepEqual(feedbackEligibility(eligible), { permitted: true });
  });

  it('permits feedback on mock output, and does not pretend it is real', () => {
    // Refusing it would make the feedback loop untestable until a provider credential exists.
    // What matters is that the record says which it was — asserted in the quality summary.
    const result = feedbackEligibility({ ...eligible, producedByRealModel: false });
    assert.equal(result.permitted, true);
  });

  it('refuses a run with no output', () => {
    const result = feedbackEligibility({ ...eligible, hasOutput: false });
    assert.equal(result.permitted, false);
    if (result.permitted) return;
    assert.match(result.reason, /nothing to judge/);
  });

  it('refuses a second rating from the same reviewer', () => {
    // Two ratings from one person would count twice in the quality figures.
    const result = feedbackEligibility({ ...eligible, alreadyRatedByReviewer: true });
    assert.equal(result.permitted, false);
    if (result.permitted) return;
    assert.match(result.reason, /Amend your existing feedback/);
  });

  it('refuses another company’s output', () => {
    const result = feedbackEligibility({ ...eligible, sameTenant: false });
    assert.equal(result.permitted, false);
  });
});

describe('validating a submission', () => {
  const correction = 'It quoted last quarter’s figure instead of this quarter’s.';

  it('accepts a correct rating with no note', () => {
    assert.deepEqual(feedbackProblems({ rating: 'Correct', correction: null, evidence: null }), []);
  });

  it('accepts a correct rating with a note anyway', () => {
    // Somebody marking an output correct and adding a remark is doing something useful.
    assert.deepEqual(
      feedbackProblems({ rating: 'Correct', correction: 'Neatly done.', evidence: null }),
      [],
    );
  });

  it('refuses a negative rating with no correction', () => {
    for (const rating of ['NeedsCorrection', 'Incorrect', 'Incomplete'] as const) {
      const problems = feedbackProblems({ rating, correction: null, evidence: null });
      assert.ok(problems.length > 0, rating);
      assert.ok(
        problems.some((problem) => /needs to say what is wrong/.test(problem)),
        rating,
      );
    }
  });

  it('refuses a one-word correction', () => {
    const problems = feedbackProblems({ rating: 'Incorrect', correction: 'wrong', evidence: null });
    assert.ok(problems.some((problem) => /at least 20 characters/.test(problem)));
  });

  it('refuses whitespace as a correction', () => {
    const problems = feedbackProblems({
      rating: 'Incorrect',
      correction: '                              ',
      evidence: null,
    });
    assert.ok(problems.length > 0);
  });

  it('accepts a real correction', () => {
    assert.ok(correction.length >= MIN_CORRECTION_LENGTH);
    assert.deepEqual(feedbackProblems({ rating: 'Incorrect', correction, evidence: null }), []);
  });

  it('does not require evidence, even for Incorrect', () => {
    // §27.1 says "correction/evidence", not "correction and evidence". A reviewer who knows the
    // output is wrong should not be blocked because they cannot cite a source.
    assert.deepEqual(feedbackProblems({ rating: 'Incorrect', correction, evidence: null }), []);
  });
});

describe('feeding the evaluation dataset', () => {
  const correction = 'It should have cited the signed contract, not the draft.';

  it('makes a corrected negative rating a candidate case', () => {
    const result = evaluationEligibility({
      rating: 'Incorrect',
      correction,
      skillVersionIds: ['skill-version-1'],
    });
    assert.equal(result.eligible, true);
    if (!result.eligible) return;
    assert.deepEqual([...result.skillVersionIds], ['skill-version-1']);
  });

  it('refuses a correct rating, and says why it still counts', () => {
    // A test asserting the current behaviour passes by construction.
    const result = evaluationEligibility({
      rating: 'Correct',
      correction: null,
      skillVersionIds: ['skill-version-1'],
    });
    assert.equal(result.eligible, false);
    if (result.eligible) return;
    assert.match(result.reason, /passes by construction/);
    assert.match(result.reason, /still counts towards/);
  });

  it('refuses a rating with no correction, because there is no expected answer', () => {
    const result = evaluationEligibility({
      rating: 'Incorrect',
      correction: '   ',
      skillVersionIds: ['skill-version-1'],
    });
    assert.equal(result.eligible, false);
  });

  it('refuses a run that cites no Skill', () => {
    const result = evaluationEligibility({
      rating: 'Incorrect',
      correction,
      skillVersionIds: [],
    });
    assert.equal(result.eligible, false);
    if (result.eligible) return;
    assert.match(result.reason, /nothing for a case to test/);
  });
});

describe('the quality summary', () => {
  it('counts each rating and floors the percentage', () => {
    const summary = summariseQuality([
      { rating: 'Correct', producedByRealModel: true },
      { rating: 'Correct', producedByRealModel: true },
      { rating: 'Incorrect', producedByRealModel: true },
    ]);
    assert.equal(summary.total, 3);
    assert.equal(summary.correct, 2);
    assert.equal(summary.incorrect, 1);
    // 66.6% must not read as 67% on a screen asking "is this agent reliable".
    assert.equal(summary.correctPercent, 66);
  });

  it('reports no percentage when nobody has rated anything', () => {
    const summary = summariseQuality([]);
    assert.equal(summary.total, 0);
    assert.equal(summary.correctPercent, null);
  });

  it('says how much of the feedback was on real provider output', () => {
    // A 100% correct rate over mock output says nothing about a provider's quality, and a screen
    // showing the percentage without this would be presenting mock results as real.
    const summary = summariseQuality([
      { rating: 'Correct', producedByRealModel: false },
      { rating: 'Correct', producedByRealModel: false },
      { rating: 'Correct', producedByRealModel: true },
    ]);
    assert.equal(summary.correctPercent, 100);
    assert.equal(summary.onRealModelOutput, 1);
  });

  it('does not count an unknown provenance as real', () => {
    const summary = summariseQuality([{ rating: 'Correct', producedByRealModel: null }]);
    assert.equal(summary.onRealModelOutput, 0);
  });
});

describe('provider training', () => {
  it('states the stance in words the UI can show', () => {
    assert.match(FEEDBACK_TRAINING_STANCE, /never sent to a model provider as training data/);
    assert.match(FEEDBACK_TRAINING_STANCE, /because none exists/);
  });

  it('exposes no field, flag or function that could enable it', async () => {
    // The prompt's instruction is "do NOT assume or automatically enable external provider model
    // training on company data". This asserts the absence rather than trusting it: a later prompt
    // adding a `trainingConsent` field would fail here.
    const module = (await import('./feedback.js')) as Record<string, unknown>;
    const suspicious = Object.keys(module).filter((name) => /train/i.test(name));
    assert.deepEqual(suspicious, ['FEEDBACK_TRAINING_STANCE']);
  });
});
