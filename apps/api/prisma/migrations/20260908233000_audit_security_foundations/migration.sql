-- Prompt 8 — Audit and security foundations.
--
-- Three new tables and seven new columns, then a block of hand-written
-- statements that turn "append-only" from a code convention into a database
-- property.
--
--   security_events           the security trail: login, session, risk, support
--   audit_chain_checkpoints   sealed chain positions, the seam for an external anchor
--   break_glass_requests      emergency access, with its full paper trail
--
-- The seven new `audit_events` columns are all NULLABLE, including the four
-- chain columns. Existing rows are deliberately NOT retro-chained: computing
-- hashes now over rows whose integrity was never protected would produce a
-- chain that verifies and proves nothing. Verification reports the unchained
-- count instead of hiding it. ADR-046.
--
-- One consequence worth knowing before it surprises somebody: with the
-- append-only trigger in place, a hard `DELETE FROM tenants` now FAILS, because
-- the cascade would delete that tenant's audit rows. That is the intended
-- reading — closing a company must not erase what it did — and nothing in the
-- application hard-deletes a tenant (lifecycle state does that job). The test
-- harness truncates, which has its own narrow escape hatch below.

-- CreateEnum
CREATE TYPE "security_event_category" AS ENUM ('Login', 'Session', 'Risk', 'Support', 'Access');

-- CreateEnum
CREATE TYPE "security_event_severity" AS ENUM ('Info', 'Notice', 'Warning', 'Critical');

-- CreateEnum
CREATE TYPE "security_event_outcome" AS ENUM ('Succeeded', 'Failed', 'Blocked');

-- CreateEnum
CREATE TYPE "break_glass_state" AS ENUM ('Requested', 'IdentityVerified', 'Approved', 'Denied', 'Active', 'Expired', 'Revoked');

-- CreateEnum
CREATE TYPE "identity_verification_state" AS ENUM ('Unverified', 'VerifiedByHuman', 'VerifiedBySecondFactor', 'Failed');

-- CreateEnum
CREATE TYPE "customer_notification_state" AS ENUM ('Pending', 'Sent', 'Failed', 'Suppressed');

-- AlterTable
ALTER TABLE "audit_events" ADD COLUMN     "chain_key" VARCHAR(64),
ADD COLUMN     "prev_hash" VARCHAR(64),
ADD COLUMN     "reason" VARCHAR(1000),
ADD COLUMN     "resource_ref" VARCHAR(120),
ADD COLUMN     "resource_version" INTEGER,
ADD COLUMN     "row_hash" VARCHAR(64),
ADD COLUMN     "sequence" BIGINT;

