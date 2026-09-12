import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  countTone,
  DEFAULT_SECURITY_TIME_RANGE,
  everySecurityCategoryIsReachable,
  everyViewIsReachable,
  guestExpiry,
  guestTone,
  mfaCoverage,
  mfaCoverageTone,
  rangeStart,
  SECURITY_CENTER_VIEW_LABELS,
  SECURITY_CENTER_VIEW_PURPOSE,
  SECURITY_CENTER_VIEW_SOURCE,
  SECURITY_CENTER_VIEWS,
  SECURITY_EXPORT_ACTIONS,
  SECURITY_METRIC_DRILLDOWN,
  SECURITY_METRIC_LABELS,
  SECURITY_METRICS,
  SECURITY_PERMISSION_ACTIONS,
  SECURITY_TIME_RANGE_HOURS,
  SECURITY_TIME_RANGES,
  ssoStatus,
  supportAccessTone,
  viewHasCorrelationIds,
} from './security-center.js';

describe('the Security Center vocabulary', () => {
  it('has the seven views the prompt names', () => {
    assert.deepEqual(
      [...SECURITY_CENTER_VIEWS],
      [
        'AuthenticationEvents',
        'ActiveSessions',
        'AdminAndPermissionChanges',
        'GuestAccess',
        'DataExports',
        'AgentHighRiskActions',
        'SupportAccess',
      ],
    );
  });

  it('has the eleven metrics both source documents name', () => {
    assert.equal(SECURITY_METRICS.length, 11);
    // The four the approved UI reference already shows, in its order, first.
    assert.deepEqual(SECURITY_METRICS.slice(0, 4), [
      'MfaCoverage',
      'ActiveSessions',
      'AdminAccounts',
      'Guests',
    ]);
  });

  it('labels and explains every view', () => {
    for (const view of SECURITY_CENTER_VIEWS) {
      assert.ok(SECURITY_CENTER_VIEW_LABELS[view].length > 0, view);
      assert.ok(SECURITY_CENTER_VIEW_PURPOSE[view].length > 0, view);
      assert.ok(SECURITY_CENTER_VIEW_SOURCE[view] !== undefined, view);
    }
  });

  it('labels every metric and drills every one into a view', () => {
    for (const metric of SECURITY_METRICS) {
      assert.ok(SECURITY_METRIC_LABELS[metric].length > 0, metric);
      assert.ok(SECURITY_CENTER_VIEWS.includes(SECURITY_METRIC_DRILLDOWN[metric]), metric);
    }
  });

  it('leaves no view unreachable from a metric', () => {
    // A view with no card leading to it is a screen nobody finds.
    assert.equal(everyViewIsReachable(), true);
  });

  it('leaves no recorded event category invisible', () => {
    assert.equal(everySecurityCategoryIsReachable(), true);
  });

  it('claims a correlation id only where a request produced the row', () => {
    // A live session and a guest membership are *state*. Offering a correlation-id filter on
    // them would send an investigator looking for a request that never existed.
    assert.equal(viewHasCorrelationIds('AuthenticationEvents'), true);
    assert.equal(viewHasCorrelationIds('DataExports'), true);
    assert.equal(viewHasCorrelationIds('SupportAccess'), true);
    assert.equal(viewHasCorrelationIds('ActiveSessions'), false);
    assert.equal(viewHasCorrelationIds('GuestAccess'), false);
    assert.equal(viewHasCorrelationIds('AgentHighRiskActions'), false);
  });

  it('builds the exports view from named actions rather than a category', () => {
    // `Access` holds fifty actions. A category filter would answer "what happened" instead of
    // "what left this company".
    const source = SECURITY_CENTER_VIEW_SOURCE.DataExports;
    assert.equal(source.kind, 'SecurityEventActions');
    if (source.kind !== 'SecurityEventActions') return;
    assert.deepEqual([...source.actions], [...SECURITY_EXPORT_ACTIONS]);
  });

  it('includes the Security Center’s own exports in the exports view', () => {
    // Otherwise the one export path a company cannot see is the one on the screen that shows it.
    assert.ok(SECURITY_EXPORT_ACTIONS.includes('security.security_center_exported'));
  });

  it('counts a refused permission as a permission change', () => {
    // A denial is the most informative row in an access investigation: somebody tried.
    assert.ok(SECURITY_PERMISSION_ACTIONS.includes('security.permission_denied'));
    assert.ok(SECURITY_PERMISSION_ACTIONS.includes('security.separation_of_duties_blocked'));
  });

  it('shows sign-outs and new-device sign-ins as authentication events', () => {
    // A new-device sign-in is classified `Risk` rather than `Login`, and a sign-out is
    // `Session` — and Active Sessions shows live state with no history in it, so leaving
    // `Session` out meant a company could not see that somebody had been signed out at all.
    const source = SECURITY_CENTER_VIEW_SOURCE.AuthenticationEvents;
    assert.equal(source.kind, 'SecurityEvents');
    if (source.kind !== 'SecurityEvents') return;
    assert.deepEqual([...source.categories], ['Login', 'Session', 'Risk']);
  });
});

describe('time ranges', () => {
  it('offers four windows and defaults to a week', () => {
    assert.deepEqual(
      [...SECURITY_TIME_RANGES],
      ['Last24Hours', 'Last7Days', 'Last30Days', 'Last90Days'],
    );
    assert.equal(DEFAULT_SECURITY_TIME_RANGE, 'Last7Days');
  });

  it('measures from a clock the caller supplies', () => {
    const now = new Date('2026-09-11T12:00:00.000Z');
    assert.equal(rangeStart('Last24Hours', now).toISOString(), '2026-09-10T12:00:00.000Z');
    assert.equal(rangeStart('Last7Days', now).toISOString(), '2026-09-04T12:00:00.000Z');
  });

  it('keeps its hour table in step with its range list', () => {
    for (const range of SECURITY_TIME_RANGES) {
      assert.ok(SECURITY_TIME_RANGE_HOURS[range] > 0, range);
    }
  });
});

