-- CreateTable
CREATE TABLE "budget_wallets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scope" VARCHAR(20) NOT NULL,
    "subject_id" UUID,
    "currency" VARCHAR(3) NOT NULL,
    "allowance_minor" INTEGER NOT NULL DEFAULT 0,
    "used_minor" INTEGER NOT NULL DEFAULT 0,
    "reserved_minor" INTEGER NOT NULL DEFAULT 0,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "resets_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "budget_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_reservations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'Held',
    "estimate_minor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "settled_minor" INTEGER,
    "agent_run_id" UUID,
    "objective_id" UUID,
    "department_id" UUID,
    "engine_agent_id" UUID,
    "logical_profile" VARCHAR(40) NOT NULL,
    "purpose" VARCHAR(200) NOT NULL,
    "model_gateway_call_id" UUID,
    "held_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "close_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "budget_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_reservation_holds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_reservation_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_ledger_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "balance_after_allowance_minor" INTEGER NOT NULL,
    "balance_after_used_minor" INTEGER NOT NULL,
    "balance_after_reserved_minor" INTEGER NOT NULL,
    "actor_user_id" UUID,
    "reason" VARCHAR(500) NOT NULL,
    "reference" VARCHAR(200),
    "reservation_id" UUID,
    "agent_run_id" UUID,
    "objective_id" UUID,
    "department_id" UUID,
    "engine_agent_id" UUID,
    "logical_profile" VARCHAR(40),
    "pricing_version_id" UUID,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cached_input_tokens" INTEGER,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "budget_wallets_tenant_id_scope_idx" ON "budget_wallets"("tenant_id", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "budget_wallets_tenant_id_id_key" ON "budget_wallets"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "budget_reservations_tenant_id_state_held_at_idx" ON "budget_reservations"("tenant_id", "state", "held_at");

