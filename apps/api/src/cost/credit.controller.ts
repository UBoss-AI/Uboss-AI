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
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  BILLING_CHOICE_LABELS,
  BILLING_CHOICES,
  BUDGET_SCOPES,
  CARRY_FORWARD_POLICIES,
  CARRY_FORWARD_POLICY_LABELS,
  CREDIT_REQUEST_STATE_LABELS,
  CREDIT_REQUEST_STATE_TONES,
  CREDIT_REQUEST_STATES,
  DEFAULT_CREDIT_POLICY,
  GRANT_SOURCE_LABELS,
  GRANT_SOURCES,
  NEGATIVE_BALANCE_POLICIES,
  NEGATIVE_BALANCE_POLICY_LABELS,
  PLAN_CHANGE_POLICIES,
  PLAN_CHANGE_POLICY_LABELS,
  RESET_POLICIES,
  RESET_POLICY_LABELS,
  type BillingChoice,
  type BudgetScope,
  type CarryForwardPolicy,
  type CreditRequestState,
  type NegativeBalancePolicy,
  type PlanChangePolicy,
  type ResetPolicy,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { CreditService } from './credit.service.js';

export class RequestCreditsDto {
  @IsInt() @Min(1) amountMinor!: number;
  /** Required: Finance records this as the reason the credits were added. */
  @IsString() @MinLength(1) @MaxLength(1000) reason!: string;
  @IsOptional() @IsIn(BILLING_CHOICES as readonly string[]) billingChoice?: BillingChoice;
}

export class CancelRequestDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

export class ReallocateDto {
  @IsIn(BUDGET_SCOPES as readonly string[]) fromScope!: BudgetScope;
  @IsOptional() @IsUUID() fromSubjectId?: string;
  @IsIn(BUDGET_SCOPES as readonly string[]) toScope!: BudgetScope;
  @IsOptional() @IsUUID() toSubjectId?: string;
  @IsInt() @Min(1) amountMinor!: number;
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

export class CreditPolicyDto {
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

/**
 * Credits — the company's half (Prompt 31).
 *
 * ## Who may do what, and why
 *
 * `settings:Administer` for every write here. The prompt is explicit that **"Employees cannot
 * increase company credits"**, and `Administer` on settings is a Company Admin grant in the role
 * templates — a Manager or Head holds `settings:View` at most.
 *
 * Reading the company's own requests and grants is `settings:View`, because a manager watching a
 * department's budget needs to know whether a top-up is on its way.
 *
 * ## What is not here
 *
 * **Approving a credit request.** That is Finance's, on the platform plane
 * (`CreditPlatformController`) — a company approving its own credit request would be the company
 * setting its own commercial terms. The separation is the whole point of the flow.
 *
 * **Anything that takes a payment.** No payment provider is integrated or approved. A request
 * records an amount, a reason and a billing *intent*; Finance records the invoice reference when
 * they add the credits.
 */
@TenantScoped()
@Controller('tenants/:tenantId/credits')
export class CreditController {
  constructor(
    private readonly credits: CreditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The vocabulary a credits screen renders against. */
  @Get('meta')
  @RequirePermission({ module: 'settings', action: 'View' })
  meta(): unknown {
    return {
      requestStates: CREDIT_REQUEST_STATES.map((state) => ({
        state,
        label: CREDIT_REQUEST_STATE_LABELS[state],
        tone: CREDIT_REQUEST_STATE_TONES[state],
      })),
      billingChoices: BILLING_CHOICES.map((choice) => ({
        choice,
        label: BILLING_CHOICE_LABELS[choice],
      })),
      grantSources: GRANT_SOURCES.map((source) => ({
        source,
        label: GRANT_SOURCE_LABELS[source],
      })),
      policies: {
        reset: RESET_POLICIES.map((value) => ({ value, label: RESET_POLICY_LABELS[value] })),
        carryForward: CARRY_FORWARD_POLICIES.map((value) => ({
          value,
          label: CARRY_FORWARD_POLICY_LABELS[value],
        })),
        negativeBalance: NEGATIVE_BALANCE_POLICIES.map((value) => ({
          value,
          label: NEGATIVE_BALANCE_POLICY_LABELS[value],
        })),
        planChange: PLAN_CHANGE_POLICIES.map((value) => ({
          value,
          label: PLAN_CHANGE_POLICY_LABELS[value],
        })),
      },
      defaults: DEFAULT_CREDIT_POLICY,
      note:
        'Requesting credits does not take a payment. Finance reviews the request and records ' +
        'the invoice reference when the credits are added.',
    };
  }

  @Get('policy')
  @RequirePermission({ module: 'settings', action: 'View' })
  async policy(): Promise<unknown> {
    return this.credits.policy(this.tenantContext.requireScope());
  }

  @Get('requests')
  @RequirePermission({ module: 'settings', action: 'View' })
  async listRequests(@Query('state') state?: string): Promise<unknown> {
    return this.credits.listRequests({
      scope: this.tenantContext.requireScope(),
      ...(state === undefined ? {} : { state: state as CreditRequestState }),
    });
  }

  @Get('grants')
  @RequirePermission({ module: 'settings', action: 'View' })
  async listGrants(): Promise<unknown> {
    return this.credits.listGrants(this.tenantContext.requireScope());
  }

  /** The prompt's "Request / Buy More Credits". */
  @Post('requests')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async requestCredits(@Body() body: RequestCreditsDto): Promise<unknown> {
    return this.credits.requestCredits({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      amountMinor: body.amountMinor,
      reason: body.reason,
      ...(body.billingChoice === undefined ? {} : { billingChoice: body.billingChoice }),
    });
  }

  @Post('requests/:requestId/cancel')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async cancelRequest(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() body: CancelRequestDto,
  ): Promise<unknown> {
    return this.credits.cancelRequest({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      requestId,
      reason: body.reason,
    });
  }

  /**
   * The prompt's "Reallocate existing company budget without increasing total allowance".
   *
   * A company action rather than a platform one, because it buys nothing — it moves what the
   * company already has between its own departments and objectives.
   */
  @Post('reallocate')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async reallocate(@Body() body: ReallocateDto): Promise<unknown> {
    return this.credits.reallocate({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      from: { budgetScope: body.fromScope, subjectId: body.fromSubjectId ?? null },
      to: { budgetScope: body.toScope, subjectId: body.toSubjectId ?? null },
      amountMinor: body.amountMinor,
      reason: body.reason,
    });
  }

  /** Whether a negative balance is currently stopping new work, under this company's policy. */
  @Get('negative-balance')
  @RequirePermission({ module: 'settings', action: 'View' })
  async negativeBalance(): Promise<unknown> {
    return this.credits.negativeBalanceStatus(this.tenantContext.requireScope());
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified user.');
    }
    return userId;
  }
}
