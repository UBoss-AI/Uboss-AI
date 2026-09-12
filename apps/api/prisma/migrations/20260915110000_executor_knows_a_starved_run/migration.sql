-- ===========================================================================
-- Prompt 40 — the Executor learns one more exception kind
-- ===========================================================================
--
-- `AgentRunOverdue` (ADR-238): a run queued so long it has stopped being fairly queued and started
-- being starved. Round-robin ordering and a per-company ceiling both mean a company waits, and both
-- are invisible to the person who asked for the work — the run sits in `Queued`, a state that reads
-- as normal, indefinitely.
--
-- ---------------------------------------------------------------------------
-- The lesson this migration exists to record
-- ---------------------------------------------------------------------------
--
-- **A CHECK that enumerates a set must be revisited whenever the set grows, and nothing reminds
-- you.** `exception_kind_is_known` listed ten kinds. Adding the eleventh to `EXCEPTION_KINDS` in
-- TypeScript compiled cleanly, passed the type tests, passed lint, and then failed at runtime the
-- first time the sweep tried to raise one — with `23514`, from a constraint written five prompts
-- ago by somebody who could not have known.
--
-- This is the **third** appearance of that failure mode in this schema (Prompts 25, 34, and this).
-- Every time, the enumeration was correct when written and silently became incomplete. The
-- alternative — dropping the CHECK and trusting the application — is worse: the constraint is what
-- stops a typo becoming a row nobody can route, and a closed set is only closed if something
-- closes it. So the constraint stays, and the cost is a migration like this one whenever a kind is
-- added.

ALTER TABLE "executor_exceptions" DROP CONSTRAINT "exception_kind_is_known";

ALTER TABLE "executor_exceptions"
  ADD CONSTRAINT "exception_kind_is_known"
  CHECK ("kind" IN ('NeedsHumanInput', 'CredentialOrConnectionExpired', 'PermissionDenied',
                    'BudgetOrTokenLimit', 'ProviderOrToolUnavailable', 'ValidationFailed',
                    'ApprovalPending', 'RepeatedFailure', 'HumanTaskOverdue', 'MissingEvidence',
                    'AgentRunOverdue'));
