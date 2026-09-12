-- ===========================================================================
-- Prompt 40A (CR-03) — permission-controlled build/operate, the Job Method
-- file flow, employee photos and Workspace Chat
-- ===========================================================================
--
-- ## What is *not* here, and that is most of the amendment
--
-- §1 and §2 are the largest part of CR-03 by consequence and they need **no schema at all**.
-- Making a standard Employee operations-only is a change to the role template in
-- `packages/types/src/role-templates.ts`; hiding the two BUILDERS screens is the same absent grant
-- the route guard refuses on, because `visibleModules` is derived from whatever a person holds. The
-- business-friendly Access & Permissions step expands into the existing grants. And four of the
-- five people around an agent were already columns on `engine_agents` — creator, configurator,
-- owner and activator — with the approver on the `ApprovalRequest` where approval decisions have
-- always lived.
--
-- So what lands here is only what genuinely had nowhere to go: who may *operate* an agent, the Job
-- Method artifact, a photo, and chat.
--
-- ## Files are files
--
-- A photo and a chat attachment are both rows in `files` with a pointer to them. That was a
-- deliberate choice over bespoke columns: it inherits the storage abstraction (CR-03 asks for
-- exactly that — "not base64 in normal DB fields"), the size validation, the malware scan, the
-- classification, the retention rules and the audit trail. A second file pipeline "just for chat"
-- is how one upload path in a product ends up being the unscanned one.

-- ---------------------------------------------------------------------------
-- §2 — the one new column on engine_agents
-- ---------------------------------------------------------------------------

ALTER TABLE "engine_agents" ADD COLUMN     "built_for_user_id" UUID;

-- ---------------------------------------------------------------------------
-- §3 — the employee photo
-- ---------------------------------------------------------------------------

CREATE TABLE "employee_photos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "stored_file_id" UUID NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "employee_photos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "employee_photos_tenant_id_stored_file_id_idx" ON "employee_photos"("tenant_id", "stored_file_id");

-- One photo per person per company. Replacing means replacing rather than accumulating —
-- otherwise "remove my photo" would leave earlier ones reachable by id, which is the opposite of
-- what somebody asking for that means.
CREATE UNIQUE INDEX "one_photo_per_person_per_company" ON "employee_photos"("tenant_id", "user_id");

