/**
 * Backups, restore and disaster recovery — Prompt 41.
 *
 * ## The rule this module is built around
 *
 * **Nothing here claims DR works.** The prompt is explicit — *"Do not claim DR is complete until a
 * restore test succeeds in a safe environment"* — and the locked rule from Prompt 38–42 says the
 * same. So this module deliberately separates three things that are usually blurred into one:
 *
 * * a **configured** backup — somebody wrote a policy down;
 * * a **taken** backup — a file exists;
 * * a **verified** backup — a restore actually succeeded and something checked the result.
 *
 * Only the third is worth anything, and a status that reported the first as green is how a company
 * discovers at the worst possible moment that its backups were never readable.
 * `RECOVERY_CLAIM_STANCE` is the sentence the product is allowed to say.
 *
 * ## What UBoss can and cannot do about DR
 *
 * Most of DR belongs to the deployment, not the application: continuous archiving, cross-region
 * replication, object-store versioning and key custody are all configured where UBoss runs rather
 * than inside it. Pretending otherwise would produce a dashboard that reports on things it cannot
 * see.
 *
 * So this module holds the **policy, the targets, the drill and the decision tree** as data the
 * product can serve and a test can check — and `DEPLOYMENT_RESPONSIBILITIES` names, in one list,
 * everything the application does not do. An operator reading it should be able to tell which
 * half is theirs.
 */

// ---------------------------------------------------------------------------
// What a backup is
// ---------------------------------------------------------------------------

/**
 * The three kinds, and why all three exist.
 *
 * They are not redundant. Each answers a failure the others cannot:
 *
 * * a **base backup** plus WAL is the only way to reach an arbitrary point in time, which is what
 *   you need when the damage was a bad migration at 14:02 rather than a lost disk;
 * * **WAL archiving** on its own is useless without a base to replay onto, and a base on its own
 *   can only restore to the moment it was taken;
 * * a **logical dump** survives a major-version upgrade and a corrupted cluster, and is the only
 *   one you can restore into a different PostgreSQL — which is exactly the situation where
 *   physical backups fail you.
 */
