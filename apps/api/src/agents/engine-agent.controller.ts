import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  Allow,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  AGENT_MEMORY_MODE_LABELS,
  AGENT_MEMORY_MODE_RULES,
  AGENT_MEMORY_MODES,
  AGENT_RUN_TYPES,
  ENGINE_AGENT_ACTION_LABELS,
  ENGINE_AGENT_ACTIONS,
  ENGINE_AGENT_STATUS_LABELS,
  ENGINE_AGENT_STATUS_TONES,
  ENGINE_AGENT_STATUSES,
  MISSING_DATA_BEHAVIOURS,
  TOOL_ACTION_CATEGORIES,
  WEEKDAYS,
  type AgentMemoryMode,
  type Weekday,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { AgentSetupPatchDto } from './agent-builder.controller.js';
import { EngineAgentService } from './engine-agent.service.js';

export class PauseAgentDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

export class ArchiveAgentDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @Allow() _?: unknown;
}

/** A new name for an agent. The only field, because a rename changes nothing else. */
export class RenameAgentDto {
  @IsString() @MaxLength(200) name!: string;
}

/**
 * When an agent runs, as a person sets it.
 *
 * Days and a time, never a cron expression. A browser that could post a raw expression could post
 * one the engine's parser rejects, and the refusal would arrive hours later as *an agent that
 * never ran* instead of as a validation error here. The service does the translation, once.
 *
 * All three absent means "take it off its schedule", which is how a screen clears one.
 */
export class SetAgentScheduleDto {
  @IsOptional() @IsArray() @IsIn(WEEKDAYS, { each: true }) weekdays?: Weekday[];
  @IsOptional() @IsInt() @Min(0) @Max(23) hour?: number;
  @IsOptional() @IsInt() @Min(0) @Max(59) minute?: number;
}

export class CreateAgentVersionDto {
  @IsOptional() @ValidateNested() @Type(() => AgentSetupPatchDto) setup?: AgentSetupPatchDto;
  @IsOptional() @IsIn(AGENT_MEMORY_MODES) memoryMode?: AgentMemoryMode;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) skillVersionIds?: string[];
  @IsOptional() @IsArray() @IsIn(TOOL_ACTION_CATEGORIES, { each: true }) toolCategories?: string[];
  @Allow() _?: unknown;
}

