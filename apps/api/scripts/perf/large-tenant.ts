import { randomUUID } from 'node:crypto';

/**
 * Seed one company large enough for a query plan to mean something — Prompt 43.
 *
 * ## This never touches `uboss_test`, and that is not a preference
 *
 * `audit_events` refuses `DELETE`, `UPDATE` **and** `TRUNCATE` by trigger — it is append-only by
 * design, which is the whole point of an audit trail. So fifty thousand seeded rows written into
 * the shared test database could **never be removed**: not by the cleanup, not by
 * `resetTestDatabase`, not by anything short of dropping the database. `DELETE FROM tenants` would
 * not even cascade, because the trigger refuses the cascade too.
 *
 * That is the Prompt 41 lesson repeating in a worse form — there, one fake row in
 * `_prisma_migrations` broke `migrate deploy` for every later suite. Here it would be fifty thousand
 * permanent rows in the one table nobody can clean.
 *
 * So the harness builds its **own throwaway database**, migrates it, measures against it and drops
 * it. The same discipline as `pg-restore-verify.sh`, and for the same reason: a measurement must not
 * be able to damage the thing it is measuring.
 *
 * ## Why bulk SQL rather than the services
 *
 * Creating five thousand employees through `EmploymentService` would take minutes and would be
 * measuring the seeder. These rows exist to give the planner a table worth planning against.
 *
 * The cost is stated rather than hidden: **these rows skip every domain rule.** They satisfy the
 * database — constraints, foreign keys and RLS all apply — and they are not necessarily valid to
 * the product. Acceptable for measuring a plan, and acceptable for nothing else.
 *
 * ## Why there is more than one company in here
 *
 * The first version seeded a single tenant and reported sequential scans on
 * `employment_records` and `audit_events` as findings. They were not findings.
 *
 * With one company, `tenant_id = X` matches **every row in the table**, so a tenant-prefixed
 * index would mean reading the whole index *and* the whole heap — strictly worse than scanning.
 * The planner chose the scan because the planner was right, and
 * `audit_events_tenant_id_occurred_at_idx` — the exact index that query wants — already
 * existed and was correctly ignored.
 *
 * Acting on that would have added a duplicate index production never uses. So the harness seeds
 * **twenty companies** and measures one: the measured tenant is a twentieth of each table, which
 * is the selectivity a real deployment has and the only shape in which a scan is evidence of
 * anything.
 *
 * ## Why the numbers are what they are
 *
 * Five thousand employees is a large enterprise customer, not a synthetic million. The point is to
 * cross the threshold where PostgreSQL stops choosing a sequential scan because the table is
 * trivially small. Past that, the plan it chooses is the plan it chooses at ten million — and that
 * is the finding that transfers off this laptop.
 */

/** Anything that can run a statement. Kept structural so the harness is not tied to Prisma. */
export interface SqlRunner {
  run(statement: string, ...values: unknown[]): Promise<unknown>;
}

export interface LargeTenant {
  tenantId: string;
  departmentId: string;
  /** The person at the top of the reporting tree. */
  rootUserId: string;
  /** The last person added, which is the deepest leaf — the worst case for a subtree walk. */
  deepUserId: string;
  employees: number;
  auditEvents: number;
  notifications: number;
}

export interface LargeTenantOptions {
  employees?: number;
  auditEvents?: number;
  notifications?: number;
  /** How many people report to each manager. Decides how deep the tree gets. */
  span?: number;
  /**
   * Other companies sharing the tables.
   *
   * Not decoration: without them `tenant_id` has no selectivity and every tenant-scoped index in
   * the schema looks useless. See the note at the top of this file.
   */
  otherTenants?: number;
}

/** A deterministic uuid for the nth seeded person, so the tree is computable rather than random. */
export function perfUserId(ordinal: number): string {
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
}

