-- CreateTable
CREATE TABLE "memory_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mode" VARCHAR(40) NOT NULL,
    "retention_days" INTEGER,
    "visibility" VARCHAR(30) NOT NULL,
    "max_classification" VARCHAR(20) NOT NULL DEFAULT 'Internal',
    "allow_cross_user" BOOLEAN NOT NULL DEFAULT false,
    "allow_cross_objective" BOOLEAN NOT NULL DEFAULT false,
    "offboarding_behaviour" VARCHAR(30) NOT NULL DEFAULT 'DeleteOnOffboarding',
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "memory_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mode" VARCHAR(40) NOT NULL,
    "visibility" VARCHAR(30) NOT NULL,
    "run_id" UUID NOT NULL,
    "objective_id" UUID,
    "engine_agent_id" UUID NOT NULL,
    "owner_user_id" UUID,
    "classification" VARCHAR(20) NOT NULL DEFAULT 'Internal',
    "label" VARCHAR(200) NOT NULL,
    "content" JSONB,
    "approval_request_id" UUID,
    "expires_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" VARCHAR(300),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "memory_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_output_feedback" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "rating" VARCHAR(30) NOT NULL,
    "correction" VARCHAR(4000),
    "evidence" VARCHAR(4000),
    "reviewer_user_id" UUID NOT NULL,
    "produced_by_real_model" BOOLEAN,
    "evaluation_eligible" BOOLEAN NOT NULL DEFAULT false,
    "evaluation_reason" VARCHAR(500),
    "promoted_case_id" UUID,
    "promoted_at" TIMESTAMPTZ(6),
    "promoted_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ai_output_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "memory_policies_tenant_id_mode_key" ON "memory_policies"("tenant_id", "mode");

-- CreateIndex
CREATE INDEX "memory_records_tenant_id_engine_agent_id_visibility_expires_idx" ON "memory_records"("tenant_id", "engine_agent_id", "visibility", "expires_at");

-- CreateIndex
CREATE INDEX "memory_records_tenant_id_objective_id_expires_at_idx" ON "memory_records"("tenant_id", "objective_id", "expires_at");

-- CreateIndex
CREATE INDEX "memory_records_tenant_id_owner_user_id_idx" ON "memory_records"("tenant_id", "owner_user_id");