export class RequestActivationApprovalDto {
  /** Omit to address it to a Head rather than to one person. */
  @IsOptional() @IsUUID() approverUserId?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class ActivateVersionDto {
  /**
   * The approver, where the impact analysis said one is required.
   *
   * A separate person: the service refuses an actor who names themselves, because approving one's
   * own reach-widening change would make the requirement decorative.
   */
  /**
   * The approved `AgentActivation` request authorising this activation.
   *
   * Was `approvedByUserId` until Prompt 28, which is to say it was a name the caller supplied
   * and nobody checked. Now it is a request the service looks up and verifies.
   */
  @IsOptional() @IsUUID() approvalRequestId?: string;
  @Allow() _?: unknown;
}

export class ListAgentsDto {
  @IsOptional() @IsBoolean() @Type(() => Boolean) includeArchived?: boolean;
  @Allow() _?: unknown;
}

/**
 * The Engine Agent registry — Prompt 25.
 *
 * ## What is deliberately absent
 *
 * **`Run Now` and `Open Runs` have no routes here.** Runs are the next prompt's engine, and an
 * endpoint that accepted "run now" and queued nothing would be worse than one that does not
 * exist: a caller would have no way to tell a silent no-op from a successful start. The registry
 * still *reports* both actions in `actions`, because the status genuinely permits them, and the
 * screen disables them with the reason.
 *
 * ## Permissions
 *
 * `View` to read. `Pause` for pause and resume — the action the role templates already grant a
 * Manager and a CompanyAdmin for exactly this. `Publish` for anything that changes what the
 * company runs: drafting a version, testing it, activating it, and archiving an agent. That last
 * one is a Head decision because archiving retires an identity permanently.
 */
@TenantScoped()
@Controller('tenants/:tenantId/agents')
export class EngineAgentController {
  constructor(
    private readonly agents: EngineAgentService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The registry's own vocabulary, so a screen's controls cannot drift from the server's. */
  @Get('meta')
  @RequirePermission({ module: 'agents', action: 'View' })
  meta(): unknown {
    return {
      statuses: ENGINE_AGENT_STATUSES.map((status) => ({
        status,
        label: ENGINE_AGENT_STATUS_LABELS[status],
        tone: ENGINE_AGENT_STATUS_TONES[status],
      })),
      actions: ENGINE_AGENT_ACTIONS.map((action) => ({
        action,
        label: ENGINE_AGENT_ACTION_LABELS[action],
      })),
      memoryModes: AGENT_MEMORY_MODES.map((mode) => ({
        mode,
        label: AGENT_MEMORY_MODE_LABELS[mode],
        // The architecture's technical rule, shown wherever a mode is chosen, so nobody picks one
        // without seeing what it commits the company to.
        rule: AGENT_MEMORY_MODE_RULES[mode],
      })),
      runTypes: AGENT_RUN_TYPES,
      missingDataBehaviours: MISSING_DATA_BEHAVIOURS,
      note:
        'Recurring work creates Runs on the agent it already has; it never creates another ' +
        'agent. A published version is immutable, and a configuration change drafts a new one.',
    };
  }

  @Get()
  @RequirePermission({ module: 'agents', action: 'View' })
  async list(@Query() query: ListAgentsDto): Promise<unknown> {
    return this.agents.list({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      ...(query.includeArchived === undefined ? {} : { includeArchived: query.includeArchived }),
    });
  }

  @Get(':agentId')
  @RequirePermission({ module: 'agents', action: 'View' })
  async view(@Param('agentId', ParseUUIDPipe) agentId: string): Promise<unknown> {
    return this.agents.view({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      agentId,
    });
  }

  @Post(':agentId/pause')
  @RequirePermission({ module: 'agents', action: 'Pause' })
  async pause(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() body: PauseAgentDto,
  ): Promise<unknown> {
    return this.agents.pause({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      agentId,
      reason: body.reason,
    });
  }

  @Post(':agentId/resume')
  @RequirePermission({ module: 'agents', action: 'Pause' })
  async resume(@Param('agentId', ParseUUIDPipe) agentId: string): Promise<unknown> {
    return this.agents.resume({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      agentId,
    });
  }

  @Post(':agentId/archive')
  @RequirePermission({ module: 'agents', action: 'Publish' })
  async archive(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() body: ArchiveAgentDto,
  ): Promise<unknown> {
    return this.agents.archive({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      agentId,
      reason: body.reason ?? '',
    });
  }

  /**
   * Rename an agent.
   *
   * Gated on `agent-builder: EditDraft`, not on an `agents` action: deciding what an agent is
   * called belongs with deciding what it is. The service checks the same thing again — this
   * decorator is the route's declaration, not its enforcement.
   */
  @Post(':agentId/name')
  @RequirePermission({ module: 'agent-builder', action: 'EditDraft' })
  async rename(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() body: RenameAgentDto,
  ): Promise<unknown> {
    return this.agents.rename({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      agentId,
      name: body.name,
    });
  }

  /**
   * Set or clear an agent's schedule.
   *
   * `agents: Schedule`, not `Run`. Deciding that an agent runs unattended is a different authority
   * from running one yourself — a standard Employee holds the second and not the first, and that
   * is the whole reason the two actions exist separately.
   */
  @Post(':agentId/schedule')
  @RequirePermission({ module: 'agents', action: 'Schedule' })
  async setSchedule(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() body: SetAgentScheduleDto,
  ): Promise<unknown> {
    /*
     * Nothing supplied means "no schedule". An hour without a minute does not: a half-given
     * schedule is a mistake, and guessing the missing half would put an agent on a time nobody
     * chose.
     */
    const clearing = body.hour === undefined && body.minute === undefined;
    if (!clearing && (body.hour === undefined || body.minute === undefined)) {
      throw new BadRequestException('A schedule needs both an hour and a minute.');
    }

    return this.agents.setSchedule({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      agentId,
      schedule: clearing
        ? null
        : { weekdays: body.weekdays ?? [], hour: body.hour!, minute: body.minute! },
    });
  }

  @Post(':agentId/versions')
  @RequirePermission({ module: 'agents', action: 'Publish' })
  async createVersion(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() body: CreateAgentVersionDto,
  ): Promise<unknown> {
    return this.agents.createNewVersion({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      agentId,
      ...(body.setup === undefined ? {} : { setup: body.setup }),
      ...(body.memoryMode === undefined ? {} : { memoryMode: body.memoryMode }),
      ...(body.skillVersionIds === undefined ? {} : { skillVersionIds: body.skillVersionIds }),
      ...(body.toolCategories === undefined ? {} : { toolCategories: body.toolCategories }),
    });
  }

  @Post(':agentId/versions/:versionId/test')
  @RequirePermission({ module: 'agents', action: 'Publish' })
  async testVersion(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ): Promise<unknown> {
    return this.agents.testVersion({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      agentId,
      versionId,
    });
  }

  /**
   * Raise the approval a reach-widening version needs.
   *
   * `Publish` rather than `Approve`: asking for a decision is not making one, and the person who
   * wants to activate a version is exactly the person who should be able to ask.
   */
  @Post(':agentId/versions/:versionId/request-approval')
  @RequirePermission({ module: 'agents', action: 'Publish' })
  async requestActivationApproval(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() body: RequestActivationApprovalDto,
  ): Promise<unknown> {
    return this.agents.requestActivationApproval({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      agentId,
      versionId,
      ...(body.approverUserId === undefined ? {} : { approverUserId: body.approverUserId }),
      ...(body.note === undefined ? {} : { note: body.note }),
    });
  }

  @Post(':agentId/versions/:versionId/activate')
  @RequirePermission({ module: 'agents', action: 'Publish' })
  async activateVersion(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() body: ActivateVersionDto,
  ): Promise<unknown> {
    return this.agents.activateVersion({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      agentId,
      versionId,
      ...(body.approvalRequestId === undefined
        ? {}
        : { approvalRequestId: body.approvalRequestId }),
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
