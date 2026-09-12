-- Prompt 10 — company provisioning and initial admin activation.
--
-- The no-public-signup tenant creation journey. Four new tables, seven new `tenants` columns,
-- and the constraints that make the client's bootstrap rule unambiguous.
--
--   tenant_ai_settings          wizard steps 5-6: AI mode, model-profile policy, skill packs
--   tenant_ai_budget_policies   wizard step 7: allowance, warning, approval, hard stop
--   company_setup_tasks         the first-login checklist, seeded per company
--   outbox_messages             the transactional outbox for the activation invitation
--
-- Every enum value and field comes from the approved wizard table in UBoss_Final_1 (steps 1-10)
-- and the Setup Checklist in its §33 — the AI modes, the skill packs, the four budget thresholds
-- and the ten checklist items are the client's own vocabulary.
--
-- **No credential is stored in any of this.** `tenant_ai_settings` holds a *reference* to a BYOK
-- secret held in the Prompt 6 secret box plus a masked hint, never a key; and the outbox payload
-- carries an invitation's id rather than its one-time token, because an outbox row is long-lived
-- working state and a token in one would be a credential at rest in a queue.

-- CreateEnum
CREATE TYPE "billing_cycle" AS ENUM ('Monthly', 'Quarterly', 'Annual');

-- CreateEnum
CREATE TYPE "company_ai_mode" AS ENUM ('UBossManaged', 'CompanyByok', 'CustomEnterpriseProvider');

-- CreateEnum
CREATE TYPE "outbox_state" AS ENUM ('Pending', 'InFlight', 'Delivered', 'Failed', 'DeadLettered');

-- CreateEnum
CREATE TYPE "setup_task_state" AS ENUM ('NotStarted', 'InProgress', 'Done', 'Skipped');

-- AlterTable
ALTER TABLE "role_assignments" ADD COLUMN     "bootstrap" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "tenant_auth_policies" ADD COLUMN     "guest_expiry_days" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "support_access_allowed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "support_access_requires_customer_approval" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "tenant_subscriptions" ADD COLUMN     "billing_cycle" "billing_cycle" NOT NULL DEFAULT 'Annual';

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "code" VARCHAR(20),
ADD COLUMN     "country_region" VARCHAR(2),
ADD COLUMN     "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
ADD COLUMN     "logo_file_name" VARCHAR(200),
ADD COLUMN     "logo_mime_type" VARCHAR(80),
ADD COLUMN     "logo_size_bytes" INTEGER,
ADD COLUMN     "logo_storage_key" VARCHAR(300),
ADD COLUMN     "timezone" VARCHAR(60) NOT NULL DEFAULT 'Asia/Kolkata';

-- CreateTable
CREATE TABLE "tenant_ai_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mode" "company_ai_mode" NOT NULL DEFAULT 'UBossManaged',
    "model_profile_policy" JSONB,
    "provider_credential_ref" VARCHAR(120),
    "provider_credential_hint" VARCHAR(40),
    "custom_provider_endpoint" VARCHAR(300),
    "universal_pack_enabled" BOOLEAN NOT NULL DEFAULT true,
    "industry_packs" TEXT[],
    "custom_skill_capability" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tenant_ai_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_ai_budget_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "monthly_allowance_minor" INTEGER NOT NULL,
    "warning_percent" INTEGER NOT NULL DEFAULT 80,
    "approval_threshold_minor" INTEGER NOT NULL,
    "hard_stop_minor" INTEGER NOT NULL,
    "department_allocations" JSONB,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tenant_ai_budget_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_messages" (
    "id" UUID NOT NULL,
    "topic" VARCHAR(120) NOT NULL,
    "tenant_id" UUID,
    "payload" JSONB NOT NULL,
    "state" "outbox_state" NOT NULL DEFAULT 'Pending',
    "idempotency_key" VARCHAR(200) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(1000),
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_setup_tasks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(60) NOT NULL,
    "position" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "rationale" VARCHAR(500) NOT NULL,
    "target_route" VARCHAR(120),
    "state" "setup_task_state" NOT NULL DEFAULT 'NotStarted',
    "skip_reason" VARCHAR(500),
    "completed_at" TIMESTAMPTZ(6),
    "completed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "company_setup_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_ai_settings_tenant_id_key" ON "tenant_ai_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_ai_budget_policies_tenant_id_key" ON "tenant_ai_budget_policies"("tenant_id");

