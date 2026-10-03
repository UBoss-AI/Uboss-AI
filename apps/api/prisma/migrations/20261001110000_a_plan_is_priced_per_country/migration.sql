-- A plan can be priced in more than one currency, because a company is billed in its own.
--
-- ## What was wrong
--
-- `plans` carries one `price_minor` and one `currency`. Every company therefore sees the same
-- figure in the same currency, whatever country it is in — so an Indian customer was shown a
-- dollar price, and the alternative somebody reaches for is to convert it, which is worse: a rate
-- this product invented produces a number the invoice will not match, and the customer discovers
-- that after paying.
--
-- ## The rule this implements
--
-- A company's currency follows its country and is then **fixed** (`currency_for_country` in the
-- shared types). The country decides the default when the company is created; after that
-- `tenants.currency` is the truth and nothing re-derives it. Re-deriving would change the meaning
-- of every minor-unit integer already stored against that company — its wallet, its ledger, its
-- invoices — the day somebody corrected its country.
--
-- ## Why a table and not more columns
--
-- `price_minor_inr`, `price_minor_usd`, `price_minor_eur` would mean a migration for every new
-- market and a query that names each one. A row per currency means adding a market is inserting
-- a row, which a platform administrator can do from the console.
--
-- ## Why the plan keeps its own price
--
-- `plans.price_minor` and `plans.currency` stay exactly as they are, as the plan's base price.
-- Everything already reads them — the console, the provisioning service, the published Stripe
-- price — and breaking that to prove a point would be a large change with no benefit. The base is
-- seeded into this table below so there is one list to read, and the two cannot disagree for a
-- currency that appears in both because the base is where its row came from.

CREATE TABLE "plan_prices" (
  "id"      UUID NOT NULL,
  "plan_id" UUID NOT NULL,

  -- ISO 4217, and one of `BILLING_CURRENCIES`. The check is the list, so a currency nobody has
  -- agreed terms for cannot reach the column.
  "currency" VARCHAR(3) NOT NULL,

  -- Minor units, integer. Never a float: a rounding difference here is an invoice dispute.
  "price_minor" INTEGER NOT NULL,

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "plan_price_is_not_negative" CHECK ("price_minor" >= 0),

  CONSTRAINT "plan_price_currency_is_sold"
    CHECK ("currency" IN ('INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD'))
);

-- One price per plan per currency. Two would be a plan with two answers to "what does this cost",
-- and the one that reached the customer would be whichever the query happened to return first.
CREATE UNIQUE INDEX "plan_prices_plan_id_currency_key"
  ON "plan_prices" ("plan_id", "currency");

ALTER TABLE "plan_prices"
  ADD CONSTRAINT "plan_prices_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Platform-owned, like `plans` itself: a plan's price is a decision UBoss makes, not a company.
-- No row-level security, for the same reason `plans` has none — every company may read the
-- catalogue, and none may write it.
GRANT SELECT, INSERT, UPDATE, DELETE ON "plan_prices" TO "uboss_app";

-- Seed each existing plan's own price as its row, so there is one list to read from the start.
-- Plans with a negotiated price (null) seed nothing, which is correct: they have no figure.
INSERT INTO "plan_prices" ("id", "plan_id", "currency", "price_minor")
SELECT gen_random_uuid(), "id", "currency", "price_minor"
  FROM "plans"
 WHERE "price_minor" IS NOT NULL
   AND "currency" IN ('INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD')
ON CONFLICT DO NOTHING;
