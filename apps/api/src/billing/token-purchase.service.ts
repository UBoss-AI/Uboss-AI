import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { validateTopUpTokens } from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { CreditService } from '../cost/credit.service.js';
import { ubossTokenMinorUnits } from '../cost/uboss-token.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  tenantScopeForPlatformOperation,
  type TenantScope,
} from '../persistence/tenant-context.js';
import { AUTH_CONFIG, type AuthConfig } from '../auth/auth.config.js';
import { Inject } from '@nestjs/common';
import { StripeClient } from './stripe.client.js';

/**
 * Buying more UBoss Tokens, when the month's allowance has run out.
 *
 * ## Why this is a purchase and not a subscription change
 *
 * The plan's allowance is what a company agreed to receive every month. A top-up is extra, now,
 * once — it does not change next month's allowance and must not look as though it has. Folding it
 * into the subscription would do exactly that, and the company would be surprised in both
 * directions: a bigger bill next month, and a smaller allowance than they thought they had bought.
 *
 * ## The quote is recorded before the browser leaves
 *
 * Every figure the company was shown — the tokens, the amount, the currency and **the rate those
 * two were computed from** — is written down before they are sent to the provider. The rate
 * matters most: it is a platform setting that can change, and a purchase quoted at one rate and
 * credited at another is this product charging for one thing and delivering another.
 *
 * ## Nothing is credited until the provider says so
 *
 * The same rule the rest of billing follows. The return from Checkout can be opened by hand and
 * can be missed; the webhook is the only thing that moves credit into a wallet.
 */
@Injectable()
export class TokenPurchaseService {
  private readonly logger = new Logger(TokenPurchaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeClient,
    private readonly credits: CreditService,
    private readonly auditEvents: AuditEventService,
    @Inject(AUTH_CONFIG) private readonly authConfig: AuthConfig,
  ) {}

  /** What a given number of tokens would cost, for the screen that asks before it sells. */
  async quote(
    scope: TenantScope,
    tokens: number,
  ): Promise<{
    tokens: number;
    amountMinor: number;
    currency: string;
    ok: boolean;
    reason: string;
  }> {
    const check = validateTopUpTokens(tokens);
    const rate = await ubossTokenMinorUnits(this.prisma, this.logger);
    const currency = await this.currencyFor(scope);

    return {
      tokens,
      amountMinor: check.ok ? tokens * rate : 0,
      currency,
      ok: check.ok,
      reason: check.reason,
    };
  }

  /**
   * Start a purchase, and return where to send the browser.
   *
   * The provider's hosted page rather than a card form here: it owns 3-D Secure, the payment
   * methods available in the company's country, and the card details, which never touch this
   * product.
   */
  async start(input: {
    scope: TenantScope;
    userId: string;
    tokens: number;
  }): Promise<{ url: string; purchaseId: string; tokens: number; amountMinor: number }> {
    const client = this.stripe.require();

    const check = validateTopUpTokens(input.tokens);
    if (!check.ok) throw new BadRequestException(check.reason);

    const rate = await ubossTokenMinorUnits(this.prisma, this.logger);
    const currency = await this.currencyFor(input.scope);
    const amountMinor = input.tokens * rate;

    /*
     * The row first, then the provider.
     *
     * Written as `Pending` before the session exists, so a company that pays on a page this
     * product then fails to record is impossible: there is no window in which money can move
     * against a purchase nobody wrote down.
     */
    const purchase = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.tokenPurchase.create({
        data: {
          tenantId: input.scope.tenantId,
          // Replaced with the real session id below. Unique, so two in flight cannot collide.
          providerSessionRef: `pending:${input.scope.tenantId}:${Date.now()}`,
          tokens: input.tokens,
          amountMinor,
          currency,
          tokenMinorUnits: rate,
          status: 'Pending',
          requestedByUserId: input.userId,
        },
      }),
    );

    const web = this.authConfig.webBaseUrl;
    const session = await client.checkout.sessions.create(
      {
        mode: 'payment',
        client_reference_id: input.scope.tenantId,
        line_items: [
          {
            price_data: {
              currency: currency.toLowerCase(),
              unit_amount: amountMinor,
              product_data: {
                name: `${input.tokens.toLocaleString('en-IN')} UBoss Tokens`,
                description: 'A one-off top-up, added to this company’s AI allowance.',
              },
            },
            quantity: 1,
          },
        ],
        /*
         * The purchase id travels with the payment.
         *
         * The webhook finds the row by this rather than by the amount: two companies buying the
         * same number of tokens in the same minute would otherwise be indistinguishable, and
         * crediting the wrong wallet is not a mistake that shows up quickly.
         */
        metadata: { ubossTokenPurchaseId: purchase.id, ubossTenantId: input.scope.tenantId },
        success_url: `${web}/settings/billing?topup=complete&purchase=${purchase.id}`,
        cancel_url: `${web}/settings/billing?topup=cancelled&purchase=${purchase.id}`,
      },
      { idempotencyKey: `uboss-topup-${purchase.id}` },
    );

    if (session.url === null) {
      await this.prisma.runInTenantTransaction(input.scope, () =>
        this.prisma.client.tokenPurchase.update({
          where: { id: purchase.id },
          data: { status: 'Failed', failureReason: 'The provider returned no payment page.' },
        }),
      );
      throw new BadRequestException(
        'The payment provider did not return a page to send you to. Nothing has been charged.',
      );
    }

