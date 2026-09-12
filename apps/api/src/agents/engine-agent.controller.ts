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
import { Type } from 'class-transformer';
import {
  Allow,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
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
  type AgentMemoryMode,
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
