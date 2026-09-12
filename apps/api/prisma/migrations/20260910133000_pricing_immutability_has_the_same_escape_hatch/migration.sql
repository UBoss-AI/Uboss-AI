-- ===========================================================================
-- Prompt 29, corrective — the pricing immutability trigger gets the standard escape hatch
-- ===========================================================================
--
-- `uboss_pricing_versions_are_immutable` as first written refused every DELETE unconditionally.
-- Correct for the application and wrong in two ways nobody would notice until a test run:
--
--   1. **A cascade would fail.** `pricing_versions.provider_model_id` cascades from
--      `provider_models`, so deleting a company's provider model would try to delete its pricing
--      versions and be refused by the trigger. A company removing a BYOK model would get an
--      error naming a table it has never heard of.
--   2. **The test harness could not isolate.** The platform mock profile, models, routes and
--      prices are seeded by migration — like the platform separation-of-duties baseline — so the
--      reset must clear only *tenant-owned* rows and leave the platform seed standing. That means
--      DELETE with a WHERE clause, not TRUNCATE, and the trigger refused it.
--
-- So it gains the same narrow, deliberately ugly escape hatch the Prompt 8 append-only tables
-- have: `SET LOCAL uboss.allow_history_truncate = 'on'`. `SET LOCAL` rather than `SET`, so the
-- permission dies with the transaction and cannot leak onto a pooled connection.
--
-- **UPDATE is still refused absolutely.** The hatch only permits deletion, because the thing being
-- protected is that a published price must never be *restated* — a gateway call cites the version
-- that priced it. Removing a row wholesale in a test database is a different act from editing a
-- price under a ledger entry that references it, and the FK is what stops the second.
--
-- Nothing in `src/` sets this variable. `grep -r allow_history_truncate src` returning nothing is
-- the check that matters.

CREATE OR REPLACE FUNCTION uboss_pricing_versions_are_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(current_setting('uboss.allow_history_truncate', true), '') = 'on' THEN
      RETURN OLD;
    END IF;

    RAISE EXCEPTION
      'A pricing version cannot be deleted. Gateway calls cite it as what priced them.'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW."provider_model_id" IS DISTINCT FROM OLD."provider_model_id"
     OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."input_per_million_minor_units" IS DISTINCT FROM OLD."input_per_million_minor_units"
     OR NEW."output_per_million_minor_units" IS DISTINCT FROM OLD."output_per_million_minor_units"
     OR NEW."cached_input_per_million_minor_units"
        IS DISTINCT FROM OLD."cached_input_per_million_minor_units"
     OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from" THEN
    RAISE EXCEPTION
      'A pricing version is immutable. Supersede it with a new version rather than editing it — '
      'a price change must not retroactively restate what a Run cost.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;
