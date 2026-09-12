-- ===========================================================================
-- Prompt 40 — Rate limits, abuse protection and execution fairness
-- ===========================================================================
--
-- Two things land here, and only two: the table that makes a retried mutating request safe, and
-- the platform settings that configure the limits.
--
-- Nothing else needs a table. The per-user and per-tenant API buckets live in Redis (or in
-- process), because a token bucket is state with a lifetime of one minute and writing it to
-- PostgreSQL would put a row-level write in front of every request in the product — the limiter
-- would become the load problem. The **run concurrency cap needs no counter at all**: the number
-- of runs a company has in flight is `COUNT(*) WHERE state IN ('Reserved','Running')`, which is
-- derived from the rows that already exist and therefore cannot drift out of step with them. A
-- counter column would be a second answer to a question the rows already answer.

-- ---------------------------------------------------------------------------
-- Idempotency records
-- ---------------------------------------------------------------------------

CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "scope_key" VARCHAR(60) NOT NULL,
    "user_id" UUID NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "method" VARCHAR(10) NOT NULL,
    "path" VARCHAR(500) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status_code" INTEGER,
    "response_body" JSONB,
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

CREATE INDEX "idempotency_records_tenant_id_created_at_idx" ON "idempotency_records"("tenant_id", "created_at");

-- **The constraint that makes idempotency safe rather than dangerous.**
--
-- A key is unique per *actor*, never globally. A global key space would let one customer send
-- another customer's key and be handed their stored response body — idempotency would become a
-- cross-tenant read primitive. `scope_key` is in the index precisely so the uniqueness can be
-- stated without a NULL in it.
CREATE UNIQUE INDEX "idempotency_key_is_unique_per_actor" ON "idempotency_records"("scope_key", "user_id", "key");

ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The three things a record must be internally consistent about
-- ---------------------------------------------------------------------------
--
-- Every CHECK below is wrapped in `COALESCE(..., false)`. **A CHECK whose expression evaluates to
-- NULL passes** — this is the fifth time in this codebase that fact has mattered (Prompts 14, 22,
-- 35, 39), and every one of those was a constraint that looked right and enforced nothing. The
-- expressions here happen not to produce NULL, and they are wrapped anyway, because "happens not
-- to" is a property of today's column nullability rather than a property of the constraint.

-- `scope_key` and `tenant_id` say the same thing or the row is wrong. Without this, a row could
-- claim to be platform-plane while carrying a tenant id, and the unique index would then be
-- scoping it by the wrong key.
ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_scope_matches_its_plane"
  CHECK (COALESCE(
    ("tenant_id" IS NULL AND "scope_key" = 'platform')
    OR ("tenant_id" IS NOT NULL AND "scope_key" = "tenant_id"::text),
    false
  ));

-- A finished record has both a status and a time; an unfinished one has neither. The in-flight
-- state is meaningful — a retry that arrives mid-flight has nothing to replay — so it must be
-- representable, and "half finished" must not be.
ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_record_is_finished_or_not"
  CHECK (COALESCE(("status_code" IS NULL) = ("completed_at" IS NULL), false));

-- A record that expired before it was created would be swept immediately, which looks exactly
-- like a client whose retries never work and is very hard to diagnose from the outside.
ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_record_expires_after_it_was_created"
  CHECK (COALESCE("expires_at" > "created_at", false));

-- ---------------------------------------------------------------------------
-- Row-level security: the strict policy, not the shared one
-- ---------------------------------------------------------------------------
--
-- `provider_profiles` admits a NULL-tenant row to a tenant reader, because there a NULL row is
-- shared platform *configuration* with no company data in it. **This table is the opposite**: a
-- NULL-tenant row is a platform operator's own request and response, so it must not be visible to
-- a company. `NULL = <tenant>` is NULL, which fails the policy — so the strict form is also the
-- fail-closed form, and a platform-plane record is reachable only inside a platform operation.

