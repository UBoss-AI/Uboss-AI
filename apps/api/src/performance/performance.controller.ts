import { Body, Controller, Get, Param, Post, Put, UnauthorizedException } from '@nestjs/common';
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

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { PerformanceService } from './performance.service.js';

/** The kinds a *person* may record by hand. The derived four come from the modules that own work. */
const MANUAL_EVENT_KINDS = ['ManualAdjustment', 'BlockerNeutralised'] as const;

export class RecordEventDto {
  @IsUUID()
  subjectUserId!: string;

  @IsIn(MANUAL_EVENT_KINDS, {
    message:
      'Only a manual adjustment or a blocker neutralisation may be recorded by hand. ' +
      'On-time, late, missed and rejected outcomes are recorded by the module that owns the ' +
      'work, so a score cannot be typed in for work that never happened.',
  })
  kind!: (typeof MANUAL_EVENT_KINDS)[number];

  @IsString()
  @MaxLength(40)
  sourceKind!: string;

  @IsString()
  @MaxLength(120)
  sourceId!: string;

  @IsString()
  @MinLength(5, { message: 'A performance adjustment must say why.' })
  @MaxLength(1000)
  reason!: string;

  /** Required for `BlockerNeutralised`. */
  @IsOptional()
  @IsUUID()
  neutralisesEventId?: string;

  /** Required for `ManualAdjustment`. */
  @IsOptional()
  @IsInt()
  points?: number;
}

export class SetPolicyDto {
  @IsString()
  @MinLength(5, { message: 'A performance policy change must say why.' })
  @MaxLength(500)
  reason!: string;

  @IsOptional() @IsInt() @Min(0) onTimeAcceptedPoints?: number;
  @IsOptional() @IsInt() lateCompletionPoints?: number;
  @IsOptional() @IsInt() missedPoints?: number;
  @IsOptional() @IsInt() qualityRejectedPoints?: number;

  @IsOptional() @IsInt() bronzeThreshold?: number;
  @IsOptional() @IsInt() silverThreshold?: number;
  @IsOptional() @IsInt() goldThreshold?: number;
  @IsOptional() @IsInt() platinumThreshold?: number;
  @IsOptional() @IsInt() diamondThreshold?: number;

  @IsOptional() @IsBoolean() blockersNeutraliseFully?: boolean;
}

/**
 * Performance score and badges.
 *
 * ## Why the derived kinds are not postable
 *
 * A route that accepted `OnTimeAccepted` would let anybody with the permission mint points for
 * work that never existed, and no amount of audit makes that acceptable — the whole value of the
 * ledger is that each row points at real work. So the four derived kinds are recorded by the
 * modules that own the work (to-do completion, an approval decision, the deadline sweeper), and
 * this controller exposes only the two a person legitimately decides.
 *
 * ## Reading somebody else's score is scoped
 *
 * The route permission is the floor. `viewFor` re-checks with the subject as the resource owner,
 * so an Employee reads their own, a Manager reads their team's through `TeamSubtree`, and an
 * Admin reads the company's — the Prompt 7 answer, not a second rule invented here.
 */
@Controller('tenants/:tenantId/performance')
@TenantScoped()
export class PerformanceController {
  constructor(
    private readonly performance: PerformanceService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The signed-in person's own performance. Always permitted to themselves. */
  @Get('me')
  @RequirePermission({ module: 'performance', action: 'View' })
  async mine(): Promise<unknown> {
    const userId = this.currentUserId();
    return this.performance.viewFor({
      scope: this.tenantContext.requireScope(),
      actorUserId: userId,
      subjectUserId: userId,
    });
  }

  /** The active policy, so a screen can show the rules next to the score. */
  @Get('policy')
  @RequirePermission({ module: 'performance', action: 'View' })
  async policy(): Promise<unknown> {
    const policy = await this.performance.activePolicy(this.tenantContext.requireScope());
    return {
      version: policy.version,
      points: {
        onTimeAccepted: policy.onTimeAcceptedPoints,
        lateCompletion: policy.lateCompletionPoints,
        missed: policy.missedPoints,
        qualityRejected: policy.qualityRejectedPoints,
      },
      thresholds: {
        Bronze: policy.bronzeThreshold,
        Silver: policy.silverThreshold,
        Gold: policy.goldThreshold,
        Platinum: policy.platinumThreshold,
        Diamond: policy.diamondThreshold,
      },
      blockersNeutraliseFully: policy.blockersNeutraliseFully,
      reason: policy.reason,
      note:
        'Past events keep the policy version they were scored under. Changing this creates ' +
        'version ' +
        String(policy.version + 1) +
        ' and re-derives levels; it never rewrites points already earned.',
    };
  }

  /** Replace the policy with a new version. `performance:Administer`. */
  @Put('policy')
  @RequirePermission({ module: 'performance', action: 'Administer' })
  async setPolicy(@Body() body: SetPolicyDto): Promise<unknown> {
    const { reason, ...changes } = body;
    const policy = await this.performance.setPolicy({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      reason,
      changes,
    });
    return { version: policy.version, supersededVersion: policy.version - 1 };
  }

  /** One person's performance detail. Scoped — see the class note. */
  @Get(':subjectUserId')
  @RequirePermission({ module: 'performance', action: 'View' })
  async view(@Param('subjectUserId') subjectUserId: string): Promise<unknown> {
    return this.performance.viewFor({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subjectUserId,
    });
  }

  /**
   * Record a manual adjustment or an approved blocker's neutralisation.
   *
   * `performance:Administer`, because it changes somebody's standing. Idempotent: posting the
   * same source twice returns the first event and says so, rather than scoring twice.
   */
  @Post('events')
  @RequirePermission({ module: 'performance', action: 'Administer' })
  async recordEvent(@Body() body: RecordEventDto): Promise<unknown> {
    const result = await this.performance.recordEvent({
      scope: this.tenantContext.requireScope(),
      subjectUserId: body.subjectUserId,
      kind: body.kind,
      sourceKind: body.sourceKind,
      sourceId: body.sourceId,
      reason: body.reason,
      ...(body.neutralisesEventId === undefined
        ? {}
        : { neutralisesEventId: body.neutralisesEventId }),
      ...(body.points === undefined ? {} : { points: body.points }),
      recordedByUserId: this.currentUserId(),
    });

    return {
      eventId: result.event.id,
      points: result.event.points,
      alreadyRecorded: result.alreadyRecorded,
      ...(result.alreadyRecorded
        ? {
            note:
              'This source had already been scored for that kind, so nothing was added. The ' +
              'existing event is returned.',
          }
        : {}),
    };
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified user.');
    }
    return userId;
  }
}
