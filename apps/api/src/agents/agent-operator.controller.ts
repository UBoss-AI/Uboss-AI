import { Controller, Delete, Get, Param, Post, UnauthorizedException } from '@nestjs/common';

import { OPERATOR_GRANTS_NOTHING, RUN_PRECONDITIONS } from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { AgentOperatorService } from './agent-operator.service.js';

/**
 * OPERATIONS → Engine Agents, as an operator sees it — Prompt 40A (CR-03) §5.
 *
 * ## Why this is a separate controller from Agent Builder's
 *
 * Because the audience is different in exactly the way this amendment is about. Every route here is
 * gated on `agents:*` — the operations module a standard Employee holds — and **none** on
 * `agent-builder`, which they do not. A single controller serving both would mean one permission
 * change away from an operator reading a configuration screen.
 *
 * The share routes need `todo:Assign` here and `agents:View` as well in the service — two grants
 * rather than one, because **`agents:Assign` is granted to no role template at all**. Staffing an
 * agent is handing work to a person, which is what `todo:Assign` means, and Manager and Head hold
 * it while a standard Employee does not.
 */
@Controller('tenants/:tenantId/agents')
@TenantScoped()
export class AgentOperatorController {
  constructor(
    private readonly operators: AgentOperatorService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The seven conditions, and what a share does not give you.
   *
   * Served so a screen can explain a disabled Run button from the same list the server checks,
   * rather than from its own copy of the rules.
   */
  @Get('operator-meta')
  @RequirePermission({ module: 'agents', action: 'View' })
  async meta(): Promise<unknown> {
    return {
      runPreconditions: RUN_PRECONDITIONS.map((precondition) => ({
        key: precondition.key,
        label: precondition.label,
        ifMissing: precondition.ifMissing,
      })),
      // Served verbatim: it is the sentence the whole amendment exists to make true.
      operatorStance: OPERATOR_GRANTS_NOTHING,
    };
  }

  /**
   * "My Engine Agents" — the operator's list.
   *
   * `agents:View`, which a standard Employee holds. The list is confined to agents **shared with
   * them**, so the grant is what lets them see the screen and the share is what puts anything on
   * it.
   */
  @Get('mine')
  @RequirePermission({ module: 'agents', action: 'View' })
  async mine(): Promise<unknown> {
    return {
      agents: await this.operators.myAgents({
        scope: this.tenantContext.requireScope(),
        actorUserId: this.currentUserId(),
      }),
    };
  }

  /** One agent, as an operator sees it — including why they cannot run it, when they cannot. */
  @Get(':engineAgentId/operator-view')
  @RequirePermission({ module: 'agents', action: 'View' })
  async view(@Param('engineAgentId') engineAgentId: string): Promise<unknown> {
    return this.operators.operatorView({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      engineAgentId,
    });
  }

  /**
   * View Result and History, for the person the agent was given to.
   *
   * `agents:View` at the route and a live share in the service. The projection belongs to
   * the service method, so no field later added to `AgentRun` reaches an operator merely by
   * existing.
   */
  @Get(':engineAgentId/my-runs')
  @RequirePermission({ module: 'agents', action: 'View' })
  async myRuns(@Param('engineAgentId') engineAgentId: string): Promise<unknown> {
    return {
      runs: await this.operators.myRuns({
        scope: this.tenantContext.requireScope(),
        actorUserId: this.currentUserId(),
        engineAgentId,
      }),
    };
  }

  @Get(':engineAgentId/operators')
  @RequirePermission({ module: 'agents', action: 'View' })
  async list(@Param('engineAgentId') engineAgentId: string): Promise<unknown> {
    return {
      operatorUserIds: await this.operators.operatorsOf(
        this.tenantContext.requireScope(),
        engineAgentId,
      ),
    };
  }

  @Post(':engineAgentId/operators/:operatorUserId')
  // Two grants, checked in the service: `agents:View` and `todo:Assign`. The route-level
  // decorator is the coarser of the two, because `agents:Assign` is granted to no role at all.
  @RequirePermission({ module: 'todo', action: 'Assign' })
  async share(
    @Param('engineAgentId') engineAgentId: string,
    @Param('operatorUserId') operatorUserId: string,
  ): Promise<unknown> {
    return this.operators.share({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      engineAgentId,
      operatorUserId,
    });
  }

  @Delete(':engineAgentId/operators/:operatorUserId')
  // Two grants, checked in the service: `agents:View` and `todo:Assign`. The route-level
  // decorator is the coarser of the two, because `agents:Assign` is granted to no role at all.
  @RequirePermission({ module: 'todo', action: 'Assign' })
  async revoke(
    @Param('engineAgentId') engineAgentId: string,
    @Param('operatorUserId') operatorUserId: string,
  ): Promise<unknown> {
    return this.operators.revokeShare({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      engineAgentId,
      operatorUserId,
    });
  }

  private currentUserId(): string {
    const id = actorUserId(getActor());
    if (id === undefined || id === null) {
      throw new UnauthorizedException('This requires a signed-in member of the company.');
    }
    return id;
  }
}
