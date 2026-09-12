import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { PrismaService } from '../../src/persistence/prisma.service.js';
import { AuditEventService } from '../../src/audit/audit-event.service.js';
import { AuditEventRepository } from '../../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../../src/persistence/audit-trail.repository.js';
import { TenantMembershipRepository } from '../../src/persistence/tenant-membership.repository.js';
import { TenantRepository } from '../../src/persistence/tenant.repository.js';
import { UserCredentialRepository } from '../../src/persistence/user-credential.repository.js';
import { UserRepository } from '../../src/persistence/user.repository.js';
import { TenantProvisioningService } from '../../src/provisioning/tenant-provisioning.service.js';

/**
 * Walk up from the compiled location until the directory holding `prisma/schema.prisma` is
 * found — that is `apps/api`, and Prisma needs it as the working directory to locate its schema
 * and config.
 */
function findApiRoot(): string {
  let current = import.meta.dirname;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'prisma', 'schema.prisma'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error('Could not locate apps/api (no prisma/schema.prisma found walking upward).');
}

/**
 * Integration test harness.
 *
 * Points at the dedicated `uboss_test` database created by `infra/docker-compose.yml`, never at
 * `uboss_dev`, so running the suite can never destroy development data.
 *
 * Two URLs, because the two roles exist for a reason:
 *  - `TEST_DATABASE_URL` uses `uboss_app`, the unprivileged role, so Row-Level Security applies
 *    exactly as it does in the running application. Tests that assert isolation must use this.
 *  - `TEST_MIGRATION_DATABASE_URL` uses the owner role, which may alter the schema and truncate
 *    tables.
 */
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://uboss_app:uboss_app_local_dev@localhost:5442/uboss_test?schema=public';

export const TEST_MIGRATION_DATABASE_URL =
  process.env['TEST_MIGRATION_DATABASE_URL'] ??
  'postgresql://uboss:uboss_local_dev@localhost:5442/uboss_test?schema=public';

/**
 * Pooled connections per test client.
 *
 * Sized from what the code actually does concurrently, not guessed. Two demands set the floor:
 * `AuthorizationService.contextFor` opens **five** transactions at once via `Promise.all`, and it
 * runs on every authorized request; and the audit chain's concurrency test fires **twelve**
 * concurrent appends, each an interactive transaction taking an advisory lock. The driver's
 * default of ten cannot seat twelve, which is why that one test was the flaky one — it was
 * under-provisioned from the day it was written, and it failed as a transaction timeout rather
 * than as anything that named a pool.
 *
 * Twenty, and **raising it makes things worse** — measured, not assumed. See the note on the
 * PrismaService constructor: Prisma allows two seconds to acquire a transaction, and a larger
 * ceiling has the driver open *cold* connections under a burst instead of reusing warm ones. The
 * same spec passes twice at 20 and fails at 40.
 *
 * So 20 is not a compromise between the two demands above; it is the size at which the pool stays
 * warm. Spec files run one at a time (`--test-concurrency=1`) and the owner-role client stays
 * small, so this is twenty-five connections per file against the server ceiling of 200 set in
 * `infra/docker-compose.yml` — ample headroom for a file's context still closing as the next
 * one opens.
 *
 * Three sizes tried, and every failure named neither pools nor limits:
 *   * **Four** — tidy-looking, and it breaks every authorized request, because `contextFor`
 *     alone wants five slots at once.
 *   * **Twenty for both clients, against the stock ceiling of 100** — forty per file, which
 *     overruns the *server* on overlap and surfaces as a bare `P1001` in an unrelated spec.
 *   * **Forty** — fails inside the acquire budget on cold-connection setup, as above.
 */
const TEST_POOL_MAX = 20;

/** The owner-role client does fixtures and migrations, one statement at a time. */
const ADMIN_POOL_MAX = 5;

