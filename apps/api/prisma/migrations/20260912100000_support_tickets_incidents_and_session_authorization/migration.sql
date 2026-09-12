
-- AlterEnum
-- **`IF NOT EXISTS` is load-bearing.** `ALTER TYPE ... ADD VALUE` is not transactional:
-- PostgreSQL commits the new label even when a later statement in this migration fails, and a
-- label cannot be dropped. Without this, one failure would leave a migration that can never be
-- replayed. (Prompt 34 learned this the expensive way.)
ALTER TYPE "service_alert_state" ADD VALUE IF NOT EXISTS 'Mitigated';

-- DropForeignKey
ALTER TABLE "knowledge_sources" DROP CONSTRAINT "knowledge_sources_tenant_id_connection_id_fkey";

-- AlterTable
ALTER TABLE "break_glass_requests" ADD COLUMN     "customer_authorization_note" VARCHAR(500),
ADD COLUMN     "customer_authorization_state" VARCHAR(20) NOT NULL DEFAULT 'NotRequired',
ADD COLUMN     "customer_authorized_at" TIMESTAMPTZ(6),
ADD COLUMN     "customer_authorized_by_user_id" UUID,
ADD COLUMN     "support_ticket_id" UUID;

-- AlterTable
ALTER TABLE "service_alerts" ADD COLUMN     "customer_impact" VARCHAR(2000),
ADD COLUMN     "customer_visible" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "declared_at" TIMESTAMPTZ(6),
ADD COLUMN     "declared_by_user_id" UUID,
ADD COLUMN     "incident_severity" VARCHAR(10),
ADD COLUMN     "mitigated_at" TIMESTAMPTZ(6),
ADD COLUMN     "mitigation" VARCHAR(4000),
ADD COLUMN     "owner_user_id" UUID;

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" INTEGER NOT NULL,
    "subject" VARCHAR(300) NOT NULL,
    "body" VARCHAR(8000) NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "priority" VARCHAR(20) NOT NULL DEFAULT 'Normal',
    "state" VARCHAR(30) NOT NULL DEFAULT 'New',
    "raised_by_user_id" UUID NOT NULL,
    "assigned_operator_user_id" UUID,
    "acknowledged_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "resolution_note" VARCHAR(4000),
    "closed_at" TIMESTAMPTZ(6),
    "service_alert_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "support_ticket_id" UUID NOT NULL,
    "body" VARCHAR(8000) NOT NULL,
    "is_internal" BOOLEAN NOT NULL DEFAULT true,
    "author_user_id" UUID NOT NULL,
    "author_is_operator" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "support_ticket_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_tickets_tenant_id_state_idx" ON "support_tickets"("tenant_id", "state");

-- CreateIndex
CREATE INDEX "support_tickets_state_priority_idx" ON "support_tickets"("state", "priority");

