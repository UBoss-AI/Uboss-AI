import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UnauthorizedException,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { COMPANY_MODULES } from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { PlatformOnly, TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { CommercialService } from './commercial.service.js';
import { CompanyLifecycleService } from './company-lifecycle.service.js';
import { SeatService } from './seat.service.js';

const CHANGE_KINDS = [
  'MoreSeats',
  'FewerSeats',
  'PlanUpgrade',
  'PlanDowngrade',
  'MoreAiAllowance',
  'ModuleEntitlement',
] as const;

const LIFECYCLE_STATES = [
  'Provisioning',
  'PendingActivation',
  'Active',
  'Suspended',
  'ReadOnly',
  'Closed',
] as const;

export class RequestCommercialChangeDto {
  @IsIn(CHANGE_KINDS, { message: `kind must be one of: ${CHANGE_KINDS.join(', ')}.` })
  kind!: (typeof CHANGE_KINDS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  requestedSeats?: number;

  @IsOptional()
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
  @MaxLength(40)
  requestedPlanCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  requestedAllowanceMinor?: number;

  @IsOptional()
  @ArrayMaxSize(COMPANY_MODULES.length)
  @IsIn(COMPANY_MODULES, { each: true })
  requestedModules?: string[];

  /** Mandatory. The platform cannot evaluate a request with no stated business need. */
  @IsString()
  @MinLength(10, { message: 'justification must explain the business need.' })
  @MaxLength(1000)
  justification!: string;
}

export class DecideCommercialChangeDto {
  @IsIn(['approve', 'decline'], { message: 'decision must be approve or decline.' })
  decision!: 'approve' | 'decline';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  /** Apply on approval. Otherwise the platform applies it separately. */
  @IsOptional()
  @IsIn(['now', 'later'])
  apply?: 'now' | 'later';

  /** For a downgrade: when the lower ceiling takes effect. */
  @IsOptional()
  @IsISO8601()
  effectiveAt?: string;
}

export class SetSeatsDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  seats!: number;

  @IsString()
  @MinLength(5, { message: 'reason must say why the contracted ceiling is changing.' })
  @MaxLength(500)
  reason!: string;
}

export class TransitionLifecycleDto {
  @IsIn(LIFECYCLE_STATES, { message: `toState must be one of: ${LIFECYCLE_STATES.join(', ')}.` })
  toState!: (typeof LIFECYCLE_STATES)[number];

  /** Mandatory. A suspension nobody can explain is the one a customer disputes. */
  @IsString()
  @MinLength(10, { message: 'reason must explain why the company is changing state.' })
  @MaxLength(1000)
  reason!: string;

  /** Omit to apply now. A future date records the intent without applying it. */
  @IsOptional()
  @IsISO8601()
  effectiveAt?: string;
}

/**
 * The company's own view of its commercial position, and its requests.
 *
 * ## Read-and-request, never set
 *
 * The client's rule: *Company Admin may view permitted plan/seat position and may request allowed
 * commercial changes; Platform Admin controls contracted ceiling/entitlements.* So there is no
 * endpoint here that changes a contracted number. A company that could set its own ceiling would
 * make the ceiling a preference rather than a contract.
 *
 * Viewing needs only `settings:View`, which every company role holds — a manager who cannot see
 * how many seats remain will invite somebody into a refusal. Requesting needs
 * `settings:Administer`, because it commits the company to a conversation about money.
 */
@Controller('tenants/:tenantId/commercial')
@TenantScoped()
export class CompanyCommercialController {
  constructor(
    private readonly commercial: CommercialService,
    private readonly seats: SeatService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Plan, entitlements, release channel, allowance and seats — with RBAC deliberately absent.
   *
   * The response carries an `rbacNote` saying so, because a reader who expects permissions here
   * should learn *why* they are not rather than assume an oversight.
   */
  @Get('position')
  @RequirePermission({ module: 'settings', action: 'View' })
  async position(): Promise<unknown> {
    return this.commercial.positionForCompany(
      this.tenantContext.requireScope(),
      this.currentUserId(),
    );
  }

  /** Just the seat numbers, for a screen deciding whether to offer an Invite button. */
  @Get('seats')
  @RequirePermission({ module: 'settings', action: 'View' })
  async seatPosition(): Promise<unknown> {
    return this.seats.positionFor(this.tenantContext.requireScope());
  }

  @Get('requests')
  @RequirePermission({ module: 'settings', action: 'View' })
  async requests(): Promise<unknown> {
    const requests = await this.commercial.requestsForCompany(
      this.tenantContext.requireScope(),
      this.currentUserId(),
    );
    return { requests };
  }

  @Post('requests')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async requestChange(@Body() body: RequestCommercialChangeDto): Promise<unknown> {
    const request = await this.commercial.requestChange({
      scope: this.tenantContext.requireScope(),
      userId: this.currentUserId(),
      kind: body.kind,
      requestedSeats: body.requestedSeats,
      requestedPlanCode: body.requestedPlanCode,
      requestedAllowanceMinor: body.requestedAllowanceMinor,
      requestedModules: body.requestedModules,
      justification: body.justification,
    });
    return { id: request.id, kind: request.kind, state: request.state };
  }

  @Post('requests/:requestId/withdraw')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async withdraw(@Param('requestId', new ParseUUIDPipe()) requestId: string): Promise<unknown> {
    const request = await this.commercial.withdrawChange({
      scope: this.tenantContext.requireScope(),
      userId: this.currentUserId(),
      requestId,
    });
    return { id: request.id, state: request.state };
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified user.');
    }
    return userId;
  }
}

/**
 * The platform side: decide requests, set contracted terms, move lifecycle states.
 *
 * Every route here changes something the customer cannot change for themselves, which is the
 * point of the split.
 */
@Controller('platform/commercial')
@PlatformOnly()
export class PlatformCommercialController {
  constructor(
    private readonly commercial: CommercialService,
    private readonly seats: SeatService,
    private readonly lifecycle: CompanyLifecycleService,
  ) {}

  /** The queue of requests awaiting a decision. */
  @Get('requests')
  @RequirePermission({ module: 'companies', action: 'View' })
  async pending(): Promise<unknown> {
    return { requests: await this.commercial.pendingRequestsForPlatform() };
  }

  /**
   * Approve or decline, and optionally apply.
   *
   * `companies:Administer` — Owner and Admin. A Commercial role defines plans but does not decide
   * which company is on one, because that is a customer-facing commitment.
   *
   * The decider may not be the requester: enforced here and by a check constraint.
   */
  @Post('requests/:requestId/decide')
  @RequirePermission({ module: 'companies', action: 'Administer' })
  async decide(
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body() body: DecideCommercialChangeDto,
  ): Promise<unknown> {
    const request = await this.commercial.decideChange({
      requestId,
      actorUserId: this.currentUserId(),
      approve: body.decision === 'approve',
      note: body.note,
      applyNow: body.apply === 'now',
      effectiveAt: body.effectiveAt === undefined ? undefined : new Date(body.effectiveAt),
    });
    return { id: request.id, state: request.state, appliedAt: request.appliedAt };
  }

  /**
   * One company's seat position, as the platform sees it.
   *
   * The same numbers the enforcement uses, including the counting rule and any live grace
   * window — so an operator deciding a seat request and the refusal a company hits cannot
   * disagree about how many seats are in use.
   */
  @Get('companies/:tenantId/seats')
  @RequirePermission({ module: 'companies', action: 'View' })
  async seatPosition(@Param('tenantId', new ParseUUIDPipe()) tenantId: string): Promise<unknown> {
    return this.seats.positionForPlatform(tenantId);
  }

  /** What a proposed reduction would mean, before agreeing to it. */
  @Get('companies/:tenantId/seat-reduction/:seats')
  @RequirePermission({ module: 'companies', action: 'View' })
  async assessReduction(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('seats') seats: string,
  ): Promise<unknown> {
    return this.seats.assessReduction({ tenantId, newCeiling: Number(seats) });
  }

  /**
   * Set a company's contracted ceiling directly.
   *
   * The escape hatch for a change agreed on a call rather than through a request — most real
   * contract changes are. It still needs a reason and still applies grace on a reduction, so the
   * non-destructive rule holds regardless of route.
   */
  @Put('companies/:tenantId/seats')
  @RequirePermission({ module: 'companies', action: 'Administer' })
  async setSeats(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() body: SetSeatsDto,
  ): Promise<unknown> {
    return this.commercial.setContractedSeats({
      tenantId,
      seats: body.seats,
      reason: body.reason,
      actorUserId: this.currentUserId(),
    });
  }

  /** A company's lifecycle position, what that state permits, and its history. */
  @Get('companies/:tenantId/lifecycle')
  @RequirePermission({ module: 'companies', action: 'View' })
  async lifecycleView(@Param('tenantId', new ParseUUIDPipe()) tenantId: string): Promise<unknown> {
    return this.lifecycle.viewFor(tenantId);
  }

  /**
   * Move a company to a new lifecycle state, now or on a date.
   *
   * Illegal transitions are refused with the list of legal ones. `Closed` is terminal through
   * this route — see `ALLOWED_LIFECYCLE_TRANSITIONS`.
   */
  @Post('companies/:tenantId/lifecycle')
  @RequirePermission({ module: 'companies', action: 'Administer' })
  async transition(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() body: TransitionLifecycleDto,
  ): Promise<unknown> {
    return this.lifecycle.transition({
      tenantId,
      toState: body.toState,
      reason: body.reason,
      actorUserId: this.currentUserId(),
      effectiveAt: body.effectiveAt === undefined ? undefined : new Date(body.effectiveAt),
    });
  }

  /**
   * Apply scheduled lifecycle transitions and plan changes whose date has arrived.
   *
   * Exposed as an endpoint so the state can be advanced before a scheduler exists. Deliberately
   * **not** enforcement: a scheduled suspension that has not been applied still shows the old
   * state, which is correct — the company has not been suspended yet.
   */
  @Post('apply-due')
  @RequirePermission({ module: 'companies', action: 'Administer' })
  async applyDue(): Promise<unknown> {
    const [lifecycle, plans] = await Promise.all([
      this.lifecycle.applyDueTransitions(),
      this.commercial.applyDuePlanChanges(),
    ]);
    return { lifecycleTransitionsApplied: lifecycle, planChangesApplied: plans };
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified platform actor.');
    }
    return userId;
  }
}
