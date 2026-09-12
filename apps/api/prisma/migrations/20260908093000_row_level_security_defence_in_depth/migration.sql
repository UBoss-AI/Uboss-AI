-- Row-Level Security as defence in depth.
--
-- This is a SECOND layer. The authoritative check remains the application's tenant scoping
-- (see src/persistence/tenant-context.ts and the TenantGuard); the Master Prompt is explicit
-- that RLS must not be the only authorization layer. RLS exists to catch the realistic bug —
-- a query that forgets `WHERE tenant_id = ...` — before it becomes a cross-tenant data leak.
--
-- Two facts about this database made a naive setup useless, and both are handled below:
--   1. The owner role `uboss` is a SUPERUSER with rolbypassrls, so policies would never apply
--      to it. The application therefore connects as a separate, deliberately unprivileged role.
--   2. A table owner bypasses RLS even without rolbypassrls, so FORCE ROW LEVEL SECURITY is set.

-- ---------------------------------------------------------------------------
-- 1. The application role: no superuser, no BYPASSRLS, no table ownership.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uboss_app') THEN
    -- Local development password. Real environments create this role out of band with a
    -- credential from a secret manager; it is never read from a committed file.
    CREATE ROLE uboss_app LOGIN PASSWORD 'uboss_app_local_dev' NOBYPASSRLS NOSUPERUSER;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO uboss_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uboss_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO uboss_app;
-- Tables created by future migrations must be reachable too.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO uboss_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO uboss_app;

-- The application must never alter the schema; migrations run as the owner.
REVOKE CREATE ON SCHEMA public FROM uboss_app;

-- ---------------------------------------------------------------------------
-- 2. Policies on the tenant-owned tables.
-- ---------------------------------------------------------------------------
-- Access is granted when EITHER:
--   * app.current_tenant_id matches the row's tenant_id  (a tenant-scoped request), OR
--   * app.platform_operation = 'on'                      (a deliberate platform-plane operation)
--
-- A code path that sets NEITHER sees zero rows. That is intentional: RLS fails CLOSED, so
-- forgetting to declare the scope is a visible, immediate failure rather than a silent leak.

ALTER TABLE "tenant_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_memberships" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_memberships_tenant_isolation ON "tenant_memberships"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;

-- audit_events.tenant_id is nullable: a NULL means a platform-plane event that belongs to no
-- company, so it is visible only during a platform operation and never inside a tenant session.
CREATE POLICY audit_events_tenant_isolation ON "audit_events"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

-- `tenants` and `users` are deliberately NOT under RLS:
--   * `tenants` is the tenant root, keyed by the tenant id itself, and the Master Console
--     legitimately reads across all of them.
--   * `users` is the permanent platform person identity — one human can belong to several
--     companies, so a tenant_id column would be wrong. Isolation for people is applied at the
--     membership join (UserRepository.findInTenant / listInTenant).
-- Both are still protected by the application layer and the guard.
