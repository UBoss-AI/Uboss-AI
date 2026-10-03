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