/** Guard: refuse to run against anything that is not clearly a test database. */
function assertIsTestDatabase(url: string): void {
  const databaseName = url.split('/').pop()?.split('?')[0] ?? '';
  if (!databaseName.includes('test')) {
    throw new Error(
      `Refusing to run integration tests against database "${databaseName}": ` +
        'the database name must contain "test". This guard exists because the suite truncates tables.',
    );
  }
}

export interface TestContext {
  /** Runs as `uboss_app`: RLS applies. This is what the application uses. */
  prisma: PrismaService;
  /** Runs as the owner: used only for setup and truncation. */
  admin: PrismaService;
  tenants: TenantRepository;
  users: UserRepository;
  memberships: TenantMembershipRepository;
  auditEvents: AuditEventRepository;
  /// Exposed so tests can assert on stored credentials — only ever a hash.
  credentials: UserCredentialRepository;
  provisioning: TenantProvisioningService;
}

/**
 * Apply migrations to the test database.
 *
 * Uses `migrate deploy`, the same command production uses, so the tests run against exactly the
 * migrated schema rather than a `db push` approximation that could diverge.
 */
export function migrateTestDatabase(): void {
  assertIsTestDatabase(TEST_MIGRATION_DATABASE_URL);

  // Resolved by walking up rather than by counting `../` hops: this file runs from
  // `dist-test/test/support/`, which is a different depth from its source location, and a
  // hard-coded relative path silently points at the wrong directory.
  const apiRoot = findApiRoot();
  // Node's own resolver finds the CLI wherever npm hoisted it, so this survives changes to the
  // workspace layout.
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');

  // Invoked as `node <prisma entry point>` with no shell: `shell: true` concatenates rather than
  // escapes arguments (Node DEP0190) and needs platform-specific `.cmd` shims on Windows.
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: apiRoot,
    env: {
      ...process.env,
      DATABASE_MIGRATION_URL: TEST_MIGRATION_DATABASE_URL,
      DATABASE_URL: TEST_MIGRATION_DATABASE_URL,
    },
    stdio: 'pipe',
  });
}

export function createTestContext(): TestContext {
  assertIsTestDatabase(TEST_DATABASE_URL);

  // Sized deliberately — see TEST_POOL_MAX. The driver default cannot seat the audit chain's
  // twelve concurrent appends, and the failure surfaces as a transaction timeout somewhere else.
  const prisma = new PrismaService(TEST_DATABASE_URL, TEST_POOL_MAX);
  // The owner-role client only runs fixtures and migrations, always sequentially, so it needs
  // nothing like the application pool. Sizing the two the same doubled every spec file's
  // footprint for no benefit.
  const admin = new PrismaService(TEST_MIGRATION_DATABASE_URL, ADMIN_POOL_MAX);
  const tenants = new TenantRepository(prisma);
  const users = new UserRepository(prisma);
  const memberships = new TenantMembershipRepository(prisma);
  const auditEvents = new AuditEventRepository(prisma);
  const auditTrail = new AuditTrailRepository(prisma);
  const auditEventService = new AuditEventService(prisma, auditTrail);
  const credentials = new UserCredentialRepository(prisma);
  // Provisioning takes the chained writer since Prompt 8; `auditEvents` below is the read-only
  // repository, kept because the tenant-isolation suite reads through it to prove RLS from
  // outside the query layer.
  const provisioning = new TenantProvisioningService(
    prisma,
    tenants,
    users,
    memberships,
    auditEventService,
  );

  return { prisma, admin, tenants, users, memberships, auditEvents, credentials, provisioning };
}

/**
 * Empty every table between tests.
 *
 * Runs as the owner because `uboss_app` is subject to `FORCE ROW LEVEL SECURITY` and could only
 * truncate rows it can see — which is the whole point of RLS, and useless for a reset.
 */