-- CreateTable
CREATE TABLE "security_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "category" "security_event_category" NOT NULL,
    "severity" "security_event_severity" NOT NULL DEFAULT 'Info',
    "outcome" "security_event_outcome" NOT NULL DEFAULT 'Succeeded',
    "action" VARCHAR(120) NOT NULL,
    "actor_user_id" UUID,
    "subject_user_id" UUID,
    "resource_type" VARCHAR(60),
    "resource_id" VARCHAR(64),
    "reason" VARCHAR(500),
    "metadata" JSONB,
    "device_label" VARCHAR(120),
    "client_hint" VARCHAR(64),
    "correlation_id" VARCHAR(64),
    "chain_key" VARCHAR(64) NOT NULL,
    "sequence" BIGINT NOT NULL,
    "prev_hash" VARCHAR(64),
    "row_hash" VARCHAR(64) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_chain_checkpoints" (
    "id" UUID NOT NULL,
    "chain_key" VARCHAR(64) NOT NULL,
    "trail" VARCHAR(16) NOT NULL,
    "sequence" BIGINT NOT NULL,
    "row_hash" VARCHAR(64) NOT NULL,
    "row_count" BIGINT NOT NULL,
    "external_anchor_ref" VARCHAR(300),
    "anchored_at" TIMESTAMPTZ(6),
    "sealed_by_user_id" UUID,
    "sealed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_chain_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "break_glass_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requester_user_id" UUID NOT NULL,
    "state" "break_glass_state" NOT NULL DEFAULT 'Requested',
    "identity_verification_state" "identity_verification_state" NOT NULL DEFAULT 'Unverified',
    "identity_verification_note" VARCHAR(500),
    "identity_verified_by_user_id" UUID,
    "identity_verified_at" TIMESTAMPTZ(6),
    "reason" VARCHAR(1000) NOT NULL,
    "external_reference" VARCHAR(300),
    "allowed_modules" TEXT[],
    "allowed_actions" TEXT[],
    "allowed_resource_ids" TEXT[],
    "approver_user_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "approval_note" VARCHAR(500),
    "denied_at" TIMESTAMPTZ(6),
    "activated_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_user_id" UUID,
    "revocation_reason" VARCHAR(500),
    "customer_notification_state" "customer_notification_state" NOT NULL DEFAULT 'Pending',
    "customer_notified_at" TIMESTAMPTZ(6),
    "notification_suppression_reason" VARCHAR(500),
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "break_glass_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_events_tenant_id_occurred_at_idx" ON "security_events"("tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "security_events_actor_user_id_occurred_at_idx" ON "security_events"("actor_user_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "security_events_tenant_id_category_occurred_at_idx" ON "security_events"("tenant_id", "category", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "security_events_severity_occurred_at_idx" ON "security_events"("severity", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "security_events_chain_key_sequence_key" ON "security_events"("chain_key", "sequence");

-- CreateIndex
CREATE INDEX "audit_chain_checkpoints_chain_key_trail_sealed_at_idx" ON "audit_chain_checkpoints"("chain_key", "trail", "sealed_at" DESC);

-- CreateIndex
CREATE INDEX "break_glass_requests_tenant_id_created_at_idx" ON "break_glass_requests"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "break_glass_requests_state_expires_at_idx" ON "break_glass_requests"("state", "expires_at");

-- CreateIndex
CREATE INDEX "break_glass_requests_customer_notification_state_state_idx" ON "break_glass_requests"("customer_notification_state", "state");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_action_occurred_at_idx" ON "audit_events"("tenant_id", "action", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_chain_key_sequence_key" ON "audit_events"("chain_key", "sequence");

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "break_glass_requests" ADD CONSTRAINT "break_glass_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- HAND-WRITTEN ADDITIONS (not generated by `prisma migrate diff`)
-- ===========================================================================
--
-- This is where "append-only" stops being a convention and becomes something
-- the database enforces. Up to now `audit_events` was append-only because no
-- repository method updated or deleted a row — true, but a property of the
-- code rather than of the data.
--
-- The exact guarantee these statements provide, and what they do NOT provide,
-- is written out in docs/ARCHITECTURE_DECISIONS.md ADR-046 and
-- docs/SECURITY_DECISIONS.md S-049. Read that before relying on it.

-- ---------------------------------------------------------------------------
-- 1. The application role cannot modify or remove a trail row.
-- ---------------------------------------------------------------------------
-- `uboss_app` is the role the API connects as. Revoking UPDATE and DELETE means
-- a compromised application — an injection, a rogue endpoint, a mistaken
-- migration run through the app's connection — CANNOT alter history. It can
-- still append, which is the only thing it needs to do.
--
-- This is the strongest control in this migration, and it is a privilege rather
-- than a hash: it *prevents* rather than *detects*.
REVOKE UPDATE, DELETE ON "audit_events" FROM uboss_app;
REVOKE UPDATE, DELETE ON "security_events" FROM uboss_app;

-- Checkpoints are also append-only: a checkpoint that could be rewritten would
-- be useless as an anchor.
REVOKE UPDATE, DELETE ON "audit_chain_checkpoints" FROM uboss_app;

-- Future tables must not silently inherit UPDATE/DELETE on these. The default
-- privileges set in Prompt 4 grant all four verbs on new tables; that is right
-- for business tables and wrong for these three, so the revoke above is
-- explicit and permanent rather than relying on the default.

-- ---------------------------------------------------------------------------
-- 2. A trigger, so even the owner role cannot quietly rewrite history.
-- ---------------------------------------------------------------------------
-- The revoke above does not bind the table owner (`uboss`), which is the role
-- migrations and seeds run as. A trigger does: it fires regardless of
-- privilege, so a mistaken `UPDATE audit_events SET ...` in a future migration
-- fails loudly instead of succeeding.
--
-- Honest limit: a superuser can `ALTER TABLE ... DISABLE TRIGGER`. This raises
-- the bar from "any owner-level statement" to "a deliberate, separately
-- auditable schema change", and it is not a defence against a database
-- superuser. Nothing inside the database can be.
CREATE OR REPLACE FUNCTION uboss_refuse_history_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'uboss: % on % is refused. This trail is append-only; correcting a record means appending a '
    'correcting event, not editing history. See ADR-046.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION uboss_refuse_history_change();

CREATE TRIGGER security_events_append_only
  BEFORE UPDATE OR DELETE ON "security_events"
  FOR EACH ROW EXECUTE FUNCTION uboss_refuse_history_change();

CREATE TRIGGER audit_chain_checkpoints_append_only
  BEFORE UPDATE OR DELETE ON "audit_chain_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION uboss_refuse_history_change();

-- TRUNCATE bypasses row-level triggers entirely, so it needs its own
-- statement-level one. Without this, `TRUNCATE audit_events` would silently
-- erase the whole trail while both controls above looked intact.
--
-- The integration test suite truncates these tables between tests, which is why
-- the trigger checks a session flag: a test harness sets
-- `uboss.allow_history_truncate` for the duration of its reset, and nothing in
-- the application ever sets it. That is a deliberate, narrow escape hatch with
-- a name that makes its use obvious in a grep.
CREATE OR REPLACE FUNCTION uboss_refuse_history_truncate() RETURNS trigger AS $$
BEGIN
  IF COALESCE(current_setting('uboss.allow_history_truncate', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION
    'uboss: TRUNCATE on % is refused. This trail is append-only. A test harness may set '
    'uboss.allow_history_truncate; nothing in the application does. See ADR-046.',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION uboss_refuse_history_truncate();

CREATE TRIGGER security_events_no_truncate
  BEFORE TRUNCATE ON "security_events"
  FOR EACH STATEMENT EXECUTE FUNCTION uboss_refuse_history_truncate();

CREATE TRIGGER audit_chain_checkpoints_no_truncate
  BEFORE TRUNCATE ON "audit_chain_checkpoints"
  FOR EACH STATEMENT EXECUTE FUNCTION uboss_refuse_history_truncate();

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security on the new tables.
-- ---------------------------------------------------------------------------
-- Same fail-closed policy as Prompt 4. `security_events` has a nullable
-- tenant_id for platform-plane identity events, which are therefore visible
-- only during a declared platform operation — exactly as `audit_events`
-- already handles them.
--
-- `audit_chain_checkpoints` keys on `chain_key` rather than a tenant_id
-- column, because a chain key is either a tenant id or the literal 'platform'.
-- The policy compares it to the declared scope as text.

ALTER TABLE "security_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "security_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY security_events_tenant_isolation ON "security_events"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "break_glass_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "break_glass_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY break_glass_requests_tenant_isolation ON "break_glass_requests"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "audit_chain_checkpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_chain_checkpoints" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_chain_checkpoints_isolation ON "audit_chain_checkpoints"
  USING (
    "chain_key" = NULLIF(current_setting('app.current_tenant_id', true), '')
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "chain_key" = NULLIF(current_setting('app.current_tenant_id', true), '')
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

-- ---------------------------------------------------------------------------
-- 4. Break-glass cannot be stored in an unsafe shape.
-- ---------------------------------------------------------------------------
-- The service enforces the workflow; these make sure the service is not the
-- only thing that does. Each one describes a combination that, if it existed in
-- the table, would be a standing back door.

-- The approver is never the requester. Self-approved break-glass is not
-- break-glass, it is unaudited access with paperwork.
ALTER TABLE "break_glass_requests"
  ADD CONSTRAINT "break_glass_approver_is_not_requester"
  CHECK ("approver_user_id" IS NULL OR "approver_user_id" <> "requester_user_id");

-- Approved or Active requires an approver and an expiry. Break-glass with no
-- expiry is a permanent grant.
ALTER TABLE "break_glass_requests"
  ADD CONSTRAINT "break_glass_approved_needs_approver_and_expiry"
  CHECK (
    "state" NOT IN ('Approved', 'Active')
    OR ("approver_user_id" IS NOT NULL AND "expires_at" IS NOT NULL)
  );

-- Approved or Active requires a verified identity. "Approved but we never
-- checked who asked" must be unrepresentable.
ALTER TABLE "break_glass_requests"
  ADD CONSTRAINT "break_glass_approved_needs_verified_identity"
  CHECK (
    "state" NOT IN ('Approved', 'Active')
    OR "identity_verification_state" IN ('VerifiedByHuman', 'VerifiedBySecondFactor')
  );

-- Withholding customer notification needs a written reason.
ALTER TABLE "break_glass_requests"
  ADD CONSTRAINT "break_glass_suppression_needs_reason"
  CHECK (
    "customer_notification_state" <> 'Suppressed'
    OR ("notification_suppression_reason" IS NOT NULL
        AND length(btrim("notification_suppression_reason")) > 0)
  );

-- A reason is mandatory in substance, not just in type: an empty string is not
-- a reason.
ALTER TABLE "break_glass_requests"
  ADD CONSTRAINT "break_glass_reason_is_not_blank"
  CHECK (length(btrim("reason")) > 0);
