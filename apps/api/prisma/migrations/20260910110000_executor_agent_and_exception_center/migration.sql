-- CreateTable
CREATE TABLE "executor_exceptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" VARCHAR(60) NOT NULL,
    "severity" VARCHAR(20) NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'Open',
    "source_type" VARCHAR(40) NOT NULL,
    "source_id" UUID NOT NULL,
    "objective_id" UUID,
    "engine_agent_id" UUID,
    "detail" VARCHAR(2000) NOT NULL,
    "evidence" JSONB,
    "owner_user_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "escalation_hours" INTEGER NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "escalated_at" TIMESTAMPTZ(6),
    "escalated_to_user_id" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "closed_by_user_id" UUID,
    "close_reason" VARCHAR(2000),
    "expectation_id" UUID,
    "dedupe_key" VARCHAR(300) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "executor_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "executor_exception_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "exception_id" UUID NOT NULL,
    "action" VARCHAR(40),
    "state" VARCHAR(20) NOT NULL,
    "actor_user_id" UUID,
    "by_executor" BOOLEAN NOT NULL DEFAULT false,
    "note" VARCHAR(2000) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "executor_exception_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "executor_exceptions_tenant_id_state_severity_idx" ON "executor_exceptions"("tenant_id", "state", "severity");

-- CreateIndex
CREATE INDEX "executor_exceptions_tenant_id_kind_state_idx" ON "executor_exceptions"("tenant_id", "kind", "state");

