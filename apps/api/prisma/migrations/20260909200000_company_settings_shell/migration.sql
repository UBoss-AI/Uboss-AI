-- CreateTable
CREATE TABLE "company_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "company_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_setting_changes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "previousValue" JSONB,
    "newValue" JSONB NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "changed_by_user_id" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_setting_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "company_settings_tenant_id_idx" ON "company_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_settings_tenant_id_key_key" ON "company_settings"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "company_setting_changes_tenant_id_key_changed_at_idx" ON "company_setting_changes"("tenant_id", "key", "changed_at" DESC);

-- AddForeignKey
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_setting_changes" ADD CONSTRAINT "company_setting_changes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Prompt 14 — hand-written section
-- ===========================================================================
-- Row-Level Security and the constraints Prisma cannot express. Nothing here needs a composite
-- foreign key: neither table references another tenant-owned row.

-- ---------------------------------------------------------------------------
-- 1. Row-Level Security, fail-closed like every other tenant-owned table
-- ---------------------------------------------------------------------------

ALTER TABLE "company_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_settings" FORCE ROW LEVEL SECURITY;

CREATE POLICY "company_settings_tenant_isolation" ON "company_settings"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "company_setting_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_setting_changes" FORCE ROW LEVEL SECURITY;

CREATE POLICY "company_setting_changes_tenant_isolation" ON "company_setting_changes"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

-- ---------------------------------------------------------------------------
-- 2. A setting key must look like a catalogue key
-- ---------------------------------------------------------------------------
-- The catalogue in code is the real gate — an unknown key is refused by the service before it
-- reaches here. This is the shape check underneath it: `category.setting_name`, lower case. It
-- stops a hand-run INSERT creating a row no screen will ever read, which is a setting that
-- exists and does nothing.

ALTER TABLE "company_settings"
  ADD CONSTRAINT "company_setting_key_is_dotted_lower_snake"
  CHECK ("key" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$');

ALTER TABLE "company_setting_changes"
  ADD CONSTRAINT "company_setting_change_key_is_dotted_lower_snake"
  CHECK ("key" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$');

-- A material change must say why. The whole point of keeping the history is to be able to
-- reconstruct a decision, and "the value changed" without a reason reconstructs nothing.
ALTER TABLE "company_setting_changes"
  ADD CONSTRAINT "company_setting_change_reason_is_not_blank"
  CHECK (length(btrim("reason")) > 0);

-- The value must be a JSON **scalar**. The catalogue has no object or array types, so a nested
-- value would be a shape no validator checked and no control can render.
ALTER TABLE "company_settings"
  ADD CONSTRAINT "company_setting_value_is_a_scalar"
  CHECK (jsonb_typeof("value") IN ('string', 'number', 'boolean'));

-- ---------------------------------------------------------------------------
-- 3. The history is append-only
-- ---------------------------------------------------------------------------
-- Weaker than the Prompt 8 audit trails, and deliberately so: this has no hash chain, so the
-- claim is "the application cannot rewrite it", not "tampering is detectable". Revoking UPDATE
-- and DELETE from the application role is what makes the first claim true, and saying which
-- claim is which is the point of writing it down.

REVOKE UPDATE, DELETE ON "company_setting_changes" FROM uboss_app;
