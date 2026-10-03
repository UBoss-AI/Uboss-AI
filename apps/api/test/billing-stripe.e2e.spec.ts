import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import Stripe from 'stripe';

import { BillingWebhookService } from '../src/billing/billing-webhook.service.js';
import {
  MAPPED_STRIPE_STATUSES,
  mapStripeSubscriptionStatus,
} from '../src/billing/billing-mapping.js';
import { StripeClient } from '../src/billing/stripe.client.js';
import { readStripeConfiguration } from '../src/billing/stripe.config.js';
import { AuditEventService } from '../src/audit/audit-event.service.js';
import { BillingNoticeService } from '../src/billing/billing-notice.service.js';
import { TokenPurchaseService } from '../src/billing/token-purchase.service.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { loadAuthConfig } from '../src/auth/auth.config.js';
import { CostEngineService } from '../src/cost/cost-engine.service.js';
import { CreditService } from '../src/cost/credit.service.js';
import { NotificationService } from '../src/notifications/notification.service.js';
import { NotificationRepository } from '../src/persistence/notification.repository.js';
import { OutboxRepository } from '../src/persistence/outbox.repository.js';
import { lifecycleCapability, refusalFor } from '../src/tenancy/tenant-lifecycle.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { CommercialService } from '../src/commercial/commercial.service.js';
import { CompanyLifecycleService } from '../src/commercial/company-lifecycle.service.js';
import { SeatService } from '../src/commercial/seat.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { ModuleEntitlementService } from '../src/commercial/module-entitlement.service.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { TenantRepository } from '../src/persistence/tenant.repository.js';
import {
  closeTestContext,
  createTestContext,
  isTestDatabaseReachable,
  migrateTestDatabase,
  reachabilityFailureReason,
  resetTestDatabase,
  type TestContext,
} from './support/test-database.js';

/**
 * Stripe billing, against real PostgreSQL and real signature verification.
 *
 * ## Where the weight of this suite is, and why
 *
 * The webhook endpoint is the only thing in this product that can mark an invoice paid or hand a
 * company access on payment grounds. Everything else about billing is a screen. So these tests are
 * almost entirely about that one path, and about the three ways it can be wrong:
 *
 *   1. **acting on an unverified delivery** — the body of a webhook is attacker-controllable until
 *      the signature says otherwise, so a forged one must change nothing;
 *   2. **acting on the same delivery twice** — the provider retries for up to three days, and a
 *      replayed `invoice.paid` must not be a second payment;
 *   3. **acting on deliveries out of order** — they are not promised in order, and a late one must
 *      not resurrect a state the company has already left.
 *
 * ## No network is reached
 *
 * Signature verification is a keyed hash over the body; it needs no call to the provider. So these
 * tests set a fabricated test-mode key and a fabricated signing secret, sign payloads with the
 * provider's own helper, and exercise the real verification code — which is the code that matters.
 * Nothing here contacts Stripe, and nothing here needs a real account.
 */

const WEBHOOK_SECRET = 'whsec_uboss_test_secret_for_signature_verification';
const SECRET_KEY = 'sk_test_uboss_fabricated_for_tests';

/** A Stripe event, signed the way the provider signs one. */
function signedDelivery(event: Record<string, unknown>): { payload: Buffer; signature: string } {
  const payload = Buffer.from(JSON.stringify(event), 'utf8');
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: payload.toString('utf8'),
    secret: WEBHOOK_SECRET,
  });
  return { payload, signature };
}

function subscriptionEvent(input: {
  id: string;
  type: string;
  createdSeconds: number;
  customerId: string;
  subscriptionId: string;
  status: string;
  tenantId: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    object: 'event',
    type: input.type,
    created: input.createdSeconds,
    livemode: false,
    data: {
      object: {
        id: input.subscriptionId,
        object: 'subscription',
        customer: input.customerId,
        status: input.status,
        metadata: { ubossTenantId: input.tenantId },
        items: { data: [{ current_period_end: input.createdSeconds + 2592000 }] },
      },
    },
  };
}

/**
 * A completed Checkout session for a one-off token purchase.
 *
 * `mode: 'payment'` and the purchase id in the metadata are what tell this apart from a
 * subscription sale — both arrive as the same event type, and a top-up has no subscription at all.
 */
function topUpSessionEvent(input: {
  id: string;
  createdSeconds: number;
  sessionId: string;
  purchaseId: string;
  tenantId: string;
  paymentStatus: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    object: 'event',
    type: 'checkout.session.completed',
    created: input.createdSeconds,
    livemode: false,
    data: {
      object: {
        id: input.sessionId,
        object: 'checkout.session',
        mode: 'payment',
        payment_status: input.paymentStatus,
        payment_intent: `pi_${input.purchaseId.slice(0, 20)}`,
        client_reference_id: input.tenantId,
        customer: null,
        subscription: null,
        metadata: {
          ubossTokenPurchaseId: input.purchaseId,
          ubossTenantId: input.tenantId,
        },
      },
    },
  };
}

function invoiceEvent(input: {
  id: string;
  type: string;
  createdSeconds: number;
  customerId: string;
  invoiceId: string;
  status: string;
  amountDue: number;
  amountPaid: number;
}): Record<string, unknown> {
  return {
    id: input.id,
    object: 'event',
    type: input.type,
    created: input.createdSeconds,
    livemode: false,
    data: {
      object: {
        id: input.invoiceId,
        object: 'invoice',
        customer: input.customerId,
        status: input.status,
        number: 'UB-TEST-0001',
        amount_due: input.amountDue,
        amount_paid: input.amountPaid,
        currency: 'usd',
        period_start: input.createdSeconds,
        period_end: input.createdSeconds + 2592000,
        due_date: null,
        hosted_invoice_url: 'https://invoice.stripe.com/test',
        invoice_pdf: 'https://invoice.stripe.com/test.pdf',
        status_transitions: { paid_at: input.status === 'paid' ? input.createdSeconds : null },
      },
    },
  };
}

