import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  CARRY_FORWARD_POLICIES,
  GRANT_SOURCES,
  NEGATIVE_BALANCE_POLICIES,
  PLAN_CHANGE_POLICIES,
  RESET_POLICIES,
  type CarryForwardPolicy,
  type CreditRequestState,
  type GrantSource,
  type NegativeBalancePolicy,
  type PlanChangePolicy,
  type ResetPolicy,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { tenantScopeForPlatformOperation } from '../persistence/tenant-context.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { PlatformOnly } from '../tenancy/tenancy.decorators.js';
import { CreditService } from './credit.service.js';

export class DecideCreditRequestDto {
  @IsBoolean() approve!: boolean;
  /** The prompt's "Adjust Amount": an approval for a number Finance chooses. */
  @IsOptional() @IsInt() @Min(1) approvedMinor?: number;
  @IsOptional() @IsISO8601() effectiveFrom?: string;
  @IsOptional() @IsISO8601() expiresAt?: string;
  /** The prompt's "invoice/reference". */
  @IsOptional() @IsString() @MaxLength(200) reference?: string;
  @IsString() @MaxLength(1000) note = '';
}

export class GrantCreditsDto {
  @IsUUID() tenantId!: string;
  @IsIn(GRANT_SOURCES as readonly string[]) source!: GrantSource;
  @IsInt() @Min(1) amountMinor!: number;
  @IsOptional() @IsISO8601() effectiveFrom?: string;
  @IsOptional() @IsISO8601() expiresAt?: string;
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
  @IsOptional() @IsString() @MaxLength(200) reference?: string;
}

export class RevokeGrantDto {
  @IsUUID() tenantId!: string;
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

export class SetCreditPolicyDto {
  @IsUUID() tenantId!: string;
  @IsIn(RESET_POLICIES as readonly string[]) resetPolicy!: ResetPolicy;
  @IsIn(CARRY_FORWARD_POLICIES as readonly string[]) carryForwardPolicy!: CarryForwardPolicy;
  @IsOptional() @IsInt() @Min(0) carryForwardCapMinor?: number;
  @IsOptional() @IsInt() @Min(1) defaultTopUpExpiryDays?: number;
  @IsIn(NEGATIVE_BALANCE_POLICIES as readonly string[])
  negativeBalancePolicy!: NegativeBalancePolicy;
  @IsInt() @Min(0) negativeBalanceGraceMinor!: number;
  @IsIn(PLAN_CHANGE_POLICIES as readonly string[]) planChangePolicy!: PlanChangePolicy;
  @IsBoolean() billingChoiceEnabled!: boolean;
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

export class ApplyPlanChangeDto {
  @IsUUID() tenantId!: string;
  @IsInt() @Min(0) newPlanAllowanceMinor!: number;
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

export class TenantScopedDto {
  @IsUUID() tenantId!: string;
}

/**
 * Credits — Finance's half (Prompt 31).
 *
 * ## Why this is a separate, platform-only controller
 *
 * The prompt splits the flow between "Company Admin" and "UBoss Platform Admin / Finance", and
 * the split is the control. A company that could approve its own credit request would be setting
 * its own commercial terms — the review is what makes the request a request.
 *
 * So: the company asks (`/tenants/:tenantId/credits`), Finance decides (here), and the operator's
 * identity, the effective date, the optional expiry, the reason and the invoice reference are all
 * recorded on the decision — the prompt's own list.
 *
 * ## The commercial policy lives here too
 *
 * Monthly reset, carry-forward, top-up expiry, negative balance and plan change are **contract
 * terms**, not company preferences. A company that could set its own carry-forward policy could
 * grant itself credit it had not bought, which is the same hole as self-approval wearing a
 * different hat.
 *
 * ## No payment is taken anywhere
 *
 * No payment provider is integrated or approved. `reference` is where Finance records the invoice
 * they raised in whatever system actually bills, and nothing in this controller claims otherwise.
 */
@Controller('platform/credits')
@PlatformOnly()
export class CreditPlatformController {
  constructor(private readonly credits: CreditService) {}

  /** Every company's open requests, for Finance's queue. */
  @Get('requests')
  @RequirePermission({ module: 'credits', action: 'View' })
  async listRequests(
    @Query('tenantId') tenantId: string,
    @Query('state') state?: string,
  ): Promise<unknown> {
    return this.credits.listRequests({
      scope: tenantScopeForPlatformOperation(tenantId),
      ...(state === undefined ? {} : { state: state as CreditRequestState }),
    });
  }

