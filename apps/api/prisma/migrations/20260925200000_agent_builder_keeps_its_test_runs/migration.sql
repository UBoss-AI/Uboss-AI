-- Agent Builder keeps its test runs.
--
-- Before this, testing an agent wrote four columns onto the assignment and overwrote them next
-- time. That answered "is it ready" and threw away the only thing an admin actually wants to look
-- at: what they put in, what came out, and whether the run before this one was any different.
--
-- The columns on `ai_work_assignments` stay exactly as they were. They are what the readiness
-- banner reads. This table is the evidence behind that banner, not a replacement for it.

CREATE TABLE "agent_builder_test_runs" (
  "id"                    UUID           NOT NULL,
  "tenant_id"             UUID           NOT NULL,
  "ai_work_assignment_id" UUID           NOT NULL,
  "sample_input"          TEXT           NOT NULL,
  "expected_outcome"      TEXT,
  "output"                TEXT,
  "status"                VARCHAR(20)    NOT NULL,
  "warnings"              JSONB          NOT NULL DEFAULT '[]'::jsonb,
  "errors"                JSONB          NOT NULL DEFAULT '[]'::jsonb,
  "duration_ms"           INTEGER        NOT NULL,
  "was_real"              BOOLEAN        NOT NULL DEFAULT false,
  "capability"            VARCHAR(60),
  "ran_by_user_id"        UUID           NOT NULL,
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_builder_test_runs_pkey" PRIMARY KEY ("id")
);

-- The same-tenant composite key every other table here declares, so a child row can never point at
-- a parent in another company.
CREATE UNIQUE INDEX "agent_builder_test_runs_tenant_id_id_key"
  ON "agent_builder_test_runs" ("tenant_id", "id");

-- How the history is read: newest first, for one agent.
CREATE INDEX "agent_builder_test_runs_history_idx"
  ON "agent_builder_test_runs" ("tenant_id", "ai_work_assignment_id", "created_at" DESC);

ALTER TABLE "agent_builder_test_runs"
  ADD CONSTRAINT "agent_builder_test_runs_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Cascade: a test run is evidence about one agent's draft and has no meaning once that draft is
-- gone. This is not audit history -- `audit_events` records that the test happened, and that
-- record is not touched by this.
ALTER TABLE "agent_builder_test_runs"
  ADD CONSTRAINT "agent_builder_test_runs_assignment_fk"
  FOREIGN KEY ("tenant_id", "ai_work_assignment_id")
  REFERENCES "ai_work_assignments" ("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A user is global -- `users` has no tenant column, because a person keeps one identity
-- across companies and belongs to each through `tenant_memberships`. The single-column key is
-- therefore the only one available here; tenant isolation on this table comes from its own
-- `tenant_id` and the policy below, not from this reference.
ALTER TABLE "agent_builder_test_runs"
  ADD CONSTRAINT "agent_builder_test_runs_ran_by_fk"
  FOREIGN KEY ("ran_by_user_id") REFERENCES "users" ("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Three outcomes and no others. `Failed` is the agent producing nothing usable; `Error` is the
-- test not completing. Keeping them apart is the point: an infrastructure problem must never be
-- readable as the work being impossible.
ALTER TABLE "agent_builder_test_runs"
  ADD CONSTRAINT "agent_builder_test_run_status_is_known"
  CHECK ("status" IN ('Passed', 'Failed', 'Error'));

-- A pass has no errors, and a failure of either kind has at least one. Without this a row could
-- claim success while carrying the reason it did not succeed, and the screen would print both.
ALTER TABLE "agent_builder_test_runs"
  ADD CONSTRAINT "agent_builder_test_run_errors_agree_with_status"
  CHECK (
    COALESCE(
      ("status" = 'Passed' AND jsonb_array_length("errors") = 0)
      OR ("status" IN ('Failed', 'Error') AND jsonb_array_length("errors") > 0),
      false
    )
  );

-- Both arrays are arrays. JSONB would otherwise accept a bare string here and the screen would
-- iterate its characters.
ALTER TABLE "agent_builder_test_runs"
  ADD CONSTRAINT "agent_builder_test_run_lists_are_lists"
  CHECK (jsonb_typeof("warnings") = 'array' AND jsonb_typeof("errors") = 'array');

-- Time does not run backwards.
ALTER TABLE "agent_builder_test_runs"
  ADD CONSTRAINT "agent_builder_test_run_duration_is_not_negative"
  CHECK ("duration_ms" >= 0);

-- A test run belongs to one company and must never be readable by another. Same policy shape as
-- every other tenant-owned table: the company's own rows, or a declared platform operation.
ALTER TABLE "agent_builder_test_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_builder_test_runs" FORCE ROW LEVEL SECURITY;

CREATE POLICY "agent_builder_test_runs_tenant_isolation" ON "agent_builder_test_runs"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );
