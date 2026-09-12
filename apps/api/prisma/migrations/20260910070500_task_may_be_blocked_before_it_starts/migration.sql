-- ===========================================================================
-- Fix: a task may be blocked, or need input, before it is ever started
-- ===========================================================================
-- `started_task_records_when` required a start time for every status except `Assigned` and
-- `Cancelled`. That refused two ordinary first actions: "I cannot begin, the input has not
-- arrived" (Blocked) and "I do not understand what is being asked" (NeedsInput). Both happen
-- before any work, and both are exactly what the client's To-do UI offers a person on day one.
--
-- The statuses that genuinely imply work began are the four below. Corrected append-only; the
-- previous migration is already applied.
--
-- Found by a test doing the obvious thing: block a freshly assigned task. The constraint was
-- written from the happy path outwards, which is how a rule ends up forbidding a real state.

ALTER TABLE "human_tasks"
  DROP CONSTRAINT "started_task_records_when";

ALTER TABLE "human_tasks"
  ADD CONSTRAINT "started_task_records_when"
  CHECK ("status" NOT IN ('InProgress', 'WaitingApproval', 'Submitted', 'Completed')
         OR "started_at" IS NOT NULL);
