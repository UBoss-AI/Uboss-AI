-- CreateTable
CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "filename" VARCHAR(400) NOT NULL,
    "content_type" VARCHAR(160) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_ref" VARCHAR(500),
    "content_hash" VARCHAR(64),
    "scan_state" VARCHAR(20) NOT NULL DEFAULT 'Pending',
    "scanned_at" TIMESTAMPTZ(6),
    "scan_result" VARCHAR(500),
    "scanned_by_real_scanner" BOOLEAN,
    "classification" VARCHAR(20) NOT NULL DEFAULT 'Internal',
    "retention_action" VARCHAR(30) NOT NULL DEFAULT 'DeleteContent',
    "retention_expires_at" TIMESTAMPTZ(6),
    "on_legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "legal_hold_reason" VARCHAR(500),
    "legal_hold_placed_at" TIMESTAMPTZ(6),
    "legal_hold_placed_by_user_id" UUID,
    "uploaded_by_user_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" VARCHAR(500),
    "deleted_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_sources" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000) NOT NULL DEFAULT '',
    "kind" VARCHAR(30) NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'Draft',
    "access_scope" VARCHAR(30) NOT NULL DEFAULT 'NamedAgentsOnly',
    "department_id" UUID,
    "named_agent_ids" UUID[],
    "classification" VARCHAR(20) NOT NULL DEFAULT 'Internal',
    "connection_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_user_id" UUID,
    "retired_at" TIMESTAMPTZ(6),
    "retired_reason" VARCHAR(500),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_source_files" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "knowledge_source_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "added_by_user_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "knowledge_source_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_knowledge_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "max_upload_bytes" INTEGER NOT NULL DEFAULT 52428800,
    "allowed_content_types" TEXT[],
    "default_retention_days" INTEGER,
    "default_retention_action" VARCHAR(30) NOT NULL DEFAULT 'DeleteContent',
    "export_ceiling" VARCHAR(20) NOT NULL DEFAULT 'Confidential',
    "external_egress_ceiling" VARCHAR(20) NOT NULL DEFAULT 'Internal',
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "company_knowledge_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "files_tenant_id_scan_state_idx" ON "files"("tenant_id", "scan_state");

-- CreateIndex
CREATE INDEX "files_tenant_id_classification_idx" ON "files"("tenant_id", "classification");

-- CreateIndex
CREATE INDEX "files_tenant_id_retention_expires_at_idx" ON "files"("tenant_id", "retention_expires_at");

-- CreateIndex
CREATE INDEX "files_tenant_id_on_legal_hold_idx" ON "files"("tenant_id", "on_legal_hold");

-- CreateIndex
CREATE UNIQUE INDEX "files_tenant_id_id_key" ON "files"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "knowledge_sources_tenant_id_state_idx" ON "knowledge_sources"("tenant_id", "state");

