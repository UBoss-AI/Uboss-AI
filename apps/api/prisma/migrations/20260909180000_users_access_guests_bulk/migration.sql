-- CreateEnum
CREATE TYPE "bulk_operation_kind" AS ENUM ('ImportEmployees', 'InviteOrResend', 'RoleAndScope', 'ManagerOrDepartment', 'SuspendOrOffboard');

-- CreateEnum
CREATE TYPE "bulk_operation_state" AS ENUM ('Validating', 'Validated', 'Applying', 'Applied', 'Cancelled');

-- CreateEnum
CREATE TYPE "bulk_row_state" AS ENUM ('Valid', 'Invalid', 'Applied', 'Skipped', 'Failed');

-- CreateEnum
CREATE TYPE "offboarding_state" AS ENUM ('Requested', 'Completed', 'Cancelled');

-- AlterTable
ALTER TABLE "tenant_memberships" ADD COLUMN     "guest_access_expires_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "bulk_operations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "bulk_operation_kind" NOT NULL,
    "state" "bulk_operation_state" NOT NULL DEFAULT 'Validating',
    "requested_by_user_id" UUID NOT NULL,
    "source_file_name" VARCHAR(260),
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "invalid_rows" INTEGER NOT NULL DEFAULT 0,
    "applied_rows" INTEGER NOT NULL DEFAULT 0,
    "failed_rows" INTEGER NOT NULL DEFAULT 0,
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "reason" VARCHAR(1000),
    "validated_at" TIMESTAMPTZ(6),
    "applied_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "bulk_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_operation_rows" (
    "id" UUID NOT NULL,
    "bulk_operation_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "state" "bulk_row_state" NOT NULL DEFAULT 'Valid',
    "input" JSONB NOT NULL,
    "errors" TEXT[],
    "subject_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bulk_operation_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offboardings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_user_id" UUID NOT NULL,
    "successor_user_id" UUID,
    "state" "offboarding_state" NOT NULL DEFAULT 'Requested',
    "reason" VARCHAR(1000) NOT NULL,
    "handover" JSONB NOT NULL DEFAULT '{}',
    "effective_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requested_by_user_id" UUID NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "offboardings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bulk_operations_tenant_id_state_created_at_idx" ON "bulk_operations"("tenant_id", "state", "created_at" DESC);

