-- A top-up is priced per currency, like a plan is.
--
-- There was one rate — `commercial.uboss_token_minor_units`, ten paise to the token — and the
-- top-up multiplied the token count by it whatever the company's currency was, stamping the
-- currency on afterwards. So fifty thousand tokens cost an Indian company ₹5,000 and an American
-- company $5,000: about eighty-eight times as much for the same thing. Not a display fault. That
-- figure went to the payment provider as `unit_amount`, so the card would have been charged it,
-- and eleven of the eighteen companies in the development database are on USD.
--
-- Plan prices were never wrong this way, because `plan_prices` has a row per currency. These are
-- the same idea for the top-up.
--
--
-- Why a price for a thousand tokens rather than for one
--
-- Because one token does not cost a whole minor unit in every currency, and a price in minor
-- units is an integer.
--
-- UBoss does not price USD at the day's exchange rate; it prices it the way the plans already do.
-- Growth is ₹49,999 and $1,900, so a dollar stands for about twenty-six rupees here, not the
-- market's eighty-eight. Carry ₹0.10 a token across at that ratio and a token is $0.0038 — less
-- than half a cent. Rounded to the nearest whole cent that becomes $0.01, and the American
-- company pays about two and a half times what the ratio says: a smaller version of the same bug,
-- baked into the unit rather than into a mistake.
--
-- A thousand tokens is the unit that survives. ₹100 and $3.80 are both whole numbers of minor
-- units, and the smallest top-up anybody can buy is ten thousand tokens anyway.
--
--
-- Why the accounting rate above is left alone
--
-- `commercial.uboss_token_minor_units` still defines what a token *is* for an allowance and for
-- what has been consumed. Changing that would restate every existing company's allowance and
-- consumption at once. What a top-up costs is a separate question, and it is the one that moves
-- money.
--
--
-- A currency with no row here is a currency top-ups are not sold in. The quote returns a refusal
-- and the purchase call throws; nothing is converted, because a converted price is not the price
-- the invoice would show.

INSERT INTO "platform_settings"
  ("id", "key", "value", "description", "section", "locked",
   "created_at", "updated_at", "row_version")
VALUES
  (gen_random_uuid(),
   'commercial.uboss_token_price_minor_per_1000.INR',
   '10000'::jsonb,
   'What a company is charged for a thousand UBoss Tokens, in paise. ₹100, carried across '
     || 'unchanged from the ten-paise-a-token rate that was in use before top-ups were priced '
     || 'per currency, so no Indian company pays anything different.',
   'Commercial', false, NOW(), NOW(), 1),

  (gen_random_uuid(),
   'commercial.uboss_token_price_minor_per_1000.USD',
   '380'::jsonb,
   'What a company is charged for a thousand UBoss Tokens, in cents. $3.80, which is the INR '
     || 'price at the ratio the plans already use — Growth is ₹49,999 and $1,900 — rather than '
     || 'at the day''s exchange rate. Pricing the top-up by one ratio and the plan by another is '
     || 'what this avoids.',
   'Commercial', false, NOW(), NOW(), 1)

ON CONFLICT ("key") DO NOTHING;
