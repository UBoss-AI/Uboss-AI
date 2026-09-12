import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { DEFAULT_RECOVERY_TARGETS, RECOVERY_TARGET_SETTING_KEYS } from '@uboss/types';

import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { RecoveryService } from '../src/observability/recovery.service.js';
import {
  closeTestContext,
  createTestContext,
  isTestDatabaseReachable,
  migrateTestDatabase,
  reachabilityFailureReason,
  resetTestDatabase,
  type TestContext,
} from './support/test-database.js';

/**
 * Recovery reporting — Prompt 41, against real PostgreSQL.
 *
 * The scripts are what perform a backup and a restore, and they have been run for real: the drill
 * record and the verification evidence live in `infra/backup/evidence/`. What this suite covers is
 * the part that runs inside the application — **what UBoss is willing to say about its own
 * recoverability**, which is where an overstatement would actually reach somebody.
 *
 * The tests that matter are the ones that check it refuses to overstate: no verified restore reads
 * as the worst case rather than as a blank, and the claim stance is served verbatim rather than
 * summarised into something reassuring.
 */
describe('recovery reporting (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  before(async () => {
    ctx = createTestContext();
    if (!(await isTestDatabaseReachable(ctx))) {
      throw new Error(
        `The test database is not reachable: ${reachabilityFailureReason()}\n` +
          'Start it with:\n' +
          '  docker compose -f infra/docker-compose.yml up -d',
      );
    }
    migrateTestDatabase();
    delete process.env['NODE_ENV'];

    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        PlatformRepository,
        RecoveryService,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  after(async () => {
    await app.close();
    await closeTestContext(ctx);
  });

  /**
   * The fake migration rows have to be removed by hand, and the reason is worth recording.
   *
   * `resetTestDatabase` truncates the application's tables. It does **not** touch
   * `_prisma_migrations`, which is Prisma's own bookkeeping — so a row left there survives every
   * reset, and a row with no `finished_at` makes `migrate deploy` refuse with P3009 for **every
   * subsequent suite in the run**.
   *
   * Found by running the next suite along: this spec passed on its own and broke observability,
   * knowledge, and everything after it. A test that pollutes shared state it does not own is a
   * test that fails somebody else's work, and the failure looks nothing like its cause.
   */
  const clearFakeMigrations = async (): Promise<void> => {
    await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.$executeRawUnsafe(
        "DELETE FROM _prisma_migrations WHERE migration_name LIKE '000000000000%'",
      ),
    );
  };

  beforeEach(async () => {
    await resetTestDatabase(ctx);
    await clearFakeMigrations();
  });

  afterEach(async () => {
    // Also after, not only before: a failure between the insert and the end of a test would
    // otherwise leave the row for the next suite rather than for the next test in this one.
    await clearFakeMigrations();
  });

  const recovery = () => app.get(RecoveryService);

  // =========================================================================
  describe('targets', () => {
    it('falls back to the tier default and says that is what it did', async () => {
      const targets = await recovery().targets();
      // Not merely the numbers: "the default for your tier" and "what your contract says" are
      // different facts, and an operator reading a target needs to know which one they have.
      assert.match(targets.source, /tier default/);
      assert.ok(targets.rpoMinutes > 0);
      assert.ok(targets.rtoMinutes > 0);
    });

    it('uses a configured value over the default, and reports the change', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.platformSetting.create({
          data: {
            key: RECOVERY_TARGET_SETTING_KEYS.rpoMinutes,
            value: 15,
            section: 'Recovery',
            description: 'Set by a test.',
          },
        }),
      );

      const targets = await recovery().targets();
      assert.equal(targets.rpoMinutes, 15);
      assert.equal(targets.source, 'configured');
    });

    it('follows the tier when one is set', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.platformSetting.create({
          data: {
            key: RECOVERY_TARGET_SETTING_KEYS.tier,
            value: 'enterprise',
            section: 'Recovery',
            description: 'Set by a test.',
          },
        }),
      );

      const targets = await recovery().targets();
      const enterprise = DEFAULT_RECOVERY_TARGETS.find((entry) => entry.tier === 'enterprise');
      assert.equal(targets.tier, 'enterprise');
      assert.equal(targets.rpoMinutes, enterprise?.rpoMinutes);
    });
  });

  // =========================================================================
  describe('what it reports about recoverability', () => {
    it('treats no verified restore as the worst case, not as a blank', async () => {
      // **The most important test here.** A status page that showed nothing where the evidence
      // should be would be read as "fine", and the whole module exists to prevent exactly that.
      const position = (await recovery().position()) as {
        rpo: { withinTarget: boolean; neverVerified: boolean; breachMinutes: number | null };
        drill: { overdue: boolean };
      };

      assert.equal(position.rpo.neverVerified, true);
      assert.equal(position.rpo.withinTarget, false);
      // `Infinity` does not survive JSON and a null here must not read as "no problem" — it is
      // paired with `neverVerified: true`, which is unambiguous.
      assert.equal(position.rpo.breachMinutes, null);
      assert.equal(position.drill.overdue, true);
    });

    it('reports a recent verified restore as within target', async () => {
      const position = (await recovery().position({
        lastVerifiedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        now: new Date().toISOString(),
      })) as { rpo: { withinTarget: boolean; neverVerified: boolean }; drill: { overdue: boolean } };

      assert.equal(position.rpo.neverVerified, false);
      assert.equal(position.rpo.withinTarget, true);
      assert.equal(position.drill.overdue, false);
    });

    it('reports an old verified restore as a breach with a figure', async () => {
      const position = (await recovery().position({
        lastVerifiedAt: new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(),
        now: new Date().toISOString(),
      })) as { rpo: { withinTarget: boolean; breachMinutes: number | null } };

      assert.equal(position.rpo.withinTarget, false);
      assert.ok((position.rpo.breachMinutes ?? 0) > 0);
    });

    it('calls the drill overdue past its cadence', async () => {
      const position = (await recovery().position({
        lastVerifiedAt: new Date(Date.now() - 200 * 24 * 3_600_000).toISOString(),
        now: new Date().toISOString(),
      })) as { drill: { overdue: boolean; cadenceDays: number } };

      assert.equal(position.drill.overdue, true);
      assert.equal(position.drill.cadenceDays, 90);
    });
  });

  // =========================================================================
  describe('what it refuses to claim', () => {
    it('never describes itself as disaster-recovery ready', async () => {
      const position = (await recovery().position({
        lastVerifiedAt: new Date().toISOString(),
      })) as Record<string, unknown>;

      const serialised = JSON.stringify(position).toLowerCase();
      // Even with a fresh verified restore. The claim stance is the sentence the product is
      // allowed to say, and "ready" is not in it.
      assert.equal(serialised.includes('"ready":true'), false);
      assert.match(String(position['claimStance']), /does not describe itself/i);
    });

    it('names what belongs to the deployment rather than implying it covers everything', async () => {
      const position = (await recovery().position()) as {
        deploymentResponsibilities: { item: string; why: string }[];
      };

      assert.ok(position.deploymentResponsibilities.length >= 5);
      const items = position.deploymentResponsibilities
        .map((entry) => entry.item.toLowerCase())
        .join(' | ');
      for (const expected of ['archiv', 'replication', 'kms', 'dns']) {
        assert.ok(items.includes(expected), `${expected} is not named as somebody else's`);
      }
    });

    it('says a restored database is unreadable without its keys', async () => {
      const position = (await recovery().position()) as Record<string, unknown>;
      assert.match(
        String(position['secretsAssumptions']),
        /unreadable without the encryption keys/i,
      );
    });

    it('says Redis is not restored', async () => {
      const position = (await recovery().position()) as Record<string, unknown>;
      assert.match(String(position['redisStance']), /does not restore Redis/i);
    });

    it('points at the scripts rather than pretending the API takes backups', async () => {
      // The application holds no owner credentials, deliberately — so it cannot run `pg_dump`, and
      // an endpoint that appeared to would be a lie about where the capability lives.
      const position = (await recovery().position()) as {
        scripts: { backup: string; verify: string };
      };
      assert.match(position.scripts.backup, /pg-backup\.sh/);
      assert.match(position.scripts.verify, /pg-restore-verify\.sh/);
    });
  });

  // =========================================================================
  describe('the schema state, which is the one fact the application owns', () => {
    it('reports the migration the database is at', async () => {
      const state = await recovery().schemaState();
      assert.notEqual(state.lastMigration, null);
      assert.equal(state.inFlight, 0);
      assert.equal(state.healthy, true);
    });

    it('does not count a rolled-back migration as in flight', async () => {
      /**
       * The defect the first real drill found.
       *
       * A row that is neither finished nor rolled back is genuinely in flight — a dump taken
       * mid-migration, which is the dangerous case. A **rolled-back** row is a failure somebody
       * already resolved, and it sits in the table forever. Counting it made the check fail
       * against a perfectly good backup, and a verification that cries wolf is one people learn to
       * skip.
       */
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.$executeRawUnsafe(
          `INSERT INTO _prisma_migrations
             (id, checksum, migration_name, started_at, rolled_back_at, applied_steps_count)
           VALUES (gen_random_uuid()::text, 'x', '00000000000000_failed_attempt', now(), now(), 0)`,
        ),
      );

      const state = await recovery().schemaState();
      assert.equal(state.rolledBack, 1);
      assert.equal(state.inFlight, 0, 'a resolved rollback must not read as in flight');
      assert.equal(state.healthy, true);
    });

    it('reports a genuinely unfinished migration as unhealthy', async () => {
      // The case the check exists for: a dump taken while a migration was running restores to a
      // schema no application version can run against, and it looks healthy until the first query.
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.$executeRawUnsafe(
          `INSERT INTO _prisma_migrations
             (id, checksum, migration_name, started_at, applied_steps_count)
           VALUES (gen_random_uuid()::text, 'x', '00000000000001_in_flight', now(), 0)`,
        ),
      );

      const state = await recovery().schemaState();
      assert.equal(state.inFlight, 1);
      assert.equal(state.healthy, false);
    });
  });
});