export async function seedLargeTenant(
  sql: SqlRunner,
  options: LargeTenantOptions = {},
): Promise<LargeTenant> {
  const employees = options.employees ?? 5000;
  const auditEvents = options.auditEvents ?? 50000;
  const notifications = options.notifications ?? 20000;
  const span = options.span ?? 7;
  const otherTenants = options.otherTenants ?? 19;

  const tenantId = randomUUID();
  const departmentId = randomUUID();

  // ---- the company ----
  await sql.run(
    `INSERT INTO "tenants" ("id", "slug", "name", "lifecycle_state", "updated_at")
     VALUES ($1::uuid, $2, $3, 'Active', now())`,
    tenantId,
    `perf-${tenantId.slice(0, 8)}`,
    'Perf Scale Company',
  );

  await sql.run(
    `INSERT INTO "departments" ("id", "tenant_id", "name", "code", "updated_at")
     VALUES ($1::uuid, $2::uuid, 'Operations', 'OPS', now())`,
    departmentId,
    tenantId,
  );

  /*
   * ---- the people ----
   *
   * One statement each. `generate_series` gives every row a stable ordinal, which is what makes the
   * reporting tree computable: person n reports to person floor((n-2)/span)+1, so the tree is
   * uniform and its depth is about log_span(employees) — five levels at 5000 over a span of 7.
   */
  await sql.run(
    `INSERT INTO "users" ("id", "uboss_unique_id", "email", "display_name", "updated_at")
     SELECT
       ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'UB-PERF-' || lpad(n::text, 8, '0'),
       'perf' || n || '@scale.test',
       'Perf Person ' || n,
       now()
     FROM generate_series(1, $1) AS n`,
    employees,
  );

  await sql.run(
    `INSERT INTO "tenant_memberships"
       ("id", "tenant_id", "user_id", "user_type", "account_state", "updated_at")
     SELECT
       gen_random_uuid(),
       $2::uuid,
       ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'InternalUser',
       'Active',
       now()
     FROM generate_series(1, $1) AS n`,
    employees,
    tenantId,
  );

  await sql.run(
    `INSERT INTO "employment_records"
       ("id", "tenant_id", "user_id", "employee_id", "designation", "department_id",
        "reporting_manager_user_id", "state", "updated_at")
     SELECT
       gen_random_uuid(),
       $2::uuid,
       ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'PERF-' || lpad(n::text, 6, '0'),
       'Operations Associate',
       $3::uuid,
       CASE
         WHEN n = 1 THEN NULL
         ELSE ('00000000-0000-4000-8000-' || lpad((((n - 2) / $4) + 1)::text, 12, '0'))::uuid
       END,
       'Active',
       now()
     FROM generate_series(1, $1) AS n`,
    employees,
    tenantId,
    departmentId,
    span,
  );

  // ---- the tables that only grow ----
  await sql.run(
    `INSERT INTO "audit_events"
       ("id", "tenant_id", "actor_user_id", "action", "resource_type", "resource_id",
        "summary", "occurred_at")
     SELECT
       gen_random_uuid(),
       $2::uuid,
       ('00000000-0000-4000-8000-' || lpad(((n % $3) + 1)::text, 12, '0'))::uuid,
       'perf.event',
       'perf',
       gen_random_uuid()::text,
       'Seeded for scale measurement',
       now() - (n || ' seconds')::interval
     FROM generate_series(1, $1) AS n`,
    auditEvents,
    tenantId,
    employees,
  );

  await sql.run(
    `INSERT INTO "notifications"
       ("id", "tenant_id", "recipient_user_id", "kind", "severity", "title", "body",
        "deep_link", "resource_type", "resource_id", "dedupe_key", "occurred_at")
     SELECT
       gen_random_uuid(),
       $2::uuid,
       ('00000000-0000-4000-8000-' || lpad(((n % $3) + 1)::text, 12, '0'))::uuid,
       -- A real enum member. 'kind' is a PostgreSQL enum, so an invented label is refused —
       -- which is the schema doing its job and is why the seeder had to be told a true one.
       'Overdue',
       'Info',
       'Seeded notification ' || n,
       'Seeded for scale measurement',
       '/dashboard',
       'perf',
       gen_random_uuid()::text,
       'perf-' || n,
       now() - (n || ' seconds')::interval
     FROM generate_series(1, $1) AS n`,
    notifications,
    tenantId,
    employees,
  );

  /*
   * ---- the other companies ----
   *
   * Each gets the same volume of the two unbounded tables, so the measured tenant is one of
   * twenty rather than all of them. Their rows are never read; they exist so the planner sees a
   * realistic distribution and chooses what it would choose in production.
   */
  for (let index = 0; index < otherTenants; index += 1) {
    const otherId = randomUUID();
    const decoyDepartmentId = randomUUID();

    await sql.run(
      `INSERT INTO "tenants" ("id", "slug", "name", "lifecycle_state", "updated_at")
       VALUES ($1::uuid, $2, $3, 'Active', now())`,
      otherId,
      `perf-other-${otherId.slice(0, 8)}`,
      'Perf Decoy Company',
    );

    await sql.run(
      `INSERT INTO "departments" ("id", "tenant_id", "name", "updated_at")
       VALUES ($1::uuid, $2::uuid, 'Operations', now())`,
      decoyDepartmentId,
      otherId,
    );

    // Employment records too, or that table stays single-tenant and its plan proves nothing.
    // Fewer per decoy than the measured company, which is what a real deployment looks like.
    await sql.run(
      `INSERT INTO "employment_records"
         ("id", "tenant_id", "user_id", "employee_id", "designation", "department_id",
          "state", "updated_at")
       -- A person may be employed by several companies, which is the product's own model, so
       -- the decoys reuse the seeded users rather than inventing rows the FK would refuse.
       SELECT gen_random_uuid(), $2::uuid,
              ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'DECOY-' || n,
              'Associate', $3::uuid, 'Active', now()
       FROM generate_series(1, $1) AS n`,
      2000,
      otherId,
      decoyDepartmentId,
    );
    await sql.run(
      `INSERT INTO "audit_events"
         ("id", "tenant_id", "action", "resource_type", "summary", "occurred_at")
       SELECT gen_random_uuid(), $2::uuid, 'perf.event', 'perf',
              'Seeded for selectivity', now() - (n || ' seconds')::interval
       FROM generate_series(1, $1) AS n`,
      auditEvents,
      otherId,
    );

    await sql.run(
      `INSERT INTO "notifications"
         ("id", "tenant_id", "recipient_user_id", "kind", "severity", "title", "body",
          "deep_link", "resource_type", "dedupe_key", "occurred_at")
       SELECT gen_random_uuid(), $2::uuid, $3::uuid, 'Overdue', 'Info',
              'Seeded notification', 'Seeded for selectivity', '/dashboard', 'perf',
              'perf-other-' || $2 || '-' || n, now() - (n || ' seconds')::interval
       FROM generate_series(1, $1) AS n`,
      notifications,
      otherId,
      perfUserId(1),
    );
  }

  /*
   * ---- ANALYZE ----
   *
   * Not optional, and the easiest thing here to forget. PostgreSQL plans from statistics, and a
   * table that has just been bulk-loaded has none — so the planner assumes it is tiny and picks a
   * sequential scan whatever indexes exist.
   *
   * Measuring without this would produce a report full of "missing index" findings that are really
   * "missing statistics", and somebody would then add indexes the database never wanted and would
   * never use.
   */
  await sql.run(
    'ANALYZE "employment_records", "users", "tenant_memberships", "audit_events", "notifications"',
  );

  return {
    tenantId,
    departmentId,
    rootUserId: perfUserId(1),
    deepUserId: perfUserId(employees),
    employees,
    auditEvents,
    notifications,
  };
}
