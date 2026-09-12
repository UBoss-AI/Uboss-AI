-- Prompt 9 — the UBoss Master Console, and platform roles that actually guard it.
--
-- Six tables. Five are platform-plane and have no `tenant_id`; one, `tenant_subscriptions`, is
-- tenant-owned and gets Row-Level Security like every other tenant table. Section 1 of the
-- hand-written half explains why the other five get none, because "no RLS here" should be a
-- stated decision rather than something a reviewer notices.
--
--   platform_role_assignments   which platform roles a person holds
--   plans                       commercial plans, seats, entitlements, allowance, price
--   tenant_subscriptions        a company's plan, seats, billing state, renewal, allowance
--   feature_flags               staged rollout, Release & Feature Control
--   platform_settings           global configuration, one row per setting
--   service_alerts              platform service alerts for the dashboard and System Health
--
-- The consequential statement is the **backfill** in section 4. `platformContext` stops granting
-- every platform actor all fifteen modules and starts reading assignments, which is a fail-closed
-- change; without the backfill it would lock every existing platform actor out the moment it
-- deployed. `PlatformAdmin` is deliberately identical to the old blanket grant minus the two
-- global controls, neither of which existed before this prompt.

-- CreateEnum
CREATE TYPE "platform_role_kind" AS ENUM ('PlatformOwner', 'PlatformAdmin', 'PlatformCommercial', 'PlatformSupport', 'PlatformSecurity', 'PlatformEngineer');

-- CreateEnum
CREATE TYPE "plan_tier" AS ENUM ('Starter', 'Growth', 'Enterprise', 'Pilot');

-- CreateEnum
CREATE TYPE "subscription_state" AS ENUM ('Pending', 'Active', 'Suspended', 'Expired', 'Cancelled');

-- CreateEnum
CREATE TYPE "billing_state" AS ENUM ('Current', 'Grace', 'Overdue');

-- CreateEnum
CREATE TYPE "attention_flag" AS ENUM ('None', 'Billing', 'Budget', 'Security', 'Seats', 'Renewal');

-- CreateEnum
CREATE TYPE "feature_stage" AS ENUM ('Dev', 'Staging', 'Uat', 'Prod');

-- CreateEnum
CREATE TYPE "feature_flag_state" AS ENUM ('Paused', 'InReview', 'Active', 'Retired');

-- CreateEnum
CREATE TYPE "service_alert_severity" AS ENUM ('Info', 'Warning', 'Critical');

-- CreateEnum
CREATE TYPE "service_alert_state" AS ENUM ('Open', 'Acknowledged', 'Resolved');

-- CreateTable
CREATE TABLE "platform_role_assignments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "platform_role_kind" NOT NULL,
    "granted_by_user_id" UUID,
    "justification" VARCHAR(500),
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "platform_role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "tier" "plan_tier" NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "seat_limit" INTEGER,
    "entitled_modules" TEXT[],
    "ai_allowance_minor" INTEGER,
    "price_minor" INTEGER,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "state" "subscription_state" NOT NULL DEFAULT 'Pending',
    "billing_state" "billing_state" NOT NULL DEFAULT 'Current',
    "seats_licensed" INTEGER,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renews_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "ai_allowance_minor" INTEGER NOT NULL DEFAULT 0,
    "ai_consumed_minor" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "extra_modules" TEXT[],
    "removed_modules" TEXT[],
    "pinned_flag" "attention_flag" NOT NULL DEFAULT 'None',
    "notes" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tenant_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" UUID NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "description" VARCHAR(500),
    "stage" "feature_stage" NOT NULL DEFAULT 'Dev',
    "state" "feature_flag_state" NOT NULL DEFAULT 'Paused',
    "audience" VARCHAR(120) NOT NULL DEFAULT 'Internal',
    "rollout_percent" INTEGER NOT NULL DEFAULT 0,
    "enabled_tenant_ids" TEXT[],
    "rationale" VARCHAR(1000),
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" UUID NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "value" JSONB NOT NULL,
    "description" VARCHAR(500),
    "section" VARCHAR(60) NOT NULL DEFAULT 'Global defaults',
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_alerts" (
    "id" UUID NOT NULL,
    "service" VARCHAR(80) NOT NULL,
    "severity" "service_alert_severity" NOT NULL DEFAULT 'Warning',
    "state" "service_alert_state" NOT NULL DEFAULT 'Open',
    "summary" VARCHAR(300) NOT NULL,
    "detail" VARCHAR(1000),
    "affected_tenant_id" UUID,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "acknowledged_by_user_id" UUID,
    "resolved_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "service_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_role_assignments_role_idx" ON "platform_role_assignments"("role");

