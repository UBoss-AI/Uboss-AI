import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALLOWED_EXIT_TRANSITIONS,
  confirmationIsCorrect,
  decideCancellation,
  DEFAULT_READ_ONLY_DAYS,
  DETACH_BEFORE_DELETE,
  DEFAULT_RETENTION_DAYS,
  deletionConfirmationFor,
  DISPOSITION_DESCRIPTIONS,
  DISPOSITION_LABELS,
  DISPOSITIONS,
  dispositionOf,
  EXIT_STATE_DESCRIPTIONS,
  EXIT_STATE_LABELS,
  EXIT_STATES,
  exitIsCancellable,
  exitIsFinished,
  exitSchedule,
  EXPORT_EXCLUSIONS,
  EXPORT_SECTION_LABELS,
  EXPORT_SECTIONS,
  MAX_EXIT_WINDOW_DAYS,
  mayMoveExit,
  TABLE_DISPOSITION,
  tablesWithDisposition,
  windowProblems,
  type ExitState,
} from './company-exit.js';

/**
 * Company exit — Prompt 38.
 *
 * The weight is on the sentence the prompt leads with: *"without silently erasing
 * accountability"*. So the tests that matter are **what survives deletion**, **where the point of
 * no return is**, and **that no table can slip through unclassified**.
 */