-- CreateIndex
CREATE INDEX "memory_records_tenant_id_expires_at_idx" ON "memory_records"("tenant_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "memory_records_tenant_id_id_key" ON "memory_records"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "ai_output_feedback_tenant_id_run_id_idx" ON "ai_output_feedback"("tenant_id", "run_id");

-- CreateIndex
CREATE INDEX "ai_output_feedback_tenant_id_rating_idx" ON "ai_output_feedback"("tenant_id", "rating");

-- CreateIndex
CREATE INDEX "ai_output_feedback_tenant_id_evaluation_eligible_promoted_a_idx" ON "ai_output_feedback"("tenant_id", "evaluation_eligible", "promoted_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_output_feedback_tenant_id_run_id_reviewer_user_id_key" ON "ai_output_feedback"("tenant_id", "run_id", "reviewer_user_id");

-- AddForeignKey
ALTER TABLE "memory_policies" ADD CONSTRAINT "memory_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "agent_runs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_output_feedback" ADD CONSTRAINT "ai_output_feedback_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_output_feedback" ADD CONSTRAINT "ai_output_feedback_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "agent_runs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security
--
-- All three tables are strictly tenant-owned. Unlike provider configuration there is no
-- platform-plane row here: a memory record belongs to exactly one company, and so does a
-- judgement of that company's AI output.
--
-- This is what makes "no cross-tenant memory" structural rather than a rule somebody remembers.
-- Combined with the composite foreign key to `agent_runs` (tenant_id, run_id), a record cannot
-- even reference another company's run, so there is no query shape that could return one.
-- ===========================================================================

ALTER TABLE "memory_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memory_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_policies_tenant_isolation ON "memory_policies"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "memory_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memory_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_records_tenant_isolation ON "memory_records"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "ai_output_feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_output_feedback" FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_output_feedback_tenant_isolation ON "ai_output_feedback"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "memory_policies" TO "uboss_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "memory_records" TO "uboss_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_output_feedback" TO "uboss_app";

-- ===========================================================================
-- The memory policy is coherent, whatever the application does
-- ===========================================================================

-- Only the approved long-term mode may be kept indefinitely. Retention nobody governed is
-- exactly what the other three modes exist to prevent.
ALTER TABLE "memory_policies"
  ADD CONSTRAINT "only_approved_long_term_memory_never_expires"
  CHECK ("retention_days" IS NOT NULL OR "mode" = 'ApprovedLongTermMemory');

ALTER TABLE "memory_policies"
  ADD CONSTRAINT "memory_retention_is_a_sane_number_of_days"
  CHECK ("retention_days" IS NULL OR ("retention_days" >= 1 AND "retention_days" <= 3650));

-- The mode called "approved" requires an approval. Without this the name would be decoration.
ALTER TABLE "memory_policies"
  ADD CONSTRAINT "approved_long_term_memory_requires_an_approval"
  CHECK ("mode" <> 'ApprovedLongTermMemory' OR "requires_approval" = true);

-- The architecture's "never unrestricted cross-user memory", as a database rule: cross-user
-- reading needs company-wide visibility. A record scoped to one Objective or one agent that any
-- user may read is precisely the unrestricted case.
ALTER TABLE "memory_policies"
  ADD CONSTRAINT "cross_user_memory_needs_company_wide_visibility"
  CHECK ("allow_cross_user" = false OR "visibility" = 'CompanyWide');

-- A record visible only within its Objective cannot also be readable across Objectives.
ALTER TABLE "memory_policies"
  ADD CONSTRAINT "objective_scoped_memory_is_not_cross_objective"
  CHECK ("allow_cross_objective" = false OR "visibility" <> 'SameObjective');

-- ===========================================================================
-- A memory record's scope is complete
-- ===========================================================================

-- Objective Memory is "visible only to same Objective scope" (§19). A record with that
-- visibility and no Objective has no scope to be visible in — and a read that treated the null
-- as a match would make it visible everywhere, which is the failure this forbids.
ALTER TABLE "memory_records"
  ADD CONSTRAINT "objective_scoped_memory_names_its_objective"
  CHECK ("visibility" <> 'SameObjective' OR "objective_id" IS NOT NULL);

-- Only the approved long-term mode may hold a record with no expiry.
ALTER TABLE "memory_records"
  ADD CONSTRAINT "only_approved_long_term_records_never_expire"
  CHECK ("expires_at" IS NOT NULL OR "mode" = 'ApprovedLongTermMemory');

-- The mode that needs an approval cites one. A verified id, not a boolean claim (ADR-160).
ALTER TABLE "memory_records"
  ADD CONSTRAINT "approved_long_term_record_cites_its_approval"
  CHECK ("mode" <> 'ApprovedLongTermMemory' OR "approval_request_id" IS NOT NULL);

-- A deletion says why, and a reason with no deletion is half a record.
ALTER TABLE "memory_records"
  ADD CONSTRAINT "memory_deletion_is_explained"
  CHECK (("deleted_at" IS NULL) = ("deleted_reason" IS NULL));

-- **A deleted record holds no content.** Otherwise "deleted" would mean a tombstone with the data
-- still in it, and a company that asked for a deletion would not have got one. The row survives
-- with its scope and its dates because "what was deleted, when and why" is a governance question.
ALTER TABLE "memory_records"
  ADD CONSTRAINT "deleted_memory_keeps_no_content"
  CHECK ("deleted_at" IS NULL OR "content" IS NULL);

-- ===========================================================================
-- Feedback says something
-- ===========================================================================

-- Every rating but `Correct` needs a correction. A bare "Incorrect" tells an agent's owner that
-- something failed and nothing about what, and §27.1 pairs the ratings with "and provide
-- correction/evidence".
--
-- `length(btrim(COALESCE(...)))` rather than `IS NOT NULL`: a column holding three spaces is
-- not a correction, and COALESCE is here because a CHECK whose expression is NULL passes — the
-- failure mode that has now appeared four times in this schema.
ALTER TABLE "ai_output_feedback"
  ADD CONSTRAINT "negative_feedback_says_what_is_wrong"
  CHECK ("rating" = 'Correct' OR length(btrim(COALESCE("correction", ''))) >= 20);

-- A promotion is attributed in all three directions, or it is not a record of anything.
ALTER TABLE "ai_output_feedback"
  ADD CONSTRAINT "feedback_promotion_is_attributed"
  CHECK (
    ("promoted_at" IS NULL AND "promoted_by_user_id" IS NULL AND "promoted_case_id" IS NULL)
    OR ("promoted_at" IS NOT NULL AND "promoted_by_user_id" IS NOT NULL AND "promoted_case_id" IS NOT NULL)
  );

-- Only eligible feedback can be promoted. Promoting a `Correct` rating would create a regression
-- case that asserts the current behaviour and therefore passes by construction.
ALTER TABLE "ai_output_feedback"
  ADD CONSTRAINT "only_eligible_feedback_is_promoted"
  CHECK ("promoted_at" IS NULL OR "evaluation_eligible" = true);
