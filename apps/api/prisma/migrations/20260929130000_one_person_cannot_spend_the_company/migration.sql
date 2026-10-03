-- A per-person AI allowance.
--
-- Every budget scope before this one describes *work* — a department, an objective, an agent —
-- and none of them is keyed to a human being. So the company budget was the only thing between
-- one employee and the whole month's AI: somebody running an agent in a loop could exhaust it in
-- an afternoon, and every other person in the company would then be refused for something they
-- did not do.
--
-- A wallet that does not exist places no limit, so this constrains nobody until an administrator
-- sets an allowance on somebody. Adding the scope is what makes setting one possible.
--
-- `one_wallet_per_subject` already covers (tenant, scope, subject) and needs no change: a person
-- is a subject like any other.
ALTER TABLE "budget_wallets" DROP CONSTRAINT "budget_scope_is_known";

ALTER TABLE "budget_wallets"
  ADD CONSTRAINT "budget_scope_is_known"
  CHECK ("scope"::text = ANY (ARRAY[
    'Company'::varchar, 'Department'::varchar, 'Person'::varchar,
    'Objective'::varchar, 'Agent'::varchar
  ]::text[]));

-- How often this wallet's allowance comes back.
--
-- `resets_at` already existed and is a single instant: it says *when* the next reset is and
-- nothing about what happens after it, so a wallet that reset once never reset again. A per-person
-- daily allowance is the case that makes the difference obvious — it is not one reset tomorrow,
-- it is one every day.
--
-- `None` for a wallet that is topped up deliberately rather than on a clock, which is what every
-- existing wallet is. No behaviour changes for any row already here.
ALTER TABLE "budget_wallets"
  ADD COLUMN "reset_cadence" VARCHAR(20) NOT NULL DEFAULT 'None';

ALTER TABLE "budget_wallets"
  ADD CONSTRAINT "reset_cadence_is_known"
  CHECK ("reset_cadence"::text = ANY (ARRAY[
    'None'::varchar, 'Daily'::varchar, 'Weekly'::varchar, 'Monthly'::varchar
  ]::text[]));

-- A cadence has to say when the first one falls due, or nothing can act on it.
ALTER TABLE "budget_wallets"
  ADD CONSTRAINT "a_cadence_needs_a_next_reset"
  CHECK ("reset_cadence" = 'None' OR "resets_at" IS NOT NULL);