-- CreateIndex
CREATE INDEX "executor_exceptions_tenant_id_engine_agent_id_idx" ON "executor_exceptions"("tenant_id", "engine_agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "executor_exceptions_tenant_id_id_key" ON "executor_exceptions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "executor_exception_events_tenant_id_exception_id_occurred_a_idx" ON "executor_exception_events"("tenant_id", "exception_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "executor_exception_events_tenant_id_id_key" ON "executor_exception_events"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "executor_exceptions" ADD CONSTRAINT "executor_exceptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_exception_events" ADD CONSTRAINT "executor_exception_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_exception_events" ADD CONSTRAINT "executor_exception_events_tenant_id_exception_id_fkey" FOREIGN KEY ("tenant_id", "exception_id") REFERENCES "executor_exceptions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Prompt 27 — the Exception Center
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Tenant isolation
-- ---------------------------------------------------------------------------

ALTER TABLE "executor_exceptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "executor_exceptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "executor_exceptions_tenant_isolation" ON "executor_exceptions"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "executor_exception_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "executor_exception_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "executor_exception_events_tenant_isolation" ON "executor_exception_events"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- ---------------------------------------------------------------------------
-- 2. The closed vocabularies
-- ---------------------------------------------------------------------------
-- Ten kinds, three severities, five states, four source types. Named here as well as in the
-- shared types so a typo cannot introduce an eleventh kind that no screen has a label, a default
-- owner or an escalation window for.

ALTER TABLE "executor_exceptions"
  ADD CONSTRAINT "exception_kind_is_known"
  CHECK ("kind" IN ('NeedsHumanInput', 'CredentialOrConnectionExpired', 'PermissionDenied',
                    'BudgetOrTokenLimit', 'ProviderOrToolUnavailable', 'ValidationFailed',
                    'ApprovalPending', 'RepeatedFailure', 'HumanTaskOverdue', 'MissingEvidence'));

ALTER TABLE "executor_exceptions"
  ADD CONSTRAINT "exception_severity_is_known"
  CHECK ("severity" IN ('Low', 'Medium', 'High'));

ALTER TABLE "executor_exceptions"
  ADD CONSTRAINT "exception_state_is_known"
  CHECK ("state" IN ('Open', 'Acknowledged', 'Escalated', 'Resolved', 'Dismissed'));

ALTER TABLE "executor_exceptions"
  ADD CONSTRAINT "exception_source_type_is_known"
  CHECK ("source_type" IN ('HumanTask', 'AgentRun', 'Connection', 'ApprovalRequest'));

ALTER TABLE "executor_exception_events"
  ADD CONSTRAINT "exception_event_state_is_known"
  CHECK ("state" IN ('Open', 'Acknowledged', 'Escalated', 'Resolved', 'Dismissed'));

ALTER TABLE "executor_exception_events"
  ADD CONSTRAINT "exception_event_action_is_known"
  CHECK ("action" IS NULL
         OR "action" IN ('Acknowledge', 'Reassign', 'Escalate', 'Retry', 'PauseAgent',
                         'RequestApproval', 'Resolve', 'Dismiss'));

-- ---------------------------------------------------------------------------
-- 3. An exception says what happened, and its numbers are real
-- ---------------------------------------------------------------------------

ALTER TABLE "executor_exceptions"
  ADD CONSTRAINT "exception_says_what_happened"
  CHECK (length(btrim("detail")) > 0);

ALTER TABLE "executor_exceptions"
  ADD CONSTRAINT "exception_attempts_start_at_one"
  CHECK ("attempts" >= 1);

-- Resolved at raise time from severity and policy, so a later policy change cannot retroactively
-- make a past exception look overdue.
ALTER TABLE "executor_exceptions"
  ADD CONSTRAINT "exception_escalation_window_is_positive"
  CHECK ("escalation_hours" >= 1);

ALTER TABLE "executor_exceptions"
  ADD CONSTRAINT "exception_evidence_is_an_object"
  CHECK ("evidence" IS NULL OR jsonb_typeof("evidence") = 'object');

-- ---------------------------------------------------------------------------
-- 4. Closing and escalating are attributed
-- ---------------------------------------------------------------------------
-- Who decided this was dealt with is the question an auditor asks about a closed exception, and a
-- close with no actor cannot answer it.

ALTER TABLE "executor_exceptions"
  ADD CONSTRAINT "closed_exception_records_when"
  CHECK (("state" IN ('Resolved', 'Dismissed')) = ("closed_at" IS NOT NULL));

ALTER TABLE "executor_exceptions"
  ADD CONSTRAINT "closed_exception_is_attributed"
  CHECK (("closed_at" IS NULL) = ("closed_by_user_id" IS NULL));

ALTER TABLE "executor_exceptions"
  ADD CONSTRAINT "closed_exception_says_why"
  CHECK ("closed_at" IS NULL OR length(btrim(COALESCE("close_reason", ''))) > 0);

-- An escalation with no destination is not a route. Both directions, so neither half can be
-- recorded without the other.
ALTER TABLE "executor_exceptions"
  ADD CONSTRAINT "escalation_is_attributed"
  CHECK (("escalated_at" IS NULL) = ("escalated_to_user_id" IS NULL));

ALTER TABLE "executor_exceptions"
  ADD CONSTRAINT "escalated_exception_records_when"
  CHECK ("state" <> 'Escalated' OR "escalated_at" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 5. One condition raises one open exception
-- ---------------------------------------------------------------------------
-- The Executor sweeps repeatedly. Without this, an overdue task would raise a fresh exception on
-- every pass and the Exception Center would fill with duplicates of the one thing nobody has
-- fixed, which is how a queue stops being read.
--
-- Partial, on the open states only: once an exception is closed the same condition recurring is a
-- genuinely new event and must be able to raise a new one.

CREATE UNIQUE INDEX "one_open_exception_per_condition"
  ON "executor_exceptions" ("tenant_id", "dedupe_key")
  WHERE "state" IN ('Open', 'Acknowledged', 'Escalated');

-- ---------------------------------------------------------------------------
-- 6. An event either has a person or was the Executor
-- ---------------------------------------------------------------------------
-- The locked rule leaves a trace here: every entry in the resolution history says whether a
-- person or the oversight layer did it, and it cannot say neither. Nobody and the machine are
-- different answers, and a report must never conflate them.

ALTER TABLE "executor_exception_events"
  ADD CONSTRAINT "exception_event_has_an_actor"
  CHECK (("actor_user_id" IS NOT NULL) <> ("by_executor" = true));

-- The Executor may never record a Resolve or a Dismiss. Enforced in the database as well as in
-- the service, because this is the rule the whole oversight design rests on: an Executor that
-- could close its own findings would not be oversight.
ALTER TABLE "executor_exception_events"
  ADD CONSTRAINT "executor_never_closes_an_exception"
  CHECK ("by_executor" = false OR "action" IS NULL
         OR "action" NOT IN ('Resolve', 'Dismiss'));

-- ---------------------------------------------------------------------------
-- 7. The resolution history is append-only
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION uboss_exception_events_are_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Exception resolution history is append-only. It records who did what about a problem, and a '
    'history that can be edited afterwards is not evidence.'
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER "uboss_exception_events_are_append_only"
  BEFORE UPDATE OR DELETE ON "executor_exception_events"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_exception_events_are_append_only();
