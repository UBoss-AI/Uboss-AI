import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
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
  RESET_CADENCES,
  type BudgetScope,
  type ResetCadence,
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
  /**
   * How often it comes back. Absent means a one-off, which is what every allowance was before.
   *
   * "Give this person ₹500 a day" is one sentence and is one call: the amount set here is also
   * the amount each period grants.
   */
  @IsOptional()
  @IsIn(RESET_CADENCES as readonly string[])
  resetCadence?: ResetCadence;
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

  /**
   * Who spent it — §20's usage drill-down.
   *
   * The ledger has carried the department, the objective, the agent and the person on every
   * charge since it was written, and nothing grouped by any of them. One company total and a
   * list of individual entries does not answer "which department is spending this", which is
   * the first thing anybody asks about an AI bill.
   *
   * `View` on settings, like the wallets and the ledger beside it: this reports what the
   * company spent, and reading it changes nothing.
   */
  @Get('usage')
  @RequirePermission({ module: 'settings', action: 'View' })
  async usage(
    @Query('by') by?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<unknown> {
    const dimensions = ['department', 'objective', 'agent', 'user'] as const;
    if (by === undefined || !(dimensions as readonly string[]).includes(by)) {
      throw new BadRequestException(
        `by must be one of: ${dimensions.join(', ')} — what the spend should be grouped under.`,
      );
    }

    // A window that cannot be read is a window nobody meant. Refused rather than silently
    // widened to everything, which would quietly report a year where a month was asked for.
    const parse = (value: string | undefined, name: string): Date | undefined => {
      if (value === undefined) return undefined;
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException(`${name} is not a date.`);
      }
      return parsed;
    };

    const breakdown = await this.cost.usageBreakdown({
      scope: this.tenantContext.requireScope(),
      by: by as 'department' | 'objective' | 'agent' | 'user',
      from: parse(from, 'from'),
      to: parse(to, 'to'),
    });

    /*
     * Tokens leave this route; money does not.
     *
     * This is a tenant-scoped endpoint, so every reader of it is a company, and a company is
     * quoted a plan price in money and counts everything it consumes in tokens. The pair on one
     * screen is the shape that matters: divide the charge by the tokens and a reader has a
     * per-million rate to match against a published price list, which names the provider and
     * exposes the margin.
     *
     * Stripped here rather than left out of the engine, because the engine's sums serve the
     * platform plane too, and one query that both readers share cannot disagree with itself
     * about the same ledger. `currency` goes with it: a currency beside a token count is a label
     * for a number that is not money.
     */
    return {
      by: breakdown.by,
      rows: breakdown.rows.map((row) => ({
        key: row.key,
        tokens: row.tokens,
        calls: row.calls,
        uncostedCalls: row.uncostedCalls,
      })),
      totals: {
        tokens: breakdown.totals.tokens,
        calls: breakdown.totals.calls,
        uncostedCalls: breakdown.totals.uncostedCalls,
      },
    };
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
      ...(body.resetCadence === undefined ? {} : { resetCadence: body.resetCadence }),
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
