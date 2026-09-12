-- ---------------------------------------------------------------------------
-- `ADD VALUE IF NOT EXISTS` on purpose.
--
-- PostgreSQL commits a new enum label even when a later statement in the same migration fails, so
-- a migration containing `ALTER TYPE ... ADD VALUE` is **not atomic**. A failed deploy leaves the
-- type extended and everything after the failure missing — and an enum label cannot be removed, so
-- the only way back is a re-runnable statement. This is that.
-- ---------------------------------------------------------------------------

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "objective_status_kind" ADD VALUE IF NOT EXISTS 'Paused';
ALTER TYPE "objective_status_kind" ADD VALUE IF NOT EXISTS 'OutcomeReview';
ALTER TYPE "objective_status_kind" ADD VALUE IF NOT EXISTS 'Closed';

-- CreateTable
CREATE TABLE "objective_outcome_reviews" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "objective_id" UUID NOT NULL,
    "objective_version_id" UUID NOT NULL,
    "verdict" VARCHAR(30) NOT NULL,
    "actual_result" VARCHAR(4000) NOT NULL,
    "explanation" VARCHAR(4000),
    "sla_outcome" VARCHAR(20) NOT NULL,
    "days_late" INTEGER,
    "comparison" JSONB NOT NULL,
    "sign_off_policy" VARCHAR(30) NOT NULL,
    "reviewed_by_user_id" UUID NOT NULL,
    "reviewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signed_off_by_user_id" UUID,
    "signed_off_at" TIMESTAMPTZ(6),
    "approval_request_id" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "closed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "objective_outcome_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "objective_pauses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "objective_id" UUID NOT NULL,
    "reason_kind" VARCHAR(40) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "paused_by_user_id" UUID NOT NULL,
    "paused_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resumed_by_user_id" UUID,
    "resumed_at" TIMESTAMPTZ(6),
    "resume_note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "objective_pauses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "objective_outcome_reviews_tenant_id_objective_id_idx" ON "objective_outcome_reviews"("tenant_id", "objective_id");

-- CreateIndex
CREATE INDEX "objective_outcome_reviews_tenant_id_verdict_idx" ON "objective_outcome_reviews"("tenant_id", "verdict");

-- CreateIndex
CREATE INDEX "objective_outcome_reviews_tenant_id_closed_at_idx" ON "objective_outcome_reviews"("tenant_id", "closed_at");

-- CreateIndex
CREATE UNIQUE INDEX "objective_outcome_reviews_tenant_id_objective_version_id_key" ON "objective_outcome_reviews"("tenant_id", "objective_version_id");

-- CreateIndex
CREATE INDEX "objective_pauses_tenant_id_objective_id_paused_at_idx" ON "objective_pauses"("tenant_id", "objective_id", "paused_at");

-- AddForeignKey
ALTER TABLE "objective_outcome_reviews" ADD CONSTRAINT "objective_outcome_reviews_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_outcome_reviews" ADD CONSTRAINT "objective_outcome_reviews_tenant_id_objective_id_fkey" FOREIGN KEY ("tenant_id", "objective_id") REFERENCES "objectives"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_outcome_reviews" ADD CONSTRAINT "objective_outcome_reviews_tenant_id_objective_version_id_fkey" FOREIGN KEY ("tenant_id", "objective_version_id") REFERENCES "objective_versions"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "objective_pauses" ADD CONSTRAINT "objective_pauses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_pauses" ADD CONSTRAINT "objective_pauses_tenant_id_objective_id_fkey" FOREIGN KEY ("tenant_id", "objective_id") REFERENCES "objectives"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security
--
-- Both tables are strictly tenant-owned. An outcome review is a company's judgement of its own
-- work and a pause is a company's decision about its own objective; neither has a platform-plane
-- row, so there is no shape a cross-tenant read could take.
-- ===========================================================================

ALTER TABLE "objective_outcome_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "objective_outcome_reviews" FORCE ROW LEVEL SECURITY;
CREATE POLICY objective_outcome_reviews_tenant_isolation ON "objective_outcome_reviews"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "objective_pauses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "objective_pauses" FORCE ROW LEVEL SECURITY;
CREATE POLICY objective_pauses_tenant_isolation ON "objective_pauses"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "objective_outcome_reviews" TO "uboss_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "objective_pauses" TO "uboss_app";

-- ===========================================================================
-- A review says something
-- ===========================================================================