-- CreateIndex
CREATE INDEX "knowledge_sources_tenant_id_access_scope_idx" ON "knowledge_sources"("tenant_id", "access_scope");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_sources_tenant_id_id_key" ON "knowledge_sources"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_sources_tenant_id_name_key" ON "knowledge_sources"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "knowledge_source_files_tenant_id_file_id_idx" ON "knowledge_source_files"("tenant_id", "file_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_source_files_tenant_id_knowledge_source_id_file_i_key" ON "knowledge_source_files"("tenant_id", "knowledge_source_id", "file_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_knowledge_policies_tenant_id_key" ON "company_knowledge_policies"("tenant_id");

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "connections"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_source_files" ADD CONSTRAINT "knowledge_source_files_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_source_files" ADD CONSTRAINT "knowledge_source_files_tenant_id_knowledge_source_id_fkey" FOREIGN KEY ("tenant_id", "knowledge_source_id") REFERENCES "knowledge_sources"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_source_files" ADD CONSTRAINT "knowledge_source_files_tenant_id_file_id_fkey" FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_knowledge_policies" ADD CONSTRAINT "company_knowledge_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security
--
-- All four tables are strictly tenant-owned. A file, a knowledge source and a company's upload
-- policy each belong to exactly one company, and there is no platform-plane row — so there is no
-- query shape that could return another company's document.
-- ===========================================================================

ALTER TABLE "files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "files" FORCE ROW LEVEL SECURITY;
CREATE POLICY files_tenant_isolation ON "files"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "knowledge_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_sources" FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_sources_tenant_isolation ON "knowledge_sources"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "knowledge_source_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_source_files" FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_source_files_tenant_isolation ON "knowledge_source_files"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "company_knowledge_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_knowledge_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_knowledge_policies_tenant_isolation ON "company_knowledge_policies"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR NULLIF(current_setting('app.platform_operation', true), '') = 'on'
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "files" TO "uboss_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "knowledge_sources" TO "uboss_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "knowledge_source_files" TO "uboss_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "company_knowledge_policies" TO "uboss_app";

-- ===========================================================================
-- A file is what it says it is
-- ===========================================================================

-- **A file that has not been scanned clean holds no storage reference nobody may follow.**
--
-- The application decides this in `fileIsUsable`; the database's half is narrower and stronger:
-- a row cannot record a scan outcome without recording *when* it was scanned, so an
-- "it's clean, trust me" row written by a bug is refused rather than believed.
ALTER TABLE "files"
  ADD CONSTRAINT "scanned_file_records_when_and_by_what"
  CHECK (
    "scan_state" IN ('Pending', 'Scanning')
    OR ("scanned_at" IS NOT NULL AND "scanned_by_real_scanner" IS NOT NULL)
  );

-- A scan outcome names a scanner. `false` is the mock — recorded rather than hidden, for the same
-- reason `produced_by_real_model` is: a compliance report must never present an unscanned file as
-- scanned by a real product.
ALTER TABLE "files"
  ADD CONSTRAINT "unscanned_file_claims_no_scanner"
  CHECK ("scan_state" NOT IN ('Pending', 'Scanning') OR "scanned_by_real_scanner" IS NULL);

-- Size is a positive whole number of bytes. A zero-byte file is an upload that failed.
ALTER TABLE "files"
  ADD CONSTRAINT "file_has_a_size"
  CHECK ("size_bytes" > 0);

-- **A deleted file holds no storage reference.** Otherwise "deleted" would mean a row pointing at
-- content that is still there, and a company that asked for a deletion would not have got one.
-- The row survives with its name, its dates and its reason, because "what was deleted, when and
-- why" is a governance question.
ALTER TABLE "files"
  ADD CONSTRAINT "deleted_file_keeps_no_storage_reference"
  CHECK ("deleted_at" IS NULL OR "storage_ref" IS NULL);

-- A deletion is explained and attributed, in all directions.
ALTER TABLE "files"
  ADD CONSTRAINT "file_deletion_is_explained"
  CHECK (
    ("deleted_at" IS NULL AND "deleted_reason" IS NULL AND "deleted_by_user_id" IS NULL)
    OR ("deleted_at" IS NOT NULL AND "deleted_reason" IS NOT NULL AND "deleted_by_user_id" IS NOT NULL)
  );

-- **A legal hold is attributed and reasoned, or it is not a hold.**
--
-- A hold with no reason cannot be reviewed, and a hold with no author cannot be lifted by anybody
-- who knows why it was placed. Both directions, so lifting a hold clears all three.
ALTER TABLE "files"
  ADD CONSTRAINT "legal_hold_is_attributed_and_reasoned"
  CHECK (
    ("on_legal_hold" = false AND "legal_hold_reason" IS NULL AND "legal_hold_placed_at" IS NULL
      AND "legal_hold_placed_by_user_id" IS NULL)
    OR ("on_legal_hold" = true AND "legal_hold_reason" IS NOT NULL
      AND "legal_hold_placed_at" IS NOT NULL AND "legal_hold_placed_by_user_id" IS NOT NULL)
  );

-- **A file under a legal hold cannot be deleted.** The application refuses it, and so does this —
-- a hold exists precisely to stop a deletion every other rule would permit, so the rule belongs
-- where a bug cannot walk around it.
ALTER TABLE "files"
  ADD CONSTRAINT "held_file_is_not_deleted"
  CHECK ("on_legal_hold" = false OR "deleted_at" IS NULL);

-- ===========================================================================
-- A knowledge source is scoped and approved
-- ===========================================================================

-- A department-scoped source names its department. One with no department has no scope to be
-- visible in, and a read that treated the null as a match would make it visible everywhere.
ALTER TABLE "knowledge_sources"
  ADD CONSTRAINT "department_source_names_its_department"
  CHECK ("access_scope" <> 'Department' OR "department_id" IS NOT NULL);

-- A named-agents source names at least one agent, or nothing can ever read it.
--
-- **`COALESCE` is load-bearing.** `array_length` on an empty array returns NULL, and a CHECK whose
-- expression is NULL passes — so the obvious `array_length(...) >= 1` accepted precisely the row
-- it was written to refuse. Third appearance of this failure mode in this schema (Prompt 14's
-- `array_length`, Prompt 22's `jsonb_typeof`), and the probe is the only reason it was noticed.
ALTER TABLE "knowledge_sources"
  ADD CONSTRAINT "named_agents_source_names_an_agent"
  CHECK (
    "access_scope" <> 'NamedAgentsOnly'
    OR COALESCE(array_length("named_agent_ids", 1), 0) >= 1
  );

-- An approval is attributed in both directions.
ALTER TABLE "knowledge_sources"
  ADD CONSTRAINT "knowledge_source_approval_is_attributed"
  CHECK (("approved_at" IS NULL) = ("approved_by_user_id" IS NULL));

-- An approved source has been approved. Stated because the state column and the approval columns
-- are written together and a bug that set one without the other would leave a source consultable
-- with nobody's name on the decision.
ALTER TABLE "knowledge_sources"
  ADD CONSTRAINT "approved_source_records_its_approval"
  CHECK ("state" <> 'Approved' OR "approved_at" IS NOT NULL);

-- A retirement says why.
ALTER TABLE "knowledge_sources"
  ADD CONSTRAINT "retired_source_says_why"
  CHECK ("state" <> 'Retired' OR length(btrim(COALESCE("retired_reason", ''))) > 0);

-- A connection-backed source names its connection.
ALTER TABLE "knowledge_sources"
  ADD CONSTRAINT "connection_source_names_its_connection"
  CHECK ("kind" <> 'Connection' OR "connection_id" IS NOT NULL);

-- ===========================================================================
-- The policy is coherent
-- ===========================================================================

ALTER TABLE "company_knowledge_policies"
  ADD CONSTRAINT "upload_limit_is_sane"
  CHECK ("max_upload_bytes" > 0 AND "max_upload_bytes" <= 262144000);

ALTER TABLE "company_knowledge_policies"
  ADD CONSTRAINT "knowledge_retention_is_a_sane_number_of_days"
  CHECK ("default_retention_days" IS NULL
         OR ("default_retention_days" >= 1 AND "default_retention_days" <= 3650));

-- **External egress can never be looser than an internal export.**
--
-- The one cross-field rule in this policy, and the one a company could get wrong in a way nobody
-- would notice: permitting `Restricted` out of the company while only permitting `Confidential`
-- to be exported inside it would mean the stricter boundary was the internal one. The order is
-- `Public < Internal < Confidential < Restricted`, so the comparison is spelled out rather than
-- computed.
ALTER TABLE "company_knowledge_policies"
  ADD CONSTRAINT "egress_is_no_looser_than_export"
  CHECK (
    CASE "external_egress_ceiling"
      WHEN 'Public' THEN 0 WHEN 'Internal' THEN 1
      WHEN 'Confidential' THEN 2 WHEN 'Restricted' THEN 3 ELSE 99
    END
    <=
    CASE "export_ceiling"
      WHEN 'Public' THEN 0 WHEN 'Internal' THEN 1
      WHEN 'Confidential' THEN 2 WHEN 'Restricted' THEN 3 ELSE 99
    END
  );

-- ===========================================================================
-- A source never becomes more sensitive than its approval
-- ===========================================================================

-- **A file cannot be added to a source approved at a lower classification.**
--
-- A source approved to hold `Internal` material that later acquires a `Confidential` file is a
-- source whose approval no longer covers its contents — and every read decision downstream trusts
-- the source's classification. A trigger rather than a CHECK because the comparison spans two
-- tables.
CREATE OR REPLACE FUNCTION uboss_knowledge_file_is_within_source_classification()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  file_rank integer;
  source_rank integer;
  file_class text;
  source_class text;
BEGIN
  SELECT "classification" INTO file_class FROM "files"
    WHERE "id" = NEW."file_id" AND "tenant_id" = NEW."tenant_id";
  SELECT "classification" INTO source_class FROM "knowledge_sources"
    WHERE "id" = NEW."knowledge_source_id" AND "tenant_id" = NEW."tenant_id";

  file_rank := CASE file_class
    WHEN 'Public' THEN 0 WHEN 'Internal' THEN 1
    WHEN 'Confidential' THEN 2 WHEN 'Restricted' THEN 3 ELSE 99 END;
  source_rank := CASE source_class
    WHEN 'Public' THEN 0 WHEN 'Internal' THEN 1
    WHEN 'Confidential' THEN 2 WHEN 'Restricted' THEN 3 ELSE 99 END;

  IF file_rank > source_rank THEN
    RAISE EXCEPTION
      'This knowledge source is approved to hold % material and that file is %. Reclassify the '
      'source — and have it approved again — before adding it.',
      source_class, file_class
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "uboss_knowledge_file_is_within_source_classification"
  BEFORE INSERT OR UPDATE ON "knowledge_source_files"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_knowledge_file_is_within_source_classification();
