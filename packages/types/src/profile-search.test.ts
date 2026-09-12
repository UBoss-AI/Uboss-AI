import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_PERFORMANCE_SHARING,
  DEFAULT_PROFILE_SEARCH_ENABLED,
  decideProfileSearch,
  NEVER_IN_A_PORTABLE_PROFILE,
  onTimePercent,
  PERFORMANCE_SHARING_DESCRIPTIONS,
  PERFORMANCE_SHARING_LABELS,
  PERFORMANCE_SHARING_MODES,
  PORTABLE_EMPLOYMENT_FIELDS,
  PORTABLE_PERFORMANCE_FIELDS,
  PORTABLE_PROFILE_FIELDS,
  PROFILE_SEARCH_INPUT,
  PROFILE_SEARCH_INPUT_STANCE,
  shareablePerformance,
} from './profile-search.js';

/**
 * Portable UBoss Profile Search — Prompt 37A.
 *
 * The weight is on the four things that make this the highest-risk read in the product: **the
 * input is one identifier**, **the projection is a whitelist**, **`BadgeOnly` cannot return a
 * score**, and **the defaults are off**.
 */
describe('the input', () => {
  it('is a UBoss Unique ID and nothing else', () => {
    assert.equal(PROFILE_SEARCH_INPUT, 'UbossUniqueId');
    assert.equal(PROFILE_SEARCH_INPUT_STANCE.includes('Aadhaar is never a search field'), true);
    assert.equal(PROFILE_SEARCH_INPUT_STANCE.includes('enumerate'), true);
  });
});

describe('the projection is a whitelist', () => {
  it('names exactly the four fields a profile may carry', () => {
    assert.deepEqual(
      [...PORTABLE_PROFILE_FIELDS],
      ['ubossUniqueId', 'displayName', 'employments', 'searchedAt'],
    );
  });

  it('names exactly the six fields an employment may carry', () => {
    assert.deepEqual(
      [...PORTABLE_EMPLOYMENT_FIELDS],
      ['companyName', 'designation', 'joinedOn', 'endedAt', 'isCurrent', 'performance'],
    );
  });

  it('names exactly the four fields a performance summary may carry', () => {
    assert.deepEqual(
      [...PORTABLE_PERFORMANCE_FIELDS],
      ['score', 'badge', 'onTimePercent', 'achievements'],
    );
  });

  /**
   * The prompt's own forbidden list, checked to actually be in the constant a test greps with.
   *
   * Crude on purpose. A test that checks the response's *shape* passes the moment somebody nests
   * a forbidden thing one level deeper; a test that greps the serialized JSON does not.
   */
  it('forbids everything the prompt forbids', () => {
    for (const forbidden of [
      'aadhaar',
      'objective',
      'task',
      'prompt',
      'credential',
      'connection',
      'file',
    ]) {
      assert.equal(
        NEVER_IN_A_PORTABLE_PROFILE.includes(forbidden),
        true,
        `"${forbidden}" is named in the prompt and missing from the forbidden list`,
      );
    }
  });

  it('carries no forbidden word in a permitted field name', () => {
    // Otherwise the grep test would fail against a correct response, and somebody would weaken
    // the grep rather than the field.
    const permitted = [
      ...PORTABLE_PROFILE_FIELDS,
      ...PORTABLE_EMPLOYMENT_FIELDS,
      ...PORTABLE_PERFORMANCE_FIELDS,
    ];
    for (const field of permitted) {
      for (const forbidden of NEVER_IN_A_PORTABLE_PROFILE) {
        assert.equal(
          field.toLowerCase().includes(forbidden),
          false,
          `the permitted field "${field}" contains the forbidden word "${forbidden}", which ` +
            'would make the leak test unusable',
        );
      }
    }
  });
});

describe('company policy', () => {
  it('is off until somebody turns it on', () => {
    assert.equal(DEFAULT_PROFILE_SEARCH_ENABLED, false);
    assert.equal(DEFAULT_PERFORMANCE_SHARING, 'Nothing');
  });

  it('refuses a lookup for a company that has not enabled it, and says why', () => {
    const decision = decideProfileSearch({ enabledForSearcher: false });
    assert.equal(decision.permitted, false);
    assert.equal(
      decision.permitted === false && decision.reason.includes('switched off'),
      true,
    );
  });

  it('permits one for a company that has', () => {
    assert.equal(decideProfileSearch({ enabledForSearcher: true }).permitted, true);
  });

  it('labels and describes every sharing mode', () => {
    for (const mode of PERFORMANCE_SHARING_MODES) {
      assert.equal(typeof PERFORMANCE_SHARING_LABELS[mode], 'string');
      assert.equal(typeof PERFORMANCE_SHARING_DESCRIPTIONS[mode], 'string');
    }
  });
});

describe('what a sharing mode lets out', () => {
  const full = {
    score: 87,
    badge: 'Gold',
    onTimePercent: 92,
    achievements: { count: 3, mostRecentAt: '2026-03-01T00:00:00.000Z' },
  };

  it('returns nothing at all under Nothing', () => {
    assert.equal(shareablePerformance({ mode: 'Nothing', ...full }), null);
  });

  /**
   * The one that would be a quiet leak.
   *
   * `BadgeOnly` returning the score because the caller passed it through is exactly the bug this
   * function exists to make impossible — which is why the decision is here and not in the
   * service.
   */
  it('cannot return a score under BadgeOnly, even when one is passed in', () => {
    const shared = shareablePerformance({ mode: 'BadgeOnly', ...full });
    assert.notEqual(shared, null);
    assert.equal(shared?.score, null, 'BadgeOnly must withhold the number by construction');
    assert.equal(shared?.badge, 'Gold');
    assert.equal(shared?.onTimePercent, 92);
  });

  it('returns the score under BadgeAndScore', () => {
    assert.equal(shareablePerformance({ mode: 'BadgeAndScore', ...full })?.score, 87);
  });
});

describe('on-time percentage', () => {
  it('is null when nothing had a due date', () => {
    assert.equal(
      onTimePercent({ onTime: 0, withDueDate: 0 }),
      null,
      '0% would read as "never on time", which is the opposite of the truth',
    );
  });

  it('rounds to a whole percent', () => {
    assert.equal(onTimePercent({ onTime: 2, withDueDate: 3 }), 67);
    assert.equal(onTimePercent({ onTime: 3, withDueDate: 3 }), 100);
    assert.equal(onTimePercent({ onTime: 0, withDueDate: 4 }), 0);
  });
});
