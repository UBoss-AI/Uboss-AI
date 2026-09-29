import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';

import { AuditEventService } from '../audit/audit-event.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../persistence/tenant-context.js';
import { mapStripeSubscriptionStatus } from './billing-mapping.js';
import { StripeClient } from './stripe.client.js';

/**
 * What the payment provider tells us, and what this product does about it.
 *
 * ## This endpoint is the only thing that changes what a company has paid for
 *
 * Not the redirect back from Checkout, which can be opened by hand and can be missed. Everything
 * that grants, suspends or records money happens here, on a delivery whose signature has been
 * verified against a shared secret.
 *
 * ## Three properties this file exists to hold
 *
 * **1. Verified.** An unsigned or wrongly signed delivery is refused before it is looked at. The
 * body of a webhook is attacker-controllable until the signature says otherwise, and acting on
 * one without verifying is the same as letting anybody on the internet mark invoices paid.
 *
 * **2. Idempotent.** The provider retries a delivery it did not get a clean answer to — for up to
 * three days in live mode. Every delivery is written first, keyed by the provider's own event id;
 * a second arrival of that id finds the row and stops. Without this, one retry of `invoice.paid`
 * is a second payment applied.
 *
 * **3. Ordered by the provider's clock, not ours.** Deliveries are not promised in order, so a
 * late `customer.subscription.updated` can arrive after a newer one. Subscription state is only
 * moved when the event is newer than what was last applied; an older one is recorded and ignored,
 * so a delayed delivery cannot resurrect a state the company has already left.
 *
 * ## Why every delivery gets a row even when nothing is done with it
 *
 * The failure this integration is most exposed to is a webhook that quietly stops arriving: the
 * product looks healthy, and every company slowly drifts out of date. A table of deliveries with
 * their outcomes makes that visible — "the last delivery was two days ago" is a sentence somebody
 * can act on, and it cannot be said without recording the ones that were ignored.
 */
@Injectable()
export class BillingWebhookService {
  private readonly logger = new Logger(BillingWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeClient,
    private readonly auditEvents: AuditEventService,
  ) {}

  /**
   * Verify a delivery and act on it.
   *
   * `payload` must be the **raw** request body. A parsed-and-reserialised body does not produce
   * the same bytes — key order and number formatting both differ — so the signature would never
   * match and every real delivery would be rejected as a forgery.
   */
  async handle(
    payload: Buffer,
    signature: string | undefined,
  ): Promise<{ received: true; outcome: string }> {
    const secret = this.stripe.webhookSecret;
    if (secret === null) {
      /*
       * Refused rather than trusted.
       *
       * Without the signing secret there is no way to tell a delivery from the provider apart
       * from a request somebody made up, and the things this endpoint does are "mark this invoice
       * paid" and "give this company access". An unverifiable webhook is not a degraded mode.
       */
      throw new BadRequestException(
        'This deployment cannot verify webhook deliveries because no webhook signing secret is ' +
          'configured. Nothing has been applied.',
      );
    }
    if (signature === undefined || signature.trim() === '') {
      throw new BadRequestException('This delivery carried no signature.');
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.require().webhooks.constructEvent(payload, signature, secret);
    } catch (error) {
      // The provider's own message says whether it was the signature, the timestamp tolerance or
      // the payload. It is safe to log — it contains no secret — and it is the only way to tell a
      // misconfigured secret apart from a replayed delivery.
      this.logger.warn(
        `Refused a webhook delivery: ${error instanceof Error ? error.message : 'unknown reason'}`,
      );
      throw new BadRequestException('That delivery could not be verified.');
    }

    // Written before it is acted on. A crash between the write and the work leaves a row with no
    // outcome, which reads as "arrived, never finished" — which is exactly what happened.
    const fresh = await this.claim(event);
    if (!fresh) {
      return { received: true, outcome: 'duplicate' };
    }

    try {
      const outcome = await this.apply(event);
      await this.close(event.id, outcome.outcome, outcome.detail, outcome.tenantId);
      return { received: true, outcome: outcome.outcome };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      await this.close(event.id, 'failed', detail.slice(0, 500), null);
      /*
       * Rethrown, deliberately.
       *
       * A non-2xx answer is what makes the provider retry, and a delivery this product failed to
       * apply is one it must be sent again. Swallowing the error would return 200 and lose the
       * event for good.
       */
      throw error;
    }
  }

