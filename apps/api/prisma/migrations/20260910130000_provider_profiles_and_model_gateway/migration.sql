-- CreateTable
CREATE TABLE "provider_profiles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "kind" VARCHAR(40) NOT NULL,
    "mode" VARCHAR(40) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "lifecycle" VARCHAR(30) NOT NULL DEFAULT 'Active',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "base_url" VARCHAR(500),
    "auth_type" VARCHAR(30),
    "auth_header_name" VARCHAR(120),
    "secret_ref" VARCHAR(200),
    "timeout_ms" INTEGER,
    "usage_input_path" VARCHAR(200),
    "usage_output_path" VARCHAR(200),
    "usage_cached_input_path" VARCHAR(200),
    "request_id_path" VARCHAR(200),
    "last_tested_at" TIMESTAMPTZ(6),
    "last_test_ok" BOOLEAN,
    "last_test_reached_provider" BOOLEAN,
    "last_test_detail" VARCHAR(1000),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "provider_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_models" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "provider_profile_id" UUID NOT NULL,
    "provider_model_ref" VARCHAR(200) NOT NULL,
    "capability" VARCHAR(80) NOT NULL,
    "lifecycle" VARCHAR(30) NOT NULL DEFAULT 'Active',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lifecycle_changed_at" TIMESTAMPTZ(6),
    "lifecycle_note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "provider_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logical_model_routes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "profile" VARCHAR(40) NOT NULL,
    "provider_model_id" UUID NOT NULL,
    "preference" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "logical_model_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "provider_model_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "input_per_million_minor_units" INTEGER NOT NULL,
    "output_per_million_minor_units" INTEGER NOT NULL,
    "cached_input_per_million_minor_units" INTEGER,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "superseded_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_gateway_calls" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "profile" VARCHAR(40) NOT NULL,
    "purpose" VARCHAR(200) NOT NULL,
    "provider_profile_id" UUID,
    "provider_model_id" UUID,
    "pricing_version_id" UUID,
    "capability" VARCHAR(80) NOT NULL,
    "used_fallback" BOOLEAN NOT NULL DEFAULT false,
    "provider_request_id" VARCHAR(200),
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_minor_units" INTEGER,
    "currency" VARCHAR(3),
    "produced_by_real_model" BOOLEAN NOT NULL DEFAULT false,
    "outcome" VARCHAR(30) NOT NULL,
    "detail" VARCHAR(2000) NOT NULL DEFAULT '',
    "latency_ms" INTEGER,
    "agent_run_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_gateway_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_profiles_tenant_id_enabled_idx" ON "provider_profiles"("tenant_id", "enabled");

-- CreateIndex
CREATE INDEX "provider_profiles_kind_lifecycle_idx" ON "provider_profiles"("kind", "lifecycle");

-- CreateIndex
CREATE INDEX "provider_models_tenant_id_lifecycle_idx" ON "provider_models"("tenant_id", "lifecycle");

-- CreateIndex
CREATE INDEX "provider_models_provider_profile_id_enabled_idx" ON "provider_models"("provider_profile_id", "enabled");

-- CreateIndex
CREATE INDEX "logical_model_routes_tenant_id_profile_preference_idx" ON "logical_model_routes"("tenant_id", "profile", "preference");

-- CreateIndex
CREATE INDEX "pricing_versions_provider_model_id_superseded_at_idx" ON "pricing_versions"("provider_model_id", "superseded_at");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_versions_provider_model_id_version_number_key" ON "pricing_versions"("provider_model_id", "version_number");

-- CreateIndex
CREATE INDEX "model_gateway_calls_tenant_id_occurred_at_idx" ON "model_gateway_calls"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "model_gateway_calls_tenant_id_profile_occurred_at_idx" ON "model_gateway_calls"("tenant_id", "profile", "occurred_at");

