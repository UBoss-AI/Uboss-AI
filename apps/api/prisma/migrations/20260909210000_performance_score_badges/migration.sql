-- CreateEnum
CREATE TYPE "performance_event_kind" AS ENUM ('OnTimeAccepted', 'LateCompletion', 'Missed', 'QualityRejected', 'BlockerNeutralised', 'ManualAdjustment');

-- CreateEnum
CREATE TYPE "badge_level" AS ENUM ('Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond');

-- CreateTable
CREATE TABLE "performance_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "on_time_accepted_points" INTEGER NOT NULL DEFAULT 10,
    "late_completion_points" INTEGER NOT NULL DEFAULT -5,
    "missed_points" INTEGER NOT NULL DEFAULT -15,
    "quality_rejected_points" INTEGER NOT NULL DEFAULT -10,
    "bronze_threshold" INTEGER NOT NULL DEFAULT 0,
    "silver_threshold" INTEGER NOT NULL DEFAULT 100,
    "gold_threshold" INTEGER NOT NULL DEFAULT 300,
    "platinum_threshold" INTEGER NOT NULL DEFAULT 600,
    "diamond_threshold" INTEGER NOT NULL DEFAULT 1000,
    "blockers_neutralise_fully" BOOLEAN NOT NULL DEFAULT true,
    "superseded_at" TIMESTAMPTZ(6),
    "reason" VARCHAR(500) NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "performance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_user_id" UUID NOT NULL,
    "kind" "performance_event_kind" NOT NULL,
    "source_kind" VARCHAR(40) NOT NULL,
    "source_id" VARCHAR(120) NOT NULL,
    "employment_record_id" UUID,
    "points" INTEGER NOT NULL,
    "policy_id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "neutralises_event_id" UUID,
    "reason" VARCHAR(1000),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performance_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "badge_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_user_id" UUID NOT NULL,
    "level" "badge_level" NOT NULL,
    "score_at_change" INTEGER NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_exit_snapshot" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "badge_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "performance_policies_tenant_id_superseded_at_idx" ON "performance_policies"("tenant_id", "superseded_at");

-- CreateIndex
CREATE UNIQUE INDEX "performance_policies_tenant_id_version_key" ON "performance_policies"("tenant_id", "version");

