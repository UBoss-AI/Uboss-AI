import assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { describe, it } from 'node:test';

import {
  tokenPriceSettingKey,
  tokenSalePriceMinorPer1000,
  topUpAmountMinor,
} from '../src/cost/uboss-token.js';
import type { PrismaService } from '../src/persistence/prisma.service.js';

/**
 * What a company is charged for a top-up, in their own currency.
 *
 * The defect: one rate was multiplied by the token count whatever the currency was, and the
 * currency was stamped on afterwards. The rate is ten paise, so fifty thousand tokens cost an
 * Indian company ₹5,000 and an American one $5,000 — about eighty-eight times as much — and that
 * figure went to the payment provider as the amount to charge, not just to the screen.
 *
 * No database here. Every one of these is a decision about which key is read, what happens when
 * it holds nothing usable, and the arithmetic on the way to an amount — which is the whole of
 * what was wrong.
 */

/** A Prisma stand-in holding the given settings rows. */
function prismaWith(rows: { key: string; value: string }[]): PrismaService {
  return {
    runAsPlatformOperation: <T>(work: () => Promise<T>) => work(),
    client: {
      platformSetting: {
        findUnique: ({ where }: { where: { key: string } }) =>
          Promise.resolve(rows.find((row) => row.key === where.key) ?? null),
      },
    },
  } as unknown as PrismaService;
}

/** A Prisma stand-in whose read fails. */
function prismaThatThrows(): PrismaService {
  return {
    runAsPlatformOperation: () => Promise.reject(new Error('connection lost')),
    client: {},
  } as unknown as PrismaService;
}

/** Quiet: these cases warn on purpose, and the warning is not what is under test. */
const logger = new Logger('token-sale-rate.spec');
logger.warn = () => {};

/** What the migration seeds: ₹100 and $3.80 for a thousand tokens. */
const SEEDED = [
  { key: 'commercial.uboss_token_price_minor_per_1000.INR', value: '10000' },
  { key: 'commercial.uboss_token_price_minor_per_1000.USD', value: '380' },
];

describe('tokenPriceSettingKey', () => {
  it('names the key the migration writes', () => {
    assert.equal(tokenPriceSettingKey('usd'), 'commercial.uboss_token_price_minor_per_1000.USD');
  });
});

describe('tokenSalePriceMinorPer1000', () => {
  it('prices INR at what Indian companies were already paying', async () => {
    assert.equal(await tokenSalePriceMinorPer1000(prismaWith(SEEDED), logger, 'INR'), 10_000);
  });

  it('prices USD at the ratio the plans use, not the day’s exchange rate', async () => {
    assert.equal(await tokenSalePriceMinorPer1000(prismaWith(SEEDED), logger, 'USD'), 380);
  });

  it('refuses a currency with no price rather than charging another currency’s', async () => {
    /*
     * The defect in one assertion. Before, a currency with no price of its own was charged the
     * INR rate, so fifty thousand tokens were sold to a USD company for $5,000.
     */
    assert.equal(await tokenSalePriceMinorPer1000(prismaWith(SEEDED), logger, 'EUR'), null);
  });

  it('does not fall back to the accounting rate', async () => {
    /*
     * `commercial.uboss_token_minor_units` still exists and still says 10 — it defines what a
     * token is for an allowance. Reading it here is exactly the bug that was removed.
     */
    const rate = await tokenSalePriceMinorPer1000(
      prismaWith([{ key: 'commercial.uboss_token_minor_units', value: '10' }]),
      logger,
      'INR',
    );
    assert.equal(rate, null);
  });

  it('reads the currency whatever case and spacing it arrives in', async () => {
    assert.equal(await tokenSalePriceMinorPer1000(prismaWith(SEEDED), logger, ' usd '), 380);
  });

  it('refuses a price below one minor unit rather than rounding it to zero', async () => {
    /*
     * A price of 0 would sell any number of tokens for nothing, and a fraction rounds to it. Both
     * are an operator's mistake, and neither is something to charge a card with.
     */
    const rate = await tokenSalePriceMinorPer1000(
      prismaWith([{ key: 'commercial.uboss_token_price_minor_per_1000.USD', value: '0' }]),
      logger,
      'USD',
    );
    assert.equal(rate, null);
  });

  it('refuses when the setting cannot be read at all', async () => {
    /*
     * A failed read is not a currency without a price. A refused top-up can be retried; a wrong
     * charge needs a refund.
     */
    assert.equal(await tokenSalePriceMinorPer1000(prismaThatThrows(), logger, 'INR'), null);
  });
});

describe('topUpAmountMinor', () => {
  it('charges an Indian company exactly what it paid before', () => {
    // ₹5,000 for fifty thousand tokens, the figure that was on the screen already.
    assert.equal(topUpAmountMinor(50_000, 10_000), 500_000);
  });

  it('charges an American company the ratio rather than the same number', () => {
    // $190, not $5,000.
    assert.equal(topUpAmountMinor(50_000, 380), 19_000);
  });

  it('is exact on the smallest top-up anybody can buy', () => {
    assert.equal(topUpAmountMinor(10_000, 380), 3_800);
  });

  it('rounds an odd token count once, on the total', () => {
    /*
     * The only place rounding bites: a figure typed by hand that is not a whole number of
     * thousands. 10,001 × 380 / 1000 is 3800.38, and the half-cent question is settled once on
     * the total rather than per token.
     */
    assert.equal(topUpAmountMinor(10_001, 380), 3_800);
  });

  it('never charges a fraction of a minor unit', () => {
    for (const tokens of [10_000, 10_001, 12_345, 999_999, 2_000_000]) {
      assert.ok(Number.isInteger(topUpAmountMinor(tokens, 380)));
    }
  });
});
