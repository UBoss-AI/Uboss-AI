-- CreateTable
CREATE TABLE "credit_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'Submitted',
    "requested_minor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "billing_choice" VARCHAR(30),
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" VARCHAR(1000),
    "approved_minor" INTEGER,
    "effective_from" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "reference" VARCHAR(200),
    "grant_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "credit_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_grants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "source" VARCHAR(30) NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "written_off_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_user_id" UUID,
    "revoke_reason" VARCHAR(500),
    "reason" VARCHAR(500) NOT NULL,
    "reference" VARCHAR(200),
    "credit_request_id" UUID,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "credit_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_credit_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reset_policy" VARCHAR(30) NOT NULL DEFAULT 'MonthlyReset',
    "carry_forward_policy" VARCHAR(30) NOT NULL DEFAULT 'Forfeit',
    "carry_forward_cap_minor" INTEGER,
    "default_top_up_expiry_days" INTEGER,
    "negative_balance_policy" VARCHAR(30) NOT NULL DEFAULT 'BlockImmediately',
    "negative_balance_grace_minor" INTEGER NOT NULL DEFAULT 0,
    "plan_change_policy" VARCHAR(30) NOT NULL DEFAULT 'NextCycle',
    "billing_choice_enabled" BOOLEAN NOT NULL DEFAULT true,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "next_reset_at" TIMESTAMPTZ(6),
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "company_credit_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_requests_tenant_id_state_requested_at_idx" ON "credit_requests"("tenant_id", "state", "requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "credit_requests_tenant_id_id_key" ON "credit_requests"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "credit_grants_tenant_id_wallet_id_effective_from_idx" ON "credit_grants"("tenant_id", "wallet_id", "effective_from");

-- CreateIndex
CREATE INDEX "credit_grants_tenant_id_expires_at_idx" ON "credit_grants"("tenant_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "credit_grants_tenant_id_id_key" ON "credit_grants"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "company_credit_policies_tenant_id_key" ON "company_credit_policies"("tenant_id");

-- AddForeignKey
ALTER TABLE "credit_requests" ADD CONSTRAINT "credit_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_tenant_id_credit_request_id_fkey" FOREIGN KEY ("tenant_id", "credit_request_id") REFERENCES "credit_requests"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_credit_policies" ADD CONSTRAINT "company_credit_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Prompt 31 — credit top-up, reallocation and the commercial edge cases
-- ===========================================================================
--
-- UBoss_Final_1 line 1048 requires these policies to be **defined and auditable** and states no
-- value for any of them. So every commercial term is a column somebody can change, with a
-- default that cannot surprise a customer, and every movement still goes through the Prompt 30
-- ledger — this migration adds no second way to move money.

-- ---------------------------------------------------------------------------
-- 1. Tenant isolation
-- ---------------------------------------------------------------------------

ALTER TABLE "credit_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "credit_requests_tenant_isolation" ON "credit_requests"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "credit_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "credit_grants_tenant_isolation" ON "credit_grants"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "company_credit_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_credit_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "company_credit_policies_tenant_isolation" ON "company_credit_policies"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- ---------------------------------------------------------------------------
-- 2. The closed vocabularies
-- ---------------------------------------------------------------------------

ALTER TABLE "credit_requests"
  ADD CONSTRAINT "credit_request_state_is_known"
  CHECK ("state" IN ('Submitted', 'Approved', 'Rejected', 'Cancelled'));

ALTER TABLE "credit_requests"
  ADD CONSTRAINT "billing_choice_is_known"
  CHECK ("billing_choice" IS NULL
         OR "billing_choice" IN ('AddToInvoice', 'ExistingCommitment', 'Unspecified'));

ALTER TABLE "credit_grants"
  ADD CONSTRAINT "grant_source_is_known"
  CHECK ("source" IN (
    'PlanAllowance', 'TopUp', 'Promotional', 'ManualAdjustment', 'CarryForward', 'PlanChange'
  ));

ALTER TABLE "company_credit_policies"
  ADD CONSTRAINT "reset_policy_is_known"
  CHECK ("reset_policy" IN ('NoReset', 'MonthlyReset'));

ALTER TABLE "company_credit_policies"
  ADD CONSTRAINT "carry_forward_policy_is_known"
  CHECK ("carry_forward_policy" IN ('Forfeit', 'CarryForward', 'CarryForwardCapped'));

ALTER TABLE "company_credit_policies"
  ADD CONSTRAINT "negative_balance_policy_is_known"
  CHECK ("negative_balance_policy" IN ('BlockImmediately', 'AllowGrace'));

ALTER TABLE "company_credit_policies"
  ADD CONSTRAINT "plan_change_policy_is_known"
  CHECK ("plan_change_policy" IN ('ProRate', 'ImmediateFull', 'NextCycle'));

-- ---------------------------------------------------------------------------
-- 3. A request asks for something, and a decision is complete
-- ---------------------------------------------------------------------------

ALTER TABLE "credit_requests"
  ADD CONSTRAINT "a_credit_request_asks_for_something"
  CHECK ("requested_minor" > 0);

ALTER TABLE "credit_requests"
  ADD CONSTRAINT "a_credit_request_states_a_reason"
  CHECK (length(btrim("reason")) > 0);

ALTER TABLE "credit_requests"
  ADD CONSTRAINT "credit_request_currency_is_three_letters"
  CHECK ("currency" ~ '^[A-Z]{3}$');

-- Submitted means undecided; anything else names the operator and the moment. Without this a row
-- could report itself Approved with nobody attached, which is the one thing a credit decision
-- must never be able to say.
ALTER TABLE "credit_requests"
  ADD CONSTRAINT "a_decided_credit_request_names_its_operator"
  CHECK (
    ("state" = 'Submitted' AND "decided_by_user_id" IS NULL AND "decided_at" IS NULL)
    OR ("state" <> 'Submitted' AND "decided_by_user_id" IS NOT NULL AND "decided_at" IS NOT NULL)
  );

-- An approval names an amount and the date the balance becomes effective. "Approved, but we do
-- not know how much or from when" is not an approval.
ALTER TABLE "credit_requests"
  ADD CONSTRAINT "an_approved_request_names_an_amount_and_a_date"
  CHECK (
    ("state" = 'Approved' AND "approved_minor" IS NOT NULL AND "approved_minor" > 0
     AND "effective_from" IS NOT NULL)
    OR ("state" <> 'Approved' AND "approved_minor" IS NULL)
  );

-- A rejection says why. The company cannot act on "no".
ALTER TABLE "credit_requests"
  ADD CONSTRAINT "a_rejected_request_states_a_reason"
  CHECK ("state" <> 'Rejected' OR length(btrim(COALESCE("decision_note", ''))) > 0);

ALTER TABLE "credit_requests"
  ADD CONSTRAINT "approved_credits_do_not_expire_before_they_start"
  CHECK ("expires_at" IS NULL OR "effective_from" IS NULL OR "expires_at" > "effective_from");

-- **A decision is final.** A rejected request that could be re-approved would reverse a decision
-- with no record of the reversal; the company raises a new request instead. Same discipline as
-- the Approval Engine (ADR-139), and a trigger for the same reason: a CHECK sees one row.
CREATE OR REPLACE FUNCTION uboss_credit_request_decided_once()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."state" <> 'Submitted' AND NEW."state" <> OLD."state" THEN
    RAISE EXCEPTION
      'Credit request % is already %. Raise a new request rather than reversing a decision '
      'nobody would see.', OLD."id", OLD."state"
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD."state" <> 'Submitted'
     AND (NEW."approved_minor" IS DISTINCT FROM OLD."approved_minor"
          OR NEW."decided_by_user_id" IS DISTINCT FROM OLD."decided_by_user_id"
          OR NEW."decided_at" IS DISTINCT FROM OLD."decided_at") THEN
    RAISE EXCEPTION
      'Credit request % is decided. How much was approved, by whom and when cannot be '
      'rewritten.', OLD."id"
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "uboss_credit_request_decided_once"
  BEFORE UPDATE ON "credit_requests"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_credit_request_decided_once();

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------

-- A grant of zero would be a row that explains nothing. Negative grants are not a thing either:
-- taking credit away is a revocation or an Adjustment ledger entry, both of which say why.
ALTER TABLE "credit_grants"
  ADD CONSTRAINT "a_grant_is_a_positive_amount"
  CHECK ("amount_minor" > 0);

ALTER TABLE "credit_grants"
  ADD CONSTRAINT "grant_currency_is_three_letters"
  CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "credit_grants"
  ADD CONSTRAINT "a_grant_does_not_expire_before_it_starts"
  CHECK ("expires_at" IS NULL OR "expires_at" > "effective_from");

ALTER TABLE "credit_grants"
  ADD CONSTRAINT "a_grant_states_a_reason"
  CHECK (length(btrim("reason")) > 0);

-- Revocation records both halves: who and why. A grant that vanished with neither is the state
-- that makes a payment-failure investigation impossible.
ALTER TABLE "credit_grants"
  ADD CONSTRAINT "a_revoked_grant_names_who_and_why"
  CHECK (
    ("revoked_at" IS NULL AND "revoked_by_user_id" IS NULL AND "revoke_reason" IS NULL)
    OR ("revoked_at" IS NOT NULL AND "revoked_by_user_id" IS NOT NULL
        AND length(btrim(COALESCE("revoke_reason", ''))) > 0)
  );

-- Only a grant that can expire can be written off as expired.
ALTER TABLE "credit_grants"
  ADD CONSTRAINT "only_an_expiring_grant_is_written_off"
  CHECK ("written_off_at" IS NULL OR "expires_at" IS NOT NULL);

-- One grant per approved request. Two would double the credit an approval granted.
CREATE UNIQUE INDEX "one_grant_per_credit_request"
  ON "credit_grants" ("tenant_id", "credit_request_id")
  WHERE "credit_request_id" IS NOT NULL;

-- The amount a grant is for never changes. Its *life* can — it can be revoked or written off —
-- but a grant whose amount could be edited would move a company's allowance with no ledger entry
-- explaining the movement, which is exactly the drift `reconcile` exists to catch.
CREATE OR REPLACE FUNCTION uboss_grant_amount_is_fixed()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
     OR NEW."source" IS DISTINCT FROM OLD."source" THEN
    RAISE EXCEPTION
      'A credit grant''s amount, currency, source and effective date are fixed. Revoke it and '
      'grant again, so the ledger explains both movements.'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS NULL THEN
    RAISE EXCEPTION
      'A revoked grant cannot be un-revoked. Grant again if the credit is owed.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "uboss_grant_amount_is_fixed"
  BEFORE UPDATE ON "credit_grants"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_grant_amount_is_fixed();

-- ---------------------------------------------------------------------------
-- 5. The commercial policy has to be internally coherent
-- ---------------------------------------------------------------------------
-- Mirrors `validateCreditPolicy`. Each pairing is refused because the alternative is a number
-- nothing reads, which somebody eventually believes is being applied.

ALTER TABLE "company_credit_policies"
  ADD CONSTRAINT "a_cap_belongs_only_to_a_capped_carry_forward"
  CHECK (
    ("carry_forward_policy" = 'CarryForwardCapped' AND "carry_forward_cap_minor" IS NOT NULL
     AND "carry_forward_cap_minor" >= 0)
    OR ("carry_forward_policy" <> 'CarryForwardCapped' AND "carry_forward_cap_minor" IS NULL)
  );

ALTER TABLE "company_credit_policies"
  ADD CONSTRAINT "carry_forward_needs_a_reset_to_carry_across"
  CHECK ("carry_forward_policy" = 'Forfeit' OR "reset_policy" <> 'NoReset');

ALTER TABLE "company_credit_policies"
  ADD CONSTRAINT "a_grace_belongs_only_to_a_tolerant_policy"
  CHECK (
    ("negative_balance_policy" = 'AllowGrace' AND "negative_balance_grace_minor" >= 0)
    OR ("negative_balance_policy" = 'BlockImmediately' AND "negative_balance_grace_minor" = 0)
  );

ALTER TABLE "company_credit_policies"
  ADD CONSTRAINT "a_default_expiry_is_at_least_a_day"
  CHECK ("default_top_up_expiry_days" IS NULL OR "default_top_up_expiry_days" >= 1);

ALTER TABLE "company_credit_policies"
  ADD CONSTRAINT "a_reset_is_after_the_period_started"
  CHECK ("next_reset_at" IS NULL OR "next_reset_at" > "period_start");
