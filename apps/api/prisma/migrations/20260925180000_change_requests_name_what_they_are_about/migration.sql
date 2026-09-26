-- What a change request is about.
--
-- A change request is an approval like every other -- somebody asks, somebody with the authority
-- decides, and the decision is audited -- so it is a `type` on `approval_requests` rather than a
-- table of its own with its own idea of who may act on it. What it needs that the others do not is
-- a category: the client names six, and an Admin reading a queue should be able to tell a
-- hierarchy request from an access problem without parsing a title.
--
-- Nullable, and meaningful only for `type = 'ChangeRequest'`. That is how this table already works
-- -- `objective_id` and `workflow_node_id` are both nullable columns that mean something for some
-- types and nothing for others.
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "change_kind" VARCHAR(40);

-- A change request says which kind, and nothing else carries one.
ALTER TABLE "approval_requests" DROP CONSTRAINT IF EXISTS "change_kind_belongs_to_a_change_request";
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "change_kind_belongs_to_a_change_request"
  CHECK (
    (type = 'ChangeRequest' AND change_kind IS NOT NULL)
    OR (type <> 'ChangeRequest' AND change_kind IS NULL)
  );

-- The vocabulary, so a kind nobody declared cannot reach the column.
ALTER TABLE "approval_requests" DROP CONSTRAINT IF EXISTS "change_kind_is_known";
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "change_kind_is_known"
  CHECK (
    change_kind IS NULL
    OR change_kind IN ('Hierarchy', 'Objective', 'WorkReassignment', 'AgentCorrection', 'Access', 'Other')
  );

CREATE INDEX IF NOT EXISTS "approval_requests_change_kind_idx"
  ON "approval_requests" ("tenant_id", "change_kind")
  WHERE "change_kind" IS NOT NULL;

-- The type vocabulary learns the new word.
--
-- Dropped and recreated because Postgres has no ADD VALUE for a CHECK. Additive: every type that
-- was legal before is still legal, so no existing row can fail it.
ALTER TABLE "approval_requests" DROP CONSTRAINT IF EXISTS "approval_type_is_known";
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_type_is_known"
  CHECK (
    type IN (
      'ObjectiveReview',
      'WorkflowPublish',
      'AgentActivation',
      'HighRiskAction',
      'OutputApproval',
      'BudgetOverride',
      'GuestAccess',
      'WorkflowStepApproval',
      'ChangeRequest'
    )
  );
