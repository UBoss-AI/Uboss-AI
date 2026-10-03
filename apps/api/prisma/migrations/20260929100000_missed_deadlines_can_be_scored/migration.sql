-- A deadline that passes and is never met has to become a score, and until now nothing could
-- produce a `Missed` event: the kind existed, the points existed, and no code path wrote one.
--
-- How long a task sits past its due date before it stops being *late* and starts being *undone*
-- is a company's judgement, not ours, so it is policy rather than a constant. A day by default:
-- a deadline that has survived a full working day untouched is not a scheduling accident.
--
-- Additive only. Existing policies take the default and keep scoring exactly as they did.
ALTER TABLE "performance_policies"
  ADD COLUMN "missed_after_hours" INTEGER NOT NULL DEFAULT 24;

-- A window of zero would make every task missed the instant it came due, which is the one value
-- that cannot be meant. A negative one would make it missed before it was due.
ALTER TABLE "performance_policies"
  ADD CONSTRAINT "missed_after_hours_is_positive" CHECK ("missed_after_hours" > 0);
