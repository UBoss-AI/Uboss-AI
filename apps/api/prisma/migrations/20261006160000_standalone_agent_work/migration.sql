-- An agent that no Objective asked for, built through the same form as every other agent.
--
-- The client: "jaise humne objective me kiya hai ... agent builder jab ban raha hai, form fill
-- kara rahe hain -- woh agent us objective ke liye ban raha hai. Jab hum normal agent banayen,
-- form sab kuch same rahega, process same, bas objective ki jagah woh khud ek agent ban raha hai."
--
-- Agent Builder's whole form hangs off an `ai_work_assignments` row: the job method grid, the
-- execution setup, the controlled test, the readiness rules and activation all read it. The row
-- could not exist without an objective, an objective version and a workflow draft, so the only
-- standalone agent the product could make was a two-field stub created somewhere else and
-- configured on a different screen -- a second, lesser path to the same thing.
--
-- These three columns become optional so that one row can describe either: work a plan asked for,
-- or work somebody asked for directly. Nothing else about the row changes, which is the point --
-- the form, the readiness rules and activation are untouched and shared.
--
-- `node_id` goes with them: it names a node inside the workflow draft, so it is meaningless
-- without one. The unique key over (tenant, objective version, node) keeps working -- Postgres
-- treats NULLs as distinct, so any number of standalone rows coexist while two assignments for
-- the same node of the same version remain impossible.

ALTER TABLE "ai_work_assignments" ALTER COLUMN "objective_id" DROP NOT NULL;
ALTER TABLE "ai_work_assignments" ALTER COLUMN "objective_version_id" DROP NOT NULL;
ALTER TABLE "ai_work_assignments" ALTER COLUMN "workflow_draft_id" DROP NOT NULL;
ALTER TABLE "ai_work_assignments" ALTER COLUMN "node_id" DROP NOT NULL;

-- All four together, or none of them.
--
-- Three of the four would be a row that claims to come from a plan and cannot say which, and the
-- services read them as a set. Written as a constraint rather than left to the code because the
-- code that writes these rows is in two places now, and will be in three.
ALTER TABLE "ai_work_assignments"
  ADD CONSTRAINT "assignment_is_planned_or_standalone"
  CHECK (
    (
      "objective_id" IS NOT NULL
      AND "objective_version_id" IS NOT NULL
      AND "workflow_draft_id" IS NOT NULL
      AND "node_id" IS NOT NULL
    )
    OR (
      "objective_id" IS NULL
      AND "objective_version_id" IS NULL
      AND "workflow_draft_id" IS NULL
      AND "node_id" IS NULL
    )
  );

-- The job method is the form itself, so it follows.
--
-- `objective_version_id` on a job method records which version of the plan the form was aligned
-- to, so that an import from an older one is refused rather than silently mapped. A standalone
-- agent has no plan to drift from, so there is nothing to align to and nothing to refuse.
--
-- The pairing -- a job method may only leave this blank when its work does -- is enforced where
-- the row is written, not here: a CHECK cannot read another table, and a trigger that could would
-- be a second place for this rule to live and drift from.
ALTER TABLE "job_methods" ALTER COLUMN "objective_version_id" DROP NOT NULL;
