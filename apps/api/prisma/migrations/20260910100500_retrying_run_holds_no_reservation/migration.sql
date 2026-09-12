-- ===========================================================================
-- Fix: a Retrying run holds no reservation
-- ===========================================================================
-- `running_run_was_reserved_first` listed the states that legitimately have no reservation and
-- omitted `Retrying`. But a retry is precisely the case where the reservation was *released* when
-- the previous attempt failed: the next attempt has to take a new one rather than assume the old
-- one still holds, which is why the engine clears `reserved_at` on the way into `Retrying`.
--
-- The effect was that every retry violated the constraint, the transaction rolled back, and the
-- run stayed on its first attempt — a bounded-retry policy that silently never retried. Caught by
-- the run-engine e2e suite; the raw-SQL probe had checked `Running` without a reservation and not
-- `Retrying`, which is the lesson: probe every state the code actually writes, not the obvious one.
--
-- `WaitingForHumanInput` and `WaitingForApproval` stay out of the list on purpose. Those hold
-- their reservation — that is why resuming one returns it to `Running` rather than to `Queued`.

ALTER TABLE "agent_runs"
  DROP CONSTRAINT "running_run_was_reserved_first";

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "running_run_was_reserved_first"
  CHECK ("state" IN ('Queued', 'Retrying', 'Cancelled', 'BlockedByBudget', 'BlockedByConnection',
                     'BlockedByPermission', 'BlockedByProvider')
         OR "reserved_at" IS NOT NULL);
