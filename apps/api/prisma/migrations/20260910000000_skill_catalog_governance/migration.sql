-- CreateEnum
CREATE TYPE "skill_layer_kind" AS ENUM ('UbossVerified', 'IndustryPack', 'CompanyCustom');

-- CreateEnum
CREATE TYPE "skill_status_kind" AS ENUM ('Draft', 'Test', 'Review', 'Approved', 'Published', 'Deprecated', 'Archived');

-- CreateEnum
CREATE TYPE "skill_autonomy_kind" AS ENUM ('SuggestOnly', 'ProposeForApproval', 'ActThenReport', 'FullyAutonomous');

-- CreateEnum
CREATE TYPE "skill_creation_mode_kind" AS ENUM ('Manual', 'CreateWithUbossAi', 'FromDocument', 'Clone');

-- CreateTable
CREATE TABLE "skills" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "layer" "skill_layer_kind" NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "industry" VARCHAR(80),
    "owner_user_id" UUID,
    "published_version_id" UUID,
    "cloned_from_skill_id" UUID,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "skill_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" "skill_status_kind" NOT NULL DEFAULT 'Draft',
    "purpose" VARCHAR(2000) NOT NULL,
    "category" VARCHAR(40) NOT NULL,
    "when_to_use" VARCHAR(2000) NOT NULL,
    "when_not_to_use" VARCHAR(2000) NOT NULL,
    "inputs" JSONB NOT NULL,
    "rules" JSONB NOT NULL,
    "steps" JSONB NOT NULL,
    "allowed_tool_categories" TEXT[],
    "output_schema" TEXT NOT NULL,
    "validation" VARCHAR(2000) NOT NULL,
    "failure_handling" VARCHAR(2000) NOT NULL,
    "requires_approval" BOOLEAN NOT NULL DEFAULT true,
    "autonomy" "skill_autonomy_kind" NOT NULL DEFAULT 'ProposeForApproval',
    "evidence_requirement" VARCHAR(2000) NOT NULL,
    "creation_mode" "skill_creation_mode_kind" NOT NULL DEFAULT 'Manual',
    "source_reference" VARCHAR(500),
    "cloned_from_version_id" UUID,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "published_by_user_id" UUID,
    "published_at" TIMESTAMPTZ(6),
    "deprecated_at" TIMESTAMPTZ(6),
    "retirement_reason" VARCHAR(1000),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "skill_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_transitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "skill_version_id" UUID NOT NULL,
    "from_status" "skill_status_kind" NOT NULL,
    "to_status" "skill_status_kind" NOT NULL,
    "reason" VARCHAR(1000),
    "actor_user_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "skills_tenant_id_layer_idx" ON "skills"("tenant_id", "layer");

-- CreateIndex
CREATE INDEX "skills_layer_industry_idx" ON "skills"("layer", "industry");

-- CreateIndex
CREATE INDEX "skills_cloned_from_skill_id_idx" ON "skills"("cloned_from_skill_id");

