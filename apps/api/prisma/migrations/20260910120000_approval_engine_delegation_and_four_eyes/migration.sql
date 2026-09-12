-- AlterTable
ALTER TABLE "approval_requests" ADD COLUMN     "decided_on_behalf_of_user_id" UUID,
ADD COLUMN     "escalated_at" TIMESTAMPTZ(6),
ADD COLUMN     "escalated_to_user_id" UUID,
ADD COLUMN     "supersedes_id" UUID;

-- CreateTable
CREATE TABLE "approval_decisions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "approval_request_id" UUID NOT NULL,
    "decision" VARCHAR(20) NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "on_behalf_of_user_id" UUID,
    "delegation_id" UUID,
    "note" VARCHAR(4000) NOT NULL DEFAULT '',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_delegations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "from_user_id" UUID NOT NULL,
    "to_user_id" UUID NOT NULL,
    "types" VARCHAR(40)[],
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_user_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "approval_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_decisions_tenant_id_approval_request_id_occurred_a_idx" ON "approval_decisions"("tenant_id", "approval_request_id", "occurred_at");

-- CreateIndex
CREATE INDEX "approval_decisions_tenant_id_actor_user_id_idx" ON "approval_decisions"("tenant_id", "actor_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_decisions_tenant_id_id_key" ON "approval_decisions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "approval_delegations_tenant_id_from_user_id_starts_at_ends__idx" ON "approval_delegations"("tenant_id", "from_user_id", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "approval_delegations_tenant_id_to_user_id_idx" ON "approval_delegations"("tenant_id", "to_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_delegations_tenant_id_id_key" ON "approval_delegations"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "approval_requests_tenant_id_status_due_at_idx" ON "approval_requests"("tenant_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "approval_requests_tenant_id_approver_role_kind_status_idx" ON "approval_requests"("tenant_id", "approver_role_kind", "status");

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_supersedes_id_fkey" FOREIGN KEY ("tenant_id", "supersedes_id") REFERENCES "approval_requests"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_tenant_id_approval_request_id_fkey" FOREIGN KEY ("tenant_id", "approval_request_id") REFERENCES "approval_requests"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Prompt 28 — the Approval Engine, delegation and four-eyes controls
-- ===========================================================================
--
-- What this migration deliberately does NOT create:
--
--   * **No second approval table.** The client's constraint is that approvals work "without
--     duplicating separate approval tables per module", so `approval_requests` — created at
--     Prompt 23 with all eight `APPROVAL_REQUEST_TYPES` already in its vocabulary — gains four
--     columns rather than a sibling. Objective review, workflow publish, agent activation,
--     high-risk actions, output approval, budget override and guest access are all the same row
--     shape with the same lifecycle.
--   * **No separation-of-duties table.** `separation_of_duties_policies` exists from Prompt 7 and
--     already carries a mandatory platform-wide `NoSelfApproval` control on `Approve` that every
--     company inherits. The Approval Engine feeds `checkSeparationOfDuties` the requester as
--     `createdByUserId` and this history as `priorActorUserIds`; nothing about the rule is
--     restated in the approvals code.
--   * **No permission columns on the delegation table.** A delegation moves routing, never
--     authority. The delegate passes the same module check and the same SoD controls, so there is
--     nothing here for a grant to live in.

-- ---------------------------------------------------------------------------
-- 1. Tenant isolation
-- ---------------------------------------------------------------------------

ALTER TABLE "approval_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_decisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "approval_decisions_tenant_isolation" ON "approval_decisions"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

ALTER TABLE "approval_delegations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_delegations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "approval_delegations_tenant_isolation" ON "approval_delegations"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on')
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
         OR COALESCE(current_setting('app.platform_operation', true), '') = 'on');

-- ---------------------------------------------------------------------------
-- 2. The closed decision vocabulary
-- ---------------------------------------------------------------------------
-- Named here as well as in `APPROVAL_DECISIONS` so that a typo becomes a rejected write rather
-- than a fifth decision kind that no screen has a label for and no status mapping covers.

ALTER TABLE "approval_decisions"
  ADD CONSTRAINT "approval_decision_is_a_known_kind"
  CHECK ("decision" IN ('Approve', 'Reject', 'SendBack', 'Comment'));

-- A refusal has to say why. An author told only "rejected" cannot tell what to change, which
-- makes the send-back loop the client asked for unusable in practice.
ALTER TABLE "approval_decisions"
  ADD CONSTRAINT "a_refusal_states_a_reason"
  CHECK ("decision" NOT IN ('Reject', 'SendBack') OR length(btrim("note")) > 0);

-- A stand-in records both halves or neither: which delegation authorised it, and who it was for.
-- "Somebody acted on behalf of somebody, we forget which arrangement let them" is not an audit
-- trail, and this is the pairing an auditor actually asks about.
ALTER TABLE "approval_decisions"
  ADD CONSTRAINT "a_stand_in_names_the_delegation_that_allowed_it"
  CHECK (("on_behalf_of_user_id" IS NULL) = ("delegation_id" IS NULL));

-- A person cannot have stood in for themselves.
ALTER TABLE "approval_decisions"
  ADD CONSTRAINT "a_stand_in_is_not_the_actor"
  CHECK ("on_behalf_of_user_id" IS NULL OR "on_behalf_of_user_id" <> "actor_user_id");