-- CreateIndex
CREATE UNIQUE INDEX "platform_role_assignments_user_id_role_key" ON "platform_role_assignments"("user_id", "role");

-- CreateIndex
CREATE INDEX "plans_active_sort_order_idx" ON "plans"("active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_subscriptions_tenant_id_key" ON "tenant_subscriptions"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_subscriptions_billing_state_renews_at_idx" ON "tenant_subscriptions"("billing_state", "renews_at");

-- CreateIndex
CREATE INDEX "tenant_subscriptions_state_renews_at_idx" ON "tenant_subscriptions"("state", "renews_at");

-- CreateIndex
CREATE INDEX "feature_flags_state_stage_idx" ON "feature_flags"("state", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags"("key");

-- CreateIndex
CREATE INDEX "platform_settings_section_idx" ON "platform_settings"("section");

-- CreateIndex
CREATE UNIQUE INDEX "platform_settings_key_key" ON "platform_settings"("key");

-- CreateIndex
CREATE INDEX "service_alerts_state_severity_opened_at_idx" ON "service_alerts"("state", "severity", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "service_alerts_service_state_idx" ON "service_alerts"("service", "state");

-- AddForeignKey
ALTER TABLE "platform_role_assignments" ADD CONSTRAINT "platform_role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- HAND-WRITTEN ADDITIONS (not generated by `prisma migrate diff`)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Row-Level Security, and the deliberate decision not to apply it
-- ---------------------------------------------------------------------------
-- `tenant_subscriptions` is tenant-owned, so it gets the same fail-closed policy as every other
-- tenant table. A company's plan, seats and billing state are commercially sensitive, and a leak
-- here would tell one customer what another is paying.
ALTER TABLE "tenant_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_subscriptions_tenant_isolation ON "tenant_subscriptions"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

-- The other five tables get **no** RLS policy, and that is a decision rather than an omission:
-- `plans`, `feature_flags`, `platform_settings`, `service_alerts` and
-- `platform_role_assignments` have no `tenant_id`, so there is no tenant to isolate them by. A
-- policy keyed on `app.current_tenant_id` would evaluate to false for every row and make the
-- Master Console unable to read its own tables; one keyed on `app.platform_operation` alone
-- would be a policy that says "allow if you declared you are allowed", which is theatre.
--
-- What protects them instead:
--   * every Master Console controller is `@PlatformOnly`, so a company-plane request cannot
--     reach the routes at all;
--   * the platform-role guards decide which platform module a platform actor may touch;
--   * `platform_role_assignments` is additionally protected by the constraints below, because a
--     row in it *is* somebody's platform authority.
--
-- Recorded in docs/SECURITY_DECISIONS.md S-054 so "these tables have no RLS" is a stated
-- property with a reason, not something discovered during a review.

-- ---------------------------------------------------------------------------
-- 2. A platform role assignment cannot be stored in a nonsensical shape
-- ---------------------------------------------------------------------------
-- Same reasoning as the Prompt 7 gates on company role assignment: the service enforces these,
-- and these make sure the service is not the only thing that does.

-- Nobody grants themselves platform authority. This is the platform-plane version of the Prompt 7
-- rule, and it matters more here: a company admin granting themselves a role affects one company,
-- while a platform role affects every company at once.
ALTER TABLE "platform_role_assignments"
  ADD CONSTRAINT "platform_role_not_self_granted"
  CHECK ("granted_by_user_id" IS NULL OR "granted_by_user_id" <> "user_id");

-- A revoked assignment records who revoked it. "It was revoked and we do not know by whom" is
-- exactly the gap an access review is looking for.
ALTER TABLE "platform_role_assignments"
  ADD CONSTRAINT "platform_role_revocation_is_attributed"
  CHECK (("revoked_at" IS NULL) = ("revoked_by_user_id" IS NULL));

-- ---------------------------------------------------------------------------
-- 3. Commercial and rollout values cannot be nonsense
-- ---------------------------------------------------------------------------
-- Money is stored in minor units as an integer, so these are integer bounds rather than
-- precision rules. A negative price or allowance is not a discount, it is a bug that would
-- silently credit a customer.
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_amounts_are_not_negative"
  CHECK (
    ("price_minor" IS NULL OR "price_minor" >= 0)
    AND ("ai_allowance_minor" IS NULL OR "ai_allowance_minor" >= 0)
    AND ("seat_limit" IS NULL OR "seat_limit" > 0)
  );

ALTER TABLE "plans"
  ADD CONSTRAINT "plans_currency_is_iso4217"
  CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "tenant_subscriptions"
  ADD CONSTRAINT "subscription_amounts_are_not_negative"
  CHECK (
    "ai_allowance_minor" >= 0
    AND "ai_consumed_minor" >= 0
    AND ("seats_licensed" IS NULL OR "seats_licensed" > 0)
  );

-- A term cannot end before it starts.
ALTER TABLE "tenant_subscriptions"
  ADD CONSTRAINT "subscription_term_is_ordered"
  CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");

-- A rollout at 140% would be a silently broken gate rather than an error.
ALTER TABLE "feature_flags"
  ADD CONSTRAINT "feature_flag_rollout_is_a_percentage"
  CHECK ("rollout_percent" BETWEEN 0 AND 100);

-- A `Paused` or `InReview` flag must not carry a live rollout percentage: the state and the
-- percentage would disagree about whether the feature is on, and whichever one the consuming code
-- happened to read would decide.
ALTER TABLE "feature_flags"
  ADD CONSTRAINT "paused_feature_flag_has_no_rollout"
  CHECK ("state" IN ('Active', 'Retired') OR "rollout_percent" = 0);

-- An acknowledged or resolved alert records who did it, for the same reason as a revocation.
ALTER TABLE "service_alerts"
  ADD CONSTRAINT "service_alert_resolution_is_ordered"
  CHECK ("resolved_at" IS NULL OR "resolved_at" >= "opened_at");

ALTER TABLE "service_alerts"
  ADD CONSTRAINT "resolved_service_alert_has_a_resolved_state"
  CHECK (("resolved_at" IS NULL) = ("state" <> 'Resolved'));

-- ---------------------------------------------------------------------------
-- 4. Backfill: every existing platform actor becomes a Platform Admin
-- ---------------------------------------------------------------------------
-- This is the statement that makes the whole change safe to ship.
--
-- From this migration onward, `platformContext` builds its permissions from **assignments**
-- instead of granting every platform actor all fifteen modules. Without a backfill that would be
-- a fail-closed change that locks every existing platform actor — including the seed's and every
-- test's — out of the Master Console the moment it deploys.
--
-- `PlatformAdmin` is chosen because its template is deliberately identical to the old blanket
-- grant minus the two global controls (`release`, `platform-settings`), which no code could have
-- depended on because neither module existed before this prompt. So nothing that worked stops
-- working, and least privilege becomes possible rather than being imposed retroactively.
--
-- `granted_by_user_id` is NULL: there was no granting human, and attributing it to somebody
-- would be a false record in the one table where a false record is a privilege.
INSERT INTO "platform_role_assignments"
  ("id", "user_id", "role", "granted_by_user_id", "justification",
   "created_at", "updated_at", "row_version")
SELECT
  gen_random_uuid(),
  u."id",
  'PlatformAdmin',
  NULL,
  'Backfilled by the Prompt 9 migration: this account already had unrestricted platform access '
    || 'through is_platform_actor, and PlatformAdmin preserves exactly that. Review and narrow.',
  NOW(), NOW(), 1
FROM "users" u
WHERE u."is_platform_actor" = true
  AND NOT EXISTS (
    SELECT 1 FROM "platform_role_assignments" a
    WHERE a."user_id" = u."id" AND a."role" = 'PlatformAdmin'
  );

-- ---------------------------------------------------------------------------
-- 5. Seed the plans, the platform settings and one flag
-- ---------------------------------------------------------------------------
-- Seeded by the migration rather than by `prisma/seed.ts`, for the same reason as the Prompt 7
-- separation-of-duties baseline: a Master Console with an empty plan table cannot provision a
-- company, and a platform that has never run the seed must still be in a usable state. The seed
-- adds demo *companies*; these are product configuration.
--
-- Idempotent, so re-running the migration chain on a database that already has them is safe.

INSERT INTO "plans"
  ("id", "code", "tier", "name", "description", "seat_limit", "entitled_modules",
   "ai_allowance_minor", "price_minor", "currency", "active", "sort_order",
   "created_at", "updated_at", "row_version")
VALUES
  (gen_random_uuid(), 'starter', 'Starter', 'Starter',
   'Map and optimise. For a first team.', 10,
   ARRAY['dashboard','hierarchy','objective','todo','profile-search','settings'],
   20000, 49000, 'USD', true, 10, NOW(), NOW(), 1),
  (gen_random_uuid(), 'growth', 'Growth', 'Growth',
   'Adds building and operating Engine Agents.', 40,
   ARRAY['dashboard','hierarchy','objective','agent-builder','todo','agents','executor',
         'approvals','reports','users','profile-search','settings'],
   100000, 190000, 'USD', true, 20, NOW(), NOW(), 1),
  (gen_random_uuid(), 'enterprise', 'Enterprise', 'Enterprise',
   'Every module including governance. Seats and allowance negotiated.', NULL,
   ARRAY['dashboard','hierarchy','objective','agent-builder','todo','agents','executor',
         'approvals','performance','reports','users','roles','profile-search','settings'],
   NULL, NULL, 'USD', true, 30, NOW(), NOW(), 1),
  (gen_random_uuid(), 'pilot', 'Pilot', 'Pilot',
   'A time-boxed evaluation. Converts to a paid plan or expires.', 25,
   ARRAY['dashboard','hierarchy','objective','todo','settings'],
   10000, 0, 'USD', true, 5, NOW(), NOW(), 1)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "platform_settings"
  ("id", "key", "value", "description", "section", "locked",
   "created_at", "updated_at", "row_version")
VALUES
  (gen_random_uuid(), 'provisioning.default_plan_code', '"growth"'::jsonb,
   'The plan pre-selected when a new company is provisioned.', 'Global defaults', false,
   NOW(), NOW(), 1),
  (gen_random_uuid(), 'provisioning.default_timezone', '"Asia/Kolkata"'::jsonb,
   'The default region and timezone for a new company.', 'Global defaults', false,
   NOW(), NOW(), 1),
  (gen_random_uuid(), 'provisioning.default_currency', '"USD"'::jsonb,
   'The billing currency a new company starts on.', 'Global defaults', false,
   NOW(), NOW(), 1),
  -- Locked: this is a client requirement, not a preference. The reference UI states it as a
  -- fixed value too ("Master Console only (no public signup)"), and the API refuses to change a
  -- locked setting rather than offering a control that silently does nothing.
  (gen_random_uuid(), 'governance.company_creation', '"master_console_only"'::jsonb,
   'How a company can come into existence. There is no public company signup.',
   'Governance', true, NOW(), NOW(), 1),
  (gen_random_uuid(), 'governance.data_residency', '"per_tenant"'::jsonb,
   'Where a company''s data is stored.', 'Governance', false, NOW(), NOW(), 1),
  -- Locked for the same reason: the client's Aadhaar constraint is a product rule.
  (gen_random_uuid(), 'governance.aadhaar_handling', '"internal_matching_only"'::jsonb,
   'Aadhaar is entered for internal person matching only. UBoss does not perform Aadhaar '
     || 'authentication or claim verified Aadhaar status.',
   'Governance', true, NOW(), NOW(), 1),
  (gen_random_uuid(), 'security.require_mfa_for_platform_actors', 'true'::jsonb,
   'Whether platform staff must hold a second factor. Enforced by the identity policy.',
   'Governance', false, NOW(), NOW(), 1),
  (gen_random_uuid(), 'support.break_glass_max_minutes', '480'::jsonb,
   'The longest break-glass window an approver may grant.', 'Governance', false,
   NOW(), NOW(), 1)
ON CONFLICT ("key") DO NOTHING;

-- One flag, so the Release & Feature Control screen is not empty on a fresh install, and so the
-- "a paused flag has no rollout" constraint has something real behind it.
INSERT INTO "feature_flags"
  ("id", "key", "description", "stage", "state", "audience", "rollout_percent",
   "enabled_tenant_ids", "rationale", "created_at", "updated_at", "row_version")
VALUES
  (gen_random_uuid(), 'master-console-v1',
   'The Master Console itself, so its own rollout is visible in the tool it ships with.',
   'Prod', 'Active', 'Internal', 100, ARRAY[]::text[],
   'Retire once the console is unconditional. Kept so the first flag in the table is a real one.',
   NOW(), NOW(), 1)
ON CONFLICT ("key") DO NOTHING;