export async function resetTestDatabase(context: TestContext): Promise<void> {
  assertIsTestDatabase(TEST_MIGRATION_DATABASE_URL);

  // ---------------------------------------------------------------------------
  // 1. The append-only history tables: TRUNCATE, because DELETE is blocked
  // ---------------------------------------------------------------------------
  // These carry triggers that refuse UPDATE and DELETE outright — that is the point of them — so
  // the only way to clear them is the one narrow, deliberately ugly escape hatch the Prompt 8
  // migration provides. `SET LOCAL` rather than `SET`, so the permission dies with the
  // transaction and cannot leak onto a pooled connection: a later test must not inherit the
  // ability to erase a trail.
  //
  // Nothing in `src/` sets this. `grep -r allow_history_truncate src` returning nothing is the
  // check that matters, and `audit.e2e.spec.ts` asserts it.
  await context.admin.unsafeRootClient.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL uboss.allow_history_truncate = 'on'`);
    await tx.$executeRawUnsafe(
      // Exactly the tables carrying a DELETE-firing trigger, from
      //   SELECT relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      //   WHERE NOT tgisinternal AND (tgtype & 8) > 0;
      // Six are append-only histories — `approval_decisions` joined at Prompt 28 and
      // `model_gateway_calls` at Prompt 29, both enforced by a trigger with no escape hatch.
      // The seventh, `objective_workflow_steps`, refuses deletion once its version is live — the
      // Form 2 grid freeze — which is why the first DELETE-based reset failed 1,264 tests with
      // "its workflow grid cannot be changed". Re-run that query when a new freeze trigger is
      // added rather than guessing.
      `TRUNCATE TABLE "audit_events", "security_events", "audit_chain_checkpoints",` +
        ` "agent_run_events", "executor_exception_events", "objective_workflow_steps",` +
        ` "approval_decisions", "model_gateway_calls", "cost_ledger_entries" CASCADE;`,
    );

    // ---- Prompt 29: provider configuration is cleared and re-seeded ----
    //
    // The platform provider baseline is seeded by migration, and the first attempt here deleted
    // only *tenant-owned* rows so that baseline would survive. **That was wrong, and the tests
    // caught it:** a test that deprecates the platform fast model, or deletes the platform
    // `EXECUTOR` route to prove an unroutable call is recorded, leaves that change in place for
    // every later test. The suite became order-dependent, which is the exact failure this reset
    // exists to prevent — and it failed quietly, as "no model is configured" in an unrelated test.
    //
    // So everything goes and the baseline is written again. `pricing_versions` needs the escape
    // hatch already open above: a published price refuses DELETE, and the corrective migration
    // `20260910133000` is what allows it here and nowhere else.
    //
    // The ids and values below are the migration's, deliberately duplicated rather than derived:
    // if `20260910130000` changes its baseline, this must change with it, and a copy that has to
    // be updated is more honest than a query that silently adopts whatever it finds.
    await tx.$executeRawUnsafe(
      `DELETE FROM "pricing_versions";` +
        `DELETE FROM "logical_model_routes";` +
        `DELETE FROM "provider_models";` +
        `DELETE FROM "provider_profiles";`,
    );

    await tx.$executeRawUnsafe(
      `INSERT INTO "provider_profiles"
         ("id", "tenant_id", "kind", "mode", "label", "lifecycle", "enabled", "created_at",
          "updated_at", "row_version")
       VALUES ('00000000-0000-4000-8000-00000000e001', NULL, 'Mock', 'UBossManaged',
               'Mock (no provider configured)', 'Active', true, NOW(), NOW(), 1);

       INSERT INTO "provider_models"
         ("id", "tenant_id", "provider_profile_id", "provider_model_ref", "capability",
          "lifecycle", "enabled", "created_at", "updated_at", "row_version")
       VALUES
         ('00000000-0000-4000-8000-00000000e101', NULL,
          '00000000-0000-4000-8000-00000000e001', 'mock-reasoning-v1', 'high-reasoning-v1',
          'Active', true, NOW(), NOW(), 1),
         ('00000000-0000-4000-8000-00000000e102', NULL,
          '00000000-0000-4000-8000-00000000e001', 'mock-fast-v1', 'fast-v1',
          'Active', true, NOW(), NOW(), 1);

       INSERT INTO "logical_model_routes"
         ("id", "tenant_id", "profile", "provider_model_id", "preference", "enabled",
          "created_at", "updated_at", "row_version")
       VALUES
         ('00000000-0000-4000-8000-00000000e201', NULL, 'OBJECTIVE_PLANNER',
          '00000000-0000-4000-8000-00000000e101', 0, true, NOW(), NOW(), 1),
         ('00000000-0000-4000-8000-00000000e202', NULL, 'AGENT_STANDARD',
          '00000000-0000-4000-8000-00000000e101', 0, true, NOW(), NOW(), 1),
         ('00000000-0000-4000-8000-00000000e203', NULL, 'AGENT_STANDARD',
          '00000000-0000-4000-8000-00000000e102', 1, true, NOW(), NOW(), 1),
         ('00000000-0000-4000-8000-00000000e204', NULL, 'AGENT_FAST',
          '00000000-0000-4000-8000-00000000e102', 0, true, NOW(), NOW(), 1),
         ('00000000-0000-4000-8000-00000000e205', NULL, 'EXECUTOR',
          '00000000-0000-4000-8000-00000000e101', 0, true, NOW(), NOW(), 1),
         ('00000000-0000-4000-8000-00000000e206', NULL, 'HIGH_REASONING',
          '00000000-0000-4000-8000-00000000e101', 0, true, NOW(), NOW(), 1);

       INSERT INTO "pricing_versions"
         ("id", "tenant_id", "provider_model_id", "version_number", "currency",
          "input_per_million_minor_units", "output_per_million_minor_units",
          "cached_input_per_million_minor_units", "effective_from", "created_at")
       VALUES
         ('00000000-0000-4000-8000-00000000e301', NULL,
          '00000000-0000-4000-8000-00000000e101', 1, 'INR', 0, 0, NULL, NOW(), NOW()),
         ('00000000-0000-4000-8000-00000000e302', NULL,
          '00000000-0000-4000-8000-00000000e102', 1, 'INR', 0, 0, NULL, NOW(), NOW());`,
    );
  });

  // ---------------------------------------------------------------------------
  // 2. Everything else: DELETE, children first
  // ---------------------------------------------------------------------------
  // **DELETE rather than TRUNCATE, and this is not a style choice.** PostgreSQL allocates a new
  // relfilenode for every table it truncates, so truncating two hundred tables before each of
  // fourteen hundred tests creates roughly 280,000 relation files per suite run. They are
  // unlinked at commit, but the directory itself keeps growing while the run is in flight, and
  // anything that crashes or is killed leaves its share behind for good.
  //
  // `uboss_test` reached 810,738 files that way, then 405,438 again a few runs later. The effect
  // is not disk: it is that every subsequent TRUNCATE has to create and unlink files in a
  // directory with hundreds of thousands of entries, so the reset gets slower run after run until
  // it blows past a transaction budget — surfacing as `Unable to start a transaction in the given
  // time` in whichever unrelated test happened to be running. Results degraded 1438 → 1437 →
  // 1336 → 1168 across four runs of *identical* code while I adjusted pool sizes that were never
  // the cause.
  //
  // DELETE allocates nothing. These tables hold a handful of rows per test, so it is comparably
  // fast, and the order below is already children-first for exactly this purpose. The five
  // history tables above still need TRUNCATE, which is 5 tables per test instead of 200.
  // One circular foreign key has to be broken first: `objectives.active_version_id` points at
  // `objective_versions`, which points back at `objectives`. `TRUNCATE ... CASCADE` resolved that
  // implicitly — one of the things it was quietly doing for us — and with DELETE there is no
  // order satisfying both directions, so the pointer is nulled before anything is removed.
  //
  // `engine_agents.current_version_id` looks like the same shape and is not: it carries no
  // foreign key, and nulling it violates `active_engine_agent_has_a_current_version` — an Active
  // agent must have a configuration in force. Nulling it "to be safe" failed 1,253 tests. The
  // agents are simply deleted before their versions instead.
  await context.admin.unsafeRootClient.$executeRawUnsafe(
    `UPDATE "objectives" SET "active_version_id" = NULL WHERE "active_version_id" IS NOT NULL;`,
  );
  const tablesInDeletionOrder = [
    // Prompt 40A (CR-03). Children before parents: a chat attachment references both a message
    // and a file, and a photo references a file, so the pointers go before the things they point
    // at. All of these cascade from `tenants` as well — they are listed so a reset does not
    // depend on the cascade order, which is the same reasoning as the Prompt 39 entries below.
    'chat_context_refs',
    'chat_message_attachments',
    'chat_messages',
    'chat_participants',
    'chat_conversations',
    'job_method_imports',
    'job_method_rows',
    'job_methods',
    'engine_agent_operators',
    'employee_photos',
    // Prompt 40. A platform-plane record has a null tenant_id, so nothing cascades it away when
    // the tenants go — it would survive a reset and collide with the next test to use the same
    // key. Tenant-scoped rows would cascade; this is for the ones that would not.
    'idempotency_records',
    // Prompt 39. Both cascade from `service_alerts`, which has no tenant column and is therefore
    // not in this list at all — so they are cleared explicitly or they survive a reset.
    'corrective_actions',
    'incident_timeline_entries',
    // Prompt 38. An exit references only the tenant, so it can go first — and it must go before
    // the tenant itself, which is what this list is ordered for.
    'company_exits',
    // Prompt 36. Notes reference the ticket by a composite FK, and a break-glass session points
    // at one with NO ACTION — so the sessions have to be cleared before the tickets they name.
    'support_ticket_notes',
    'break_glass_requests',
    'support_tickets',
    // Prompt 35. The join table first: it holds composite FKs to both the source and the file, so
    // deleting either first would rely on a cascade rather than on an order a failure can name.
    'knowledge_source_files',
    'knowledge_sources',
    'files',
    'company_knowledge_policies',
    // Prompt 23 onward: everything a published workflow becomes. Task children first, then the
    // tasks, then the siblings, then the draft they were all assigned from.
    'human_task_evidence',
    'human_task_notes',
    'human_tasks',
    'executor_exceptions',
    // Prompt 33. Both reference `agent_runs` with a composite FK, so they go before it — the
    // cascade would handle it, but an explicit order means a failure names the right table.
    'memory_records',
    'ai_output_feedback',
    'agent_runs',
    // Prompt 34. The outcome review holds a **NO ACTION** composite FK to `objective_versions`,
    // so nothing cascades it away — it has to be deleted explicitly and before the versions.
    'objective_outcome_reviews',
    'objective_pauses',
    'ai_work_assignments',
    // Prompt 28. `approval_decisions` is TRUNCATEd above, not deleted here — its append-only
    // trigger refuses DELETE. A resubmitted request points at the one it replaced through
    // `supersedes_id` with NO ACTION, so the whole table goes in one statement rather than in
    // supersession order.
    'approval_requests',
    'approval_delegations',
    // Prompt 33's per-mode memory governance.
    'memory_policies',
    // Prompt 30. Holds before reservations before wallets; `cost_ledger_entries` is TRUNCATEd
    // above because the ledger refuses DELETE by trigger.
    'budget_reservation_holds',
    'budget_reservations',
    // Prompt 31. Grants before requests before wallets: a grant points at both, and the
    // request FK is NO ACTION so the order has to be right rather than left to a cascade.
    'credit_grants',
    'credit_requests',
    'company_credit_policies',
    'budget_wallets',
    'executor_expectations',
    'engine_agents',
    'engine_agent_versions',
    // Prompt 22: the manager-editable draft is a child of both the objective version and the
    // analysis run, so it goes before either.
    'objective_workflow_drafts',
    'objective_analysis_runs',
    'reward_awards',
    'objective_rewards',
    'objective_versions',
    'objectives',
    'skill_candidates',
    'skill_regression_comparisons',
    'skill_evaluation_runs',
    'skill_evaluation_cases',
    'skill_transitions',
    'skill_versions',
    // Skill rows with a NULL tenant are platform-plane and cannot cascade from `tenants` — the
    // fourth instance of that class, so they are named explicitly.
    'skills',
    'connection_checks',
    'connection_tool_grants',
    'connection_secrets',
    'connections',
    'notifications',
    'notification_preferences',
    'outbox_messages',
    'performance_events',
    'badge_history',
    'performance_policies',
    'break_glass_requests',
    'service_alerts',
    'tenant_subscriptions',
    'employment_records',
    'departments',
    'person_identifiers',
    'tenant_memberships',
    'users',
    // Last: everything above is reachable from here, and deleting it also catches any table added
    // since that the list has not been updated for — the FK cascades do that work.
    'tenants',
  ];

  // One statement, so the whole reset is one round trip rather than forty-four. Named explicitly
  // and in order rather than left to the cascade graph, for the same reason the truncate was: a
  // reset that has to discover a growing dependency graph gets slower and more contended every
  // prompt.
  await context.admin.unsafeRootClient.$executeRawUnsafe(
    tablesInDeletionOrder.map((table) => `DELETE FROM "${table}";`).join(' '),
  );

  // The platform-plane tables the Prompt 9 migration seeds have no tenant to cascade from, so a
  // truncate cannot reach them and they would otherwise accumulate rows across runs — a plan
  // created by one test collided with the same test on the next run, which is how this was found.
  //
  // Reset to exactly what the migration seeds rather than truncating: a test database with no
  // plans and no settings cannot exercise the Master Console at all, so those rows have to
  // survive while test-created ones do not.
  await context.admin.unsafeRootClient.$executeRawUnsafe(
    `DELETE FROM "feature_flags" WHERE "key" <> 'master-console-v1'`,
  );
  await context.admin.unsafeRootClient.$executeRawUnsafe(
    `DELETE FROM "plans" WHERE "code" NOT IN ('starter', 'growth', 'enterprise', 'pilot')`,
  );
  await context.admin.unsafeRootClient.$executeRawUnsafe(
    `UPDATE "plans" SET "active" = true
       WHERE "code" IN ('starter', 'growth', 'enterprise', 'pilot') AND "active" = false`,
  );

  // `platform_settings`, back to exactly the six rows the Prompt 9 migration seeds.
  //
  // **The third instance of this leak**, and the reason it keeps happening is worth naming: a
  // platform-plane table has no tenant to cascade from, so `TRUNCATE tenants CASCADE` never
  // reaches it, and a row one test creates is still there on the next run. It cost a failing
  // test each time — a Prompt 9 plan, a Prompt 11 plan column, and now a Prompt 14 platform
  // default that made a company inherit `Weekly` when the test expected the code default.
  //
  // Every new platform-plane table needs a line here. The rule: if it has no `tenant_id`, the
  // truncate cannot clean it.
  await context.admin.unsafeRootClient.$executeRawUnsafe(
    `DELETE FROM "platform_settings"
      WHERE "key" NOT IN (
        'provisioning.default_plan_code', 'provisioning.default_timezone',
        'provisioning.default_currency', 'governance.company_creation',
        'governance.data_residency', 'governance.aadhaar_handling'
      )`,
  );

  // The Prompt 11 commercial columns, back to the values the migration gives them.
  //
  // Same class of leak as the plan rows above, and found the same way: a test that set
  // `allow_seat_requests = false` on the Growth plan made a *different* test in the same file
  // fail on the **next run**, because a plan is platform configuration that no truncate reaches.
  // Reset here rather than in each test, so a test that changes a plan cannot poison the suite
  // by forgetting to put it back.
  await context.admin.unsafeRootClient.$executeRawUnsafe(
    `UPDATE "plans"
        SET "allow_seat_requests" = true,
            "downgrade_grace_days" = 30,
            "release_channel" = 'Stable',
            "seat_counting_rule" = 'ActiveAndInvited'
      WHERE "code" IN ('starter', 'growth', 'enterprise', 'pilot')`,
  );

  await restorePlatformBaseline(context);
}

