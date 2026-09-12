import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { Pool } from 'pg';

import {
  NOT_MEASURED_HERE,
  planSeqScansLargeTable,
  SCALE_CLAIM_STANCE,
  summarise,
  UNBOUNDED_TABLES,
  type ScaleScenarioKey,
  type ScenarioResult,
} from '@uboss/types';

import { perfUserId, seedLargeTenant, type LargeTenant, type SqlRunner } from './large-tenant.js';

/**
 * Measure the scenarios Prompt 43 names, against a database built for the purpose — and dropped
 * afterwards.
 *
 * ## What this produces, and what it is worth
 *
 * Two kinds of evidence, and only one of them transfers:
 *
 *   * **Latency percentiles**, which describe this laptop and nothing else. They are recorded
 *     because a regression between two runs on the *same* machine is real information.
 *   * **Query plans**, which describe the database. A plan that sequentially scans fifty thousand
 *     rows will sequentially scan fifty million, and that is true wherever it runs. This is the
 *     evidence the report actually rests on.
 *
 * Run with:
 *
 *   npx tsc -p tsconfig.scripts.json && node dist-scripts/scripts/perf/scale-run.js
 *
 * ## Why this lives under `scripts/` rather than `test/`
 *
 * It is an operational script, not a test: nothing asserts, and its console output **is** its
 * interface. The shared lint config already says exactly that — every path under a `scripts`
 * directory turns `no-console` off, because "a seed that reports nothing is worse than one
 * that does" — so this file belongs where that rule already applies. It sat under `test/` at
 * first only because `tsconfig.test.json` compiled it, which was convenience rather than a
 * reason.
 *
 * (The glob itself is not written out here: it starts with a doubled asterisk and a slash, which
 * ends a block comment. Doing that closed this docblock mid-sentence and left the rest of the
 * paragraph being parsed as code — which TypeScript accepted and ESLint caught.)
 *
 * It creates `uboss_perf_<stamp>`, migrates it, seeds it, measures, and drops it in a `finally` —
 * including when a scenario throws, because a forgotten perf database is a several-hundred-megabyte
 * copy of nothing that somebody finds months later.
 */

const ADMIN_URL =
  process.env['PERF_ADMIN_URL'] ?? 'postgresql://uboss:uboss_local_dev@localhost:5442/postgres';

/** Every measured query runs as the application role, under RLS. That is the half that matters. */
const APP_ROLE = process.env['PERF_APP_ROLE'] ?? 'uboss_app';
const APP_PASSWORD = process.env['PERF_APP_PASSWORD'] ?? 'uboss_app_local_dev';

const SAMPLES = Number(process.env['PERF_SAMPLES'] ?? 20);
const EMPLOYEES = Number(process.env['PERF_EMPLOYEES'] ?? 5000);
const AUDIT_EVENTS = Number(process.env['PERF_AUDIT_EVENTS'] ?? 50000);
const NOTIFICATIONS = Number(process.env['PERF_NOTIFICATIONS'] ?? 20000);
/**
 * Companies sharing the tables besides the measured one.
 *
 * Not decoration. With a single company `tenant_id` has no selectivity, every tenant-prefixed index
 * in the schema looks useless, and the harness reports existing indexes as missing (ADR-272).
 */
const OTHER_TENANTS = Number(process.env['PERF_OTHER_TENANTS'] ?? 19);

interface Measured {
  results: ScenarioResult[];
  plans: { scenario: string; query: string; plan: string; seqScans: string[] }[];
}

/** Time one call, in milliseconds, at the resolution the runtime actually offers. */
async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = performance.now();
  const value = await work();
  return { ms: performance.now() - started, value };
}

/**
 * Run one scenario `SAMPLES` times.
 *
 * The first call is **discarded**, deliberately. A cold plan cache and an unwarmed buffer pool make
 * the first execution several times slower than every subsequent one, and including it would put a
 * number in the p99 that describes process start-up rather than the query. It is reported separately
 * instead, because "the first one is slow" is itself worth knowing.
 */