  /** Record the delivery, or report that it has already been seen. */
  private async claim(event: Stripe.Event): Promise<boolean> {
    return this.prisma.runAsPlatformOperation(async () => {
      const existing = await this.prisma.client.stripeWebhookEvent.findUnique({
        where: { id: event.id },
      });
      if (existing !== null) return false;

      try {
        await this.prisma.client.stripeWebhookEvent.create({
          data: {
            id: event.id,
            type: event.type,
            livemode: event.livemode,
            occurredAt: new Date(event.created * 1000),
          },
        });
        return true;
      } catch {
        // Two deliveries of the same event racing each other. The loser treats it as a duplicate,
        // which it is.
        return false;
      }
    });
  }

  private async close(
    id: string,
    outcome: string,
    detail: string | null,
    tenantId: string | null,
  ): Promise<void> {
    await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.stripeWebhookEvent.update({
        where: { id },
        data: { processedAt: new Date(), outcome, detail, tenantId },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // What each kind of delivery means
  // -------------------------------------------------------------------------

  private async apply(
    event: Stripe.Event,
  ): Promise<{ outcome: string; detail: string | null; tenantId: string | null }> {
    switch (event.type) {
      case 'checkout.session.completed':
        return this.onCheckoutCompleted(event.data.object);

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed':
        return this.onSubscription(event.data.object, new Date(event.created * 1000));

      case 'invoice.finalized':
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.voided':
      case 'invoice.marked_uncollectible':
        return this.onInvoice(event.data.object);

      default:
        /*
         * Recorded, not acted on, and not an error.
         *
         * A Stripe account sends far more than this integration subscribes to, and treating an
         * unknown type as a failure would make the provider retry it for three days and fill the
         * console with red for events that mean nothing here.
         */
        return { outcome: 'ignored', detail: `No handler for ${event.type}.`, tenantId: null };
    }
  }

  /**
   * A company finished paying at the provider's hosted page.
   *
   * All this does is bind the provider's subscription to the company. The state comes from the
   * subscription events, which arrive for renewals and failures too — binding here and granting
   * there means there is exactly one place that decides what a company has.
   */
  private async onCheckoutCompleted(
    session: Stripe.Checkout.Session,
  ): Promise<{ outcome: string; detail: string | null; tenantId: string | null }> {
    const tenantId = session.client_reference_id;
    if (tenantId === null) {
      return {
        outcome: 'ignored',
        detail: 'The session carried no company reference.',
        tenantId: null,
      };
    }

    const subscriptionId =
      typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    const customerId =
      typeof session.customer === 'string' ? session.customer : session.customer?.id;

    if (subscriptionId === undefined || customerId === undefined) {
      return {
        outcome: 'ignored',
        detail: 'The session completed without a subscription — it was not a subscription sale.',
        tenantId,
      };
    }

    const scope = tenantScopeForPlatformOperation(tenantId);
    await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.tenantSubscription.updateMany({
        where: { tenantId },
        data: { stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId },
      }),
    );

    await this.auditEvents.recordForTenant(scope, {
      action: 'billing.subscription_linked',
      resourceType: 'tenant_subscription',
      resourceId: subscriptionId,
      summary: 'A payment completed at the provider and was bound to this company.',
      metadata: { stripeSubscriptionId: subscriptionId, stripeCustomerId: customerId },
    });

    return { outcome: 'applied', detail: 'Subscription bound.', tenantId };
  }

  /**
   * The provider's opinion of a subscription changed.
   *
   * This is the only place a company's commercial state moves on payment grounds.
   */
  private async onSubscription(
    subscription: Stripe.Subscription,
    occurredAt: Date,
  ): Promise<{ outcome: string; detail: string | null; tenantId: string | null }> {
    const tenantId = await this.tenantFor(subscription);
    if (tenantId === null) {
      return {
        outcome: 'ignored',
        detail: 'No company matches this subscription or its customer.',
        tenantId: null,
      };
    }

    const mapped = mapStripeSubscriptionStatus(subscription.status);
    if (mapped === null) {
      /*
       * A status this product has never seen. Nothing is changed.
       *
       * The two available guesses are "grant access" and "revoke access": one gives the product
       * away, the other locks a paying customer out of their own workspace. Neither is safe, so
       * the delivery is recorded as unhandled and a person decides.
       */
      this.logger.warn(
        `Unknown provider subscription status "${subscription.status}" for company ${tenantId}. ` +
          'Nothing was changed.',
      );
      return {
        outcome: 'ignored',
        detail: `Unrecognised provider status "${subscription.status}". Nothing was changed.`,
        tenantId,
      };
    }

    const current = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.tenantSubscription.findUnique({ where: { tenantId } }),
    );

    // Deliveries are not ordered. An event older than what has already been applied is recorded
    // and dropped, so a delayed one cannot resurrect a state the company has already left.
    if (current?.stripeSyncedAt != null && current.stripeSyncedAt > occurredAt) {
      return {
        outcome: 'ignored',
        detail: 'A newer delivery has already been applied.',
        tenantId,
      };
    }

    const periodEnd = subscriptionPeriodEnd(subscription);

    await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.tenantSubscription.updateMany({
        where: { tenantId },
        data: {
          state: mapped.state,
          billingState: mapped.billingState,
          stripeSubscriptionId: subscription.id,
          stripeStatus: subscription.status,
          stripeCurrentPeriodEnd: periodEnd,
          stripeSyncedAt: occurredAt,
        },
      }),
    );

    await this.auditEvents.recordForTenant(tenantScopeForPlatformOperation(tenantId), {
      action: 'billing.subscription_synced',
      resourceType: 'tenant_subscription',
      resourceId: subscription.id,
      summary:
        `The payment provider reports "${subscription.status}". This company is now ` +
        `${mapped.state}, ${mapped.billingState}.`,
      reason: 'The payment provider is the record of truth for whether a company has paid.',
      metadata: {
        stripeStatus: subscription.status,
        state: mapped.state,
        billingState: mapped.billingState,
        entitled: String(mapped.entitled),
      },
    });

    return {
      outcome: 'applied',
      detail: `${subscription.status} → ${mapped.state}/${mapped.billingState}`,
      tenantId,
    };
  }

