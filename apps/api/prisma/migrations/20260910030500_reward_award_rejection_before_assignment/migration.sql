-- ===========================================================================
-- Correction to `assigned_award_records_when`
-- ===========================================================================
-- The previous migration wrote:
--
--   CHECK ("status" = 'Draft' OR "assigned_at" IS NOT NULL)
--
-- which contradicts the lifecycle it was meant to protect. `ALLOWED_AWARD_TRANSITIONS` permits
-- `Draft -> Rejected`: a claim can be refused before anybody is assigned under it — the reward
-- was declared, somebody asked, and the answer was no. The constraint demanded an `assigned_at`
-- for a `Rejected` row, so the only way to record that refusal would have been to first record an
-- assignment that never happened. A constraint that forces a false record is worse than no
-- constraint.
--
-- The raw-SQL verification pass caught this before any service code depended on it. It is
-- corrected in its own migration rather than by editing the previous one, because that migration
-- has been applied and an applied migration is append-only.
--
-- `Draft` and `Rejected` are therefore the two statuses that do not imply an assignment.
-- Everything from `Assigned` onwards still must record when it was assigned.

ALTER TABLE "reward_awards" DROP CONSTRAINT IF EXISTS "assigned_award_records_when";

ALTER TABLE "reward_awards"
  ADD CONSTRAINT "assigned_award_records_when"
  CHECK ("status" IN ('Draft', 'Rejected') OR "assigned_at" IS NOT NULL);