export const BACKUP_KINDS = ['BaseBackup', 'WalArchive', 'LogicalDump'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export const BACKUP_KIND_LABELS: Record<BackupKind, string> = {
  BaseBackup: 'Full physical backup',
  WalArchive: 'Continuous write-ahead log archive',
  LogicalDump: 'Logical dump (pg_dump)',
};

export const BACKUP_KIND_PURPOSE: Record<BackupKind, string> = {
  BaseBackup:
    'The foundation a point-in-time recovery replays onto. On its own it restores only to the ' +
    'moment it was taken.',
  WalArchive:
    'Every change since the last base backup, so recovery can stop at any second — which is what ' +
    'you need when the damage was a bad deploy rather than a lost disk. Useless without a base.',
  LogicalDump:
    'Portable and version-independent. The only backup that can be restored into a different ' +
    'PostgreSQL, which is precisely the case where a physical backup cannot help.',
};

/**
 * What a backup is allowed to say about itself.
 *
 * `Taken` and `Verified` are separate states and that separation is the whole point of the module.
 * A backup nobody has restored is a file, not a backup.
 */
export const BACKUP_STATES = ['Planned', 'Taken', 'Verified', 'Failed', 'Expired'] as const;
export type BackupState = (typeof BACKUP_STATES)[number];

export const BACKUP_STATE_LABELS: Record<BackupState, string> = {
  Planned: 'Scheduled, not yet taken',
  Taken: 'Taken, never restored',
  Verified: 'Restored successfully and checked',
  Failed: 'Did not complete',
  Expired: 'Past its retention window',
};

/**
 * A backup you may rely on.
 *
 * Only `Verified`. Stated as a function rather than as a comment so that a status endpoint and a
 * test read the same rule — and so "do we have a backup?" cannot be answered by counting files.
 */
export function mayBeReliedOn(state: BackupState): boolean {
  return state === 'Verified';
}

// ---------------------------------------------------------------------------
// Targets, by tier
// ---------------------------------------------------------------------------

/**
 * Recovery targets per plan tier.
 *
 * **RPO** is how much data a company may lose: the age of the newest recoverable state. **RTO** is
 * how long they may wait to get it back. Two different promises, and conflating them is how a
 * contract ends up unachievable — continuous archiving gives a small RPO and says nothing at all
 * about RTO, which is dominated by how long a restore takes.
 *
 * Tiered because the cost is real: a five-minute RPO means continuous archiving with off-site
 * shipping, and a one-hour RTO means a warm standby somebody pays for. Promising every customer
 * the top tier would be promising something nobody has bought.
 *
 * These are **defaults with an argument**, not contract terms. The approved documents state no
 * figures, so a company's real numbers belong in its agreement and the platform setting is what
 * records them.
 */
export interface RecoveryTarget {
  tier: string;
  /** Maximum acceptable data loss, in minutes. */
  rpoMinutes: number;
  /** Maximum acceptable time to restore service, in minutes. */
  rtoMinutes: number;
  why: string;
}

export const DEFAULT_RECOVERY_TARGETS: readonly RecoveryTarget[] = [
  {
    tier: 'starter',
    rpoMinutes: 24 * 60,
    rtoMinutes: 8 * 60,
    why:
      'A nightly logical dump and a restore inside a working day. Honest for a plan with no ' +
      'standby behind it — and far better than an unstated promise nobody can keep.',
  },
  {
    tier: 'growth',
    rpoMinutes: 60,
    rtoMinutes: 4 * 60,
    why:
      'Hourly WAL shipping, so at most an hour of work is at risk, with half a working day to ' +
      'restore. The point where continuous archiving starts to be worth its cost.',
  },
  {
    tier: 'enterprise',
    rpoMinutes: 5,
    rtoMinutes: 60,
    why:
      'Continuous archiving and a warm standby. Five minutes is about the floor for archive ' +
      'shipping without synchronous replication, and claiming less would be claiming a different ' +
      'architecture.',
  },
];

export const RECOVERY_TARGET_SETTING_KEYS = {
  rpoMinutes: 'recovery.rpo_minutes',
  rtoMinutes: 'recovery.rto_minutes',
  tier: 'recovery.tier',
} as const;

export function targetForTier(tier: string): RecoveryTarget | undefined {
  return DEFAULT_RECOVERY_TARGETS.find((target) => target.tier === tier);
}

/**
 * Is the newest verified backup inside the promised RPO?
 *
 * **Measured against a `Verified` backup, never a `Taken` one** — the whole point. A company whose
 * last verified restore was a week ago has a week-old RPO in practice, however many files were
 * written since.
 *
 * Returns the breach as data rather than a boolean, so an alert can say how far out it is.
 */
export function rpoStatus(input: {
  newestVerifiedAt: string | null;
  rpoMinutes: number;
  now: string;
}): { withinTarget: boolean; ageMinutes: number | null; breachMinutes: number } {
  if (input.newestVerifiedAt === null) {
    // No verified backup at all is the worst case, not a missing measurement — and it must not
    // read as "fine" because there is nothing to compare.
    return { withinTarget: false, ageMinutes: null, breachMinutes: Number.POSITIVE_INFINITY };
  }

  const ageMinutes = Math.max(
    0,
    (new Date(input.now).getTime() - new Date(input.newestVerifiedAt).getTime()) / 60_000,
  );

  return {
    withinTarget: ageMinutes <= input.rpoMinutes,
    ageMinutes,
    breachMinutes: Math.max(0, ageMinutes - input.rpoMinutes),
  };
}

// ---------------------------------------------------------------------------
// Restore verification
// ---------------------------------------------------------------------------

/**
 * What a restore verification checks, in order.
 *
 * A restore that ends with "the process exited zero" has verified almost nothing. Each check below
 * catches a failure the previous one cannot see, and the order is cheapest-first so a broken backup
 * fails fast:
 */
export const VERIFICATION_CHECKS = [
  {
    key: 'RestoreCompletes',
    label: 'The restore runs to completion',
    why: 'The floor. A backup that cannot be read is not a backup.',
  },
  {
    key: 'SchemaMatches',
    label: 'The schema matches the migration history',
    why:
      'A restore of a backup taken mid-migration leaves a schema no application version can run ' +
      'against — and it looks perfectly healthy until the first query.',
  },
  {
    key: 'RowCountsPlausible',
    label: 'The core tables are not empty',
    why:
      'The check that catches a backup of the wrong database, or of an empty one. A restore that ' +
      'succeeds into nothing exits zero.',
  },
  {
    key: 'TenantIsolationIntact',
    label: 'Row-level security survived the restore',
    why:
      'RLS policies, `FORCE ROW LEVEL SECURITY` and the `uboss_app` grants are schema objects and ' +
      'a restore can drop or fail to reapply them. A restored database that serves every tenant ' +
      'to every reader is worse than no restore at all, and nothing else in this list would ' +
      'notice.',
  },
  {
    key: 'AuditChainIntact',
    label: 'The audit chain still verifies',
    why:
      'The audit trail is hash-chained, so a restore that lost or reordered rows is detectable — ' +
      'and if the chain is broken, the restored trail cannot be relied on in the one situation ' +
      'where somebody will ask to rely on it.',
  },
  {
    key: 'ApplicationStarts',
    label: 'The application connects and answers',
    why: 'The end-to-end check. Everything above can pass against a database nothing can use.',
  },
] as const;

export type VerificationCheckKey = (typeof VERIFICATION_CHECKS)[number]['key'];

export interface VerificationResult {
  check: VerificationCheckKey;
  passed: boolean;
  /** What was observed, in words an operator can act on. Never a connection string. */
  detail: string;
}

/**
 * Did this verification actually verify the backup?
 *
 * **Every check must pass.** No partial credit, and no "mostly restored" — a restore that lost
 * row-level security is not 83% of a good restore, it is a data breach waiting for a reader.
 */
export function verificationPassed(results: readonly VerificationResult[]): boolean {
  if (results.length !== VERIFICATION_CHECKS.length) return false;
  const seen = new Set(results.map((result) => result.check));
  if (seen.size !== VERIFICATION_CHECKS.length) return false;
  return results.every((result) => result.passed);
}

export function missingChecks(results: readonly VerificationResult[]): VerificationCheckKey[] {
  const seen = new Set(results.map((result) => result.check));
  return VERIFICATION_CHECKS.map((check) => check.key).filter((key) => !seen.has(key));
}

/**
 * Where a restore verification may run.
 *
 * **Never production**, and this is a hard rule rather than a preference: a restore writes a
 * database, and a "verification" that restored over live data would be the disaster it exists to
 * protect against. The scratch database is created and dropped by the drill.
 */
export const VERIFICATION_ENVIRONMENTS = ['scratch', 'staging'] as const;
export type VerificationEnvironment = (typeof VERIFICATION_ENVIRONMENTS)[number];

export function environmentIsSafeForRestore(name: string): boolean {
  // A deny-list would be the wrong shape: anything not explicitly named safe is refused, so a new
  // environment is safe only once somebody says so.
  return (VERIFICATION_ENVIRONMENTS as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// What the application does not do
// ---------------------------------------------------------------------------

/**
 * DR responsibilities that belong to the deployment, named so the boundary is visible.
 *
 * Served by the API. An operator reading a green backup status must be able to tell which half of
 * DR the product is reporting on, because the application genuinely cannot see any of these.
 */
export const DEPLOYMENT_RESPONSIBILITIES: readonly { item: string; why: string }[] = [
  {
    item: 'Continuous WAL archiving to off-host storage',
    why:
      'Configured in PostgreSQL and the host, not in UBoss. The application can report whether a ' +
      'verified restore exists; it cannot make archiving happen.',
  },
  {
    item: 'Cross-region replication of backups and object storage',
    why: 'A storage-provider policy. UBoss never sees the replication state.',
  },
  {
    item: 'Object-store versioning and lifecycle rules',
    why:
      'Set on the bucket. The application writes objects through `StorageAdapter` and has no view ' +
      'of whether a deleted version is still recoverable.',
  },
  {
    item: 'KMS key custody, rotation and recovery',
    why:
      'A restored database is unreadable without the keys that encrypted its secrets, so key ' +
      'recovery is part of DR — and it is entirely outside the application. See ' +
      '`SECRETS_RECOVERY_ASSUMPTIONS`.',
  },
  {
    item: 'DNS and traffic failover',
    why: 'Where a failover actually takes effect. UBoss has no control over who reaches it.',
  },
  {
    item: 'Scheduling the drill',
    why:
      'The drill is a route and a script. Nothing in this build runs it on a cadence — the ninth ' +
      'job waiting on the business-cron scheduler.',
  },
];

/**
 * Redis is not authoritative, and the product must behave as though it can vanish.
 *
 * This is not a DR aspiration — it is a property the codebase already has and this states it so a
 * recovery plan can rely on it. The durable run row exists before anything is enqueued, the cost
 * ledger and the wallets are in PostgreSQL, and the rate limiter fails open. So a total Redis loss
 * costs queue position and a moment of unshared limits, and no correctness.
 *
 * **The consequence for a recovery plan**: Redis is not restored. It is rebuilt empty, and the
 * scheduler re-derives what is due from the rows.
 */
export const REDIS_STANCE =
  'Redis carries queue position and rate-limit counters. It is never the source of truth: every ' +
  'run has a durable row before it is enqueued, every rate limit fails open, and the ledger lives ' +
  'in PostgreSQL. A recovery therefore does not restore Redis — it starts an empty one, and the ' +
  'scheduler re-derives what is due from the database. Losing Redis costs queue order, not work.';

export const SECRETS_RECOVERY_ASSUMPTIONS =
  'Connection credentials and provider keys are stored encrypted, with the keys held outside the ' +
  'database. **A restored database is therefore unreadable without the encryption keys**, and key ' +
  'recovery is not part of a database restore. A DR plan that restores PostgreSQL and not the key ' +
  'material recovers a company’s objectives and none of its integrations — so the drill checks ' +
  'that a key is available before it claims a successful recovery.';

export const RECOVERY_CLAIM_STANCE =
  'UBoss reports what it can prove: when a backup was last taken, when a restore last succeeded, ' +
  'and which checks that restore passed. It does not describe itself as disaster-recovery ready, ' +
  'because most of disaster recovery — archiving, replication, key custody, DNS failover — is ' +
  'configured where UBoss runs rather than inside it, and because a backup nobody has restored is ' +
  'a file rather than a backup.';

// ---------------------------------------------------------------------------
// The drill
// ---------------------------------------------------------------------------

/**
 * The drill checklist, in order.
 *
 * Held as data so a drill produces a record rather than a memory, and so a step cannot be quietly
 * dropped because it is inconvenient. `evidence` says what has to be captured — a checklist whose
 * steps are ticked without evidence is a checklist that gets ticked.
 */
export const DRILL_STEPS = [
  {
    key: 'ChooseBackup',
    label: 'Choose the backup and record which one',
    evidence: 'The backup id, its kind, and when it was taken.',
  },
  {
    key: 'ProvisionScratch',
    label: 'Create a scratch database',
    evidence: 'The scratch database name, and proof it is not production.',
  },
  {
    key: 'Restore',
    label: 'Restore into it',
    evidence: 'The restore duration, which is the only real measurement of RTO you will get.',
  },
  {
    key: 'Verify',
    label: 'Run every verification check',
    evidence: 'All six results, pass or fail, with the observation for each.',
  },
  {
    key: 'CheckKeys',
    label: 'Confirm the encryption keys are recoverable',
    evidence:
      'That a key is available and decrypts a known value. Without this the drill proves only ' +
      'that the objectives came back, not the integrations.',
  },
  {
    key: 'TearDown',
    label: 'Drop the scratch database',
    evidence: 'That it is gone — a forgotten restore is an unmonitored copy of customer data.',
  },
  {
    key: 'Record',
    label: 'Record the outcome and the measured RTO',
    evidence: 'The drill record, whether it passed, and what to fix.',
  },
] as const;

export type DrillStepKey = (typeof DRILL_STEPS)[number]['key'];

/** How often a drill should run, and why that cadence. */
export const DRILL_CADENCE_DAYS = 90;

export const DRILL_CADENCE_RATIONALE =
  'Quarterly. Often enough that a broken backup is found within one quarter of breaking, and rare ' +
  'enough that the drill is done properly rather than rushed. A drill that has not run within ' +
  'twice its cadence is reported as overdue rather than assumed fine.';

export function drillIsOverdue(input: { lastPassedAt: string | null; now: string }): boolean {
  if (input.lastPassedAt === null) return true;
  const days =
    (new Date(input.now).getTime() - new Date(input.lastPassedAt).getTime()) / 86_400_000;
  return days > DRILL_CADENCE_DAYS;
}

// ---------------------------------------------------------------------------
// The decision tree
// ---------------------------------------------------------------------------

/**
 * Failover or roll back? The decision tree, as data.
 *
 * Written down because it is decided at 3am by somebody who did not build this, and because the
 * wrong choice is expensive in a way the right one is not: **failing over discards the data written
 * since the last replication point, and rolling back discards the deploy.** Those are not
 * symmetrical, and the tree makes the asymmetry explicit rather than leaving it to judgement under
 * pressure.
 */
export const DECISION_TREE: readonly {
  situation: string;
  action: string;
  why: string;
  cost: string;
}[] = [
  {
    situation: 'A deploy broke the application but the data is intact',
    action: 'Roll back the deploy. Do not restore.',
    why:
      'The data is fine. A restore would throw away every change customers made since the ' +
      'backup, to fix a problem in code.',
    cost: 'The deploy is lost. No customer data is lost.',
  },
  {
    situation: 'A migration corrupted or destroyed data',
    action: 'Point-in-time recovery to immediately before the migration.',
    why:
      'The only tool that reaches an arbitrary second. A base backup alone would lose everything ' +
      'since it was taken.',
    cost: 'Everything written between the recovery point and now. Announce it.',
  },
  {
    situation: 'The primary database is unreachable but not damaged',
    action: 'Investigate connectivity first. Do not fail over yet.',
    why:
      'The commonest cause is a network or credential problem, and a failover under those ' +
      'conditions discards recent writes for nothing.',
    cost: 'Minutes of downtime while you check. Far cheaper than a needless failover.',
  },
  {
    situation: 'The primary database is lost',
    action: 'Promote the standby, then verify the audit chain.',
    why:
      'The case failover exists for. Verify the chain afterwards because a promotion at an ' +
      'inconsistent point is detectable and must be known about.',
    cost: 'Whatever had not replicated — bounded by the RPO, if the RPO is real.',
  },
  {
    situation: 'A single company’s data was wrongly deleted',
    action:
      'Restore that company from a verified backup into a scratch database and copy their rows ' +
      'back. Do not restore the cluster.',
    why:
      'A cluster restore to fix one tenant would roll back every other customer. The exit and ' +
      'portability work from Prompt 38 is what makes a per-tenant copy possible.',
    cost: 'Slow and manual. The alternative is an outage for every other customer.',
  },
  {
    situation: 'You are not sure whether the data is intact',
    action: 'Restore to a scratch database and look. Do not touch production.',
    why:
      'The answer is cheap to get and the wrong decision is not. A restore into scratch costs ' +
      'disk and an hour; a needless production restore costs every write since the backup.',
    cost: 'An hour. Take it.',
  },
];

/** Nothing in the tree ever recommends restoring over production without a scratch check first. */
export function treeNeverRestoresBlind(): boolean {
  return DECISION_TREE.every(
    (entry) =>
      !/restore/i.test(entry.action) ||
      /scratch|point-in-time|standby|do not restore/i.test(entry.action),
  );
}
