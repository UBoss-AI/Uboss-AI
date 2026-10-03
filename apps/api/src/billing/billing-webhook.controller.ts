import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { AllowAnonymous } from '../tenancy/tenancy.decorators.js';
import { BillingWebhookService } from './billing-webhook.service.js';

/**
 * Where the payment provider tells us what happened.
 *
 * ## Why this route is anonymous, and why that is not a hole
 *
 * The provider is not a user of this product: it holds no session, belongs to no company, and
 * cannot be asked to sign in. What authenticates a delivery is the signature over its body,
 * computed with a secret only this deployment and the provider share. That check happens in the
 * service, before anything is read out of the body, and a delivery that fails it is refused.
 *
 * `@AllowAnonymous` is therefore deliberate and narrow: it opens exactly one route, and that route
 * trusts nothing until the signature says so.
 *
 * ## Why the body arrives as a Buffer
 *
 * The signature is over the **exact bytes** the provider sent. A body that has been parsed to JSON
 * and serialised again is not those bytes — key order and number formatting both differ — so every
 * genuine delivery would be rejected as a forgery. `main.ts` routes this one path to a raw body
 * parser for that reason, and this handler asserts it got one rather than assuming.
 *
 * ## Why it answers 200 for a duplicate and 4xx/5xx for a failure
 *
 * A non-2xx answer is what makes the provider retry. A delivery that was already applied must not
 * be retried — that is the whole point of the idempotency — so it answers 200. A delivery this
 * product genuinely failed to apply must be retried, so the error is allowed out.
 */
@Controller('billing/stripe')
export class StripeWebhookController {
  constructor(private readonly webhooks: BillingWebhookService) {}

  @Post('webhook')
  @AllowAnonymous()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: Request,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<unknown> {
    const body: unknown = request.body;
    if (!Buffer.isBuffer(body)) {
      /*
       * Refused rather than coerced.
       *
       * If this is ever not a Buffer, the raw-body route in `main.ts` has stopped matching this
       * path, and every signature check from that moment would fail in a way that looks like a
       * wrong secret. Saying so here turns a confusing outage into one sentence.
       */
      throw new BadRequestException(
        'This endpoint did not receive a raw request body, so no delivery can be verified. The ' +
          'raw-body route in the API bootstrap no longer matches this path.',
      );
    }

    return this.webhooks.handle(body, signature);
  }
}
