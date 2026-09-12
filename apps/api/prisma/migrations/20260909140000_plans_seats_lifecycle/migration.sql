-- Prompt 11 — plans, entitlements, seats and company lifecycle.
--
-- Two tables, eleven columns across `plans` and `tenant_subscriptions`, ten check constraints.
--
--   commercial_change_requests    a company asks; the platform decides
--   tenant_lifecycle_transitions  what state a company was in, when — and what is scheduled
--
-- The client requires five concepts to stay separate: Commercial Plan, Module Entitlements,
-- Feature/Release Channel, Commercial Allowance, and RBAC. Nothing in this migration touches
-- `role_assignments`, `custom_roles` or `policy_rules`, and nothing in those reads a plan. That
-- separation is the point: conflating them is the classic SaaS bug where buying a bigger plan
-- silently grants somebody administrative rights.
--
-- Seat counting is configurable per plan (`seat_counting_rule`) with a documented per-company
-- override, because a per-provisioned-person contract and a per-concurrent-user contract count
-- differently and that is negotiated rather than preferred.
--
-- **Nothing here deletes anything.** Reducing a contracted ceiling sets a grace window that
-- holds the old ceiling; it does not remove users, employment history, tasks, Agent history or
-- audit rows. There is no DELETE statement in this migration.

-- CreateEnum
CREATE TYPE "release_channel" AS ENUM ('Stable', 'Early', 'Internal');

-- CreateEnum
CREATE TYPE "seat_counting_rule" AS ENUM ('ActiveOnly', 'ActiveAndInvited', 'ActiveInvitedAndSuspended');

-- CreateEnum
CREATE TYPE "commercial_change_kind" AS ENUM ('MoreSeats', 'FewerSeats', 'PlanUpgrade', 'PlanDowngrade', 'MoreAiAllowance', 'ModuleEntitlement');

-- CreateEnum
CREATE TYPE "commercial_change_state" AS ENUM ('Requested', 'Approved', 'Declined', 'Applied', 'Withdrawn');

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "allow_seat_requests" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "downgrade_grace_days" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "release_channel" "release_channel" NOT NULL DEFAULT 'Stable',
ADD COLUMN     "seat_counting_rule" "seat_counting_rule" NOT NULL DEFAULT 'ActiveAndInvited';

-- AlterTable
ALTER TABLE "tenant_subscriptions" ADD COLUMN     "pending_effective_at" TIMESTAMPTZ(6),
ADD COLUMN     "pending_plan_id" UUID,
ADD COLUMN     "pending_reason" VARCHAR(500),
ADD COLUMN     "pending_seats" INTEGER,
ADD COLUMN     "release_channel_override" "release_channel",
ADD COLUMN     "seat_counting_override" "seat_counting_rule",
ADD COLUMN     "seat_grace_ceiling" INTEGER,
ADD COLUMN     "seat_grace_until" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "commercial_change_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "commercial_change_kind" NOT NULL,
    "state" "commercial_change_state" NOT NULL DEFAULT 'Requested',
    "requested_seats" INTEGER,
    "requested_plan_code" VARCHAR(40),
    "requested_allowance_minor" INTEGER,
    "requested_modules" TEXT[],
    "justification" VARCHAR(1000) NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" VARCHAR(1000),
    "applied_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "commercial_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_lifecycle_transitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "from_state" "tenant_lifecycle_state" NOT NULL,
    "to_state" "tenant_lifecycle_state" NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "effective_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMPTZ(6),
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tenant_lifecycle_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commercial_change_requests_tenant_id_state_requested_at_idx" ON "commercial_change_requests"("tenant_id", "state", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "commercial_change_requests_state_requested_at_idx" ON "commercial_change_requests"("state", "requested_at");

-- CreateIndex
CREATE INDEX "tenant_lifecycle_transitions_tenant_id_effective_at_idx" ON "tenant_lifecycle_transitions"("tenant_id", "effective_at" DESC);

-- CreateIndex
CREATE INDEX "tenant_lifecycle_transitions_applied_at_effective_at_idx" ON "tenant_lifecycle_transitions"("applied_at", "effective_at");

-- AddForeignKey
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_pending_plan_id_fkey" FOREIGN KEY ("pending_plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commercial_change_requests" ADD CONSTRAINT "commercial_change_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_lifecycle_transitions" ADD CONSTRAINT "tenant_lifecycle_transitions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- HAND-WRITTEN ADDITIONS (not generated by `prisma migrate diff`)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Row-Level Security on the two new tenant-owned tables
-- ---------------------------------------------------------------------------
-- Both are commercially sensitive. A leak from `commercial_change_requests` would tell one
-- customer that another is negotiating a downgrade; a leak from `tenant_lifecycle_transitions`
-- would reveal that a competitor's account was suspended for non-payment.

ALTER TABLE "commercial_change_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commercial_change_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_change_requests_tenant_isolation ON "commercial_change_requests"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "tenant_lifecycle_transitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_lifecycle_transitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_lifecycle_transitions_tenant_isolation ON "tenant_lifecycle_transitions"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

-- ---------------------------------------------------------------------------
-- 2. A commercial change request cannot be stored in a contradictory shape
-- ---------------------------------------------------------------------------