-- Every verdict but a clean `Met` has to be explained. A "partially met" with no explanation is a
-- grade rather than a review, and §27.1 asks for a comparison.
--
-- `length(btrim(COALESCE(...)))` rather than `IS NOT NULL`: a column holding three spaces is not
-- an explanation, and COALESCE is here because a CHECK whose expression is NULL passes — the
-- failure mode that has now appeared five times in this schema.
ALTER TABLE "objective_outcome_reviews"
  ADD CONSTRAINT "non_trivial_verdict_is_explained"
  CHECK ("verdict" = 'Met' OR length(btrim(COALESCE("explanation", ''))) >= 40);

-- The actual result is the one field with no other source in the product. A blank one would make
-- the whole review decorative.
ALTER TABLE "objective_outcome_reviews"
  ADD CONSTRAINT "outcome_review_states_the_actual_result"
  CHECK (length(btrim("actual_result")) >= 10);

-- Lateness belongs to the `Late` outcome and nowhere else. `OnTime` records zero rather than
-- null, so a report can sum the column without a COALESCE that hides a missing value.
ALTER TABLE "objective_outcome_reviews"
  ADD CONSTRAINT "days_late_belongs_to_a_late_outcome"
  CHECK (
    ("sla_outcome" = 'Late' AND "days_late" IS NOT NULL AND "days_late" > 0)
    OR ("sla_outcome" = 'OnTime' AND "days_late" = 0)
    OR ("sla_outcome" = 'Unknown' AND "days_late" IS NULL)
  );

-- A sign-off is attributed in both directions. A timestamp with no name is half a record, and
-- "who signed this off" is the first question asked of a closure.
ALTER TABLE "objective_outcome_reviews"
  ADD CONSTRAINT "outcome_sign_off_is_attributed"
  CHECK (("signed_off_at" IS NULL) = ("signed_off_by_user_id" IS NULL));

ALTER TABLE "objective_outcome_reviews"
  ADD CONSTRAINT "outcome_closure_is_attributed"
  CHECK (("closed_at" IS NULL) = ("closed_by_user_id" IS NULL));

-- **A closure satisfies the policy that was in force when it was reviewed.**
--
-- The check the whole prompt turns on. `OwnerSignOff` needs a signature; `Approval` needs a
-- verified approved request. `Never` needs neither. Enforced here as well as in the service
-- because "who was allowed to close this" is exactly the question somebody will ask of a row long
-- after the code that wrote it has changed.
--
-- `OwnerSignOff` accepts a closure with no separate signature **only when the closer is the
-- signer** — which the application decides, because this constraint cannot see who owns the
-- objective. So the database's half is: if the policy needs a signature or an approval, the row
-- carries one or the other.
ALTER TABLE "objective_outcome_reviews"
  ADD CONSTRAINT "closure_satisfies_its_sign_off_policy"
  CHECK (
    "closed_at" IS NULL
    OR "sign_off_policy" = 'Never'
    OR ("sign_off_policy" = 'OwnerSignOff'
        AND ("signed_off_by_user_id" IS NOT NULL OR "closed_by_user_id" IS NOT NULL))
    OR ("sign_off_policy" = 'Approval' AND "approval_request_id" IS NOT NULL)
  );

-- ===========================================================================
-- A pause is a pause
-- ===========================================================================

-- A resume is attributed and dated together, like every other act in this schema.
ALTER TABLE "objective_pauses"
  ADD CONSTRAINT "objective_resume_is_attributed"
  CHECK (("resumed_at" IS NULL) = ("resumed_by_user_id" IS NULL));

-- Time runs forwards.
ALTER TABLE "objective_pauses"
  ADD CONSTRAINT "objective_resume_follows_its_pause"
  CHECK ("resumed_at" IS NULL OR "resumed_at" >= "paused_at");

-- A resume note only makes sense on a resumed pause.
ALTER TABLE "objective_pauses"
  ADD CONSTRAINT "resume_note_belongs_to_a_resume"
  CHECK ("resume_note" IS NULL OR "resumed_at" IS NOT NULL);

-- **At most one open pause per objective.**
--
-- A partial unique index, because two open pauses would make "is this paused?" a question with
-- two answers — and the resume would close an arbitrary one of them. The index is on the
-- unresumed rows only, so the history of past pauses accumulates freely, which is the whole
-- reason this is a table rather than two columns.
CREATE UNIQUE INDEX "one_open_pause_per_objective"
  ON "objective_pauses" ("tenant_id", "objective_id")
  WHERE "resumed_at" IS NULL;

-- ===========================================================================
-- An existing constraint that the new states outgrew
-- ===========================================================================