  /**
   * Approve (for any amount Finance chooses) or reject.
   *
   * The prompt's four actions — review, Approve & Add Credits, Adjust Amount, Reject with reason
   * — are two outcomes here. "Adjust Amount" is an approval whose `approvedMinor` differs from
   * what was asked, and the audit event records that it differed so nobody has to do arithmetic
   * to find out.
   */
  @Post('requests/:requestId/decide')
  @RequirePermission({ module: 'credits', action: 'Administer' })
  async decide(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Query('tenantId') tenantId: string,
    @Body() body: DecideCreditRequestDto,
  ): Promise<unknown> {
    return this.credits.decideRequest({
      scope: tenantScopeForPlatformOperation(tenantId),
      operatorUserId: this.currentUserId(),
      requestId,
      approve: body.approve,
      note: body.note,
      ...(body.approvedMinor === undefined ? {} : { approvedMinor: body.approvedMinor }),
      ...(body.effectiveFrom === undefined ? {} : { effectiveFrom: new Date(body.effectiveFrom) }),
      ...(body.expiresAt === undefined ? {} : { expiresAt: new Date(body.expiresAt) }),
      ...(body.reference === undefined ? {} : { reference: body.reference }),
    });
  }

  /**
   * Add credit with no request behind it — the prompt's "refunds/promotional/manual adjustments".
   *
   * The `source` is what keeps the books honest: promotional credit is recorded as an
   * `Adjustment` rather than a `TopUp`, so a revenue figure built from top-ups does not count
   * money nobody paid.
   */
  @Post('grants')
  @RequirePermission({ module: 'credits', action: 'Administer' })
  async grant(@Body() body: GrantCreditsDto): Promise<unknown> {
    return this.credits.grant({
      scope: tenantScopeForPlatformOperation(body.tenantId),
      actorUserId: this.currentUserId(),
      source: body.source,
      amountMinor: body.amountMinor,
      effectiveFrom: body.effectiveFrom === undefined ? new Date() : new Date(body.effectiveFrom),
      reason: body.reason,
      ...(body.expiresAt === undefined ? {} : { expiresAt: new Date(body.expiresAt) }),
      ...(body.reference === undefined ? {} : { reference: body.reference }),
    });
  }

  /**
   * Withdraw a grant — the prompt's "payment failure after top-up".
   *
   * This can leave a company's balance below what it has already spent, and that is the honest
   * outcome: it spent credit it turned out not to have paid for. The negative-balance policy
   * decides what happens next.
   */
  @Post('grants/:grantId/revoke')
  @RequirePermission({ module: 'credits', action: 'Administer' })
  async revoke(
    @Param('grantId', ParseUUIDPipe) grantId: string,
    @Body() body: RevokeGrantDto,
  ): Promise<unknown> {
    return this.credits.revokeGrant({
      scope: tenantScopeForPlatformOperation(body.tenantId),
      actorUserId: this.currentUserId(),
      grantId,
      reason: body.reason,
    });
  }

  @Get('policy')
  @RequirePermission({ module: 'credits', action: 'View' })
  async policy(@Query('tenantId') tenantId: string): Promise<unknown> {
    return this.credits.policy(tenantScopeForPlatformOperation(tenantId));
  }

  /** Set the commercial terms. Contract, not preference — see the class note. */
  @Post('policy')
  @RequirePermission({ module: 'credits', action: 'Administer' })
  async setPolicy(@Body() body: SetCreditPolicyDto): Promise<unknown> {
    return this.credits.setPolicy({
      scope: tenantScopeForPlatformOperation(body.tenantId),
      actorUserId: this.currentUserId(),
      reason: body.reason,
      policy: {
        resetPolicy: body.resetPolicy,
        carryForwardPolicy: body.carryForwardPolicy,
        carryForwardCapMinor: body.carryForwardCapMinor ?? null,
        defaultTopUpExpiryDays: body.defaultTopUpExpiryDays ?? null,
        negativeBalancePolicy: body.negativeBalancePolicy,
        negativeBalanceGraceMinor: body.negativeBalanceGraceMinor,
        planChangePolicy: body.planChangePolicy,
        billingChoiceEnabled: body.billingChoiceEnabled,
      },
    });
  }

  /** The monthly reset and carry-forward, on demand. */
  @Post('period-reset')
  @RequirePermission({ module: 'credits', action: 'Administer' })
  async periodReset(@Body() body: TenantScopedDto): Promise<unknown> {
    return this.credits.applyPeriodReset({
      scope: tenantScopeForPlatformOperation(body.tenantId),
      actorUserId: this.currentUserId(),
    });
  }

  /** Write off grants that have reached their expiry. */
  @Post('expire-grants')
  @RequirePermission({ module: 'credits', action: 'Administer' })
  async expireGrants(@Body() body: TenantScopedDto): Promise<unknown> {
    return this.credits.expireGrants({
      scope: tenantScopeForPlatformOperation(body.tenantId),
      actorUserId: this.currentUserId(),
    });
  }

  /** Apply a plan change mid-cycle, under the company's configured policy. */
  @Post('plan-change')
  @RequirePermission({ module: 'credits', action: 'Administer' })
  async planChange(@Body() body: ApplyPlanChangeDto): Promise<unknown> {
    return this.credits.applyPlanChange({
      scope: tenantScopeForPlatformOperation(body.tenantId),
      actorUserId: this.currentUserId(),
      newPlanAllowanceMinor: body.newPlanAllowanceMinor,
      reason: body.reason,
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
