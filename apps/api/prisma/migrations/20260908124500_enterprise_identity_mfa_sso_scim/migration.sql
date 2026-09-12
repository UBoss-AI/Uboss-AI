-- Prompt 6 — enterprise identity: MFA, SSO, domain verification, SCIM.
--
-- Type: expand only. Every added column is nullable or carries a default, and no existing row's
-- meaning changes, so there is nothing to backfill and no expand/migrate/contract sequence:
--   * sessions.primary_auth_method defaults to 'Password', which is truthfully what every
--     session created before this migration was;
--   * sessions.mfa_satisfied_at is null, which is correct — none of them needed a second factor;
--   * tenant_memberships.provisioning_source defaults to 'Local', which is what every existing
--     membership is: none of them came from SCIM, because SCIM did not exist.
--
-- Rollback drops every enrolled second factor, every recovery code and every SSO connection.
-- Recovery codes and TOTP secrets cannot be reconstructed, so everyone with MFA would have to
-- re-enrol. Recorded in docs/DB_CHANGELOG.md so it is not discovered during an incident.

-- CreateEnum
CREATE TYPE "auth_method" AS ENUM ('Password', 'Totp', 'WebAuthn', 'Oidc', 'Saml', 'RecoveryCode');

-- CreateEnum
CREATE TYPE "mfa_factor_state" AS ENUM ('Pending', 'Active', 'Revoked');

-- CreateEnum
CREATE TYPE "sso_protocol" AS ENUM ('Oidc', 'Saml');

-- CreateEnum
CREATE TYPE "domain_verification_state" AS ENUM ('Pending', 'Verified', 'Failed', 'Expired');

-- CreateEnum
CREATE TYPE "provisioning_source" AS ENUM ('Local', 'Scim');

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "mfa_satisfied_at" TIMESTAMPTZ(6),
ADD COLUMN     "primary_auth_method" "auth_method" NOT NULL DEFAULT 'Password',
ADD COLUMN     "provider_session_id" VARCHAR(255),
ADD COLUMN     "sso_connection_id" UUID;

-- AlterTable
ALTER TABLE "tenant_memberships" ADD COLUMN     "provisioning_source" "provisioning_source" NOT NULL DEFAULT 'Local',
ADD COLUMN     "scim_external_id" VARCHAR(200);

-- CreateTable
CREATE TABLE "tenant_auth_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "require_mfa" BOOLEAN NOT NULL DEFAULT false,
    "require_sso" BOOLEAN NOT NULL DEFAULT false,
    "allow_password_sign_in" BOOLEAN NOT NULL DEFAULT true,
    "mfa_grace_until" TIMESTAMPTZ(6),
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tenant_auth_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_factors" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "method" "auth_method" NOT NULL DEFAULT 'Totp',
    "state" "mfa_factor_state" NOT NULL DEFAULT 'Pending',
    "label" VARCHAR(80),
    "secret_ciphertext" VARCHAR(512),
    "last_used_counter" BIGINT,
    "confirmed_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "mfa_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "batch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "device_label" VARCHAR(120),
    "client_hint" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_connections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "protocol" "sso_protocol" NOT NULL,
    "display_name" VARCHAR(120) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "issuer" VARCHAR(255),
    "discovery_url" VARCHAR(500),
    "client_id" VARCHAR(255),
    "client_secret_ciphertext" VARCHAR(512),
    "scopes" VARCHAR(255),
    "entity_id" VARCHAR(255),
    "sso_url" VARCHAR(500),
    "slo_url" VARCHAR(500),
    "signing_certificate" TEXT,
    "attribute_mapping" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "sso_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_auth_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "state_hash" VARCHAR(64) NOT NULL,
    "nonce_hash" VARCHAR(64) NOT NULL,
    "code_verifier_ciphertext" VARCHAR(512) NOT NULL,
    "redirect_after" VARCHAR(500),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sso_auth_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_verifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "domain" VARCHAR(253) NOT NULL,
    "verification_token" VARCHAR(80) NOT NULL,
    "state" "domain_verification_state" NOT NULL DEFAULT 'Pending',
    "verified_at" TIMESTAMPTZ(6),
    "last_checked_at" TIMESTAMPTZ(6),
    "failure_reason" VARCHAR(300),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "domain_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_clients" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "display_name" VARCHAR(120) NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "scim_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_groups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "display_name" VARCHAR(200) NOT NULL,
    "external_id" VARCHAR(200),
    "source" "provisioning_source" NOT NULL DEFAULT 'Local',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "user_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_group_members" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source" "provisioning_source" NOT NULL DEFAULT 'Local',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_auth_policies_tenant_id_key" ON "tenant_auth_policies"("tenant_id");

