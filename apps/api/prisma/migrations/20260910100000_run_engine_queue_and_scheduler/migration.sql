-- AlterTable
ALTER TABLE "engine_agents" ADD COLUMN     "last_run_at" TIMESTAMPTZ(6),
ADD COLUMN     "missed_run_policy" VARCHAR(20),
ADD COLUMN     "next_run_at" TIMESTAMPTZ(6),
ADD COLUMN     "overlap_policy" VARCHAR(20),
ADD COLUMN     "schedule_cron" VARCHAR(120);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "engine_agent_id" UUID NOT NULL,
    "engine_agent_version_id" UUID NOT NULL,
    "ai_work_assignment_id" UUID,
    "objective_id" UUID,
    "state" VARCHAR(40) NOT NULL DEFAULT 'Queued',
    "trigger" VARCHAR(20) NOT NULL,
    "idempotency_key" VARCHAR(300) NOT NULL,
    "correlation_id" VARCHAR(80) NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "retryability" VARCHAR(30),
    "scheduled_for" TIMESTAMPTZ(6),
    "reserved_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "percent" SMALLINT,
    "progress_message" VARCHAR(500),
    "output" JSONB,
    "failure_reason" VARCHAR(2000),
    "produced_by_real_model" BOOLEAN,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_user_id" UUID,
    "dead_lettered_at" TIMESTAMPTZ(6),
    "started_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_run_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "state" VARCHAR(40),
    "percent" SMALLINT,
    "message" VARCHAR(500) NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_runs_tenant_id_engine_agent_id_created_at_idx" ON "agent_runs"("tenant_id", "engine_agent_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_runs_tenant_id_state_idx" ON "agent_runs"("tenant_id", "state");