-- ---------------------------------------------------------------------------
-- 3. The decision history is append-only
-- ---------------------------------------------------------------------------
-- This is the client's **immutable decision record**, enforced in the database rather than in a
-- service, because a service can be bypassed by the next prompt and a trigger cannot. A history
-- that can be edited afterwards is not evidence of anything.
--
-- No escape hatch: unlike the freeze triggers elsewhere, there is no session variable that
-- switches this off. The test harness clears the table with TRUNCATE, which does not fire
-- row-level triggers, so the tests need no privilege the application lacks.

CREATE OR REPLACE FUNCTION uboss_approval_decisions_are_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'The approval decision record is immutable. It says who approved, rejected or sent back a '
    'piece of work and when, and a record that can be rewritten afterwards proves nothing.'
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER "uboss_approval_decisions_are_append_only"
  BEFORE UPDATE OR DELETE ON "approval_decisions"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_approval_decisions_are_append_only();

-- ---------------------------------------------------------------------------
-- 4. A settled request records who settled it, and stays settled
-- ---------------------------------------------------------------------------

-- Pending means undecided; anything else names the decider and the moment. Without this a row
-- could report itself Approved with nobody attached, which is the one thing an approval must
-- never be able to say.
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "a_settled_approval_names_who_decided_it"
  CHECK (
    ("status" = 'Pending' AND "decided_by_user_id" IS NULL AND "decided_at" IS NULL)
    OR ("status" <> 'Pending' AND "decided_by_user_id" IS NOT NULL AND "decided_at" IS NOT NULL)
  );

-- The stand-in pairing again, on the request itself.
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "a_delegated_decision_is_not_by_the_approver_themselves"
  CHECK (
    "decided_on_behalf_of_user_id" IS NULL
    OR "decided_on_behalf_of_user_id" <> "decided_by_user_id"
  );

-- Escalation records where it went. An escalation with no destination is a flag nobody receives.
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "an_escalated_approval_records_who_it_went_to"
  CHECK (("escalated_at" IS NULL) = ("escalated_to_user_id" IS NULL));

-- A request cannot supersede itself.
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "an_approval_does_not_supersede_itself"
  CHECK ("supersedes_id" IS NULL OR "supersedes_id" <> "id");

-- One resubmission per superseded request. Two live requests both claiming to replace the same
-- sent-back item would give the same work two independent verdicts.
CREATE UNIQUE INDEX "one_resubmission_per_superseded_approval"
  ON "approval_requests" ("tenant_id", "supersedes_id")
  WHERE "supersedes_id" IS NOT NULL;

-- **A decision is final.** Once a request leaves Pending it may never move again — not to
-- another verdict, and not back to Pending. A corrected submission is a new row pointing at this
-- one through `supersedes_id`, which is why that column exists.
--
-- Written as a trigger rather than a CHECK because a CHECK sees one row, not the transition.
CREATE OR REPLACE FUNCTION uboss_approval_decision_is_final()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" <> 'Pending' AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION
      'Approval % is already %. A decision is final: correct the work and submit a new request, '
      'which will point back at this one.', OLD."id", OLD."status"
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD."status" <> 'Pending'
     AND (NEW."decided_by_user_id" IS DISTINCT FROM OLD."decided_by_user_id"
          OR NEW."decided_at" IS DISTINCT FROM OLD."decided_at"
          OR NEW."decision_note" IS DISTINCT FROM OLD."decision_note") THEN
    RAISE EXCEPTION
      'Approval % is already decided. Who decided it, when, and why cannot be rewritten.',
      OLD."id"
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "uboss_approval_decision_is_final"
  BEFORE UPDATE ON "approval_requests"
  FOR EACH ROW
  EXECUTE FUNCTION uboss_approval_decision_is_final();

-- ---------------------------------------------------------------------------
-- 5. Delegations are real, bounded windows
-- ---------------------------------------------------------------------------

ALTER TABLE "approval_delegations"
  ADD CONSTRAINT "a_delegation_is_not_to_yourself"
  CHECK ("from_user_id" <> "to_user_id");

-- A window that covers no time is worse than no delegation at all, because the person who set it
-- believes they are covered and stops watching the queue.
ALTER TABLE "approval_delegations"
  ADD CONSTRAINT "a_delegation_window_is_real"
  CHECK ("ends_at" > "starts_at");

-- Beyond a quarter this is not out-of-office cover, it is a reassignment of authority, and it
-- should be made as one so that it is visible as one. Matches `MAX_DELEGATION_DAYS`.
ALTER TABLE "approval_delegations"
  ADD CONSTRAINT "a_delegation_is_bounded_to_a_quarter"
  CHECK ("ends_at" <= "starts_at" + INTERVAL '92 days');

ALTER TABLE "approval_delegations"
  ADD CONSTRAINT "a_delegation_states_a_reason"
  CHECK (length(btrim("reason")) > 0);

-- Every named type must be a real approval type. An empty array is the "all types" case and is
-- allowed; an array containing a typo is not, because it would silently cover nothing.
ALTER TABLE "approval_delegations"
  ADD CONSTRAINT "delegated_types_are_known_approval_types"
  CHECK ("types" <@ ARRAY[
    'ObjectiveReview', 'WorkflowPublish', 'AgentActivation', 'HighRiskAction',
    'OutputApproval', 'BudgetOverride', 'GuestAccess', 'WorkflowStepApproval'
  ]::varchar(40)[]);

-- Revocation records both halves: when, and by whom.
ALTER TABLE "approval_delegations"
  ADD CONSTRAINT "a_revoked_delegation_names_who_revoked_it"
  CHECK (("revoked_at" IS NULL) = ("revoked_by_user_id" IS NULL));
