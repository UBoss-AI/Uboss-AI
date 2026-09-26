import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';

import {
  readStripeConfiguration,
  stripeSecretKey,
  stripeUnavailableReason,
  stripeWebhookSecret,
  type StripeConfiguration,
} from './stripe.config.js';

/**
 * The provider's SDK, or an honest refusal.
 *
 * ## Why this is a seam and not a direct `new Stripe(...)` at each call site
 *
 * Two reasons, and neither is tidiness. First, a deployment with no credentials must refuse in
 * one place with one message, rather than throwing a provider library's own error out of whichever
 * route happened to be called. Second, every call to the provider is money or the record of it, so
 * there has to be exactly one object whose configuration can be inspected and logged — including
 * whether it is in test mode, which is the single most useful thing to know when an invoice is
 * missing.
 *
 * ## The client is built once and kept
 *
 * The SDK holds a connection pool and its own retry state; constructing one per request throws
 * both away. It is built lazily so that a deployment which never takes a payment never constructs
 * one at all.
 *
 * ## Nothing here reads a key twice
 *
 * The secret is read once, at construction, and is never returned, logged or attached to an
 * error. {@link StripeClient.configuration} is what the rest of the product is allowed to see.
 */
@Injectable()
export class StripeClient {
  private readonly logger = new Logger(StripeClient.name);
  private client: Stripe | null = null;
  private announced = false;

  /** What this deployment knows, re-read each time so a restart is the only thing needed. */
  get configuration(): StripeConfiguration {
    return readStripeConfiguration();
  }

  get connected(): boolean {
    return this.configuration.connected;
  }

  /** The webhook signing secret, for verification only. Never returned to a caller. */
  get webhookSecret(): string | null {
    return stripeWebhookSecret();
  }

  /**
   * The SDK, or null when this deployment has no secret key.
   *
   * Callers that can degrade — a screen listing what is already stored — use this. Callers that
   * cannot use {@link require}.
   */
  optional(): Stripe | null {
    if (this.client !== null) return this.client;

    const secret = stripeSecretKey();
    if (secret === null) return null;

    const configuration = this.configuration;
    this.client = new Stripe(secret, {
      /*
       * The version this integration was written and tested against, pinned.
       *
       * Left unpinned, the account's default version applies, and an account-level upgrade would
       * change the shape of objects this code reads — silently, in production, without a deploy.
       * Moving it is a deliberate change with its own testing.
       */
      apiVersion: '2026-08-26.dahlia',
      /*
       * Named so that a request from this product is identifiable in the provider's own logs. It
       * is the difference between "some integration created this subscription" and knowing which
       * deployment did.
       */
      appInfo: { name: 'UBoss AI AMS', url: 'https://uboss.ai' },
      maxNetworkRetries: 2,
    });

    // Said once, at first use, because "which mode is this deployment in" is the first question
    // asked when an invoice is missing — and the answer is otherwise nowhere.
    if (!this.announced) {
      this.announced = true;
      this.logger.log(
        `Payment provider connected in ${configuration.mode ?? 'an unrecognised'} mode` +
          (configuration.mode === 'live' ? ' — this deployment can take real money.' : '.'),
      );
    }

    return this.client;
  }

  /**
   * The SDK, or a 503 naming what is missing.
   *
   * A 503 rather than a 500: the request was well formed and the product is not broken — this
   * deployment simply cannot reach a payment provider, and that is an operator's problem with an
   * operator's fix.
   */
  require(): Stripe {
    const client = this.optional();
    const reason = stripeUnavailableReason(this.configuration);
    if (client === null || reason !== null) {
      throw new ServiceUnavailableException(
        reason ?? 'No payment provider is connected.',
      );
    }
    return client;
  }
}
