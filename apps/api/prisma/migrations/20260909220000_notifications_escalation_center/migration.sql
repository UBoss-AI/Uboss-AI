-- CreateEnum
CREATE TYPE "notification_kind" AS ENUM ('Invitation', 'ApprovalWaiting', 'Overdue', 'ConnectionExpiry', 'BudgetThreshold', 'SecurityEvent');

-- CreateEnum
CREATE TYPE "notification_severity" AS ENUM ('Info', 'Warning', 'Critical');

-- CreateEnum
CREATE TYPE "notification_digest" AS ENUM ('Off', 'Daily', 'Weekly');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "kind" "notification_kind" NOT NULL,
    "severity" "notification_severity" NOT NULL DEFAULT 'Info',
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "deep_link" VARCHAR(500) NOT NULL,
    "resource_type" VARCHAR(60) NOT NULL,
    "resource_id" VARCHAR(120),
    "is_assigned_to_recipient" BOOLEAN NOT NULL DEFAULT false,
    "is_mandatory" BOOLEAN NOT NULL DEFAULT false,
    "requires_acknowledgement" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMPTZ(6),
    "acknowledged_at" TIMESTAMPTZ(6),
    "dedupe_key" VARCHAR(200) NOT NULL,
    "escalates_at" TIMESTAMPTZ(6),
    "escalated_at" TIMESTAMPTZ(6),
    "escalated_from_id" UUID,
    "email_queued_at" TIMESTAMPTZ(6),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "notification_kind" NOT NULL,
    "in_app_enabled" BOOLEAN NOT NULL DEFAULT true,
    "email_enabled" BOOLEAN NOT NULL DEFAULT true,
    "digest" "notification_digest" NOT NULL DEFAULT 'Off',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_tenant_id_recipient_user_id_occurred_at_idx" ON "notifications"("tenant_id", "recipient_user_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_tenant_id_recipient_user_id_read_at_idx" ON "notifications"("tenant_id", "recipient_user_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_escalates_at_escalated_at_idx" ON "notifications"("escalates_at", "escalated_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_tenant_id_id_key" ON "notifications"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_tenant_id_recipient_user_id_dedupe_key_key" ON "notifications"("tenant_id", "recipient_user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "notification_preferences_tenant_id_user_id_idx" ON "notification_preferences"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_tenant_id_user_id_kind_key" ON "notification_preferences"("tenant_id", "user_id", "kind");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_escalated_from_id_fkey" FOREIGN KEY ("tenant_id", "escalated_from_id") REFERENCES "notifications"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Prompt 15 — hand-written section
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Row-Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "notifications_tenant_isolation" ON "notifications"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_preferences" FORCE ROW LEVEL SECURITY;
CREATE POLICY "notification_preferences_tenant_isolation" ON "notification_preferences"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- ---------------------------------------------------------------------------
-- 2. A mandatory alert cannot be muted
-- ---------------------------------------------------------------------------
-- The client's rule: mandatory security and critical alerts cannot be muted. A service is one
-- missed branch away from breaking that, and "the alert nobody could turn off" is precisely the
-- kind of guarantee that must not depend on remembering.
--
-- `SecurityEvent` is the kind that is *always* mandatory, so it is expressible here. Severity is
-- not on a preference row — preferences are per kind, and a kind carries events of several
-- severities — so the `Critical` half of the rule is enforced by the engine ignoring preferences
-- for a critical event, and by `mandatory_notification_is_marked_mandatory` below making a
-- critical notification's own row say so.

ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "security_notifications_cannot_be_muted"
  CHECK (
    "kind" <> 'SecurityEvent'
    OR ("in_app_enabled" = true AND "email_enabled" = true AND "digest" = 'Off')
  );

-- A critical notification must be marked mandatory and must require acknowledgement. Both are
-- stored on the row rather than derived at read time, so a later change to the mandatory set
-- cannot retroactively make an alert that was delivered as mandatory look optional.
ALTER TABLE "notifications"
  ADD CONSTRAINT "mandatory_notification_is_marked_mandatory"
  CHECK (
    "severity" <> 'Critical'
    OR ("is_mandatory" = true AND "requires_acknowledgement" = true)
  );

-- A security notification is mandatory whatever its severity.
ALTER TABLE "notifications"
  ADD CONSTRAINT "security_notification_is_mandatory"
  CHECK ("kind" <> 'SecurityEvent' OR "is_mandatory" = true);

-- ---------------------------------------------------------------------------
-- 3. State coherence
-- ---------------------------------------------------------------------------

-- Acknowledging implies having seen it. A row acknowledged but unread would make the unread count
-- and the acknowledgement queue disagree, and both are shown on the same screen.
ALTER TABLE "notifications"
  ADD CONSTRAINT "acknowledged_notification_has_been_read"
  CHECK ("acknowledged_at" IS NULL OR "read_at" IS NOT NULL);

ALTER TABLE "notifications"
  ADD CONSTRAINT "acknowledgement_follows_reading"
  CHECK ("acknowledged_at" IS NULL OR "read_at" IS NULL OR "acknowledged_at" >= "read_at");

-- Only something with an escalation deadline can have escalated. Otherwise a row could claim it
-- escalated when nothing was ever waiting for it.
ALTER TABLE "notifications"
  ADD CONSTRAINT "only_escalating_notifications_escalate"
  CHECK ("escalated_at" IS NULL OR "escalates_at" IS NOT NULL);

-- A deep link is the whole point of a notification: "something needs you" with no route to it is
-- worse than silence. Workspace-relative, so it survives a domain change.
ALTER TABLE "notifications"
  ADD CONSTRAINT "notification_deep_link_is_a_relative_path"
  CHECK ("deep_link" LIKE '/%' AND length(btrim("deep_link")) > 1);

ALTER TABLE "notifications"
  ADD CONSTRAINT "notification_says_something"
  CHECK (length(btrim("title")) > 0 AND length(btrim("body")) > 0);

ALTER TABLE "notifications"
  ADD CONSTRAINT "notification_dedupe_key_is_not_blank"
  CHECK (length(btrim("dedupe_key")) > 0);

-- ---------------------------------------------------------------------------
-- 4. An escalation cannot cross companies
-- ---------------------------------------------------------------------------
-- Handled above, by Prisma, from the schema declaration:
--   notifications_tenant_id_id_key                  UNIQUE (tenant_id, id)
--   notifications_tenant_id_escalated_from_id_fkey   FK (tenant_id, escalated_from_id)
--
-- Declared in the datamodel rather than written here, which is the Prompt 12 lesson: Prisma
-- cannot see a hand-written constraint, treats it as drift, and the next migrate dev emits a
-- DROP for it. A tenant-isolation guarantee silently removed by a routine migration is the
-- worst possible way to lose one.

-- ---------------------------------------------------------------------------
-- 5. The record of what somebody was told is append-only in the ways that matter
-- ---------------------------------------------------------------------------
-- `UPDATE` is needed — read, acknowledge and escalate all write to the row — so a blanket revoke
-- is impossible here. `DELETE` is not needed by any code path, and the client requires history,
-- so it is revoked: nobody can make a delivered critical alert disappear.
--
-- The claim is exactly "the application cannot delete a notification", not "the record is
-- tamper-evident": read state and acknowledgement are mutable by design. What must not be
-- rewritable is the *fact* an alert was raised, and the audit trail carries that separately.

REVOKE DELETE ON "notifications" FROM uboss_app;

-- ---------------------------------------------------------------------------
-- 6. New outbox topics
-- ---------------------------------------------------------------------------
-- No schema change: `outbox_messages.topic` is a VARCHAR and `OUTBOX_TOPICS` is the closed set in
-- code. Recorded here because the notification email adapter is the **first consumer of the
-- Prompt 10 outbox**, closing the "no dispatcher exists yet" limitation that repository has
-- carried since. The queue was built and tested independently; the dispatcher is now a consumer
-- of a working queue rather than the two written together and never exercised apart.