/**
 * Put back the platform-layer separation-of-duties baseline.
 *
 * `separation_of_duties_policies` has a nullable `tenant_id` and a foreign key to `tenants`, so
 * `TRUNCATE tenants CASCADE` takes the platform-layer rows with it — including the mandatory
 * no-self-approval control the Prompt 7 migration seeds. That is correct behaviour for a truncate
 * and wrong for a test fixture: every test would then run against a company with no baseline,
 * which is a state no real deployment can be in.
 *
 * Restored rather than excluded from the truncate, because excluding it would need the truncate
 * to name every table explicitly and stay in step with the schema — which is exactly the
 * maintenance burden CASCADE avoids.
 */
async function restorePlatformBaseline(context: TestContext): Promise<void> {
  await context.admin.unsafeRootClient.$executeRawUnsafe(`
    INSERT INTO "separation_of_duties_policies"
      ("id", "tenant_id", "layer", "module", "action", "rule", "mandatory", "reason", "enabled",
       "created_at", "updated_at", "row_version")
    SELECT
      gen_random_uuid(), NULL, 'Platform', NULL, 'Approve', 'NoSelfApproval', true,
      'You cannot approve something you created. UBoss requires a different person to approve it.',
      true, NOW(), NOW(), 1
    WHERE NOT EXISTS (
      SELECT 1 FROM "separation_of_duties_policies"
      WHERE "tenant_id" IS NULL AND "layer" = 'Platform' AND "action" = 'Approve'
        AND "rule" = 'NoSelfApproval'
    );
  `);
}

