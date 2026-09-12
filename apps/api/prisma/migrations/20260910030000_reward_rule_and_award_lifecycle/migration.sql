-- CreateEnum
CREATE TYPE "reward_award_status_kind" AS ENUM ('Draft', 'Assigned', 'Completed', 'Eligible', 'Approved', 'Rejected', 'Settled', 'Recorded');

-- AlterTable
ALTER TABLE "performance_policies" ADD COLUMN     "reward_points_reach_performance" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "reward_awards" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "objective_reward_id" UUID NOT NULL,
    "objective_id" UUID NOT NULL,
    "subject_user_id" UUID NOT NULL,
    "status" "reward_award_status_kind" NOT NULL DEFAULT 'Draft',
    "reward_type" "objective_reward_type_kind" NOT NULL,
    "amount_minor_units" INTEGER,
    "eligibility_condition" VARCHAR(2000) NOT NULL,
    "completion_deadline" DATE,
    "approver_user_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6),
    "assigned_by_user_id" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "completed_by_user_id" UUID,
    "eligible_at" TIMESTAMPTZ(6),
    "eligible_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decided_by_user_id" UUID,
    "decision_reason" VARCHAR(2000),
    "settled_at" TIMESTAMPTZ(6),
    "settled_by_user_id" UUID,
    "payout_reference" VARCHAR(200),
    "payout_was_real" BOOLEAN NOT NULL DEFAULT false,
    "performance_event_id" UUID,
    "performance_note" VARCHAR(500),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "reward_awards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reward_awards_tenant_id_status_idx" ON "reward_awards"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "reward_awards_tenant_id_subject_user_id_status_idx" ON "reward_awards"("tenant_id", "subject_user_id", "status");

-- CreateIndex
CREATE INDEX "reward_awards_tenant_id_objective_id_idx" ON "reward_awards"("tenant_id", "objective_id");

-- CreateIndex
CREATE INDEX "reward_awards_tenant_id_objective_reward_id_idx" ON "reward_awards"("tenant_id", "objective_reward_id");

-- CreateIndex
CREATE UNIQUE INDEX "objective_rewards_tenant_id_id_key" ON "objective_rewards"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "reward_awards" ADD CONSTRAINT "reward_awards_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_awards" ADD CONSTRAINT "reward_awards_tenant_id_objective_reward_id_fkey" FOREIGN KEY ("tenant_id", "objective_reward_id") REFERENCES "objective_rewards"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_awards" ADD CONSTRAINT "reward_awards_tenant_id_objective_id_fkey" FOREIGN KEY ("tenant_id", "objective_id") REFERENCES "objectives"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Prompt 19A — reward awards: the half Prisma cannot express
-- ===========================================================================
-- The client's two hard rules here are "do not auto-pay cash" and "link approved
-- points/achievement to performance only through policy". Neither is expressible as a column
-- type, and both are enforced below as well as in the service.

-- ---------------------------------------------------------------------------
-- 1. Tenant isolation
-- ---------------------------------------------------------------------------

ALTER TABLE "reward_awards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reward_awards" FORCE ROW LEVEL SECURITY;
CREATE POLICY "reward_awards_tenant_isolation" ON "reward_awards"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- ---------------------------------------------------------------------------
-- 2. The promise is a promise
-- ---------------------------------------------------------------------------

ALTER TABLE "reward_awards"
  ADD CONSTRAINT "award_condition_is_not_blank"
  CHECK (length(btrim("eligibility_condition")) > 0);

ALTER TABLE "reward_awards"
  ADD CONSTRAINT "award_amount_is_not_negative"
  CHECK ("amount_minor_units" IS NULL OR "amount_minor_units" >= 0);

