
-- CreateTable
CREATE TABLE "human_tasks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "objective_id" UUID NOT NULL,
    "objective_version_id" UUID NOT NULL,
    "workflow_draft_id" UUID NOT NULL,
    "node_id" VARCHAR(80) NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "assigned_to_user_id" UUID NOT NULL,
    "assigned_by_user_id" UUID NOT NULL,
    "input_description" VARCHAR(2000) NOT NULL DEFAULT '',
    "due_at" TIMESTAMPTZ(6),
    "trigger_description" VARCHAR(300) NOT NULL DEFAULT '',
    "expected_output" VARCHAR(2000) NOT NULL DEFAULT '',
    "evidence_requirement" VARCHAR(2000) NOT NULL DEFAULT '',
    "depends_on_node_ids" TEXT[],
    "approval_kind" VARCHAR(40),
    "status" VARCHAR(40) NOT NULL DEFAULT 'Assigned',
    "started_at" TIMESTAMPTZ(6),
    "submitted_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "blocked_reason" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "human_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "human_task_evidence" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "reference" VARCHAR(500) NOT NULL DEFAULT '',
    "added_by_user_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "human_task_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "human_task_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "body" VARCHAR(4000) NOT NULL,
    "author_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "human_task_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_work_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "objective_id" UUID NOT NULL,
    "objective_version_id" UUID NOT NULL,
    "workflow_draft_id" UUID NOT NULL,
    "node_id" VARCHAR(80) NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "status" VARCHAR(40) NOT NULL DEFAULT 'AwaitingAgentSetup',
    "engine_agent_id" UUID,
    "setup_prefill" JSONB NOT NULL,
    "assigned_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ai_work_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "status" VARCHAR(40) NOT NULL DEFAULT 'Pending',
    "title" VARCHAR(300) NOT NULL,
    "detail" VARCHAR(4000) NOT NULL DEFAULT '',
    "subject_type" VARCHAR(60) NOT NULL,
    "subject_id" UUID,
    "objective_id" UUID,
    "objective_version_id" UUID,
    "workflow_node_id" VARCHAR(80),
    "requested_by_user_id" UUID NOT NULL,
    "named_approver_user_id" UUID,
    "approver_role_kind" VARCHAR(40),
    "due_at" TIMESTAMPTZ(6),
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" VARCHAR(4000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "executor_expectations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "objective_id" UUID NOT NULL,
    "objective_version_id" UUID NOT NULL,
    "node_id" VARCHAR(80) NOT NULL,
    "kind" VARCHAR(60) NOT NULL,
    "subject_type" VARCHAR(60) NOT NULL,
    "subject_id" UUID,
    "detail" VARCHAR(2000) NOT NULL,
    "due_at" TIMESTAMPTZ(6),
    "satisfied_at" TIMESTAMPTZ(6),
    "registered_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "executor_expectations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "human_tasks_tenant_id_assigned_to_user_id_status_idx" ON "human_tasks"("tenant_id", "assigned_to_user_id", "status");

