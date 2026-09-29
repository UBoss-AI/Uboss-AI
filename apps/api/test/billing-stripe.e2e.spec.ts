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
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
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
    const auditEvents = new AuditEventService(
      context.prisma,
      new AuditTrailRepository(context.prisma),
    );
    webhooks = new BillingWebhookService(context.prisma, stripeClient, auditEvents);
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
      },
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
  // 5. The translation itself
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
