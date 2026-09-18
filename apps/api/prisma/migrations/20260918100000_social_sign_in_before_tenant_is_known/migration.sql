-- ===========================================================================
-- Social sign-in: an authorization request that begins before any tenant is known
-- ===========================================================================
--
-- ## The problem this solves
--
-- `sso_auth_requests` was built for a company's own enterprise connection, where the tenant is
-- settled before the browser ever leaves: a connection row belongs to exactly one company, so the
-- request can be keyed to that company from the first moment.
--
-- A Google, Microsoft or Apple sign-in is the other way round. Nobody has said who they are yet.
-- The address comes back from the provider, and only then can it be matched to a person and their
-- company. So `tenant_id` and `connection_id` cannot be known at the start, and forcing a value
-- into either one would mean guessing — most likely from something the client sent, which is
-- precisely how a cross-tenant hole gets made.
--
-- ## Why a NULL tenant is safe here, and specifically
--
-- The table's policy is unchanged:
--
--     tenant_id = current_setting('app.current_tenant_id')::uuid
--     OR current_setting('app.platform_operation') = 'on'
--
-- In SQL, `NULL = anything` is NULL rather than true. So a row with no tenant satisfies the first
-- branch for **nobody** — it is invisible to every tenant context, not merely to other tenants.
-- It is reachable only through the platform operation that created it, which is how the existing
-- SSO flow already reads these rows.
--
-- That is the property the approval asked for, and it falls out of the policy already in place
-- rather than needing a new one: an unresolved social request carries no tenant privilege because
-- it carries no tenant. Once identity is verified and a membership resolved, `tenant_id` is set,
-- and from that instant the row is visible to exactly one company.
--
-- `FORCE ROW LEVEL SECURITY` stays on, so this holds for the table owner too.
--
-- ## What stops a request from being adopted by the wrong company
--
-- Nothing in this row decides the tenant. `state_hash` is unique and is the only way to find the
-- row on the way back; `consumed_at` makes it single-use; `expires_at` bounds it. The tenant is
-- written by the callback after the ID token's signature, issuer, audience, expiry and nonce have
-- all been checked and the verified email has been matched to an existing membership. A client
-- cannot nominate it, because the client never supplies it.
--
-- ## Enterprise connections are untouched
--
-- Their rows still carry both ids from the start. The columns become nullable, which widens what
-- the table *can* hold; `flow_kind` records which arrangement each row is, and the two are kept
-- apart by a constraint rather than by convention — an enterprise row without a tenant, or a
-- social row with a connection, is refused by the database.

-- ---------------------------------------------------------------------------
-- 1. Which arrangement a request belongs to
-- ---------------------------------------------------------------------------

CREATE TYPE "SsoFlowKind" AS ENUM ('EnterpriseConnection', 'SocialProvider');

ALTER TABLE "sso_auth_requests"
  ADD COLUMN "flow_kind" "SsoFlowKind" NOT NULL DEFAULT 'EnterpriseConnection';

-- Every row that exists today is an enterprise connection request, which is what the default
-- says. The default stays: it is the safe reading of a row written by older code.

-- ---------------------------------------------------------------------------
-- 2. Which provider, for a social request
-- ---------------------------------------------------------------------------

CREATE TYPE "SocialProviderKind" AS ENUM ('Google', 'Microsoft', 'Apple');

ALTER TABLE "sso_auth_requests"
  ADD COLUMN "provider_kind" "SocialProviderKind";

-- The provider is stored rather than re-derived on the way back, so the callback validates the ID
-- token against the issuer the request was *started* with. Re-reading configuration at callback
-- time would mean a configuration change mid-flight could move which issuer is trusted for a
-- request already in the air.

-- ---------------------------------------------------------------------------
-- 3. The tenant and connection become unknown-at-first
-- ---------------------------------------------------------------------------

ALTER TABLE "sso_auth_requests"
  ALTER COLUMN "tenant_id" DROP NOT NULL,
  ALTER COLUMN "connection_id" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. The two arrangements cannot be mixed up
-- ---------------------------------------------------------------------------

-- An enterprise request has both ids and no provider. A social request has a provider, no
-- connection, and a tenant only once one has been resolved. Written as a constraint because
-- "we always set it correctly" is not a property, it is a hope.
ALTER TABLE "sso_auth_requests"
  ADD CONSTRAINT "sso_auth_requests_flow_shape" CHECK (
    (
      "flow_kind" = 'EnterpriseConnection'
      AND "tenant_id" IS NOT NULL
      AND "connection_id" IS NOT NULL
      AND "provider_kind" IS NULL
    )
    OR (
      "flow_kind" = 'SocialProvider'
      AND "connection_id" IS NULL
      AND "provider_kind" IS NOT NULL
    )
  );

-- ---------------------------------------------------------------------------
-- 5. Finding a social request on the way back
-- ---------------------------------------------------------------------------

-- The callback finds its row by `state_hash`, which is already unique. This index is for the
-- sweeper that deletes expired requests, which now has rows with no tenant to consider and can no
-- longer rely on the tenant index alone.
CREATE INDEX "sso_auth_requests_expires_at_idx"
  ON "sso_auth_requests" ("expires_at");
