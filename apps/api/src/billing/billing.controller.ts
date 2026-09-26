import { Body, Controller, Get, Post, UnauthorizedException } from '@nestjs/common';
import { IsIn } from 'class-validator';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import type { BillingCycle } from '../generated/prisma/enums.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { BillingService } from './billing.service.js';

const CYCLES = ['Monthly', 'Annual'] as const;

export class StartCheckoutDto {
  /**
   * Monthly or annual. Quarterly exists in this product's own vocabulary but is deliberately not
   * offered here: a provider price carries its own interval, and there is no quarterly price to
   * charge against. Offering it would produce a button that fails at the provider.
   */
  @IsIn(CYCLES as readonly string[]) cycle!: (typeof CYCLES)[number];
}

/**
 * A company paying for itself.
 *
 * ## Why `settings:Administer` and not something narrower
 *
 * Buying is administering the company's own settings, which is the permission the rest of the
 * commercial screens already use — a manager can see the position, an administrator can change
 * it. Inventing a `billing` company module for this would add a module to the approved company
 * module list to describe one button.
 *
 * ## Reading is separate from paying
 *
 * The invoice history needs `View`, because everybody who can see the company's commercial
 * position should be able to see what it has been charged. Starting a payment needs
 * `Administer`. They are different questions and a company should be able to answer the first
 * without granting the second.
 */
@Controller('tenants/:tenantId/billing')
@TenantScoped()
export class CompanyBillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Whether this deployment can take a payment at all.
   *
   * Said to the company rather than hidden, because the alternative is a Pay button that fails —
   * and a payment that fails for a reason the customer cannot see is the worst version of this
   * screen.
   */
  @Get('connection')
  @RequirePermission({ module: 'settings', action: 'View' })
  connection(): unknown {
    const connection = this.billing.connection();
    // The company is told whether payment is possible and nothing about why not: `missing` names
    // this deployment's environment variables, which is an operator's business.
    return { connected: connection.connected, mode: connection.mode };
  }

  @Get('invoices')
  @RequirePermission({ module: 'settings', action: 'View' })
  async invoices(): Promise<unknown> {
    const invoices = await this.billing.invoicesFor(this.tenantContext.requireScope());
    return { invoices };
  }

  @Post('checkout')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async checkout(@Body() body: StartCheckoutDto): Promise<unknown> {
    return this.billing.startCheckout({
      scope: this.tenantContext.requireScope(),
      userId: this.currentUserId(),
      cycle: body.cycle as BillingCycle,
    });
  }

  @Post('portal')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async portal(): Promise<unknown> {
    return this.billing.portalUrl({
      scope: this.tenantContext.requireScope(),
      userId: this.currentUserId(),
    });
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified user.');
    }
    return userId;
  }
}