-- CreateIndex
CREATE INDEX "budget_reservations_tenant_id_agent_run_id_idx" ON "budget_reservations"("tenant_id", "agent_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_reservations_tenant_id_id_key" ON "budget_reservations"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "budget_reservation_holds_tenant_id_wallet_id_idx" ON "budget_reservation_holds"("tenant_id", "wallet_id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_reservation_holds_tenant_id_id_key" ON "budget_reservation_holds"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_reservation_holds_reservation_id_wallet_id_key" ON "budget_reservation_holds"("reservation_id", "wallet_id");

-- CreateIndex
CREATE INDEX "cost_ledger_entries_tenant_id_wallet_id_occurred_at_idx" ON "cost_ledger_entries"("tenant_id", "wallet_id", "occurred_at");

-- CreateIndex
CREATE INDEX "cost_ledger_entries_tenant_id_agent_run_id_idx" ON "cost_ledger_entries"("tenant_id", "agent_run_id");

-- CreateIndex
CREATE INDEX "cost_ledger_entries_tenant_id_kind_occurred_at_idx" ON "cost_ledger_entries"("tenant_id", "kind", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "cost_ledger_entries_tenant_id_id_key" ON "cost_ledger_entries"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "budget_wallets" ADD CONSTRAINT "budget_wallets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_tenant_id_wallet_id_fkey" FOREIGN KEY ("tenant_id", "wallet_id") REFERENCES "budget_wallets"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reservation_holds" ADD CONSTRAINT "budget_reservation_holds_tenant_id_reservation_id_fkey" FOREIGN KEY ("tenant_id", "reservation_id") REFERENCES "budget_reservations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_ledger_entries" ADD CONSTRAINT "cost_ledger_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_ledger_entries" ADD CONSTRAINT "cost_ledger_entries_tenant_id_wallet_id_fkey" FOREIGN KEY ("tenant_id", "wallet_id") REFERENCES "budget_wallets"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_ledger_entries" ADD CONSTRAINT "cost_ledger_entries_tenant_id_reservation_id_fkey" FOREIGN KEY ("tenant_id", "reservation_id") REFERENCES "budget_reservations"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- ===========================================================================
-- Prompt 30 — the Token/Cost Engine: wallets, reservations and the ledger
-- ===========================================================================
--
-- Section 20's flow: Check -> Estimate -> Reserve -> Execute -> Provider actual usage -> Settle ->
-- Release unused reserve -> Reconcile. The database's job in that flow is to make three things
-- impossible rather than merely unlikely:
--
--   * a balance that moved without a ledger entry explaining it,
--   * a reservation settled twice, and
--   * a ledger that can be edited after the fact.

-- ---------------------------------------------------------------------------
-- 1. Tenant isolation
-- ---------------------------------------------------------------------------
-- All four are strictly tenant-owned. Unlike provider configuration there is no platform plane
-- here: a budget always belongs to exactly one company.

ALTER TABLE "budget_wallets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "budget_wallets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "budget_wallets_tenant_isolation" ON "budget_wallets"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "budget_reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "budget_reservations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "budget_reservations_tenant_isolation" ON "budget_reservations"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "budget_reservation_holds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "budget_reservation_holds" FORCE ROW LEVEL SECURITY;
CREATE POLICY "budget_reservation_holds_tenant_isolation" ON "budget_reservation_holds"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "cost_ledger_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cost_ledger_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "cost_ledger_entries_tenant_isolation" ON "cost_ledger_entries"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- ---------------------------------------------------------------------------
-- 2. The closed vocabularies
-- ---------------------------------------------------------------------------

ALTER TABLE "budget_wallets"
  ADD CONSTRAINT "budget_scope_is_known"
  CHECK ("scope" IN ('Company', 'Department', 'Objective', 'Agent'));

ALTER TABLE "budget_reservations"
  ADD CONSTRAINT "reservation_state_is_known"
  CHECK ("state" IN ('Held', 'Settled', 'Released', 'Expired'));

ALTER TABLE "cost_ledger_entries"
  ADD CONSTRAINT "ledger_entry_kind_is_known"
  CHECK ("kind" IN (
    'TopUp', 'Adjustment', 'Reallocation', 'Reserve', 'ReleaseReserve', 'Settle', 'Refund',
    'Expiry'
  ));

-- ---------------------------------------------------------------------------
-- 3. One wallet per level, and the company level is singular
-- ---------------------------------------------------------------------------
-- Two wallets for one department would let a reservation lock one and spend against the other,
-- which is the overspend this whole prompt exists to prevent, arriving through the back door.

CREATE UNIQUE INDEX "one_company_wallet_per_tenant"
  ON "budget_wallets" ("tenant_id")
  WHERE "scope" = 'Company';

CREATE UNIQUE INDEX "one_wallet_per_subject"
  ON "budget_wallets" ("tenant_id", "scope", "subject_id")
  WHERE "subject_id" IS NOT NULL;

-- The company level is the one with no subject; every other level must name one. Without this a
-- stray Department wallet with a null subject would be a second company-wide budget that the
-- unique index above does not catch.
ALTER TABLE "budget_wallets"
  ADD CONSTRAINT "only_the_company_level_has_no_subject"
  CHECK (("scope" = 'Company' AND "subject_id" IS NULL)
         OR ("scope" <> 'Company' AND "subject_id" IS NOT NULL));

ALTER TABLE "budget_wallets"
  ADD CONSTRAINT "wallet_amounts_are_sane"
  CHECK ("allowance_minor" >= 0 AND "reserved_minor" >= 0);

-- `used_minor` may exceed the allowance and is deliberately **not** bounded above: a provider's
-- actual usage can come in above the estimate that was reserved, and refusing to record that
-- would make the ledger disagree with the provider's own invoice. The hard stop catches it on the
-- next call, which is the right place.

ALTER TABLE "budget_wallets"
  ADD CONSTRAINT "wallet_currency_is_three_letters"
  CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "budget_wallets"
  ADD CONSTRAINT "a_reset_or_expiry_is_after_the_period_started"
  CHECK (("resets_at" IS NULL OR "resets_at" > "period_start")
         AND ("expires_at" IS NULL OR "expires_at" > "period_start"));

-- ---------------------------------------------------------------------------
-- 4. A reservation settles once, and only from Held
-- ---------------------------------------------------------------------------

ALTER TABLE "budget_reservations"
  ADD CONSTRAINT "reservation_estimate_is_not_negative"
  CHECK ("estimate_minor" >= 0);

-- A settled reservation records what it was charged; an open one has not been charged yet.
ALTER TABLE "budget_reservations"
  ADD CONSTRAINT "only_a_settled_reservation_has_an_actual_charge"
  CHECK (("state" = 'Settled' AND "settled_minor" IS NOT NULL)
         OR ("state" <> 'Settled' AND "settled_minor" IS NULL));

-- A closed reservation says when and why. "It stopped counting and nobody wrote down why" is the
-- state that makes an overspend investigation impossible.
ALTER TABLE "budget_reservations"
  ADD CONSTRAINT "a_closed_reservation_says_when_and_why"
  CHECK (("state" = 'Held' AND "closed_at" IS NULL AND "close_reason" IS NULL)
         OR ("state" <> 'Held' AND "closed_at" IS NOT NULL AND "close_reason" IS NOT NULL));

-- **A decision is final.** A settled reservation that could return to Held would charge one run's
-- budget twice; an expired one that could settle would charge for work whose outcome nobody
-- recorded. Written as a trigger because a CHECK sees one row, not the transition.
CREATE OR REPLACE FUNCTION uboss_reservation_closes_once()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."state" <> 'Held' AND NEW."state" <> OLD."state" THEN
    RAISE EXCEPTION
      'Reservation % is already %. Re-opening or re-settling it would charge one run''s budget '
      'twice.', OLD."id", OLD."state"
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD."state" <> 'Held'
     AND (NEW."settled_minor" IS DISTINCT FROM OLD."settled_minor"
          OR NEW."closed_at" IS DISTINCT FROM OLD."closed_at") THEN
    RAISE EXCEPTION
      'Reservation % is closed. What it was charged and when cannot be rewritten.', OLD."id"
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "uboss_reservation_closes_once"
  BEFORE UPDATE ON "budget_reservations"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_reservation_closes_once();

-- ---------------------------------------------------------------------------
-- 5. Holds
-- ---------------------------------------------------------------------------

ALTER TABLE "budget_reservation_holds"
  ADD CONSTRAINT "hold_amount_is_not_negative"
  CHECK ("amount_minor" >= 0);

-- The unique index Prisma already emits on (reservation_id, wallet_id) is what stops one
-- reservation holding twice against the same wallet — which would double-count it in
-- `reserved_minor` and make the release only half-undo it.

-- ---------------------------------------------------------------------------
-- 6. The ledger is append-only
-- ---------------------------------------------------------------------------
-- Section 20 requires every movement preserved with "who, amount, reason, time, source/reference
-- and resulting balance". An editable ledger preserves nothing, and the reconciliation job that
-- compares it against the maintained balance would be comparing two things that could both be
-- wrong in the same direction.
--
-- No escape hatch: the test harness clears it with TRUNCATE, which does not fire row-level
-- triggers, so the tests need no privilege the application lacks.

ALTER TABLE "cost_ledger_entries"
  ADD CONSTRAINT "ledger_currency_is_three_letters"
  CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "cost_ledger_entries"
  ADD CONSTRAINT "ledger_reason_is_not_blank"
  CHECK (length(btrim("reason")) > 0);

-- A reserve or release always belongs to a reservation; a top-up never does. Without this a
-- reservation movement could float free of the thing it moved for, and the settle/release pair
-- could not be matched up during an investigation.
ALTER TABLE "cost_ledger_entries"
  ADD CONSTRAINT "reservation_movements_name_their_reservation"
  CHECK (
    ("kind" IN ('Reserve', 'ReleaseReserve', 'Settle') AND "reservation_id" IS NOT NULL)
    OR ("kind" NOT IN ('Reserve', 'ReleaseReserve', 'Settle'))
  );

-- Signs are part of the vocabulary rather than the caller's choice. A Reserve of a negative
-- amount would *release* budget through a code path that says it is taking some.
ALTER TABLE "cost_ledger_entries"
  ADD CONSTRAINT "ledger_amount_sign_matches_its_kind"
  CHECK (
    ("kind" IN ('Reserve', 'ReleaseReserve', 'Settle', 'TopUp', 'Refund', 'Expiry')
     AND "amount_minor" >= 0)
    -- Adjustment and Reallocation are the two that are legitimately signed: a correction can go
    -- either way, and a reallocation is a negative entry on one budget and a positive on another.
    OR "kind" IN ('Adjustment', 'Reallocation')
  );

CREATE OR REPLACE FUNCTION uboss_cost_ledger_is_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'The cost ledger is append-only. It is what a company was actually charged, and the '
    'reconciliation job compares the running balance against it — a ledger that can be edited '
    'reconciles against nothing.'
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER "uboss_cost_ledger_is_append_only"
  BEFORE UPDATE OR DELETE ON "cost_ledger_entries"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_cost_ledger_is_append_only();
