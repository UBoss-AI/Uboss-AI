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
import { Allow, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import {
  HUMAN_TASK_STATUS_LABELS,
  HUMAN_TASK_STATUS_TONES,
  HUMAN_TASK_STATUSES,
  TASK_NOTE_KINDS,
  type HumanTaskStatus,
  type TaskNoteKind,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';

import { HumanTaskService } from './human-task.service.js';

export class ListTasksDto {
  @IsOptional() @IsIn(['mine', 'team', 'blocked']) filter?: 'mine' | 'team' | 'blocked';
  @IsOptional() @IsIn(HUMAN_TASK_STATUSES) status?: HumanTaskStatus;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  /** Present so `whitelist: true` does not silently strip an unknown query parameter. */
  @Allow() _?: unknown;
}

export class BlockTaskDto {
  @IsString() @MinLength(1) @MaxLength(2000) reason!: string;
}

export class AddEvidenceDto {
  @IsString() @MinLength(1) @MaxLength(2000) description!: string;
  @IsOptional() @IsString() @MaxLength(500) reference?: string;
}

export class AddNoteDto {
  @IsIn(TASK_NOTE_KINDS) kind!: TaskNoteKind;
  @IsString() @MinLength(1) @MaxLength(4000) body!: string;
}

/**
 * The Human To-do list.
 *
 * Its own module and its own permission set (`todo`), not a sub-route of objectives: an Employee
 * has `todo` access at `OwnWork` scope and no right to browse objectives, and routing their work
 * through the objective module would have made that separation impossible to express.
 */
@Controller('tenants/:tenantId/todo')
@TenantScoped()
export class HumanTaskController {
  constructor(
    private readonly tasks: HumanTaskService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The status vocabulary, so a screen never invents a label or a colour. */
  @Get('meta')
  @RequirePermission({ module: 'todo', action: 'View' })
  meta(): unknown {
    return {
      statuses: HUMAN_TASK_STATUSES.map((status) => ({
        status,
        label: HUMAN_TASK_STATUS_LABELS[status],
        tone: HUMAN_TASK_STATUS_TONES[status],
      })),
      noteKinds: TASK_NOTE_KINDS,
      note:
        'Overdue is not a stored status. It is derived from the due time, so a task can be both ' +
        'waiting on somebody else and late without losing either fact.',
    };
  }

  @Get()
  @RequirePermission({ module: 'todo', action: 'View' })
  async list(@Query() query: ListTasksDto): Promise<unknown> {
    return this.tasks.list({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      ...(query.filter === undefined ? {} : { filter: query.filter }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.search === undefined ? {} : { search: query.search }),
    });
  }

  @Get(':taskId')
  @RequirePermission({ module: 'todo', action: 'View' })
  async view(@Param('taskId', ParseUUIDPipe) taskId: string): Promise<unknown> {
    return this.tasks.view({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      taskId,
    });
  }

  @Post(':taskId/start')
  @RequirePermission({ module: 'todo', action: 'EditDraft' })
  async start(@Param('taskId', ParseUUIDPipe) taskId: string): Promise<unknown> {
    return this.tasks.start({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      taskId,
    });
  }

  @Post(':taskId/block')
  @RequirePermission({ module: 'todo', action: 'EditDraft' })
  async block(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: BlockTaskDto,
  ): Promise<unknown> {
    return this.tasks.block({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      taskId,
      reason: body.reason,
    });
  }

  @Post(':taskId/evidence')
  @RequirePermission({ module: 'todo', action: 'EditDraft' })
  async addEvidence(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: AddEvidenceDto,
  ): Promise<unknown> {
    return this.tasks.addEvidence({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      taskId,
      description: body.description,
      ...(body.reference === undefined ? {} : { reference: body.reference }),
    });
  }

  @Post(':taskId/notes')
  @RequirePermission({ module: 'todo', action: 'Comment' })
  async addNote(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: AddNoteDto,
  ): Promise<unknown> {
    return this.tasks.addNote({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      taskId,
      kind: body.kind,
      body: body.body,
    });
  }

  /** Submit & complete: one action, two outcomes, depending on whether an approval is required. */
  @Post(':taskId/submit')
  @RequirePermission({ module: 'todo', action: 'EditDraft' })
  async submit(@Param('taskId', ParseUUIDPipe) taskId: string): Promise<unknown> {
    return this.tasks.submit({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      taskId,
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
