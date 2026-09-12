-- CreateEnum
CREATE TYPE "analysis_stage_kind" AS ENUM ('UnderstandingObjective', 'ReadingTeamStructure', 'DetectingHumanWork', 'IdentifyingAiWork', 'MatchingSkills', 'AssigningOwners', 'BuildingWorkflow');

-- CreateEnum
CREATE TYPE "analysis_run_status_kind" AS ENUM ('Queued', 'Running', 'Completed', 'Cancelled', 'Failed');

-- CreateTable
CREATE TABLE "objective_analysis_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "objective_id" UUID NOT NULL,
    "objective_version_id" UUID NOT NULL,
    "status" "analysis_run_status_kind" NOT NULL DEFAULT 'Queued',
    "stage" "analysis_stage_kind",
    "stages_completed" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_user_id" UUID,
    "failure_reason" VARCHAR(2000),
    "draft" JSONB,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "model_capability" VARCHAR(80),
    "produced_by_real_model" BOOLEAN NOT NULL DEFAULT false,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "requested_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "objective_analysis_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "objective_analysis_runs_tenant_id_status_idx" ON "objective_analysis_runs"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "objective_analysis_runs_tenant_id_objective_id_created_at_idx" ON "objective_analysis_runs"("tenant_id", "objective_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "objective_analysis_runs_tenant_id_objective_version_id_idx" ON "objective_analysis_runs"("tenant_id", "objective_version_id");

-- AddForeignKey
ALTER TABLE "objective_analysis_runs" ADD CONSTRAINT "objective_analysis_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_analysis_runs" ADD CONSTRAINT "objective_analysis_runs_tenant_id_objective_id_fkey" FOREIGN KEY ("tenant_id", "objective_id") REFERENCES "objectives"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_analysis_runs" ADD CONSTRAINT "objective_analysis_runs_tenant_id_objective_version_id_fkey" FOREIGN KEY ("tenant_id", "objective_version_id") REFERENCES "objective_versions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Prompt 21 — objective AI analysis: the half Prisma cannot express
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Tenant isolation
-- ---------------------------------------------------------------------------

ALTER TABLE "objective_analysis_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "objective_analysis_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "objective_analysis_runs_tenant_isolation" ON "objective_analysis_runs"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- ---------------------------------------------------------------------------
-- 2. A run's state and its evidence agree
-- ---------------------------------------------------------------------------
-- The seven stages are the client's, so the counter cannot exceed them, and each terminal state
-- must carry what that state means. A row claiming to be `Completed` with no draft is the state
-- that makes a screen render nothing and look broken.

ALTER TABLE "objective_analysis_runs"
  ADD CONSTRAINT "analysis_stage_count_is_within_range"
  CHECK ("stages_completed" >= 0 AND "stages_completed" <= 7);

ALTER TABLE "objective_analysis_runs"
  ADD CONSTRAINT "completed_analysis_has_a_draft"
  CHECK ("status" <> 'Completed' OR ("draft" IS NOT NULL AND "completed_at" IS NOT NULL));

-- All seven stages, or it did not finish. "Completed at stage five" is not a completion.
ALTER TABLE "objective_analysis_runs"
  ADD CONSTRAINT "completed_analysis_finished_every_stage"
  CHECK ("status" <> 'Completed' OR "stages_completed" = 7);

ALTER TABLE "objective_analysis_runs"
  ADD CONSTRAINT "failed_analysis_says_why"
  CHECK ("status" <> 'Failed' OR length(btrim(COALESCE("failure_reason", ''))) > 0);

-- Cancellation is attributed in both directions: a timestamp with no actor and an actor with no
-- timestamp are both half-records, and "who stopped this" is the first question asked.
ALTER TABLE "objective_analysis_runs"
  ADD CONSTRAINT "analysis_cancellation_is_attributed"
  CHECK (("cancelled_at" IS NULL) = ("cancelled_by_user_id" IS NULL));

ALTER TABLE "objective_analysis_runs"
  ADD CONSTRAINT "cancelled_analysis_records_when"
  CHECK (("status" = 'Cancelled') = ("cancelled_at" IS NOT NULL));

-- A run that has started says when. A queued one has not.
ALTER TABLE "objective_analysis_runs"
  ADD CONSTRAINT "running_analysis_records_when_it_started"
  CHECK ("status" = 'Queued' OR "started_at" IS NOT NULL);

ALTER TABLE "objective_analysis_runs"
  ADD CONSTRAINT "analysis_completion_follows_start"
  CHECK ("completed_at" IS NULL OR "started_at" IS NULL OR "completed_at" >= "started_at");

-- ---------------------------------------------------------------------------
-- 3. A draft is never stored without its schema version
-- ---------------------------------------------------------------------------
-- The prompt requires a versioned schema. A stored draft outlives the code that wrote it, so a
-- draft with no version — or a version this build does not recognise — must be refusable on read
-- rather than mis-interpreted. The constraint keeps the two from ever being separated.

ALTER TABLE "objective_analysis_runs"
  ADD CONSTRAINT "analysis_schema_version_is_positive"
  CHECK ("schema_version" > 0);

ALTER TABLE "objective_analysis_runs"
  ADD CONSTRAINT "stored_draft_declares_its_schema"
  CHECK ("draft" IS NULL OR ("draft" -> 'schemaVersion') IS NOT NULL);

-- The stamped column and the value inside the document must agree. Two sources of the same fact
-- disagreeing is how a reader picks the wrong one.
ALTER TABLE "objective_analysis_runs"
  ADD CONSTRAINT "draft_schema_version_matches_column"
  CHECK (
    "draft" IS NULL
    OR ("draft" ->> 'schemaVersion') = "schema_version"::text
  );

-- ---------------------------------------------------------------------------
-- 4. Nothing claims a real model when one was not used
-- ---------------------------------------------------------------------------
-- The mirror of the reward rule about payments. `produced_by_real_model` is written from what the
-- gateway reported and is false for every adapter that ships. A row that claimed otherwise while
-- naming no capability would be unattributable, which is exactly the state a fabrication would
-- leave behind.

ALTER TABLE "objective_analysis_runs"
  ADD CONSTRAINT "real_model_output_names_its_capability"
  CHECK ("produced_by_real_model" IS NOT TRUE OR length(btrim(COALESCE("model_capability", ''))) > 0);

ALTER TABLE "objective_analysis_runs"
  ADD CONSTRAINT "analysis_token_counts_are_not_negative"
  CHECK ("prompt_tokens" >= 0 AND "completion_tokens" >= 0);

-- ---------------------------------------------------------------------------
-- 5. One live run per objective version
-- ---------------------------------------------------------------------------
-- Two analyses of one version at once would race to write the draft, and the screen would show
-- whichever answered last. A *finished* run must not block a new one: re-analysing after an edit
-- is the normal case.

CREATE UNIQUE INDEX "one_active_analysis_per_objective_version"
  ON "objective_analysis_runs" ("tenant_id", "objective_version_id")
  WHERE "status" IN ('Queued', 'Running');

-- ---------------------------------------------------------------------------
-- 6. A finished run is a historical record
-- ---------------------------------------------------------------------------
-- Its draft, its token counts and whether a real model produced it are what a later cost review
-- or dispute reads. Editing them afterwards would make the record worthless, and the
-- `produced_by_real_model` flag in particular is the one somebody would be tempted to flip.

CREATE OR REPLACE FUNCTION uboss_analysis_run_is_immutable_once_finished()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" NOT IN ('Completed', 'Cancelled', 'Failed') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Analysis run % is % and cannot be changed. Re-analyse the objective to produce a new run; '
    'never rewrite a finished one.',
    OLD."id", OLD."status"
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER "analysis_run_is_frozen_once_finished"
  BEFORE UPDATE ON "objective_analysis_runs"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_analysis_run_is_immutable_once_finished();
