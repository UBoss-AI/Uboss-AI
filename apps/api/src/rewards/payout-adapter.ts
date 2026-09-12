import { Injectable, Logger } from '@nestjs/common';

import type { PayoutRequest, PayoutResult } from '@uboss/types';

/**
 * The integration boundary for an approved payroll or payment connector.
 *
 * ## Why this is a seam and not an implementation
 *
 * The client's instruction is to **expose an integration boundary** for an approved payroll or
 * payment connector, and separately that cash is never auto-paid. Those two together mean the
 * honest shape is an interface with no real provider behind it: UBoss knows how to ask a payroll
 * system to pay somebody, and today nothing answers.
 *
 * The alternative — a stub that returns a plausible reference and reports success — would be the
 * single most dangerous thing in this codebase. Somebody would read "Settled · ref PAY-8842" in a
 * report and believe an employee had been paid. So `deliveredRealPayment` is part of the result
 * type rather than an implementation detail, it is **stored on the award**, and the default
 * adapter refuses outright rather than pretending.
 *
 * ## What a real connector changes
 *
 * One class and one registry entry. The award lifecycle, the four-eyes control, the audit trail,
 * the provider-reference requirement and the "only Cash is settled" rule are all
 * provider-agnostic and stay exactly as they are.
 */
export abstract class PayoutAdapter {
  /** Which connector this speaks to, matching a `CONNECTOR_DEFINITIONS` kind. */
  abstract readonly kind: string;

  /**
   * Whether this adapter can actually move money.
   *
   * Read before a settlement is attempted, so the refusal happens before any state changes rather
   * than as a failed write half way through.
   */
  abstract readonly canSettle: boolean;

  abstract settle(request: PayoutRequest): Promise<PayoutResult>;
}

/**
 * What ships: an adapter that refuses.
 *
 * No payroll provider has been approved or integrated, so this is the truthful implementation.
 * It throws rather than returning a failed result, because a caller that ignored a soft failure
 * would leave an award looking settled.
 */
@Injectable()
export class UnconfiguredPayoutAdapter extends PayoutAdapter {
  readonly kind = 'none';
  readonly canSettle = false;

  private readonly logger = new Logger(UnconfiguredPayoutAdapter.name);

  async settle(request: PayoutRequest): Promise<PayoutResult> {
    this.logger.warn(
      `Refused a settlement for award ${request.awardId}: no payroll connector is configured.`,
    );
    throw new Error(
      'No approved payroll or payment connector is configured. UBoss will not record a payment ' +
        'it did not make.',
    );
  }
}

/**
 * A mock payroll adapter, for tests and for exercising the governance around a real one.
 *
 * `deliveredRealPayment` is **false**, always, and that is the point: every test that walks an
 * award to `Settled` proves the lifecycle, the four-eyes control and the audit trail work, and
 * none of them can be mistaken for evidence that a payment happened. `payout_was_real` on the
 * award carries the same false value into the database.
 *
 * Instructed through the reference so a test can drive a failure without a network: a reference
 * beginning `fail:` makes the settlement throw.
 */
export class MockPayrollPayoutAdapter extends PayoutAdapter {
  readonly kind = 'mock-payroll';
  readonly canSettle = true;

  constructor(private readonly nextReference: () => string = () => `MOCK-${Date.now()}`) {
    super();
  }

  async settle(request: PayoutRequest): Promise<PayoutResult> {
    const reference = this.nextReference();

    if (reference.startsWith('fail:')) {
      throw new Error(`The payroll connector refused: ${reference.slice('fail:'.length)}`);
    }

    return {
      reference,
      // Never true. A mock that claimed otherwise would make every green settlement test a lie.
      deliveredRealPayment: false,
      detail:
        `Mock payroll accepted ${request.amountMinorUnits} minor units for ` +
        `${request.subjectUserId}. **No real payment was made.**`,
    };
  }
}
