import { Controller, Get, Param, ParseUUIDPipe, Post, UnauthorizedException } from '@nestjs/common';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { PlatformOnly } from '../tenancy/tenancy.decorators.js';
import { BillingService } from './billing.service.js';

/**
 * Billing & Payments, in the platform console.
 *
 * ## What this screen is for
 *
 * Three questions, and it exists to answer them without anybody opening the provider's dashboard:
 * is a provider connected and in which mode; which plans can actually be bought; and what has
 * each company paid. The fourth — is the integration still working — is answered by the
 * deliveries list, because a webhook that has quietly stopped is the failure this integration is
 * most exposed to and it is invisible from anywhere else.
 *
 * ## What it deliberately does not do
 *
 * It does not charge a company, refund one, or edit an invoice. Those are the provider's own
 * screens, they are correct there, and rebuilding them here would mean this product holding a
 * second opinion about money.
 */
@Controller('platform/billing')
@PlatformOnly()
export class PlatformBillingController {
  constructor(private readonly billing: BillingService) {}

  /** Whether a provider is connected, in which mode, and what is missing if not. */
  @Get('connection')
  @RequirePermission({ module: 'billing', action: 'View' })
  connection(): unknown {
    return this.billing.connection();
  }

  /** Every plan, and whether it can be bought yet. */
  @Get('plans')
  @RequirePermission({ module: 'billing', action: 'View' })
  async plans(): Promise<unknown> {
    return this.billing.platformPlans();
  }

  /** Every company's payment position. */
  @Get('companies')
  @RequirePermission({ module: 'billing', action: 'View' })
  async companies(): Promise<unknown> {
    return this.billing.platformOverview();
  }

  /** What the provider has sent us lately, and what was done with each. */
  @Get('deliveries')
  @RequirePermission({ module: 'billing', action: 'View' })
  async deliveries(): Promise<unknown> {
    return this.billing.platformDeliveries();
  }

  /**
   * Publish a plan to the provider so companies can buy it.
   *
   * `Administer`, because this is what decides that a price can be charged — and because a
   * re-publish creates a new price at the provider that every subsequent sale uses.
   */
  @Post('plans/:planId/publish')
  @RequirePermission({ module: 'billing', action: 'Administer' })
  async publish(@Param('planId', new ParseUUIDPipe()) planId: string): Promise<unknown> {
    return this.billing.publishPlan({ planId, actorUserId: this.currentUserId() });
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified platform actor.');
    }
    return userId;
  }
}