-- CreateIndex
CREATE INDEX "mfa_factors_user_id_state_idx" ON "mfa_factors"("user_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_recovery_codes_code_hash_key" ON "mfa_recovery_codes"("code_hash");

-- CreateIndex
CREATE INDEX "mfa_recovery_codes_user_id_used_at_idx" ON "mfa_recovery_codes"("user_id", "used_at");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_challenges_token_hash_key" ON "mfa_challenges"("token_hash");

-- CreateIndex
CREATE INDEX "mfa_challenges_user_id_created_at_idx" ON "mfa_challenges"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sso_connections_tenant_id_enabled_idx" ON "sso_connections"("tenant_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "sso_auth_requests_state_hash_key" ON "sso_auth_requests"("state_hash");

-- CreateIndex
CREATE INDEX "sso_auth_requests_tenant_id_created_at_idx" ON "sso_auth_requests"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "domain_verifications_domain_state_idx" ON "domain_verifications"("domain", "state");

-- CreateIndex
CREATE UNIQUE INDEX "domain_verifications_tenant_id_domain_key" ON "domain_verifications"("tenant_id", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "scim_clients_token_hash_key" ON "scim_clients"("token_hash");

-- CreateIndex
CREATE INDEX "scim_clients_tenant_id_enabled_idx" ON "scim_clients"("tenant_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "user_groups_tenant_id_display_name_key" ON "user_groups"("tenant_id", "display_name");

-- CreateIndex
CREATE UNIQUE INDEX "user_groups_tenant_id_external_id_key" ON "user_groups"("tenant_id", "external_id");

-- CreateIndex
CREATE INDEX "user_group_members_tenant_id_user_id_idx" ON "user_group_members"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_group_members_group_id_user_id_key" ON "user_group_members"("group_id", "user_id");

-- CreateIndex
CREATE INDEX "sessions_sso_connection_id_provider_session_id_idx" ON "sessions"("sso_connection_id", "provider_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_memberships_tenant_id_scim_external_id_key" ON "tenant_memberships"("tenant_id", "scim_external_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_sso_connection_id_fkey" FOREIGN KEY ("sso_connection_id") REFERENCES "sso_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_auth_policies" ADD CONSTRAINT "tenant_auth_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_factors" ADD CONSTRAINT "mfa_factors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_challenges" ADD CONSTRAINT "mfa_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_auth_requests" ADD CONSTRAINT "sso_auth_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_auth_requests" ADD CONSTRAINT "sso_auth_requests_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "sso_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_verifications" ADD CONSTRAINT "domain_verifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_clients" ADD CONSTRAINT "scim_clients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "user_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN ADDITIONS (not generated by `prisma migrate diff`)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. A verified domain claim is exclusive across the whole platform.
-- ---------------------------------------------------------------------------
-- The generated schema already enforces one claim per (tenant, domain). This
-- adds the rule that only ONE company can ever hold a *Verified* claim on a
-- given domain, while any number may hold Pending/Failed/Expired ones.
--
-- It has to be a partial index: a plain unique index on `domain` would mean the
-- first company to *attempt* a claim blocks everyone else from even trying,
-- including the company that actually controls the domain. Prisma has no
-- partial-index syntax, which is why this is written by hand.
CREATE UNIQUE INDEX "domain_verifications_verified_domain_key"
  ON "domain_verifications" ("domain")
  WHERE "state" = 'Verified';

-- ---------------------------------------------------------------------------
-- 2. Row-Level Security on the new tenant-owned tables.
-- ---------------------------------------------------------------------------
-- Same policy shape as Prompt 4 (see 20260908093000_row_level_security...):
-- a row is reachable when the request declared this tenant's scope, OR when a
-- platform operation was deliberately declared. A code path that declares
-- NEITHER sees zero rows — RLS fails closed.
--
-- This matters more here than anywhere so far: `sso_connections` holds each
-- company's encrypted client secret and its issuer configuration, and
-- `scim_clients` holds the hash of a provisioning credential. A missing
-- `WHERE tenant_id` on either would be a cross-company disclosure of security
-- configuration, not just of business data.

ALTER TABLE "tenant_auth_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_auth_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_auth_policies_tenant_isolation ON "tenant_auth_policies"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "sso_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sso_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY sso_connections_tenant_isolation ON "sso_connections"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "sso_auth_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sso_auth_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY sso_auth_requests_tenant_isolation ON "sso_auth_requests"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "domain_verifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "domain_verifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY domain_verifications_tenant_isolation ON "domain_verifications"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "scim_clients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scim_clients" FORCE ROW LEVEL SECURITY;
CREATE POLICY scim_clients_tenant_isolation ON "scim_clients"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "user_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_groups" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_groups_tenant_isolation ON "user_groups"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "user_group_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_group_members" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_group_members_tenant_isolation ON "user_group_members"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

-- `mfa_factors`, `mfa_recovery_codes` and `mfa_challenges` are deliberately NOT
-- under RLS, for the same reason as `user_credentials` and `sessions`: they are
-- PERSON-level, not tenant-level. One human keeps one set of second factors
-- across every company they belong to — that is the whole point of a single
-- UBoss identity — so there is no tenant_id for a policy to key on, and adding
-- one would break the cross-company case the client asked for.
--
-- They are protected instead by never being queried outside the MFA services,
-- each of which scopes on a `user_id` taken from a verified session or a
-- verified MFA challenge, never from anything a caller supplied. Stated in
-- docs/SECURITY_DECISIONS.md S-015 rather than papered over.
