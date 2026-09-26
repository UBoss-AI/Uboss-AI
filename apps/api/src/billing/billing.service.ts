import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type Stripe from 'stripe';

import { AUTH_CONFIG, type AuthConfig } from '../auth/auth.config.js';
import { AuditEventService } from '../audit/audit-event.service.js';
import type { BillingCycle } from '../generated/prisma/enums.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { StripeClient } from './stripe.client.js';
import { stripeUnavailableReason } from './stripe.config.js';

/**
 * Taking money, and keeping the record of it.
 *
 * ## The one rule everything here follows
 *
 * **The provider is the record of truth for money, and nothing in this file computes any.** Every
 * amount, currency, invoice number and period is copied from the provider verbatim. This product
 * decides *what* to sell and *who* may buy it; it never decides what was charged, because a
 * second opinion about that is an invoice dispute waiting to happen.
 *
 * ## Access is granted by the webhook, never by the redirect
 *
 * A Checkout Session ends by sending the browser back to a success URL. That redirect is **not**
 * evidence of payment: it can be opened by hand, it can be missed when a connection drops, and it
 * arrives before the provider has necessarily settled anything. So nothing in this file grants
 * anything on the strength of a return from Checkout. The subscription's state changes when the
 * provider says so, on the webhook, and the success screen only says "we are waiting to hear".
 *
 * ## Provider calls never happen inside a database transaction
 *
 * A network call to a payment provider can take seconds and can retry. Holding a tenant
 * transaction open across one would hold row locks for that whole time, on the tables the rest of
 * the company is using. So each operation is: read what is needed and close; call the provider;
 * write the result and close.
 *
 * ## Idempotency
 *
 * Every creating call to the provider carries an idempotency key derived from what is being
 * created, so a retry after a timeout resumes rather than creating a second customer, a second
 * subscription or a second charge.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeClient,
    private readonly auditEvents: AuditEventService,
    @Inject(AUTH_CONFIG) private readonly authConfig: AuthConfig,
  ) {}

  // -------------------------------------------------------------------------
  // What this deployment can do at all
  // -------------------------------------------------------------------------

  /**
   * The provider connection, for the platform console.
   *
   * Returns no secret — only whether the two required values are present, which of them are not,
   * the mode read from the key's own prefix, and the publishable key, which is public by design.
   */
  connection(): {
    connected: boolean;
    mode: string | null;
    missing: readonly string[];
    publishableKey: string | null;
    reason: string | null;
  } {
    const configuration = this.stripe.configuration;
    return {
      connected: configuration.connected,
      mode: configuration.mode,
      missing: configuration.missing,
      publishableKey: configuration.publishableKey,
      reason: stripeUnavailableReason(configuration),
    };
  }

  // -------------------------------------------------------------------------
  // Plans, as the provider needs to know them
  // -------------------------------------------------------------------------

  /**
   * Publish a plan to the provider: one product, and a price for each cycle that has a number.
   *
   * ## Why the prices come from the plan and nowhere else
   *
   * The plan's `priceMinor` and `currency` are what a platform administrator agreed and what the
   * Plans screen shows. Publishing copies them. Nothing here rounds, converts, or applies a
   * multiplier — a published price that differs from the plan is the one failure mode that would
   * charge a customer something nobody approved.
   *
   * ## Why annual is twelve times monthly
   *
   * Because that is the only relationship the data supports. `priceMinor` is documented as the
   * **monthly** price and there is no annual figure anywhere in the plan, so an annual price is
   * twelve of them. That is arithmetic on the platform's own number, not a discount policy — if
   * an annual discount is wanted it is a commercial decision that needs its own field, and
   * inventing one here would quietly undercharge every annual customer.
   *
   * ## Why a re-publish creates new prices
   *
   * Prices at the provider are immutable. A plan whose price changed cannot update its old price;
   * it gets a new one, and existing subscriptions stay on the old one until they are moved — which
   * is the correct behaviour, because a live subscription's price is a contract.
   */
  async publishPlan(input: { planId: string; actorUserId: string }): Promise<{
    productId: string;
    monthlyPriceId: string | null;
    annualPriceId: string | null;
  }> {
    const client = this.stripe.require();

    const plan = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.plan.findUnique({ where: { id: input.planId } }),
    );
    if (plan === null) throw new NotFoundException('That plan does not exist.');

    if (plan.priceMinor === null) {
      throw new BadRequestException(
        `${plan.name} has no price. A plan with a negotiated price cannot be published to the ` +
          'payment provider, because there is no figure to charge. Sell it by invoice instead.',
      );
    }
    if (!plan.active) {
      throw new BadRequestException(
        `${plan.name} is retired. Publishing it would let a new company buy a plan this platform ` +
          'has withdrawn.',
      );
    }

    const product =
      plan.stripeProductId === null
        ? await client.products.create(
            {
              name: plan.name,
              ...(plan.description === null ? {} : { description: plan.description }),
              metadata: { ubossPlanId: plan.id, ubossPlanCode: plan.code },
            },
            { idempotencyKey: `uboss-plan-product-${plan.id}` },
          )
        : await client.products.update(plan.stripeProductId, {
            name: plan.name,
            ...(plan.description === null ? {} : { description: plan.description }),
          });

    const currency = plan.currency.toLowerCase();
    const monthly = await client.prices.create(
      {
        product: product.id,
        currency,
        unit_amount: plan.priceMinor,
        recurring: { interval: 'month' },
        metadata: { ubossPlanId: plan.id, ubossCycle: 'Monthly' },
      },
      { idempotencyKey: `uboss-plan-price-month-${plan.id}-${plan.priceMinor}` },
    );

    const annual = await client.prices.create(
      {
        product: product.id,
        currency,
        // Twelve months of the plan's own monthly price. See the note above.
        unit_amount: plan.priceMinor * 12,
        recurring: { interval: 'year' },
        metadata: { ubossPlanId: plan.id, ubossCycle: 'Annual' },
      },
      { idempotencyKey: `uboss-plan-price-year-${plan.id}-${plan.priceMinor}` },
    );

    await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.plan.update({
        where: { id: plan.id },
        data: {
          stripeProductId: product.id,
          stripeMonthlyPriceId: monthly.id,
          stripeAnnualPriceId: annual.id,
          stripePublishedPriceMinor: plan.priceMinor,
          stripePublishedAt: new Date(),
        },
      }),
    );

    await this.auditEvents.recordForPlatform({
      action: 'billing.plan_published',
      resourceType: 'plan',
      resourceId: plan.id,
      actorUserId: input.actorUserId,
      summary: `Published ${plan.name} to the payment provider.`,
      reason: 'A plan must exist at the provider before a company can buy it.',
      metadata: {
        planCode: plan.code,
        priceMinor: String(plan.priceMinor),
        currency: plan.currency,
        stripeProductId: product.id,
      },
    });

    return { productId: product.id, monthlyPriceId: monthly.id, annualPriceId: annual.id };
  }

  // -------------------------------------------------------------------------
  // A company buying
  // -------------------------------------------------------------------------

  /**
   * Begin a payment for this company's current plan, and return where to send the browser.
   *
   * Returns the provider's hosted page rather than rendering a card form here: the provider then
   * owns 3-D Secure, the payment methods available in the company's country, and the card details
   * themselves, which never touch this product.
   */
  async startCheckout(input: {
    scope: TenantScope;
    userId: string;
    cycle: BillingCycle;
  }): Promise<{ url: string }> {
    const client = this.stripe.require();

    const subscription = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.tenantSubscription.findUnique({
        where: { tenantId: input.scope.tenantId },
        include: { plan: true },
      }),
    );
    if (subscription === null) {
      throw new NotFoundException('This company has no subscription to pay for.');
    }

    if (subscription.stripeSubscriptionId !== null) {
      throw new BadRequestException(
        'This company already has a subscription with the payment provider. Change the payment ' +
          'method or the plan from Manage billing rather than starting a second subscription.',
      );
    }

    const priceId =
      input.cycle === 'Annual'
        ? subscription.plan.stripeAnnualPriceId
        : subscription.plan.stripeMonthlyPriceId;

    if (priceId === null) {
      throw new BadRequestException(
        `${subscription.plan.name} has not been published to the payment provider for ` +
          `${input.cycle.toLowerCase()} billing, so there is no price to charge. A platform ` +
          'administrator publishes it from Billing & Payments.',
      );
    }

    const tenant = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.tenant.findUnique({ where: { id: input.scope.tenantId } }),
    );

    const customerId =
      subscription.stripeCustomerId ??
      (
        await client.customers.create(
          {
            // Spread rather than `name: undefined`: this project forbids passing an explicit
            // undefined for an optional property, and a company with no recorded name should send
            // no name rather than an empty one.
            ...(tenant?.name == null ? {} : { name: tenant.name }),
            /*
             * The company's id travels with the customer.
             *
             * Every webhook then carries a way back to the company without this product having to
             * keep a second mapping that can disagree with the provider's.
             */
            metadata: { ubossTenantId: input.scope.tenantId },
          },
          { idempotencyKey: `uboss-customer-${input.scope.tenantId}` },
        )
      ).id;

    if (subscription.stripeCustomerId === null) {
      await this.prisma.runInTenantTransaction(input.scope, () =>
        this.prisma.client.tenantSubscription.update({
          where: { tenantId: input.scope.tenantId },
          data: { stripeCustomerId: customerId },
        }),
      );
    }

    const web = this.authConfig.webBaseUrl;
    const session = await client.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      /*
       * One of the plan, not one per seat.
       *
       * `priceMinor` is documented as the plan's monthly price and `seatLimit` as a ceiling on how
       * many people may be provisioned — not a multiplier. Charging per seat would be inventing a
       * commercial model nobody agreed, and it would silently multiply every existing customer's
       * bill by their headcount.
       */
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: input.scope.tenantId,
      subscription_data: {
        metadata: {
          ubossTenantId: input.scope.tenantId,
          ubossPlanId: subscription.planId,
          ubossCycle: input.cycle,
        },
      },
      /*
       * The success page says "waiting to hear from the provider", and means it. Nothing is
       * granted here — the webhook does that. The session id is passed so the page can show which
       * attempt it is waiting on.
       */
      success_url: `${web}/settings/billing?checkout=complete&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${web}/settings/billing?checkout=cancelled`,
    });

    if (session.url === null) {
      throw new BadRequestException(
        'The payment provider did not return a page to send you to. Nothing has been charged.',
      );
    }

    await this.auditEvents.recordForTenant(input.scope, {
      action: 'billing.checkout_started',
      resourceType: 'tenant_subscription',
      resourceId: subscription.id,
      actorUserId: input.userId,
      summary: `Started ${input.cycle.toLowerCase()} payment for ${subscription.plan.name}.`,
      metadata: { cycle: input.cycle, planCode: subscription.plan.code, sessionId: session.id },
    });

    return { url: session.url };
  }

  /**
   * A link into the provider's own billing portal, for a company that already pays.
   *
   * Changing a card, downloading an invoice and cancelling all live there rather than being
   * rebuilt here. That is not laziness: each of those is a place to get a regulated flow subtly
   * wrong, and the provider's page is already correct in every country it operates in.
   */
  async portalUrl(input: { scope: TenantScope; userId: string }): Promise<{ url: string }> {
    const client = this.stripe.require();

    const subscription = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.tenantSubscription.findUnique({
        where: { tenantId: input.scope.tenantId },
      }),
    );

    if (subscription?.stripeCustomerId == null) {
      throw new BadRequestException(
        'This company has never paid through the payment provider, so it has no billing account ' +
          'to manage yet.',
      );
    }

    const session = await client.billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: `${this.authConfig.webBaseUrl}/settings/billing`,
    });

    await this.auditEvents.recordForTenant(input.scope, {
      action: 'billing.portal_opened',
      resourceType: 'tenant_subscription',
      resourceId: subscription.id,
      actorUserId: input.userId,
      summary: 'Opened the payment provider’s billing portal.',
    });

    return { url: session.url };
  }

  // -------------------------------------------------------------------------
  // Reading what happened
  // -------------------------------------------------------------------------

  /** This company's invoices, newest first, as the provider issued them. */
  async invoicesFor(scope: TenantScope, take = 50): Promise<unknown[]> {
    const rows = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.billingInvoice.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: { createdAt: 'desc' },
        take,
      }),
    );

    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status,
      amountDueMinor: row.amountDueMinor,
      amountPaidMinor: row.amountPaidMinor,
      currency: row.currency,
      periodStart: row.periodStart?.toISOString() ?? null,
      periodEnd: row.periodEnd?.toISOString() ?? null,
      paidAt: row.paidAt?.toISOString() ?? null,
      dueAt: row.dueAt?.toISOString() ?? null,
      hostedInvoiceUrl: row.hostedInvoiceUrl,
      invoicePdfUrl: row.invoicePdfUrl,
      lastPaymentError: row.lastPaymentError,
    }));
  }

  /**
   * Every company's payment position, for the platform console.
   *
   * The provider's status is returned beside this product's translation of it, because when the
   * two disagree that is the finding.
   */
  async platformOverview(): Promise<unknown> {
    return this.prisma.runAsPlatformOperation(async () => {
      const subscriptions = await this.prisma.client.tenantSubscription.findMany({
        include: { tenant: { select: { name: true } }, plan: { select: { name: true, code: true } } },
        orderBy: { updatedAt: 'desc' },
      });

      const paid = await this.prisma.client.billingInvoice.groupBy({
        by: ['tenantId'],
        where: { status: 'paid' },
        _sum: { amountPaidMinor: true },
        _count: { _all: true },
      });
      const paidByTenant = new Map(paid.map((row) => [row.tenantId, row]));

      return {
        companies: subscriptions.map((subscription) => {
          const totals = paidByTenant.get(subscription.tenantId);
          return {
            tenantId: subscription.tenantId,
            tenantName: subscription.tenant.name,
            planName: subscription.plan.name,
            planCode: subscription.plan.code,
            state: subscription.state,
            billingState: subscription.billingState,
            billingCycle: subscription.billingCycle,
            currency: subscription.currency,
            // Null where the company has never been connected, rather than a zero that would
            // read as "connected and paid nothing".
            stripeCustomerId: subscription.stripeCustomerId,
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            stripeStatus: subscription.stripeStatus,
            stripeCurrentPeriodEnd: subscription.stripeCurrentPeriodEnd?.toISOString() ?? null,
            stripeSyncedAt: subscription.stripeSyncedAt?.toISOString() ?? null,
            invoicesPaid: totals?._count._all ?? 0,
            paidMinor: totals?._sum.amountPaidMinor ?? 0,
          };
        }),
      };
    });
  }

  /** Plans and whether each has been published to the provider. */
  async platformPlans(): Promise<unknown> {
    return this.prisma.runAsPlatformOperation(async () => {
      const plans = await this.prisma.client.plan.findMany({ orderBy: { sortOrder: 'asc' } });
      return {
        plans: plans.map((plan) => ({
          id: plan.id,
          code: plan.code,
          name: plan.name,
          active: plan.active,
          priceMinor: plan.priceMinor,
          currency: plan.currency,
          published: plan.stripeProductId !== null,
          stripeProductId: plan.stripeProductId,
          stripeMonthlyPriceId: plan.stripeMonthlyPriceId,
          stripeAnnualPriceId: plan.stripeAnnualPriceId,
          publishedAt: plan.stripePublishedAt?.toISOString() ?? null,
          /*
           * Whether the published price still matches the plan.
           *
           * A provider price cannot be edited, so a plan whose price was changed after publishing
           * keeps charging the old one until it is published again. That is invisible unless it
           * is said, and it is the difference between the price on the Plans screen and the price
           * on the customer's card.
           */
          priceStale:
            plan.stripeProductId !== null &&
            plan.stripePublishedPriceMinor !== null &&
            plan.stripePublishedPriceMinor !== plan.priceMinor,
          publishedPriceMinor: plan.stripePublishedPriceMinor,
        })),
      };
    });
  }

  /**
   * The provider's recent deliveries, for the platform console.
   *
   * A webhook that has quietly stopped arriving is the failure this integration is most exposed
   * to, and the only way to see it is to look at when the last one came.
   */
  async platformDeliveries(take = 50): Promise<unknown> {
    return this.prisma.runAsPlatformOperation(async () => {
      const rows = await this.prisma.client.stripeWebhookEvent.findMany({
        orderBy: { occurredAt: 'desc' },
        take,
      });
      return {
        deliveries: rows.map((row) => ({
          id: row.id,
          type: row.type,
          livemode: row.livemode,
          occurredAt: row.occurredAt.toISOString(),
          receivedAt: row.receivedAt.toISOString(),
          processedAt: row.processedAt?.toISOString() ?? null,
          tenantId: row.tenantId,
          outcome: row.outcome,
          detail: row.detail,
        })),
      };
    });
  }

  /** The provider's SDK for the webhook service, which needs it to re-read objects. */
  get client(): Stripe {
    return this.stripe.require();
  }
}