async function measure(
  scenario: ScaleScenarioKey,
  work: () => Promise<unknown>,
): Promise<{ result: ScenarioResult; coldMs: number | null }> {
  let coldMs: number | null = null;
  const samples: number[] = [];
  let errors = 0;

  try {
    coldMs = (await timed(work)).ms;
  } catch {
    errors += 1;
  }

  for (let index = 0; index < SAMPLES; index += 1) {
    try {
      samples.push((await timed(work)).ms);
    } catch {
      errors += 1;
    }
  }

  return { result: summarise({ scenario, samples, errors }), coldMs };
}

async function main(): Promise<void> {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  const database = `uboss_perf_${stamp}`;

  /*
   * The same allow-list discipline as the restore drill: the name is generated here and checked
   * here, so there is no input path by which this can be pointed at a real database.
   */
  if (!/^uboss_perf_\d{14}$/.test(database)) {
    throw new Error(`refusing to use '${database}': not a generated perf database name`);
  }

  const admin = new Pool({ connectionString: ADMIN_URL });
  let created = false;

  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    console.log(`created ${database}`);

    const ownerUrl = ADMIN_URL.replace(/\/[^/]+$/, `/${database}`);

    // Migrate it with the real migrations, so the schema under measurement is the shipped one.
    const { execFileSync } = await import('node:child_process');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: path.join(process.cwd()),
      env: { ...process.env, DATABASE_MIGRATION_URL: ownerUrl, DATABASE_URL: ownerUrl },
      stdio: 'inherit',
      shell: true,
    });

    const owner = new Pool({ connectionString: ownerUrl });
    const runner: SqlRunner = { run: (statement, ...values) => owner.query(statement, values) };

    console.log(`seeding ${EMPLOYEES} employees, ${AUDIT_EVENTS} audit events…`);
    const tenant = await seedLargeTenant(runner, {
      employees: EMPLOYEES,
      auditEvents: AUDIT_EVENTS,
      notifications: NOTIFICATIONS,
      otherTenants: OTHER_TENANTS,
    });

    // The application role, so every measured query runs under RLS exactly as it does in production.
    const appUrl = ownerUrl.replace(
      /^postgresql:\/\/[^@]+@/,
      `postgresql://${APP_ROLE}:${APP_PASSWORD}@`,
    );
    const app = new Pool({ connectionString: appUrl, max: 10 });

    const measured = await runScenarios(app, tenant);

    await app.end();
    await owner.end();

    report(measured, tenant);
  } finally {
    if (created) {
      // Terminate anything still connected, or the drop is refused.
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
        [database],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      console.log(`dropped ${database}`);
    }
    await admin.end();
  }
}

/**
 * Run a query inside a tenant-scoped transaction, the way the application does.
 *
 * `app.current_tenant_id` is what every RLS policy reads. Measuring without it would measure a
 * query the application never makes — and would return no rows, which would look fast.
 */
async function scoped<T>(
  pool: Pool,
  tenantId: string,
  work: (query: (sql: string, values?: unknown[]) => Promise<{ rows: T[] }>) => Promise<unknown>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    await work((sql, values) => client.query(sql, values) as unknown as Promise<{ rows: T[] }>);
    await client.query('COMMIT');
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw cause;
  } finally {
    client.release();
  }
}