  /** An invoice was issued, paid, or failed. Stored verbatim. */
  private async onInvoice(
    invoice: Stripe.Invoice,
  ): Promise<{ outcome: string; detail: string | null; tenantId: string | null }> {
    const customerId =
      typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    if (customerId === undefined) {
      return { outcome: 'ignored', detail: 'The invoice had no customer.', tenantId: null };
    }

    const tenantId = await this.tenantForCustomer(customerId);
    if (tenantId === null) {
      return {
        outcome: 'ignored',
        detail: 'No company matches this customer.',
        tenantId: null,
      };
    }

    /*
     * Every figure here is the provider's. Nothing is added up, converted or rounded — the only
     * arithmetic this product would be doing is arithmetic the provider has already done, and a
     * disagreement between the two is an invoice dispute.
     */
    const data = {
      tenantId,
      stripeInvoiceId: invoice.id ?? '',
      number: invoice.number ?? null,
      status: invoice.status ?? 'unknown',
      amountDueMinor: invoice.amount_due,
      amountPaidMinor: invoice.amount_paid,
      currency: invoice.currency.toUpperCase(),
      periodStart: invoice.period_start === null ? null : new Date(invoice.period_start * 1000),
      periodEnd: invoice.period_end === null ? null : new Date(invoice.period_end * 1000),
      paidAt:
        invoice.status === 'paid' && invoice.status_transitions.paid_at !== null
          ? new Date(invoice.status_transitions.paid_at * 1000)
          : null,
      dueAt: invoice.due_date === null ? null : new Date(invoice.due_date * 1000),
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      invoicePdfUrl: invoice.invoice_pdf ?? null,
      lastPaymentError: lastPaymentError(invoice),
    };

    if (data.stripeInvoiceId === '') {
      return { outcome: 'ignored', detail: 'The invoice had no id.', tenantId };
    }

    await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.billingInvoice.upsert({
        where: { stripeInvoiceId: data.stripeInvoiceId },
        create: data,
        update: data,
      }),
    );

