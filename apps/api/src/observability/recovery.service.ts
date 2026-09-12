import { Injectable, Logger } from '@nestjs/common';

import {
  DECISION_TREE,
  DEFAULT_RECOVERY_TARGETS,
  DEPLOYMENT_RESPONSIBILITIES,
  DRILL_CADENCE_DAYS,
  DRILL_CADENCE_RATIONALE,
  DRILL_STEPS,
  drillIsOverdue,
  RECOVERY_CLAIM_STANCE,
  RECOVERY_TARGET_SETTING_KEYS,
  REDIS_STANCE,
  rpoStatus,
  SECRETS_RECOVERY_ASSUMPTIONS,
  targetForTier,
  VERIFICATION_CHECKS,
  type RecoveryTarget,
} from '@uboss/types';

import { PlatformRepository } from '../persistence/platform.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';

/**
 * What UBoss can honestly say about its own recoverability — Prompt 41.
 *
 * ## Why this reports rather than orchestrates
 *
 * Taking a backup and restoring one are shell operations against a database server, run where the
 * server is: `infra/backup/pg-backup.sh` and `infra/backup/pg-restore-verify.sh`. An API endpoint
 * that ran `pg_dump` would need the application to hold owner credentials — and the whole reason
 * the application connects as `uboss_app` is that it must not.
 *
 * So the scripts do the work and this reads the evidence they leave. That division is also why the
 * evidence is a **file the drill writes**, not a row the API can invent: a status that could be
 * updated without a restore having happened is a status somebody will eventually update.
 *
 * ## What it will not say
 *
 * It will not report DR as ready. `RECOVERY_CLAIM_STANCE` is served verbatim, and the numbers
 * beside it are only ever "when a restore last succeeded and which checks it passed". Everything
 * else about disaster recovery — archiving, replication, key custody, DNS failover — is configured
 * where UBoss runs, and `DEPLOYMENT_RESPONSIBILITIES` names all of it so an operator can tell which
 * half they are looking at.
 */
@Injectable()
export class RecoveryService {
  private readonly logger = new Logger(RecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platform: PlatformRepository,
  ) {}

  /** The targets in force: the tier's defaults, overridden by platform settings where set. */
  async targets(): Promise<{ tier: string; rpoMinutes: number; rtoMinutes: number; source: string }> {
    const tier = (await this.setting(RECOVERY_TARGET_SETTING_KEYS.tier)) ?? 'growth';
    const fallback: RecoveryTarget =
      targetForTier(String(tier)) ?? (DEFAULT_RECOVERY_TARGETS[1] as RecoveryTarget);

    const rpo = await this.setting(RECOVERY_TARGET_SETTING_KEYS.rpoMinutes);
    const rto = await this.setting(RECOVERY_TARGET_SETTING_KEYS.rtoMinutes);

    const configured = typeof rpo === 'number' || typeof rto === 'number';

    return {
      tier: String(tier),
      rpoMinutes: typeof rpo === 'number' ? rpo : fallback.rpoMinutes,
      rtoMinutes: typeof rto === 'number' ? rto : fallback.rtoMinutes,
      // Said out loud, because "the default for your tier" and "what your contract says" are
      // different facts and an operator reading a target needs to know which one they have.
      source: configured ? 'configured' : `tier default (${fallback.tier})`,
    };
  }

  /**
   * The recovery position, as far as the application can see it.
   *
   * `verifiedAt` comes from the drill record. **When there is none, the answer is not "unknown" but
   * "not recoverable as far as anything can prove"** — and `rpoStatus` treats it as the worst case
   * rather than as a missing measurement, because a status page that showed a blank there would be
   * read as fine.
   */
  async position(input: { lastVerifiedAt?: string | null; now?: string } = {}): Promise<unknown> {
    const targets = await this.targets();
    const now = input.now ?? new Date().toISOString();
    const lastVerifiedAt = input.lastVerifiedAt ?? null;

    const rpo = rpoStatus({
      newestVerifiedAt: lastVerifiedAt,
      rpoMinutes: targets.rpoMinutes,
      now,
    });

    return {
      targets,
      lastVerifiedRestoreAt: lastVerifiedAt,
      rpo: {
        withinTarget: rpo.withinTarget,
        ageMinutes: rpo.ageMinutes,
        // `Infinity` does not survive JSON, and a null here would read as "no problem".
        breachMinutes: Number.isFinite(rpo.breachMinutes) ? rpo.breachMinutes : null,
        neverVerified: lastVerifiedAt === null,
      },
      drill: {
        cadenceDays: DRILL_CADENCE_DAYS,
        rationale: DRILL_CADENCE_RATIONALE,
        overdue: drillIsOverdue({ lastPassedAt: lastVerifiedAt, now }),
        steps: DRILL_STEPS,
      },
      verificationChecks: VERIFICATION_CHECKS,
      decisionTree: DECISION_TREE,
      deploymentResponsibilities: DEPLOYMENT_RESPONSIBILITIES,
      // Served verbatim. Each is a claim somebody would otherwise make on the product's behalf.
      claimStance: RECOVERY_CLAIM_STANCE,
      redisStance: REDIS_STANCE,
      secretsAssumptions: SECRETS_RECOVERY_ASSUMPTIONS,
      runbook: 'docs/RUNBOOK.md §11',
      scripts: {
        backup: 'infra/backup/pg-backup.sh',
        verify: 'infra/backup/pg-restore-verify.sh',
      },
    };
  }

  /**
   * What the database says about its own migration state.
   *
   * The one recovery-relevant fact the application genuinely owns, and the one a restore can get
   * wrong invisibly: a dump taken mid-migration restores to a schema no application version can
   * run against, and it looks perfectly healthy until the first query.
   *
   * **A rolled-back row is not an unfinished one.** A migration that failed and was resolved sits
   * in this table forever; counting it as in-flight makes the check cry wolf, which is how a check
   * gets ignored. That distinction was found by running the drill, not by reading the schema.
   */
  async schemaState(): Promise<{
    lastMigration: string | null;
    inFlight: number;
    rolledBack: number;
    healthy: boolean;
  }> {
    return this.prisma.runAsPlatformOperation(async () => {
      const rows = await this.prisma.client.$queryRawUnsafe<
        { migration_name: string; finished: boolean; rolled_back: boolean }[]
      >(
        `SELECT migration_name,
                finished_at IS NOT NULL AS finished,
                rolled_back_at IS NOT NULL AS rolled_back
           FROM _prisma_migrations
          ORDER BY started_at`,
      );

      const inFlight = rows.filter((row) => !row.finished && !row.rolled_back).length;
      const rolledBack = rows.filter((row) => row.rolled_back).length;
      const finished = rows.filter((row) => row.finished);

      return {
        lastMigration: finished[finished.length - 1]?.migration_name ?? null,
        inFlight,
        rolledBack,
        healthy: inFlight === 0 && finished.length > 0,
      };
    });
  }

  private async setting(key: string): Promise<unknown> {
    try {
      const row = await this.platform.findSetting(key);
      return row?.value;
    } catch (error) {
      // A recovery status that failed because a settings read failed would be the least useful
      // possible outcome. Fall back to the tier default and say so.
      this.logger.debug(
        `Could not read ${key}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return undefined;
    }
  }
}