/** The queries, as the repository actually writes them. */
const QUERIES = {
  HierarchyList: `
    SELECT e."user_id", u."display_name", e."employee_id", e."designation",
           d."name" AS department_name, m."display_name" AS manager_name,
           tm."account_state"::text
      FROM "employment_records" e
      JOIN "users" u ON u."id" = e."user_id"
      JOIN "departments" d ON d."id" = e."department_id"
      LEFT JOIN "users" m ON m."id" = e."reporting_manager_user_id"
      LEFT JOIN "tenant_memberships" tm
             ON tm."user_id" = e."user_id" AND tm."tenant_id" = e."tenant_id"
     ORDER BY u."display_name"`,

  /**
   * Copied from `OrganizationRepository.subtreeContains`, tenant predicates included.
   *
   * An earlier version of this harness wrote the query by hand and left the tenant out. It
   * measured 120ms and reported a bottleneck that does not exist, because the repository names
   * the tenant in **both** terms of the recursion. Hand-writing a query to measure a query is how
   * a benchmark ends up describing the benchmark.
   */
  HierarchySubtree: `
    WITH RECURSIVE subtree AS (
      SELECT e."user_id"
        FROM "employment_records" e
       WHERE e."tenant_id" = $1::uuid AND e."user_id" = $2::uuid
      UNION
      SELECT child."user_id"
        FROM "employment_records" child
        JOIN subtree ON child."reporting_manager_user_id" = subtree."user_id"
       WHERE child."tenant_id" = $1::uuid
    )
    SELECT EXISTS (SELECT 1 FROM subtree WHERE "user_id" = $3::uuid) AS found`,

  AuditList: `
    SELECT "id", "action", "resource_type", "summary", "occurred_at"
      FROM "audit_events"
     ORDER BY "occurred_at" DESC
     LIMIT 50`,

  /**
   * The same audit page, with the tenant named explicitly.
   *
   * Not a different result — RLS already confines the query to this tenant, so the predicate is
   * redundant by construction and can only match the rows the policy would have allowed anyway.
   * What it changes is what the *planner* can see: a plain equality on an indexed column, rather
   * than an OR it cannot use an index for.
   *
   * Measured against the version above to find out whether that is worth anything.
   */
  AuditListExplicitTenant: `
    SELECT "id", "action", "resource_type", "summary", "occurred_at"
      FROM "audit_events"
     WHERE "tenant_id" = $1::uuid
     ORDER BY "occurred_at" DESC
     LIMIT 50`,

  NotificationList: `
    SELECT "id", "kind", "title", "occurred_at"
      FROM "notifications"
     WHERE "recipient_user_id" = $1::uuid
     ORDER BY "occurred_at" DESC
     LIMIT 50`,
} as const;

