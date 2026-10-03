import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../persistence/prisma.service.js';

/** Hourly. The things being swept lapse over days, so nothing is gained by looking more often. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Closing out the things nobody finished.
 *
 * ## Why this exists
 *
 * Two rows in this product are created by somebody starting something and are never closed by
 * anybody finishing it:
 *
 *   * a **signup** that proved an address and then never published its DNS record;
 *   * a **top-up** whose payment page was opened and abandoned.
 *
 * Both carry a deadline — one an `expiresAt`, the other the provider's own session — and until
 * this existed nothing read either. The rows simply accumulated as `AwaitingDomain` and `Pending`
 * forever.
 *
 * ## Why that mattered more than it looks
 *
 * Not storage. A stale `AwaitingEmail` row is what refuses the same person a second signup —
 * "there is already a signup open for this address" — so somebody who gave up in March could not
 * start again in June. The limit was doing its job against a registration that had no chance of
 * being completed.
 *
 * And a top-up that stays `Pending` forever is indistinguishable, on the company's own screen,
 * from one that is about to succeed. The honest state after the window closes is "not completed",
 * which is a thing somebody can act on.
 *
 * ## Why nothing here is destructive
 *
 * It moves a state and writes a reason. No row is deleted: a signup that lapsed is the record of
 * somebody who tried, which is worth keeping, and an abandoned purchase is the record of an
 * intention to pay. Deleting either would also lose the only evidence for a dispute about whether
 * somebody was charged.
 */
@Injectable()
export class UnfinishedSweepRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UnfinishedSweepRunner.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    if (process.env['NODE_ENV'] === 'test' || process.env['UBOSS_DISABLE_BACKGROUND_SWEEPS']) {
      this.logger.log('The unfinished-signup sweep is off in this environment.');
      return;
    }

    const configured = Number(
      process.env['UBOSS_UNFINISHED_SWEEP_INTERVAL_MS'] ?? DEFAULT_INTERVAL_MS,
    );
    const every = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_INTERVAL_MS;

    this.timer = setInterval(() => {
      void this.sweepQuietly();
    }, every);
    this.timer.unref();
    this.logger.log(
      `Unfinished signups and top-ups swept every ${Math.round(every / 60_000)} minutes.`,
    );
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
      if (outcome.registrations > 0 || outcome.purchases > 0) {
        this.logger.log(
          `Closed ${outcome.registrations} lapsed signup(s) and ` +
            `${outcome.purchases} abandoned top-up(s).`,
        );
      }
    } catch (error) {
      this.logger.error(
        `The unfinished sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Close everything whose window has passed.
   *
   * @param now injected by the tests, which have to place "lapsed" somewhere they control.
   */
  async sweep(now: Date = new Date()): Promise<{ registrations: number; purchases: number }> {
    return this.prisma.runAsPlatformOperation(async () => {
      /*
       * A signup that ran out of time.
       *
       * `Completed` is excluded by listing the open states rather than by excluding the closed
       * one: a state added later is then left alone by default, which is the safe direction. The
       * opposite — sweeping everything that is not Completed — would one day abandon a state
       * somebody had just introduced.
       */
      const registrations = await this.prisma.client.pendingRegistration.updateMany({
        where: {
          state: { in: ['AwaitingEmail', 'AwaitingDomain', 'Ready'] },
          expiresAt: { lte: now },
        },
        data: {
          state: 'Abandoned',
          failureReason:
            'Not completed in time. Nothing was created, and a new signup can be started for ' +
            'this address or domain whenever you are ready.',
        },
      });

      /*
       * A top-up whose page was opened and left.
       *
       * Judged on age rather than on anything the provider says, because the provider says
       * nothing about a session nobody paid: there is no event for "a person closed the tab".
       * A day is far longer than a card form takes and far shorter than a company waits before
       * asking where its tokens are.
       *
       * `creditGrantId: null` is the guard that matters. A purchase that reached a wallet is
       * finished whatever its status column says, and marking one Abandoned after it had been
       * credited would tell a company its money went nowhere.
       */
      const purchases = await this.prisma.client.tokenPurchase.updateMany({
        where: {
          status: 'Pending',
          creditGrantId: null,
          createdAt: { lte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
        },
        data: {
          status: 'Abandoned',
          failureReason:
            'The payment was not completed. Nothing was charged, and no tokens were added.',
        },
      });

      return { registrations: registrations.count, purchases: purchases.count };
    });
  }
}