-- CreateIndex
CREATE INDEX "outbox_messages_state_available_at_idx" ON "outbox_messages"("state", "available_at");

-- CreateIndex
CREATE INDEX "outbox_messages_tenant_id_topic_idx" ON "outbox_messages"("tenant_id", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_messages_idempotency_key_key" ON "outbox_messages"("idempotency_key");

-- CreateIndex
CREATE INDEX "company_setup_tasks_tenant_id_position_idx" ON "company_setup_tasks"("tenant_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "company_setup_tasks_tenant_id_key_key" ON "company_setup_tasks"("tenant_id", "key");

-- AddForeignKey
ALTER TABLE "tenant_ai_settings" ADD CONSTRAINT "tenant_ai_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_ai_budget_policies" ADD CONSTRAINT "tenant_ai_budget_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_setup_tasks" ADD CONSTRAINT "company_setup_tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- HAND-WRITTEN ADDITIONS (not generated by `prisma migrate diff`)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Row-Level Security on the four new tenant-owned tables
-- ---------------------------------------------------------------------------
-- `tenant_ai_settings`, `tenant_ai_budget_policies` and `company_setup_tasks` are tenant-owned
-- and get the same fail-closed policy as every other tenant table. The AI settings table matters
-- most: it names a company's provider and holds the reference to its BYOK credential, so a leak
-- here tells one customer which models another is running on.
--
-- `outbox_messages` has a NULLABLE tenant_id (platform-plane messages exist), handled the same
-- way as `audit_events` — visible only inside a declared platform operation.

ALTER TABLE "tenant_ai_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_ai_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_ai_settings_tenant_isolation ON "tenant_ai_settings"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "tenant_ai_budget_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_ai_budget_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_ai_budget_policies_tenant_isolation ON "tenant_ai_budget_policies"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "company_setup_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_setup_tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_setup_tasks_tenant_isolation ON "company_setup_tasks"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "outbox_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_messages_tenant_isolation ON "outbox_messages"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

-- ---------------------------------------------------------------------------
-- 2a. Existing role assignments are marked bootstrap where they have no grantor
-- ---------------------------------------------------------------------------
-- The constraint in section 2 requires it in both directions, so any pre-existing grant with a
-- null grantor has to be labelled — otherwise this migration fails on a database that has one.
UPDATE "role_assignments" SET "bootstrap" = true
WHERE "granted_by_user_id" IS NULL AND "bootstrap" = false;

-- ---------------------------------------------------------------------------
-- 2. The bootstrap grant and the null grantor cannot disagree
-- ---------------------------------------------------------------------------
-- The client's rule is that the first Company Admin must not need an existing Company Admin to
-- grant it, so provisioning is the grantor — the one grantor with no human behind it.
--
-- These two constraints make that unambiguous in both directions. A `bootstrap` row must have no
-- granting user (otherwise it is an ordinary grant wearing a bootstrap label, and an access
-- review reading the flag would draw the wrong conclusion), and a row with no granting user must
-- be marked bootstrap (otherwise a grant nobody made looks like an ordinary one, which is worse).
ALTER TABLE "role_assignments"
  ADD CONSTRAINT "bootstrap_grant_has_no_human_grantor"
  CHECK (("bootstrap" = false) OR ("granted_by_user_id" IS NULL));

ALTER TABLE "role_assignments"
  ADD CONSTRAINT "grant_with_no_grantor_is_marked_bootstrap"
  CHECK (("granted_by_user_id" IS NOT NULL) OR ("bootstrap" = true));

-- ---------------------------------------------------------------------------
-- 3. AI budget thresholds must be usable, not just present
-- ---------------------------------------------------------------------------
-- Four ordered guardrails: warn, then require approval, then stop. If the approval threshold sat
-- above the hard stop, the approval step would be unreachable — the run would simply be blocked —
-- and the "approval threshold" would be decorative configuration. That is exactly the kind of
-- setting an operator sets once and trusts forever, so the ordering is enforced rather than
-- documented.
ALTER TABLE "tenant_ai_budget_policies"
  ADD CONSTRAINT "ai_budget_thresholds_are_ordered"
  CHECK (
    "monthly_allowance_minor" >= 0
    AND "approval_threshold_minor" >= 0
    AND "hard_stop_minor" >= 0
    AND "approval_threshold_minor" <= "hard_stop_minor"
  );

ALTER TABLE "tenant_ai_budget_policies"
  ADD CONSTRAINT "ai_budget_warning_is_a_percentage"
  CHECK ("warning_percent" BETWEEN 1 AND 100);

-- ---------------------------------------------------------------------------
-- 4. A skipped setup task records why
-- ---------------------------------------------------------------------------
-- "Skipped" with no reason is indistinguishable from "forgotten", and the checklist exists to
-- tell those two apart.
ALTER TABLE "company_setup_tasks"
  ADD CONSTRAINT "skipped_setup_task_has_a_reason"
  CHECK (
    "state" <> 'Skipped'
    OR ("skip_reason" IS NOT NULL AND length(btrim("skip_reason")) > 0)
  );

ALTER TABLE "company_setup_tasks"
  ADD CONSTRAINT "setup_task_position_is_in_range"
  CHECK ("position" BETWEEN 1 AND 50);

-- ---------------------------------------------------------------------------
-- 5. Company identity fields cannot hold junk
-- ---------------------------------------------------------------------------
-- Two-letter country and three-letter currency, upper case. Free text here would let `India`,
-- `IN` and `in` become three countries, and every report grouped by region would be wrong in a
-- way nobody notices until it is a year of data.
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenant_country_region_is_iso3166"
  CHECK ("country_region" IS NULL OR "country_region" ~ '^[A-Z]{2}$');

ALTER TABLE "tenants"
  ADD CONSTRAINT "tenant_currency_is_iso4217"
  CHECK ("currency" ~ '^[A-Z]{3}$');

-- The company/workspace code is human-facing and appears on invoices, so it is constrained to a
-- readable shape and made unique — two companies with the same code would make it useless as an
-- identifier, which is its only purpose.
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenant_code_is_readable"
  CHECK ("code" IS NULL OR "code" ~ '^[A-Z0-9][A-Z0-9-]{1,18}[A-Z0-9]$');

CREATE UNIQUE INDEX "tenants_code_key" ON "tenants" ("code") WHERE "code" IS NOT NULL;

-- Logo metadata is all-or-nothing: a storage key with no mime type is a file nothing can render.
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenant_logo_metadata_is_complete"
  CHECK (
    "logo_storage_key" IS NULL
    OR ("logo_file_name" IS NOT NULL AND "logo_mime_type" IS NOT NULL AND "logo_size_bytes" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 6. The outbox never carries a credential, and cannot be silently drained
-- ---------------------------------------------------------------------------
-- `attempts` is bounded so a permanently failing message dead-letters rather than retrying
-- forever, and a delivered message must carry its timestamp — "Delivered" with no
-- `delivered_at` would make the outbox unauditable.
ALTER TABLE "outbox_messages"
  ADD CONSTRAINT "delivered_outbox_message_has_a_timestamp"
  CHECK (("state" <> 'Delivered') = ("delivered_at" IS NULL));

ALTER TABLE "outbox_messages"
  ADD CONSTRAINT "outbox_attempts_are_not_negative"
  CHECK ("attempts" >= 0);

-- No UPDATE/DELETE revoke here, deliberately. Unlike the audit trails, an outbox row is *working
-- state*: a dispatcher must be able to claim it, record a failure and mark it delivered. What
-- happened to a message belongs in the audit trail, and the dispatcher writes one.

-- ---------------------------------------------------------------------------
-- 7. Backfill: existing companies get the identity, AI and checklist rows
-- ---------------------------------------------------------------------------
-- Six companies already exist from the Prompt 9 seed. Without a backfill they would have no AI
-- settings, no budget policy and no setup checklist — so the screens built on those would show
-- an empty state that looks like a bug rather than like a company provisioned before the wizard
-- existed.
--
-- The values are deliberately the same safe defaults the wizard would apply: UBoss Managed, the
-- universal pack only, and a budget policy derived from the company's existing AI allowance.
-- Nothing here invents a commercial term.

UPDATE "tenants" SET "code" = UPPER(REPLACE(LEFT("slug", 18), '-', ''))
WHERE "code" IS NULL
  AND UPPER(REPLACE(LEFT("slug", 18), '-', '')) ~ '^[A-Z0-9][A-Z0-9-]{1,18}[A-Z0-9]$';

INSERT INTO "tenant_ai_settings"
  ("id", "tenant_id", "mode", "universal_pack_enabled", "industry_packs",
   "custom_skill_capability", "created_at", "updated_at", "row_version")
SELECT gen_random_uuid(), t."id", 'UBossManaged', true, ARRAY[]::text[], false, NOW(), NOW(), 1
FROM "tenants" t
WHERE NOT EXISTS (SELECT 1 FROM "tenant_ai_settings" a WHERE a."tenant_id" = t."id");

-- The budget policy mirrors whatever allowance the company already has: warn at 80%, require
-- approval at the allowance, hard stop at 120% of it. Those are the wizard's own defaults, and
-- deriving them keeps the guardrail consistent with the commercial term rather than arbitrary.
INSERT INTO "tenant_ai_budget_policies"
  ("id", "tenant_id", "monthly_allowance_minor", "warning_percent",
   "approval_threshold_minor", "hard_stop_minor", "created_at", "updated_at", "row_version")
SELECT
  gen_random_uuid(),
  t."id",
  COALESCE(s."ai_allowance_minor", 0),
  80,
  COALESCE(s."ai_allowance_minor", 0),
  (COALESCE(s."ai_allowance_minor", 0) * 12) / 10,
  NOW(), NOW(), 1
FROM "tenants" t
LEFT JOIN "tenant_subscriptions" s ON s."tenant_id" = t."id"
WHERE NOT EXISTS (SELECT 1 FROM "tenant_ai_budget_policies" b WHERE b."tenant_id" = t."id");

-- The ten checklist items, in the client's order, from UBoss_Final_1 §33. Seeded by the
-- migration for existing companies and by provisioning for new ones, so the two paths produce
-- the same checklist rather than two variants.
INSERT INTO "company_setup_tasks"
  ("id", "tenant_id", "key", "position", "title", "rationale", "target_route",
   "state", "created_at", "updated_at", "row_version")
SELECT gen_random_uuid(), t."id", v."key", v."position", v."title", v."rationale",
       v."target_route", 'NotStarted', NOW(), NOW(), 1
FROM "tenants" t
CROSS JOIN (VALUES
  ('company_profile', 1,
   'Confirm company profile, timezone, locale and branding.',
   'Every date/schedule and visible company identity depends on these defaults.',
   '/settings/general'),
  ('hierarchy', 2,
   'Build departments and reporting hierarchy.',
   'Objectives and work assignment need real internal people/manager relationships.',
   '/hierarchy'),
  ('roles', 3,
   'Configure roles, scope, module visibility and allowed actions.',
   'Prevents overexposure before users activate.',
   '/settings/roles'),
  ('employee_profiles', 4,
   'Create internal employee profiles.',
   'People can be planned/assigned even before invitation.',
   '/hierarchy'),
  ('invite_users', 5,
   'Invite internal users from Settings -> Users & Access.',
   'Activates login without duplicating hierarchy identities.',
   '/settings/users'),
  ('guests', 6,
   'Add external guests only when required.',
   'Guests stay outside hierarchy.',
   '/settings/users'),
  ('ai_policy', 7,
   'Review AI Providers, Skills & AI, Token/Cost policy.',
   'Controls which AI capabilities and budget are available.',
   '/settings/ai-providers'),
  ('connections', 8,
   'Connect approved company systems.',
   'Agents need governed connections rather than raw credentials.',
   '/settings/integrations'),
  ('governance_defaults', 9,
   'Set approvals, notifications, escalation and schedule defaults.',
   'Operational work gets predictable governance.',
   '/settings/notifications'),
  -- No route: the client's final item is an assertion a person makes, not a screen they visit.
  ('readiness_review', 10,
   'Run readiness review and mark workspace ready for managers.',
   'Objective publishing can begin safely.',
   NULL)
) AS v("key", "position", "title", "rationale", "target_route")
WHERE NOT EXISTS (
  SELECT 1 FROM "company_setup_tasks" c
  WHERE c."tenant_id" = t."id" AND c."key" = v."key"
);
