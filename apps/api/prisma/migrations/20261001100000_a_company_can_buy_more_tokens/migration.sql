-- A company can buy more UBoss Tokens when its monthly allowance runs out.
--
-- ## Why one-off purchases need a table at all
--
-- A webhook says "this payment succeeded". Nothing in it says what the company was *told* they
-- were buying. The number of tokens is quoted on the screen they agreed to, and if it is not
-- written down before the browser leaves, the only surviving record of the offer is the one the
-- provider hands back afterwards -- which is how a company ends up credited with a different
-- number from the one it accepted.
--
-- ## Why `credit_grant_id` is the idempotency and not `status`
--
-- `status` says what the provider reports. `credit_grant_id` says whether this product has
-- already moved credit into the wallet, and a retried delivery has to be stopped by the second,
-- not the first. A row that is Paid with no grant is a payment taken and not yet credited, which
-- is precisely the thing somebody needs to be able to find and fix.
--
-- ## Why the rate is stored on the row
--
-- `commercial.uboss_token_minor_units` can be changed by the platform. A purchase quoted at one
-- rate and credited at another would be this product charging for one thing and delivering
-- another, and the only way to prove which rate applied is to keep the one that was quoted.

CREATE TABLE "token_purchases" (
  "id"        UUID NOT NULL,
  "tenant_id" UUID NOT NULL,

  -- The provider's Checkout session, and the payment that settled it.
  "provider_session_ref" VARCHAR(255) NOT NULL,
  "provider_payment_ref" VARCHAR(255),

  -- What was quoted, before the browser left. All three, because all three were on the screen.
  "tokens"              INTEGER    NOT NULL,
  "amount_minor"        INTEGER    NOT NULL,
  "currency"            VARCHAR(3) NOT NULL,
  "token_minor_units"   INTEGER    NOT NULL,

  -- From `TOKEN_PURCHASE_STATUSES`: Pending, Paid, Failed, Abandoned.
  "status" VARCHAR(20) NOT NULL,

  -- Who bought it. A webhook has no actor of its own, and a credit grant with no actor is one
  -- nobody asked for as far as the audit trail is concerned.
  "requested_by_user_id" UUID NOT NULL,

  -- Set when the wallet was actually credited. See the note above.
  "credit_grant_id" UUID,

  "failure_reason" VARCHAR(500),

  -- The provider's hosted page, so a company that closed the tab can be sent back to it.
  "checkout_url" VARCHAR(1000),

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paid_at"    TIMESTAMPTZ(6),

  CONSTRAINT "token_purchases_pkey" PRIMARY KEY ("id"),

  -- A purchase of nothing, or of a negative number of tokens, is not a purchase.
  CONSTRAINT "token_purchase_buys_something"
    CHECK ("amount_minor" > 0 AND "tokens" > 0 AND "token_minor_units" > 0),

  -- The quote has to be arithmetic somebody can check: the amount is the tokens at the rate that
  -- was quoted. A row where these disagree is a purchase whose price nobody can account for.
  CONSTRAINT "token_purchase_quote_adds_up"
    CHECK ("amount_minor" = "tokens" * "token_minor_units")
);

CREATE UNIQUE INDEX "token_purchases_provider_session_ref_key"
  ON "token_purchases" ("provider_session_ref");

CREATE INDEX "token_purchases_tenant_id_created_at_idx"
  ON "token_purchases" ("tenant_id", "created_at" DESC);

-- "Paid, but never credited" — the query somebody runs when a company says its tokens never
-- arrived. Partial, because that is the only state worth sweeping for.
CREATE INDEX "token_purchases_awaiting_credit_idx"
  ON "token_purchases" ("created_at")
  WHERE "status" = 'Paid' AND "credit_grant_id" IS NULL;

ALTER TABLE "token_purchases"
  ADD CONSTRAINT "token_purchases_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A company's purchases are its own. Same policy shape as every other tenant-owned table.
ALTER TABLE "token_purchases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "token_purchases" FORCE ROW LEVEL SECURITY;

CREATE POLICY "token_purchases_tenant_isolation" ON "token_purchases"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "token_purchases" TO "uboss_app";