describe('MFA coverage', () => {
  it('counts over people who can actually sign in', () => {
    const coverage = mfaCoverage({ activeMembers: 10, membersWithConfirmedFactor: 7 });
    assert.equal(coverage.percent, 70);
    assert.equal(coverage.uncovered, 3);
  });

  it('floors rather than rounds', () => {
    // 249 of 250 must not display as 100% on a screen asking "is everybody covered".
    const coverage = mfaCoverage({ activeMembers: 250, membersWithConfirmedFactor: 249 });
    assert.equal(coverage.percent, 99);
    assert.equal(coverage.uncovered, 1);
  });

  it('reads as complete when there is nobody to cover', () => {
    const coverage = mfaCoverage({ activeMembers: 0, membersWithConfirmedFactor: 0 });
    assert.equal(coverage.percent, 100);
    assert.equal(coverage.uncovered, 0);
  });

  it('never reports more covered than there are people', () => {
    // A person can hold two factors. Coverage is people, not factors.
    const coverage = mfaCoverage({ activeMembers: 4, membersWithConfirmedFactor: 9 });
    assert.equal(coverage.percent, 100);
    assert.equal(coverage.uncovered, 0);
  });

  it('judges incomplete coverage against the company’s own policy', () => {
    // The approved documents set no MFA target. A company that does not require MFA is complying
    // with its own policy, and a red badge would be this module inventing a rule.
    assert.equal(
      mfaCoverageTone({ percent: 60, requireMfa: false, inGracePeriod: false }),
      'neutral',
    );
    assert.equal(mfaCoverageTone({ percent: 60, requireMfa: true, inGracePeriod: false }), 'bad');
    assert.equal(mfaCoverageTone({ percent: 60, requireMfa: true, inGracePeriod: true }), 'watch');
    assert.equal(mfaCoverageTone({ percent: 100, requireMfa: true, inGracePeriod: false }), 'good');
  });
});

describe('guest access', () => {
  const now = new Date('2026-09-11T00:00:00.000Z');
  const days = (n: number) => new Date(now.getTime() + n * 86_400_000);

  it('separates lapsed from expiring from neither', () => {
    const result = guestExpiry(
      [
        { guestAccessExpiresAt: days(-1) },
        { guestAccessExpiresAt: days(3) },
        { guestAccessExpiresAt: days(60) },
        { guestAccessExpiresAt: null },
      ],
      { now, withinDays: 30 },
    );
    assert.equal(result.total, 4);
    assert.equal(result.expired, 1);
    assert.equal(result.expiring, 1);
    assert.equal(result.noExpiry, 1);
  });

  it('counts access ending exactly now as lapsed', () => {
    const result = guestExpiry([{ guestAccessExpiresAt: now }], { now, withinDays: 30 });
    assert.equal(result.expired, 1);
    assert.equal(result.expiring, 0);
  });

  it('treats a guest with no end date as a problem', () => {
    // §23 requires guest access to be expiry-capable; an expiry nobody set is the case it exists
    // to prevent, so it does not read as a blank.
    assert.equal(guestTone({ expired: 0, expiring: 0, noExpiry: 1 }), 'bad');
    assert.equal(guestTone({ expired: 1, expiring: 0, noExpiry: 0 }), 'bad');
    assert.equal(guestTone({ expired: 0, expiring: 2, noExpiry: 0 }), 'watch');
    assert.equal(guestTone({ expired: 0, expiring: 0, noExpiry: 0 }), 'neutral');
  });
});

describe('SSO status', () => {
  it('says required-but-missing rather than a count', () => {
    // A company that requires SSO with nothing enabled cannot sign in. That is the first thing
    // the Security Center should say, and "0" does not say it.
    const result = ssoStatus({ connections: 1, enabledConnections: 0, requireSso: true });
    assert.equal(result.status, 'RequiredButNotConfigured');
    assert.equal(result.tone, 'bad');
  });

  it('distinguishes configured from enabled', () => {
    assert.equal(
      ssoStatus({ connections: 2, enabledConnections: 0, requireSso: false }).status,
      'Configured',
    );
    assert.equal(
      ssoStatus({ connections: 2, enabledConnections: 1, requireSso: false }).status,
      'Enabled',
    );
    assert.equal(
      ssoStatus({ connections: 0, enabledConnections: 0, requireSso: false }).status,
      'NotConfigured',
    );
  });

  it('reads as good when SSO is required and working', () => {
    const result = ssoStatus({ connections: 1, enabledConnections: 1, requireSso: true });
    assert.equal(result.status, 'Required');
    assert.equal(result.tone, 'good');
  });
});

describe('counts and support access', () => {
  it('sets no threshold it was not given', () => {
    // The approved documents state no tolerance for failed logins. One is enough to look at; the
    // screen's job is to surface, not to grade.
    assert.equal(countTone(0), 'neutral');
    assert.equal(countTone(1), 'watch');
    assert.equal(countTone(500), 'watch');
  });

  it('reads support access as live, historical or absent', () => {
    assert.equal(supportAccessTone({ active: 1, inWindow: 3 }), 'watch');
    assert.equal(supportAccessTone({ active: 0, inWindow: 3 }), 'neutral');
    assert.equal(supportAccessTone({ active: 0, inWindow: 0 }), 'good');
  });
});
