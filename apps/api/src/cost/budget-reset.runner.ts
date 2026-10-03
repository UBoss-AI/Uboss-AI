import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { nextReset, remainingMinor, type ResetCadence } from '@uboss/types';

import { PrismaService } from '../persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../persistence/tenant-context.js';
import { CostEngineService } from './cost-engine.service.js';

/** How often the sweep looks for allowances that have come due. */
const DEFAULT_INTERVAL_MS = 5 * 60_000;

/**
 * Gives a recurring allowance back when its period turns over.
 *
 * ## What it is for
 *
 * A per-person daily allowance is the whole point. Every other budget scope describes *work* — a
 * department, an objective, an agent — and none of them stops one employee consuming a company's
 * entire month in an afternoon, leaving everybody else refused for something they did not do. A
 * person's allowance does, and an allowance that never comes back is a person who stops working
 * on the second day.
 *
 * ## What "reset" means here, and what it deliberately does not
 *
 * **`usedMinor` is never zeroed.** It is derived from an immutable ledger, and `reconcile` replays
 * that ledger against the maintained balance — so zeroing it would report drift for as long as the
 * company existed. The only ledger kind that reduces `used` is `Refund`, which would claim last
 * period's spend came back.
 *
 * So a reset is two ordinary ledger movements, exactly as the monthly company reset already does
 * it: what was left over lapses (`Expiry`), and the period's amount is granted afresh
 * (`Adjustment`). The arithmetic works because remaining is allowance minus used minus reserved,
 * and both sides move together.
 *
 * ## Catching up rather than forgiving
 *
 * A wallet three days behind is advanced three times, not once. A sweep that skipped to today
 * would quietly grant one day for three, and a person would be short exactly as much as the
 * system had been down. The loop is bounded so a wallet left for a year cannot hold the sweep.
 *
 * ## Running twice is harmless
 *
 * The advance is guarded on the wallet's own `resetsAt` inside the same transaction, so a second
 * instance reading the same row finds it already advanced and does nothing.
 */
@Injectable()
export class BudgetResetRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BudgetResetRunner.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cost: CostEngineService,
  ) {}

  onModuleInit(): void {
    if (process.env['NODE_ENV'] === 'test' || process.env['UBOSS_DISABLE_BACKGROUND_SWEEPS']) {
      this.logger.log('Budget resets are off in this environment.');
      return;
    }

    const configured = Number(process.env['UBOSS_BUDGET_RESET_INTERVAL_MS'] ?? DEFAULT_INTERVAL_MS);
    const every = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_INTERVAL_MS;

    this.timer = setInterval(() => {
      void this.sweepQuietly();
    }, every);
    this.timer.unref();
    this.logger.log(`Budget resets every ${Math.round(every / 60_000)} minutes.`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async sweepQuietly(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const outcome = await this.sweep();
      if (outcome.reset > 0) {
        this.logger.log(
          `Reset ${outcome.reset} allowance(s) across ${outcome.tenants} company(ies).`,
        );
      }
    } catch (error) {
      this.logger.error(
        `The budget reset sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Reset every allowance whose period has turned over.
   *
   * @param now injected by the tests, which have to place "due" somewhere they control.
   */
  async sweep(now: Date = new Date()): Promise<{ tenants: number; reset: number }> {
    const due = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.budgetWallet.findMany({
        where: {
          resetCadence: { not: 'None' },
          resetsAt: { lte: now },
        },
        select: { id: true, tenantId: true },
        // Bounded: a sweep is not a migration, and whatever is left is picked up next time.
        take: 2_000,
        orderBy: { resetsAt: 'asc' },
      }),
    );

    const tenants = new Set<string>();
    let reset = 0;

    for (const wallet of due) {
      try {
        const moved = await this.resetOne(wallet.tenantId, wallet.id, now);
        if (moved > 0) {
          tenants.add(wallet.tenantId);
          reset += 1;
        }
      } catch (error) {
        // One wallet's failure is one wallet's failure. Everybody else's allowance still returns.
        this.logger.warn(
          `Could not reset wallet ${wallet.id}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { tenants: tenants.size, reset };
  }

  /** @returns how many periods this wallet was advanced. */
  private async resetOne(tenantId: string, walletId: string, now: Date): Promise<number> {
    const scope = tenantScopeForPlatformOperation(tenantId);

    return this.prisma.runInTenantTransaction(scope, async () => {
      let periods = 0;

      // Bounded so a wallet nobody has touched for a year cannot hold the sweep. 400 covers more
      // than a year of daily periods, which is far longer than an outage anybody would recover
      // from by waiting.
      for (let guard = 0; guard < 400; guard += 1) {
        const wallet = await this.prisma.client.budgetWallet.findUnique({
          where: { id: walletId },
        });
        if (wallet === null) return periods;
        if (wallet.resetsAt === null || wallet.resetsAt.getTime() > now.getTime()) return periods;
        if (wallet.resetCadence === 'None' || wallet.recurringGrantMinor === null) return periods;

        const boundary = wallet.resetsAt;
        const leftOver = remainingMinor(wallet);

        /*
         * What was not spent lapses.
         *
         * A daily allowance that carried forward would not be a daily allowance — a person away
         * for a week would come back able to spend eight days at once, which is the opposite of
         * what a per-day limit is for. The company's own monthly period has a carry-forward
         * policy and keeps it; this is a different question with a different answer.
         */
        if (leftOver > 0) {
          await this.cost.recordPeriodMovement(scope, {
            walletId,
            kind: 'Expiry',
            amountMinor: leftOver,
            reason: `Unused allowance lapsed at the end of the ${wallet.resetCadence.toLowerCase()} period.`,
            occurredAt: boundary,
          });
        }

        await this.cost.recordPeriodMovement(scope, {
          walletId,
          kind: 'Adjustment',
          amountMinor: wallet.recurringGrantMinor,
          reason: `${wallet.resetCadence} allowance for the new period.`,
          occurredAt: boundary,
        });

        const advanced = nextReset(boundary, wallet.resetCadence as ResetCadence);
        await this.prisma.client.budgetWallet.update({
          // Guarded on the boundary this iteration read, so a second instance that advanced the
          // row first finds nothing to update and this loop re-reads and stops.
          where: { id: walletId, resetsAt: boundary },
          data: {
            periodStart: boundary,
            resetsAt: advanced,
            version: { increment: 1 },
          },
        });

        periods += 1;
      }

      this.logger.warn(
        `Wallet ${walletId} was more than 400 periods behind; the rest will be caught up next sweep.`,
      );
      return periods;
    });
  }
}
