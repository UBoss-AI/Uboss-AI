-- AlterTable
ALTER TABLE "ai_work_assignments" ADD COLUMN     "execution_setup" JSONB,
ADD COLUMN     "last_test_passed" BOOLEAN,
ADD COLUMN     "last_test_summary" VARCHAR(2000),
ADD COLUMN     "last_test_was_real" BOOLEAN,
ADD COLUMN     "last_tested_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "engine_agents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "status" VARCHAR(40) NOT NULL DEFAULT 'DraftSetup',
    "current_version_id" UUID,
    "activated_at" TIMESTAMPTZ(6),
    "activated_by_user_id" UUID,
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "engine_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engine_agent_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "engine_agent_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'Draft',
    "config" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "published_by_user_id" UUID,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "engine_agent_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "engine_agents_tenant_id_status_idx" ON "engine_agents"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "engine_agents_tenant_id_id_key" ON "engine_agents"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "engine_agents_tenant_id_name_key" ON "engine_agents"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "engine_agent_versions_tenant_id_engine_agent_id_status_idx" ON "engine_agent_versions"("tenant_id", "engine_agent_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "engine_agent_versions_tenant_id_id_key" ON "engine_agent_versions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "engine_agent_versions_tenant_id_engine_agent_id_version_num_key" ON "engine_agent_versions"("tenant_id", "engine_agent_id", "version_number");

-- AddForeignKey
ALTER TABLE "ai_work_assignments" ADD CONSTRAINT "ai_work_assignments_tenant_id_engine_agent_id_fkey" FOREIGN KEY ("tenant_id", "engine_agent_id") REFERENCES "engine_agents"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "engine_agents" ADD CONSTRAINT "engine_agents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engine_agent_versions" ADD CONSTRAINT "engine_agent_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engine_agent_versions" ADD CONSTRAINT "engine_agent_versions_tenant_id_engine_agent_id_fkey" FOREIGN KEY ("tenant_id", "engine_agent_id") REFERENCES "engine_agents"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Prompt 24 — the reusable Engine Agent and Agent Builder's execution setup
-- ===========================================================================
-- The locked lifecycle rule is what this schema exists to make structurally true: recurring work
-- creates Runs on the agent it already has, never a second agent for the same job. An agent is
-- created once, at activation, with one immutable published configuration.

-- ---------------------------------------------------------------------------
-- 1. Tenant isolation
-- ---------------------------------------------------------------------------
-- Symmetric on both tables. An Engine Agent is company-owned operational identity and is never
-- platform-shared. FORCE applies the policy to the owner too, so a migration or a console
-- session cannot quietly read across companies.

ALTER TABLE "engine_agents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "engine_agents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "engine_agents_tenant_isolation" ON "engine_agents"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "engine_agent_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "engine_agent_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "engine_agent_versions_tenant_isolation" ON "engine_agent_versions"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- ---------------------------------------------------------------------------
-- 2. An agent's identity is real
-- ---------------------------------------------------------------------------
-- A name is how people refer to an agent on an operations screen, so a blank one is not a name.
-- The unique index above already refuses a duplicate; this refuses an empty one.

ALTER TABLE "engine_agents"
  ADD CONSTRAINT "engine_agent_has_a_name"
  CHECK (length(btrim("name")) > 0);

-- The status vocabulary is the client's seven, and it lives in the shared types package. Naming
-- them here as well is deliberate duplication of a *closed* list: it stops a typo or a future
-- module inventing an eighth status that no screen has a label or a tone for.
ALTER TABLE "engine_agents"
  ADD CONSTRAINT "engine_agent_status_is_known"
  CHECK ("status" IN ('DraftSetup', 'Ready', 'Active', 'Paused', 'NeedsInput', 'Error', 'Archived'));

-- Activation is attributed in both directions. "Who put this agent in front of real work" is the
-- first question asked when one misbehaves, and a timestamp with no actor is half a record.
ALTER TABLE "engine_agents"
  ADD CONSTRAINT "engine_agent_activation_is_attributed"
  CHECK (("activated_at" IS NULL) = ("activated_by_user_id" IS NULL));

