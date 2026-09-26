import { Module } from '@nestjs/common';

import { PlatformBillingController } from './billing-platform.controller.js';
import { BillingWebhookService } from './billing-webhook.service.js';
import { StripeWebhookController } from './billing-webhook.controller.js';
import { CompanyBillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { StripeClient } from './stripe.client.js';

/**
 * Taking payment, and keeping the record of it.
 *
 * ## Why this is its own module rather than part of `commercial`
 *
 * The commercial module owns what a company has agreed to: its plan, its seats, its entitlements
 * and its lifecycle. This one owns whether the money for that arrived. They are different
 * questions with different sources of truth — one is negotiated here, the other is settled at a
 * payment provider — and keeping them apart is what lets the provider be swapped without touching
 * any of the commercial rules.
 *
 * Not `@Global`: nothing outside billing needs to take a payment, and making it global would
 * invite exactly that.
 */
@Module({
  controllers: [CompanyBillingController, PlatformBillingController, StripeWebhookController],
  providers: [StripeClient, BillingService, BillingWebhookService],
  exports: [BillingService],
})
export class BillingModule {}