-- CreateIndex
CREATE INDEX "human_tasks_tenant_id_due_at_idx" ON "human_tasks"("tenant_id", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "human_tasks_tenant_id_objective_version_id_node_id_key" ON "human_tasks"("tenant_id", "objective_version_id", "node_id");

-- CreateIndex
CREATE UNIQUE INDEX "human_tasks_tenant_id_id_key" ON "human_tasks"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "human_task_evidence_tenant_id_task_id_idx" ON "human_task_evidence"("tenant_id", "task_id");

-- CreateIndex
CREATE INDEX "human_task_notes_tenant_id_task_id_idx" ON "human_task_notes"("tenant_id", "task_id");

-- CreateIndex
CREATE INDEX "ai_work_assignments_tenant_id_status_idx" ON "ai_work_assignments"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ai_work_assignments_tenant_id_objective_version_id_node_id_key" ON "ai_work_assignments"("tenant_id", "objective_version_id", "node_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_work_assignments_tenant_id_id_key" ON "ai_work_assignments"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "approval_requests_tenant_id_status_type_idx" ON "approval_requests"("tenant_id", "status", "type");

-- CreateIndex
CREATE INDEX "approval_requests_tenant_id_named_approver_user_id_status_idx" ON "approval_requests"("tenant_id", "named_approver_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_tenant_id_id_key" ON "approval_requests"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "executor_expectations_tenant_id_kind_satisfied_at_idx" ON "executor_expectations"("tenant_id", "kind", "satisfied_at");

-- CreateIndex
CREATE UNIQUE INDEX "executor_expectations_tenant_id_objective_version_id_node_i_key" ON "executor_expectations"("tenant_id", "objective_version_id", "node_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "objective_workflow_drafts_tenant_id_id_key" ON "objective_workflow_drafts"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "human_tasks" ADD CONSTRAINT "human_tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_tasks" ADD CONSTRAINT "human_tasks_tenant_id_objective_id_fkey" FOREIGN KEY ("tenant_id", "objective_id") REFERENCES "objectives"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_tasks" ADD CONSTRAINT "human_tasks_tenant_id_objective_version_id_fkey" FOREIGN KEY ("tenant_id", "objective_version_id") REFERENCES "objective_versions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_tasks" ADD CONSTRAINT "human_tasks_tenant_id_workflow_draft_id_fkey" FOREIGN KEY ("tenant_id", "workflow_draft_id") REFERENCES "objective_workflow_drafts"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "human_task_evidence" ADD CONSTRAINT "human_task_evidence_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_task_evidence" ADD CONSTRAINT "human_task_evidence_tenant_id_task_id_fkey" FOREIGN KEY ("tenant_id", "task_id") REFERENCES "human_tasks"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_task_notes" ADD CONSTRAINT "human_task_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_task_notes" ADD CONSTRAINT "human_task_notes_tenant_id_task_id_fkey" FOREIGN KEY ("tenant_id", "task_id") REFERENCES "human_tasks"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_work_assignments" ADD CONSTRAINT "ai_work_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_work_assignments" ADD CONSTRAINT "ai_work_assignments_tenant_id_objective_id_fkey" FOREIGN KEY ("tenant_id", "objective_id") REFERENCES "objectives"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_work_assignments" ADD CONSTRAINT "ai_work_assignments_tenant_id_objective_version_id_fkey" FOREIGN KEY ("tenant_id", "objective_version_id") REFERENCES "objective_versions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_work_assignments" ADD CONSTRAINT "ai_work_assignments_tenant_id_workflow_draft_id_fkey" FOREIGN KEY ("tenant_id", "workflow_draft_id") REFERENCES "objective_workflow_drafts"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_objective_id_fkey" FOREIGN KEY ("tenant_id", "objective_id") REFERENCES "objectives"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_objective_version_id_fkey" FOREIGN KEY ("tenant_id", "objective_version_id") REFERENCES "objective_versions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_expectations" ADD CONSTRAINT "executor_expectations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_expectations" ADD CONSTRAINT "executor_expectations_tenant_id_objective_id_fkey" FOREIGN KEY ("tenant_id", "objective_id") REFERENCES "objectives"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_expectations" ADD CONSTRAINT "executor_expectations_tenant_id_objective_version_id_fkey" FOREIGN KEY ("tenant_id", "objective_version_id") REFERENCES "objective_versions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Prompt 23 — what a published workflow becomes
-- ===========================================================================
-- Six tables, and the reason there are six rather than one: a human task, an AI assignment, an
-- approval and a monitoring expectation have genuinely different lifecycles, and the last two are
-- consumed by prompts that do not exist yet. What they share is the publish transaction that
-- creates them, which is a property of the code, not of the schema.

-- ---------------------------------------------------------------------------
-- 1. Tenant isolation, on all six
-- ---------------------------------------------------------------------------
-- Symmetric and FORCEd, like every other company-owned table. These rows say who is doing what
-- work and what is waiting on whom; nothing here is ever platform-shared.

ALTER TABLE "human_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "human_tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "human_tasks_tenant_isolation" ON "human_tasks"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "human_task_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "human_task_evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "human_task_evidence_tenant_isolation" ON "human_task_evidence"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "human_task_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "human_task_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "human_task_notes_tenant_isolation" ON "human_task_notes"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "ai_work_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_work_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_work_assignments_tenant_isolation" ON "ai_work_assignments"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "approval_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "approval_requests_tenant_isolation" ON "approval_requests"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "executor_expectations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "executor_expectations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "executor_expectations_tenant_isolation" ON "executor_expectations"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- ---------------------------------------------------------------------------
-- 2. A human task's status and its record agree
-- ---------------------------------------------------------------------------

ALTER TABLE "human_tasks"
  ADD CONSTRAINT "human_task_status_is_known"
  CHECK ("status" IN ('Assigned', 'InProgress', 'Blocked', 'NeedsInput', 'WaitingApproval',
                      'Submitted', 'Completed', 'Cancelled'));

ALTER TABLE "human_tasks"
  ADD CONSTRAINT "human_task_approval_kind_is_known"
  CHECK ("approval_kind" IS NULL
         OR "approval_kind" IN ('NotRequired', 'Manager', 'Head', 'FourEyes'));

-- A task nobody can read is not an assignment.
ALTER TABLE "human_tasks"
  ADD CONSTRAINT "human_task_has_a_title"
  CHECK (length(btrim("title")) > 0);

-- The client's UI has a "Blocked reason" field for a reason: "blocked" with no explanation tells
-- the manager nothing and leaves the person no way to be helped.
ALTER TABLE "human_tasks"
  ADD CONSTRAINT "blocked_task_says_why"
  CHECK ("status" <> 'Blocked' OR length(btrim(COALESCE("blocked_reason", ''))) > 0);

-- Each state carries the timestamp that state means. A `Completed` row with no completion time
-- cannot be reported on, and a performance record reads exactly these columns.
ALTER TABLE "human_tasks"
  ADD CONSTRAINT "started_task_records_when"
  CHECK ("status" IN ('Assigned', 'Cancelled') OR "started_at" IS NOT NULL);

ALTER TABLE "human_tasks"
  ADD CONSTRAINT "submitted_task_records_when"
  CHECK ("status" NOT IN ('Submitted', 'Completed') OR "submitted_at" IS NOT NULL);

ALTER TABLE "human_tasks"
  ADD CONSTRAINT "completed_task_records_when"
  CHECK (("status" = 'Completed') = ("completed_at" IS NOT NULL));

ALTER TABLE "human_tasks"
  ADD CONSTRAINT "human_task_timestamps_are_ordered"
  CHECK (("submitted_at" IS NULL OR "started_at" IS NULL OR "submitted_at" >= "started_at")
         AND ("completed_at" IS NULL OR "submitted_at" IS NULL OR "completed_at" >= "submitted_at"));

-- ---------------------------------------------------------------------------
-- 3. Notes and evidence say something
-- ---------------------------------------------------------------------------

ALTER TABLE "human_task_notes"
  ADD CONSTRAINT "task_note_kind_is_known"
  CHECK ("kind" IN ('Comment', 'Clarification'));

ALTER TABLE "human_task_notes"
  ADD CONSTRAINT "task_note_has_a_body"
  CHECK (length(btrim("body")) > 0);

-- Evidence with no description is a row that proves nothing, which is worse than no row: it makes
-- the submission gate pass while leaving the reviewer with nothing to read.
ALTER TABLE "human_task_evidence"
  ADD CONSTRAINT "task_evidence_describes_itself"
  CHECK (length(btrim("description")) > 0);

-- ---------------------------------------------------------------------------
-- 4. An AI assignment cannot claim a mapping it does not have
-- ---------------------------------------------------------------------------
-- The Engine Agent registry is a later prompt, so `engine_agent_id` has no foreign key yet. This
-- is what stands in for it: the status and the column must agree, so a row can never report
-- "mapped to an existing agent" while naming none — which is precisely the claim that would make
-- an unperformable step look ready.

ALTER TABLE "ai_work_assignments"
  ADD CONSTRAINT "ai_assignment_status_is_known"
  CHECK ("status" IN ('AwaitingAgentSetup', 'MappedToEngineAgent', 'Cancelled'));

ALTER TABLE "ai_work_assignments"
  ADD CONSTRAINT "mapped_assignment_names_its_agent"
  CHECK (("status" = 'MappedToEngineAgent') = ("engine_agent_id" IS NOT NULL));

ALTER TABLE "ai_work_assignments"
  ADD CONSTRAINT "ai_assignment_prefill_is_an_object"
  CHECK (jsonb_typeof("setup_prefill") = 'object');

ALTER TABLE "ai_work_assignments"
  ADD CONSTRAINT "ai_assignment_has_a_title"
  CHECK (length(btrim("title")) > 0);

-- ---------------------------------------------------------------------------
-- 5. The approvals queue
-- ---------------------------------------------------------------------------

ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_type_is_known"
  CHECK ("type" IN ('ObjectiveReview', 'WorkflowPublish', 'AgentActivation', 'HighRiskAction',
                    'OutputApproval', 'BudgetOverride', 'GuestAccess', 'WorkflowStepApproval'));

ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_status_is_known"
  CHECK ("status" IN ('Pending', 'Approved', 'Rejected', 'SentBack', 'Cancelled'));

ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_has_a_title"
  CHECK (length(btrim("title")) > 0);

-- A decision is attributed in both directions. "Approved, but we do not know by whom" is not an
-- approval record, and this is the table an audit reads when a decision is questioned.
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_decision_is_attributed"
  CHECK (("decided_at" IS NULL) = ("decided_by_user_id" IS NULL));

ALTER TABLE "approval_requests"
  ADD CONSTRAINT "decided_approval_records_its_decision"
  CHECK ("status" NOT IN ('Approved', 'Rejected') OR "decided_at" IS NOT NULL);

-- A pending request has not been decided. Without this a row could show as waiting while already
-- carrying somebody's decision, which is the state that makes a queue untrustworthy.
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "pending_approval_has_no_decision"
  CHECK ("status" <> 'Pending' OR "decided_at" IS NULL);

-- A rejection has to say why. A refusal with no reason cannot be acted on or appealed.
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "rejected_approval_says_why"
  CHECK ("status" <> 'Rejected' OR length(btrim(COALESCE("decision_note", ''))) > 0);

-- A version reference without its objective is half a pointer.
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_version_names_its_objective"
  CHECK ("objective_version_id" IS NULL OR "objective_id" IS NOT NULL);

ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_node_names_its_version"
  CHECK ("workflow_node_id" IS NULL OR "objective_version_id" IS NOT NULL);

-- One approval per workflow step per version, so a retried publish cannot ask the same person for
-- the same decision twice. Partial because it applies only to the step-approval type; every other
-- type is scoped by its own subject.
CREATE UNIQUE INDEX "one_step_approval_per_workflow_node"
  ON "approval_requests" ("tenant_id", "objective_version_id", "workflow_node_id")
  WHERE "type" = 'WorkflowStepApproval' AND "workflow_node_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. Executor expectations
-- ---------------------------------------------------------------------------

ALTER TABLE "executor_expectations"
  ADD CONSTRAINT "executor_expectation_kind_is_known"
  CHECK ("kind" IN ('HumanTaskOverdue', 'MissingCompletionEvidence', 'ApprovalPending',
                    'ConnectionRequired'));

ALTER TABLE "executor_expectations"
  ADD CONSTRAINT "executor_expectation_subject_is_known"
  CHECK ("subject_type" IN ('HumanTask', 'AiWorkAssignment', 'ApprovalRequest'));

-- The whole point of registering an expectation is that an exception can quote it. A blank detail
-- would leave the Executor Agent raising "something was expected here".
ALTER TABLE "executor_expectations"
  ADD CONSTRAINT "executor_expectation_says_what_is_expected"
  CHECK (length(btrim("detail")) > 0);

-- An overdue expectation needs a time to be overdue against. This is the constraint that makes
-- "a task with no due time is never reported late" a property of the data rather than of whichever
-- query happens to read it.
ALTER TABLE "executor_expectations"
  ADD CONSTRAINT "overdue_expectation_has_a_due_time"
  CHECK ("kind" <> 'HumanTaskOverdue' OR "due_at" IS NOT NULL);
