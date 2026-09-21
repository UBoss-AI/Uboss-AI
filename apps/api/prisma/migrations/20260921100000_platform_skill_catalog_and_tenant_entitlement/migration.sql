-- Platform Skill Catalog, and which packs a company is entitled to.
--
-- ## What this does NOT change, and why that matters
--
-- Nothing about ownership. `skills.tenant_id` has been nullable since the catalogue landed, and
-- `skill_layer_matches_its_owner` already insists that `UbossVerified` and `IndustryPack` rows
-- carry no tenant while `CompanyCustom` rows must. The row-level security policy already reads
-- `tenant_id IS NULL OR tenant_id = current_tenant OR platform_operation`. The architecture for a
-- shared platform catalogue was designed in; it had simply never been filled.
--
-- So this adds two things and rewrites nothing:
--
--   1. the taxonomy a four-hundred-row catalogue is browsed by — department and archetype;
--   2. `tenant_skill_packs`, which says which Industry Packs a company may see.
--
-- ## Why the entitlement is a table and not a policy
--
-- RLS answers "may this tenant read this row". Every company may read the platform catalogue —
-- that is what makes it a catalogue. Entitlement answers a different question: which packs are
-- *for* this company. Pushing that into the policy would mean a healthcare company's query
-- planner consulting a subscription table on every skill read, and would make an operator's view
-- of the catalogue depend on whose session they were in. It belongs in the service.

-- ---------------------------------------------------------------------------
-- 1. The catalogue taxonomy
-- ---------------------------------------------------------------------------
--
-- Both nullable: a company authoring its own Skill need not classify it, and every existing row
-- predates the catalogue. Neither is `SkillVersion.category`, which is a closed nine-value
-- vocabulary capped at 40 characters — the catalogue's department names reach 65.

ALTER TABLE "skills" ADD COLUMN "department" VARCHAR(120);
ALTER TABLE "skills" ADD COLUMN "archetype" VARCHAR(60);

CREATE INDEX "skills_layer_department_idx" ON "skills"("layer", "department");
CREATE INDEX "skills_layer_archetype_idx" ON "skills"("layer", "archetype");

-- The source catalogue's own autonomy word, kept beside the enum it mapped onto. The mapping is
-- lossy and fails closed; recording the original is what makes that checkable.
ALTER TABLE "skill_versions" ADD COLUMN "source_autonomy" VARCHAR(60);

-- ---------------------------------------------------------------------------
-- 2. Tenant entitlement to an Industry Pack
-- ---------------------------------------------------------------------------

CREATE TABLE "tenant_skill_packs" (
  "id"                 UUID         NOT NULL,
  "tenant_id"          UUID         NOT NULL,
  "industry"           VARCHAR(80)  NOT NULL,
  "enabled_by_user_id" UUID,
  "enabled_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason"             VARCHAR(1000) NOT NULL,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL,
  "row_version"        INTEGER      NOT NULL DEFAULT 1,

  CONSTRAINT "tenant_skill_packs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tenant_skill_packs"
  ADD CONSTRAINT "tenant_skill_packs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enabling a pack twice is the same fact, not two.
CREATE UNIQUE INDEX "one_pack_per_company" ON "tenant_skill_packs"("tenant_id", "industry");
CREATE INDEX "tenant_skill_packs_industry_idx" ON "tenant_skill_packs"("industry");

-- An entitlement with no stated reason is an entitlement nobody can review.
ALTER TABLE "tenant_skill_packs"
  ADD CONSTRAINT "skill_pack_entitlement_says_why"
  CHECK (length(btrim("reason")) > 0);

ALTER TABLE "tenant_skill_packs"
  ADD CONSTRAINT "skill_pack_names_an_industry"
  CHECK (length(btrim("industry")) > 0);

-- ---------------------------------------------------------------------------
-- 3. Row-level security
-- ---------------------------------------------------------------------------
--
-- The ordinary tenant-scoped shape, not the catalogue's. An entitlement row belongs to exactly
-- one company and there is no such thing as a platform-owned one, so unlike `skills` there is no
-- `tenant_id IS NULL` arm: a row with no tenant would be an entitlement for nobody.

ALTER TABLE "tenant_skill_packs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_skill_packs" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_skill_packs_tenant_isolation" ON "tenant_skill_packs"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );
