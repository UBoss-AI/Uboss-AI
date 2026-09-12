-- CreateTable
CREATE TABLE "objective_workflow_drafts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "objective_id" UUID NOT NULL,
    "objective_version_id" UUID NOT NULL,
    "seeded_from_run_id" UUID,
    "graph" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "assigned_at" TIMESTAMPTZ(6),
    "assigned_by_user_id" UUID,
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "objective_workflow_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "objective_workflow_drafts_tenant_id_objective_id_idx" ON "objective_workflow_drafts"("tenant_id", "objective_id");

-- CreateIndex
CREATE UNIQUE INDEX "objective_workflow_drafts_tenant_id_objective_version_id_key" ON "objective_workflow_drafts"("tenant_id", "objective_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "objective_analysis_runs_tenant_id_id_key" ON "objective_analysis_runs"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "objective_workflow_drafts" ADD CONSTRAINT "objective_workflow_drafts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_workflow_drafts" ADD CONSTRAINT "objective_workflow_drafts_tenant_id_objective_id_fkey" FOREIGN KEY ("tenant_id", "objective_id") REFERENCES "objectives"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_workflow_drafts" ADD CONSTRAINT "objective_workflow_drafts_tenant_id_objective_version_id_fkey" FOREIGN KEY ("tenant_id", "objective_version_id") REFERENCES "objective_versions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_workflow_drafts" ADD CONSTRAINT "objective_workflow_drafts_tenant_id_seeded_from_run_id_fkey" FOREIGN KEY ("tenant_id", "seeded_from_run_id") REFERENCES "objective_analysis_runs"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- ===========================================================================
-- Prompt 22 — the manager-editable workflow draft
-- ===========================================================================
-- The AI's proposal and the manager's plan are two different records, by client decision:
-- `objective_analysis_runs` stays frozen as the historical AI proposal, and this table holds the
-- plan the manager actually edits. Keeping them apart means "what did the AI suggest?" and "what
-- did we decide?" both remain answerable a year later, which a single mutable row would lose.

-- ---------------------------------------------------------------------------
-- 1. Tenant isolation
-- ---------------------------------------------------------------------------
-- Symmetric, like every other company-owned table: this holds who does what work, and it is
-- never platform-shared. `FORCE` applies the policy to the table owner too, so a migration or a
-- console session cannot quietly read across tenants.

ALTER TABLE "objective_workflow_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "objective_workflow_drafts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "objective_workflow_drafts_tenant_isolation" ON "objective_workflow_drafts"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- ---------------------------------------------------------------------------
-- 2. A stored graph is actually a graph
-- ---------------------------------------------------------------------------
-- The column is `jsonb`, which by itself permits `4`, `"hello"` and `null`. A row that stores one
-- of those does not fail on write; it fails much later when a screen tries to draw it. The whole
-- point of putting the plan in JSON is that its shape is enforced in code — so the database
-- guards the part code cannot recover from: that the top-level object and its two collections
-- exist at all.

ALTER TABLE "objective_workflow_drafts"
  ADD CONSTRAINT "workflow_draft_graph_is_an_object"
  CHECK (jsonb_typeof("graph") = 'object');

ALTER TABLE "objective_workflow_drafts"
  ADD CONSTRAINT "workflow_draft_graph_has_nodes_and_edges"
  CHECK (jsonb_typeof("graph" -> 'nodes') = 'array'
         AND jsonb_typeof("graph" -> 'edges') = 'array');

-- A plan with no nodes is not a plan. The Goal alone is one node, so one is the real floor.
ALTER TABLE "objective_workflow_drafts"
  ADD CONSTRAINT "workflow_draft_has_at_least_one_node"
  CHECK (jsonb_array_length("graph" -> 'nodes') >= 1);

-- ---------------------------------------------------------------------------
-- 3. A draft never loses its schema version
-- ---------------------------------------------------------------------------
-- Same reasoning as the analysis run: stored JSON outlives the code that wrote it. A draft whose
-- version is missing cannot be safely upgraded on read, and silently guessing v1 would invent
-- content for parts v1 never recorded.

ALTER TABLE "objective_workflow_drafts"
  ADD CONSTRAINT "workflow_draft_schema_version_is_positive"
  CHECK ("schema_version" >= 1);

-- ---------------------------------------------------------------------------
-- 4. The revision is a real optimistic-concurrency token
-- ---------------------------------------------------------------------------
-- Two managers editing one plan is an ordinary situation, and last-write-wins is the wrong answer
-- for a document that decides what people are told to do. The service refuses a stale revision;
-- these keep the token itself trustworthy, so a bug cannot rewind it and make a stale write look
-- current.

ALTER TABLE "objective_workflow_drafts"
  ADD CONSTRAINT "workflow_draft_revision_starts_at_one"
  CHECK ("revision" >= 1);

CREATE OR REPLACE FUNCTION uboss_workflow_draft_revision_never_goes_backwards()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."revision" < OLD."revision" THEN
    RAISE EXCEPTION
      'Workflow draft % cannot move from revision % back to revision %. The revision is how a '
      'stale edit is detected; rewinding it would let one manager silently overwrite another.',
      OLD."id", OLD."revision", NEW."revision"
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "uboss_workflow_draft_revision_never_goes_backwards"
  BEFORE UPDATE ON "objective_workflow_drafts"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_workflow_draft_revision_never_goes_backwards();

-- ---------------------------------------------------------------------------
-- 5. Assignment is attributed, and freezes the plan
-- ---------------------------------------------------------------------------
-- "Who assigned this work to me" is the first question an employee asks, so a timestamp with no
-- actor is a half-record.

ALTER TABLE "objective_workflow_drafts"
  ADD CONSTRAINT "workflow_draft_assignment_is_attributed"
  CHECK (("assigned_at" IS NULL) = ("assigned_by_user_id" IS NULL));

-- Once assigned, the graph is frozen. This is the same rule as a live Objective version, for the
-- same reason: people are already working to this plan, and editing it underneath them is exactly
-- what versioning exists to prevent. An authorised change opens a new Objective version, which
-- gets its own draft row — it never rewrites the one people are working to.
--
-- The service refuses the edit first, with a readable message. This is the backstop, so that a
-- future caller that forgets the check cannot quietly rewrite assigned work.

CREATE OR REPLACE FUNCTION uboss_assigned_workflow_draft_is_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."assigned_at" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."graph" IS DISTINCT FROM OLD."graph"
     OR NEW."schema_version" IS DISTINCT FROM OLD."schema_version"
     OR NEW."objective_version_id" IS DISTINCT FROM OLD."objective_version_id"
     OR NEW."objective_id" IS DISTINCT FROM OLD."objective_id"
     OR NEW."seeded_from_run_id" IS DISTINCT FROM OLD."seeded_from_run_id"
     OR NEW."assigned_at" IS DISTINCT FROM OLD."assigned_at"
     OR NEW."assigned_by_user_id" IS DISTINCT FROM OLD."assigned_by_user_id"
  THEN
    RAISE EXCEPTION
      'Workflow draft % was assigned at % and can no longer be edited. People are already '
      'working to this plan; an authorised change creates a new Objective version.',
      OLD."id", OLD."assigned_at"
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "uboss_assigned_workflow_draft_is_immutable"
  BEFORE UPDATE ON "objective_workflow_drafts"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_assigned_workflow_draft_is_immutable();
