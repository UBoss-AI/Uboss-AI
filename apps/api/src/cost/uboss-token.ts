import { Logger } from '@nestjs/common';

import type { PrismaService } from '../persistence/prisma.service.js';

/**
 * The UBoss Token: the only unit a company is shown its AI use in.
 *
 * ## Why a company counts tokens and not rupees
 *
 * Never rupees per call, and never the provider's own token counts. Both leak the same thing:
 * given a charge and a provider token count, anybody can divide, read off a per-million rate,
 * match it against a public price list, and walk away with the provider's name and UBoss's margin
 * together. A unit that is neither of those cannot be divided into anything.
 *
 * What a company pays for its *plan* is a different matter and stays in rupees — that is their own
 * money and they can see it. What one AI call cost is not.
 *
 * ## Why a token is defined in sell value rather than in provider tokens
 *
 * This is the decision that makes the margin structural rather than something to be maintained:
 *
 *   * Route to a cheaper model tomorrow and a job costs the customer the same number of tokens
 *     while costing UBoss less. The margin widens by itself.
 *   * A provider raises its price and a job consumes more tokens, so a company's allowance drains
 *     faster and its own cap stops it. The rise lands on the allowance, not on the margin.
 *
 * A token defined as "a thousand provider tokens" would do the opposite of both.
 *
 * ## Why this is a function and not a service
 *
 * It is one number read from one row, wanted by the cost engine and by the commercial plane. As an
 * injectable it would be a third constructor argument in services that are assembled by hand in
 * several test modules, and the first thing it did was break three of them. A function taking the
 * Prisma handle its callers already hold adds no wiring anywhere and still leaves exactly one
 * definition of the rate.
 */

/**
 * Ten paise of sell value to the token, when the setting cannot be read.
 *
 * The fallback and the seeded setting have to agree: a fallback of a different size would quietly
 * restate every company's allowance the moment the setting went missing. Ten puts a typical agent
 * run at about a hundred and fifty tokens and a month's allowance in the hundreds of thousands —
 * numbers a person can hold in their head and compare.
 *
 * Not one. One would be a rupee's hundredth part under a new name, which a customer could multiply
 * straight back into money.
 */
export const DEFAULT_UBOSS_TOKEN_MINOR_UNITS = 10;

/**
 * What one UBoss Token is worth, in minor units of sell value.
 *
 * `commercial.uboss_token_minor_units`, beside the sell multiplier, because both are one decision:
 * what UBoss charges, and in what unit it says so. Platform-plane only — it appears on no
 * company-facing screen or export, because publishing it would let a customer convert their token
 * count back into money and from there into the provider's public rate.
 */
export async function ubossTokenMinorUnits(prisma: PrismaService, logger: Logger): Promise<number> {
  try {
    const row = await prisma.runAsPlatformOperation(() =>
      prisma.client.platformSetting.findUnique({
        where: { key: 'commercial.uboss_token_minor_units' },
        select: { value: true },
      }),
    );

    const value = Number(row?.value);
    if (!Number.isFinite(value) || value < 1) {
      logger.warn(
        'commercial.uboss_token_minor_units is missing or below 1; using the default of ' +
          `${DEFAULT_UBOSS_TOKEN_MINOR_UNITS}. Set it in the Master Console.`,
      );
      return DEFAULT_UBOSS_TOKEN_MINOR_UNITS;
    }
    return Math.round(value);
  } catch (error) {
    logger.warn(
      `Could not read the UBoss Token rate, so the default of ${DEFAULT_UBOSS_TOKEN_MINOR_UNITS} ` +
        `is in use: ${error instanceof Error ? error.message : String(error)}`,
    );
    return DEFAULT_UBOSS_TOKEN_MINOR_UNITS;
  }
}

/** How many tokens one price row covers. See `tokenSalePriceMinorPer1000`. */
export const TOKEN_PRICE_BLOCK = 1000;

/** The key a currency's top-up price lives under. */
export function tokenPriceSettingKey(currency: string): string {
  return `commercial.uboss_token_price_minor_per_1000.${currency.trim().toUpperCase()}`;
}