export async function closeTestContext(context: TestContext): Promise<void> {
  await context.prisma.unsafeRootClient.$disconnect();
  await context.admin.unsafeRootClient.$disconnect();
}

/**
 * Open and release `count` connections, so a following burst finds them warm.
 *
 * A pool grows lazily. A test that fires a dozen concurrent transactions at a cold pool needs a
 * dozen TCP handshakes inside Prisma's two-second budget for *starting* a transaction, and on a
 * Docker Desktop Postgres that budget can run out — reported as 'Unable to start a transaction in
 * the given time', which sounds like contention and is actually setup cost.
 *
 * Deliberately a per-test helper rather than a global pool setting. Raising the pool ceiling makes
 * this *worse* (more cold connections opened under load), raising `maxWait` globally turns fast
 * failures into long queues across the whole suite, and raising `timeout` starves the pool by
 * letting transactions hold slots longer. All three were tried; see the note on TEST_POOL_MAX.
 * Warming the pool where a burst is deliberate costs one round of queries and changes nothing
 * else.
 */
export async function warmPool(context: TestContext, count: number): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, () => context.prisma.unsafeRootClient.$queryRaw`SELECT 1`),
  );
}
/** Is the test database reachable? Used to fail with a helpful message rather than a stack trace. */
export async function isTestDatabaseReachable(context: TestContext): Promise<boolean> {
  try {
    await context.admin.unsafeRootClient.$queryRaw`SELECT 1`;
    return true;
  } catch (caught) {
    // Reported rather than swallowed. "The test database is not reachable" with no reason is
    // indistinguishable from a stopped container, a wrong port and an exhausted connection
    // pool — and it was the third of those.
    lastReachabilityFailure = caught instanceof Error ? caught.message : String(caught);
    return false;
  }
}

