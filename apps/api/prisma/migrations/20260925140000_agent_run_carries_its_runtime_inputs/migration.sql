-- What the person operating an agent told it, for this run only.
--
-- The published agent answers how the work is done. A run still needs the one or two things that
-- are genuinely different each time -- which batch, which period, anything to add -- and until now
-- there was nowhere to put them: `POST .../runs` took no body at all and every run of an agent was
-- identical to every other.
--
-- Nullable and additive. Every existing run predates the idea and truthfully carries no inputs;
-- backfilling a default would be inventing answers nobody gave.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "runtime_inputs" JSONB;

COMMENT ON COLUMN "agent_runs"."runtime_inputs" IS
  'What the operator answered for this run. Shape: RuntimeInputs. Null for a run started before the idea existed, or by the scheduler with nothing to add.';
