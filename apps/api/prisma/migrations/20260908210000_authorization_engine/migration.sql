-- Prompt 7 — the authorization engine.
--
-- Type: expand only. Every added column is nullable or carries a default and no existing row's
-- meaning changes:
--   * tenant_memberships.user_type defaults to 'InternalUser', which is truthfully what every
--     existing membership is — no external guest has been provisioned, because there was no way
--     to be one;
--   * external_user_type and external_allotment are null, correct because no membership came
--     through a TCSiON mapping (the approved reference has not been supplied).
--
-- Five new tables plus six enums. The authorization VOCABULARY is not here — it lives in
-- @uboss/types, shared with the web application so a permission the server enforces and one the
-- UI renders cannot drift apart. These tables are storage only.
--
-- The six built-in roles are deliberately NOT rows. A built-in role's meaning must be identical
-- in every company, and six rows per tenant would diverge under editing and migration. See
-- ROLE_TEMPLATES in @uboss/types, and ADR-038.
--
-- Rollback drops every role assignment, custom role and policy rule — i.e. everyone's authority.
-- Recorded in docs/DB_CHANGELOG.md so it is not discovered during an incident.

-- CreateEnum
CREATE TYPE "user_type" AS ENUM ('InternalUser', 'ExternalGuest', 'PlatformUser');

-- CreateEnum
CREATE TYPE "role_kind" AS ENUM ('Employee', 'Manager', 'Head', 'CompanyAdmin', 'Approver', 'Auditor', 'Custom');

-- CreateEnum
CREATE TYPE "scope_kind" AS ENUM ('OwnWork', 'SelectedResource', 'TeamSubtree', 'Department', 'MultipleDepartments', 'WholeCompany');

-- CreateEnum
CREATE TYPE "policy_layer" AS ENUM ('Platform', 'Company', 'Department', 'Objective', 'EngineAgent');

-- CreateEnum
CREATE TYPE "policy_effect" AS ENUM ('Deny', 'Allow');

-- CreateEnum
CREATE TYPE "sod_rule" AS ENUM ('NoSelfApproval', 'FourEyes');

-- AlterTable
ALTER TABLE "tenant_memberships" ADD COLUMN     "external_allotment" VARCHAR(120),
ADD COLUMN     "external_user_type" VARCHAR(120),
ADD COLUMN     "user_type" "user_type" NOT NULL DEFAULT 'InternalUser';

-- CreateTable
CREATE TABLE "custom_roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "display_name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "permissions" JSONB NOT NULL,
    "max_scope" "scope_kind" NOT NULL DEFAULT 'OwnWork',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "custom_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_kind" "role_kind" NOT NULL,
    "custom_role_id" UUID,
    "scope_kind" "scope_kind" NOT NULL,
    "department_ids" TEXT[],
    "selected_resource_ids" TEXT[],
    "expires_at" TIMESTAMPTZ(6),
    "granted_by_user_id" UUID,
    "justification" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_rules" (
    "id" UUID NOT NULL,
    "layer" "policy_layer" NOT NULL,
    "tenant_id" UUID,
    "department_id" VARCHAR(64),
    "objective_id" VARCHAR(64),
    "engine_agent_id" VARCHAR(64),
    "module" VARCHAR(64),
    "action" VARCHAR(32),
    "effect" "policy_effect" NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "max_scope" "scope_kind",
    "reason" VARCHAR(300) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "policy_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "separation_of_duties_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "layer" "policy_layer" NOT NULL DEFAULT 'Company',
    "module" VARCHAR(64),
    "action" VARCHAR(32) NOT NULL,
    "rule" "sod_rule" NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "reason" VARCHAR(300) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "separation_of_duties_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tcsion_mappings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "external_user_type" VARCHAR(120) NOT NULL,
    "external_allotment" VARCHAR(120),
    "uboss_user_type" "user_type" NOT NULL,
    "role_kind" "role_kind" NOT NULL,
    "custom_role_id" UUID,
    "scope_kind" "scope_kind" NOT NULL,
    "department_ids" TEXT[],
    "module_visibility" JSONB NOT NULL,
    "allowed_actions" JSONB NOT NULL,
    "approved_reference" VARCHAR(300) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tcsion_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_roles_tenant_id_enabled_idx" ON "custom_roles"("tenant_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "custom_roles_tenant_id_display_name_key" ON "custom_roles"("tenant_id", "display_name");

-- CreateIndex
CREATE INDEX "role_assignments_tenant_id_user_id_idx" ON "role_assignments"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "role_assignments_tenant_id_role_kind_idx" ON "role_assignments"("tenant_id", "role_kind");

-- CreateIndex
CREATE UNIQUE INDEX "role_assignments_tenant_id_user_id_role_kind_custom_role_id_key" ON "role_assignments"("tenant_id", "user_id", "role_kind", "custom_role_id");

-- CreateIndex
CREATE INDEX "policy_rules_tenant_id_layer_enabled_idx" ON "policy_rules"("tenant_id", "layer", "enabled");

-- CreateIndex
CREATE INDEX "policy_rules_layer_enabled_idx" ON "policy_rules"("layer", "enabled");

-- CreateIndex
CREATE INDEX "separation_of_duties_policies_tenant_id_enabled_idx" ON "separation_of_duties_policies"("tenant_id", "enabled");

-- CreateIndex
CREATE INDEX "separation_of_duties_policies_action_enabled_idx" ON "separation_of_duties_policies"("action", "enabled");