/**
 * What a company is charged for **a thousand tokens**, in their own currency's minor units — or
 * null when top-ups are not priced in that currency.
 *
 * ## The defect this exists to stop
 *
 * There was one rate and it was multiplied by the token count whatever the company's currency
 * was, with the currency stamped on afterwards. The rate is ten *paise* — the constant above says
 * so — so an Indian company bought fifty thousand tokens for ₹5,000 and an American one bought
 * the same fifty thousand for $5,000, roughly eighty-eight times as much. Not a display fault:
 * `start()` hands that figure to the payment provider as `unit_amount`, so the card would have
 * been charged it. Eleven of the eighteen companies in the local database are on USD.
 *
 * Plan prices were never wrong this way, because a plan has a price row per currency. This is the
 * same idea for the top-up.
 *
 * ## Why a thousand tokens and not one
 *
 * Because one token does not cost a whole minor unit in every currency, and a price in minor
 * units is an integer.
 *
 * UBoss does not price USD at the day's exchange rate — it prices it the way the plans already
 * do. Growth is ₹49,999 and $1,900, so a dollar stands for about twenty-six rupees here, not the
 * market's eighty-eight. Carry ₹0.10 a token across at that ratio and a token costs $0.0038:
 * less than half a cent. Rounded to the nearest whole cent it becomes $0.01, and the American
 * company pays about two and a half times what the ratio says — a smaller version of the same
 * bug, baked in by the unit rather than by a mistake.
 *
 * A thousand tokens is the unit that survives: ₹100 and $3.80 are both whole numbers of minor
 * units, and the smallest top-up anyone can buy is ten thousand tokens anyway.
 */
export async function tokenSalePriceMinorPer1000(
  prisma: PrismaService,
  logger: Logger,
  currency: string,
): Promise<number | null> {
  const code = currency.trim().toUpperCase();

  try {
    const row = await prisma.runAsPlatformOperation(() =>
      prisma.client.platformSetting.findUnique({
        where: { key: tokenPriceSettingKey(code) },
        select: { value: true },
      }),
    );

    const value = Number(row?.value);
    if (Number.isFinite(value) && value >= 1) return Math.round(value);

    /*
     * No fallback, and in particular not to the accounting rate.
     *
     * There is no safe number to guess: converting at some rate of the day would charge a figure
     * nobody agreed and that no invoice could be reconciled against, and falling back to the INR
     * rate is the bug this replaces. A currency with no price is one UBoss has not priced top-ups
     * in yet, and every caller turns that into a refusal rather than a charge.
     */
    logger.warn(
      `No UBoss Token price is set for ${code}, so top-ups are refused in that currency. ` +
        `Set ${tokenPriceSettingKey(code)} in the Master Console.`,
    );
    return null;
  } catch (error) {
    /*
     * A read that failed is not a currency without a price, and must not be charged as if the
     * price were something else. Refusing is the only safe answer: a top-up can be retried, a
     * wrong charge cannot be taken back without a refund.
     */
    logger.warn(
      `Could not read the UBoss Token price for ${code}, so top-ups are refused until it reads: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * What to charge for a given number of tokens, from a per-thousand price.
 *
 * Rounded to the nearest minor unit, once, on the total. The smallest top-up is ten thousand
 * tokens and the step people actually buy in is a thousand, so the rounding only bites on an odd
 * figure typed by hand — and then by less than one paisa or cent on the whole purchase.
 *
 * The quote and the charge both come through here, so the number on the screen and the number on
 * the card are the same arithmetic rather than two copies of it.
 */
export function topUpAmountMinor(tokens: number, priceMinorPer1000: number): number {
  return Math.round((tokens * priceMinorPer1000) / TOKEN_PRICE_BLOCK);
}

/**
 * The accounting rate carried across to the new unit, for the migration that seeds INR.
 *
 * Ten paise a token is ₹100 a thousand. Written here rather than as a literal in SQL so the two
 * cannot drift apart: if the accounting rate ever changes, this says what the INR top-up price
 * was derived from.
 */
export const DEFAULT_INR_TOKEN_PRICE_MINOR_PER_1000 =
  DEFAULT_UBOSS_TOKEN_MINOR_UNITS * TOKEN_PRICE_BLOCK;

/**
 * An amount of sell value, as the number of UBoss Tokens a company sees.
 *
 * Rounded to the nearest token, and meant for a **total** rather than for each call. Converting
 * per call and adding up would round a few paise upward thousands of times over a month and show a
 * company more spent than it had spent: the arithmetic would be invisible and the drift would not
 * be. The exact minor-unit figure stays what the hard stop enforces; this is what is printed.
 */
export function tokensFrom(minorUnits: number, rateMinorUnits: number): number {
  if (minorUnits <= 0) return 0;
  return Math.round(minorUnits / Math.max(1, rateMinorUnits));
}
