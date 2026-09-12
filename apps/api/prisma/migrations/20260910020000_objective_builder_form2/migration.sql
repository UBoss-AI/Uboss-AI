-- CreateEnum
CREATE TYPE "objective_status_kind" AS ENUM ('Draft', 'UnderReview', 'AiAnalysis', 'WorkflowDraft', 'ReadyForApproval', 'Active', 'Completed', 'Archived');

-- CreateEnum
CREATE TYPE "objective_time_unit_kind" AS ENUM ('WorkingDays', 'CalendarDays', 'Hours', 'Weeks');

-- CreateEnum
CREATE TYPE "objective_step_engine_kind" AS ENUM ('Human', 'Engine', 'SubEngine', 'Executor');

-- CreateEnum
CREATE TYPE "objective_step_approval_kind" AS ENUM ('NotRequired', 'Manager', 'Head', 'FourEyes');

-- CreateEnum
CREATE TYPE "objective_reward_type_kind" AS ENUM ('Cash', 'Points', 'Recognition', 'Other');

-- CreateTable
CREATE TABLE "objectives" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "department_id" UUID NOT NULL,
    "objective_owner_user_id" UUID NOT NULL,
    "active_version_id" UUID,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "objectives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "objective_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "objective_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" "objective_status_kind" NOT NULL DEFAULT 'Draft',
    "objective_name" VARCHAR(200) NOT NULL,
    "department_id" UUID NOT NULL,
    "objective_owner_user_id" UUID NOT NULL,
    "expected_final_result" VARCHAR(4000) NOT NULL,
    "current_workload" INTEGER,
    "unit" VARCHAR(60),
    "target_completion_time" INTEGER,
    "time_unit" "objective_time_unit_kind",
    "prepared_by" VARCHAR(160),
    "form_date" DATE,
    "responsible_owner_user_id" UUID,
    "execution_team" VARCHAR(200),
    "submitted_at" TIMESTAMPTZ(6),
    "submitted_by_user_id" UUID,
    "published_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "objective_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "objective_workflow_steps" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "objective_version_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "who_person_name" VARCHAR(160),
    "who_designation" VARCHAR(160),
    "who_engine" "objective_step_engine_kind" NOT NULL DEFAULT 'Human',
    "when_trigger" VARCHAR(200),
    "when_frequency" VARCHAR(120),
    "what_exact_work" VARCHAR(2000) NOT NULL,
    "input_what_is_used" VARCHAR(400),
    "input_received_from" VARCHAR(200),
    "where_work_is_done" VARCHAR(200),
    "output_what_is_produced" VARCHAR(400),
    "output_sent_to" VARCHAR(200),
    "time_taken" VARCHAR(60),
    "current_problem" VARCHAR(2000),
    "approval" "objective_step_approval_kind" NOT NULL DEFAULT 'NotRequired',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "objective_workflow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "objective_rewards" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "objective_id" UUID NOT NULL,
    "applicable" BOOLEAN NOT NULL DEFAULT false,
    "reward_type" "objective_reward_type_kind",
    "amount_minor_units" INTEGER,
    "eligibility_condition" VARCHAR(2000),
    "completion_deadline" DATE,
    "evidence" VARCHAR(2000),
    "approver_user_id" UUID,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "objective_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "objectives_tenant_id_department_id_idx" ON "objectives"("tenant_id", "department_id");

