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
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
  MinLength,
} from 'class-validator';

import {
  BLOCK_OWNER,
  MISSED_RUN_POLICIES,
  OVERLAP_POLICIES,
  RUN_STATE_LABELS,
  RUN_STATE_TONES,
  RUN_STATES,
  RUN_TRIGGER_LABELS,
  RUN_TRIGGERS,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { AgentOperatorService } from '../agents/agent-operator.service.js';
import { EngineAgentService } from '../agents/engine-agent.service.js';
import { RunEngineService } from './run-engine.service.js';
import { RunQueue } from './run-queue.js';
import { RunSchedulerService } from './run-scheduler.service.js';

export class CancelRunDto {
  @IsString() @MinLength(1) @MaxLength(2000) reason!: string;
}

export class ResumeRunDto {
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @Allow() _?: unknown;
}

export class ListRunsDto {
  @IsOptional() @IsInt() @Min(1) @Max(200) @Type(() => Number) limit?: number;
  @Allow() _?: unknown;
}

/**
 * Runs — Prompt 26.
 *
 * Mounted under the agent, because a run has no meaning without one: `Agent → Assignment/Job →
 * Run` is the locked relationship, and a top-level `/runs` collection would invite code that
 * looks up a run without ever establishing which agent's it is.
 *
 * ## This closes ADR-122
 *
 * `Run Now` and `Open Runs` were reported as permitted actions at Prompt 25 with no routes behind
 * them, deliberately, because a route that queued nothing would be indistinguishable from one that
 * worked. They exist now.
 *
 * ## Permissions
 *
 * `Run` to start one — the action an Employee holds for their own work, because running approved
 * work is the job. `View` to read. `Pause` to cancel or resume: stopping a run in flight is the
 * same operational authority as pausing the agent, and it is what a Manager and a CompanyAdmin
 * hold. `Schedule` to set a schedule, which is the action the templates already name for deciding
 * that work runs unattended.
 */
@TenantScoped()
@Controller('tenants/:tenantId/agents/:agentId/runs')
export class RunController {
  constructor(
    private readonly engine: RunEngineService,
    private readonly agents: EngineAgentService,
    // Prompt 40A (CR-03): the operator half of agent access.
    private readonly operators: AgentOperatorService,
    private readonly scheduler: RunSchedulerService,
    private readonly queue: RunQueue,
    private readonly authorization: AuthorizationService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The run vocabulary, including who resolves each kind of block. */
  @Get('meta')
  @RequirePermission({ module: 'agents', action: 'View' })
  meta(): unknown {
    return {
      states: RUN_STATES.map((state) => ({
        state,
        label: RUN_STATE_LABELS[state],
        tone: RUN_STATE_TONES[state],
      })),
      triggers: RUN_TRIGGERS.map((trigger) => ({
        trigger,
        label: RUN_TRIGGER_LABELS[trigger],
      })),
      // The reason the four blocked states are four states: four different people resolve them.
      blockOwners: BLOCK_OWNER,
      missedRunPolicies: MISSED_RUN_POLICIES,
      overlapPolicies: OVERLAP_POLICIES,
      transport: {
        kind: this.queue.kind,
        isDurableTransport: this.queue.isDurableTransport,
        note: this.queue.isDurableTransport
          ? 'Work is queued through a broker and survives a restart.'
          : 'Work runs in this process. The durable run row is still the record either way.',
      },
      note:
        'A durable run row exists before the work does. Live progress is a convenience and never ' +
        'replaces reading the run.',
    };
  }

  @Get()
  @RequirePermission({ module: 'agents', action: 'View' })
  async list(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Query() query: ListRunsDto,
  ): Promise<unknown> {
    await this.assertOnAgent(agentId, 'View');
    return this.engine.listForAgent({
      scope: this.tenantContext.requireScope(),
      engineAgentId: agentId,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  }

  @Get(':runId')
  @RequirePermission({ module: 'agents', action: 'View' })
  async view(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
  ): Promise<unknown> {
    await this.assertOnAgent(agentId, 'View');
    return this.engine.view({ scope: this.tenantContext.requireScope(), runId });
  }

  /** Run now. */
  @Post()
  @RequirePermission({ module: 'agents', action: 'Run' })
  async start(@Param('agentId', ParseUUIDPipe) agentId: string): Promise<unknown> {
    await this.assertOnAgent(agentId, 'Run');
    return this.engine.start({
      scope: this.tenantContext.requireScope(),
      engineAgentId: agentId,
      trigger: 'Manual',
      startedByUserId: this.currentUserId(),
    });
  }

  @Post(':runId/cancel')
  @RequirePermission({ module: 'agents', action: 'Pause' })
  async cancel(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() body: CancelRunDto,
  ): Promise<unknown> {
    await this.assertOnAgent(agentId, 'Pause');
    return this.engine.cancel({
      scope: this.tenantContext.requireScope(),
      runId,
      actorUserId: this.currentUserId(),
      reason: body.reason,
    });
  }

  @Post(':runId/resume')
  @RequirePermission({ module: 'agents', action: 'Pause' })
  async resume(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() body: ResumeRunDto,
  ): Promise<unknown> {
    await this.assertOnAgent(agentId, 'Pause');
    return this.engine.resume({
      scope: this.tenantContext.requireScope(),
      runId,
      note: body.note ?? 'Resumed by an operator.',
    });
  }

  /**
   * Run one scheduler tick for this company.
   *
   * Exposed because a timer is infrastructure and a company still needs to be able to say "catch
   * up now" — and because it makes the scheduler observable rather than a black box. Idempotent:
   * every occurrence is keyed by its due instant, so calling this twice starts nothing twice.
   */
  @Post('scheduler/tick')
  @RequirePermission({ module: 'agents', action: 'Schedule' })
  async tick(): Promise<unknown> {
    return this.scheduler.tick({ scope: this.tenantContext.requireScope() });
  }

  /**
   * The row-level check, delegated rather than reimplemented.
   *
   * `EngineAgentService.view` already asks the scope engine the right question — it hands over the
   * agent's owner *and* the department of the objectives it serves, which is what makes
   * `OwnWork`, `TeamSubtree` and `Department` mean what the role templates say.
   *
   * The first version of this method passed only `{ id: agentId }`. That is the third time in
   * this codebase that a resource has been handed over without every dimension the templates
   * scope by (S-165), and it fails the same way each time: a Department-scoped Head matches
   * nothing and the refusal looks like the agent does not exist. Calling the service that gets it
   * right is better than getting it right again here.
   */
  /**
   * May this person do this to this agent?
   *
   * ## Two ways in, and the second one is CR-03
   *
   * The original path decides visibility from ownership and department, which is right for the
   * people who *build* agents and wrong for the person one was built **for**. A manager builds
   * an agent for an employee, so `ownerUserId` is the manager, the employee is capped at
   * `OwnWork`, the owner path refuses — and the Run button the operator screen had just enabled
   * would answer 404. The gap was real: `assertMayRun` existed with no caller until this.
   *
   * A live `EngineAgentOperator` row is the record that this work was given to this person, so it
   * is a second way to *reach* the agent. It is not a second permission system: `mayRun` asks the
   * same `AuthorizationService` for `agents:Run` and for scope, and all the share does is make the
   * operator count as the owner of that one row for the scope question.
   *
   * ## What a share does not confer
   *
   * `Pause` stays with the owner and the department. Cancelling a run in flight is the authority
   * to stop somebody's work, and being handed a job to do is not being handed that.
   */
  private async assertOnAgent(agentId: string, action: 'View' | 'Run' | 'Pause'): Promise<void> {
    const scope = this.tenantContext.requireScope();
    const actorUserId = this.currentUserId();

    const shared =
      action === 'Pause' ? false : await this.operators.isOperator(scope, agentId, actorUserId);

    if (!shared) {
      // Throws 404 when this person may not see the agent at all.
      await this.agents.view({ scope, actorUserId, agentId });

      if (action === 'View') return;

      // Reading an agent is not the same as acting on it, so the stronger action is asked for
      // separately, against the same row.
      const context = await this.authorization.contextFor(scope, actorUserId);
      await this.authorization.assertCan(context, { module: 'agents', action });
      return;
    }

    if (action === 'Run') {
      // All seven preconditions, and the security event for an unshared attempt — which cannot
      // arise on this branch, but calling the throwing form is what keeps the answer the screen
      // was given and the answer the route enforces from ever drifting apart.
      await this.operators.assertMayRun({ scope, actorUserId, engineAgentId: agentId });
      return;
    }

    // Reading their own agent's runs. The module grant is still required: a share is not a grant.
    const context = await this.authorization.contextFor(scope, actorUserId);
    await this.authorization.assertCan(context, { module: 'agents', action: 'View' });
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified user.');
    }
    return userId;
  }
}