/**
 * A webhook event id that is unique to this run.
 *
 * The ids used to be literals, which made the suite pass once and then fail on every later run
 * against the same database: the rows survive on purpose — they are what stops one provider retry
 * being applied twice — so the second run was correctly told its events were duplicates. Stamping
 * them keeps the idempotency behaviour genuinely under test instead of testing the leftovers.
 */
const RUN_STAMP = Date.now().toString(36);
const eid = (name: string): string => name + RUN_STAMP;

describe('Stripe billing (e2e)', () => {
  let context: TestContext;
  let webhooks: BillingWebhookService;
  let notices: BillingNoticeService;
  let topUps: TokenPurchaseService;

  /** The scope a company request would carry. Platform-shaped, because there is no request here. */
  const scopeFor = (id: string) => tenantScopeForPlatformOperation(id);
  let buyerId: string;

  let tenantId: string;
  const customerId = 'cus_uboss_test_company';
  const subscriptionId = 'sub_uboss_test_company';

  before(async () => {
    process.env['STRIPE_SECRET_KEY'] = SECRET_KEY;
    process.env['STRIPE_WEBHOOK_SECRET'] = WEBHOOK_SECRET;

    migrateTestDatabase();
    context = createTestContext();
    if (!(await isTestDatabaseReachable(context))) {
      throw new Error(reachabilityFailureReason());
    }

    const stripeClient = new StripeClient();
    const trail = new AuditTrailRepository(context.prisma);
    const auditEvents = new AuditEventService(context.prisma, trail);

    /*
     * The real lifecycle service, not a stand-in.
     *
     * What a payment event does to a company's *access* is the whole point of these tests now,
     * and a fake here would assert that this file calls a method rather than that a company
     * actually stops working. The chain is shallow enough to build by hand.
     */
    const lifecycle = new CompanyLifecycleService(
      context.prisma,
      new TenantRepository(context.prisma),
      auditEvents,
      new SecurityEventPublisher(new SecurityEventService(context.prisma, trail)),
    );

    /*
     * The real notification path too.
     *
     * A company losing write access and nobody being told was one of the gaps this work closed,
     * so the notice has to be exercised rather than stubbed — the assertion worth having is that
     * a row reaches an administrator, not that this file called a method.
     */
    const notifications = new NotificationService(
      context.prisma,
      new NotificationRepository(context.prisma),
      new OutboxRepository(context.prisma),
      auditEvents,
    );

    notices = new BillingNoticeService(context.prisma, notifications);

    /*
     * The real credit path, down to the ledger.
     *
     * A top-up that does not actually reach the wallet is the failure worth testing for, and the
     * only way to see it is to let `CreditService` write the grant, move the allowance and append
     * the ledger entry the way it does in the product — `reconcile` checks those three against
     * each other, and a stub here would hide a top-up that passed and credited nothing.
     */
    const cost = new CostEngineService(context.prisma, auditEvents, notifications);
    topUps = new TokenPurchaseService(
      context.prisma,
      stripeClient,
      new CreditService(context.prisma, cost, auditEvents, notifications),
      auditEvents,
      loadAuthConfig(),
    );

    /*
     * The real commercial service, because a paid upgrade moves the plan through it.
     *
     * A stub would assert that the webhook calls a method. What matters is that the company ends
     * up on the plan it paid for, with that plan's seats — and that a company already over the
     * new ceiling keeps everybody, which is arithmetic only this service knows.
     */
    const commercial = new CommercialService(
      context.prisma,
      new PlatformRepository(context.prisma),
      new SeatService(context.prisma),
      new AuthorizationService(
        context.prisma,
        new AuthorizationRepository(context.prisma),
        new SecurityEventPublisher(new SecurityEventService(context.prisma, trail)),
        new PlatformRepository(context.prisma),
        // The plan gate. `visibleModules` is narrowed to what the company bought, and this test
        // only reads commercial state, so a real one is cheaper than a stub that would have to
        // be kept in step with it.
        new ModuleEntitlementService(context.prisma),
      ),
      auditEvents,
      new SecurityEventPublisher(new SecurityEventService(context.prisma, trail)),
    );

    webhooks = new BillingWebhookService(
      context.prisma,
      stripeClient,
      auditEvents,
      lifecycle,
      notices,
      topUps,
      commercial,
    );
  });

  after(async () => {
    await closeTestContext(context);
    delete process.env['STRIPE_SECRET_KEY'];
    delete process.env['STRIPE_WEBHOOK_SECRET'];
  });

  beforeEach(async () => {
    await resetTestDatabase(context);

    // A company on a plan, with the provider's customer already linked — the position a company
    // is in the moment after it has paid once.
    const tenant = await context.admin.client.tenant.create({
      data: { name: 'SPM Medicare Pvt Ltd', slug: `spm-${Date.now()}`, lifecycleState: 'Active' },
    });
    tenantId = tenant.id;

    const plan = await context.admin.client.plan.create({
      data: {
        code: `growth-${Date.now()}`,
        tier: 'Growth',
        name: 'Growth',
        priceMinor: 49900,
        currency: 'USD',
        entitledModules: ['dashboard'],
      },
    });

    await context.admin.client.tenantSubscription.create({
      data: {
        tenantId,
        planId: plan.id,
        state: 'Pending',
        billingState: 'Current',
        stripeCustomerId: customerId,
        // INR, so a top-up's quote has a currency to be in. The plan is priced in USD, which is
        // the mismatch the document records as still to be decided.
        currency: 'INR',
      },
    });

    // Whoever presses Buy. Recorded on the purchase because the webhook has no actor of its own,
    // and a credit grant with no actor is one nobody asked for as far as the trail is concerned.
    const buyer = await context.admin.client.user.create({
      data: {
        ubossUniqueId: `UB-BUYER-${Date.now()}`,
        displayName: 'Aditi Sharma',
        email: `buyer-${Date.now()}@aarohan.test`,
      },
    });
    buyerId = buyer.id;
    await context.admin.client.tenantMembership.create({
      data: { tenantId, userId: buyerId, accountState: 'Active' },
    });
  });

  // -------------------------------------------------------------------------
  // 1. Nothing unverified is ever acted on
  // -------------------------------------------------------------------------

  describe('a delivery nobody can prove came from the provider', () => {
    it('is refused when it carries no signature at all', async () => {
      const event = subscriptionEvent({
        id: eid('evt_unsigned'),
        type: 'customer.subscription.updated',
        createdSeconds: Math.floor(Date.now() / 1000),
        customerId,
        subscriptionId,
        status: 'active',
        tenantId,
      });

      await assert.rejects(
        () => webhooks.handle(Buffer.from(JSON.stringify(event)), undefined),
        /signature/i,
      );

      // And nothing moved. This is the assertion that matters: a refusal that still applied the
      // change would be worse than no check at all.
      const subscription = await context.admin.client.tenantSubscription.findUnique({
        where: { tenantId },
      });
      assert.equal(subscription?.state, 'Pending');
      assert.equal(subscription?.stripeStatus, null);
    });

    it('is refused when the signature was made with a different secret', async () => {
      const event = subscriptionEvent({
        id: eid('evt_wrong_secret'),
        type: 'customer.subscription.updated',
        createdSeconds: Math.floor(Date.now() / 1000),
        customerId,
        subscriptionId,
        status: 'active',
        tenantId,
      });
      const payload = Buffer.from(JSON.stringify(event), 'utf8');
      const forged = Stripe.webhooks.generateTestHeaderString({
        payload: payload.toString('utf8'),
        secret: 'whsec_somebody_elses_secret',
      });

      await assert.rejects(() => webhooks.handle(payload, forged), /could not be verified/i);

      const subscription = await context.admin.client.tenantSubscription.findUnique({
        where: { tenantId },
      });
      assert.equal(subscription?.state, 'Pending');
    });

    it('is refused when the body was changed after it was signed', async () => {
      const created = Math.floor(Date.now() / 1000);
      const honest = subscriptionEvent({
        id: eid('evt_tampered'),
        type: 'customer.subscription.updated',
        createdSeconds: created,
        customerId,
        subscriptionId,
        status: 'incomplete',
        tenantId,
      });
      const { signature } = signedDelivery(honest);

      // The same event, but claiming the subscription is active — the change somebody forging one
      // would actually want to make.
      const tampered = subscriptionEvent({
        id: eid('evt_tampered'),
        type: 'customer.subscription.updated',
        createdSeconds: created,
        customerId,
        subscriptionId,
        status: 'active',
        tenantId,
      });

      await assert.rejects(
        () => webhooks.handle(Buffer.from(JSON.stringify(tampered)), signature),
        /could not be verified/i,
      );

      const subscription = await context.admin.client.tenantSubscription.findUnique({
        where: { tenantId },
      });
      assert.equal(subscription?.state, 'Pending');
    });
  });

  // -------------------------------------------------------------------------
  // 2. A verified delivery is applied — exactly once
  // -------------------------------------------------------------------------

  describe('a verified delivery', () => {
    it('moves the company to what the provider says, and records why', async () => {
      const created = Math.floor(Date.now() / 1000);
      const { payload, signature } = signedDelivery(
        subscriptionEvent({
          id: eid('evt_active'),
          type: 'customer.subscription.updated',
          createdSeconds: created,
          customerId,
          subscriptionId,
          status: 'active',
          tenantId,
        }),
      );

      const result = await webhooks.handle(payload, signature);
      assert.equal(result.outcome, 'applied');

      const subscription = await context.admin.client.tenantSubscription.findUnique({
        where: { tenantId },
      });
      assert.equal(subscription?.state, 'Active');
      assert.equal(subscription?.billingState, 'Current');
      // The provider's own word is kept beside the translation, so a disagreement can be seen.
      assert.equal(subscription?.stripeStatus, 'active');
      assert.equal(subscription?.stripeSubscriptionId, subscriptionId);

      const delivery = await context.admin.client.stripeWebhookEvent.findUnique({
        where: { id: eid('evt_active') },
      });
      assert.equal(delivery?.outcome, 'applied');
      assert.equal(delivery?.tenantId, tenantId);
      assert.notEqual(delivery?.processedAt, null);
    });

    it('is a no-op the second time it arrives, because the provider retries', async () => {
      const created = Math.floor(Date.now() / 1000);
      const { payload, signature } = signedDelivery(
        invoiceEvent({
          id: eid('evt_invoice_paid'),
          type: 'invoice.paid',
          createdSeconds: created,
          customerId,
          invoiceId: 'in_uboss_test_0001',
          status: 'paid',
          amountDue: 49900,
          amountPaid: 49900,
        }),
      );

      const first = await webhooks.handle(payload, signature);
      assert.equal(first.outcome, 'applied');

      const second = await webhooks.handle(payload, signature);
      assert.equal(second.outcome, 'duplicate');

      /*
       * One invoice, one payment.
       *
       * Without the idempotency this is two rows and twice the money in every total that reads
       * them — and it happens on an ordinary retry, not on an attack.
       */
      const invoices = await context.admin.client.billingInvoice.findMany({ where: { tenantId } });
      assert.equal(invoices.length, 1);
      assert.equal(invoices[0]?.amountPaidMinor, 49900);
      assert.equal(invoices[0]?.status, 'paid');
    });

    it('copies the provider’s figures rather than computing any', async () => {
      const created = Math.floor(Date.now() / 1000);
      const { payload, signature } = signedDelivery(
        invoiceEvent({
          id: eid('evt_invoice_partial'),
          type: 'invoice.payment_failed',
          createdSeconds: created,
          customerId,
          invoiceId: 'in_uboss_test_0002',
          status: 'open',
          amountDue: 49900,
          // Deliberately not equal to the amount due, and deliberately not a number this product
          // could derive: if anything here recalculated, this is where it would show.
          amountPaid: 12345,
        }),
      );

      await webhooks.handle(payload, signature);

      const invoice = await context.admin.client.billingInvoice.findUnique({
        where: { stripeInvoiceId: 'in_uboss_test_0002' },
      });
      assert.equal(invoice?.amountDueMinor, 49900);
      assert.equal(invoice?.amountPaidMinor, 12345);
      assert.equal(invoice?.currency, 'USD');
      assert.equal(invoice?.status, 'open');
      assert.equal(invoice?.paidAt, null);
    });
  });

  // -------------------------------------------------------------------------
  // 2b. A delivery this product failed to apply
  // -------------------------------------------------------------------------

  describe('a delivery that failed the first time', () => {
    it('is attempted again rather than being called a duplicate', async () => {
      const created = Math.floor(Date.now() / 1000);
      const id = eid('evt_retry_after_failure');

      /*
       * The row a failed attempt leaves behind.
       *
       * The service writes the delivery down before acting on it, so that a crash is visible. If
       * applying then throws, the row is closed as `failed` and the error is rethrown so the
       * provider retries — and until this behaviour existed, that retry found its own row and was
       * answered 200 as a duplicate. The event was then lost for good.
       *
       * Survivable when the worst case was a missing invoice row. Not survivable now that this
       * service decides whether a company may use the product at all.
       */
      await context.admin.client.stripeWebhookEvent.create({
        data: {
          id,
          type: 'customer.subscription.updated',
          livemode: false,
          occurredAt: new Date(created * 1000),
          processedAt: new Date(),
          outcome: 'failed',
          detail: 'the database went away mid-apply',
        },
      });

      const { payload, signature } = signedDelivery(
        subscriptionEvent({
          id,
          type: 'customer.subscription.updated',
          createdSeconds: created,
          customerId,
          subscriptionId,
          status: 'active',
          tenantId,
        }),
      );

      const result = await webhooks.handle(payload, signature);
      assert.equal(result.outcome, 'applied');

      const subscription = await context.admin.client.tenantSubscription.findUnique({
        where: { tenantId },
      });
      assert.equal(subscription?.state, 'Active');

      const delivery = await context.admin.client.stripeWebhookEvent.findUnique({ where: { id } });
      assert.equal(delivery?.outcome, 'applied');
      // The failure's own note is gone, because it is no longer what happened to this delivery.
      assert.equal(delivery?.detail?.includes('database went away'), false);
    });

    it('still refuses a second attempt while the first one is in flight', async () => {
      const created = Math.floor(Date.now() / 1000);
      const id = eid('evt_in_flight');

      // Written and not yet closed: an attempt that is still running. Letting a second one in
      // beside it is how a payment gets applied twice, so this one stays a duplicate.
      await context.admin.client.stripeWebhookEvent.create({
        data: {
          id,
          type: 'customer.subscription.updated',
          livemode: false,
          occurredAt: new Date(created * 1000),
        },
      });

      const { payload, signature } = signedDelivery(
        subscriptionEvent({
          id,
          type: 'customer.subscription.updated',
          createdSeconds: created,
          customerId,
          subscriptionId,
          status: 'active',
          tenantId,
        }),
      );

      const result = await webhooks.handle(payload, signature);
      assert.equal(result.outcome, 'duplicate');

      const subscription = await context.admin.client.tenantSubscription.findUnique({
        where: { tenantId },
      });
      assert.equal(subscription?.state, 'Pending');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Order is the provider's, not the network's
  // -------------------------------------------------------------------------

  describe('deliveries that arrive out of order', () => {
    it('does not let an older delivery undo a newer one', async () => {
      const now = Math.floor(Date.now() / 1000);

      // The newer truth arrives first: this company stopped paying.
      const newer = signedDelivery(
        subscriptionEvent({
          id: eid('evt_newer_unpaid'),
          type: 'customer.subscription.updated',
          createdSeconds: now,
          customerId,
          subscriptionId,
          status: 'unpaid',
          tenantId,
        }),
      );
      await webhooks.handle(newer.payload, newer.signature);

      // Then a delayed older one, saying everything is fine.
      const older = signedDelivery(
        subscriptionEvent({
          id: eid('evt_older_active'),
          type: 'customer.subscription.updated',
          createdSeconds: now - 600,
          customerId,
          subscriptionId,
          status: 'active',
          tenantId,
        }),
      );
      const result = await webhooks.handle(older.payload, older.signature);

      assert.equal(result.outcome, 'ignored');

      const subscription = await context.admin.client.tenantSubscription.findUnique({
        where: { tenantId },
      });
      // Still suspended. A delayed delivery must not give the product away.
      assert.equal(subscription?.state, 'Suspended');
      assert.equal(subscription?.stripeStatus, 'unpaid');
    });
  });

  // -------------------------------------------------------------------------
  // 4. What is not understood changes nothing
  // -------------------------------------------------------------------------

  describe('what this product does not understand', () => {
    it('records an unknown event type without acting on it', async () => {
      const { payload, signature } = signedDelivery({
        id: eid('evt_unknown_type'),
        object: 'event',
        type: 'radar.early_fraud_warning.created',
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        data: { object: { id: 'issfr_test' } },
      });

      const result = await webhooks.handle(payload, signature);
      assert.equal(result.outcome, 'ignored');

      const delivery = await context.admin.client.stripeWebhookEvent.findUnique({
        where: { id: eid('evt_unknown_type') },
      });
      assert.equal(delivery?.outcome, 'ignored');
      assert.match(delivery?.detail ?? '', /No handler/);
    });

    it('changes nothing on a subscription status it has no translation for', async () => {
      const { payload, signature } = signedDelivery(
        subscriptionEvent({
          id: eid('evt_unknown_status'),
          type: 'customer.subscription.updated',
          createdSeconds: Math.floor(Date.now() / 1000),
          customerId,
          subscriptionId,
          status: 'some_status_stripe_added_later',
          tenantId,
        }),
      );

      const result = await webhooks.handle(payload, signature);
      assert.equal(result.outcome, 'ignored');

      /*
       * Unchanged, deliberately.
       *
       * The two available guesses are "grant access" and "revoke access": one gives the product
       * away, the other locks a paying customer out of their own workspace. Neither is a safe
       * default, so nothing moves and the delivery says why.
       */
      const subscription = await context.admin.client.tenantSubscription.findUnique({
        where: { tenantId },
      });
      assert.equal(subscription?.state, 'Pending');
      assert.equal(subscription?.stripeStatus, null);
    });
  });

  // -------------------------------------------------------------------------
  // 5. What a payment event does to the company's actual access
  // -------------------------------------------------------------------------

  /**
   * The tests that make the rest of this file mean something.
   *
   * Everything above proves the product writes down what the provider said. For a long time that
   * was all it did: `TenantSubscription.state` went to `Suspended` and the request guard never
   * read it, because what the guard enforces is `Tenant.lifecycleState` — a different column, set
   * by a different service. A company whose card failed was marked unpaid and carried on working.
   *
   * So these assert on `lifecycleState`, not on the subscription row. A test that checked the
   * subscription row would have passed throughout the entire period the defect existed.
   */
  describe('what it does to the company’s access', () => {
    /** Push one subscription status through the webhook and return the company's state after. */
    const deliver = async (
      status: string,
      name: string,
      createdSeconds = Math.floor(Date.now() / 1000),
    ): Promise<string> => {
      const { payload, signature } = signedDelivery(
        subscriptionEvent({
          id: eid(name),
          type: 'customer.subscription.updated',
          createdSeconds,
          customerId,
          subscriptionId,
          status,
          tenantId,
        }),
      );
      await webhooks.handle(payload, signature);
      const tenant = await context.admin.client.tenant.findUnique({ where: { id: tenantId } });
      return tenant?.lifecycleState ?? 'missing';
    };

    it('stops a company working once the provider has given up collecting', async () => {
      assert.equal(await deliver('unpaid', 'evt_access_unpaid'), 'ReadOnly');

      // Read-only rather than suspended, and that is the whole design: they can still see their
      // own data and still reach the screen that takes a payment. Suspended would lock them out
      // of the room containing the Pay button.
      const capability = lifecycleCapability('ReadOnly');
      assert.equal(capability.canAccess, true);
      assert.equal(capability.canWrite, false);
    });

    it('keeps a company working while the provider is still retrying the card', async () => {
      // `past_due` is Grace, and Grace is not a punishment. Locking somebody out of their own
      // workspace on the first failed charge is a support ticket, not a collection strategy.
      assert.equal(await deliver('past_due', 'evt_access_pastdue'), 'Active');
    });

    it('gives the company back when it pays', async () => {
      const base = Math.floor(Date.now() / 1000);
      assert.equal(await deliver('unpaid', 'evt_access_lapse', base), 'ReadOnly');
      assert.equal(await deliver('active', 'evt_access_recover', base + 60), 'Active');
    });

    it('does not throw when the provider redelivers the same lapse', async () => {
      const base = Math.floor(Date.now() / 1000);
      assert.equal(await deliver('unpaid', 'evt_access_twice_a', base), 'ReadOnly');
      // A different event id carrying the same status — which is what a provider sending
      // `customer.subscription.updated` twice actually looks like. Moving a company to a state
      // it is already in must not be an error: a 409 here would make the provider retry for days.
      assert.equal(await deliver('unpaid', 'evt_access_twice_b', base + 60), 'ReadOnly');
    });

    it('does not reopen a company a person suspended deliberately', async () => {
      await context.admin.client.tenant.update({
        where: { id: tenantId },
        data: { lifecycleState: 'Suspended' },
      });

      /*
       * A payment succeeding must not undo a human decision.
       *
       * Somebody at UBoss suspended this company for a reason that is recorded against their
       * name — a security incident, a legal hold, an abuse report. None of those are settled by
       * a card going through.
       */
      assert.equal(await deliver('active', 'evt_access_no_reopen'), 'Suspended');
    });

    it('does not lift a read-only that a person put the company into', async () => {
      await context.admin.client.tenant.update({
        where: { id: tenantId },
        data: { lifecycleState: 'ReadOnly' },
      });
      await context.admin.client.tenantLifecycleTransition.create({
        data: {
          tenantId,
          fromState: 'Active',
          toState: 'ReadOnly',
          reason: 'Frozen during a data dispute.',
          effectiveAt: new Date(),
          appliedAt: new Date(),
          // Set, so it was a person. The null case is the system's own, and only that one is
          // lifted by a payment.
          actorUserId: '01a0a8fb-8f67-71cb-99f8-f9fdedde810d',
        },
      });

      assert.equal(await deliver('active', 'evt_access_human_readonly'), 'ReadOnly');
    });

    it('leaves a company that is still being provisioned alone', async () => {
      await context.admin.client.tenant.update({
        where: { id: tenantId },
        data: { lifecycleState: 'Provisioning' },
      });

      // Billing has nothing to say about a company that has not opened yet, and saying something
      // would move it into a state its provisioning never finished arriving at.
      assert.equal(await deliver('unpaid', 'evt_access_provisioning'), 'Provisioning');
    });

    it('tells the company why, instead of just saying read-only', async () => {
      await deliver('unpaid', 'evt_access_reason');

      const tenant = await context.admin.client.tenant.findUnique({ where: { id: tenantId } });
      assert.equal(tenant?.accessReasonCode, 'PaymentOverdue');

      /*
       * The sentence an employee actually gets when their save is refused.
       *
       * "This company is in read-only mode, so changes cannot be saved" is true and useless: it
       * does not say the cause is money and does not say where to fix it, so the person raises a
       * ticket instead of telling their administrator to pay.
       */
      const refusal = refusalFor('ReadOnly', tenant?.accessReasonCode ?? null);
      assert.match(refusal, /not been paid/i);
      assert.match(refusal, /Settings . Billing/i);
      assert.match(refusal, /nothing has been deleted/i);
    });

    it('clears the reason when the company pays, so a later freeze does not borrow it', async () => {
      const base = Math.floor(Date.now() / 1000);
      await deliver('unpaid', 'evt_reason_set', base);
      await deliver('active', 'evt_reason_cleared', base + 60);

      const tenant = await context.admin.client.tenant.findUnique({ where: { id: tenantId } });
      assert.equal(tenant?.accessReasonCode, null);
      // And a company that is simply Active never shows a reason, whatever is stored.
      assert.equal(refusalFor('Active', 'PaymentOverdue'), 'Active.');
    });

    it('tells the company’s administrators, and only once per episode', async () => {
      // An administrator who can actually act: paying needs `settings:Administer`, and the notice
      // goes to the people who hold it rather than to everybody who feels it.
      const stamp = Date.now();
      const admin = await context.admin.client.user.create({
        data: {
          ubossUniqueId: `UB-NOTICE-${stamp}`,
          displayName: 'Aditi Sharma',
          email: `aditi-${stamp}@aarohan.test`,
        },
      });
      await context.admin.client.tenantMembership.create({
        data: { tenantId, userId: admin.id, accountState: 'Active' },
      });
      await context.admin.client.roleAssignment.create({
        data: {
          tenantId,
          userId: admin.id,
          roleKind: 'CompanyAdmin',
          scopeKind: 'WholeCompany',
          grantedByUserId: admin.id,
        },
      });

      await deliver('unpaid', 'evt_notice_raised');

      const raised = await context.admin.client.notification.findMany({
        where: { tenantId, kind: 'SubscriptionLapsed' },
      });
      assert.equal(raised.length, 1);
      assert.equal(raised[0]?.recipientUserId, admin.id);
      assert.equal(raised[0]?.severity, 'Critical');
      // Mandatory, because muting it means learning the workspace stopped by failing to save.
      assert.equal(raised[0]?.isMandatory, true);
      assert.match(raised[0]?.body ?? '', /Settings . Billing/i);
      assert.equal(raised[0]?.deepLink, '/settings/billing');

      /*
       * A second delivery of the same lapse tells nobody again.
       *
       * The company is already read-only, so the second one moves nothing and raises nothing.
       * Without that, a provider retrying for three days would send three days of identical
       * critical alerts, and the next real one would be ignored.
       */
      await deliver('unpaid', 'evt_notice_not_repeated');
      const after = await context.admin.client.notification.findMany({
        where: { tenantId, kind: 'SubscriptionLapsed' },
      });
      assert.equal(after.length, 1);
    });

    it('records the access change in the company’s own trail, with the reason', async () => {
      await deliver('unpaid', 'evt_access_audited');

      const events = await context.admin.client.auditEvent.findMany({
        where: { tenantId, action: 'company.lifecycle_changed' },
      });
      assert.equal(events.length, 1);
      assert.equal(events[0]?.summary, 'Active → ReadOnly.');
      // A customer asking "what happened to my workspace" is entitled to the answer, in their
      // own trail, including the fact that nothing was deleted.
      assert.match(events[0]?.reason ?? '', /nothing has been deleted/i);

      const transitions = await context.admin.client.tenantLifecycleTransition.findMany({
        where: { tenantId },
      });
      assert.equal(transitions.length, 1);
      assert.equal(transitions[0]?.toState, 'ReadOnly');
      // Null is the record that this was the system and not a person — and it is what the
      // restore path reads to decide whether a payment may lift it.
      assert.equal(transitions[0]?.actorUserId, null);
    });
  });

  // -------------------------------------------------------------------------
  // 5b. Buying more tokens outright
  // -------------------------------------------------------------------------

  describe('a token top-up', () => {
    /** The row `start` would have written, without needing to reach the provider. */
    const quoted = async (tokens: number, sessionId: string): Promise<string> => {
      const purchase = await context.admin.client.tokenPurchase.create({
        data: {
          tenantId,
          providerSessionRef: sessionId,
          tokens,
          // Ten paise to the token: the rate the platform setting carries, recorded on the row
          // because a purchase credited at a different rate is a different purchase.
          amountMinor: tokens * 10,
          currency: 'INR',
          tokenMinorUnits: 10,
          status: 'Pending',
          requestedByUserId: buyerId,
        },
      });
      return purchase.id;
    };

    const deliverTopUp = async (
      name: string,
      purchaseId: string,
      sessionId: string,
      paymentStatus = 'paid',
    ): Promise<string> => {
      const { payload, signature } = signedDelivery(
        topUpSessionEvent({
          id: eid(name),
          createdSeconds: Math.floor(Date.now() / 1000),
          sessionId,
          purchaseId,
          tenantId,
          paymentStatus,
        }),
      );
      const result = await webhooks.handle(payload, signature);
      return result.outcome;
    };

    it('refuses a top-up below the floor, before anybody is sent to pay', async () => {
      await assert.rejects(
        () => topUps.start({ scope: scopeFor(tenantId), userId: buyerId, tokens: 500 }),
        /smallest top-up/i,
      );
      // And nothing was written down, so there is no half-made purchase to explain later.
      const rows = await context.admin.client.tokenPurchase.findMany({ where: { tenantId } });
      assert.equal(rows.length, 0);
    });

    it('refuses a typo that would charge five hundred times the intent', async () => {
      await assert.rejects(
        () => topUps.start({ scope: scopeFor(tenantId), userId: buyerId, tokens: 5_000_000 }),
        /largest single top-up/i,
      );
    });

    it('quotes what it will charge, in the company’s own currency', async () => {
      const quote = await topUps.quote(scopeFor(tenantId), 50_000);
      assert.equal(quote.ok, true);
      assert.equal(quote.tokens, 50_000);
      assert.equal(quote.amountMinor, 500_000);
      assert.equal(quote.currency, 'INR');
    });

    it('credits the wallet when the provider says it was paid', async () => {
      const purchaseId = await quoted(50_000, 'cs_topup_paid');
      assert.equal(await deliverTopUp('evt_topup_paid', purchaseId, 'cs_topup_paid'), 'applied');

      const purchase = await context.admin.client.tokenPurchase.findUnique({
        where: { id: purchaseId },
      });
      assert.equal(purchase?.status, 'Paid');
      assert.notEqual(purchase?.creditGrantId, null);
      assert.notEqual(purchase?.paidAt, null);

      /*
       * The grant, and the wallet behind it.
       *
       * The assertion that matters is not that a row says Paid — it is that the company can now
       * spend what it bought. `allowanceMinor` is what the hard stop reads.
       */
      const grant = await context.admin.client.creditGrant.findUnique({
        where: { id: purchase?.creditGrantId ?? '' },
      });
      assert.equal(grant?.source, 'TopUp');
      assert.equal(grant?.amountMinor, 500_000);

      const wallet = await context.admin.client.budgetWallet.findFirst({
        where: { tenantId, scope: 'Company', subjectId: null },
      });
      assert.equal(wallet?.allowanceMinor, 500_000);
    });

    it('credits once, however many times the provider redelivers', async () => {
      const purchaseId = await quoted(50_000, 'cs_topup_twice');
      assert.equal(await deliverTopUp('evt_topup_once', purchaseId, 'cs_topup_twice'), 'applied');

      // A different event id carrying the same purchase — which is what a provider resending
      // `checkout.session.completed` looks like. The second must add nothing.
      assert.equal(await deliverTopUp('evt_topup_again', purchaseId, 'cs_topup_twice'), 'ignored');

      const grants = await context.admin.client.creditGrant.findMany({
        where: { tenantId, source: 'TopUp' },
      });
      assert.equal(grants.length, 1);

      const wallet = await context.admin.client.budgetWallet.findFirst({
        where: { tenantId, scope: 'Company', subjectId: null },
      });
      assert.equal(wallet?.allowanceMinor, 500_000);
    });

    it('credits nothing when the session completed without being paid', async () => {
      const purchaseId = await quoted(50_000, 'cs_topup_unpaid');
      assert.equal(
        await deliverTopUp('evt_topup_unpaid', purchaseId, 'cs_topup_unpaid', 'unpaid'),
        'ignored',
      );

      const purchase = await context.admin.client.tokenPurchase.findUnique({
        where: { id: purchaseId },
      });
      assert.equal(purchase?.status, 'Pending');
      assert.equal(purchase?.creditGrantId, null);

      const grants = await context.admin.client.creditGrant.findMany({ where: { tenantId } });
      assert.equal(grants.length, 0);
    });

    it('credits nothing for a purchase this product never wrote down', async () => {
      /*
       * A session naming a purchase id that does not exist.
       *
       * Recorded and ignored rather than failing: the alternative is a delivery the provider
       * retries for three days over a row that will never appear. What must not happen is credit
       * being invented for it, and nothing here can.
       */
      assert.equal(
        await deliverTopUp(
          'evt_topup_unknown',
          '01a00000-0000-7000-8000-000000000000',
          'cs_topup_unknown',
        ),
        'ignored',
      );

      const grants = await context.admin.client.creditGrant.findMany({ where: { tenantId } });
      assert.equal(grants.length, 0);
    });

    it('never tells the company the rate it was priced at', async () => {
      const purchaseId = await quoted(50_000, 'cs_topup_rate');
      await deliverTopUp('evt_topup_rate', purchaseId, 'cs_topup_rate');

      const listed = (await topUps.listFor(scopeFor(tenantId))) as Record<string, unknown>[];
      assert.equal(listed.length, 1);
      // What it bought and what it paid are its own business. The rate the platform computes
      // with is not on any company-facing response.
      assert.equal('tokenMinorUnits' in (listed[0] ?? {}), false);
      assert.equal(listed[0]?.['tokens'], 50_000);
      assert.equal(listed[0]?.['amountMinor'], 500_000);
    });
  });

  // -------------------------------------------------------------------------
  // 5c. Paying to move to a different plan
  // -------------------------------------------------------------------------

  describe('a paid upgrade', () => {
    /** A second plan to move to, with more of everything. */
    const biggerPlan = async (code: string, seats: number, allowance: number) =>
      context.admin.client.plan.create({
        data: {
          code,
          tier: 'Growth',
          name: code.toUpperCase(),
          seatLimit: seats,
          aiAllowanceMinor: allowance,
          priceMinor: 190_000,
          currency: 'USD',
          entitledModules: ['dashboard', 'objective', 'agents'],
        },
      });

    /** The subscription event a completed upgrade Checkout produces. */
    const deliverUpgrade = async (name: string, planCode: string): Promise<string> => {
      const event = subscriptionEvent({
        id: eid(name),
        type: 'customer.subscription.created',
        createdSeconds: Math.floor(Date.now() / 1000),
        customerId,
        subscriptionId,
        status: 'active',
        tenantId,
      });
      // The plan travels in the subscription's metadata, which is where Checkout put it.
      const object = (event['data'] as { object: Record<string, unknown> }).object;
      object['metadata'] = { ubossTenantId: tenantId, ubossPlanCode: planCode };

      const { payload, signature } = signedDelivery(event);
      const result = await webhooks.handle(payload, signature);
      return result.outcome;
    };

    it('moves the company to the plan it paid for, with that plan’s seats', async () => {
      await biggerPlan(`growth-up-${Date.now()}`, 40, 5_000_000);
      const code = (
        await context.admin.client.plan.findFirst({
          where: { tier: 'Growth' },
          orderBy: { createdAt: 'desc' },
        })
      )?.code;

      assert.equal(await deliverUpgrade('evt_upgrade_paid', code ?? ''), 'applied');

      const subscription = await context.admin.client.tenantSubscription.findUnique({
        where: { tenantId },
        include: { plan: true },
      });
      assert.equal(subscription?.plan.code, code);
      // Seats and allowance from the plan row, not from anything in the payment.
      assert.equal(subscription?.seatsLicensed, 40);
      assert.equal(subscription?.aiAllowanceMinor, 5_000_000);
    });

    it('moves it once, however many times the provider redelivers', async () => {
      await biggerPlan(`growth-twice-${Date.now()}`, 40, 5_000_000);
      const code = (
        await context.admin.client.plan.findFirst({
          where: { tier: 'Growth' },
          orderBy: { createdAt: 'desc' },
        })
      )?.code;

      await deliverUpgrade('evt_upgrade_a', code ?? '');
      await deliverUpgrade('evt_upgrade_b', code ?? '');

      const changes = await context.admin.client.auditEvent.findMany({
        where: { tenantId, action: 'commercial.plan_changed_on_payment' },
      });
      // One move, one audit event. The second delivery finds the company already there.
      assert.equal(changes.length, 1);
    });

    it('records that nobody at UBoss approved it, because nobody had to', async () => {
      await biggerPlan(`growth-trail-${Date.now()}`, 40, 5_000_000);
      const code = (
        await context.admin.client.plan.findFirst({
          where: { tier: 'Growth' },
          orderBy: { createdAt: 'desc' },
        })
      )?.code;

      await deliverUpgrade('evt_upgrade_trail', code ?? '');

      const event = await context.admin.client.auditEvent.findFirst({
        where: { tenantId, action: 'commercial.plan_changed_on_payment' },
      });
      /*
       * The trail says the payment was the approval.
       *
       * Every other plan change here goes through a request somebody decides. Manufacturing a
       * request-and-approval pair for this one, to make the trail look familiar, would record a
       * decision nobody made.
       */
      assert.match(event?.reason ?? '', /no decision for anybody at UBoss to make/i);
      const metadata = (event?.metadata ?? {}) as Record<string, unknown>;
      assert.equal(metadata['nobodyRemoved'], true);
    });

    it('does not move the company on a status that is not paid', async () => {
      await biggerPlan(`growth-unpaid-${Date.now()}`, 40, 5_000_000);
      const code = (
        await context.admin.client.plan.findFirst({
          where: { tier: 'Growth' },
          orderBy: { createdAt: 'desc' },
        })
      )?.code;

      const event = subscriptionEvent({
        id: eid('evt_upgrade_incomplete'),
        type: 'customer.subscription.created',
        createdSeconds: Math.floor(Date.now() / 1000),
        customerId,
        subscriptionId,
        status: 'incomplete',
        tenantId,
      });
      const object = (event['data'] as { object: Record<string, unknown> }).object;
      object['metadata'] = { ubossTenantId: tenantId, ubossPlanCode: code };

      const { payload, signature } = signedDelivery(event);
      await webhooks.handle(payload, signature);

      // `incomplete` is the state an abandoned card step leaves behind. Nothing was collected, so
      // nothing is granted — the plan must not move on an intention to pay.
      const subscription = await context.admin.client.tenantSubscription.findUnique({
        where: { tenantId },
        include: { plan: true },
      });
      assert.notEqual(subscription?.plan.code, code);
    });
  });

  // -------------------------------------------------------------------------
  // 6. The translation itself
  // -------------------------------------------------------------------------

  describe('the provider’s status, translated', () => {
    it('never grants access on a status the provider says is not paid', () => {
      for (const status of ['incomplete', 'incomplete_expired', 'unpaid', 'canceled', 'paused']) {
        const mapped = mapStripeSubscriptionStatus(status);
        assert.equal(mapped?.entitled, false, `"${status}" must not entitle`);
      }
    });

    it('keeps a company working while the provider is still retrying', () => {
      // `past_due` is the first failed card, not the end of the relationship. Locking somebody out
      // of their own workspace at that point is a support ticket, not a collection strategy.
      const mapped = mapStripeSubscriptionStatus('past_due');
      assert.equal(mapped?.entitled, true);
      assert.equal(mapped?.billingState, 'Grace');
      assert.equal(mapped?.state, 'Active');
    });

    it('does not put somebody who has left into a collections state', () => {
      const mapped = mapStripeSubscriptionStatus('canceled');
      assert.equal(mapped?.state, 'Cancelled');
      // Nothing is owed by somebody who cancelled; Overdue would queue them for money not due.
      assert.equal(mapped?.billingState, 'Current');
    });

    it('answers null for anything it has never seen', () => {
      assert.equal(mapStripeSubscriptionStatus('not_a_real_status'), null);
      assert.ok(MAPPED_STRIPE_STATUSES.length >= 8);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Configuration is read, never assumed
  // -------------------------------------------------------------------------

  describe('the provider configuration', () => {
    it('reads test or live from the key itself, so a deployment cannot be wrong about it', () => {
      assert.equal(readStripeConfiguration({ STRIPE_SECRET_KEY: 'sk_test_x' }).mode, 'test');
      assert.equal(readStripeConfiguration({ STRIPE_SECRET_KEY: 'sk_live_x' }).mode, 'live');
      assert.equal(readStripeConfiguration({ STRIPE_SECRET_KEY: 'something_else' }).mode, null);
    });

    it('is not connected without a webhook secret, however good the key is', () => {
      /*
       * Half-configured is absent.
       *
       * With a secret key and no signing secret, payments could be started and none of them could
       * ever be verified — every company would pay and none would be granted anything.
       */
      const configuration = readStripeConfiguration({ STRIPE_SECRET_KEY: 'sk_test_x' });
      assert.equal(configuration.connected, false);
      assert.ok(configuration.missing.includes('STRIPE_WEBHOOK_SECRET'));
    });

    it('never returns a secret', () => {
      const configuration = readStripeConfiguration({
        STRIPE_SECRET_KEY: SECRET_KEY,
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        STRIPE_PUBLISHABLE_KEY: 'pk_test_public',
      });
      const serialised = JSON.stringify(configuration);
      assert.ok(!serialised.includes(SECRET_KEY), 'the secret key must never be serialisable');
      assert.ok(
        !serialised.includes(WEBHOOK_SECRET),
        'the signing secret must never be serialisable',
      );
      // The publishable key is public by design and is the one thing that may come back.
      assert.equal(configuration.publishableKey, 'pk_test_public');
    });
  });
});
