import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BACKUP_KIND_LABELS,
  BACKUP_KIND_PURPOSE,
  BACKUP_KINDS,
  BACKUP_STATE_LABELS,
  BACKUP_STATES,
  DECISION_TREE,
  DEFAULT_RECOVERY_TARGETS,
  DEPLOYMENT_RESPONSIBILITIES,
  DRILL_CADENCE_DAYS,
  DRILL_CADENCE_RATIONALE,
  DRILL_STEPS,
  drillIsOverdue,
  environmentIsSafeForRestore,
  mayBeReliedOn,
  missingChecks,
  RECOVERY_CLAIM_STANCE,
  RECOVERY_TARGET_SETTING_KEYS,
  REDIS_STANCE,
  rpoStatus,
  SECRETS_RECOVERY_ASSUMPTIONS,
  targetForTier,
  treeNeverRestoresBlind,
  VERIFICATION_CHECKS,
  VERIFICATION_ENVIRONMENTS,
  verificationPassed,
  type VerificationResult,
} from './disaster-recovery.js';

const allChecks = (passed: boolean): VerificationResult[] =>
  VERIFICATION_CHECKS.map((check) => ({
    check: check.key,
    passed,
    detail: passed ? 'fine' : 'not fine',
  }));

describe('a backup is only worth what a restore proved', () => {
  it('relies on a Verified backup and on nothing else', () => {
    // The distinction the whole module exists to draw. A `Taken` backup is a file; a status that
    // reported it as green is how a company discovers at the worst moment that its backups were
    // never readable.
    assert.equal(mayBeReliedOn('Verified'), true);
    for (const state of BACKUP_STATES.filter((entry) => entry !== 'Verified')) {
      assert.equal(mayBeReliedOn(state), false, state);
    }
  });

  it('keeps Taken and Verified as separate states', () => {
    assert.ok(BACKUP_STATES.includes('Taken'));
    assert.ok(BACKUP_STATES.includes('Verified'));
    for (const state of BACKUP_STATES) {
      assert.ok(BACKUP_STATE_LABELS[state].length > 0, state);
    }
  });

  it('explains why each backup kind exists rather than listing three', () => {
    // They are not redundant: each answers a failure the others cannot.
    assert.deepEqual([...BACKUP_KINDS], ['BaseBackup', 'WalArchive', 'LogicalDump']);
    for (const kind of BACKUP_KINDS) {
      assert.ok(BACKUP_KIND_LABELS[kind].length > 0, kind);
      assert.ok(BACKUP_KIND_PURPOSE[kind].length > 60, `${kind} has no argument`);
    }
    // The one people forget: WAL alone restores nothing.
    assert.match(BACKUP_KIND_PURPOSE.WalArchive, /useless without a base/i);
    // And the one that saves you when the cluster itself is gone.
    assert.match(BACKUP_KIND_PURPOSE.LogicalDump, /different postgresql/i);
  });
});

describe('recovery targets', () => {
  it('gives every tier both numbers and a reason', () => {
    for (const target of DEFAULT_RECOVERY_TARGETS) {
      assert.ok(target.rpoMinutes > 0, target.tier);
      assert.ok(target.rtoMinutes > 0, target.tier);
      assert.ok(target.why.length > 60, `${target.tier} has no argument`);
    }
  });

  it('tightens as the tier rises', () => {
    // A tier that promised less than the one below it would be a pricing table nobody could
    // explain.
    const tiers = [...DEFAULT_RECOVERY_TARGETS];
    for (let index = 1; index < tiers.length; index += 1) {
      assert.ok(
        (tiers[index]?.rpoMinutes ?? 0) < (tiers[index - 1]?.rpoMinutes ?? 0),
        'RPO must tighten',
      );
      assert.ok(
        (tiers[index]?.rtoMinutes ?? 0) < (tiers[index - 1]?.rtoMinutes ?? 0),
        'RTO must tighten',
      );
    }
  });

  it('keeps RPO and RTO as different promises', () => {
    // Conflating them is how a contract becomes unachievable: continuous archiving gives a small
    // RPO and says nothing at all about RTO.
    for (const target of DEFAULT_RECOVERY_TARGETS) {
      assert.notEqual(target.rpoMinutes, target.rtoMinutes, target.tier);
    }
    assert.equal(Object.keys(RECOVERY_TARGET_SETTING_KEYS).length, 3);
  });

  it('finds a tier and shrugs at one it does not know', () => {
    assert.equal(targetForTier('enterprise')?.rpoMinutes, 5);
    assert.equal(targetForTier('nonsense'), undefined);
  });
});