let lastReachabilityFailure: string | null = null;

/** Why the last reachability check failed, for a suite hook to put in its own error. */
export function reachabilityFailureReason(): string {
  return lastReachabilityFailure ?? 'no reason was recorded';
}

/** Activate a company so the guard permits workspace access, as the Master Console would. */
export async function activateTenant(context: TestContext, tenantId: string): Promise<void> {
  await context.admin.unsafeRootClient.tenant.update({
    where: { id: tenantId },
    data: { lifecycleState: 'Active' },
  });
}

/** Put a company into any lifecycle state, for testing the guard's decisions. */
export async function setTenantLifecycle(
  context: TestContext,
  tenantId: string,
  lifecycleState:
    'Provisioning' | 'PendingActivation' | 'Active' | 'Suspended' | 'ReadOnly' | 'Closed',
): Promise<void> {
  await context.admin.unsafeRootClient.tenant.update({
    where: { id: tenantId },
    data: { lifecycleState },
  });
}

/**
 * Mark a membership Active, as invitation activation would.
 *
 * Needed because `provision()` correctly leaves the first member `NotInvited` — provisioning
 * creates the company and the person, but only activation grants access, and there is no public
 * signup. Fixtures that want a usable workspace must activate both the *company* and the
 * *account*; they are separate states with separate meanings.
 */
