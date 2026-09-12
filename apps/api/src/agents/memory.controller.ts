import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
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
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

import {
  AGENT_MEMORY_MODES,
  AGENT_MEMORY_MODE_LABELS,
  AGENT_MEMORY_MODE_RULES,
  DATA_CLASSIFICATION_DESCRIPTIONS,
  DATA_CLASSIFICATIONS,
  MAX_MEMORY_RETENTION_DAYS,
  MEMORY_OFFBOARDING_BEHAVIOURS,
  MEMORY_OFFBOARDING_LABELS,
  MEMORY_MODE_MAX_VISIBILITY,
  MEMORY_VISIBILITIES,
  MEMORY_VISIBILITY_LABELS,
  type AgentMemoryMode,
  type DataClassification,
  type MemoryOffboardingBehaviour,
  type MemoryVisibility,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { tenantScopeForPlatformOperation } from '../persistence/tenant-context.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { PlatformOnly, TenantScoped } from '../tenancy/tenancy.decorators.js';
import { MemoryService } from './memory.service.js';

class SetMemoryPolicyDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'retentionDays must be a whole number of days.' })
  @Min(1)
  @Max(MAX_MEMORY_RETENTION_DAYS)
  retentionDays?: number;

  @IsIn(MEMORY_VISIBILITIES as readonly string[])
  visibility!: MemoryVisibility;

  @IsIn(DATA_CLASSIFICATIONS as readonly string[])
  maxClassification!: DataClassification;

  @IsBoolean() allowCrossUser!: boolean;
  @IsBoolean() allowCrossObjective!: boolean;

  @IsIn(MEMORY_OFFBOARDING_BEHAVIOURS as readonly string[])
  offboardingBehaviour!: MemoryOffboardingBehaviour;

  @IsBoolean() requiresApproval!: boolean;

  @IsString() @MinLength(4) @MaxLength(1000) reason!: string;
}

class ForgetDto {
  @IsString() @MinLength(4) @MaxLength(300) reason!: string;
}