-- CreateIndex
CREATE INDEX "model_gateway_calls_tenant_id_agent_run_id_idx" ON "model_gateway_calls"("tenant_id", "agent_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "model_gateway_calls_tenant_id_id_key" ON "model_gateway_calls"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "provider_profiles" ADD CONSTRAINT "provider_profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_models" ADD CONSTRAINT "provider_models_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_models" ADD CONSTRAINT "provider_models_provider_profile_id_fkey" FOREIGN KEY ("provider_profile_id") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logical_model_routes" ADD CONSTRAINT "logical_model_routes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logical_model_routes" ADD CONSTRAINT "logical_model_routes_provider_model_id_fkey" FOREIGN KEY ("provider_model_id") REFERENCES "provider_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_versions" ADD CONSTRAINT "pricing_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_versions" ADD CONSTRAINT "pricing_versions_provider_model_id_fkey" FOREIGN KEY ("provider_model_id") REFERENCES "provider_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_gateway_calls" ADD CONSTRAINT "model_gateway_calls_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_gateway_calls" ADD CONSTRAINT "model_gateway_calls_provider_profile_id_fkey" FOREIGN KEY ("provider_profile_id") REFERENCES "provider_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_gateway_calls" ADD CONSTRAINT "model_gateway_calls_provider_model_id_fkey" FOREIGN KEY ("provider_model_id") REFERENCES "provider_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_gateway_calls" ADD CONSTRAINT "model_gateway_calls_pricing_version_id_fkey" FOREIGN KEY ("pricing_version_id") REFERENCES "pricing_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Prompt 29 — AI Provider Profiles and the Model Gateway
-- ===========================================================================
--
-- The locked rule this migration makes structural: **provider names are configuration, not
-- business object identity** (Technical Architecture §18). No business table gains a provider
-- column. `model_gateway_calls` stores the logical profile and an opaque capability label, and the
-- provider and model are foreign keys into platform-plane configuration that a company workspace
-- never reads.

-- ---------------------------------------------------------------------------
-- 1. Tenant isolation
-- ---------------------------------------------------------------------------
-- Four of the five carry a nullable `tenant_id`: NULL is a platform row every company inherits
-- (UBoss Managed), and a value is a company's own BYOK or custom configuration. The policy
-- therefore has to admit NULL rows to a tenant reader — otherwise a company could not be routed
-- through the platform default at all. That is the same shape `skills` and
-- `separation_of_duties_policies` already use, and it is safe for the same reason: a platform row
-- is by definition shared, and it contains no company data.
--
-- `model_gateway_calls` is different — every row belongs to exactly one company — so its policy is
-- the strict one with no NULL allowance.

ALTER TABLE "provider_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "provider_profiles_tenant_isolation" ON "provider_profiles"
  USING ("tenant_id" IS NULL
         OR "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "provider_models" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_models" FORCE ROW LEVEL SECURITY;
CREATE POLICY "provider_models_tenant_isolation" ON "provider_models"
  USING ("tenant_id" IS NULL
         OR "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "logical_model_routes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "logical_model_routes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "logical_model_routes_tenant_isolation" ON "logical_model_routes"
  USING ("tenant_id" IS NULL
         OR "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "pricing_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pricing_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pricing_versions_tenant_isolation" ON "pricing_versions"
  USING ("tenant_id" IS NULL
         OR "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "model_gateway_calls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "model_gateway_calls" FORCE ROW LEVEL SECURITY;
CREATE POLICY "model_gateway_calls_tenant_isolation" ON "model_gateway_calls"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- ---------------------------------------------------------------------------
-- 2. The closed vocabularies
-- ---------------------------------------------------------------------------
-- Named here as well as in the shared types, so a typo becomes a rejected write rather than a
-- sixth logical profile that no route resolves and no screen has a label for.

ALTER TABLE "provider_profiles"
  ADD CONSTRAINT "provider_kind_is_known"
  CHECK ("kind" IN ('Anthropic', 'OpenAI', 'Custom', 'Mock'));

ALTER TABLE "provider_profiles"
  ADD CONSTRAINT "provider_mode_is_known"
  CHECK ("mode" IN ('UBossManaged', 'CompanyBYOK', 'CustomEnterprise'));

ALTER TABLE "provider_profiles"
  ADD CONSTRAINT "provider_profile_lifecycle_is_known"
  CHECK ("lifecycle" IN ('Active', 'Deprecated', 'MigrationRequired'));

ALTER TABLE "provider_models"
  ADD CONSTRAINT "provider_model_lifecycle_is_known"
  CHECK ("lifecycle" IN ('Active', 'Deprecated', 'MigrationRequired'));

ALTER TABLE "logical_model_routes"
  ADD CONSTRAINT "route_names_one_of_the_five_logical_profiles"
  CHECK ("profile" IN (
    'OBJECTIVE_PLANNER', 'AGENT_STANDARD', 'AGENT_FAST', 'EXECUTOR', 'HIGH_REASONING'
  ));

ALTER TABLE "model_gateway_calls"
  ADD CONSTRAINT "call_names_one_of_the_five_logical_profiles"
  CHECK ("profile" IN (
    'OBJECTIVE_PLANNER', 'AGENT_STANDARD', 'AGENT_FAST', 'EXECUTOR', 'HIGH_REASONING'
  ));

ALTER TABLE "model_gateway_calls"
  ADD CONSTRAINT "call_outcome_is_known"
  CHECK ("outcome" IN ('Succeeded', 'Failed', 'Unroutable'));

-- ---------------------------------------------------------------------------
-- 3. A provider mode and its configuration have to agree
-- ---------------------------------------------------------------------------

-- A custom enterprise profile needs an endpoint; a first-party adapter must not carry one. The
-- second half matters as much as the first: a stale `base_url` on an Anthropic profile is a value
-- somebody will eventually believe is being used.
ALTER TABLE "provider_profiles"
  ADD CONSTRAINT "a_custom_provider_has_an_endpoint_and_others_do_not"
  CHECK (
    ("kind" = 'Custom' AND "base_url" IS NOT NULL AND "auth_type" IS NOT NULL
     AND "timeout_ms" IS NOT NULL)
    OR ("kind" <> 'Custom' AND "base_url" IS NULL)
  );

-- https only. A provider call carries the company's own data and, under BYOK, its credential.
ALTER TABLE "provider_profiles"
  ADD CONSTRAINT "a_custom_endpoint_is_https"
  CHECK ("base_url" IS NULL OR "base_url" LIKE 'https://%');

ALTER TABLE "provider_profiles"
  ADD CONSTRAINT "provider_auth_type_is_known"
  CHECK ("auth_type" IS NULL OR "auth_type" IN ('BearerToken', 'ApiKeyHeader', 'None'));

-- An auth type that needs a credential must name one, and one that does not must not hold one.
-- A stored secret nothing reads is a secret nobody rotates.
ALTER TABLE "provider_profiles"
  ADD CONSTRAINT "auth_type_and_secret_agree"
  CHECK (
    "auth_type" IS NULL
    OR ("auth_type" = 'None' AND "secret_ref" IS NULL)
    OR ("auth_type" IN ('BearerToken', 'ApiKeyHeader') AND "secret_ref" IS NOT NULL)
  );

ALTER TABLE "provider_profiles"
  ADD CONSTRAINT "a_header_key_names_its_header"
  CHECK ("auth_type" IS DISTINCT FROM 'ApiKeyHeader' OR "auth_header_name" IS NOT NULL);

ALTER TABLE "provider_profiles"
  ADD CONSTRAINT "provider_timeout_is_sane"
  CHECK ("timeout_ms" IS NULL OR ("timeout_ms" >= 1000 AND "timeout_ms" <= 600000));

-- A custom endpoint must say where the token counts are. Without it the gateway would have to
-- estimate what it just spent and record the estimate as measured usage.
ALTER TABLE "provider_profiles"
  ADD CONSTRAINT "a_custom_provider_maps_its_usage"
  CHECK (
    "kind" <> 'Custom'
    OR ("usage_input_path" IS NOT NULL AND "usage_output_path" IS NOT NULL)
  );

-- A company profile is BYOK or custom; a platform profile is UBoss Managed. The two halves of
-- §19's model, made unmixable: a UBoss-managed profile owned by one company would be metered
-- against that company while being everybody's default.
ALTER TABLE "provider_profiles"
  ADD CONSTRAINT "provider_mode_matches_who_owns_the_profile"
  CHECK (
    ("tenant_id" IS NULL AND "mode" = 'UBossManaged')
    OR ("tenant_id" IS NOT NULL AND "mode" IN ('CompanyBYOK', 'CustomEnterprise'))
  );

-- A Test Connection result is recorded whole or not at all, and it always says whether a provider
-- actually answered. "It validated" and "it responded" are different claims (S-188).
ALTER TABLE "provider_profiles"
  ADD CONSTRAINT "a_test_result_says_whether_a_provider_answered"
  CHECK (
    ("last_tested_at" IS NULL AND "last_test_ok" IS NULL
     AND "last_test_reached_provider" IS NULL)
    OR ("last_tested_at" IS NOT NULL AND "last_test_ok" IS NOT NULL
        AND "last_test_reached_provider" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 4. A model belongs to its profile's tenant
-- ---------------------------------------------------------------------------
-- Prisma cannot express "these two nullable tenant ids must match", so it is a trigger. Without
-- it a company could attach a model to the platform profile, and that model would then be
-- routable for every other company.

CREATE OR REPLACE FUNCTION uboss_provider_model_matches_profile_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  profile_tenant uuid;
BEGIN
  SELECT "tenant_id" INTO profile_tenant
    FROM "provider_profiles" WHERE "id" = NEW."provider_profile_id";

  IF profile_tenant IS DISTINCT FROM NEW."tenant_id" THEN
    RAISE EXCEPTION
      'A provider model must belong to the same tenant as its profile. Attaching a company model '
      'to the platform profile would make it routable for every other company.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "uboss_provider_model_matches_profile_tenant"
  BEFORE INSERT OR UPDATE ON "provider_models"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_provider_model_matches_profile_tenant();

-- ---------------------------------------------------------------------------
-- 5. Routing is unambiguous
-- ---------------------------------------------------------------------------

-- One route per (scope, profile, model): listing a model twice for one profile would make its
-- preference meaningless.
CREATE UNIQUE INDEX "one_route_per_platform_profile_and_model"
  ON "logical_model_routes" ("profile", "provider_model_id")
  WHERE "tenant_id" IS NULL;

CREATE UNIQUE INDEX "one_route_per_company_profile_and_model"
  ON "logical_model_routes" ("tenant_id", "profile", "provider_model_id")
  WHERE "tenant_id" IS NOT NULL;

-- Distinct preferences within a scope, so "most preferred" is a fact rather than a tie broken by
-- row order. A tie would make routing non-deterministic across restarts.
CREATE UNIQUE INDEX "one_model_per_platform_profile_preference"
  ON "logical_model_routes" ("profile", "preference")
  WHERE "tenant_id" IS NULL;

CREATE UNIQUE INDEX "one_model_per_company_profile_preference"
  ON "logical_model_routes" ("tenant_id", "profile", "preference")
  WHERE "tenant_id" IS NOT NULL;

ALTER TABLE "logical_model_routes"
  ADD CONSTRAINT "route_preference_is_not_negative"
  CHECK ("preference" >= 0);

-- ---------------------------------------------------------------------------
-- 6. Pricing is immutable and versioned
-- ---------------------------------------------------------------------------

ALTER TABLE "pricing_versions"
  ADD CONSTRAINT "pricing_is_not_negative"
  CHECK (
    "input_per_million_minor_units" >= 0
    AND "output_per_million_minor_units" >= 0
    AND ("cached_input_per_million_minor_units" IS NULL
         OR "cached_input_per_million_minor_units" >= 0)
  );

ALTER TABLE "pricing_versions"
  ADD CONSTRAINT "pricing_version_number_is_positive"
  CHECK ("version_number" >= 1);

ALTER TABLE "pricing_versions"
  ADD CONSTRAINT "pricing_currency_is_three_letters"
  CHECK ("currency" ~ '^[A-Z]{3}$');

-- Exactly one current price per model. Two would mean a call could be priced either way, and the
-- two answers would both look correct in the ledger.
CREATE UNIQUE INDEX "one_current_pricing_version_per_model"
  ON "pricing_versions" ("provider_model_id")
  WHERE "superseded_at" IS NULL;

-- A published price never changes. A gateway call cites the version that priced it, so editing
-- one would retroactively restate what a Run cost — the same rule as an immutable Objective
-- version, for the same reason. Superseding it is the only permitted update.
CREATE OR REPLACE FUNCTION uboss_pricing_versions_are_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'A pricing version cannot be deleted. Gateway calls cite it as what priced them.'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW."provider_model_id" IS DISTINCT FROM OLD."provider_model_id"
     OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."input_per_million_minor_units" IS DISTINCT FROM OLD."input_per_million_minor_units"
     OR NEW."output_per_million_minor_units" IS DISTINCT FROM OLD."output_per_million_minor_units"
     OR NEW."cached_input_per_million_minor_units"
        IS DISTINCT FROM OLD."cached_input_per_million_minor_units"
     OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from" THEN
    RAISE EXCEPTION
      'A pricing version is immutable. Supersede it with a new version rather than editing it — '
      'a price change must not retroactively restate what a Run cost.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "uboss_pricing_versions_are_immutable"
  BEFORE UPDATE OR DELETE ON "pricing_versions"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_pricing_versions_are_immutable();

-- ---------------------------------------------------------------------------
-- 7. The call record is append-only and internally honest
-- ---------------------------------------------------------------------------

-- A priced call cites the pricing version that priced it. A cost with no cited price is a number
-- nobody can check, which is worse than no number.
ALTER TABLE "model_gateway_calls"
  ADD CONSTRAINT "a_priced_call_cites_its_pricing_version"
  CHECK (
    ("cost_minor_units" IS NULL AND "currency" IS NULL)
    OR ("cost_minor_units" IS NOT NULL AND "currency" IS NOT NULL
        AND "pricing_version_id" IS NOT NULL)
  );

ALTER TABLE "model_gateway_calls"
  ADD CONSTRAINT "call_token_counts_are_not_negative"
  CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0 AND "cached_input_tokens" >= 0);

-- An unroutable call reached no model, and a succeeded one did. Without this a routing failure
-- could be recorded as a success against no provider, which would make the fallback statistics
-- meaningless.
ALTER TABLE "model_gateway_calls"
  ADD CONSTRAINT "an_unroutable_call_reached_no_model"
  CHECK (
    ("outcome" = 'Unroutable' AND "provider_model_id" IS NULL)
    OR ("outcome" <> 'Unroutable')
  );

ALTER TABLE "model_gateway_calls"
  ADD CONSTRAINT "a_successful_call_names_the_model_that_answered"
  CHECK ("outcome" <> 'Succeeded' OR "provider_model_id" IS NOT NULL);

-- **A mock call can never be recorded as real.** The flag is stored rather than inferred, and a
-- mock adapter has no provider request id to offer — so claiming one would be the fabrication the
-- client's rules forbid.
ALTER TABLE "model_gateway_calls"
  ADD CONSTRAINT "a_mock_call_has_no_provider_request_id"
  CHECK ("produced_by_real_model" = true OR "provider_request_id" IS NULL);

CREATE OR REPLACE FUNCTION uboss_gateway_calls_are_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Model gateway call records are append-only. They are what a provider actually did, and '
    'Prompt 30 reconciles the cost ledger against them — a history that can be edited afterwards '
    'reconciles against nothing.'
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER "uboss_gateway_calls_are_append_only"
  BEFORE UPDATE OR DELETE ON "model_gateway_calls"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_gateway_calls_are_append_only();

-- ---------------------------------------------------------------------------
-- 8. The platform baseline: a mock provider, honestly labelled
-- ---------------------------------------------------------------------------
-- No real provider has been configured or approved, and this migration does not pretend one has.
-- It seeds the mock profile the gateway already ships with, one model per capability, and a route
-- for each of the five logical profiles — so the seam is exercised end to end and every call
-- records `produced_by_real_model = false`.
--
-- A real provider is registered by inserting a profile and its models; nothing in the business
-- layer changes when that happens, which is the whole point of §18.

INSERT INTO "provider_profiles"
  ("id", "tenant_id", "kind", "mode", "label", "lifecycle", "enabled", "created_at", "updated_at",
   "row_version")
SELECT
  '00000000-0000-4000-8000-00000000e001', NULL, 'Mock', 'UBossManaged',
  'Mock (no provider configured)', 'Active', true, NOW(), NOW(), 1
WHERE NOT EXISTS (
  SELECT 1 FROM "provider_profiles" WHERE "id" = '00000000-0000-4000-8000-00000000e001'
);

-- Two capabilities rather than one, so a same-capability fallback and a refused cross-capability
-- fallback are both reachable without a real provider.
INSERT INTO "provider_models"
  ("id", "tenant_id", "provider_profile_id", "provider_model_ref", "capability", "lifecycle",
   "enabled", "created_at", "updated_at", "row_version")
SELECT * FROM (VALUES
  ('00000000-0000-4000-8000-00000000e101'::uuid, NULL::uuid,
   '00000000-0000-4000-8000-00000000e001'::uuid, 'mock-reasoning-v1', 'high-reasoning-v1',
   'Active', true, NOW(), NOW(), 1),
  ('00000000-0000-4000-8000-00000000e102'::uuid, NULL::uuid,
   '00000000-0000-4000-8000-00000000e001'::uuid, 'mock-fast-v1', 'fast-v1',
   'Active', true, NOW(), NOW(), 1)
) AS seed
WHERE NOT EXISTS (
  SELECT 1 FROM "provider_models" WHERE "id" = '00000000-0000-4000-8000-00000000e101'
);

-- The reasoning model answers the three profiles that need judgement; the fast one answers
-- AGENT_FAST. AGENT_STANDARD gets both, so its `AnyApproved` fallback has somewhere to go.
INSERT INTO "logical_model_routes"
  ("id", "tenant_id", "profile", "provider_model_id", "preference", "enabled", "created_at",
   "updated_at", "row_version")
SELECT * FROM (VALUES
  ('00000000-0000-4000-8000-00000000e201'::uuid, NULL::uuid, 'OBJECTIVE_PLANNER',
   '00000000-0000-4000-8000-00000000e101'::uuid, 0, true, NOW(), NOW(), 1),
  ('00000000-0000-4000-8000-00000000e202'::uuid, NULL::uuid, 'AGENT_STANDARD',
   '00000000-0000-4000-8000-00000000e101'::uuid, 0, true, NOW(), NOW(), 1),
  ('00000000-0000-4000-8000-00000000e203'::uuid, NULL::uuid, 'AGENT_STANDARD',
   '00000000-0000-4000-8000-00000000e102'::uuid, 1, true, NOW(), NOW(), 1),
  ('00000000-0000-4000-8000-00000000e204'::uuid, NULL::uuid, 'AGENT_FAST',
   '00000000-0000-4000-8000-00000000e102'::uuid, 0, true, NOW(), NOW(), 1),
  ('00000000-0000-4000-8000-00000000e205'::uuid, NULL::uuid, 'EXECUTOR',
   '00000000-0000-4000-8000-00000000e101'::uuid, 0, true, NOW(), NOW(), 1),
  ('00000000-0000-4000-8000-00000000e206'::uuid, NULL::uuid, 'HIGH_REASONING',
   '00000000-0000-4000-8000-00000000e101'::uuid, 0, true, NOW(), NOW(), 1)
) AS seed
WHERE NOT EXISTS (
  SELECT 1 FROM "logical_model_routes" WHERE "id" = '00000000-0000-4000-8000-00000000e201'
);

-- A zero price, explicitly. The mock costs nothing, and saying so with a real pricing version
-- means the estimate/settle arithmetic is exercised rather than skipped — Prompt 30 needs a
-- pricing version to cite even when the amount is zero.
INSERT INTO "pricing_versions"
  ("id", "tenant_id", "provider_model_id", "version_number", "currency",
   "input_per_million_minor_units", "output_per_million_minor_units",
   "cached_input_per_million_minor_units", "effective_from", "created_at")
SELECT * FROM (VALUES
  ('00000000-0000-4000-8000-00000000e301'::uuid, NULL::uuid,
   '00000000-0000-4000-8000-00000000e101'::uuid, 1, 'INR', 0, 0, NULL::int, NOW(), NOW()),
  ('00000000-0000-4000-8000-00000000e302'::uuid, NULL::uuid,
   '00000000-0000-4000-8000-00000000e102'::uuid, 1, 'INR', 0, 0, NULL::int, NOW(), NOW())
) AS seed
WHERE NOT EXISTS (
  SELECT 1 FROM "pricing_versions" WHERE "id" = '00000000-0000-4000-8000-00000000e301'
);
