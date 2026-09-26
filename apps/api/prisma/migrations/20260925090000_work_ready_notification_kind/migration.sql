-- A seventh notification kind: work that has stopped waiting on other work.
--
-- Additive only. Adding a value to an enum cannot invalidate a stored row, so no existing
-- notification is touched and nothing needs backfilling: every row already carries one of the six
-- values, and they all remain legal.
--
-- IF NOT EXISTS so re-running this against a database that already has it is a no-op rather than
-- a failure -- the test database is stamped separately from the development one.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'WorkReady';

-- Waiting: a step whose dependencies have not finished.
--
-- The CHECK is what stops a status nobody declared from reaching the column, so it has to learn
-- the new one. Dropped and recreated rather than altered, because Postgres has no ADD VALUE for a
-- CHECK. Additive: every value that was legal before is still legal, so no existing row can fail
-- it and none needs rewriting.
--
-- It is separate from Blocked on purpose. Blocked is a person saying they cannot proceed and can
-- lift it themselves; Waiting is the plan's order and only the server moves it.
ALTER TABLE "human_tasks" DROP CONSTRAINT IF EXISTS "human_task_status_is_known";
ALTER TABLE "human_tasks"
  ADD CONSTRAINT "human_task_status_is_known"
  CHECK (
    status IN (
      'Waiting',
      'Assigned',
      'InProgress',
      'Blocked',
      'NeedsInput',
      'WaitingApproval',
      'Submitted',
      'Completed',
      'Cancelled'
    )
  );
