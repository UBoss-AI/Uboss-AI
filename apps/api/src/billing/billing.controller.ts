import {
  Body,
  Controller,
  Get,
  ParseIntPipe,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { IsIn, IsInt, IsNotEmpty, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAXIMUM_TOP_UP_TOKENS, MINIMUM_TOP_UP_TOKENS } from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { TokenPurchaseService } from './token-purchase.service.js';
import type { BillingCycle } from '../generated/prisma/enums.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { AllowedWhenReadOnly, TenantScoped } from '../tenancy/tenancy.decorators.js';
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

export class UpgradePlanDto {
  /**
   * Which published plan to buy, by code.
   *
   * A code, looked up in `plans` — not a description. The caller chooses *which* plan, which is
   * the point of a self-serve upgrade; the price, the seats and the allowance all come from the
   * row it names, so there is nothing here to inflate.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  planCode!: string;

  @IsIn(CYCLES as readonly string[]) cycle!: (typeof CYCLES)[number];
}

export class BuyTokensDto {
  /**
   * How many UBoss Tokens to buy.
   *
   * Bounded here **and** in the service. The decorators give the caller a clear 400 before any
   * work starts; the service checks again because it is also reachable from a test and because a
   * limit enforced only at the edge is a limit that moves the day somebody adds a second caller.
   */
  @IsInt()
  @Min(MINIMUM_TOP_UP_TOKENS)
  @Max(MAXIMUM_TOP_UP_TOKENS)
  tokens!: number;
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
    private readonly topUps: TokenPurchaseService,
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
  @RequirePermission({ module: 'settings', action: 'Administer' })
  connection(): unknown {
    const connection = this.billing.connection();
    // The company is told whether payment is possible and nothing about why not: `missing` names
    // this deployment's environment variables, which is an operator's business.
    return { connected: connection.connected, mode: connection.mode };
  }

  @Get('invoices')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async invoices(): Promise<unknown> {
    const invoices = await this.billing.invoicesFor(this.tenantContext.requireScope());
    return { invoices };
  }

  /**
   * `@AllowedWhenReadOnly` because this is the way out.
   *
   * A company that stopped paying is in read-only, which refuses every write — and this is a
   * POST. Without the waiver the product would show them a Pay button they are forbidden to
   * press. It waives nothing else: `settings:Administer` below still applies, and a suspended or
   * closed company cannot reach this route at all.
   */
  @Post('checkout')
  @AllowedWhenReadOnly()
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async checkout(@Body() body: StartCheckoutDto): Promise<unknown> {
    return this.billing.startCheckout({
      scope: this.tenantContext.requireScope(),
      userId: this.currentUserId(),
      cycle: body.cycle as BillingCycle,
    });
  }

  /** Also the way out: changing a failed card happens in the provider's portal. */
  @Post('portal')
  @AllowedWhenReadOnly()
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async portal(): Promise<unknown> {
    return this.billing.portalUrl({
      scope: this.tenantContext.requireScope(),
      userId: this.currentUserId(),
    });
  }

  /**
   * The plans this company could move to, priced in its own currency.
   *
   * `View`: seeing what a bigger plan costs is not buying one, and a manager who can read the
   * commercial position should be able to answer "what would Growth cost us" without being able
   * to commit the company to it.
   */
  @Get('plans')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async upgradeOptions(): Promise<unknown> {
    return this.billing.upgradeOptionsFor(this.tenantContext.requireScope());
  }

  /**
   * Buy a different plan — the self-serve upgrade.
   *
   * `@AllowedWhenReadOnly` for the same reason as paying the existing bill: a company whose
   * subscription lapsed and who wants to come back on a bigger plan is still a company paying,
   * and the one screen they can reach must not refuse them.
   */
  @Post('upgrade')
  @AllowedWhenReadOnly()
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async upgrade(@Body() body: UpgradePlanDto): Promise<unknown> {
    return this.billing.startPlanUpgrade({
      scope: this.tenantContext.requireScope(),
      userId: this.currentUserId(),
      planCode: body.planCode,
      cycle: body.cycle as BillingCycle,
    });
  }

  /**
   * What a given number of tokens would cost, before anybody is sent to pay.
   *
   * `View`, because seeing a price is not buying. A manager who can read the company's commercial
   * position should be able to find out what a top-up would cost without being able to make one.
   */
  @Get('tokens/quote')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async quoteTokens(@Query('tokens', new ParseIntPipe()) tokens: number): Promise<unknown> {
    return this.topUps.quote(this.tenantContext.requireScope(), tokens);
  }

  /** This company's top-ups, newest first. */
  @Get('tokens')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async tokenPurchases(): Promise<unknown> {
    return { purchases: await this.topUps.listFor(this.tenantContext.requireScope()) };
  }

  /**
   * Buy more tokens.
   *
   * Deliberately **not** `@AllowedWhenReadOnly`. A company in read-only has an unpaid
   * subscription, and its agents are already stopped — the scheduler only ticks Active companies.
   * Selling it tokens it cannot spend, while it owes for the plan, would be taking money for
   * nothing. The way out of read-only is to settle the subscription, and that is the only payment
   * route the guard holds open.
   */
  @Post('tokens')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async buyTokens(@Body() body: BuyTokensDto): Promise<unknown> {
    return this.topUps.start({
      scope: this.tenantContext.requireScope(),
      userId: this.currentUserId(),
      tokens: body.tokens,
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
