
-- CreateTable
CREATE TABLE "company_exits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'Requested',
    "reason" VARCHAR(2000) NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requested_by_customer" BOOLEAN NOT NULL DEFAULT false,
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "approval_note" VARCHAR(1000),
    "read_only_days" INTEGER NOT NULL DEFAULT 30,
    "retention_days" INTEGER NOT NULL DEFAULT 30,
    "read_only_from" TIMESTAMPTZ(6),
    "retention_from" TIMESTAMPTZ(6),
    "deletion_eligible_from" TIMESTAMPTZ(6),
    "exported_at" TIMESTAMPTZ(6),
    "exported_by_user_id" UUID,
    "exported_row_count" INTEGER,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_user_id" UUID,
    "deletion_manifest" JSONB,
    "deleted_row_count" INTEGER,
    "preserved_row_count" INTEGER,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_user_id" UUID,
    "cancellation_reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "company_exits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "company_exits_state_deletion_eligible_from_idx" ON "company_exits"("state", "deletion_eligible_from");

-- CreateIndex
CREATE UNIQUE INDEX "company_exits_tenant_id_id_key" ON "company_exits"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "company_exits" ADD CONSTRAINT "company_exits_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Row-level security
-- ===========================================================================
--
-- Tenant-scoped, so a company sees its own exit and no other. Platform operators reach it through
-- `app.platform_operation`, which is how every Master Console read already works.
--
-- The row survives the deletion it describes: `TABLE_DISPOSITION` classifies `company_exits` as
-- an accountability record, and a deletion certificate that was deleted with the data would be
-- worthless.

ALTER TABLE "company_exits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_exits" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_exits_tenant_isolation ON "company_exits"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "company_exits" TO "uboss_app";

-- ===========================================================================
-- One open exit at a time
-- ===========================================================================
--
-- Two unfinished exits for one company would mean two answers to "when is our data deleted", and
-- the one a screen happened to read would win. A **partial** unique index, so the finished ones
-- accumulate as history.
CREATE UNIQUE INDEX "one_open_exit_per_company"
  ON "company_exits" ("tenant_id")
  WHERE "state" NOT IN ('Deleted', 'Cancelled');

-- ===========================================================================
-- The state list is known
-- ===========================================================================

ALTER TABLE "company_exits"
  ADD CONSTRAINT "exit_state_is_known"
  CHECK ("state" IN ('Requested', 'Approved', 'ReadOnly', 'RetentionHold', 'Deleted', 'Cancelled'));

-- An exit says why. It is the field a dispute is argued from.
ALTER TABLE "company_exits"
  ADD CONSTRAINT "exit_is_explained"
  CHECK (length(btrim("reason")) > 0);

-- ===========================================================================
-- Separation of duties
-- ===========================================================================

-- **The approver is never the requester.**
--
-- Ending a customer's contract and approving that decision are two people — the same rule as
-- break-glass, platform role grants and every other high-risk act in this product. In the database
-- as well as in the service, because this is the control that makes the whole lifecycle
-- trustworthy and a service is a thing somebody adds a code path around.
ALTER TABLE "company_exits"
  ADD CONSTRAINT "exit_approver_is_not_the_requester"
  CHECK ("approved_by_user_id" IS NULL OR "approved_by_user_id" <> "requested_by_user_id");

-- An approval is attributed and dated together.
ALTER TABLE "company_exits"
  ADD CONSTRAINT "exit_approval_is_attributed"
  CHECK (("approved_at" IS NULL) = ("approved_by_user_id" IS NULL));

-- ===========================================================================
-- Nothing is approved without its dates, and nothing is dated without approval
-- ===========================================================================

-- The three dates are computed once, at approval, and stored. A state past `Requested` without
-- them would be a schedule nobody could show the customer.
ALTER TABLE "company_exits"
  ADD CONSTRAINT "approved_exit_is_scheduled"
  CHECK (
    "state" IN ('Requested', 'Cancelled')
    OR ("read_only_from" IS NOT NULL AND "retention_from" IS NOT NULL
        AND "deletion_eligible_from" IS NOT NULL)
  );

-- The windows stack in order. A deletion date before the read-only period started would be a
-- schedule that deletes data while the customer is still reading it.
ALTER TABLE "company_exits"
  ADD CONSTRAINT "exit_windows_are_ordered"
  CHECK (
    "read_only_from" IS NULL
    OR ("retention_from" >= "read_only_from"
        AND "deletion_eligible_from" >= "retention_from")
  );

ALTER TABLE "company_exits"
  ADD CONSTRAINT "exit_windows_are_sane"
  CHECK (
    "read_only_days" >= 0 AND "read_only_days" <= 365
    AND "retention_days" >= 0 AND "retention_days" <= 365
  );

-- ===========================================================================
-- The deletion certificate — step 7
-- ===========================================================================

-- **A deletion is attributed, dated, and carries its evidence.**
--
-- The manifest is the row counts per table as recorded at the time. A certificate that said only
-- "deleted" would be unfalsifiable; this one can be read against `TABLE_DISPOSITION` and checked.
ALTER TABLE "company_exits"
  ADD CONSTRAINT "deletion_certificate_is_complete"
  CHECK (
    "state" <> 'Deleted'
    OR ("deleted_at" IS NOT NULL AND "deleted_by_user_id" IS NOT NULL
        AND "deletion_manifest" IS NOT NULL
        AND "deleted_row_count" IS NOT NULL AND "preserved_row_count" IS NOT NULL)
  );

-- **A deletion happens only after the window it was scheduled for.**
--
-- The service checks it and so does this. The whole value of the retention window is that it
-- cannot be skipped by a code path somebody adds later, and "delete it now, the customer is on the
-- phone" is exactly the pressure this constraint exists to resist.
ALTER TABLE "company_exits"
  ADD CONSTRAINT "deletion_respects_the_retention_window"
  CHECK (
    "deleted_at" IS NULL
    OR ("deletion_eligible_from" IS NOT NULL AND "deleted_at" >= "deletion_eligible_from")
  );

-- Nothing is deleted and cancelled.
ALTER TABLE "company_exits"
  ADD CONSTRAINT "an_exit_is_not_both_deleted_and_cancelled"
  CHECK ("deleted_at" IS NULL OR "cancelled_at" IS NULL);

-- A cancellation is attributed, dated and explained. Stopping an exit is as consequential as
-- starting one.
ALTER TABLE "company_exits"
  ADD CONSTRAINT "cancellation_is_attributed_and_explained"
  CHECK (
    "state" <> 'Cancelled'
    OR ("cancelled_at" IS NOT NULL AND "cancelled_by_user_id" IS NOT NULL
        AND length(btrim(COALESCE("cancellation_reason", ''))) > 0)
  );

-- An export is attributed and dated together.
ALTER TABLE "company_exits"
  ADD CONSTRAINT "export_is_attributed"
  CHECK (("exported_at" IS NULL) = ("exported_by_user_id" IS NULL));
