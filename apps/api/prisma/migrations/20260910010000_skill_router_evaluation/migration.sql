-- CreateEnum
CREATE TYPE "evaluation_assertion_kind" AS ENUM ('ExactMatch', 'ContainsAll', 'HumanJudged');

-- CreateEnum
CREATE TYPE "regression_verdict_kind" AS ENUM ('Improved', 'NoChange', 'Regressed', 'Mixed', 'Inconclusive');

-- CreateEnum
CREATE TYPE "skill_candidate_status_kind" AS ENUM ('Suggested', 'UnderReview', 'Accepted', 'Rejected');

-- CreateTable
CREATE TABLE "skill_evaluation_cases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "skill_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" VARCHAR(1000) NOT NULL,
    "inputs" JSONB NOT NULL,
    "assertion" "evaluation_assertion_kind" NOT NULL,
    "expected" TEXT NOT NULL,
    "used_in_comparison" BOOLEAN NOT NULL DEFAULT false,
    "retired_at" TIMESTAMPTZ(6),
    "retired_reason" VARCHAR(500),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "skill_evaluation_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_evaluation_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "case_id" UUID NOT NULL,
    "skill_version_id" UUID NOT NULL,
    "actual_output" TEXT NOT NULL,
    "passed" BOOLEAN,
    "produced_by" VARCHAR(60) NOT NULL DEFAULT 'Recorded',
    "note" VARCHAR(1000),
    "duration_ms" INTEGER,
    "run_by_user_id" UUID,
    "run_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_evaluation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_regression_comparisons" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "skill_id" UUID NOT NULL,
    "current_version_id" UUID,
    "candidate_version_id" UUID NOT NULL,
    "cases_compared" INTEGER NOT NULL,
    "regression_case_ids" UUID[],
    "improvement_case_ids" UUID[],
    "unjudged_case_ids" UUID[],
    "verdict" "regression_verdict_kind" NOT NULL,
    "accepted_despite_regression_by_user_id" UUID,
    "accepted_despite_regression_at" TIMESTAMPTZ(6),
    "acceptance_reason" VARCHAR(1000),
    "run_by_user_id" UUID,
    "run_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_regression_comparisons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_candidates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" "skill_candidate_status_kind" NOT NULL DEFAULT 'Suggested',
    "requested_capability" VARCHAR(2000) NOT NULL,
    "routing_context" JSONB NOT NULL,
    "considered_and_rejected" JSONB NOT NULL,
    "suggested_name" VARCHAR(160),
    "suggested_purpose" VARCHAR(2000),
    "created_skill_id" UUID,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "decision_reason" VARCHAR(1000),
    "requested_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "skill_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "skill_evaluation_cases_tenant_id_skill_id_retired_at_idx" ON "skill_evaluation_cases"("tenant_id", "skill_id", "retired_at");

-- CreateIndex
CREATE UNIQUE INDEX "skill_evaluation_cases_skill_id_name_key" ON "skill_evaluation_cases"("skill_id", "name");

-- CreateIndex
CREATE INDEX "skill_evaluation_runs_case_id_skill_version_id_run_at_idx" ON "skill_evaluation_runs"("case_id", "skill_version_id", "run_at" DESC);

-- CreateIndex
CREATE INDEX "skill_evaluation_runs_skill_version_id_idx" ON "skill_evaluation_runs"("skill_version_id");

-- CreateIndex
CREATE INDEX "skill_regression_comparisons_tenant_id_skill_id_run_at_idx" ON "skill_regression_comparisons"("tenant_id", "skill_id", "run_at" DESC);

-- CreateIndex
CREATE INDEX "skill_regression_comparisons_candidate_version_id_idx" ON "skill_regression_comparisons"("candidate_version_id");

