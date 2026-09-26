-- Stripe billing: the provider's names for a plan, a company's customer and subscription,
-- the invoices it issues, and the deliveries it sends us.
--
-- Additive only (expand). Every column added here is nullable and every table is new, so this
-- migration is a no-op for anything already running and rolls back by dropping what it adds.
--
-- Three unrelated drifts between this database and the schema were deliberately NOT included:
-- a DROP INDEX on sso_auth_requests, a CREATE INDEX on invitations, and a rename of
-- one_pack_per_company. They predate this work, and policy rule 6 keeps a destructive step from
-- riding along unnoticed with an additive one. They need their own migration and their own review.

-- ---------------------------------------------------------------------------
-- A plan, as the payment provider knows it
-- ---------------------------------------------------------------------------

ALTER TABLE "plans"
  ADD COLUMN "stripe_product_id"            VARCHAR(80),
  ADD COLUMN "stripe_monthly_price_id"      VARCHAR(80),
  ADD COLUMN "stripe_annual_price_id"       VARCHAR(80),
  ADD COLUMN "stripe_published_price_minor" INTEGER,
  ADD COLUMN "stripe_published_at"          TIMESTAMPTZ(6);

-- ---------------------------------------------------------------------------
-- A company's customer and subscription at the provider
-- ---------------------------------------------------------------------------

ALTER TABLE "tenant_subscriptions"
  ADD COLUMN "stripe_customer_id"        VARCHAR(80),
  ADD COLUMN "stripe_subscription_id"    VARCHAR(80),
  ADD COLUMN "stripe_status"             VARCHAR(40),
  ADD COLUMN "stripe_current_period_end" TIMESTAMPTZ(6),
  ADD COLUMN "stripe_synced_at"          TIMESTAMPTZ(6);

-- Unique, because a second customer for the same company splits its invoices and its saved
-- payment methods across two records nobody can reconcile afterwards.
CREATE UNIQUE INDEX "tenant_subscriptions_stripe_customer_id_key"
  ON "tenant_subscriptions" ("stripe_customer_id");

CREATE UNIQUE INDEX "tenant_subscriptions_stripe_subscription_id_key"
  ON "tenant_subscriptions" ("stripe_subscription_id");

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------

CREATE TABLE "billing_invoices" (
  "id"                 UUID         NOT NULL,
  "tenant_id"          UUID         NOT NULL,
  "stripe_invoice_id"  VARCHAR(80)  NOT NULL,
  "number"             VARCHAR(60),
  "status"             VARCHAR(30)  NOT NULL,
  "amount_due_minor"   INTEGER      NOT NULL,
  "amount_paid_minor"  INTEGER      NOT NULL,
  "currency"           VARCHAR(3)   NOT NULL,
  "period_start"       TIMESTAMPTZ(6),
  "period_end"         TIMESTAMPTZ(6),
  "paid_at"            TIMESTAMPTZ(6),
  "due_at"             TIMESTAMPTZ(6),
  "hosted_invoice_url" VARCHAR(1000),
  "invoice_pdf_url"    VARCHAR(1000),
  "last_payment_error" VARCHAR(500),
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "billing_invoices_pkey" PRIMARY KEY ("id")
);

-- The provider's id is what makes ingestion idempotent: the same invoice arriving twice on two
-- webhook deliveries updates one row rather than creating two.
CREATE UNIQUE INDEX "billing_invoices_stripe_invoice_id_key"
  ON "billing_invoices" ("stripe_invoice_id");

CREATE INDEX "billing_invoices_tenant_id_created_at_idx"
  ON "billing_invoices" ("tenant_id", "created_at" DESC);

CREATE INDEX "billing_invoices_tenant_id_status_idx"
  ON "billing_invoices" ("tenant_id", "status");

ALTER TABLE "billing_invoices"
  ADD CONSTRAINT "billing_invoices_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- An invoice belongs to one company and must never be readable by another. Same policy shape as
-- every other tenant-owned table: the company's own rows, or a declared platform operation.
ALTER TABLE "billing_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_invoices" FORCE ROW LEVEL SECURITY;

CREATE POLICY "billing_invoices_tenant_isolation" ON "billing_invoices"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

-- ---------------------------------------------------------------------------
-- Webhook deliveries
-- ---------------------------------------------------------------------------
--
-- Platform-owned and therefore not RLS-isolated: one delivery can concern any company, the id
-- space is the provider's, and it is read by support rather than by a company. `tenant_id` is here
-- to say which company it resolved to, not to decide who may see it.

CREATE TABLE "stripe_webhook_events" (
  "id"           VARCHAR(80)    NOT NULL,
  "type"         VARCHAR(80)    NOT NULL,
  "livemode"     BOOLEAN        NOT NULL DEFAULT false,
  "occurred_at"  TIMESTAMPTZ(6) NOT NULL,
  "received_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ(6),
  "tenant_id"    UUID,
  "outcome"      VARCHAR(20),
  "detail"       VARCHAR(500),

  CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stripe_webhook_events_type_occurred_at_idx"
  ON "stripe_webhook_events" ("type", "occurred_at" DESC);

CREATE INDEX "stripe_webhook_events_tenant_id_occurred_at_idx"
  ON "stripe_webhook_events" ("tenant_id", "occurred_at" DESC);