    await this.auditEvents.recordForTenant(tenantScopeForPlatformOperation(tenantId), {
      action: 'billing.invoice_recorded',
      resourceType: 'billing_invoice',
      resourceRef: data.stripeInvoiceId,
      summary: `Invoice ${data.number ?? data.stripeInvoiceId} is ${data.status}.`,
      metadata: {
        status: data.status,
        amountDueMinor: String(data.amountDueMinor),
        amountPaidMinor: String(data.amountPaidMinor),
        currency: data.currency,
      },
    });

    return { outcome: 'applied', detail: `Invoice ${data.status}.`, tenantId };
  }

  // -------------------------------------------------------------------------
  // Which company an object belongs to
  // -------------------------------------------------------------------------

  /**
   * The company a subscription belongs to.
   *
   * The metadata written when the subscription was created is tried first, because it is exact.
   * The customer is the fallback, for a subscription created in the provider's own dashboard —
   * which is a real thing a finance team does, and it must not land nowhere.
   */
  private async tenantFor(subscription: Stripe.Subscription): Promise<string | null> {
    const fromMetadata = subscription.metadata?.['ubossTenantId'];
    if (typeof fromMetadata === 'string' && fromMetadata !== '') return fromMetadata;

    const customerId =
      typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
    return this.tenantForCustomer(customerId);
  }

  private async tenantForCustomer(customerId: string): Promise<string | null> {
    const row = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.tenantSubscription.findUnique({
        where: { stripeCustomerId: customerId },
        select: { tenantId: true },
      }),
    );
    return row?.tenantId ?? null;
  }
}

/**
 * The end of the paid period, wherever this API version keeps it.
 *
 * It moved from the subscription to its items in the 2025 versions, and reading the wrong one
 * yields `undefined` rather than an error — so access would be judged against a period end that
 * is always missing. Both are tried, and the value stays null if neither is there rather than
 * defaulting to a date.
 */
function subscriptionPeriodEnd(subscription: Stripe.Subscription): Date | null {
  const onSubscription = (subscription as unknown as { current_period_end?: number })
    .current_period_end;
  if (typeof onSubscription === 'number') return new Date(onSubscription * 1000);

  const onItem = subscription.items?.data?.[0] as unknown as { current_period_end?: number };
  if (typeof onItem?.current_period_end === 'number') {
    return new Date(onItem.current_period_end * 1000);
  }
  return null;
}

/** Why the last attempt failed, in the provider's own words, or null. */
function lastPaymentError(invoice: Stripe.Invoice): string | null {
  const payments = (
    invoice as unknown as {
      payments?: {
        data?: { payment?: { payment_intent?: { last_payment_error?: { message?: string } } } }[];
      };
    }
  ).payments;
  const message = payments?.data?.[0]?.payment?.payment_intent?.last_payment_error?.message;
  return typeof message === 'string' ? message.slice(0, 500) : null;
}