-- CreateIndex
CREATE INDEX "skill_versions_tenant_id_status_idx" ON "skill_versions"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "skill_versions_skill_id_status_idx" ON "skill_versions"("skill_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "skill_versions_skill_id_version_number_key" ON "skill_versions"("skill_id", "version_number");

-- CreateIndex
CREATE INDEX "skill_transitions_skill_version_id_occurred_at_idx" ON "skill_transitions"("skill_version_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_cloned_from_skill_id_fkey" FOREIGN KEY ("cloned_from_skill_id") REFERENCES "skills"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_transitions" ADD CONSTRAINT "skill_transitions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_transitions" ADD CONSTRAINT "skill_transitions_skill_version_id_fkey" FOREIGN KEY ("skill_version_id") REFERENCES "skill_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Prompt 17 — hand-written section
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Row-Level Security, with the platform/company split
-- ---------------------------------------------------------------------------
-- These are the **first tables in UBoss where a null tenant means "everybody may read this"**,
-- so the policy is asymmetric on purpose and the two halves say different things:
--
--   USING      — a company may READ its own rows and platform rows. That *is* what "a Verified
--                Skill is available to every company" means; without it the catalogue would be
--                empty for everyone.
--   WITH CHECK — a company may WRITE only its own rows. So a company can use a platform Skill,
--                clone it, and never author, edit or approve one.
--
-- The asymmetry is the security property. A symmetric policy would let any company publish a
-- "UBoss Verified" Skill, which every other company would then trust.

ALTER TABLE "skills" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skills" FORCE ROW LEVEL SECURITY;
CREATE POLICY "skills_tenant_isolation" ON "skills"
  USING (
    "tenant_id" IS NULL
    OR "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "skill_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "skill_versions_tenant_isolation" ON "skill_versions"
  USING (
    "tenant_id" IS NULL
    OR "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

-- The transition history follows the same rule: a company may read the governance trail of a
-- platform Skill it depends on, and may never write to it.
ALTER TABLE "skill_transitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_transitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "skill_transitions_tenant_isolation" ON "skill_transitions"
  USING (
    "tenant_id" IS NULL
    OR "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

-- ---------------------------------------------------------------------------
-- 2. A layer decides who may own it
-- ---------------------------------------------------------------------------
-- A platform layer has no tenant; a company layer must have one. Without this, a company row
-- claiming to be `UbossVerified` would be a company publishing something every other company
-- reads as verified by UBoss.

ALTER TABLE "skills"
  ADD CONSTRAINT "skill_layer_matches_its_owner"
  CHECK (
    ("layer" IN ('UbossVerified', 'IndustryPack') AND "tenant_id" IS NULL)
    OR ("layer" = 'CompanyCustom' AND "tenant_id" IS NOT NULL)
  );

-- Only a pack names an industry. A Verified Skill claiming one would be a pack by another name.
ALTER TABLE "skills"
  ADD CONSTRAINT "only_an_industry_pack_names_an_industry"
  CHECK (
    ("layer" = 'IndustryPack' AND "industry" IS NOT NULL AND length(btrim("industry")) > 0)
    OR ("layer" <> 'IndustryPack' AND "industry" IS NULL)
  );

ALTER TABLE "skills"
  ADD CONSTRAINT "skill_is_named"
  CHECK (length(btrim("key")) > 0 AND length(btrim("name")) > 0);

-- A stable handle: lower kebab, so it can appear in a URL and be typed by a person.
ALTER TABLE "skills"
  ADD CONSTRAINT "skill_key_is_lower_kebab"
  CHECK ("key" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$');

-- One key per owner. A company may have its own `tender-eligibility-screen` alongside the
-- Verified one — that is the point of cloning — but not two of its own.
CREATE UNIQUE INDEX "one_skill_key_per_company"
  ON "skills" ("tenant_id", "key")
  WHERE "tenant_id" IS NOT NULL;

CREATE UNIQUE INDEX "one_platform_skill_key"
  ON "skills" ("key")
  WHERE "tenant_id" IS NULL;

-- ---------------------------------------------------------------------------
-- 3. A version's own coherence
-- ---------------------------------------------------------------------------

ALTER TABLE "skill_versions"
  ADD CONSTRAINT "skill_version_number_is_positive"
  CHECK ("version_number" >= 1);

-- Every field the client requires, non-blank. A Skill with an empty `whenNotToUse` is the one
-- that gets used for the wrong work.
ALTER TABLE "skill_versions"
  ADD CONSTRAINT "skill_version_states_the_required_fields"
  CHECK (
    length(btrim("purpose")) > 0
    AND length(btrim("category")) > 0
    AND length(btrim("when_to_use")) > 0
    AND length(btrim("when_not_to_use")) > 0
    AND length(btrim("output_schema")) > 0
    AND length(btrim("validation")) > 0
    AND length(btrim("failure_handling")) > 0
    AND length(btrim("evidence_requirement")) > 0
  );

-- **The governance rule, in the database.** A Skill that may delete, bulk-send, export sensitive
-- data or make a financial or production change cannot be fully autonomous: that combination is
-- an irreversible action in somebody else's system with no person involved at any point. The
-- Executor Agent is not a substitute — it never silently approves high-risk work.
ALTER TABLE "skill_versions"
  ADD CONSTRAINT "high_risk_skill_is_not_fully_autonomous"
  CHECK (
    "autonomy" <> 'FullyAutonomous'
    OR NOT (
      "allowed_tool_categories" && ARRAY['Delete','ExternalBulkSend','SensitiveExport','FinancialChange','ProductionChange']::text[]
    )
  );

-- Approving, publishing and reviewing each record who did it. A timestamp with no actor is not
-- an approval anybody can account for.
ALTER TABLE "skill_versions"
  ADD CONSTRAINT "skill_approval_is_attributed"
  CHECK ("approved_at" IS NULL OR "approved_by_user_id" IS NOT NULL);

ALTER TABLE "skill_versions"
  ADD CONSTRAINT "skill_publication_is_attributed"
  CHECK ("published_at" IS NULL OR "published_by_user_id" IS NOT NULL);

ALTER TABLE "skill_versions"
  ADD CONSTRAINT "skill_review_is_attributed"
  CHECK ("reviewed_at" IS NULL OR "reviewed_by_user_id" IS NOT NULL);

-- Publication follows approval, and cannot precede it.
ALTER TABLE "skill_versions"
  ADD CONSTRAINT "skill_publication_follows_approval"
  CHECK (
    "published_at" IS NULL
    OR ("approved_at" IS NOT NULL AND "published_at" >= "approved_at")
  );

-- Retiring a capability other work may depend on requires a reason.
ALTER TABLE "skill_versions"
  ADD CONSTRAINT "retired_skill_version_has_a_reason"
  CHECK (
    "status" NOT IN ('Deprecated', 'Archived')
    OR length(btrim(COALESCE("retirement_reason", ''))) > 0
  );

-- A clone says what it was cloned from; nothing else claims one.
ALTER TABLE "skill_versions"
  ADD CONSTRAINT "cloned_version_names_its_source"
  CHECK (
    ("creation_mode" = 'Clone' AND "cloned_from_version_id" IS NOT NULL)
    OR ("creation_mode" <> 'Clone' AND "cloned_from_version_id" IS NULL)
  );

-- A document-sourced draft says which document.
ALTER TABLE "skill_versions"
  ADD CONSTRAINT "document_sourced_version_names_its_source"
  CHECK (
    "creation_mode" <> 'FromDocument'
    OR length(btrim(COALESCE("source_reference", ''))) > 0
  );

-- One live version per Skill. Two published versions would make "which one does work use"
-- ambiguous, and the answer would be whichever the query happened to return first.
CREATE UNIQUE INDEX "one_published_version_per_skill"
  ON "skill_versions" ("skill_id")
  WHERE "status" = 'Published';

-- One editable draft per Skill, for the same reason: "the draft" has to mean something.
CREATE UNIQUE INDEX "one_open_draft_per_skill"
  ON "skill_versions" ("skill_id")
  WHERE "status" IN ('Draft', 'Test', 'Review');

-- ---------------------------------------------------------------------------
-- 4. A version's content is immutable once approved
-- ---------------------------------------------------------------------------
-- The client's rule names publication; this is deliberately stricter and freezes at `Approved`,
-- because an approval is a decision about specific content. Content that could change afterwards
-- would let somebody get "delete records" approved by having "read records" reviewed.
--
-- A trigger rather than a revoked grant: the **status** must still move (Published → Deprecated →
-- Archived) while the content cannot, and a blanket `REVOKE UPDATE` would have made deprecation
-- impossible. The trigger lists exactly the columns that may change after approval, so adding a
-- content field without thinking about immutability makes this fail rather than silently permit it.

CREATE OR REPLACE FUNCTION uboss_skill_version_is_immutable_once_approved()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" NOT IN ('Approved', 'Published', 'Deprecated', 'Archived') THEN
    RETURN NEW;
  END IF;

  IF NEW."purpose" IS DISTINCT FROM OLD."purpose"
     OR NEW."category" IS DISTINCT FROM OLD."category"
     OR NEW."when_to_use" IS DISTINCT FROM OLD."when_to_use"
     OR NEW."when_not_to_use" IS DISTINCT FROM OLD."when_not_to_use"
     OR NEW."inputs"::text IS DISTINCT FROM OLD."inputs"::text
     OR NEW."rules"::text IS DISTINCT FROM OLD."rules"::text
     OR NEW."steps"::text IS DISTINCT FROM OLD."steps"::text
     OR NEW."allowed_tool_categories" IS DISTINCT FROM OLD."allowed_tool_categories"
     OR NEW."output_schema" IS DISTINCT FROM OLD."output_schema"
     OR NEW."validation" IS DISTINCT FROM OLD."validation"
     OR NEW."failure_handling" IS DISTINCT FROM OLD."failure_handling"
     OR NEW."requires_approval" IS DISTINCT FROM OLD."requires_approval"
     OR NEW."autonomy" IS DISTINCT FROM OLD."autonomy"
     OR NEW."evidence_requirement" IS DISTINCT FROM OLD."evidence_requirement"
     OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
     OR NEW."skill_id" IS DISTINCT FROM OLD."skill_id"
  THEN
    RAISE EXCEPTION
      'Skill version % is % and its content cannot be changed. An authorised edit creates a new '
      'draft version; it never rewrites one that has been approved.',
      OLD."id", OLD."status"
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "skill_version_content_is_frozen_once_approved"
  BEFORE UPDATE ON "skill_versions"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_skill_version_is_immutable_once_approved();

-- ---------------------------------------------------------------------------
-- 5. The transition history is append-only
-- ---------------------------------------------------------------------------
-- "Who sent this back to draft, and what did they say" is the question a governance review asks.
-- A rewritable history cannot answer it.

ALTER TABLE "skill_transitions"
  ADD CONSTRAINT "rejecting_transition_has_a_reason"
  CHECK (
    NOT (
      "to_status" IN ('Draft', 'Deprecated', 'Archived')
      AND "from_status" <> 'Draft'
    )
    OR length(btrim(COALESCE("reason", ''))) > 0
  );

ALTER TABLE "skill_transitions"
  ADD CONSTRAINT "transition_actually_moves"
  CHECK ("from_status" <> "to_status");

REVOKE UPDATE, DELETE ON "skill_transitions" FROM uboss_app;