ALTER TABLE "employee_photos" ADD CONSTRAINT "employee_photos_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_photos" ADD CONSTRAINT "employee_photos_stored_file_id_fkey" FOREIGN KEY ("stored_file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- §5 — who may operate an agent
-- ---------------------------------------------------------------------------

CREATE TABLE "engine_agent_operators" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "engine_agent_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "shared_by_user_id" UUID NOT NULL,
    "shared_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_user_id" UUID,
    CONSTRAINT "engine_agent_operators_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "engine_agent_operators_tenant_id_user_id_revoked_at_idx" ON "engine_agent_operators"("tenant_id", "user_id", "revoked_at");
CREATE UNIQUE INDEX "one_share_per_person_per_agent" ON "engine_agent_operators"("tenant_id", "engine_agent_id", "user_id");

ALTER TABLE "engine_agent_operators" ADD CONSTRAINT "engine_agent_operators_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "engine_agent_operators" ADD CONSTRAINT "engine_agent_operators_engine_agent_id_fkey" FOREIGN KEY ("engine_agent_id") REFERENCES "engine_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A withdrawn share says who withdrew it and when, or neither. "This person could run this, until
-- this date" is what an access review asks for, and a half-recorded revocation cannot answer it.
ALTER TABLE "engine_agent_operators"
  ADD CONSTRAINT "revoked_share_is_attributed"
  CHECK (COALESCE(("revoked_at" IS NULL) = ("revoked_by_user_id" IS NULL), false));

-- ---------------------------------------------------------------------------
-- §4 — the Job Method
-- ---------------------------------------------------------------------------

CREATE TABLE "job_methods" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ai_work_assignment_id" UUID NOT NULL,
    "objective_version_id" UUID NOT NULL,
    "form_version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "job_methods_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "job_methods_tenant_id_objective_version_id_idx" ON "job_methods"("tenant_id", "objective_version_id");

-- One per assignment. A second would leave two answers to "how is this work done" with nothing to
-- say which is current — and the import path would have to guess.
CREATE UNIQUE INDEX "one_job_method_per_assignment" ON "job_methods"("tenant_id", "ai_work_assignment_id");

ALTER TABLE "job_methods" ADD CONSTRAINT "job_methods_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "job_methods"
  ADD CONSTRAINT "job_method_form_version_is_positive"
  CHECK (COALESCE("form_version" > 0, false));

CREATE TABLE "job_method_rows" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "job_method_id" UUID NOT NULL,
    "step" INTEGER NOT NULL,
    "what_exact_work" VARCHAR(2000),
    "input_exact_input" VARCHAR(2000),
    "where_input_source" VARCHAR(2000),
    "tool_system_workplace" VARCHAR(2000),
    "how_exact_method" VARCHAR(2000),
    "rule_formula_check" VARCHAR(2000),
    "output" VARCHAR(2000),
    "output_destination" VARCHAR(2000),
    "approval" VARCHAR(2000),
    "agent_must_never_do" VARCHAR(2000),
    "if_missing_or_wrong" VARCHAR(2000),
    "time" VARCHAR(2000),
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "job_method_rows_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "job_method_rows_tenant_id_job_method_id_idx" ON "job_method_rows"("tenant_id", "job_method_id");
CREATE UNIQUE INDEX "one_row_per_step" ON "job_method_rows"("job_method_id", "step");

ALTER TABLE "job_method_rows" ADD CONSTRAINT "job_method_rows_job_method_id_fkey" FOREIGN KEY ("job_method_id") REFERENCES "job_methods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 1-based, as the person filling in the form counts. A step 0 or -1 would sort before everything
-- and read as a header row that had been imported by accident.
ALTER TABLE "job_method_rows"
  ADD CONSTRAINT "job_method_step_is_one_based"
  CHECK (COALESCE("step" >= 1, false));

-- **Every cell is deliberately nullable, and there is deliberately no "row must be filled in"
-- constraint.** A partially completed form is the normal case: the person filling it in may not
-- know the tool, and there may be no approval step. Requiring all thirteen would push people into
-- typing "n/a" thirteen times, and "n/a" is worse than an empty cell because it cannot be told
-- apart from a real answer. The import flags what is missing instead, and the flags travel with
-- the draft.

CREATE TABLE "job_method_imports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "job_method_id" UUID NOT NULL,
    "filename" VARCHAR(400) NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "claimed_form_version" INTEGER,
    "stage" VARCHAR(30) NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "refused_because" VARCHAR(2000),
    "problems" JSONB NOT NULL DEFAULT '[]',
    "rows_read" INTEGER NOT NULL DEFAULT 0,
    "rows_accepted" INTEGER NOT NULL DEFAULT 0,
    "imported_by_user_id" UUID NOT NULL,
    "imported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "job_method_imports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "job_method_imports_tenant_id_job_method_id_imported_at_idx" ON "job_method_imports"("tenant_id", "job_method_id", "imported_at");

ALTER TABLE "job_method_imports" ADD CONSTRAINT "job_method_imports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "job_method_imports" ADD CONSTRAINT "job_method_imports_job_method_id_fkey" FOREIGN KEY ("job_method_id") REFERENCES "job_methods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A refused import says why, and an accepted one does not pretend to have been refused.
--
-- The **refused** row is the more valuable record: "I sent that form in three weeks ago" is
-- answered by a row saying it arrived, which version it claimed, and why it was not applied. A
-- refusal with no reason would be a dead end for the person who filled the form in.
ALTER TABLE "job_method_imports"
  ADD CONSTRAINT "refused_import_says_why"
  CHECK (COALESCE(
    ("accepted" AND "refused_because" IS NULL)
    OR (NOT "accepted" AND "refused_because" IS NOT NULL),
    false
  ));

-- The stage it reached, from `IMPORT_STAGES`. Enumerated here **knowing what that costs**: this is
-- the fourth CHECK in this schema that lists a set (Prompts 25, 34, 40, and this), and every one of
-- the first three silently became incomplete when the set grew. Kept anyway, for the same reason:
-- it is what stops a typo becoming a row no screen can render, and a closed set is only closed if
-- something closes it. If a stage is added, this constraint is part of the work.
ALTER TABLE "job_method_imports"
  ADD CONSTRAINT "import_stage_is_known"
  CHECK ("stage" IN ('ValidateFile', 'VerifyLinkage', 'ParseRows', 'MapFields', 'FlagProblems',
                     'Review', 'MergeIntoDraft'));

ALTER TABLE "job_method_imports"
  ADD CONSTRAINT "import_row_counts_agree"
  CHECK (COALESCE("rows_accepted" >= 0 AND "rows_read" >= "rows_accepted", false));

-- ---------------------------------------------------------------------------
-- §6 — Workspace Chat
-- ---------------------------------------------------------------------------

CREATE TABLE "chat_conversations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "title" VARCHAR(120),
    "direct_key" VARCHAR(120),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_conversations_tenant_id_last_message_at_idx" ON "chat_conversations"("tenant_id", "last_message_at");

-- **The index that prevents the bug nobody would diagnose.** Two people who message each other at
-- the same moment would otherwise get two direct conversations and each would see half the
-- history — which presents as lost messages. `direct_key` is the two ids sorted and joined, so
-- "Alice and Bob" and "Bob and Alice" collide here rather than diverging in the UI.
--
-- NULL for a group conversation, and Postgres treats NULLs in a unique index as distinct, so any
-- number of groups coexist.
CREATE UNIQUE INDEX "one_direct_conversation_per_pair" ON "chat_conversations"("tenant_id", "direct_key");

ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_conversations"
  ADD CONSTRAINT "conversation_kind_is_known"
  CHECK ("kind" IN ('Direct', 'Group'));

-- A direct message has no name and does have a pair key; a group has a name and no pair key.
-- Without this, a `Direct` row with a NULL `direct_key` would escape the unique index above and
-- become the duplicate conversation it exists to prevent.
ALTER TABLE "chat_conversations"
  ADD CONSTRAINT "conversation_shape_matches_its_kind"
  CHECK (COALESCE(
    ("kind" = 'Direct' AND "direct_key" IS NOT NULL AND "title" IS NULL)
    OR ("kind" = 'Group' AND "direct_key" IS NULL AND "title" IS NOT NULL),
    false
  ));

CREATE TABLE "chat_participants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(6),
    "last_read_at" TIMESTAMPTZ(6),
    CONSTRAINT "chat_participants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_participants_tenant_id_user_id_idx" ON "chat_participants"("tenant_id", "user_id");
CREATE UNIQUE INDEX "one_participant_row_per_person" ON "chat_participants"("conversation_id", "user_id");

ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_participants"
  ADD CONSTRAINT "participant_left_after_joining"
  CHECK (COALESCE("left_at" IS NULL OR "left_at" >= "joined_at", true));

CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "body" VARCHAR(4000) NOT NULL,
    "mentioned_user_ids" UUID[],
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_messages_conversation_id_sent_at_idx" ON "chat_messages"("conversation_id", "sent_at");
CREATE INDEX "chat_messages_tenant_id_sent_at_idx" ON "chat_messages"("tenant_id", "sent_at");

ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A deleted message keeps its row so the conversation keeps its shape and the reply beneath it
-- still makes sense — but it must not keep its text. The service blanks the body; this is what
-- makes that a guarantee rather than a habit.
ALTER TABLE "chat_messages"
  ADD CONSTRAINT "deleted_message_keeps_no_text"
  CHECK (COALESCE("deleted_at" IS NULL OR "body" = '', true));

CREATE TABLE "chat_message_attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "stored_file_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_message_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_message_attachments_tenant_id_stored_file_id_idx" ON "chat_message_attachments"("tenant_id", "stored_file_id");
CREATE UNIQUE INDEX "one_attachment_row_per_file" ON "chat_message_attachments"("message_id", "stored_file_id");

ALTER TABLE "chat_message_attachments" ADD CONSTRAINT "chat_message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_message_attachments" ADD CONSTRAINT "chat_message_attachments_stored_file_id_fkey" FOREIGN KEY ("stored_file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "chat_context_refs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "context_type" VARCHAR(40) NOT NULL,
    "resource_id" UUID NOT NULL,
    "added_by_user_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_context_refs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_context_refs_tenant_id_context_type_resource_id_idx" ON "chat_context_refs"("tenant_id", "context_type", "resource_id");
CREATE UNIQUE INDEX "one_reference_per_resource" ON "chat_context_refs"("conversation_id", "context_type", "resource_id");

ALTER TABLE "chat_context_refs" ADD CONSTRAINT "chat_context_refs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- **The table has a type and an id and nothing else, and the absence is the design.**
--
-- No cached title, no cached status, no cached summary. A cached title would be a copy of the
-- resource's content sitting outside its own authorization: the moment it is stored, anybody who
-- can read the conversation can read it, and no permission check ever runs again. It would also go
-- stale — so it would be a leak *and* wrong.
--
-- Every preview is resolved against the viewer's own permissions at read time. Chat membership
-- grants no access to the referenced resource; that is the one rule this whole feature is built
-- around.
ALTER TABLE "chat_context_refs"
  ADD CONSTRAINT "context_type_is_known"
  CHECK ("context_type" IN ('Objective', 'HumanTask', 'EngineAgent', 'AgentRun',
                            'ApprovalRequest', 'ExecutorException'));

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- Every one of these tables holds rows belonging to exactly one company, so every policy is the
-- **strict** form — no NULL-tenant allowance of the kind `provider_profiles` needs for shared
-- platform configuration. `NULL = <tenant>` is NULL, which fails, so the strict form is also the
-- fail-closed form.
--
-- `chat_participants`, `chat_messages`, `chat_message_attachments` and `chat_context_refs` each
-- carry their own `tenant_id` rather than relying on the conversation's. Joining to the parent for
-- every policy evaluation would be slower and, more importantly, a query that forgot the join
-- would silently see everything.

ALTER TABLE "employee_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_photos" FORCE ROW LEVEL SECURITY;
CREATE POLICY "employee_photos_tenant_isolation" ON "employee_photos"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "engine_agent_operators" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "engine_agent_operators" FORCE ROW LEVEL SECURITY;
CREATE POLICY "engine_agent_operators_tenant_isolation" ON "engine_agent_operators"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "job_methods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_methods" FORCE ROW LEVEL SECURITY;
CREATE POLICY "job_methods_tenant_isolation" ON "job_methods"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "job_method_rows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_method_rows" FORCE ROW LEVEL SECURITY;
CREATE POLICY "job_method_rows_tenant_isolation" ON "job_method_rows"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "job_method_imports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_method_imports" FORCE ROW LEVEL SECURITY;
CREATE POLICY "job_method_imports_tenant_isolation" ON "job_method_imports"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "chat_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_conversations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "chat_conversations_tenant_isolation" ON "chat_conversations"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "chat_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_participants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "chat_participants_tenant_isolation" ON "chat_participants"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "chat_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "chat_messages_tenant_isolation" ON "chat_messages"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "chat_message_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_message_attachments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "chat_message_attachments_tenant_isolation" ON "chat_message_attachments"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "chat_context_refs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_context_refs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "chat_context_refs_tenant_isolation" ON "chat_context_refs"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- Full DML on all nine. Every one of these is the company's own working content — a photo they can
-- remove, a Job Method they can re-import, a conversation they can leave — and a company exit has
-- to be able to delete all of it. The Prompt 38 tables that deliberately withhold DELETE withhold
-- it because deleting them would destroy an accountability record; none of these is one.
--
-- Soft deletion where it matters is a **service** decision, not a privilege one:
-- `chat_messages.deleted_at` keeps the row so the conversation keeps its shape, and
-- `engine_agent_operators.revoked_at` keeps the fact that somebody once had access. Both are
-- enforced by constraints above rather than by withholding a grant, because withholding DELETE
-- would also stop the exit sequence.

GRANT SELECT, INSERT, UPDATE, DELETE ON "employee_photos" TO "uboss_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "engine_agent_operators" TO "uboss_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "job_methods" TO "uboss_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "job_method_rows" TO "uboss_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "job_method_imports" TO "uboss_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "chat_conversations" TO "uboss_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "chat_participants" TO "uboss_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "chat_messages" TO "uboss_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "chat_message_attachments" TO "uboss_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "chat_context_refs" TO "uboss_app";