    await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.tokenPurchase.update({
        where: { id: purchase.id },
        data: { providerSessionRef: session.id, checkoutUrl: session.url },
      }),
    );

    await this.auditEvents.recordForTenant(input.scope, {
      action: 'billing.topup_started',
      resourceType: 'token_purchase',
      resourceId: purchase.id,
      actorUserId: input.userId,
      summary: `Started a top-up of ${input.tokens.toLocaleString('en-IN')} UBoss Tokens.`,
      metadata: {
        tokens: String(input.tokens),
        amountMinor: String(amountMinor),
        currency,
        // The rate is recorded here too, because this event is what an auditor reads when a
        // company disputes what it was charged for a top-up.
        tokenMinorUnits: String(rate),
      },
    });

    return { url: session.url, purchaseId: purchase.id, tokens: input.tokens, amountMinor };
  }

  /**
   * A top-up was paid for. Credit the wallet, exactly once.
   *
   * Called from the webhook and from nowhere else.
   *
   * ## Why `creditGrantId` is what makes this idempotent
   *
   * Not `status`. The provider retries, and a second delivery of the same event must not add a
   * second lot of credit — but it is `creditGrantId` that records whether the credit actually
   * moved. A row that is `Paid` with no grant is a payment taken and not yet credited, which has
   * to be retryable; a row with a grant is finished, whatever its status says.
   */
  async markPaid(input: {
    purchaseId: string;
    providerPaymentRef: string | null;
  }): Promise<{ credited: boolean; detail: string; tenantId: string | null }> {
    const purchase = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.tokenPurchase.findUnique({ where: { id: input.purchaseId } }),
    );

    if (purchase === null) {
      return {
        credited: false,
        detail: 'No such top-up. The session named one this product has never written down.',
        tenantId: null,
      };
    }

    if (purchase.creditGrantId !== null) {
      return {
        credited: false,
        detail: 'Already credited. This is a redelivery.',
        tenantId: purchase.tenantId,
      };
    }

    const scope = tenantScopeForPlatformOperation(purchase.tenantId);

    /*
     * The grant the credits module already makes.
     *
     * Not a direct wallet update: `grant` writes the lot, moves the allowance and appends the
     * ledger entry in one transaction, and `reconcile` checks the three against each other. A
     * wallet moved from here would pass unnoticed until that reconciliation found drift it could
     * not explain.
     *
     * The actor is whoever pressed Buy, which is why the purchase row records them: a webhook has
     * no actor, and a credit with none is one nobody asked for as far as the trail is concerned.
     */
    const grant = await this.credits.grant({
      scope,
      actorUserId: purchase.requestedByUserId,
      source: 'TopUp',
      amountMinor: purchase.amountMinor,
      effectiveFrom: new Date(),
      reason:
        `A purchased top-up of ${purchase.tokens.toLocaleString('en-IN')} UBoss Tokens, paid ` +
        'through the payment provider.',
      reference: purchase.providerSessionRef,
    });

    await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.tokenPurchase.update({
        where: { id: purchase.id },
        data: {
          status: 'Paid',
          paidAt: new Date(),
          creditGrantId: grant.id,
          ...(input.providerPaymentRef === null
            ? {}
            : { providerPaymentRef: input.providerPaymentRef }),
        },
      }),
    );

    await this.auditEvents.recordForTenant(scope, {
      action: 'billing.topup_credited',
      resourceType: 'token_purchase',
      resourceId: purchase.id,
      actorUserId: purchase.requestedByUserId,
      summary: `Credited ${purchase.tokens.toLocaleString('en-IN')} UBoss Tokens.`,
      reason: 'The payment provider confirmed the payment.',
      metadata: {
        tokens: String(purchase.tokens),
        amountMinor: String(purchase.amountMinor),
        currency: purchase.currency,
        creditGrantId: grant.id,
      },
    });

    this.logger.log(
      `Credited ${purchase.tokens} UBoss Tokens to company ${purchase.tenantId} ` +
        `(purchase ${purchase.id}).`,
    );

    return {
      credited: true,
      detail: `Credited ${purchase.tokens} tokens.`,
      tenantId: purchase.tenantId,
    };
  }

  /** This company's top-ups, newest first. */
  async listFor(scope: TenantScope, take = 20): Promise<unknown[]> {
    const rows = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.tokenPurchase.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: { createdAt: 'desc' },
        take,
      }),
    );

    return rows.map((row) => ({
      id: row.id,
      tokens: row.tokens,
      amountMinor: row.amountMinor,
      currency: row.currency,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      paidAt: row.paidAt?.toISOString() ?? null,
      // So a company that closed the tab can get back to an unfinished one.
      checkoutUrl: row.status === 'Pending' ? row.checkoutUrl : null,
      failureReason: row.failureReason,
      /*
       * Deliberately not `tokenMinorUnits`.
       *
       * The rate is platform-plane: a company sees what it bought and what it paid, which is its
       * own business, and not the rate the platform computes with.
       */
    }));
  }

  /** The currency this company is billed in. */
  private async currencyFor(scope: TenantScope): Promise<string> {
    const subscription = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.tenantSubscription.findUnique({
        where: { tenantId: scope.tenantId },
        select: { currency: true },
      }),
    );

    if (subscription === null) {
      throw new NotFoundException(
        'This company has no subscription, so there is no currency to charge a top-up in.',
      );
    }
    return subscription.currency;
  }
}