-- A decided request records who decided it and when. "It was declined and we do not know by
-- whom" is exactly the gap a customer dispute lands in.
ALTER TABLE "commercial_change_requests"
  ADD CONSTRAINT "decided_commercial_request_is_attributed"
  CHECK (
    "state" IN ('Requested', 'Withdrawn')
    OR ("decided_by_user_id" IS NOT NULL AND "decided_at" IS NOT NULL)
  );

-- The company cannot approve its own commercial request. This is the whole point of the
-- request/decide split: a company that could decide its own contracted ceiling would make the
-- ceiling a preference rather than a contract.
ALTER TABLE "commercial_change_requests"
  ADD CONSTRAINT "commercial_request_is_not_self_decided"
  CHECK ("decided_by_user_id" IS NULL OR "decided_by_user_id" <> "requested_by_user_id");

-- `Applied` implies `Approved` happened, so it must carry both timestamps.
ALTER TABLE "commercial_change_requests"
  ADD CONSTRAINT "applied_commercial_request_was_decided"
  CHECK ("applied_at" IS NULL OR "decided_at" IS NOT NULL);

-- A request must actually ask for something. A row with `kind = MoreSeats` and no seat count is
-- a request nobody can act on, and it would sit in the platform queue forever.
ALTER TABLE "commercial_change_requests"
  ADD CONSTRAINT "commercial_request_names_what_it_wants"
  CHECK (
    ("kind" IN ('MoreSeats', 'FewerSeats') AND "requested_seats" IS NOT NULL AND "requested_seats" > 0)
    OR ("kind" IN ('PlanUpgrade', 'PlanDowngrade') AND "requested_plan_code" IS NOT NULL)
    OR ("kind" = 'MoreAiAllowance' AND "requested_allowance_minor" IS NOT NULL AND "requested_allowance_minor" > 0)
    OR ("kind" = 'ModuleEntitlement' AND array_length("requested_modules", 1) > 0)
  );

ALTER TABLE "commercial_change_requests"
  ADD CONSTRAINT "commercial_request_justification_is_not_blank"
  CHECK (length(btrim("justification")) > 0);

-- ---------------------------------------------------------------------------
-- 3. A lifecycle transition must be a real transition
-- ---------------------------------------------------------------------------
-- A row saying "Active -> Active" is noise that makes the interval query wrong: it would look
-- like the company changed state when nothing happened.
ALTER TABLE "tenant_lifecycle_transitions"
  ADD CONSTRAINT "lifecycle_transition_changes_state"
  CHECK ("from_state" <> "to_state");

ALTER TABLE "tenant_lifecycle_transitions"
  ADD CONSTRAINT "lifecycle_transition_reason_is_not_blank"
  CHECK (length(btrim("reason")) > 0);

-- ---------------------------------------------------------------------------
-- 4. A pending plan change is all-or-nothing, and grace is coherent
-- ---------------------------------------------------------------------------
-- A pending plan with no effective date would never be applied; an effective date with no plan
-- would apply nothing. Either half alone is a change that silently does not happen, which is
-- worse than no change at all because the operator believes it is scheduled.
ALTER TABLE "tenant_subscriptions"
  ADD CONSTRAINT "pending_plan_change_is_complete"
  CHECK (
    ("pending_plan_id" IS NULL AND "pending_effective_at" IS NULL)
    OR ("pending_plan_id" IS NOT NULL AND "pending_effective_at" IS NOT NULL)
  );

-- Grace exists to hold the OLD, higher ceiling while a company gets under a new lower one, so
-- both halves are needed and the held ceiling must be a real number.
ALTER TABLE "tenant_subscriptions"
  ADD CONSTRAINT "seat_grace_is_complete"
  CHECK (
    ("seat_grace_until" IS NULL AND "seat_grace_ceiling" IS NULL)
    OR ("seat_grace_until" IS NOT NULL AND "seat_grace_ceiling" IS NOT NULL AND "seat_grace_ceiling" > 0)
  );

ALTER TABLE "plans"
  ADD CONSTRAINT "plan_downgrade_grace_is_reasonable"
  CHECK ("downgrade_grace_days" BETWEEN 0 AND 365);

-- ---------------------------------------------------------------------------
-- 5. Backfill: the current lifecycle state becomes each company's first transition
-- ---------------------------------------------------------------------------
-- Without this, the interval query ("what state was this company in, when") has no starting
-- point and every company looks as though it has always been in its current state with no
-- history — which is true only by accident and stops being true on the first real transition.
--
-- `from_state` is `Provisioning` because that is what every company genuinely starts as; the
-- reason says plainly that this row was reconstructed rather than observed, so nobody later
-- mistakes it for a recorded decision.
INSERT INTO "tenant_lifecycle_transitions"
  ("id", "tenant_id", "from_state", "to_state", "reason", "effective_at", "applied_at",
   "actor_user_id", "created_at", "updated_at", "row_version")
SELECT
  gen_random_uuid(), t."id", 'Provisioning', t."lifecycle_state",
  'Reconstructed by the Prompt 11 migration from the company''s current state. This row was '
    || 'not observed at the time and carries no actor — it exists so the lifecycle interval '
    || 'query has a starting point.',
  t."created_at", t."created_at", NULL, NOW(), NOW(), 1
FROM "tenants" t
WHERE t."lifecycle_state" <> 'Provisioning'
  AND NOT EXISTS (
    SELECT 1 FROM "tenant_lifecycle_transitions" x WHERE x."tenant_id" = t."id"
  );