-- CreateIndex
CREATE INDEX "objectives_tenant_id_objective_owner_user_id_idx" ON "objectives"("tenant_id", "objective_owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "objectives_tenant_id_code_key" ON "objectives"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "objectives_tenant_id_id_key" ON "objectives"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "objective_versions_tenant_id_status_idx" ON "objective_versions"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "objective_versions_tenant_id_objective_id_version_number_idx" ON "objective_versions"("tenant_id", "objective_id", "version_number" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "objective_versions_tenant_id_objective_id_version_number_key" ON "objective_versions"("tenant_id", "objective_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "objective_versions_tenant_id_id_key" ON "objective_versions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "objective_workflow_steps_tenant_id_objective_version_id_idx" ON "objective_workflow_steps"("tenant_id", "objective_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "objective_workflow_steps_tenant_id_objective_version_id_pos_key" ON "objective_workflow_steps"("tenant_id", "objective_version_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "objective_rewards_objective_id_key" ON "objective_rewards"("objective_id");

-- CreateIndex
CREATE UNIQUE INDEX "objective_rewards_tenant_id_objective_id_key" ON "objective_rewards"("tenant_id", "objective_id");

-- AddForeignKey
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_tenant_id_department_id_fkey" FOREIGN KEY ("tenant_id", "department_id") REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_tenant_id_active_version_id_fkey" FOREIGN KEY ("tenant_id", "active_version_id") REFERENCES "objective_versions"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "objective_versions" ADD CONSTRAINT "objective_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_versions" ADD CONSTRAINT "objective_versions_tenant_id_objective_id_fkey" FOREIGN KEY ("tenant_id", "objective_id") REFERENCES "objectives"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_versions" ADD CONSTRAINT "objective_versions_tenant_id_department_id_fkey" FOREIGN KEY ("tenant_id", "department_id") REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_workflow_steps" ADD CONSTRAINT "objective_workflow_steps_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_workflow_steps" ADD CONSTRAINT "objective_workflow_steps_tenant_id_objective_version_id_fkey" FOREIGN KEY ("tenant_id", "objective_version_id") REFERENCES "objective_versions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_rewards" ADD CONSTRAINT "objective_rewards_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_rewards" ADD CONSTRAINT "objective_rewards_tenant_id_objective_id_fkey" FOREIGN KEY ("tenant_id", "objective_id") REFERENCES "objectives"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Prompt 19 — Objective Builder (Form 2): the half Prisma cannot express
-- ===========================================================================
-- Everything below is invariant, not convenience. The client's two locked rules for this screen
-- are that Form 2 is preserved exactly and that a live version is immutable, and both are
-- enforced here as well as in the service — a service is one missed branch away from losing an
-- invariant, a constraint is not.

-- ---------------------------------------------------------------------------
-- 1. Tenant isolation
-- ---------------------------------------------------------------------------
-- Symmetric, unlike the Skill policies: there is no platform-owned objective. An objective is one
-- company's business intent, `tenant_id` is NOT NULL, and neither half of the policy has any
-- reason to admit a null-tenant row. `FORCE` so that the table owner is not exempt either.

ALTER TABLE "objectives" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "objectives" FORCE ROW LEVEL SECURITY;
CREATE POLICY "objectives_tenant_isolation" ON "objectives"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "objective_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "objective_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "objective_versions_tenant_isolation" ON "objective_versions"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "objective_workflow_steps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "objective_workflow_steps" FORCE ROW LEVEL SECURITY;
CREATE POLICY "objective_workflow_steps_tenant_isolation" ON "objective_workflow_steps"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "objective_rewards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "objective_rewards" FORCE ROW LEVEL SECURITY;
CREATE POLICY "objective_rewards_tenant_isolation" ON "objective_rewards"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- ---------------------------------------------------------------------------
-- 2. The required Form 2 fields actually carry something
-- ---------------------------------------------------------------------------
-- `NOT NULL` stops a missing field; it does not stop a field holding a space. The four starred
-- fields on the client's form are the ones the rest of the objective is derived from, so a blank
-- one is worse than an absent one — it looks answered.

ALTER TABLE "objective_versions"
  ADD CONSTRAINT "objective_name_is_not_blank"
  CHECK (length(btrim("objective_name")) > 0);

ALTER TABLE "objective_versions"
  ADD CONSTRAINT "expected_final_result_is_not_blank"
  CHECK (length(btrim("expected_final_result")) > 0);

ALTER TABLE "objective_versions"
  ADD CONSTRAINT "objective_version_number_is_positive"
  CHECK ("version_number" > 0);

-- Workload and target are optional; a negative one is not "unset", it is wrong.
ALTER TABLE "objective_versions"
  ADD CONSTRAINT "objective_workload_is_not_negative"
  CHECK ("current_workload" IS NULL OR "current_workload" >= 0);

ALTER TABLE "objective_versions"
  ADD CONSTRAINT "objective_target_time_is_not_negative"
  CHECK ("target_completion_time" IS NULL OR "target_completion_time" >= 0);

-- The client's locked instruction is that Unit and Time Unit are never collapsed into one input.
-- The corollary is that a duration without its unit is meaningless: "10" is not a target. The
-- pair is optional as a pair, and half of it is a data-entry error.
ALTER TABLE "objective_versions"
  ADD CONSTRAINT "objective_target_time_has_a_unit"
  CHECK ("target_completion_time" IS NULL OR "time_unit" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 3. The workflow grid is the form, so it is held to the same standard
-- ---------------------------------------------------------------------------
-- There is deliberately **no ceiling on the number of rows**. The approved UI states that the row
-- count is not fixed, and a company whose process has nineteen steps must be able to record
-- nineteen. What is checked is that a row says what work it is.

ALTER TABLE "objective_workflow_steps"
  ADD CONSTRAINT "workflow_step_position_is_positive"
  CHECK ("position" > 0);

ALTER TABLE "objective_workflow_steps"
  ADD CONSTRAINT "workflow_step_states_its_work"
  CHECK (length(btrim("what_exact_work")) > 0);

-- ---------------------------------------------------------------------------
-- 4. One live version, and a live version is accounted for
-- ---------------------------------------------------------------------------
-- The client's rule: published/live versions are immutable and an authorized edit creates a new
-- draft. Two simultaneously `Active` versions of one objective would make "which plan is running"
-- unanswerable, which is the state the rule exists to prevent.

CREATE UNIQUE INDEX "one_active_version_per_objective"
  ON "objective_versions" ("tenant_id", "objective_id")
  WHERE "status" = 'Active';

-- A version that is live, or that finished while live, went live at a moment somebody can name.
ALTER TABLE "objective_versions"
  ADD CONSTRAINT "live_objective_version_records_when"
  CHECK ("status" NOT IN ('Active', 'Completed') OR "published_at" IS NOT NULL);

-- Submission is attributed or it is not a submission anybody can account for. Both directions:
-- a recorded submission has an author, and a version sitting in review was actually submitted.
ALTER TABLE "objective_versions"
  ADD CONSTRAINT "objective_submission_is_attributed"
  CHECK ("submitted_at" IS NULL OR "submitted_by_user_id" IS NOT NULL);

ALTER TABLE "objective_versions"
  ADD CONSTRAINT "objective_under_review_was_submitted"
  CHECK ("status" <> 'UnderReview' OR "submitted_at" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 5. The Performance & Reward panel commits nothing
-- ---------------------------------------------------------------------------
-- The client's instruction is explicit: do not auto-pay cash on completion, and eligibility and
-- approval are decided by the reward workflow that comes later. There is therefore no approved,
-- settled or paid state on this table to enforce — the enforcement is that those columns do not
-- exist. What *is* enforceable now is that an applicable reward is a complete promise rather than
-- a half-filled one, because an applicable reward with no stated condition and no named approver
-- is the record that later becomes an argument about what was promised.

ALTER TABLE "objective_rewards"
  ADD CONSTRAINT "reward_amount_is_not_negative"
  CHECK ("amount_minor_units" IS NULL OR "amount_minor_units" >= 0);

ALTER TABLE "objective_rewards"
  ADD CONSTRAINT "applicable_reward_is_complete"
  CHECK (
    "applicable" IS NOT TRUE
    OR (
      "reward_type" IS NOT NULL
      AND length(btrim(COALESCE("eligibility_condition", ''))) > 0
      AND "approver_user_id" IS NOT NULL
    )
  );

-- Cash and Points are the two kinds the source names a quantity for ("Amount/Points"). Demanding
-- an amount for Recognition would push people into entering a fake number.
ALTER TABLE "objective_rewards"
  ADD CONSTRAINT "quantified_reward_has_an_amount"
  CHECK (
    "applicable" IS NOT TRUE
    OR "reward_type" IS NULL
    OR "reward_type" NOT IN ('Cash', 'Points')
    OR "amount_minor_units" IS NOT NULL
  );

-- ---------------------------------------------------------------------------
-- 6. A live version's content cannot be rewritten
-- ---------------------------------------------------------------------------
-- The same shape as `uboss_skill_version_is_immutable_once_approved`, for the same reason: the
-- status must stay movable (Active -> Completed -> Archived) while the content freezes. A single
-- constraint cannot express "these columns are immutable but that one is not", so it is a trigger.
--
-- Note what is *not* in the comparison: `updated_at`, `row_version`, `published_at` and the
-- submission columns. Those are bookkeeping about the version, not the plan the version records.

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
  THEN
    RAISE EXCEPTION
      'Objective version % is % and its Form 2 content cannot be changed. An authorised edit '
      'creates a new draft version; it never rewrites the version that is live.',
      OLD."id", OLD."status"
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "objective_version_content_is_frozen_once_live"
  BEFORE UPDATE ON "objective_versions"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_objective_version_is_immutable_once_live();

-- ---------------------------------------------------------------------------
-- 7. …and neither can its grid
-- ---------------------------------------------------------------------------
-- Freezing the objective-level columns while leaving the workflow grid writable would be a hole,
-- not a subtlety: the grid **is** Form 2, and inserting a step into a running plan changes it
-- exactly as much as editing the expected result. So all three write kinds are refused —
-- INSERT adds a step, DELETE removes one, UPDATE rewrites one.
--
-- A genuine cascade still works, and that is not luck. `DELETE FROM objectives` deletes the
-- version row first and then cascades to its steps as a separate command, so by the time this
-- trigger runs the version is no longer visible to its snapshot, `target_status` is NULL, and the
-- delete proceeds. A direct edit of a live objective's grid is refused; tearing down a company is
-- not.
--
-- `SECURITY INVOKER` (the default) is deliberate: the lookup runs under the caller's Row-Level
-- Security context, so this trigger cannot become a way to read another tenant's version.

CREATE OR REPLACE FUNCTION uboss_objective_steps_follow_version_freeze()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_version uuid;
  target_status "objective_status_kind";
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_version := OLD."objective_version_id";
  ELSE
    target_version := NEW."objective_version_id";
  END IF;

  SELECT "status" INTO target_status
    FROM "objective_versions"
   WHERE "id" = target_version;

  IF target_status IS NOT NULL AND target_status IN ('Active', 'Completed', 'Archived') THEN
    RAISE EXCEPTION
      'Objective version % is % and its workflow grid cannot be changed. An authorised edit '
      'creates a new draft version; it never rewrites the plan that is live.',
      target_version, target_status
      USING ERRCODE = 'raise_exception';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "objective_grid_is_frozen_once_live"
  BEFORE INSERT OR UPDATE OR DELETE ON "objective_workflow_steps"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_objective_steps_follow_version_freeze();