export async function activateMembership(
  context: TestContext,
  userId: string,
  tenantId: string,
): Promise<void> {
  await context.admin.unsafeRootClient.tenantMembership.updateMany({
    where: { userId, tenantId },
    data: { accountState: 'Active' },
  });
}

/** Put an account into any state, for testing the guard's decisions. */
export async function setAccountState(
  context: TestContext,
  userId: string,
  tenantId: string,
  accountState: 'NotInvited' | 'InvitePending' | 'Active' | 'Suspended' | 'Offboarded',
): Promise<void> {
  await context.admin.unsafeRootClient.tenantMembership.updateMany({
    where: { userId, tenantId },
    data: { accountState },
  });
}

/**
 * Give somebody Builder access explicitly — the CR-03 "Power Employee" — Prompt 40A.
 *
 * ## Why this helper exists rather than a wider role template
 *
 * CR-03 made a standard Employee operations-only: no `objective`, no `agent-builder`, so neither
 * BUILDERS screen appears and neither route is reachable. Several suites were written when the
 * Employee template granted builder access by default, and they legitimately exercise an employee
 * completing their own agent setup — that journey still exists, it just now requires somebody to
 * have granted it.
 *
 * So this is the explicit grant, through the mechanism that already existed: a `Custom` role
 * assignment whose stored matrix carries the builder permissions. The authorization engine unions
 * grants across a person's assignments, so `Employee` + this is precisely "a standard Employee with
 * Builder access added" — which is the client's own description of a Power Employee.
 *
 * **No second RBAC system, and no widening of the template.** A test that calls this is saying
 * "this person was granted builder access", and a test that does not is exercising the new default.
 * Both are now meaningful, which is the point.
 */
export async function grantBuilderAccess(
  context: TestContext,
  input: { tenantId: string; userId: string; grantedByUserId: string; scopeKind?: string },
): Promise<string> {
  return context.prisma.runAsPlatformOperation(async () => {
    const role = await context.prisma.client.customRole.create({
      data: {
        tenantId: input.tenantId,
        displayName: `Power Employee ${Math.random().toString(36).slice(2, 8)}`,
        description: 'Builder access granted explicitly under CR-03.',
        permissions: {
          objective: ['View', 'Comment', 'Create', 'EditDraft'],
          'agent-builder': ['View', 'Comment', 'Create', 'EditDraft', 'Run'],
        },
        maxScope: 'OwnWork',
      },
    });

    await context.prisma.client.roleAssignment.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        roleKind: 'Custom',
        customRoleId: role.id,
        // `OwnWork` by default, deliberately: granting the capability must not also widen reach.
        // A Power Employee builds their *own* assigned work and nobody else's.
        scopeKind: (input.scopeKind ?? 'OwnWork') as never,
        grantedByUserId: input.grantedByUserId,
      },
    });

    return role.id;
  });
}
