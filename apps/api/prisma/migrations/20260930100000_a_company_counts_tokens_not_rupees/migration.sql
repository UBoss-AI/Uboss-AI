-- A company sees its AI use in UBoss Tokens, and never in rupees per call or in a provider's own
-- token counts.
--
-- Both of those leak the same thing. Given a charge and a provider token count, anybody can
-- divide, read off a per-million rate, match it against a public price list, and walk away with
-- the provider's name and UBoss's margin together. A unit that is neither of those cannot be
-- divided into anything.
--
-- ## Why a token is defined in sell value rather than in provider tokens
--
-- This is what makes the margin structural rather than something somebody has to maintain:
--
--   * Route to a cheaper model tomorrow and a job still costs the customer the same number of
--     tokens while costing UBoss less — the margin widens on its own.
--   * A provider raises its price and a job consumes more tokens, so the company's allowance
--     drains faster and its own cap stops it. The rise lands on the allowance, not on the margin.
--
-- A token defined as "a thousand provider tokens" would do the opposite of both.
--
-- ## Ten
--
-- Ten paise of sell value to the token. That puts a typical agent run at about a hundred and fifty
-- tokens and a month's allowance in the hundreds of thousands — numbers a person can hold in their
-- head and compare. One would be a rupee's hundredth part under a new name, which the customer
-- could multiply straight back into money.
--
-- **Not locked**, and platform-plane only: it is a commercial decision like the sell multiplier
-- beside it, made by the people holding the Commercial role, and it appears on no company-facing
-- screen or export.
INSERT INTO "platform_settings"
  ("id", "key", "value", "description", "section", "locked",
   "created_at", "updated_at", "row_version")
VALUES
  (gen_random_uuid(), 'commercial.uboss_token_minor_units', '10'::jsonb,
   'Minor units of sell value to one UBoss Token. A company is shown tokens and never the '
     || 'provider''s prices or token counts, so this rate stays on the platform plane: publishing '
     || 'it would let a customer convert their token count back into money and from there into '
     || 'the provider''s public rate.',
   'Commercial', false, NOW(), NOW(), 1)
ON CONFLICT ("key") DO NOTHING;

-- A plan nobody pays for does not include an AI allowance.
--
-- Every rupee of allowance is a rupee UBoss has already paid a provider for, so a free plan
-- carrying one is not a discount — it is UBoss buying tokens and giving them away, per company,
-- every month, with no ceiling but the number of companies somebody creates. The Pilot plan was
-- exactly that: price 0, allowance $100, about ₹1,900 of real provider spend for each evaluation
-- company. Nothing was wrong with the code; the number had been chosen before there was a
-- provider bill behind it.
--
-- A free trial of the *software* is untouched — a company on a free plan gets every screen. What
-- it does not get is a standing arrangement that spends at a provider without anybody deciding to;
-- where a prospect should see an agent actually run, the platform grants that one company a
-- top-up by hand, which is audited and belongs to a person.
--
-- The service refuses this on write as well. Both, because the constraint holds for rows written
-- by anything at all, and the service's message is the one an operator can act on.
UPDATE "plans"
   SET "ai_allowance_minor" = 0, "updated_at" = NOW()
 WHERE COALESCE("price_minor", 0) = 0
   AND COALESCE("ai_allowance_minor", 0) > 0;

ALTER TABLE "plans"
  ADD CONSTRAINT "plan_free_has_no_ai_allowance"
  CHECK (COALESCE("price_minor", 0) > 0 OR COALESCE("ai_allowance_minor", 0) = 0);
