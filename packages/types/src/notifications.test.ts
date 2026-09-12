import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ALWAYS_MANDATORY_KINDS,
  isMandatoryNotification,
  NOTIFICATION_KIND_DEFINITIONS,
  NOTIFICATION_KINDS,
  notificationDedupeKey,
  notificationKind,
  SEVERITY_TONES,
  utcDay,
} from './notifications.js';

/*
 * These are unit tests in the shared package on purpose. `isMandatoryNotification` is asked by
 * **both** the engine (deciding delivery) and the preference screen (deciding what to disable),
 * so it is the one function whose answer must be identical in two places — and the cheapest place
 * to prove that is where it lives.
 */

test('the catalogue is exactly the client’s six initial sources', () => {
  assert.equal(NOTIFICATION_KINDS.length, 6);
  assert.equal(NOTIFICATION_KIND_DEFINITIONS.length, 6);

  const kinds = NOTIFICATION_KIND_DEFINITIONS.map((definition) => definition.kind);
  assert.deepEqual(new Set(kinds).size, 6, 'no duplicate kinds');
  for (const kind of NOTIFICATION_KINDS) {
    assert.ok(kinds.includes(kind), kind);
  }
});

test('every kind has a severity tone, a label and a stated producer', () => {
  for (const definition of NOTIFICATION_KIND_DEFINITIONS) {
    assert.ok(definition.label.length > 0, definition.kind);
    assert.ok(definition.description.length > 0, definition.kind);
    assert.ok(definition.producedBy.length > 0, definition.kind);
    assert.ok(definition.module.length > 0, definition.kind);
  }
  assert.deepEqual(Object.keys(SEVERITY_TONES).sort(), ['Critical', 'Info', 'Warning']);
});

test('security alerts are mandatory at every severity', () => {
  assert.deepEqual([...ALWAYS_MANDATORY_KINDS], ['SecurityEvent']);

  for (const severity of ['Info', 'Warning', 'Critical'] as const) {
    assert.equal(
      isMandatoryNotification({ kind: 'SecurityEvent', severity }),
      true,
      `SecurityEvent at ${severity}`,
    );
  }
});

test('a critical alert of any kind is mandatory, and a warning is not', () => {
  for (const kind of NOTIFICATION_KINDS) {
    assert.equal(isMandatoryNotification({ kind, severity: 'Critical' }), true, kind);
  }

  // Everything except the always-mandatory kind is optional below critical. This is the half of
  // the rule a preference screen relies on: it must offer real choices for the rest.
  for (const kind of NOTIFICATION_KINDS.filter((k) => k !== 'SecurityEvent')) {
    assert.equal(isMandatoryNotification({ kind, severity: 'Warning' }), false, kind);
    assert.equal(isMandatoryNotification({ kind, severity: 'Info' }), false, kind);
  }
});

test('only escalating kinds name an escalation window', () => {
  for (const definition of NOTIFICATION_KIND_DEFINITIONS) {
    if (definition.escalatesAfterSetting !== null) {
      // The window comes from a real company setting, not a constant here.
      assert.match(definition.escalatesAfterSetting, /^notifications\./, definition.kind);
    }
  }

  // A budget threshold is information, not a task somebody is failing to do, so it does not
  // escalate to their manager.
  assert.equal(notificationKind('BudgetThreshold')?.escalatesAfterSetting, null);
  assert.equal(notificationKind('SecurityEvent')?.escalatesAfterSetting, null);
  assert.equal(
    notificationKind('ApprovalWaiting')?.escalatesAfterSetting,
    'notifications.escalate_after_hours',
  );
});

test('an unknown kind resolves to undefined rather than a guess', () => {
  assert.equal(notificationKind('Invented'), undefined);
  assert.equal(notificationKind(''), undefined);
});

test('the dedupe keys differ in exactly the way the two cases need', () => {
  // An approval: **no time component.** One notification per approval per person, however many
  // times a queue re-runs.
  assert.equal(notificationDedupeKey.approvalWaiting('A-1'), 'approval:A-1');
  assert.equal(notificationDedupeKey.approvalWaiting('A-1'), 'approval:A-1');

  // Overdue work: **per day.** Still not done tomorrow is new information; a key without the
  // date would notify once and then stay silent for ever.
  const monday = utcDay(new Date('2026-09-07T23:59:00Z'));
  const tuesday = utcDay(new Date('2026-09-08T00:01:00Z'));
  assert.notEqual(
    notificationDedupeKey.overdue('T-1', monday),
    notificationDedupeKey.overdue('T-1', tuesday),
  );

  // A budget threshold: per threshold, so 80% and 100% both notify and neither repeats.
  assert.notEqual(
    notificationDedupeKey.budgetThreshold('S-1', 80),
    notificationDedupeKey.budgetThreshold('S-1', 100),
  );

  // A connection: per state, so "expiring" and "expired" are two notifications.
  assert.notEqual(
    notificationDedupeKey.connectionExpiry('C-1', 'Expiring'),
    notificationDedupeKey.connectionExpiry('C-1', 'Expired'),
  );

  // An escalation is keyed to what it escalated **and** to whom, so escalating the same item to
  // two managers notifies both.
  assert.notEqual(
    notificationDedupeKey.escalation('N-1', 'U-1'),
    notificationDedupeKey.escalation('N-1', 'U-2'),
  );
});

test('utcDay is a UTC calendar day, not a local one', () => {
  // A local-time day would give two people in different time zones different dedupe keys for the
  // same overdue task, and one of them would be notified twice.
  assert.equal(utcDay(new Date('2026-09-09T00:00:00Z')), '2026-09-09');
  assert.equal(utcDay(new Date('2026-09-09T23:59:59Z')), '2026-09-09');
  assert.equal(utcDay(new Date('2026-09-10T00:00:00Z')), '2026-09-10');
});