-- `live_objective_version_records_when` was written at Prompt 19 as
-- `status NOT IN ('Active','Completed') OR published_at IS NOT NULL`.
--
-- Every state this migration adds is on the **live side** of the lifecycle: a version cannot be
-- paused, reviewed or closed without first having been published. Left as it was, the constraint
-- would allow a `Closed` version with no publication date — a version closed without ever going
-- live, which is not a state the product has.
--
-- Recorded as a lesson: a CHECK that enumerates states has to be revisited whenever the state
-- list grows, and nothing reminds you. This is the second constraint in this schema to need it.
ALTER TABLE "objective_versions"
  DROP CONSTRAINT "live_objective_version_records_when";

ALTER TABLE "objective_versions"
  ADD CONSTRAINT "live_objective_version_records_when"
  CHECK (
    "status" NOT IN ('Active', 'Paused', 'Completed', 'OutcomeReview', 'Closed')
    OR "published_at" IS NOT NULL
  );

-- ===========================================================================
-- The immutability trigger, which the new states would have walked straight past
-- ===========================================================================

-- **This is the defect adding three states created, and it is the serious one.**
--
-- `uboss_objective_version_is_immutable_once_live` returns early — allowing *any* edit — when the
-- status is not one of `('Active', 'Completed', 'Archived')`. Prompt 34 adds `Paused`,
-- `OutcomeReview` and `Closed`, all of which are on the live side of the lifecycle, so a version
-- in any of them would have been **freely editable at the database level**. A company could have
-- paused a live objective and rewritten its Form 2 in place — precisely the locked rule this
-- trigger exists to enforce: a published version is immutable, and an authorised edit creates a
-- new draft rather than rewriting what people executed.
--
-- `FROZEN_OBJECTIVE_STATUSES` in the types package was updated in the same change, so the
-- application would have refused it too. That is not a reason to leave the trigger: the trigger is
-- the layer that holds when the application is wrong, which is the whole point of having it.
--
-- The body is otherwise unchanged from Prompt 20's — only the state list moves.
CREATE OR REPLACE FUNCTION uboss_objective_version_is_immutable_once_live()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" NOT IN
     ('Active', 'Paused', 'Completed', 'OutcomeReview', 'Closed', 'Archived') THEN
    RETURN NEW;
  END IF;

  IF NEW."objective_name" IS DISTINCT FROM OLD."objective_name"
     OR NEW."department_id" IS DISTINCT FROM OLD."department_id"
     OR NEW."objective_owner_user_id" IS DISTINCT FROM OLD."objective_owner_user_id"
     OR NEW."expected_final_result" IS DISTINCT FROM OLD."expected_final_result"
     OR NEW."current_workload" IS DISTINCT FROM OLD."current_workload"
     OR NEW."unit" IS DISTINCT FROM OLD."unit"
     OR NEW."target_completion_time" IS DISTINCT FROM OLD."target_completion_time"
     OR NEW."time_unit" IS DISTINCT FROM OLD."time_unit"
     OR NEW."prepared_by" IS DISTINCT FROM OLD."prepared_by"
     OR NEW."form_date" IS DISTINCT FROM OLD."form_date"
     OR NEW."responsible_owner_user_id" IS DISTINCT FROM OLD."responsible_owner_user_id"
     OR NEW."execution_team" IS DISTINCT FROM OLD."execution_team"
     OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
     OR NEW."objective_id" IS DISTINCT FROM OLD."objective_id"
     OR NEW."origin" IS DISTINCT FROM OLD."origin"
     OR NEW."copied_from_version_id" IS DISTINCT FROM OLD."copied_from_version_id"
     OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at"
     OR NEW."approved_by_user_id" IS DISTINCT FROM OLD."approved_by_user_id"
  THEN
    RAISE EXCEPTION
      'Objective version % is % and its Form 2 content, provenance and approval cannot be '
      'changed. An authorised edit creates a new draft version; it never rewrites the version '
      'that is live.',
      OLD."id", OLD."status"
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

-- The approval constraint has the same gap as the publication one: a version cannot be paused,
-- reviewed or closed without having been approved first, because it cannot have gone live.
ALTER TABLE "objective_versions"
  DROP CONSTRAINT "live_objective_version_was_approved";

ALTER TABLE "objective_versions"
  ADD CONSTRAINT "live_objective_version_was_approved"
  CHECK (
    "status" NOT IN ('Active', 'Paused', 'Completed', 'OutcomeReview', 'Closed')
    OR "approved_at" IS NOT NULL
  );