ALTER TABLE "idempotency_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY "idempotency_records_tenant_isolation" ON "idempotency_records"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- DELETE is granted, unlike the six `Content` tables at Prompt 38 that deliberately withhold it.
-- This table has a sweep: a record past `expires_at` is deleted, by design, every day. A table
-- whose whole contract includes forgetting cannot be append-only.
GRANT SELECT, INSERT, UPDATE, DELETE ON "idempotency_records" TO "uboss_app";

-- ---------------------------------------------------------------------------
-- The limits, as platform settings
-- ---------------------------------------------------------------------------
--
-- **Not company settings, and that is the load-bearing decision.** A per-company API limit
-- protects every *other* company from this one, exactly as the run concurrency cap does. A
-- customer who could raise their own would be a customer who could opt out of a protection the
-- rest depend on, which makes the control decorative.
--
-- So they are rows here: changed by platform staff through the Master Console path that already
-- records a setting change as a Critical security event, and read by `RateLimitService` with
-- `DEFAULT_LIMITS` behind them. A row that is missing, or set to something unusable, falls back
-- to the code default rather than taking the product down.

INSERT INTO "platform_settings"
  ("id", "key", "value", "description", "section", "locked",
   "created_at", "updated_at", "row_version")
VALUES
  (gen_random_uuid(), 'limits.api_requests_per_user_per_minute', '300'::jsonb,
   'How many API requests one person may make per minute. A person filling in a form with '
     || 'autosave, a dashboard polling and an upload together come nowhere near five a second; a '
     || 'script in a loop passes it immediately.',
   'Limits & fairness', false, NOW(), NOW(), 1),
  (gen_random_uuid(), 'limits.api_requests_per_company_per_minute', '3000'::jsonb,
   'How many API requests one company may make per minute, across everybody in it. Ten times the '
     || 'per-person limit, so a company of thirty active people is unconstrained and a company '
     || 'whose integration has gone wrong is stopped before it affects other customers.',
   'Limits & fairness', false, NOW(), NOW(), 1),
  (gen_random_uuid(), 'limits.concurrent_runs_per_company', '8'::jsonb,
   'How many agent runs one company may have in progress at once. Not a rate — a ceiling on work '
     || 'in flight. Paired with round-robin queue ordering: the ceiling stops one company '
     || 'monopolising the workers, the ordering stops it monopolising the queue, and neither '
     || 'alone is enough.',
   'Limits & fairness', false, NOW(), NOW(), 1),
  -- Locked, because it is a statement about the deployment rather than a preference. Changing the
  -- text would not move the boundary, and a control that appears to move a security boundary and
  -- does not is worse than no control.
  (gen_random_uuid(), 'limits.edge_protection', '"assumed_reverse_proxy"'::jsonb,
   'UBoss assumes a reverse proxy or WAF in front of it for TLS, malformed requests and IP-level '
     || 'volumetric protection. Its own limits are per authenticated identity, which is the layer '
     || 'a proxy cannot see. An unauthenticated flood is the proxy''s job.',
   'Limits & fairness', true, NOW(), NOW(), 1);

-- ---------------------------------------------------------------------------
-- The provider's own declared limit
-- ---------------------------------------------------------------------------
--
-- Nullable, and null is the expected value. Most provider contracts state a rate limit that
-- nobody transcribes into a configuration field, so a NOT NULL column with a default would be a
-- made-up number presented as a provider's terms. Null means "not declared", and UBoss then
-- learns the limit from the 429s it receives instead.
--
-- A positive number or nothing: zero would mean "this model may never be called", which is what
-- `enabled` is for, and expressing it here would give two controls the same effect and different
-- names.

ALTER TABLE "provider_models" ADD COLUMN "quota_requests_per_minute" INTEGER;

ALTER TABLE "provider_models"
  ADD CONSTRAINT "declared_model_quota_is_positive"
  CHECK (COALESCE("quota_requests_per_minute" > 0, true));
