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
import {
  Allow,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import {
  AGENT_RUN_TYPES,
  ENGINE_AGENT_STATUSES,
  FORM3_ACTION_COLUMNS,
  FORM3_JOB_LEVEL_FIELDS,
  MISSING_DATA_BEHAVIOUR_LABELS,
  MISSING_DATA_BEHAVIOURS,
  AGENT_RUN_TYPE_LABELS,
  type AgentRunType,
  type MissingDataBehaviour,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { AgentBuilderService } from './agent-builder.service.js';

/**
 * The execution setup patch.
 *
 * Every field optional, because the screen saves one answer at a time and a patch must never
 * blank an answer it did not carry. `null` is meaningful and distinct from absent: it clears an
 * answer, which is what happens when somebody changes the run type away from a scheduled one.
 */
export class AgentSetupPatchDto {
  @IsOptional() @IsIn(AGENT_RUN_TYPES) runType?: AgentRunType | null;
  @IsOptional() @IsString() @MaxLength(300) triggerOrFrequency?: string | null;
  @IsOptional() @IsUUID() inputConnectionId?: string | null;
  @IsOptional() @IsString() @MaxLength(300) whereWorkHappens?: string | null;
  @IsOptional() @IsString() @MaxLength(300) outputDestination?: string | null;
  @IsOptional() @IsIn(MISSING_DATA_BEHAVIOURS) missingDataBehaviour?: MissingDataBehaviour | null;
}

export class SaveAgentSetupDto {
  @ValidateNested()
  @Type(() => AgentSetupPatchDto)
  patch!: AgentSetupPatchDto;
}

export class ActivateAgentDto {
  /** Rename at activation where policy permits. Omit to take the suggested name. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) agentName?: string;
  /** Present so `whitelist: true` does not silently strip an empty body. */
  @Allow() _?: unknown;
}

/**
 * Agent Builder — Prompt 24.
 *
 * ## The action each route asks for, and why
 *
 *   * Reading is `View`.
 *   * Answering the remaining setup, and testing, are `EditDraft` — it is a draft configuration.
 *   * **Activation is `Run`**, not `Publish`. Putting your own assigned agent to work is doing
 *     the work, which is what an Employee is for; `Publish` would mean deciding what the company
 *     releases, and no Employee holds it on any module. Choosing `Publish` here would have
 *     quietly broken that guardrail.
 *   * **Form 3 is `Publish`** — the advanced authorized read of the whole canonical job method,
 *     including steps belonging to other people. That is authority over the job method, so it
 *     sits with the role that has it, and an Employee cannot reach it.
 *
 * Each handler then makes a second, row-level decision through the scope engine, so a `Manager`
 * with a team subtree and an `Employee` with `OwnWork` get different answers about the same
 * route. Hidden navigation is presentation only; this is what actually protects the data.
 */
@TenantScoped()
@Controller('tenants/:tenantId/agent-builder')
export class AgentBuilderController {
  constructor(
    private readonly builder: AgentBuilderService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The editor's own vocabulary.
   *
   * Served so the screen's controls and the server's validation cannot disagree about what a run
   * type or an exception behaviour may be — the same reason the workflow editor serves its own
   * meta. Includes Form 3's shape, so an authorized view renders the client's columns rather than
   * a developer's recollection of them.
   */
  @Get('meta')
  @RequirePermission({ module: 'agent-builder', action: 'View' })
  meta(): unknown {
    return {
      runTypes: AGENT_RUN_TYPES.map((runType) => ({
        runType,
        label: AGENT_RUN_TYPE_LABELS[runType],
      })),
      missingDataBehaviours: MISSING_DATA_BEHAVIOURS.map((behaviour) => ({
        behaviour,
        label: MISSING_DATA_BEHAVIOUR_LABELS[behaviour],
      })),
      engineAgentStatuses: ENGINE_AGENT_STATUSES,
      form3: {
        jobLevelFields: FORM3_JOB_LEVEL_FIELDS,
        actionColumns: FORM3_ACTION_COLUMNS,
        note:
          'Form 3 is the complete job-definition view for authorized users. It is not a blank ' +
          'form every employee must re-enter.',
      },
      note:
        'Only missing execution setup is ever requested. If the objective, the workflow, policy ' +
        'and the approved connections already answer everything, the builder asks nothing and ' +
        'offers Ready to Test / Activate.',
    };
  }

  /** Everything awaiting agent setup that this person may act on. */
  @Get()
  @RequirePermission({ module: 'agent-builder', action: 'View' })
  async list(): Promise<unknown> {
    return this.builder.list({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
    });
  }

  @Get(':assignmentId')
  @RequirePermission({ module: 'agent-builder', action: 'View' })
  async view(@Param('assignmentId', ParseUUIDPipe) assignmentId: string): Promise<unknown> {
    return this.builder.view({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      assignmentId,
    });
  }

  /** Record part of the execution setup — one answer at a time. */
  @Put(':assignmentId/setup')
  @RequirePermission({ module: 'agent-builder', action: 'EditDraft' })
  async saveSetup(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() body: SaveAgentSetupDto,
  ): Promise<unknown> {
    return this.builder.saveSetup({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      assignmentId,
      patch: body.patch,
    });
  }

  /** A controlled test. Writes nothing to the real output destination. */
  @Post(':assignmentId/test')
  @RequirePermission({ module: 'agent-builder', action: 'EditDraft' })
  async test(@Param('assignmentId', ParseUUIDPipe) assignmentId: string): Promise<unknown> {
    return this.builder.test({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      assignmentId,
    });
  }

  /** Create or map the reusable Engine Agent. */
  @Post(':assignmentId/activate')
  @RequirePermission({ module: 'agent-builder', action: 'Run' })
  async activate(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() body: ActivateAgentDto,
  ): Promise<unknown> {
    return this.builder.activate({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      assignmentId,
      ...(body.agentName === undefined ? {} : { agentName: body.agentName }),
    });
  }

  /** The canonical Form 3 — a read, never a form. */
  @Get(':assignmentId/form3')
  @RequirePermission({ module: 'agent-builder', action: 'Publish' })
  async form3(@Param('assignmentId', ParseUUIDPipe) assignmentId: string): Promise<unknown> {
    return this.builder.form3({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      assignmentId,
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