-- CreateIndex
CREATE INDEX "skill_candidates_tenant_id_status_created_at_idx" ON "skill_candidates"("tenant_id", "status", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "skill_evaluation_cases" ADD CONSTRAINT "skill_evaluation_cases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_evaluation_cases" ADD CONSTRAINT "skill_evaluation_cases_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_evaluation_runs" ADD CONSTRAINT "skill_evaluation_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_evaluation_runs" ADD CONSTRAINT "skill_evaluation_runs_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "skill_evaluation_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_regression_comparisons" ADD CONSTRAINT "skill_regression_comparisons_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_regression_comparisons" ADD CONSTRAINT "skill_regression_comparisons_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_candidates" ADD CONSTRAINT "skill_candidates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Prompt 18 — hand-written section
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Row-Level Security
-- ---------------------------------------------------------------------------
-- The three evaluation tables follow Prompt 17's **asymmetric** policy, for the same reason: a
-- case, a run and a comparison on a platform Skill have `tenant_id IS NULL` and every company
-- may read them (the evidence behind a Verified Skill is part of what makes it trustworthy),
-- while only the platform may write one.
--
-- `skill_candidates` is different: it is always a company's own request, so it takes the ordinary
-- symmetric policy. There is no such thing as a platform-plane Candidate — a missing capability
-- is missing *for somebody*.

ALTER TABLE "skill_evaluation_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_evaluation_cases" FORCE ROW LEVEL SECURITY;
CREATE POLICY "skill_evaluation_cases_tenant_isolation" ON "skill_evaluation_cases"
  USING (
    "tenant_id" IS NULL
    OR "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "skill_evaluation_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_evaluation_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "skill_evaluation_runs_tenant_isolation" ON "skill_evaluation_runs"
  USING (
    "tenant_id" IS NULL
    OR "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "skill_regression_comparisons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_regression_comparisons" FORCE ROW LEVEL SECURITY;
CREATE POLICY "skill_regression_comparisons_tenant_isolation" ON "skill_regression_comparisons"
  USING (
    "tenant_id" IS NULL
    OR "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "skill_candidates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_candidates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "skill_candidates_tenant_isolation" ON "skill_candidates"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- ---------------------------------------------------------------------------
-- 2. A case has to be a case
-- ---------------------------------------------------------------------------

ALTER TABLE "skill_evaluation_cases"
  ADD CONSTRAINT "evaluation_case_is_stated"
  CHECK (
    length(btrim("name")) > 0
    AND length(btrim("description")) > 0
    AND length(btrim("expected")) > 0
  );

-- Retiring a case removes it from future comparisons, so it says why.
ALTER TABLE "skill_evaluation_cases"
  ADD CONSTRAINT "retired_case_has_a_reason"
  CHECK (
    "retired_at" IS NULL OR length(btrim(COALESCE("retired_reason", ''))) > 0
  );

-- ---------------------------------------------------------------------------
-- 3. A run cannot fabricate a verdict
-- ---------------------------------------------------------------------------
-- `passed` is nullable on purpose: a `HumanJudged` case nobody has judged is neither a pass nor a
-- failure, and a comparison must not be able to lean on it. What the row must never be is
-- *silent* — an output of nothing with a verdict attached would be a result with no evidence.

ALTER TABLE "skill_evaluation_runs"
  ADD CONSTRAINT "evaluation_run_records_its_output"
  CHECK (length("actual_output") > 0 OR "passed" IS NULL);

ALTER TABLE "skill_evaluation_runs"
  ADD CONSTRAINT "evaluation_run_says_where_output_came_from"
  CHECK (length(btrim("produced_by")) > 0);

ALTER TABLE "skill_evaluation_runs"
  ADD CONSTRAINT "evaluation_run_duration_is_not_negative"
  CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0);

-- **The evaluation record is append-only.** A run whose verdict could be edited afterwards is not
-- evidence — and a regression comparison is exactly the kind of evidence somebody publishes on.
-- A wrong verdict is corrected by recording another run, which is also the honest shape: the
-- first result did happen.
REVOKE UPDATE, DELETE ON "skill_evaluation_runs" FROM uboss_app;

-- ---------------------------------------------------------------------------
-- 4. A comparison cannot compare a version with itself, or hide a regression
-- ---------------------------------------------------------------------------

ALTER TABLE "skill_regression_comparisons"
  ADD CONSTRAINT "comparison_compares_two_versions"
  CHECK ("current_version_id" IS NULL OR "current_version_id" <> "candidate_version_id");

ALTER TABLE "skill_regression_comparisons"
  ADD CONSTRAINT "comparison_counts_are_not_negative"
  CHECK ("cases_compared" >= 0);

-- A verdict of `Inconclusive` is the only one permitted with nothing compared, and conversely.
-- Anything else would be a conclusion drawn from no evidence.
ALTER TABLE "skill_regression_comparisons"
  ADD CONSTRAINT "inconclusive_means_nothing_was_compared"
  CHECK (
    ("cases_compared" = 0 AND "verdict" = 'Inconclusive')
    OR ("cases_compared" > 0 AND "verdict" <> 'Inconclusive')
  );

-- A verdict of `Regressed` or `Mixed` must actually list a regression, and `Improved` must list
-- an improvement. The verdict is derived from these arrays, so a row where they disagree is a
-- row whose verdict came from somewhere else.
ALTER TABLE "skill_regression_comparisons"
  ADD CONSTRAINT "verdict_matches_its_evidence"
  CHECK (
    ("verdict" IN ('Regressed', 'Mixed') AND COALESCE(array_length("regression_case_ids", 1), 0) > 0)
    OR ("verdict" = 'Improved' AND COALESCE(array_length("improvement_case_ids", 1), 0) > 0
        AND COALESCE(array_length("regression_case_ids", 1), 0) = 0)
    OR ("verdict" = 'NoChange'
        AND COALESCE(array_length("regression_case_ids", 1), 0) = 0
        AND COALESCE(array_length("improvement_case_ids", 1), 0) = 0)
    OR "verdict" = 'Inconclusive'
  );

-- **Publishing over a regression is a decision somebody makes and signs.**
ALTER TABLE "skill_regression_comparisons"
  ADD CONSTRAINT "regression_acceptance_is_attributed"
  CHECK (
    "accepted_despite_regression_at" IS NULL
    OR (
      "accepted_despite_regression_by_user_id" IS NOT NULL
      AND length(btrim(COALESCE("acceptance_reason", ''))) > 0
    )
  );

-- A comparison is evidence. `UPDATE` is needed only to record an acceptance, so `DELETE` goes.
REVOKE DELETE ON "skill_regression_comparisons" FROM uboss_app;

-- ---------------------------------------------------------------------------
-- 5. A Candidate is never a published capability
-- ---------------------------------------------------------------------------
-- The client's rule: never silently publish or auto-use a missing capability. The enum has no
-- `Published` member at all, which is the strongest version of that — there is no value to set.
--
-- What remains enforceable here is that a decision is attributed and explained, and that
-- acceptance actually produced the Draft it claims to have produced.

ALTER TABLE "skill_candidates"
  ADD CONSTRAINT "candidate_states_what_was_wanted"
  CHECK (length(btrim("requested_capability")) > 0);

ALTER TABLE "skill_candidates"
  ADD CONSTRAINT "candidate_decision_is_attributed"
  CHECK (
    "status" NOT IN ('Accepted', 'Rejected')
    OR (
      "reviewed_by_user_id" IS NOT NULL
      AND "reviewed_at" IS NOT NULL
      AND length(btrim(COALESCE("decision_reason", ''))) > 0
    )
  );

-- Acceptance means a Draft Skill exists. Without one, "accepted" would describe nothing.
ALTER TABLE "skill_candidates"
  ADD CONSTRAINT "accepted_candidate_produced_a_draft"
  CHECK ("status" <> 'Accepted' OR "created_skill_id" IS NOT NULL);

-- And a Skill is only created by acceptance.
ALTER TABLE "skill_candidates"
  ADD CONSTRAINT "only_acceptance_creates_a_skill"
  CHECK ("created_skill_id" IS NULL OR "status" = 'Accepted');

-- ---------------------------------------------------------------------------
-- 6. What is deliberately NOT here
-- ---------------------------------------------------------------------------
-- **No routing-decision table.** The router is a pure function over declared Skill fields, so a
-- decision is reproducible from its inputs; persisting every one would be a high-volume log of
-- something derivable. What *is* recorded is the exception: a `skill_candidate` when nothing
-- applied, carrying the context and every rejection — because that is the case somebody has to
-- act on, and the case that must not be silently improvised past.
--
-- **No evaluator.** Running a Skill needs the Model Gateway. `skill_evaluation_runs.produced_by`
-- defaults to `Recorded` and the service says so at every layer: a stub that invented plausible
-- output would make every green comparison worthless.