class ListMemoryDto {
  @IsOptional() @IsUUID(7) engineAgentId?: string;
  @IsOptional() @IsIn(AGENT_MEMORY_MODES as readonly string[]) mode?: AgentMemoryMode;
  @IsOptional() @Type(() => Boolean) @IsBoolean() includeDeleted?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

/**
 * Engine Agent memory — Prompt 33.
 *
 * ## There is no route that writes a memory record
 *
 * Deliberately. Remembering is something an *agent* does during a run, under the mode its
 * published version declares and the ceiling its company's policy sets. A person writing a memory
 * record directly would be memory with no provenance — no run produced it, so no rule governs its
 * scope — and every read decision in this module is expressed in terms of the run that wrote it.
 *
 * So the company-facing surface is governance: read the policies, change them, see what the agents
 * are holding, and delete something. The sweep is on the platform plane because nothing schedules
 * it yet.
 */
@Controller('tenants/:tenantId/memory')
@TenantScoped()
export class MemoryController {
  constructor(
    private readonly memory: MemoryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The vocabulary, including each mode's ceiling.
   *
   * The ceilings matter to the screen: a company may narrow a mode's visibility and may not widen
   * it past what §19 sets, so the form has to know before it offers the option. Sending the
   * server's own table means the UI cannot disagree with what the service will accept.
   */
  @Get('vocabulary')
  @RequirePermission({ module: 'agents', action: 'View' })
  vocabulary(): Record<string, unknown> {
    return {
      modes: AGENT_MEMORY_MODES.map((mode) => ({
        mode,
        label: AGENT_MEMORY_MODE_LABELS[mode],
        rule: AGENT_MEMORY_MODE_RULES[mode],
        maxVisibility: MEMORY_MODE_MAX_VISIBILITY[mode],
      })),
      visibilities: MEMORY_VISIBILITIES.map((visibility) => ({
        visibility,
        label: MEMORY_VISIBILITY_LABELS[visibility],
      })),
      classifications: DATA_CLASSIFICATIONS.map((classification) => ({
        classification,
        description: DATA_CLASSIFICATION_DESCRIPTIONS[classification],
      })),
      offboardingBehaviours: MEMORY_OFFBOARDING_BEHAVIOURS.map((behaviour) => ({
        behaviour,
        label: MEMORY_OFFBOARDING_LABELS[behaviour],
      })),
      maxRetentionDays: MAX_MEMORY_RETENTION_DAYS,
      note:
        'No cross-tenant memory is possible: every record is tenant-owned under row-level ' +
        'security and references a run in the same company. There is no setting for it because ' +
        'there is nothing to set.',
    };
  }

  @Get('policies')
  @RequirePermission({ module: 'agents', action: 'View' })
  async policies(): Promise<unknown> {
    return { policies: await this.memory.policies(this.tenantContext.requireScope()) };
  }

  /** Change one mode's policy. `settings:Administer` — see the service. */
  @Put('policies/:mode')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async setPolicy(@Param('mode') mode: string, @Body() body: SetMemoryPolicyDto): Promise<unknown> {
    return this.memory.setPolicy({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      reason: body.reason,
      policy: {
        mode: MemoryController.requireMode(mode),
        retentionDays: body.retentionDays ?? null,
        visibility: body.visibility,
        maxClassification: body.maxClassification,
        allowCrossUser: body.allowCrossUser,
        allowCrossObjective: body.allowCrossObjective,
        offboardingBehaviour: body.offboardingBehaviour,
        requiresApproval: body.requiresApproval,
      },
    });
  }

  /** What this company's agents are holding. */
  @Get('records')
  @RequirePermission({ module: 'agents', action: 'View' })
  async records(@Query() query: ListMemoryDto): Promise<unknown> {
    return {
      records: await this.memory.list({
        scope: this.tenantContext.requireScope(),
        actorUserId: this.currentUserId(),
        ...(query.engineAgentId === undefined ? {} : { engineAgentId: query.engineAgentId }),
        ...(query.mode === undefined ? {} : { mode: query.mode }),
        ...(query.includeDeleted === undefined ? {} : { includeDeleted: query.includeDeleted }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      }),
    };
  }

  /**
   * Delete one record.
   *
   * A `DELETE` that nulls the content and keeps the row. "Was our data deleted?" has to be
   * answerable, and a vanished row answers nothing.
   */
  @Delete('records/:recordId')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async forget(@Param('recordId') recordId: string, @Query() query: ForgetDto): Promise<unknown> {
    return this.memory.forget({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      recordId,
      reason: query.reason,
    });
  }

  private static requireMode(mode: string): AgentMemoryMode {
    const found = AGENT_MEMORY_MODES.find((candidate) => candidate === mode);
    if (found === undefined) {
      throw new UnauthorizedException(
        `"${mode}" is not a memory mode. The modes are: ${AGENT_MEMORY_MODES.join(', ')}.`,
      );
    }
    return found;
  }

  private currentUserId(): string {
    const id = actorUserId(getActor());
    if (id === undefined || id === null) {
      throw new UnauthorizedException('Memory governance is for signed-in company members.');
    }
    return id;
  }
}

/**
 * The retention sweep.
 *
 * Platform-plane because **nothing schedules it**. Expiring a company's memory is a job for the
 * Prompt 26 business-cron scheduler, and adding a second scheduler here to make one prompt look
 * finished would be the wrong trade. The route exists so the sweep is reachable and testable, and
 * the limitation is recorded rather than hidden.
 */
@Controller('platform/memory')
@PlatformOnly()
export class MemoryPlatformController {
  constructor(private readonly memory: MemoryService) {}

  @Post('tenants/:tenantId/sweep')
  @RequirePermission({ module: 'support', action: 'Administer' })
  async sweep(@Param('tenantId') tenantId: string): Promise<unknown> {
    return this.memory.sweepExpired({ scope: tenantScopeForPlatformOperation(tenantId) });
  }
}
