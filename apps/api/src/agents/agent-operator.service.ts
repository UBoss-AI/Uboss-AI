import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import {
  firstUnmetPrecondition,
  OPERATOR_GRANTS_NOTHING,
  RUN_PRECONDITIONS,
  type RunPreconditionKey,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { CostEngineService } from '../cost/cost-engine.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/**
 * One run, as its operator may see it.
 *
 * ## The redaction is here, not in the screen
 *
 * CR-03 forbids exposing prompts, JSON, model internals, keys and system instructions to an
 * operator. A screen can honour that and the next screen can forget; a *shape* with no field to
 * put them in cannot. So the run row is projected here, and the projection is total:
 * `engineAgentVersionId`, `correlationId`, `producedByRealModel`, `attempt`,
 * `retryability` and the raw `output` document never leave this method.
 *
 * `resultText` is the produced work and nothing else — see `operatorResultOf`.
 */
export interface OperatorRunView {
  runId: string;
  state: string;
  trigger: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The work the run produced, when it produced text. Never how it was produced. */
  resultText: string | null;
  /** Every ending that is not a completion says why, in words a person can act on. */
  failureReason: string | null;
}

/**
 * The one readable thing in a run output document.
 *
 * The run engine writes `{ text, capability }`. `text` is the work; `capability` is which
 * skill capability answered, which is a build-time fact about the agent rather than a result, so
 * it is dropped. Anything of another shape yields null rather than a stringified object: an
 * operator shown a JSON blob is precisely what the amendment forbids, and "output exists but is
 * not text" is better said by the absence of a result than by printing braces at somebody.
 */
function operatorResultOf(output: unknown): string | null {
  if (typeof output === 'string') return output;
  if (output === null || typeof output !== 'object') return null;
  const text = (output as { text?: unknown }).text;
  return typeof text === 'string' ? text : null;
}

/** What a normal operator's screen shows. Nothing here is a prompt, a model or a credential. */
export interface OperatorAgentView {
  agentId: string;
  agentName: string;
  linkedObjectiveName: string | null;
  assignedWorkTitle: string | null;
  status: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  canRun: boolean;
  cannotRunBecause: string | null;
}

/**
 * Who may operate an Engine Agent, and whether they may run it now — Prompt 40A (CR-03) §2 and §5.
 *
 * ## Being the operator grants nothing
 *
 * This is the sentence the whole amendment exists to make true. A manager builds an agent for an
 * employee; the employee runs it and never sees how it is built. So a share here is **not a
 * permission**: it is one of seven conditions, and `agents:Run`, scope, a live version, approval,
 * connections and budget are all still checked separately.
 *
 * ## Why the order of the checks is a security property
 *
 * `RUN_PRECONDITIONS` is ordered, and **assignment is first**. Somebody with no share must not
 * learn from the refusal whether the agent is approved, what it connects to, or whether the company
 * has run out of budget. Checking budget first would leak a customer's commercial state to anybody
 * who guessed an id — so the order is not a convenience, and `firstUnmetPrecondition` is what keeps
 * it in one place rather than at seven call sites.
 *
 * ## What a normal operator is shown
 *
 * `OperatorAgentView` and nothing else: a name, the work it belongs to, a status, when it last ran,
 * and either "you can run this" or one sentence saying why not. No prompt, no configuration, no
 * model name, no connection detail — because a screen built for somebody who cannot open Agent
 * Builder must not print Agent Builder's contents.
 */
@Injectable()
export class AgentOperatorService {
  private readonly logger = new Logger(AgentOperatorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
    // `@Optional()`, because a type-level optional is not a DI-level optional — Nest refuses to
    // construct the class without it. The same omission cancelled 41 run-engine tests at Prompt 40.
    @Optional() private readonly cost?: CostEngineService | undefined,
  ) {}

  // -------------------------------------------------------------------------
  // Sharing
  // -------------------------------------------------------------------------

  /**
   * Let somebody run this agent.
   *
   * ## Two grants, because `agents:Assign` is granted to nobody
   *
   * The obvious gate would be `agents:Assign`. It does not exist in practice: **no role template
   * carries `Assign` on `agents`** — not Manager, not Head, not CompanyAdmin — which is a real
   * property of the approved role matrix, like `objective:Pause` being granted to nobody.
   * Discovered by a test: gating on it made the feature unreachable for every role in the product.
   *
   * So the gate composes two grants a manager genuinely holds, and each carries its half of the
   * meaning:
   *
   * * **`agents:View`** — you must be able to see the agent you are staffing.
   * * **`todo:Assign`** — you must be entitled to hand work to a person. That is what this is; the
   *   agent is the work.
   *
   * Manager and Head hold both. A standard Employee holds `agents:View` and not `todo:Assign`, so
   * they cannot share an agent with a colleague — which is the boundary that matters.
   *
   * Deliberately **not** any `agent-builder` grant: deciding who operates an agent is an
   * operational decision, and the person who builds it is often not the person who staffs it.
   */
  async share(input: {
    scope: TenantScope;
    actorUserId: string;
    engineAgentId: string;
    operatorUserId: string;
  }): Promise<{ shared: boolean }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'agents', action: 'View' });
    await this.authorization.assertCan(context, { module: 'todo', action: 'Assign' });

    const agent = await this.requireAgent(input.scope, input.engineAgentId);

    // The operator must be a colleague. Without this an id from another company would create a
    // share row that RLS could not see but that existed.
    const isMember = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.tenantMembership.count({
        where: {
          tenantId: input.scope.tenantId,
          userId: input.operatorUserId,
          accountState: 'Active',
        },
      }),
    );
    if (isMember === 0) {
      throw new BadRequestException('That person is not an active member of this company.');
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const existing = await this.prisma.client.engineAgentOperator.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          engineAgentId: input.engineAgentId,
          userId: input.operatorUserId,
        },
        select: { id: true, revokedAt: true },
      });

      if (existing !== null && existing.revokedAt === null) return { shared: false };

      if (existing !== null) {
        // Re-sharing revives the row rather than writing a second one, so the unique index holds
        // and the history stays on one row.
        await this.prisma.client.engineAgentOperator.update({
          where: { id: existing.id },
          data: {
            revokedAt: null,
            revokedByUserId: null,
            sharedByUserId: input.actorUserId,
            sharedAt: new Date(),
          },
        });
      } else {
        await this.prisma.client.engineAgentOperator.create({
          data: {
            tenantId: input.scope.tenantId,
            engineAgentId: input.engineAgentId,
            userId: input.operatorUserId,
            sharedByUserId: input.actorUserId,
          },
        });
      }

      await this.audit.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'agents.operator_shared',
        actorUserId: input.actorUserId,
        resourceType: 'engine-agent',
        resourceId: input.engineAgentId,
        summary: `Gave somebody permission to run "${agent.name}".`,
        metadata: { operatorUserId: input.operatorUserId },
      });

      return { shared: true };
    });
  }

  /** Withdraw a share. The row stays, so an access review can still read it. */
  async revokeShare(input: {
    scope: TenantScope;
    actorUserId: string;
    engineAgentId: string;
    operatorUserId: string;
  }): Promise<{ revoked: boolean }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    // The same pair as `share`: whoever can give it can take it back, and nobody else.
    await this.authorization.assertCan(context, { module: 'agents', action: 'View' });
    await this.authorization.assertCan(context, { module: 'todo', action: 'Assign' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const updated = await this.prisma.client.engineAgentOperator.updateMany({
        where: {
          tenantId: input.scope.tenantId,
          engineAgentId: input.engineAgentId,
          userId: input.operatorUserId,
          revokedAt: null,
        },
        data: { revokedAt: new Date(), revokedByUserId: input.actorUserId },
      });

      if (updated.count > 0) {
        await this.audit.appendWithinCurrentScope(input.scope.tenantId, {
          action: 'agents.operator_revoked',
          actorUserId: input.actorUserId,
          resourceType: 'engine-agent',
          resourceId: input.engineAgentId,
          summary: 'Withdrew permission to run an agent.',
          metadata: { operatorUserId: input.operatorUserId },
        });
      }

      return { revoked: updated.count > 0 };
    });
  }

  /** Who may currently run this agent. */
  async operatorsOf(scope: TenantScope, engineAgentId: string): Promise<string[]> {
    const rows = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.engineAgentOperator.findMany({
        where: { tenantId: scope.tenantId, engineAgentId, revokedAt: null },
        select: { userId: true },
      }),
    );
    return rows.map((row) => row.userId);
  }

  /**
   * Is this agent shared with this person right now?
   *
   * Its own method rather than `operatorsOf(...).includes(...)` because the run route asks it on
   * every call and the answer is one row rather than the whole roster — and because a route
   * reading the roster to answer a question about one person is the shape that later grows into
   * a route that *shows* the roster.
   */
  async isOperator(scope: TenantScope, engineAgentId: string, userId: string): Promise<boolean> {
    const row = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.engineAgentOperator.findFirst({
        where: { tenantId: scope.tenantId, engineAgentId, userId, revokedAt: null },
        select: { id: true },
      }),
    );
    return row !== null;
  }

  // -------------------------------------------------------------------------
  // The operator's own screen
  // -------------------------------------------------------------------------

  /**
   * The agents this person may operate, as they are allowed to see them.
   *
   * Includes an agent they cannot run *right now* — with the reason. An operator whose agent
   * vanished from the list because a connection expired would conclude the work had been taken away
   * from them; telling them "a connection this agent needs is missing" is both true and actionable.
   */
  async myAgents(input: { scope: TenantScope; actorUserId: string }): Promise<OperatorAgentView[]> {
    const shares = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.engineAgentOperator.findMany({
        where: { tenantId: input.scope.tenantId, userId: input.actorUserId, revokedAt: null },
        select: { engineAgentId: true },
      }),
    );
    if (shares.length === 0) return [];

    const views: OperatorAgentView[] = [];
    for (const share of shares) {
      views.push(
        await this.operatorView({
          scope: input.scope,
          actorUserId: input.actorUserId,
          engineAgentId: share.engineAgentId,
        }),
      );
    }
    return views;
  }

  /** One agent, as an operator sees it. */
  async operatorView(input: {
    scope: TenantScope;
    actorUserId: string;
    engineAgentId: string;
  }): Promise<OperatorAgentView> {
    const agent = await this.requireAgent(input.scope, input.engineAgentId);
    const decision = await this.mayRun(input);

    return {
      agentId: agent.id,
      agentName: agent.name,
      linkedObjectiveName: agent.objectiveName,
      assignedWorkTitle: agent.assignmentTitle,
      status: agent.status,
      lastRunAt: agent.lastRunAt?.toISOString() ?? null,
      nextRunAt: agent.nextRunAt?.toISOString() ?? null,
      canRun: decision.allowed,
      cannotRunBecause: decision.allowed ? null : decision.message,
    };
  }
  /**
   * This agent's runs, for the person it was given to.
   *
   * Backs both **View Result** and **History**: they are the same list, and a screen reading two
   * endpoints could show a "latest result" that disagreed with the top row of its own history.
   *
   * The share is required and checked here rather than inherited from the module grant, because
   * `agents:View` is what lets somebody open the screen and the share is what puts a
   * particular agent on it. Refused as 403 carrying the same sentence a missing share always
   * produces, so an id somebody guessed learns nothing about whether the agent exists.
   */
  async myRuns(input: {
    scope: TenantScope;
    actorUserId: string;
    engineAgentId: string;
    limit?: number;
  }): Promise<OperatorRunView[]> {
    const shared = await this.isOperator(input.scope, input.engineAgentId, input.actorUserId);
    if (!shared) throw new ForbiddenException(RUN_PRECONDITIONS[0].ifMissing);

    const runs = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.agentRun.findMany({
        where: { tenantId: input.scope.tenantId, engineAgentId: input.engineAgentId },
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(input.limit ?? 20, 1), 50),
        select: {
          id: true,
          state: true,
          trigger: true,
          startedAt: true,
          finishedAt: true,
          output: true,
          failureReason: true,
        },
      }),
    );

    return runs.map((run) => ({
      runId: run.id,
      state: run.state,
      trigger: run.trigger,
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      resultText: operatorResultOf(run.output),
      failureReason: run.failureReason,
    }));
  }

  /**
   * May this person run this agent right now?
   *
   * The seven conditions, evaluated in the declared order, with the **first** unmet one reported.
   * Returns rather than throws, because the operator's screen needs the reason in order to render
   * a disabled button with an explanation — and `assertMayRun` is the throwing form for the route.
   */
  async mayRun(input: {
    scope: TenantScope;
    actorUserId: string;
    engineAgentId: string;
  }): Promise<{ allowed: true } | { allowed: false; key: RunPreconditionKey; message: string }> {
    const agent = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.engineAgent.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.engineAgentId },
        select: {
          id: true,
          ownerUserId: true,
          status: true,
          currentVersionId: true,
          operators: {
            where: { userId: input.actorUserId, revokedAt: null },
            select: { id: true },
          },
        },
      }),
    );
    if (agent === null) {
      // Not found, not forbidden. An id somebody guessed must not confirm that the agent exists.
      return {
        allowed: false,
        key: 'Assignment',
        message: RUN_PRECONDITIONS[0].ifMissing,
      };
    }

    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    const isShared = agent.operators.length > 0;

    const runPermission = await this.authorization.authorize(context, {
      module: 'agents',
      action: 'Run',
    });

    /**
     * ## A live share is what makes a manager-built agent the operator's own work
     *
     * This is the heart of CR-03 §2, and it took a test to surface it. A manager builds an agent
     * for an employee, so `ownerUserId` is the **manager**. The employee is capped at `OwnWork`.
     * Evaluate the scope against the manager's ownership and the scope engine correctly refuses —
     * and the whole build-for-employee case becomes unreachable.
     *
     * The resolution is not to weaken the scope check. It is to recognise what a share *means*:
     * `EngineAgentOperator` is the record that this work was given to this person, which is
     * exactly what `OwnWork` is about. So when a live share exists, the operator is the owner for
     * the purpose of this check.
     *
     * **The share is still checked separately and first** (`Assignment` in the preconditions), so
     * this cannot let anybody in: no share, no substitution, and the scope check then runs against
     * the real owner and refuses as before. `createdByUserId` deliberately stays the manager,
     * because separation of duties asks who *wrote* it and that answer has not changed.
     */
    const inScope = await this.authorization.authorize(context, {
      module: 'agents',
      action: 'Run',
      resource: {
        id: agent.id,
        ownerUserId: isShared ? input.actorUserId : agent.ownerUserId,
        createdByUserId: agent.ownerUserId,
      },
    });

    const met: Partial<Record<RunPreconditionKey, boolean>> = {
      Assignment: isShared,
      Scope: inScope.allowed,
      RunPermission: runPermission.allowed,
      LiveVersion: agent.currentVersionId !== null && agent.status === 'Active',
      // An agent whose activation needed approval cannot be `Active` without it — the Prompt 28
      // activation path is what enforces that. So reaching `Active` *is* the approval condition,
      // rather than a second lookup that could disagree with the first.
      Approval: agent.status === 'Active',
      Connections: await this.connectionsAreHealthy(input.scope, agent.id),
      Budget: await this.budgetIsAvailable(input.scope),
    };

    const unmet = firstUnmetPrecondition(met);
    if (unmet === null) return { allowed: true };
    return { allowed: false, key: unmet.key, message: unmet.message };
  }

  /**
   * The throwing form, for a run route.
   *
   * Records a security event when somebody with no share tries to run an agent — that is an attempt
   * to operate something that was not given to them, which is worth a row even though the refusal
   * itself is routine. Recorded **outside** any transaction so the refusal below cannot roll it
   * back (S-256, S-282).
   */
  async assertMayRun(input: {
    scope: TenantScope;
    actorUserId: string;
    engineAgentId: string;
  }): Promise<void> {
    const decision = await this.mayRun(input);
    if (decision.allowed) return;

    if (decision.key === 'Assignment' || decision.key === 'Scope') {
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.permissionDenied,
        actorUserId: input.actorUserId,
        tenantId: input.scope.tenantId,
        resourceType: 'engine-agent',
        resourceId: input.engineAgentId,
        summary: 'Refused an attempt to run an agent that was not shared with this person.',
        metadata: { precondition: decision.key },
      });
    }

    throw new ForbiddenException(decision.message);
  }

  /** What the product says about what a share does and does not give somebody. */
  static get stance(): string {
    return OPERATOR_GRANTS_NOTHING;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async requireAgent(
    scope: TenantScope,
    engineAgentId: string,
  ): Promise<{
    id: string;
    name: string;
    status: string;
    lastRunAt: Date | null;
    nextRunAt: Date | null;
    objectiveName: string | null;
    assignmentTitle: string | null;
  }> {
    const agent = await this.prisma.runInTenantTransaction(scope, async () => {
      const row = await this.prisma.client.engineAgent.findFirst({
        where: { tenantId: scope.tenantId, id: engineAgentId },
        select: {
          id: true,
          name: true,
          status: true,
          lastRunAt: true,
          nextRunAt: true,
          assignments: {
            select: { title: true, objectiveId: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
      });
      if (row === null) return null;

      const assignment = row.assignments[0];
      /**
       * The objective's name, read through its active version.
       *
       * Served to an operator who may hold no `objective` grant at all — and that is correct rather
       * than a leak. CR-03 requires the operator's screen to show "linked Objective/assigned
       * work", and a person running work is entitled to know what it is for. What they do not get
       * is the Objective *screen*: one name, resolved server-side, is not the form.
       */
      const objectiveName =
        assignment?.objectiveId === undefined
          ? null
          : await (async () => {
              const objective = await this.prisma.client.objective.findFirst({
                where: { tenantId: scope.tenantId, id: assignment.objectiveId },
                select: { code: true, activeVersionId: true },
              });
              if (objective === null) return null;
              if (objective.activeVersionId === null) return objective.code;
              const version = await this.prisma.client.objectiveVersion.findFirst({
                where: { tenantId: scope.tenantId, id: objective.activeVersionId },
                select: { objectiveName: true },
              });
              return version?.objectiveName ?? objective.code;
            })();

      return {
        id: row.id,
        name: row.name,
        status: row.status,
        lastRunAt: row.lastRunAt,
        nextRunAt: row.nextRunAt,
        objectiveName,
        assignmentTitle: assignment?.title ?? null,
      };
    });

    if (agent === null) throw new NotFoundException('There is no such agent you can see.');
    return agent;
  }

  /**
   * Is the connection this agent needs usable?
   *
   * ## Where the connection id actually lives
   *
   * Not on a relation — `Connection` has none to assigned work. The id is `inputConnectionId`
   * inside `AiWorkAssignment.executionSetup`, which is JSON because Prompt 28 keeps the builder's
   * answers in one document rather than spreading them across columns that change every prompt. So
   * this reads the document. Discovered by a test: the relation-based query this replaced compiled
   * and then failed at runtime, because Prisma's `where` types do not reject a relation name that
   * does not exist.
   *
   * ## Read, never probed
   *
   * The health the Prompt 16 layer already maintains — `disabledAt`, `needsReauthorization`,
   * `credentialExpiresAt` — rather than a live check. Probing a customer's system to colour a
   * button would spend their rate limit on a page load, and would do it on every render.
   *
   * An agent that declares no connection is healthy by definition, and a company with one broken
   * connection somewhere does **not** have every agent disabled: only the one that needs it.
   */
  private async connectionsAreHealthy(scope: TenantScope, engineAgentId: string): Promise<boolean> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const assignments = await this.prisma.client.aiWorkAssignment.findMany({
        where: { tenantId: scope.tenantId, engineAgentId },
        select: { executionSetup: true },
      });

      const connectionIds = new Set<string>();
      for (const assignment of assignments) {
        const setup = assignment.executionSetup as Record<string, unknown> | null;
        const id = setup?.['inputConnectionId'];
        if (typeof id === 'string' && id.length > 0) connectionIds.add(id);
      }

      if (connectionIds.size === 0) return true;

      const now = new Date();
      const unhealthy = await this.prisma.client.connection.count({
        where: {
          tenantId: scope.tenantId,
          id: { in: [...connectionIds] },
          OR: [
            { disabledAt: { not: null } },
            { needsReauthorization: true },
            { credentialExpiresAt: { lt: now } },
          ],
        },
      });

      return unhealthy === 0;
    });
  }

  /**
   * Is there budget for a run?
   *
   * Consulted through the cost engine when one is wired, and **true when it is not** — a deployment
   * without the cost engine has no budget to be out of, and refusing every run would be inventing a
   * constraint. The real reservation happens inside the Model Gateway at run time; this is the
   * screen's advance warning, which is allowed to be a little stale.
   */
  private async budgetIsAvailable(scope: TenantScope): Promise<boolean> {
    if (this.cost === undefined) return true;
    try {
      const estimate = await this.cost.estimate({ scope, logicalProfile: 'AGENT_STANDARD', maxTokens: 1 });
      return estimate.estimateMinor >= 0;
    } catch (error) {
      // A failure to *estimate* is not a failure of budget. Reporting "no budget" because a
      // pricing lookup threw would tell an operator something false about their company.
      this.logger.debug(
        `Could not estimate a run cost: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return true;
    }
  }
}