-- CreateIndex
CREATE INDEX "support_tickets_assigned_operator_user_id_state_idx" ON "support_tickets"("assigned_operator_user_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_tenant_id_id_key" ON "support_tickets"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_tenant_id_reference_key" ON "support_tickets"("tenant_id", "reference");

-- CreateIndex
CREATE INDEX "support_ticket_notes_tenant_id_support_ticket_id_created_at_idx" ON "support_ticket_notes"("tenant_id", "support_ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "service_alerts_incident_severity_state_idx" ON "service_alerts"("incident_severity", "state");

-- CreateIndex
CREATE INDEX "service_alerts_customer_visible_state_idx" ON "service_alerts"("customer_visible", "state");

-- AddForeignKey
ALTER TABLE "break_glass_requests" ADD CONSTRAINT "break_glass_requests_tenant_id_support_ticket_id_fkey" FOREIGN KEY ("tenant_id", "support_ticket_id") REFERENCES "support_tickets"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "connections"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_service_alert_id_fkey" FOREIGN KEY ("service_alert_id") REFERENCES "service_alerts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_notes" ADD CONSTRAINT "support_ticket_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_notes" ADD CONSTRAINT "support_ticket_notes_tenant_id_support_ticket_id_fkey" FOREIGN KEY ("tenant_id", "support_ticket_id") REFERENCES "support_tickets"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Row-level security
-- ===========================================================================
--
-- `support_tickets` and `support_ticket_notes` are strictly tenant-owned: a ticket is raised by a
-- company's own people, about their own use of UBoss, and one company must never see another's.
-- Platform operators reach them through `app.platform_operation`, which is what every Master
-- Console read already uses and what the audit trail records.
--
-- **`service_alerts` deliberately stays outside RLS.** It is a platform-plane table with a
-- nullable `affected_tenant_id` that is intentionally not a foreign key, so an alert about a
-- company survives that company being closed — which is exactly when the history matters. It has
-- been that way since Prompt 9 and this prompt does not change it; what this prompt adds is that
-- the *customer-facing* read never returns a row, only the published fields of one.

ALTER TABLE "support_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_tickets" FORCE ROW LEVEL SECURITY;
CREATE POLICY support_tickets_tenant_isolation ON "support_tickets"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "support_ticket_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_ticket_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY support_ticket_notes_tenant_isolation ON "support_ticket_notes"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "support_tickets" TO "uboss_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "support_ticket_notes" TO "uboss_app";

-- ===========================================================================
-- A ticket says what happened to it
-- ===========================================================================

-- A resolved ticket explains itself. "Fixed" with no words is not an answer to a company that
-- asked a question, and it is the field a support review reads first.
--
-- `COALESCE` because a CHECK whose expression is NULL **passes** — the failure mode this schema
-- has now hit three times.
ALTER TABLE "support_tickets"
  ADD CONSTRAINT "resolved_ticket_explains_itself"
  CHECK (
    "state" NOT IN ('Resolved', 'Closed')
    OR length(btrim(COALESCE("resolution_note", ''))) > 0
  );

-- Resolution and closure are timestamped when they happen, in both directions.
ALTER TABLE "support_tickets"
  ADD CONSTRAINT "resolved_ticket_records_when"
  CHECK (("state" <> 'Resolved') = ("resolved_at" IS NULL) OR "state" = 'Closed');

ALTER TABLE "support_tickets"
  ADD CONSTRAINT "closed_ticket_records_when"
  CHECK (("state" = 'Closed') = ("closed_at" IS NOT NULL));

-- A ticket reference is a positive number people say out loud.
ALTER TABLE "support_tickets"
  ADD CONSTRAINT "ticket_reference_is_positive"
  CHECK ("reference" >= 1);

-- ===========================================================================
-- A declared incident is complete enough to act on
-- ===========================================================================

-- **Declaration is attributed in all directions.** A severity with no declaration, or a
-- declaration with no severity, is half a record and the System Health screen would have to guess
-- which half to believe.
ALTER TABLE "service_alerts"
  ADD CONSTRAINT "declared_incident_is_attributed"
  CHECK (
    ("incident_severity" IS NULL AND "declared_at" IS NULL AND "declared_by_user_id" IS NULL)
    OR ("incident_severity" IS NOT NULL AND "declared_at" IS NOT NULL
        AND "declared_by_user_id" IS NOT NULL)
  );

-- The three severities §30 names, and no fourth.
ALTER TABLE "service_alerts"
  ADD CONSTRAINT "incident_severity_is_a_p_level"
  CHECK ("incident_severity" IS NULL OR "incident_severity" IN ('P0', 'P1', 'P2'));

-- **Nothing is published to customers without customer wording.**
--
-- The single most important constraint in this migration. A published incident with no
-- `customer_impact` would leave a status page with two options: show nothing, or assemble
-- something out of `summary` and `detail` — which are an operator's internal notes and may name
-- a host, a query or a customer.
ALTER TABLE "service_alerts"
  ADD CONSTRAINT "published_incident_has_customer_wording"
  CHECK (
    "customer_visible" = false
    OR length(btrim(COALESCE("customer_impact", ''))) > 0
  );

-- Only a declared incident is published. An un-declared alert is an internal signal; publishing
-- one would tell customers about something UBoss has not decided is an incident.
ALTER TABLE "service_alerts"
  ADD CONSTRAINT "only_a_declared_incident_is_published"
  CHECK ("customer_visible" = false OR "incident_severity" IS NOT NULL);

-- A mitigation is recorded when it happens, and says what it was.
ALTER TABLE "service_alerts"
  ADD CONSTRAINT "mitigated_incident_says_what_stopped_it"
  CHECK (
    "mitigated_at" IS NULL
    OR length(btrim(COALESCE("mitigation", ''))) > 0
  );

ALTER TABLE "service_alerts"
  ADD CONSTRAINT "mitigation_is_ordered"
  CHECK ("mitigated_at" IS NULL OR "mitigated_at" >= "opened_at");

-- ===========================================================================
-- A support session's customer authorization
-- ===========================================================================

ALTER TABLE "break_glass_requests"
  ADD CONSTRAINT "customer_authorization_state_is_known"
  CHECK ("customer_authorization_state" IN ('NotRequired', 'Pending', 'Authorized', 'Declined'));

-- **A decision is attributed.** "The customer authorized it" with nobody's name against it is the
-- one claim in this record that would be worth forging, so the database refuses it.
ALTER TABLE "break_glass_requests"
  ADD CONSTRAINT "customer_decision_is_attributed"
  CHECK (
    "customer_authorization_state" NOT IN ('Authorized', 'Declined')
    OR ("customer_authorized_by_user_id" IS NOT NULL AND "customer_authorized_at" IS NOT NULL)
  );

-- A decline says why. A refusal nobody explained cannot be answered.
ALTER TABLE "break_glass_requests"
  ADD CONSTRAINT "declined_session_says_why"
  CHECK (
    "customer_authorization_state" <> 'Declined'
    OR length(btrim(COALESCE("customer_authorization_note", ''))) > 0
  );

-- **A session the company declined is never activated.** The service refuses it and so does this:
-- the whole value of the control is that it cannot be worked around by a code path somebody adds
-- later, and there is deliberately no emergency bypass.
ALTER TABLE "break_glass_requests"
  ADD CONSTRAINT "declined_session_is_not_activated"
  CHECK ("customer_authorization_state" <> 'Declined' OR "activated_at" IS NULL);