-- CreateIndex
CREATE INDEX "tcsion_mappings_tenant_id_enabled_idx" ON "tcsion_mappings"("tenant_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "tcsion_mappings_tenant_id_external_user_type_external_allot_key" ON "tcsion_mappings"("tenant_id", "external_user_type", "external_allotment");

-- CreateIndex
CREATE INDEX "tenant_memberships_tenant_id_user_type_idx" ON "tenant_memberships"("tenant_id", "user_type");

-- AddForeignKey
ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_custom_role_id_fkey" FOREIGN KEY ("custom_role_id") REFERENCES "custom_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_rules" ADD CONSTRAINT "policy_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "separation_of_duties_policies" ADD CONSTRAINT "separation_of_duties_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tcsion_mappings" ADD CONSTRAINT "tcsion_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN ADDITIONS (not generated by `prisma migrate diff`)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. A Custom role assignment must name a custom role, and a built-in one
--    must not.
-- ---------------------------------------------------------------------------
-- Prisma cannot express a check across an enum and a nullable foreign key, so
-- the service enforces it — and this constraint makes sure the service cannot
-- be the only thing that does. Without it, `roleKind = 'Custom'` with a null
-- `custom_role_id` would be an assignment that grants nothing while appearing
-- to grant something, and `roleKind = 'Employee'` with a custom role id would
-- be two answers to one question about what the person may do.
ALTER TABLE "role_assignments"
  ADD CONSTRAINT "role_assignments_custom_role_consistency"
  CHECK (
    ("role_kind" = 'Custom' AND "custom_role_id" IS NOT NULL)
    OR ("role_kind" <> 'Custom' AND "custom_role_id" IS NULL)
  );

-- Same rule for a TCSiON mapping's UBoss side: a mapping that resolves to
-- `Custom` with no role is a mapping that silently grants nothing.
ALTER TABLE "tcsion_mappings"
  ADD CONSTRAINT "tcsion_mappings_custom_role_consistency"
  CHECK (
    ("role_kind" = 'Custom' AND "custom_role_id" IS NOT NULL)
    OR ("role_kind" <> 'Custom' AND "custom_role_id" IS NULL)
  );

-- ---------------------------------------------------------------------------
-- 2. A policy rule must have a subject appropriate to its layer.
-- ---------------------------------------------------------------------------
-- The precedence chain only means anything if a rule knows what it applies to.
-- A `Department` rule with no department is a rule that would either apply
-- everywhere or nowhere, and both are wrong in a way that is hard to notice.
--
-- `Platform` is the deliberate exception: it applies to every company, so it
-- has no tenant.
ALTER TABLE "policy_rules"
  ADD CONSTRAINT "policy_rules_layer_subject"
  CHECK (
    ("layer" = 'Platform' AND "tenant_id" IS NULL)
    OR ("layer" = 'Company'    AND "tenant_id" IS NOT NULL)
    OR ("layer" = 'Department' AND "tenant_id" IS NOT NULL AND "department_id" IS NOT NULL)
    OR ("layer" = 'Objective'  AND "tenant_id" IS NOT NULL AND "objective_id" IS NOT NULL)
    OR ("layer" = 'EngineAgent' AND "tenant_id" IS NOT NULL AND "engine_agent_id" IS NOT NULL)
  );

-- A mandatory `Allow` is meaningless and dangerous: "mandatory" means lower
-- layers cannot lift it, and a grant lower layers cannot tighten is the one
-- thing the precedence rule forbids. Refused at the database so it cannot be
-- written by any path.
ALTER TABLE "policy_rules"
  ADD CONSTRAINT "policy_rules_mandatory_is_deny_only"
  CHECK ("effect" = 'Deny' OR "mandatory" = false);

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security on the new tenant-owned tables.
-- ---------------------------------------------------------------------------
-- Same fail-closed policy as Prompt 4. This matters as much here as it did for
-- `sso_connections`: a `role_assignments` row IS someone's authority, and a
-- query that forgot `WHERE tenant_id` would let one company read — or worse,
-- write — another company's permission grants.
--
-- `policy_rules` and `separation_of_duties_policies` have a NULLABLE tenant_id,
-- because a Platform-layer rule legitimately belongs to no company. That NULL
-- is visible only during a declared platform operation, exactly as
-- `audit_events` already handles platform-plane rows.

ALTER TABLE "custom_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "custom_roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY custom_roles_tenant_isolation ON "custom_roles"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "role_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY role_assignments_tenant_isolation ON "role_assignments"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "policy_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "policy_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY policy_rules_tenant_isolation ON "policy_rules"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "separation_of_duties_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "separation_of_duties_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY sod_policies_tenant_isolation ON "separation_of_duties_policies"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "tcsion_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tcsion_mappings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tcsion_mappings_tenant_isolation ON "tcsion_mappings"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

-- ---------------------------------------------------------------------------
-- 4. The platform separation-of-duties baseline.
-- ---------------------------------------------------------------------------
-- Seeded as DATA rather than left to a company to configure, because the
-- default has to be the safe one: a company that never opens the settings
-- screen should still not be able to self-approve. `mandatory = true` seals it,
-- so no Company, Department, Objective or Engine Agent layer can lift it.
--
-- `Approve` is the one action where self-approval is unambiguously wrong in
-- every business UBoss serves. `Publish` and `ManageAccess` are left to the
-- company: publishing your own draft is normal in a small team, and a
-- one-person company must be able to grant itself access.
--
-- Written idempotently so re-running the migration chain (or a db:reset) does
-- not duplicate it.
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
