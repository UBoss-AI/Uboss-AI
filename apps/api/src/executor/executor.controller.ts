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
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import {
  EXCEPTION_DEFAULT_OWNER,
  EXCEPTION_DEFAULT_SEVERITY,
  EXCEPTION_KIND_LABELS,
  EXCEPTION_KINDS,
  EXCEPTION_SEVERITIES,
  EXCEPTION_SEVERITY_TONES,
  EXCEPTION_STATE_LABELS,
  EXCEPTION_STATE_TONES,
  EXCEPTION_STATES,
  EXECUTOR_PERMITTED_ACTIONS,
  RESOLUTION_ACTION_LABELS,
  RESOLUTION_ACTIONS,
  VALIDATION_STAGE_LABELS,
  VALIDATION_STAGES,
  type ExceptionKind,
  type ExceptionSeverity,
  type ExceptionState,
  type ResolutionAction,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { ExecutorService } from './executor.service.js';

export class ListExceptionsDto {
  @IsOptional() @IsIn(EXCEPTION_KINDS) kind?: ExceptionKind;
  @IsOptional() @IsIn(EXCEPTION_SEVERITIES) severity?: ExceptionSeverity;
  @IsOptional() @IsIn(EXCEPTION_STATES) state?: ExceptionState;
  @IsOptional() @IsUUID() engineAgentId?: string;
  @IsOptional() @IsBoolean() @Type(() => Boolean) openOnly?: boolean;
  @Allow() _?: unknown;
}

export class ResolveExceptionDto {
  @IsIn(RESOLUTION_ACTIONS) action!: ResolutionAction;
  /** Required: an action on an exception with no note leaves a history nobody can read. */
  @IsString() @MinLength(1) @MaxLength(2000) note!: string;
  @IsOptional() @IsUUID() toUserId?: string;
}

/**
 * The Exception Center — Prompt 27.
 *
 * ## Every action here is a person's
 *
 * There is deliberately **no endpoint through which the Executor Agent resolves anything**. Its
 * own actions happen inside the sweep, where `executorMayResolve` and a database CHECK both refuse
 * a close. A route that let a caller act "as the Executor" would be a way around the locked rule,
 * so it does not exist: `POST :id/resolve` always attributes the action to the authenticated
 * person.
 *
 * ## Permissions
 *
 * `View` to read the queue. `Comment` to act on an exception — acknowledging, reassigning,
 * escalating, retrying are operational and the role templates grant a Manager exactly that.
 * `Administer` on top for `Resolve` and `Dismiss`, because closing an exception is deciding it is
 * dealt with. `Pause` for the sweep, which is an operational trigger.
 */
@TenantScoped()
@Controller('tenants/:tenantId/executor')
export class ExecutorController {
  constructor(
    private readonly executor: ExecutorService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The Exception Center's vocabulary, including what the Executor may and may not do. */
  @Get('meta')
  @RequirePermission({ module: 'executor', action: 'View' })
  meta(): unknown {
    return {
      kinds: EXCEPTION_KINDS.map((kind) => ({
        kind,
        label: EXCEPTION_KIND_LABELS[kind],
        // The source document's words, so a screen can say whose kind of problem this is even
        // when routing could not name an individual.
        defaultOwner: EXCEPTION_DEFAULT_OWNER[kind],
        defaultSeverity: EXCEPTION_DEFAULT_SEVERITY[kind],
      })),
      severities: EXCEPTION_SEVERITIES.map((severity) => ({
        severity,
        tone: EXCEPTION_SEVERITY_TONES[severity],
      })),
      states: EXCEPTION_STATES.map((state) => ({
        state,
        label: EXCEPTION_STATE_LABELS[state],
        tone: EXCEPTION_STATE_TONES[state],
      })),
      actions: RESOLUTION_ACTIONS.map((action) => ({
        action,
        label: RESOLUTION_ACTION_LABELS[action],
        // Published so a screen can show the boundary rather than merely respect it.
        executorMayTakeItAlone: EXECUTOR_PERMITTED_ACTIONS.includes(action),
      })),
      validationOrder: VALIDATION_STAGES.map((stage, index) => ({
        position: index + 1,
        stage,
        label: VALIDATION_STAGE_LABELS[stage],
      })),
      note:
        'The Executor Agent detects, routes, escalates, retries and pauses. It never resolves or ' +
        'dismisses, and it never stands in for a required human approval.',
    };
  }

  @Get('exceptions')
  @RequirePermission({ module: 'executor', action: 'View' })
  async list(@Query() query: ListExceptionsDto): Promise<unknown> {
    return this.executor.list({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.severity === undefined ? {} : { severity: query.severity }),
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.engineAgentId === undefined ? {} : { engineAgentId: query.engineAgentId }),
      ...(query.openOnly === undefined ? {} : { openOnly: query.openOnly }),
    });
  }

  @Get('exceptions/:exceptionId')
  @RequirePermission({ module: 'executor', action: 'View' })
  async view(@Param('exceptionId', ParseUUIDPipe) exceptionId: string): Promise<unknown> {
    return this.executor.view({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      exceptionId,
    });
  }

  /**
   * Act on an exception.
   *
   * `actorUserId` is always the authenticated person — never null, and there is no parameter that
   * could make it null. That is what stops this route being a way to act as the Executor and so
   * around the rule that the Executor cannot close its own findings.
   */
  @Post('exceptions/:exceptionId/act')
  @RequirePermission({ module: 'executor', action: 'Comment' })
  async act(
    @Param('exceptionId', ParseUUIDPipe) exceptionId: string,
    @Body() body: ResolveExceptionDto,
  ): Promise<unknown> {
    return this.executor.act({
      scope: this.tenantContext.requireScope(),
      exceptionId,
      action: body.action,
      actorUserId: this.currentUserId(),
      note: body.note,
      ...(body.toUserId === undefined ? {} : { toUserId: body.toUserId }),
    });
  }

  /**
   * Run one monitoring pass for this company.
   *
   * Exposed because a timer is infrastructure and an operator still needs to be able to say "look
   * now" — and because it makes the Executor observable rather than a black box. Idempotent: one
   * condition holds one open exception.
   */
  @Post('sweep')
  @RequirePermission({ module: 'executor', action: 'Pause' })
  async sweep(): Promise<unknown> {
    return this.executor.sweep({ scope: this.tenantContext.requireScope() });
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified user.');
    }
    return userId;
  }
}
