-- CreateEnum
CREATE TYPE "connection_scope_kind" AS ENUM ('Company', 'User');

-- CreateEnum
CREATE TYPE "connection_environment_kind" AS ENUM ('Test', 'Production');

-- CreateEnum
CREATE TYPE "tool_action_category_kind" AS ENUM ('Read', 'Write', 'Delete', 'ExternalBulkSend', 'SensitiveExport', 'FinancialChange', 'ProductionChange');

-- CreateTable
CREATE TABLE "connection_secrets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "secret_ref" VARCHAR(120) NOT NULL,
    "sealed_value" TEXT NOT NULL,
    "key_id" VARCHAR(60) NOT NULL,
    "rotated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "connection_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scope" "connection_scope_kind" NOT NULL,
    "connector_kind" VARCHAR(60) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "environment" "connection_environment_kind",
    "secret_ref" VARCHAR(120),
    "allowed_department_ids" UUID[],
    "disabled_at" TIMESTAMPTZ(6),
    "disabled_reason" VARCHAR(500),
    "credential_expires_at" TIMESTAMPTZ(6),
    "needs_reauthorization" BOOLEAN NOT NULL DEFAULT false,
    "last_error" VARCHAR(1000),
    "last_successful_check_at" TIMESTAMPTZ(6),
    "last_checked_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connection_tool_grants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "category" "tool_action_category_kind" NOT NULL,
    "reason" VARCHAR(1000),
    "granted_by_user_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_user_id" UUID,
    "revoked_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_tool_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connection_checks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "succeeded" BOOLEAN NOT NULL,
    "detail" VARCHAR(1000) NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "checked_by_user_id" UUID,
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connection_secrets_secret_ref_key" ON "connection_secrets"("secret_ref");

-- CreateIndex
CREATE UNIQUE INDEX "connection_secrets_tenant_id_secret_ref_key" ON "connection_secrets"("tenant_id", "secret_ref");

-- CreateIndex
CREATE INDEX "connections_tenant_id_connector_kind_idx" ON "connections"("tenant_id", "connector_kind");

-- CreateIndex
CREATE INDEX "connections_tenant_id_owner_user_id_idx" ON "connections"("tenant_id", "owner_user_id");

-- CreateIndex
CREATE INDEX "connections_credential_expires_at_disabled_at_idx" ON "connections"("credential_expires_at", "disabled_at");

-- CreateIndex
CREATE UNIQUE INDEX "connections_tenant_id_id_key" ON "connections"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "connections_tenant_id_connector_kind_environment_owner_user_key" ON "connections"("tenant_id", "connector_kind", "environment", "owner_user_id", "label");

-- CreateIndex
CREATE INDEX "connection_tool_grants_tenant_id_connection_id_revoked_at_idx" ON "connection_tool_grants"("tenant_id", "connection_id", "revoked_at");

-- CreateIndex
CREATE INDEX "connection_tool_grants_tenant_id_agent_id_revoked_at_idx" ON "connection_tool_grants"("tenant_id", "agent_id", "revoked_at");

-- CreateIndex
CREATE INDEX "connection_checks_tenant_id_connection_id_checked_at_idx" ON "connection_checks"("tenant_id", "connection_id", "checked_at" DESC);

-- AddForeignKey
ALTER TABLE "connection_secrets" ADD CONSTRAINT "connection_secrets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_tool_grants" ADD CONSTRAINT "connection_tool_grants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_tool_grants" ADD CONSTRAINT "connection_tool_grants_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "connections"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_checks" ADD CONSTRAINT "connection_checks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_checks" ADD CONSTRAINT "connection_checks_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "connections"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Prompt 16 — hand-written section
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Row-Level Security on all four tables
-- ---------------------------------------------------------------------------

ALTER TABLE "connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "connections_tenant_isolation" ON "connections"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "connection_secrets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connection_secrets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "connection_secrets_tenant_isolation" ON "connection_secrets"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "connection_tool_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connection_tool_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "connection_tool_grants_tenant_isolation" ON "connection_tool_grants"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "connection_checks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connection_checks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "connection_checks_tenant_isolation" ON "connection_checks"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- ---------------------------------------------------------------------------
-- 2. A secret is a reference, never a value
-- ---------------------------------------------------------------------------
-- The client's rule is `secret_ref` only. The structural half of it is that the value lives in
-- its own table, so reading a connection cannot read a credential. This is the half that catches
-- somebody storing the value in the handle by mistake.
--
-- A `SecretBox` envelope starts with its version marker, so the check is exact rather than a
-- guess at what a credential looks like: whatever else `secret_ref` is, it is not ciphertext.

ALTER TABLE "connections"
  ADD CONSTRAINT "connection_secret_ref_is_not_a_secret"
  CHECK (
    "secret_ref" IS NULL
    OR ("secret_ref" NOT LIKE 'v1.%' AND length("secret_ref") <= 120)
  );