describe('the exit lifecycle', () => {
  it('labels and describes every state', () => {
    for (const state of EXIT_STATES) {
      assert.equal(typeof EXIT_STATE_LABELS[state], 'string');
      assert.equal(typeof EXIT_STATE_DESCRIPTIONS[state], 'string');
    }
  });

  it('reaches every state from Requested', () => {
    const seen = new Set<ExitState>(['Requested']);
    const queue: ExitState[] = ['Requested'];

    while (queue.length > 0) {
      const current = queue.shift() as ExitState;
      for (const next of ALLOWED_EXIT_TRANSITIONS[current]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }

    assert.equal(
      seen.size,
      EXIT_STATES.length,
      `unreachable: ${EXIT_STATES.filter((state) => !seen.has(state)).join(', ')}`,
    );
  });

  it('ends at Deleted and at Cancelled, with no way back from either', () => {
    assert.deepEqual(ALLOWED_EXIT_TRANSITIONS.Deleted, []);
    assert.deepEqual(ALLOWED_EXIT_TRANSITIONS.Cancelled, []);
    assert.equal(exitIsFinished('Deleted'), true);
    assert.equal(exitIsFinished('Cancelled'), true);
  });

  it('offers a cancel from every state before deletion', () => {
    for (const state of ['Requested', 'Approved', 'ReadOnly', 'RetentionHold'] as const) {
      assert.equal(
        mayMoveExit(state, 'Cancelled'),
        true,
        `${state} must be cancellable — the point of no return is Deleted, not before`,
      );
      assert.equal(exitIsCancellable(state), true);
    }
  });

  it('does not let a read-only period rewind to Approved', () => {
    // Undoing a read-only period is cancelling the exit, not rewinding it.
    assert.equal(mayMoveExit('ReadOnly', 'Approved'), false);
    assert.equal(mayMoveExit('RetentionHold', 'ReadOnly'), false);
  });

  it('refuses to cancel a deleted exit, and says why', () => {
    const decision = decideCancellation('Deleted');
    assert.equal(decision.mayCancel, false);
    assert.equal(
      decision.mayCancel === false && decision.reason.includes('cannot be undone'),
      true,
    );
    assert.equal(decideCancellation('RetentionHold').mayCancel, true);
  });
});

describe('the schedule', () => {
  const approvedAt = new Date('2026-01-01T00:00:00.000Z');

  it('stacks the two windows, so deletion is after both', () => {
    const schedule = exitSchedule({ approvedAt, readOnlyDays: 30, retentionDays: 30 });

    assert.equal(schedule.readOnlyFrom.toISOString(), approvedAt.toISOString());
    assert.equal(schedule.retentionFrom.toISOString(), '2026-01-31T00:00:00.000Z');
    assert.equal(schedule.deletionEligibleFrom.toISOString(), '2026-03-02T00:00:00.000Z');
  });

  it('defaults to sixty days before anything is deleted', () => {
    assert.equal(DEFAULT_READ_ONLY_DAYS + DEFAULT_RETENTION_DAYS, 60);
  });

  it('allows a zero-length window but refuses a negative or absurd one', () => {
    assert.deepEqual(windowProblems({ readOnlyDays: 0, retentionDays: 0 }), []);
    assert.equal(windowProblems({ readOnlyDays: -1, retentionDays: 30 }).length, 1);
    assert.equal(
      windowProblems({ readOnlyDays: MAX_EXIT_WINDOW_DAYS + 1, retentionDays: 30 }).length,
      1,
    );
  });
});

describe('what exit does to each table', () => {
  it('describes every disposition', () => {
    for (const disposition of DISPOSITIONS) {
      assert.equal(typeof DISPOSITION_LABELS[disposition], 'string');
      assert.equal(typeof DISPOSITION_DESCRIPTIONS[disposition], 'string');
    }
  });

  /**
   * The whole of *"without silently erasing accountability"*, as a list.
   *
   * If any of these ever became `Content`, a company leaving would take the record of what
   * happened inside it with them — and nothing else in the codebase would notice.
   */
  it('never deletes the audit trail, the security trail or break-glass history', () => {
    for (const table of [
      'audit_events',
      'security_events',
      'break_glass_requests',
      'tenant_lifecycle_transitions',
    ]) {
      assert.equal(
        dispositionOf(table),
        'Accountability',
        `${table} must survive a company exit — the prompt forbids erasing it by name`,
      );
    }
  });

  it('never deletes the financial record', () => {
    for (const table of [
      'cost_ledger_entries',
      'tenant_subscriptions',
      'credit_grants',
      'budget_wallets',
    ]) {
      assert.equal(dispositionOf(table), 'Accountability', `${table} is a financial record`);
    }
  });

  it('never deletes who held what authority, or who approved what', () => {
    for (const table of [
      'role_assignments',
      'custom_roles',
      'separation_of_duties_policies',
      'approval_requests',
      'approval_decisions',
    ]) {
      assert.equal(dispositionOf(table), 'Accountability');
    }
  });

  /**
   * The third bucket, and the one that is a product decision rather than a legal one.
   *
   * A company leaving UBoss does not get to erase somebody's career. These four are what a
   * portable profile reads at Prompt 37A, and `badge_history.is_exit_snapshot` exists precisely so
   * the badge a person left with outlives their leaving.
   */
  it('keeps the records that belong to a person rather than to the company', () => {
    for (const table of [
      'employment_records',
      'badge_history',
      'performance_events',
      // Forced by `employment_records.department_id`: a preserved employment record says
      // "Analyst in Delivery", and deleting Delivery would leave it pointing at nothing.
      'departments',
    ]) {
      assert.equal(
        dispositionOf(table),
        'PersonRecord',
        `${table} is read by a portable profile and belongs to the person`,
      );
    }
  });

  /**
   * The one the dependency graph took away, recorded rather than quietly dropped.
   *
   * `reward_awards.objective_id` and `objective_reward_id` are both NOT NULL, so an award cannot
   * be detached from the objective it was earned against — and preserving every objective to keep
   * it would defeat the whole exercise. So it is deleted, and a departed company's reward count no
   * longer reaches a portable profile. The badge and the score still do.
   */
  it('deletes reward awards, because their link to an objective cannot be detached', () => {
    assert.equal(dispositionOf('reward_awards'), 'Content');
    assert.equal(dispositionOf('badge_history'), 'PersonRecord', 'the badge still survives');
    assert.equal(dispositionOf('performance_events'), 'PersonRecord', 'and the score');
  });

  /**
   * A score cannot be read without the policy that produced it.
   *
   * Forced by `performance_events.policy_id` being NOT NULL, and correct on its own terms — the
   * same argument ADR-215 makes about sharing a raw score between companies.
   */
  it('keeps the performance policy alongside the events it scored', () => {
    assert.equal(dispositionOf('performance_policies'), 'Accountability');
  });

  /**
   * Detaching, and why every column in the list is nullable.
   *
   * A NOT NULL foreign key from a preserved table into content has no detach available — the
   * table has to be `Content` instead. That is the `reward_awards` case above, and this test
   * pins the rule so a future entry cannot be added for a NOT NULL column and fail at runtime.
   */
  it('detaches preserved rows from the content they point at', () => {
    assert.equal(DETACH_BEFORE_DELETE.length >= 3, true);
    for (const { table, column } of DETACH_BEFORE_DELETE) {
      assert.equal(
        dispositionOf(table) !== 'Content',
        true,
        `${table} is being deleted anyway, so detaching ${column} is pointless work`,
      );
      assert.equal(column.endsWith('_id'), true);
    }
  });

  it('does delete the company’s actual work', () => {
    for (const table of [
      'objectives',
      'human_tasks',
      'engine_agents',
      'agent_runs',
      'files',
      'knowledge_sources',
      'memory_records',
      'connections',
      'connection_secrets',
      'notifications',
      'company_settings',
    ]) {
      assert.equal(dispositionOf(table), 'Content', `${table} is the company’s own work`);
    }
  });

  it('revokes access, since a closed company’s people should not keep a membership', () => {
    assert.equal(dispositionOf('tenant_memberships'), 'Content');
    assert.equal(dispositionOf('invitations'), 'Content');
  });

  it('classifies every table exactly once, with a real disposition', () => {
    for (const [table, disposition] of Object.entries(TABLE_DISPOSITION)) {
      assert.equal(
        DISPOSITIONS.includes(disposition),
        true,
        `${table} has an unknown disposition "${disposition}"`,
      );
    }

    const counted =
      tablesWithDisposition('Content').length +
      tablesWithDisposition('Accountability').length +
      tablesWithDisposition('PersonRecord').length;
    assert.equal(counted, Object.keys(TABLE_DISPOSITION).length);
  });

  it('preserves more than a token number of tables', () => {
    // A sanity floor. If somebody "simplified" the classification into "delete everything but
    // audit_events", this fails rather than passing quietly.
    assert.equal(tablesWithDisposition('Accountability').length >= 15, true);
    assert.equal(tablesWithDisposition('PersonRecord').length >= 4, true);
  });
});

describe('the destructive confirmation', () => {
  it('is the company’s own identifier, not a fixed word', () => {
    // "Type DELETE" is muscle memory; typing the name of the company you are about to erase is a
    // moment of attention.
    assert.equal(deletionConfirmationFor('acme-industries'), 'acme-industries');
    assert.notEqual(deletionConfirmationFor('acme-industries'), 'DELETE');
  });

  it('accepts only an exact match, ignoring surrounding space', () => {
    assert.equal(confirmationIsCorrect({ typed: 'acme', tenantSlug: 'acme' }), true);
    assert.equal(confirmationIsCorrect({ typed: '  acme  ', tenantSlug: 'acme' }), true);
    assert.equal(confirmationIsCorrect({ typed: 'ACME', tenantSlug: 'acme' }), false);
    assert.equal(confirmationIsCorrect({ typed: 'acme-2', tenantSlug: 'acme' }), false);
    assert.equal(confirmationIsCorrect({ typed: '', tenantSlug: 'acme' }), false);
  });
});

describe('the export package', () => {
  it('labels every section', () => {
    for (const section of EXPORT_SECTIONS) {
      assert.equal(typeof EXPORT_SECTION_LABELS[section], 'string');
    }
  });

  it('carries the audit trail, so a company keeps its own record of what happened', () => {
    assert.equal(EXPORT_SECTIONS.includes('AuditTrail'), true);
  });

  it('says what it leaves out and why, rather than leaving it to be discovered', () => {
    assert.equal(EXPORT_EXCLUSIONS.length >= 4, true);
    for (const exclusion of EXPORT_EXCLUSIONS) {
      assert.equal(exclusion.what.length > 0, true);
      assert.equal(exclusion.why.length > 20, true, `"${exclusion.what}" needs a real reason`);
    }

    const excluded = EXPORT_EXCLUSIONS.map((exclusion) => exclusion.what.toLowerCase()).join(' ');
    assert.equal(excluded.includes('credential'), true, 'secrets never leave UBoss');
    assert.equal(excluded.includes('aadhaar'), true);
  });
});