describe('measuring RPO against what was actually verified', () => {
  const now = '2026-09-16T12:00:00.000Z';

  it('reports a recent verified backup as within target', () => {
    const status = rpoStatus({
      newestVerifiedAt: '2026-09-16T11:30:00.000Z',
      rpoMinutes: 60,
      now,
    });
    assert.equal(status.withinTarget, true);
    assert.equal(status.ageMinutes, 30);
    assert.equal(status.breachMinutes, 0);
  });

  it('reports how far out a stale one is, not merely that it is', () => {
    const status = rpoStatus({
      newestVerifiedAt: '2026-09-16T09:00:00.000Z',
      rpoMinutes: 60,
      now,
    });
    assert.equal(status.withinTarget, false);
    assert.equal(status.breachMinutes, 120);
  });

  it('treats no verified backup as the worst case, not as a missing measurement', () => {
    // The failure mode this exists to prevent: "we have no verified restore" reading as "fine,
    // nothing to compare".
    const status = rpoStatus({ newestVerifiedAt: null, rpoMinutes: 60, now });
    assert.equal(status.withinTarget, false);
    assert.equal(status.ageMinutes, null);
    assert.equal(status.breachMinutes, Number.POSITIVE_INFINITY);
  });

  it('does not report a negative age when the clock disagrees', () => {
    const status = rpoStatus({
      newestVerifiedAt: '2026-09-16T13:00:00.000Z',
      rpoMinutes: 60,
      now,
    });
    assert.equal(status.ageMinutes, 0);
    assert.equal(status.withinTarget, true);
  });
});

describe('verification', () => {
  it('checks the six things, each for a reason the others do not cover', () => {
    assert.equal(VERIFICATION_CHECKS.length, 6);
    for (const check of VERIFICATION_CHECKS) {
      assert.ok(check.why.length > 40, `${check.key} has no argument`);
    }
    const keys = VERIFICATION_CHECKS.map((check) => check.key);
    // The one nothing else would notice: a restore that lost row-level security passes every
    // other check on the list.
    assert.ok(keys.includes('TenantIsolationIntact'));
    assert.ok(keys.includes('AuditChainIntact'));
  });

  it('passes only when every check passed', () => {
    assert.equal(verificationPassed(allChecks(true)), true);
    assert.equal(verificationPassed(allChecks(false)), false);
  });

  it('gives no partial credit', () => {
    // A restore that lost RLS is not 83% of a good restore.
    const mostly = allChecks(true).map((result) =>
      result.check === 'TenantIsolationIntact' ? { ...result, passed: false } : result,
    );
    assert.equal(verificationPassed(mostly), false);
  });

  it('refuses a verification that skipped a check', () => {
    // Otherwise a run that quietly dropped the expensive check would report success.
    const partial = allChecks(true).slice(0, 3);
    assert.equal(verificationPassed(partial), false);
    assert.equal(missingChecks(partial).length, 3);
  });

  it('refuses a verification that repeated one check instead of running six', () => {
    const first = allChecks(true)[0] as VerificationResult;
    assert.equal(verificationPassed([first, first, first, first, first, first]), false);
  });

  it('will not restore anywhere but a scratch or staging database', () => {
    // An allow-list, not a deny-list: a new environment is safe only once somebody says so.
    for (const environment of VERIFICATION_ENVIRONMENTS) {
      assert.equal(environmentIsSafeForRestore(environment), true, environment);
    }
    for (const unsafe of ['production', 'prod', 'live', 'uboss_dev', '']) {
      assert.equal(environmentIsSafeForRestore(unsafe), false, unsafe);
    }
  });
});