-- CreateIndex
CREATE INDEX "bulk_operation_rows_tenant_id_state_idx" ON "bulk_operation_rows"("tenant_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "bulk_operations_tenant_id_id_key" ON "bulk_operations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bulk_operation_rows_bulk_operation_id_row_number_key" ON "bulk_operation_rows"("bulk_operation_id", "row_number");

-- CreateIndex
CREATE INDEX "offboardings_tenant_id_state_idx" ON "offboardings"("tenant_id", "state");

-- CreateIndex
CREATE INDEX "offboardings_tenant_id_subject_user_id_idx" ON "offboardings"("tenant_id", "subject_user_id");

-- AddForeignKey
ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_operation_rows" ADD CONSTRAINT "bulk_operation_rows_tenant_id_bulk_operation_id_fkey" FOREIGN KEY ("tenant_id", "bulk_operation_id") REFERENCES "bulk_operations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offboardings" ADD CONSTRAINT "offboardings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Prompt 13 — hand-written section
-- ===========================================================================
-- Six properties enforced here rather than only in the service layer:
--
--   1. **Tenant isolation** on the three new tenant-owned tables, fail-closed.
--   2. **A bulk row cannot belong to another tenant's operation.** A composite foreign key
--      (ADR-064), because a row is read under RLS by its own `tenant_id` and a mismatch would
--      make one company's row invisible inside its own operation — or worse, visible in another's.
--   3. **A guest has an expiry, and nobody else does.** Both directions, so "guest" and "has an
--      end date" cannot drift apart.
--   4. **A guest is outside the hierarchy.** A trigger, because it is a cross-table invariant.
--   5. **An offboarding cannot be its own successor**, and a completed one must say when.
--   6. **A bulk operation's counts cannot exceed its row count**, so a summary screen cannot
--      display an impossible number.

-- ---------------------------------------------------------------------------
-- 1. Same-tenant referential integrity — declared in the Prisma schema
-- ---------------------------------------------------------------------------
-- `bulk_operation_rows_tenant_id_bulk_operation_id_fkey`, in the generated section above,
-- references the **pair** so a row cannot belong to another tenant's operation (ADR-064). The
-- row carries its own tenant_id so it can be read under RLS without joining its parent, and the
-- composite key is what stops the two from disagreeing.
--
-- Declared in the schema rather than written by hand, for the reason Prompt 12 discovered: a
-- constraint Prisma cannot see is drift, and the next generated migration drops it.

-- ---------------------------------------------------------------------------
-- 2. Row-Level Security on the three new tenant-owned tables
-- ---------------------------------------------------------------------------

ALTER TABLE "bulk_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bulk_operations" FORCE ROW LEVEL SECURITY;

CREATE POLICY "bulk_operations_tenant_isolation" ON "bulk_operations"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "bulk_operation_rows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bulk_operation_rows" FORCE ROW LEVEL SECURITY;

CREATE POLICY "bulk_operation_rows_tenant_isolation" ON "bulk_operation_rows"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "offboardings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "offboardings" FORCE ROW LEVEL SECURITY;

CREATE POLICY "offboardings_tenant_isolation" ON "offboardings"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

-- ---------------------------------------------------------------------------
-- 3. A guest has an access expiry, and nobody else has one
-- ---------------------------------------------------------------------------
-- Both directions on purpose. Without the second half, an internal employee could be given an
-- expiry date that nothing enforces and nothing displays — a field that looks like a control and
-- is not. Without the first, a guest account outlives the project it was created for, which is
-- the failure the client's "expiry-capable" requirement exists to prevent.

ALTER TABLE "tenant_memberships"
  ADD CONSTRAINT "guest_membership_has_an_expiry"
  CHECK (
    ("user_type" = 'ExternalGuest' AND "guest_access_expires_at" IS NOT NULL)
    OR ("user_type" <> 'ExternalGuest' AND "guest_access_expires_at" IS NULL)
  );

-- ---------------------------------------------------------------------------
-- 4. A guest stays outside the hierarchy
-- ---------------------------------------------------------------------------
-- The client's rule: "Guests stay outside hierarchy and receive resource-specific,
-- expiry-capable access." A guest with an employment record would appear in the org chart, count
-- toward a department's headcount, and be selectable as somebody's reporting manager — none of
-- which is true of a contractor or a client contact.
--
-- A trigger rather than a constraint because it spans two tables. It fires from **both** sides:
-- creating an employment record for an existing guest, and switching a membership to guest when
-- an employment record already exists. One direction alone leaves the other reachable.

CREATE OR REPLACE FUNCTION uboss_guest_has_no_employment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  guest boolean;
BEGIN
  SELECT (m."user_type" = 'ExternalGuest')
    INTO guest
    FROM "tenant_memberships" m
   WHERE m."tenant_id" = NEW."tenant_id" AND m."user_id" = NEW."user_id";

  IF COALESCE(guest, false) THEN
    RAISE EXCEPTION
      'User % is an External Guest in tenant %, and guests stay outside the hierarchy. A guest '
      'with an employment record would appear in the org chart and be selectable as somebody''s '
      'reporting manager.', NEW."user_id", NEW."tenant_id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "employment_record_subject_is_not_a_guest"
  BEFORE INSERT OR UPDATE OF "user_id" ON "employment_records"
  FOR EACH ROW EXECUTE FUNCTION uboss_guest_has_no_employment();

CREATE OR REPLACE FUNCTION uboss_employed_person_is_not_a_guest()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."user_type" = 'ExternalGuest'
     AND EXISTS (
       SELECT 1 FROM "employment_records" e
        WHERE e."tenant_id" = NEW."tenant_id" AND e."user_id" = NEW."user_id"
     ) THEN
    RAISE EXCEPTION
      'User % has an employment record in tenant % and cannot be converted to an External Guest. '
      'End their employment first — a guest is outside the hierarchy by definition.',
      NEW."user_id", NEW."tenant_id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "guest_membership_has_no_employment"
  BEFORE INSERT OR UPDATE OF "user_type" ON "tenant_memberships"
  FOR EACH ROW EXECUTE FUNCTION uboss_employed_person_is_not_a_guest();

-- ---------------------------------------------------------------------------
-- 5. Offboarding coherence
-- ---------------------------------------------------------------------------

ALTER TABLE "offboardings"
  ADD CONSTRAINT "offboarding_successor_is_somebody_else"
  CHECK ("successor_user_id" IS NULL OR "successor_user_id" <> "subject_user_id");

ALTER TABLE "offboardings"
  ADD CONSTRAINT "offboarding_reason_is_not_blank"
  CHECK (length(btrim("reason")) > 0);

-- A terminal state must carry its timestamp, or "when did this person lose access" has no answer.
ALTER TABLE "offboardings"
  ADD CONSTRAINT "offboarding_terminal_state_is_timestamped"
  CHECK (
    ("state" = 'Requested' AND "completed_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("state" = 'Completed' AND "completed_at" IS NOT NULL)
    OR ("state" = 'Cancelled' AND "cancelled_at" IS NOT NULL)
  );

-- One open offboarding per person. Two would race each other to move the same work.
CREATE UNIQUE INDEX "one_open_offboarding_per_person"
  ON "offboardings" ("tenant_id", "subject_user_id")
  WHERE "state" = 'Requested';

-- ---------------------------------------------------------------------------
-- 6. A bulk operation's counts cannot be impossible
-- ---------------------------------------------------------------------------
-- A summary screen reads these four numbers. If they can exceed the row count, the screen can
-- display "402 of 400 applied", and every number on it stops being believable.

ALTER TABLE "bulk_operations"
  ADD CONSTRAINT "bulk_counts_are_not_negative"
  CHECK (
    "total_rows" >= 0 AND "valid_rows" >= 0 AND "invalid_rows" >= 0
    AND "applied_rows" >= 0 AND "failed_rows" >= 0
  );

ALTER TABLE "bulk_operations"
  ADD CONSTRAINT "bulk_counts_fit_within_total"
  CHECK (
    "valid_rows" + "invalid_rows" <= "total_rows"
    AND "applied_rows" + "failed_rows" <= "total_rows"
  );

ALTER TABLE "bulk_operations"
  ADD CONSTRAINT "bulk_terminal_state_is_timestamped"
  CHECK (
    ("state" <> 'Applied' OR "applied_at" IS NOT NULL)
    AND ("state" <> 'Cancelled' OR "cancelled_at" IS NOT NULL)
  );

ALTER TABLE "bulk_operation_rows"
  ADD CONSTRAINT "bulk_row_number_is_one_based"
  CHECK ("row_number" >= 1);

-- An invalid row must say why. "Invalid" with no errors is a row nobody can fix.
--
-- **COALESCE, and it is load-bearing.**  is NULL, not 0, so
--  evaluates to NULL for an empty array — and a CHECK constraint treats
-- NULL as **satisfied**. Without the COALESCE this constraint accepts exactly the row it exists
-- to refuse. Verified by inserting one.
ALTER TABLE "bulk_operation_rows"
  ADD CONSTRAINT "invalid_bulk_row_has_errors"
  -- **COALESCE, and it is load-bearing.** `array_length(ARRAY[]::text[], 1)` is NULL, not 0, so
  -- `array_length(...) >= 1` evaluates to NULL for an empty array — and a CHECK constraint
  -- treats NULL as **satisfied**. Without the COALESCE this constraint accepts exactly the row
  -- it exists to refuse. Verified by inserting one.
  CHECK ("state" <> 'Invalid' OR COALESCE(array_length("errors", 1), 0) >= 1);

-- ---------------------------------------------------------------------------
-- 7. Correcting the same NULL mistake in the Prompt 11 constraint
-- ---------------------------------------------------------------------------
-- `commercial_request_names_what_it_wants` has the identical bug, found while testing this
-- migration's version of it: for `kind = 'ModuleEntitlement'` with an empty module list, every
-- other branch of the OR is false and that branch is NULL, so the whole expression is NULL and
-- the row is **accepted**. A request nobody can act on could therefore sit in the platform queue
-- looking like work in progress — the exact failure the constraint was added to prevent.
--
-- Corrected here rather than by editing the Prompt 11 migration, so the chain records that the
-- defect existed and when it was found. `CommercialService.assertRequestNamesSomething` was
-- always refusing it at the API, so no such row could be created through the product; the
-- database was simply not the second layer it claimed to be.

ALTER TABLE "commercial_change_requests"
  DROP CONSTRAINT "commercial_request_names_what_it_wants";

ALTER TABLE "commercial_change_requests"
  ADD CONSTRAINT "commercial_request_names_what_it_wants"
  CHECK (
    ("kind" IN ('MoreSeats', 'FewerSeats') AND "requested_seats" IS NOT NULL AND "requested_seats" > 0)
    OR ("kind" IN ('PlanUpgrade', 'PlanDowngrade') AND "requested_plan_code" IS NOT NULL)
    OR ("kind" = 'MoreAiAllowance' AND "requested_allowance_minor" IS NOT NULL AND "requested_allowance_minor" > 0)
    OR ("kind" = 'ModuleEntitlement' AND COALESCE(array_length("requested_modules", 1), 0) > 0)
  );