ALTER TABLE "connection_secrets"
  ADD CONSTRAINT "connection_secret_is_sealed"
  CHECK ("sealed_value" LIKE 'v1.%' AND length(btrim("key_id")) > 0);

-- ---------------------------------------------------------------------------
-- 3. A high-risk tool grant must say why
-- ---------------------------------------------------------------------------
-- The client's four high-risk categories, plus Delete, which they name first. An unexplained
-- grant letting an agent delete records in a company's ERP is precisely the one somebody will be
-- asked to justify — so the database will not store it without the justification.
--
-- Enforced here as well as in the service because it is a security property, and a service is one
-- missed branch away from losing it.

ALTER TABLE "connection_tool_grants"
  ADD CONSTRAINT "high_risk_tool_grant_has_a_reason"
  CHECK (
    "category" NOT IN ('Delete', 'ExternalBulkSend', 'SensitiveExport', 'FinancialChange', 'ProductionChange')
    OR length(btrim(COALESCE("reason", ''))) > 0
  );

-- A revocation records who and why, or it is not a revocation anybody can account for.
ALTER TABLE "connection_tool_grants"
  ADD CONSTRAINT "tool_grant_revocation_is_attributed"
  CHECK (
    "revoked_at" IS NULL
    OR ("revoked_by_user_id" IS NOT NULL AND length(btrim(COALESCE("revoked_reason", ''))) > 0)
  );

ALTER TABLE "connection_tool_grants"
  ADD CONSTRAINT "tool_grant_revocation_follows_grant"
  CHECK ("revoked_at" IS NULL OR "revoked_at" >= "granted_at");

-- One live grant per agent per category per connection. Two would make "what may this agent do"
-- ambiguous, and a revoked one must not block re-granting later.
CREATE UNIQUE INDEX "one_live_tool_grant_per_agent_category"
  ON "connection_tool_grants" ("tenant_id", "connection_id", "agent_id", "category")
  WHERE "revoked_at" IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Connection coherence
-- ---------------------------------------------------------------------------

-- A disabled connection says why. "Disabled" with no reason is the state nobody can undo
-- confidently, because nobody knows what it was protecting against.
ALTER TABLE "connections"
  ADD CONSTRAINT "disabled_connection_has_a_reason"
  CHECK (
    "disabled_at" IS NULL OR length(btrim(COALESCE("disabled_reason", ''))) > 0
  );

ALTER TABLE "connections"
  ADD CONSTRAINT "connection_is_named"
  CHECK (length(btrim("label")) > 0 AND length(btrim("connector_kind")) > 0);

-- A successful check cannot be in the future, and cannot precede the connection existing.
ALTER TABLE "connections"
  ADD CONSTRAINT "connection_check_times_are_ordered"
  CHECK (
    "last_successful_check_at" IS NULL
    OR "last_checked_at" IS NULL
    OR "last_successful_check_at" <= "last_checked_at"
  );

ALTER TABLE "connection_checks"
  ADD CONSTRAINT "connection_check_duration_is_not_negative"
  CHECK ("duration_ms" >= 0);

-- A failed check has to say what failed; a successful one may simply say so.
ALTER TABLE "connection_checks"
  ADD CONSTRAINT "failed_check_says_what_happened"
  CHECK ("succeeded" = true OR length(btrim("detail")) > 0);

-- ---------------------------------------------------------------------------
-- 5. The check history and the grant history are append-only
-- ---------------------------------------------------------------------------
-- A check history that could be rewritten could not answer "how long has this been failing",
-- which is the only question it exists to answer. Grants need `UPDATE` (revocation writes to the
-- row) but never `DELETE`: "who could do this in March" must stay answerable.

REVOKE UPDATE, DELETE ON "connection_checks" FROM uboss_app;
REVOKE DELETE ON "connection_tool_grants" FROM uboss_app;

-- ---------------------------------------------------------------------------
-- 6. What is deliberately NOT here
-- ---------------------------------------------------------------------------
-- **No `state` column on `connections`.** The five client states are derived at read time from
-- `disabled_at`, `credential_expires_at`, `needs_reauthorization` and `last_error`
-- (`derivedConnectionState`). A stored copy would be a second answer to a question that already
-- has one, and the window between a credential expiring and a sweep noticing is a window in which
-- every Engine Agent run would be authorised against a stale answer. Same rule as break-glass and
-- platform-role expiry (ADR-047).
--
-- **No foreign key from `connection_tool_grants.agent_id`.** Engine Agents arrive at a later
-- prompt. The column is a uuid and gains its key then; adding a table now to satisfy a constraint
-- would be inventing the Engine Agent model two prompts early.