describe('the drill', () => {
  it('has a step for each thing that must be evidenced', () => {
    const keys = DRILL_STEPS.map((step) => step.key);
    for (const expected of ['ChooseBackup', 'Restore', 'Verify', 'CheckKeys', 'TearDown']) {
      assert.ok(keys.includes(expected as never), `${expected} is missing`);
    }
    for (const step of DRILL_STEPS) {
      assert.ok(step.evidence.length > 20, `${step.key} says what to do and not what to capture`);
    }
  });

  it('checks the encryption keys, not only the database', () => {
    // A DR plan that restores PostgreSQL and not the key material recovers a company's objectives
    // and none of its integrations.
    const keys = DRILL_STEPS.find((step) => step.key === 'CheckKeys');
    assert.match(keys?.evidence ?? '', /integrations/i);
  });

  it('tears the scratch database down', () => {
    const teardown = DRILL_STEPS.find((step) => step.key === 'TearDown');
    assert.match(teardown?.evidence ?? '', /unmonitored copy/i);
  });

  it('treats a drill that has never passed as overdue', () => {
    assert.equal(drillIsOverdue({ lastPassedAt: null, now: '2026-09-16T00:00:00Z' }), true);
  });

  it('treats a recent drill as current and an old one as overdue', () => {
    assert.equal(
      drillIsOverdue({ lastPassedAt: '2026-08-16T00:00:00Z', now: '2026-09-16T00:00:00Z' }),
      false,
    );
    assert.equal(
      drillIsOverdue({ lastPassedAt: '2026-01-16T00:00:00Z', now: '2026-09-16T00:00:00Z' }),
      true,
    );
    assert.equal(DRILL_CADENCE_DAYS, 90);
    assert.ok(DRILL_CADENCE_RATIONALE.length > 80);
  });
});

describe('the decision tree', () => {
  it('gives every situation an action, a reason and a cost', () => {
    // The cost is the part that matters at 3am: failing over and rolling back are not
    // symmetrical, and the tree has to say so rather than leave it to judgement under pressure.
    assert.ok(DECISION_TREE.length >= 5);
    for (const entry of DECISION_TREE) {
      assert.ok(entry.situation.length > 20);
      assert.ok(entry.action.length > 10);
      assert.ok(entry.why.length > 40, `"${entry.situation}" has no reason`);
      assert.ok(entry.cost.length > 10, `"${entry.situation}" does not say what it costs`);
    }
  });

  it('never restores blind over production', () => {
    assert.equal(treeNeverRestoresBlind(), true);
  });

  it('does not restore to fix a broken deploy', () => {
    // The commonest wrong instinct: the data is fine, and a restore would throw away every change
    // customers made since the backup to fix a problem in code.
    const deploy = DECISION_TREE.find((entry) => /deploy broke/i.test(entry.situation));
    assert.match(deploy?.action ?? '', /roll back/i);
    assert.match(deploy?.action ?? '', /do not restore/i);
  });

  it('does not fail over on an unreachable-but-undamaged database', () => {
    const unreachable = DECISION_TREE.find((entry) => /unreachable/i.test(entry.situation));
    assert.match(unreachable?.action ?? '', /do not fail over yet/i);
  });

  it('restores one company without rolling back everybody else', () => {
    const single = DECISION_TREE.find((entry) => /single company/i.test(entry.situation));
    assert.match(single?.action ?? '', /scratch/i);
    assert.match(single?.action ?? '', /do not restore the cluster/i);
  });

  it('says to look before touching production when the damage is unclear', () => {
    const unsure = DECISION_TREE.find((entry) => /not sure/i.test(entry.situation));
    assert.match(unsure?.action ?? '', /scratch/i);
  });
});

describe('what the product is allowed to claim', () => {
  it('does not describe itself as disaster-recovery ready', () => {
    assert.match(RECOVERY_CLAIM_STANCE, /does not describe itself/i);
    assert.match(RECOVERY_CLAIM_STANCE, /a file rather than a backup/i);
  });

  it('names what belongs to the deployment, with a reason each', () => {
    assert.ok(DEPLOYMENT_RESPONSIBILITIES.length >= 5);
    for (const entry of DEPLOYMENT_RESPONSIBILITIES) {
      assert.ok(entry.why.length > 40, `${entry.item} has no explanation`);
    }
    const items = DEPLOYMENT_RESPONSIBILITIES.map((entry) => entry.item.toLowerCase()).join(' | ');
    for (const expected of ['archiv', 'replication', 'kms', 'dns']) {
      assert.ok(items.includes(expected), `${expected} is not named as somebody else's`);
    }
  });

  it('says Redis is never the source of truth, and what that means for a recovery', () => {
    assert.match(REDIS_STANCE, /never the source of truth/i);
    // The operational consequence, which is the part a recovery plan needs.
    assert.match(REDIS_STANCE, /does not restore Redis/i);
  });

  it('says a restored database is unreadable without its keys', () => {
    // The gap that turns a "successful" recovery into a company with its objectives back and none
    // of its integrations.
    assert.match(SECRETS_RECOVERY_ASSUMPTIONS, /unreadable without the encryption keys/i);
    assert.match(SECRETS_RECOVERY_ASSUMPTIONS, /not part of a database restore/i);
  });
});
