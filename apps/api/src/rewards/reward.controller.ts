import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

import {
  ALLOWED_AWARD_TRANSITIONS,
  REWARD_AWARD_STATUS_LABELS,
  REWARD_AWARD_STATUS_TONES,
  REWARD_AWARD_STATUSES,
  SETTLEMENT_ROUTE_LABELS,
  SETTLEMENT_ROUTES,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { PayoutAdapter } from './payout-adapter.js';
import { RewardService } from './reward.service.js';

export class AssignAwardDto {
  @IsUUID() subjectUserId!: string;
}

export class DecideAwardDto {
  /** Optional on approval, required on rejection — the service and a CHECK both insist. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(2000) reason?: string;
}

export class RejectAwardDto {
  @IsString() @MinLength(1) @MaxLength(2000) reason!: string;
}

export class SettleAwardDto {
  /** ISO 4217. Defaults to the company's currency handling upstream; INR when absent. */
  @IsOptional() @Matches(/^[A-Z]{3}$/) currency?: string;
}

/**
 * Objective extra work, bonus and reward controls.
 *
 * Two bases, because the two shapes of question are different: awards *on an objective* hang off
 * the objective, and one person's awards are a query about that person.
 *
 * The permissions escalate with the decision, and none of them was invented for this prompt:
 * `objective:Assign` to assign and to find a condition met, `objective:EditDraft` to report the
 * work done (the subject may always report their own), `objective:Approve` to decide, settle or
 * record. Approving additionally requires being the **approver named on the rule** — holding the
 * permission is not the same as being accountable for this reward.
 */
@Controller('tenants/:tenantId/objectives/:objectiveId/rewards')
@TenantScoped()
export class ObjectiveRewardAwardController {
  constructor(
    private readonly rewards: RewardService,
    private readonly tenantContext: TenantContextService,
    private readonly payout: PayoutAdapter,
  ) {}

  /**
   * The lifecycle, its transitions, and — deliberately prominent — whether this deployment can
   * actually pay anybody.
   *
   * A screen that offered a Settle button with no connector behind it would be promising
   * something the product cannot do, so the answer is served rather than assumed.
   */
  @Get('meta')
  @RequirePermission({ module: 'objective', action: 'View' })
  meta(): unknown {
    return {
      statuses: REWARD_AWARD_STATUSES.map((status) => ({
        status,
        label: REWARD_AWARD_STATUS_LABELS[status],
        tone: REWARD_AWARD_STATUS_TONES[status],
        next: ALLOWED_AWARD_TRANSITIONS[status],
      })),
      settlementRoutes: SETTLEMENT_ROUTES.map((route) => ({
        route,
        label: SETTLEMENT_ROUTE_LABELS[route],
      })),
      payoutConnector: {
        kind: this.payout.kind,
        canSettle: this.payout.canSettle,
        /** Never true for any adapter that ships today. Stated, not implied. */
        deliversRealPayment: false,
      },
      note:
        'Approving a reward is a decision, not a payment. Cash is settled only through an ' +
        'approved payroll connector, by somebody other than the approver; points and ' +
        'recognition are recorded instead. Approved points reach the performance score only if ' +
        'the company’s performance policy permits it, and that is off by default.',
    };
  }

  @Get('awards')
  @RequirePermission({ module: 'objective', action: 'View' })
  async list(@Param('objectiveId', ParseUUIDPipe) objectiveId: string): Promise<unknown> {
    return this.rewards.listForObjective({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
    });
  }

  @Post('awards')
  @RequirePermission({ module: 'objective', action: 'Assign' })
  async assign(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: AssignAwardDto,
  ): Promise<unknown> {
    return this.rewards.assign({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      subjectUserId: body.subjectUserId,
    });
  }

  /** The subject may always report their own work complete, so the floor is `EditDraft`. */
  @Post('awards/:awardId/complete')
  @RequirePermission({ module: 'objective', action: 'EditDraft' })
  async complete(@Param('awardId', ParseUUIDPipe) awardId: string): Promise<unknown> {
    return this.rewards.markCompleted({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      awardId,
    });
  }

  @Post('awards/:awardId/eligible')
  @RequirePermission({ module: 'objective', action: 'Assign' })
  async eligible(@Param('awardId', ParseUUIDPipe) awardId: string): Promise<unknown> {
    return this.rewards.markEligible({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      awardId,
    });
  }

  @Post('awards/:awardId/approve')
  @RequirePermission({ module: 'objective', action: 'Approve' })
  async approve(
    @Param('awardId', ParseUUIDPipe) awardId: string,
    @Body() body: DecideAwardDto,
  ): Promise<unknown> {
    return this.rewards.approve({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      awardId,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });
  }

  @Post('awards/:awardId/reject')
  @RequirePermission({ module: 'objective', action: 'Approve' })
  async reject(
    @Param('awardId', ParseUUIDPipe) awardId: string,
    @Body() body: RejectAwardDto,
  ): Promise<unknown> {
    return this.rewards.reject({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      awardId,
      reason: body.reason,
    });
  }

  /** Cash only, and never by the person who approved it. */
  @Post('awards/:awardId/settle')
  @RequirePermission({ module: 'objective', action: 'Approve' })
  async settle(
    @Param('awardId', ParseUUIDPipe) awardId: string,
    @Body() body: SettleAwardDto,
  ): Promise<unknown> {
    return this.rewards.settle({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      awardId,
      ...(body.currency === undefined ? {} : { currency: body.currency }),
    });
  }

  /** Points and recognition. The performance link is applied here, if policy permits it. */
  @Post('awards/:awardId/record')
  @RequirePermission({ module: 'objective', action: 'Approve' })
  async record(@Param('awardId', ParseUUIDPipe) awardId: string): Promise<unknown> {
    return this.rewards.record({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      awardId,
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

/** One person's reward awards, across every objective. */
@Controller('tenants/:tenantId/reward-awards')
@TenantScoped()
export class SubjectRewardAwardController {
  constructor(
    private readonly rewards: RewardService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * A person's reward awards.
   *
   * ## Gated on `performance`, not `objective` — a CR-03 correction
   *
   * This was `objective:View`, which worked only because a standard Employee happened to hold it.
   * CR-03 (Prompt 40A) made an Employee operations-only, and the effect was that **a person could
   * no longer see their own bonus** — which is absurd, and is the same absurdity the
   * department-scoped Head test below was written to prevent.
   *
   * `performance:View` is both the fix and the more accurate gate: a reward award is performance
   * information about a person, not part of authoring an Objective. Every company role holds it,
   * including an Employee, and the real restriction has always been the row-level scope check
   * inside `listForSubject` — which is what actually decides whose awards you may read. The module
   * grant is the coarse gate; it was never the thing keeping one person out of another's bonuses.
   *
   * Found by the full suite after the CR-03 narrowing. Worth recording rather than quietly fixing:
   * removing a grant can break a route that depended on it incidentally, and the only way that
   * surfaces is running everything.
   */
  @Get(':subjectUserId')
  @RequirePermission({ module: 'performance', action: 'View' })
  async forSubject(@Param('subjectUserId', ParseUUIDPipe) subjectUserId: string): Promise<unknown> {
    return this.rewards.listForSubject({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subjectUserId,
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
