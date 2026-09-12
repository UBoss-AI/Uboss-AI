import { Body, Controller, Get, Post, Query, UnauthorizedException } from '@nestjs/common';
import {
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
  BUDGET_SCOPE_LABELS,
  BUDGET_SCOPES,
  COST_THRESHOLD_LABELS,
  COST_THRESHOLD_TONES,
  COST_THRESHOLDS,
  DEFAULT_COST_THRESHOLD_PERCENTS,
  LEDGER_ENTRY_KIND_LABELS,
  LEDGER_ENTRY_KINDS,
  RESERVATION_STATE_LABELS,
  RESERVATION_STATES,
  type BudgetScope,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { CostEngineService } from './cost-engine.service.js';

export class SetAllowanceDto {
  @IsIn(BUDGET_SCOPES as readonly string[]) budgetScope!: BudgetScope;
  @IsOptional() @IsUUID() subjectId?: string;
  @IsInt() @Min(0) allowanceMinor!: number;
  /** Required: a budget change nobody explained cannot be reviewed. */
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

/**
 * Tokens & Cost — Prompt 30.
 *
 * ## Where this lives in the product
 *
 * The approved UI puts these widgets in **Settings › Tokens & Cost** and says so in the reference
 * itself: "These budget widgets belong here in Settings — never duplicated on the Dashboard."
 * The Company Dashboard stays the two-slice donut. So the routes are read by a settings screen,
 * and nothing here is surfaced on the dashboard.
 *
 * ## Permissions
 *
 * `settings:View` to read the numbers — a manager needs to see whether their department is close
 * to its limit. `settings:Administer` to change an allowance, which only a Company Admin holds.
 *
 * Deliberately **no route that spends, reserves or settles.** Those happen inside the Model
 * Gateway as part of a real call. An endpoint that could move a balance by hand would be a way to
 * charge a company for work that never happened, and it would sit outside the reserve/settle
 * pairing that makes the ledger reconcilable.
 *
 * Top-up and reallocation as *requests* are Prompt 31; `setAllowance` here is the platform-side
 * act of setting a number, which is what Prompt 31's approval flow will end up calling.
 */
@TenantScoped()
@Controller('tenants/:tenantId/cost')
export class CostController {
  constructor(
    private readonly cost: CostEngineService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The vocabulary a Tokens & Cost screen renders against. */
  @Get('meta')
  @RequirePermission({ module: 'settings', action: 'View' })
  meta(): unknown {
    return {
      scopes: BUDGET_SCOPES.map((scope) => ({ scope, label: BUDGET_SCOPE_LABELS[scope] })),
      thresholds: COST_THRESHOLDS.map((threshold) => ({
        threshold,
        label: COST_THRESHOLD_LABELS[threshold],
        tone: COST_THRESHOLD_TONES[threshold],
        defaultPercent: DEFAULT_COST_THRESHOLD_PERCENTS[threshold],
      })),
      ledgerKinds: LEDGER_ENTRY_KINDS.map((kind) => ({
        kind,
        label: LEDGER_ENTRY_KIND_LABELS[kind],
      })),
      reservationStates: RESERVATION_STATES.map((state) => ({
        state,
        label: RESERVATION_STATE_LABELS[state],
      })),
      note:
        'Thresholds are configurable per company, not hard-coded. Reserved amounts count ' +
        'against remaining: two agents cannot both spend the same last of a budget.',
    };
  }

  /**
   * Every budget with its numbers — §20's allowance display and its drill-down.
   *
   * One call returns the whole hierarchy rather than one level at a time, because the screen
   * shows company and departments together and a per-level endpoint would make the common view
   * N+1 requests.
   */
  @Get('wallets')
  @RequirePermission({ module: 'settings', action: 'View' })
  async wallets(): Promise<unknown> {
    return this.cost.wallets(this.tenantContext.requireScope());
  }

  /** §20's credit history. */
  @Get('ledger')
  @RequirePermission({ module: 'settings', action: 'View' })
  async ledger(
    @Query('walletId') walletId?: string,
    @Query('agentRunId') agentRunId?: string,
  ): Promise<unknown> {
    return this.cost.ledger({
      scope: this.tenantContext.requireScope(),
      ...(walletId === undefined ? {} : { walletId }),
      ...(agentRunId === undefined ? {} : { agentRunId }),
    });
  }

  @Post('allowance')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async setAllowance(@Body() body: SetAllowanceDto): Promise<unknown> {
    return this.cost.setAllowance({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      budgetScope: body.budgetScope,
      subjectId: body.subjectId ?? null,
      allowanceMinor: body.allowanceMinor,
      reason: body.reason,
    });
  }

  /**
   * §20's reconciliation job, on demand.
   *
   * `View` rather than `Administer`: it changes nothing. It reads every wallet, replays its
   * ledger, and reports where the two disagree — and somebody investigating a suspicious balance
   * should not need permission to change budgets in order to look.
   */
  @Post('reconcile')
  @RequirePermission({ module: 'settings', action: 'View' })
  async reconcile(): Promise<unknown> {
    return this.cost.reconcile(this.tenantContext.requireScope());
  }

  /**
   * Release reservations nobody closed.
   *
   * `Administer`, because it moves balances — even though it only gives budget back. A sweep that
   * released a reservation belonging to a run still in flight would let that run's eventual
   * settle overspend, so it is not a read.
   */
  @Post('sweep-reservations')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async sweep(): Promise<unknown> {
    return this.cost.sweepExpiredReservations({ scope: this.tenantContext.requireScope() });
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified user.');
    }
    return userId;
  }
}
