-- AlterTable
ALTER TABLE "engine_agent_versions" ADD COLUMN     "approval_required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "impact" JSONB,
ADD COLUMN     "test_passed" BOOLEAN,
ADD COLUMN     "test_was_real" BOOLEAN,
ADD COLUMN     "tested_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "engine_agents" ADD COLUMN     "archived_at" TIMESTAMPTZ(6),
ADD COLUMN     "archived_by_user_id" UUID,
ADD COLUMN     "memory_mode" VARCHAR(40) NOT NULL DEFAULT 'CurrentRunOnly',
ADD COLUMN     "paused_reason" VARCHAR(500);


-- ===========================================================================
-- Prompt 25 — the registry, memory mode and versioning
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Memory mode is one of the four the architecture defines
-- ---------------------------------------------------------------------------
-- A closed set, named here as well as in the shared types, so a typo or a future module cannot
-- introduce a fifth mode that no governance rule covers. The default is the only mode that
-- persists nothing: Prompt 33 is what enforces retention, visibility, deletion and sharing, and
-- until it exists an agent must not be able to keep anything.

ALTER TABLE "engine_agents"
  ADD CONSTRAINT "engine_agent_memory_mode_is_known"
  CHECK ("memory_mode" IN ('CurrentRunOnly', 'ObjectiveMemory', 'AgentMemory',
                           'ApprovedLongTermMemory'));

-- ---------------------------------------------------------------------------
-- 2. Pausing and archiving are attributed and self-consistent
-- ---------------------------------------------------------------------------
-- "Why did this stop?" is the first question an operations screen has to answer, so a pause
-- carries its reason.

ALTER TABLE "engine_agents"
  ADD CONSTRAINT "paused_engine_agent_says_why"
  CHECK ("status" <> 'Paused' OR length(btrim(COALESCE("paused_reason", ''))) > 0);

-- A reason left behind after a resume would describe a state the agent is no longer in.
ALTER TABLE "engine_agents"
  ADD CONSTRAINT "only_a_paused_engine_agent_carries_a_pause_reason"
  CHECK ("status" = 'Paused' OR "paused_reason" IS NULL);

ALTER TABLE "engine_agents"
  ADD CONSTRAINT "engine_agent_archival_is_attributed"
  CHECK (("archived_at" IS NULL) = ("archived_by_user_id" IS NULL));

ALTER TABLE "engine_agents"
  ADD CONSTRAINT "archived_engine_agent_records_when"
  CHECK (("status" = 'Archived') = ("archived_at" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- 3. A version's impact and test record are complete or absent
-- ---------------------------------------------------------------------------

ALTER TABLE "engine_agent_versions"
  ADD CONSTRAINT "engine_agent_version_impact_is_an_object"
  CHECK ("impact" IS NULL OR jsonb_typeof("impact") = 'object');

-- Same shape as the Agent Builder test record, for the same reason: a pass or fail with no
-- timestamp cannot be aged, and a timestamp with no outcome says only that somebody pressed the
-- button.
ALTER TABLE "engine_agent_versions"
  ADD CONSTRAINT "engine_agent_version_test_result_is_complete"
  CHECK (("tested_at" IS NULL) = ("test_passed" IS NULL));

-- The honesty constraint, again. A recorded test cannot be silent about whether a real provider
-- was involved, so no registry screen or report can present mock output as real by omission.
ALTER TABLE "engine_agent_versions"
  ADD CONSTRAINT "engine_agent_version_test_says_whether_the_model_was_real"
  CHECK ("tested_at" IS NULL OR "test_was_real" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 4. Only one draft version per agent at a time
-- ---------------------------------------------------------------------------
-- Two open drafts of the same agent is a state nobody can reason about: which one activates, and
-- what happened to the other's impact analysis? A partial unique index makes it impossible while
-- leaving any number of published versions, which is the history and must accumulate.

CREATE UNIQUE INDEX "one_open_draft_per_engine_agent"
  ON "engine_agent_versions" ("tenant_id", "engine_agent_id")
  WHERE "status" = 'Draft';

-- ---------------------------------------------------------------------------
-- 5. The freeze trigger covers the new columns
-- ---------------------------------------------------------------------------
-- Prompt 24's trigger froze a published version's config, number, agent and publication record.
-- The impact analysis and the test result are part of what a reviewer relied on when they
-- approved it, so they are frozen too — replaced rather than edited, because the previous
-- migration is already applied.

CREATE OR REPLACE FUNCTION uboss_published_engine_agent_version_is_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" <> 'Published' THEN
    RETURN NEW;
  END IF;

  IF NEW."config" IS DISTINCT FROM OLD."config"
     OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
     OR NEW."engine_agent_id" IS DISTINCT FROM OLD."engine_agent_id"
     OR NEW."status" IS DISTINCT FROM OLD."status"
     OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
     OR NEW."published_by_user_id" IS DISTINCT FROM OLD."published_by_user_id"
     OR NEW."impact" IS DISTINCT FROM OLD."impact"
     OR NEW."approval_required" IS DISTINCT FROM OLD."approval_required"
     OR NEW."tested_at" IS DISTINCT FROM OLD."tested_at"
     OR NEW."test_passed" IS DISTINCT FROM OLD."test_passed"
     OR NEW."test_was_real" IS DISTINCT FROM OLD."test_was_real"
  THEN
    RAISE EXCEPTION
      'Engine Agent version % of agent % is published and cannot be changed. Runs cite this '
      'configuration as what produced their output, and its impact analysis and test result are '
      'what a reviewer relied on; an authorised change creates a new draft version instead.',
      OLD."version_number", OLD."engine_agent_id"
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;