async function runScenarios(pool: Pool, tenant: LargeTenant): Promise<Measured> {
  const results: ScenarioResult[] = [];
  const plans: Measured['plans'] = [];

  /** Capture a plan once, and note any sequential scan over a table that grows without bound. */
  const explain = async (scenario: string, query: string, values: unknown[]) => {
    await scoped(pool, tenant.tenantId, async (q) => {
      const explained = await q(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query}`, values);
      const plan = explained.rows
        .map((row) => (row as Record<string, string>)['QUERY PLAN'])
        .join('\n');
      plans.push({
        scenario,
        query: query.trim().split('\n')[0]?.trim() ?? '',
        plan,
        seqScans: planSeqScansLargeTable(plan, { largeTables: UNBOUNDED_TABLES }),
      });
    });
  };

  // ---- 1. the hierarchy list ----
  const hierarchy = await measure('HierarchyList', () =>
    scoped(pool, tenant.tenantId, (q) => q(QUERIES.HierarchyList)),
  );
  results.push(hierarchy.result);
  await explain('HierarchyList', QUERIES.HierarchyList, []);

  // ---- 2. the subtree walk, from the root to the deepest leaf ----
  const subtree = await measure('HierarchySubtree', () =>
    scoped(pool, tenant.tenantId, (q) =>
      q(QUERIES.HierarchySubtree, [tenant.tenantId, tenant.rootUserId, tenant.deepUserId]),
    ),
  );
  results.push(subtree.result);
  await explain('HierarchySubtree', QUERIES.HierarchySubtree, [
    tenant.tenantId,
    tenant.rootUserId,
    tenant.deepUserId,
  ]);

  /*
   * ---- 3. the audit page, twice ----
   *
   * The first is a **control, not the product**: it omits the tenant predicate and leans on RLS
   * alone. The application does not query this way — `AuditEventRepository` passes
   * `where: { tenantId: scope.tenantId }` — and this exists only to measure what that convention
   * is worth. Labelled so nobody reads its number as a UBoss latency.
   */
  const audit = await measure('AuditList', () =>
    scoped(pool, tenant.tenantId, (q) => q(QUERIES.AuditList)),
  );
  results.push({
    ...audit.result,
    label: 'CONTROL — audit page relying on RLS alone (not how the app queries)',
  });
  await explain('AuditList', QUERIES.AuditList, []);
  await explain('NotificationList', QUERIES.NotificationList, [perfUserId(2)]);

  /*
   * The same page again, with the tenant named. Reported as its own scenario so the two plans sit
   * beside each other in the evidence rather than being described in prose.
   */
  const auditExplicit = await measure('AuditList', () =>
    scoped(pool, tenant.tenantId, (q) => q(QUERIES.AuditListExplicitTenant, [tenant.tenantId])),
  );
  results.push({
    ...auditExplicit.result,
    scenario: 'AuditList',
    label: 'Audit page as the application queries it (tenant named)',
  });
  await explain('AuditListExplicitTenant', QUERIES.AuditListExplicitTenant, [tenant.tenantId]);

  /*
   * ---- 4. concurrent sessions ----
   *
   * Ten simultaneous scoped reads. This is concurrency *within one process against one pool*, which
   * is what a single API instance does — it is not a distributed load test and the report says so.
   */
  const concurrent = await measure('ConcurrentSessions', async () => {
    await Promise.all(
      Array.from({ length: 10 }, () =>
        scoped(pool, tenant.tenantId, (q) =>
          q(`SELECT "id" FROM "tenant_memberships" WHERE "user_id" = $1::uuid`, [perfUserId(3)]),
        ),
      ),
    );
  });
  results.push(concurrent.result);

  return { results, plans };
}

function report(measured: Measured, tenant: LargeTenant): void {
  const evidence = {
    measuredAt: new Date().toISOString(),
    /*
     * Per-company *and* total, because the two are different numbers and the report quotes both.
     * The measured company owns one twentieth of each unbounded table, which is the selectivity
     * that makes a plan worth reading — see ADR-272.
     */
    seeded: {
      companies: OTHER_TENANTS + 1,
      measuredCompany: {
        employees: tenant.employees,
        auditEvents: tenant.auditEvents,
        notifications: tenant.notifications,
      },
      acrossAllCompanies: {
        auditEvents: tenant.auditEvents * (OTHER_TENANTS + 1),
        notifications: tenant.notifications * (OTHER_TENANTS + 1),
        employmentRecords: tenant.employees + OTHER_TENANTS * 2000,
      },
    },
    samplesPerScenario: SAMPLES,
    results: measured.results,
    plans: measured.plans.map((entry) => ({
      scenario: entry.scenario,
      seqScansOnUnboundedTables: entry.seqScans,
      plan: entry.plan,
    })),
    stance: SCALE_CLAIM_STANCE,
    notMeasured: NOT_MEASURED_HERE,
  };

  const out = path.join(process.cwd(), '..', '..', 'infra', 'perf', 'evidence');
  writeFileSync(
    path.join(out, `scale-${evidence.measuredAt.replace(/[-:.]/g, '').slice(0, 15)}.json`),
    JSON.stringify(evidence, null, 2),
  );

  console.log('\nscenario'.padEnd(59) + '     p50      p95      p99   verdict');
  console.log('-'.repeat(96));
  for (const result of measured.results) {
    const cell = (value: number | null) => (value === null ? '   —' : value.toFixed(1).padStart(7));
    console.log(
      result.label.slice(0, 56).padEnd(58) +
        cell(result.p50) +
        cell(result.p95) +
        cell(result.p99) +
        '   ' +
        result.verdict,
    );
  }

  console.log('\nsequential scans on tables that grow without bound:');
  const offenders = measured.plans.filter((entry) => entry.seqScans.length > 0);
  if (offenders.length === 0) console.log('  none');
  else {
    for (const entry of offenders) {
      console.log(`  ${entry.scenario}: ${entry.seqScans.join(', ')}`);
    }
  }
}

await main();
