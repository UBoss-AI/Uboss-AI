-- What a recurring allowance grants each period.
--
-- `allowance_minor` cannot answer this. It is cumulative — every grant adds to it and `used_minor`
-- is never zeroed, because used is derived from an immutable ledger and zeroing it would report
-- drift against `reconcile` for as long as the company existed. So after one reset a wallet
-- granted 500 a day holds an allowance of 1,000, and nothing on the row remembers the 500.
--
-- Required whenever a cadence is set, and meaningless without one.
ALTER TABLE "budget_wallets"
  ADD COLUMN "recurring_grant_minor" INTEGER;

ALTER TABLE "budget_wallets"
  ADD CONSTRAINT "a_cadence_needs_an_amount"
  CHECK ("reset_cadence" = 'None' OR ("recurring_grant_minor" IS NOT NULL AND "recurring_grant_minor" > 0));

-- The sweep reads exactly this: what is due, and nothing else.
CREATE INDEX "budget_wallets_due_for_reset_idx"
  ON "budget_wallets" ("resets_at")
  WHERE "reset_cadence" <> 'None';
