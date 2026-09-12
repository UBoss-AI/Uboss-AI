
-- AlterTable
ALTER TABLE "cost_ledger_entries" ADD COLUMN     "correlation_id" VARCHAR(80);

-- AlterTable
ALTER TABLE "model_gateway_calls" ADD COLUMN     "correlation_id" VARCHAR(80);

-- AlterTable
ALTER TABLE "service_alerts" ADD COLUMN     "postmortem" TEXT,
ADD COLUMN     "postmortem_at" TIMESTAMPTZ(6),
ADD COLUMN     "postmortem_by_user_id" UUID;

-- CreateTable
CREATE TABLE "incident_timeline_entries" (
    "id" UUID NOT NULL,
    "service_alert_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "note" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "author_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_timeline_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corrective_actions" (
    "id" UUID NOT NULL,
    "service_alert_id" UUID NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'Open',
    "owner_user_id" UUID NOT NULL,
    "due_on" DATE NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "completed_by_user_id" UUID,
    "outcome_note" VARCHAR(2000),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "corrective_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incident_timeline_entries_service_alert_id_occurred_at_idx" ON "incident_timeline_entries"("service_alert_id", "occurred_at");

-- CreateIndex
CREATE INDEX "corrective_actions_service_alert_id_state_idx" ON "corrective_actions"("service_alert_id", "state");

-- CreateIndex
CREATE INDEX "corrective_actions_state_due_on_idx" ON "corrective_actions"("state", "due_on");

-- CreateIndex
CREATE INDEX "cost_ledger_entries_tenant_id_correlation_id_idx" ON "cost_ledger_entries"("tenant_id", "correlation_id");

-- CreateIndex
CREATE INDEX "model_gateway_calls_tenant_id_correlation_id_idx" ON "model_gateway_calls"("tenant_id", "correlation_id");

-- AddForeignKey
ALTER TABLE "incident_timeline_entries" ADD CONSTRAINT "incident_timeline_entries_service_alert_id_fkey" FOREIGN KEY ("service_alert_id") REFERENCES "service_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_service_alert_id_fkey" FOREIGN KEY ("service_alert_id") REFERENCES "service_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- The two new tables are platform-plane, like `service_alerts` itself
-- ===========================================================================
--
-- An incident is UBoss's, not a customer's. `service_alerts` has had no Row-Level Security since
-- Prompt 9 — it carries a nullable `affected_tenant_id` that is deliberately not a foreign key, so
-- an alert about a company survives that company being closed, which is when the history matters
-- most. A timeline entry and a corrective action belong to the alert and inherit that reasoning.
--
-- They are reached only through `@PlatformOnly` routes gated on the `support` module, and a
-- company never sees them: the customer-facing status endpoint projects `customer_impact` alone
-- (S-257), and neither table is in that projection.

GRANT SELECT, INSERT, UPDATE, DELETE ON "incident_timeline_entries" TO "uboss_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "corrective_actions" TO "uboss_app";

-- ===========================================================================
-- A timeline entry is readable
-- ===========================================================================

-- An empty entry is a timestamp nobody can read.
ALTER TABLE "incident_timeline_entries"
  ADD CONSTRAINT "timeline_entry_says_something"
  CHECK (length(btrim("note")) > 0);

ALTER TABLE "incident_timeline_entries"
  ADD CONSTRAINT "timeline_kind_is_known"
  CHECK ("kind" IN ('Detected', 'Investigating', 'Update', 'Mitigated', 'Resolved', 'Note'));

-- ===========================================================================
-- A corrective action is owned and dated, or it is a wish
-- ===========================================================================

ALTER TABLE "corrective_actions"
  ADD CONSTRAINT "corrective_action_state_is_known"
  CHECK ("state" IN ('Open', 'Done', 'Dropped'));

ALTER TABLE "corrective_actions"
  ADD CONSTRAINT "corrective_action_says_something"
  CHECK (length(btrim("description")) > 0);

-- **A completion is attributed and dated together.**
ALTER TABLE "corrective_actions"
  ADD CONSTRAINT "corrective_action_completion_is_attributed"
  CHECK (("completed_at" IS NULL) = ("completed_by_user_id" IS NULL));

-- A finished action records when it finished; an open one has not.
ALTER TABLE "corrective_actions"
  ADD CONSTRAINT "finished_action_records_when"
  CHECK (("state" = 'Open') = ("completed_at" IS NULL));

-- **Dropping an action needs a reason more than doing it does.**
--
-- Deciding not to fix something a postmortem identified is the decision somebody will be asked
-- about. `COALESCE` because a CHECK whose expression is NULL passes — the failure mode this schema
-- has now hit four times.
ALTER TABLE "corrective_actions"
  ADD CONSTRAINT "dropped_action_says_why"
  CHECK ("state" <> 'Dropped' OR length(btrim(COALESCE("outcome_note", ''))) > 0);

-- ===========================================================================
-- A postmortem is attributed and dated
-- ===========================================================================

ALTER TABLE "service_alerts"
  ADD CONSTRAINT "postmortem_is_attributed"
  CHECK (
    ("postmortem" IS NULL AND "postmortem_at" IS NULL AND "postmortem_by_user_id" IS NULL)
    OR ("postmortem" IS NOT NULL AND "postmortem_at" IS NOT NULL
        AND "postmortem_by_user_id" IS NOT NULL)
  );

-- **A P0 or P1 is not resolved without one.**
--
-- §30 lists the postmortem as part of the incident, and the whole value of a severity scale is
-- that the serious ones are treated differently. In the database as well as in the service,
-- because "we'll write it up later" is the pressure this constraint exists to resist — and later
-- never comes once the incident is closed and off the board.
--
-- A P2 may resolve on its mitigation note alone: most are a configuration fix nobody needs to
-- read about.
ALTER TABLE "service_alerts"
  ADD CONSTRAINT "serious_incident_is_post_mortemed_before_resolving"
  CHECK (
    "state" <> 'Resolved'
    OR "incident_severity" IS NULL
    OR "incident_severity" NOT IN ('P0', 'P1')
    OR "postmortem" IS NOT NULL
  );