-- CreateIndex
CREATE INDEX "performance_events_tenant_id_subject_user_id_occurred_at_idx" ON "performance_events"("tenant_id", "subject_user_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "performance_events_tenant_id_subject_user_id_source_kind_so_key" ON "performance_events"("tenant_id", "subject_user_id", "source_kind", "source_id", "kind");

-- CreateIndex
CREATE INDEX "badge_history_tenant_id_subject_user_id_started_at_idx" ON "badge_history"("tenant_id", "subject_user_id", "started_at" DESC);

-- AddForeignKey
ALTER TABLE "performance_policies" ADD CONSTRAINT "performance_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_events" ADD CONSTRAINT "performance_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_events" ADD CONSTRAINT "performance_events_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "performance_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "badge_history" ADD CONSTRAINT "badge_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Prompt 12B — hand-written section
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Row-Level Security on all three tables
-- ---------------------------------------------------------------------------

ALTER TABLE "performance_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "performance_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "performance_policies_tenant_isolation" ON "performance_policies"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "performance_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "performance_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "performance_events_tenant_isolation" ON "performance_events"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "badge_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "badge_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY "badge_history_tenant_isolation" ON "badge_history"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- ---------------------------------------------------------------------------
-- 2. Only one active policy version per company
-- ---------------------------------------------------------------------------
-- Two active versions would make "which rules scored this event" ambiguous, and the engine
-- would pick one arbitrarily.

CREATE UNIQUE INDEX "one_active_performance_policy_per_tenant"
  ON "performance_policies" ("tenant_id")
  WHERE "superseded_at" IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Threshold and event coherence
-- ---------------------------------------------------------------------------
-- Thresholds must ascend. Out of order, a score could satisfy Diamond and not Gold, and the
-- ladder would stop being a ladder.
ALTER TABLE "performance_policies"
  ADD CONSTRAINT "badge_thresholds_ascend"
  CHECK (
    "bronze_threshold" <= "silver_threshold"
    AND "silver_threshold" <= "gold_threshold"
    AND "gold_threshold" <= "platinum_threshold"
    AND "platinum_threshold" <= "diamond_threshold"
  );

-- A positive kind must not carry negative points, and vice versa. The policy configures the
-- magnitude; the *sign* is what the event kind means, and a policy that inverted it would make
-- missing a deadline improve somebody's score.
ALTER TABLE "performance_policies"
  ADD CONSTRAINT "performance_points_have_the_right_sign"
  CHECK (
    "on_time_accepted_points" >= 0
    AND "late_completion_points" <= 0
    AND "missed_points" <= 0
    AND "quality_rejected_points" <= 0
  );

ALTER TABLE "performance_policies"
  ADD CONSTRAINT "performance_policy_reason_is_not_blank"
  CHECK (length(btrim("reason")) > 0);

ALTER TABLE "performance_policies"
  ADD CONSTRAINT "performance_policy_version_is_positive"
  CHECK ("version" >= 1);

-- A manual adjustment and a neutralisation must both say why: they are the two kinds a person
-- chooses rather than a system deriving, and an unexplained adjustment to somebody's score is
-- the one they dispute.
ALTER TABLE "performance_events"
  ADD CONSTRAINT "discretionary_performance_event_has_a_reason"
  CHECK (
    "kind" NOT IN ('ManualAdjustment', 'BlockerNeutralised')
    OR length(btrim(COALESCE("reason", ''))) > 0
  );

-- A neutralisation must name what it neutralises; nothing else may.
ALTER TABLE "performance_events"
  ADD CONSTRAINT "neutralisation_names_its_event"
  CHECK (
    ("kind" = 'BlockerNeutralised' AND "neutralises_event_id" IS NOT NULL)
    OR ("kind" <> 'BlockerNeutralised' AND "neutralises_event_id" IS NULL)
  );

ALTER TABLE "performance_events"
  ADD CONSTRAINT "performance_event_source_is_named"
  CHECK (length(btrim("source_kind")) > 0 AND length(btrim("source_id")) > 0);

-- A badge period cannot end before it began.
ALTER TABLE "badge_history"
  ADD CONSTRAINT "badge_period_is_ordered"
  CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");

-- One current level per person per company. A second open row would make "what level are they"
-- ambiguous on the one screen that asks.
CREATE UNIQUE INDEX "one_current_badge_per_person"
  ON "badge_history" ("tenant_id", "subject_user_id")
  WHERE "ended_at" IS NULL;

-- ---------------------------------------------------------------------------
-- 4. The ledger is append-only
-- ---------------------------------------------------------------------------
-- The score is derived from these rows, so rewriting one silently restates somebody's
-- performance history. As with the settings history (Prompt 14) there is no hash chain, so the
-- claim is "the application cannot rewrite it" rather than "tampering is detectable". A
-- correction is a new `ManualAdjustment` event with a reason, which is also the honest shape:
-- the original outcome happened.

REVOKE UPDATE, DELETE ON "performance_events" FROM uboss_app;

-- ---------------------------------------------------------------------------
-- 5. Backfill: a default policy per existing company
-- ---------------------------------------------------------------------------
-- The engine cannot score an event without an active policy, and a company that has never
-- opened the screen must still accumulate performance from the day the feature ships. The
-- defaults are the column defaults, so this row states them explicitly for the record.

INSERT INTO "performance_policies"
  ("id", "tenant_id", "version", "reason", "created_at", "updated_at")
SELECT
  gen_random_uuid(), t."id", 1,
  'Baseline policy created by the Prompt 12B migration so performance can be scored from the '
    || 'day the feature ships. Thresholds are the documented defaults; change them from '
    || 'Settings to create version 2.',
  NOW(), NOW()
FROM "tenants" t
WHERE NOT EXISTS (
  SELECT 1 FROM "performance_policies" p WHERE p."tenant_id" = t."id"
);