-- CreateIndex
CREATE INDEX "agent_runs_tenant_id_correlation_id_idx" ON "agent_runs"("tenant_id", "correlation_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_tenant_id_id_key" ON "agent_runs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_tenant_id_idempotency_key_key" ON "agent_runs"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "agent_run_events_tenant_id_run_id_occurred_at_idx" ON "agent_run_events"("tenant_id", "run_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_run_events_tenant_id_id_key" ON "agent_run_events"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_tenant_id_engine_agent_id_fkey" FOREIGN KEY ("tenant_id", "engine_agent_id") REFERENCES "engine_agents"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_tenant_id_engine_agent_version_id_fkey" FOREIGN KEY ("tenant_id", "engine_agent_version_id") REFERENCES "engine_agent_versions"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "agent_runs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Prompt 26 — the run engine
-- ===========================================================================
-- Every constraint here was probed in raw SQL before code depended on it.

-- ---------------------------------------------------------------------------
-- 1. Tenant isolation
-- ---------------------------------------------------------------------------
-- Runs and their events hold what an agent did with company data. Symmetric, FORCEd, and never
-- platform-shared.

ALTER TABLE "agent_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "agent_runs_tenant_isolation" ON "agent_runs"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "agent_run_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_run_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "agent_run_events_tenant_isolation" ON "agent_run_events"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- ---------------------------------------------------------------------------
-- 2. A run is in one of the thirteen states, and its trigger is one of five
-- ---------------------------------------------------------------------------
-- Closed sets named here as well as in the shared types. The four Blocked variants are separate
-- states because four different people resolve them, and a fifth invented by a typo would have
-- no owner at all.

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "run_state_is_known"
  CHECK ("state" IN ('Queued', 'Reserved', 'Running', 'WaitingForHumanInput', 'WaitingForApproval',
                     'Retrying', 'Completed', 'Failed', 'Cancelled', 'BlockedByBudget',
                     'BlockedByConnection', 'BlockedByPermission', 'BlockedByProvider'));

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "run_trigger_is_known"
  CHECK ("trigger" IN ('Manual', 'OneTime', 'Scheduled', 'Event', 'Retry'));

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "run_retryability_is_known"
  CHECK ("retryability" IS NULL
         OR "retryability" IN ('Retryable', 'Terminal', 'NeedsIntervention'));

-- ---------------------------------------------------------------------------
-- 3. Attempts are bounded, and progress is a real percentage
-- ---------------------------------------------------------------------------
-- Unbounded retries are how a queue eats itself, so the ceiling is a column and the attempt can
-- never exceed it.

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "run_attempt_starts_at_one"
  CHECK ("attempt" >= 1);

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "run_max_attempts_is_at_least_one"
  CHECK ("max_attempts" >= 1);

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "run_attempt_within_ceiling"
  CHECK ("attempt" <= "max_attempts");

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "run_percent_is_a_percentage"
  CHECK ("percent" IS NULL OR ("percent" >= 0 AND "percent" <= 100));

ALTER TABLE "agent_run_events"
  ADD CONSTRAINT "run_event_percent_is_a_percentage"
  CHECK ("percent" IS NULL OR ("percent" >= 0 AND "percent" <= 100));

-- ---------------------------------------------------------------------------
-- 4. A run that ended says how, and when
-- ---------------------------------------------------------------------------
-- The states that mean "over" all carry a finish time, and the ones that mean "went wrong" all
-- carry a reason. A failed run with no reason is the row that makes an exception centre useless.

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "finished_run_records_when"
  CHECK ("state" NOT IN ('Completed', 'Failed', 'Cancelled') OR "finished_at" IS NOT NULL);

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "unfinished_run_has_no_finish_time"
  CHECK ("state" IN ('Completed', 'Failed', 'Cancelled') OR "finished_at" IS NULL);

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "failed_run_says_why"
  CHECK ("state" <> 'Failed' OR length(btrim(COALESCE("failure_reason", ''))) > 0);

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "blocked_run_says_why"
  CHECK ("state" NOT IN ('BlockedByBudget', 'BlockedByConnection', 'BlockedByPermission',
                         'BlockedByProvider')
         OR length(btrim(COALESCE("failure_reason", ''))) > 0);

-- Cancellation is attributed in both directions, and only a cancelled run is cancelled. A
-- timestamp with no actor is half a record, and "who stopped this" is the first question asked.
ALTER TABLE "agent_runs"
  ADD CONSTRAINT "run_cancellation_is_attributed"
  CHECK (("cancelled_at" IS NULL) = ("cancelled_by_user_id" IS NULL));

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "cancelled_run_records_when"
  CHECK (("state" = 'Cancelled') = ("cancelled_at" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- 5. Reserved before Running, and the ordering of the clock
-- ---------------------------------------------------------------------------
-- The reservation is where budget is set aside. A run that reached `Running` without one would
-- have started spending before anything checked it could — so the timestamp is required by the
-- state rather than by convention.

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "running_run_was_reserved_first"
  CHECK ("state" IN ('Queued', 'Cancelled', 'BlockedByBudget', 'BlockedByConnection',
                     'BlockedByPermission', 'BlockedByProvider')
         OR "reserved_at" IS NOT NULL);

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "run_started_after_it_was_reserved"
  CHECK ("started_at" IS NULL OR "reserved_at" IS NULL OR "started_at" >= "reserved_at");

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "run_finished_after_it_started"
  CHECK ("finished_at" IS NULL OR "started_at" IS NULL OR "finished_at" >= "started_at");

-- ---------------------------------------------------------------------------
-- 6. A completed run says whether a real model produced it
-- ---------------------------------------------------------------------------
-- The same honesty constraint as the Agent Builder and version tests, now on the thing that
-- actually did the work. A completed run silent about its provider is how mock output becomes a
-- real result in a report.

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "completed_run_says_whether_the_model_was_real"
  CHECK ("state" <> 'Completed' OR "produced_by_real_model" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 7. The dead-letter path is only for spent runs
-- ---------------------------------------------------------------------------
-- Dead-lettering a run that could still be retried would abandon work that was going to succeed.

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "dead_lettered_run_is_failed"
  CHECK ("dead_lettered_at" IS NULL OR "state" = 'Failed');

-- ---------------------------------------------------------------------------
-- 8. A scheduled run knows when it was due
-- ---------------------------------------------------------------------------
-- Without this a missed-run policy has nothing to reason about: "was this occurrence late?" needs
-- the moment it was meant to happen.

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "scheduled_run_knows_its_moment"
  CHECK ("trigger" <> 'Scheduled' OR "scheduled_for" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 9. The agent's own policy overrides are from the closed sets
-- ---------------------------------------------------------------------------

ALTER TABLE "engine_agents"
  ADD CONSTRAINT "agent_missed_run_policy_is_known"
  CHECK ("missed_run_policy" IS NULL
         OR "missed_run_policy" IN ('RunOnce', 'RunAll', 'Skip'));

ALTER TABLE "engine_agents"
  ADD CONSTRAINT "agent_overlap_policy_is_known"
  CHECK ("overlap_policy" IS NULL OR "overlap_policy" IN ('Skip', 'Queue', 'Allow'));

-- ---------------------------------------------------------------------------
-- 10. Run events are append-only
-- ---------------------------------------------------------------------------
-- The reason this table exists is that live progress must not be the record. A history that can
-- be edited afterwards is not a history — and the same reasoning already governs the audit trail.

CREATE OR REPLACE FUNCTION uboss_agent_run_events_are_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Run events are append-only. This table is the durable record behind live progress; a '
    'history that can be rewritten afterwards is not a history.'
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER "uboss_agent_run_events_are_append_only"
  BEFORE UPDATE OR DELETE ON "agent_run_events"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_agent_run_events_are_append_only();