-- Cash and Points are the quantified kinds. An award of either with no amount is a promise
-- nobody can settle.
ALTER TABLE "reward_awards"
  ADD CONSTRAINT "quantified_award_has_an_amount"
  CHECK ("reward_type" NOT IN ('Cash', 'Points') OR "amount_minor_units" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 3. Every step in the chain is attributed
-- ---------------------------------------------------------------------------
-- A reward lifecycle with anonymous steps is one nobody can be held to. Each pair is checked in
-- both directions: a timestamp without an actor, and an actor without a timestamp, are both
-- half-written records.

ALTER TABLE "reward_awards"
  ADD CONSTRAINT "award_assignment_is_attributed"
  CHECK (("assigned_at" IS NULL) = ("assigned_by_user_id" IS NULL));

ALTER TABLE "reward_awards"
  ADD CONSTRAINT "award_completion_is_attributed"
  CHECK (("completed_at" IS NULL) = ("completed_by_user_id" IS NULL));

ALTER TABLE "reward_awards"
  ADD CONSTRAINT "award_eligibility_is_attributed"
  CHECK (("eligible_at" IS NULL) = ("eligible_by_user_id" IS NULL));

ALTER TABLE "reward_awards"
  ADD CONSTRAINT "award_decision_is_attributed"
  CHECK (("decided_at" IS NULL) = ("decided_by_user_id" IS NULL));

ALTER TABLE "reward_awards"
  ADD CONSTRAINT "award_settlement_is_attributed"
  CHECK (("settled_at" IS NULL) = ("settled_by_user_id" IS NULL));

-- A status implies its own step happened. Without these a row could claim to be Approved with no
-- decision recorded, which is the state that makes the trail useless.
-- NOTE: this constraint is too strict and is corrected by the next migration
-- (`20260910030500_reward_award_rejection_before_assignment`). It is left exactly as applied
-- because an applied migration is append-only; the correction explains itself.
ALTER TABLE "reward_awards"
  ADD CONSTRAINT "assigned_award_records_when"
  CHECK ("status" = 'Draft' OR "assigned_at" IS NOT NULL);

ALTER TABLE "reward_awards"
  ADD CONSTRAINT "decided_award_records_its_decision"
  CHECK ("status" NOT IN ('Approved', 'Rejected', 'Settled', 'Recorded') OR "decided_at" IS NOT NULL);

-- A rejection says why. An unexplained refusal of somebody's bonus is the one that is disputed.
ALTER TABLE "reward_awards"
  ADD CONSTRAINT "rejected_award_has_a_reason"
  CHECK ("status" <> 'Rejected' OR length(btrim(COALESCE("decision_reason", ''))) > 0);

-- ---------------------------------------------------------------------------
-- 4. Do not auto-pay cash
-- ---------------------------------------------------------------------------
-- The rule, as constraints. Three separate things have to be true and each is refused
-- independently, because "no auto-pay" failing quietly is worse than it failing loudly.

-- Only a Cash award can reach `Settled`. Points and Recognition end in `Recorded`.
ALTER TABLE "reward_awards"
  ADD CONSTRAINT "only_cash_is_settled"
  CHECK ("status" <> 'Settled' OR "reward_type" = 'Cash');

-- A settlement has a provider reference. "We paid it" with nothing to check against is not a
-- record of a payment.
ALTER TABLE "reward_awards"
  ADD CONSTRAINT "settled_award_has_a_provider_reference"
  CHECK (
    "status" <> 'Settled'
    OR (length(btrim(COALESCE("payout_reference", ''))) > 0 AND "settled_at" IS NOT NULL)
  );

-- **Four eyes on the money.** The person who approved an award may not be the person who pays it
-- out. This is the client's high-risk control applied where it matters most, and it is here
-- rather than only in the service because a service is one missed branch away from losing it.
ALTER TABLE "reward_awards"
  ADD CONSTRAINT "settlement_needs_a_second_person"
  CHECK (
    "settled_by_user_id" IS NULL
    OR "decided_by_user_id" IS NULL
    OR "settled_by_user_id" <> "decided_by_user_id"
  );

-- Nothing that is not Settled may claim a payout, real or otherwise. Without this a Rejected
-- award could carry a reference and a `payout_was_real` of true.
ALTER TABLE "reward_awards"
  ADD CONSTRAINT "unsettled_award_claims_no_payout"
  CHECK ("status" = 'Settled' OR ("payout_reference" IS NULL AND "payout_was_real" IS NOT TRUE));

-- ---------------------------------------------------------------------------
-- 5. Points reach performance only through policy
-- ---------------------------------------------------------------------------
-- A performance event may only be attached to an award that was actually approved and recorded,
-- and only to a Points award. A Cash settlement must never move somebody's score — being paid is
-- not a performance outcome.

ALTER TABLE "reward_awards"
  ADD CONSTRAINT "only_recorded_points_touch_performance"
  CHECK (
    "performance_event_id" IS NULL
    OR ("status" = 'Recorded' AND "reward_type" = 'Points')
  );

-- When a Points award records no performance event, the absence is explained. Otherwise a policy
-- refusal is indistinguishable from a bug.
ALTER TABLE "reward_awards"
  ADD CONSTRAINT "unscored_points_award_explains_itself"
  CHECK (
    "status" <> 'Recorded'
    OR "reward_type" <> 'Points'
    OR "performance_event_id" IS NOT NULL
    OR length(btrim(COALESCE("performance_note", ''))) > 0
  );

-- ---------------------------------------------------------------------------
-- 6. One live claim per person per rule
-- ---------------------------------------------------------------------------
-- Two open awards for one person under one rule would make "what is this person owed" ambiguous,
-- and would be the shape of a double payment. A *terminal* award must not block a later one: a
-- rejected claim can legitimately be re-raised, and a second bonus in a later period is normal.

CREATE UNIQUE INDEX "one_open_award_per_person_per_rule"
  ON "reward_awards" ("tenant_id", "objective_reward_id", "subject_user_id")
  WHERE "status" NOT IN ('Rejected', 'Settled', 'Recorded');

-- ---------------------------------------------------------------------------
-- 7. A terminal award is frozen, and the snapshot never moves
-- ---------------------------------------------------------------------------
-- Two separate protections in one trigger, because both are about the same thing — what was
-- promised and what happened must stay what they were:
--
--   * **The snapshot is immutable from assignment onwards.** Reading the terms through the rule
--     would let somebody raise the amount or soften the condition after the work was done, and
--     the trail would show the new terms as though they had always been the terms.
--   * **A terminal award cannot change at all.** An un-settled award could be paid twice; an
--     un-rejected one would let a refused claim quietly reappear. A mistake is corrected with a
--     new award and a reason, not by rewriting history.

CREATE OR REPLACE FUNCTION uboss_reward_award_is_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" IN ('Rejected', 'Settled', 'Recorded') THEN
    RAISE EXCEPTION
      'Reward award % is % and cannot be changed. Correct a mistake with a new award and a '
      'reason; never by rewriting one that has been settled, recorded or refused.',
      OLD."id", OLD."status"
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD."status" <> 'Draft'
     AND (
       NEW."reward_type" IS DISTINCT FROM OLD."reward_type"
       OR NEW."amount_minor_units" IS DISTINCT FROM OLD."amount_minor_units"
       OR NEW."eligibility_condition" IS DISTINCT FROM OLD."eligibility_condition"
       OR NEW."completion_deadline" IS DISTINCT FROM OLD."completion_deadline"
       OR NEW."approver_user_id" IS DISTINCT FROM OLD."approver_user_id"
       OR NEW."subject_user_id" IS DISTINCT FROM OLD."subject_user_id"
       OR NEW."objective_reward_id" IS DISTINCT FROM OLD."objective_reward_id"
     )
  THEN
    RAISE EXCEPTION
      'Reward award % has been assigned, so what it promises cannot change. The terms are '
      'snapshotted at assignment on purpose.',
      OLD."id"
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "reward_award_terms_and_endings_are_immutable"
  BEFORE UPDATE ON "reward_awards"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_reward_award_is_immutable();