-- An agent that has ever been activated has a configuration in force. Without this, a row could
-- claim to be Active with no version, and an operations screen would show a live agent whose
-- behaviour is unknowable.
ALTER TABLE "engine_agents"
  ADD CONSTRAINT "active_engine_agent_has_a_current_version"
  CHECK ("status" NOT IN ('Active', 'Paused', 'NeedsInput', 'Error')
         OR "current_version_id" IS NOT NULL);

ALTER TABLE "engine_agents"
  ADD CONSTRAINT "activated_engine_agent_records_when"
  CHECK ("activated_at" IS NOT NULL OR "status" IN ('DraftSetup', 'Ready', 'Archived'));

-- ---------------------------------------------------------------------------
-- 3. A version is a real version
-- ---------------------------------------------------------------------------

ALTER TABLE "engine_agent_versions"
  ADD CONSTRAINT "engine_agent_version_number_starts_at_one"
  CHECK ("version_number" >= 1);

ALTER TABLE "engine_agent_versions"
  ADD CONSTRAINT "engine_agent_version_status_is_known"
  CHECK ("status" IN ('Draft', 'Published'));

-- jsonb by itself permits 4, "text" and null. A row storing one of those does not fail on write;
-- it fails much later when something tries to run the agent. Note the shape of the test:
-- jsonb_typeof(...) = 'object' is safe here because the column is NOT NULL, so there is no
-- missing-key case to fail open on — unlike a lookup into the object, which returns NULL for an
-- absent key and makes a CHECK pass. That distinction cost a corrective migration at Prompt 22.
ALTER TABLE "engine_agent_versions"
  ADD CONSTRAINT "engine_agent_version_config_is_an_object"
  CHECK (jsonb_typeof("config") = 'object');

-- Publication is attributed in both directions, and only a published version has a date.
ALTER TABLE "engine_agent_versions"
  ADD CONSTRAINT "engine_agent_version_publication_is_attributed"
  CHECK (("published_at" IS NULL) = ("published_by_user_id" IS NULL));

ALTER TABLE "engine_agent_versions"
  ADD CONSTRAINT "published_engine_agent_version_records_when"
  CHECK (("status" = 'Published') = ("published_at" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- 4. A published version is immutable
-- ---------------------------------------------------------------------------
-- The same rule as a live Objective version and an assigned workflow draft, for the same reason:
-- Runs will cite this configuration as what produced their output. If it could be edited in
-- place, every past Run's provenance would silently change with it, and "what configuration
-- produced this result?" would stop having an answer.
--
-- An authorized change creates a new draft version. That is the registry prompt's flow; this
-- trigger is what makes it the only possible one.

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
  THEN
    RAISE EXCEPTION
      'Engine Agent version % of agent % is published and cannot be changed. Runs cite this '
      'configuration as what produced their output; an authorised change creates a new draft '
      'version instead.',
      OLD."version_number", OLD."engine_agent_id"
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "uboss_published_engine_agent_version_is_immutable"
  BEFORE UPDATE ON "engine_agent_versions"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_published_engine_agent_version_is_immutable();

-- ---------------------------------------------------------------------------
-- 5. The assignment's own record of its setup and its test
-- ---------------------------------------------------------------------------
-- Same jsonb reasoning as above, but this column is nullable — null means nobody has opened the
-- builder yet — so the type test has to permit NULL explicitly rather than rely on NOT NULL.

ALTER TABLE "ai_work_assignments"
  ADD CONSTRAINT "execution_setup_is_an_object"
  CHECK ("execution_setup" IS NULL OR jsonb_typeof("execution_setup") = 'object');

-- A test result is a complete record or no record. A pass/fail with no timestamp cannot be aged,
-- and a timestamp with no outcome says only that somebody pressed the button.
ALTER TABLE "ai_work_assignments"
  ADD CONSTRAINT "agent_test_result_is_complete"
  CHECK (("last_tested_at" IS NULL) = ("last_test_passed" IS NULL));

-- Every recorded test says whether a real provider was involved. This is the constraint behind
-- "never fabricate successful real-provider integration": a stored test result cannot be silent
-- about it, so no screen or report can present a mock run as a real one by omission.
ALTER TABLE "ai_work_assignments"
  ADD CONSTRAINT "agent_test_says_whether_the_model_was_real"
  CHECK ("last_tested_at" IS NULL OR "last_test_was_real" IS NOT NULL);
