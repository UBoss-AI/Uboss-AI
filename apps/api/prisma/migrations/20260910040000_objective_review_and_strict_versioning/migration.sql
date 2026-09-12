-- CreateEnum
CREATE TYPE "objective_version_origin_kind" AS ENUM ('Initial', 'Edit', 'Rollback');

-- AlterTable
ALTER TABLE "objective_versions" ADD COLUMN     "approved_at" TIMESTAMPTZ(6),
ADD COLUMN     "approved_by_user_id" UUID,
ADD COLUMN     "copied_from_version_id" UUID,
ADD COLUMN     "execution_team_confirmed_at" TIMESTAMPTZ(6),
ADD COLUMN     "execution_team_confirmed_by_user_id" UUID,
ADD COLUMN     "origin" "objective_version_origin_kind" NOT NULL DEFAULT 'Initial',
ADD COLUMN     "sent_back_at" TIMESTAMPTZ(6),
ADD COLUMN     "sent_back_by_user_id" UUID,
ADD COLUMN     "sent_back_reason" VARCHAR(2000);

-- AddForeignKey
ALTER TABLE "objective_versions" ADD CONSTRAINT "objective_versions_tenant_id_copied_from_version_id_fkey" FOREIGN KEY ("tenant_id", "copied_from_version_id") REFERENCES "objective_versions"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- ===========================================================================
-- Prompt 20 — review routing and strict versioning
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Every review act is attributed, and a send-back says why
-- ---------------------------------------------------------------------------
-- A review trail with anonymous steps is one nobody can be held to. Each pair is checked in both
-- directions: a timestamp with no actor and an actor with no timestamp are both half-records.

ALTER TABLE "objective_versions"
  ADD CONSTRAINT "objective_approval_is_attributed"
  CHECK (("approved_at" IS NULL) = ("approved_by_user_id" IS NULL));

ALTER TABLE "objective_versions"
  ADD CONSTRAINT "objective_send_back_is_attributed"
  CHECK (("sent_back_at" IS NULL) = ("sent_back_by_user_id" IS NULL));

ALTER TABLE "objective_versions"
  ADD CONSTRAINT "objective_team_confirmation_is_attributed"
  CHECK (
    ("execution_team_confirmed_at" IS NULL) = ("execution_team_confirmed_by_user_id" IS NULL)
  );

-- The author has to know what to change. A send-back with no reason is the one that comes
-- straight back unchanged.
ALTER TABLE "objective_versions"
  ADD CONSTRAINT "objective_send_back_has_a_reason"
  CHECK (
    "sent_back_at" IS NULL OR length(btrim(COALESCE("sent_back_reason", ''))) > 0
  );

-- ---------------------------------------------------------------------------
-- 2. Nothing goes live without an approval
-- ---------------------------------------------------------------------------
-- The client's chain is `... -> Approved -> Published -> LIVE`. Approving and publishing are two
-- acts, so this is the constraint that stops the second happening without the first — including
-- through a direct database write, which is the path a service check cannot cover.

ALTER TABLE "objective_versions"
  ADD CONSTRAINT "live_objective_version_was_approved"
  CHECK ("status" NOT IN ('Active', 'Completed') OR "approved_at" IS NOT NULL);

-- Publication cannot predate the approval that permitted it. Out-of-order timestamps are how a
-- trail stops being evidence.
ALTER TABLE "objective_versions"
  ADD CONSTRAINT "objective_publication_follows_approval"
  CHECK (
    "published_at" IS NULL OR "approved_at" IS NULL OR "published_at" >= "approved_at"
  );

-- ---------------------------------------------------------------------------
-- 3. Provenance is real
-- ---------------------------------------------------------------------------
-- V1 is the only version with no parent; every later one was copied from something, because the
-- client's rule is that an edit *copies* rather than mutates.

ALTER TABLE "objective_versions"
  ADD CONSTRAINT "first_version_has_no_parent"
  CHECK (
    ("version_number" = 1 AND "origin" = 'Initial')
    OR ("version_number" > 1 AND "origin" <> 'Initial' AND "copied_from_version_id" IS NOT NULL)
  );

-- A version cannot be its own parent.
ALTER TABLE "objective_versions"
  ADD CONSTRAINT "version_is_not_its_own_parent"
  CHECK ("copied_from_version_id" IS NULL OR "copied_from_version_id" <> "id");

-- ---------------------------------------------------------------------------
-- 4. The freeze trigger has to cover the new columns
-- ---------------------------------------------------------------------------
-- Replaced rather than added to, because the Prompt 19 function listed the content columns
-- explicitly and a second trigger would leave two lists to keep in step.
--
-- `origin` and `copied_from_version_id` join the frozen set: they are the historical record of
-- where a live version came from, and the client requires that historical records keep exact
-- version ids. `approved_at`/`approved_by_user_id` are frozen too — rewriting who approved a live
-- plan is precisely the thing an audit exists to detect.
--
-- Still *not* frozen: `status` (so Active -> Completed -> Archived works), `updated_at`,
-- `row_version`, `published_at`, and the submission columns.

CREATE OR REPLACE FUNCTION uboss_objective_version_is_immutable_once_live()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" NOT IN ('Active', 'Completed', 'Archived') THEN
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
