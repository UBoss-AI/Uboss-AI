import { Injectable } from '@nestjs/common';

import {
  emptyOrchestrationCounts,
  EXECUTION_STAGE_ORDER,
  executionStages,
  type ModuleKey,
  type OrchestrationCounts,
  type OrchestrationDepartmentRow,
  type OrchestrationStage,
  type OrchestrationStageRow,
  type OrchestrationView,
  type ReportScope,
  TERMINAL_EXCEPTION_STATES,
} from '@uboss/types';

import type { AuthorizationContext } from '../authorization/authorization.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { ReportScopeService } from './report-scope.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/**
 * The orchestration overview: where the company's work has actually got to.
 *
 * ## The question this answers, and why the tiles could not
 *
 * The dashboard tiles say how much of each thing exists. That is the right thing to land on, and
 * it is useless for the one decision an admin makes every morning — *what is stuck*. Engine,
 * Sub-Engine and Executor are positions in a sequence, so their numbers only mean anything beside
 * one another: sixty ready at Engine and nothing at Executor is a company that has not started,
 * and the reverse is one that is nearly finished. As seven separate tiles that reading disappears.
 *
 * ## `waiting` is the number this exists for
 *
 * Work that has an owner and cannot be started, because something before it is unfinished. Every
 * screen before this counted it as "not started", which hid the difference between a person who
 * has not begun and a person who is *not allowed* to begin. The second is a queue, and clearing a
 * queue is the admin's job rather than the employee's.
 *
 * ## Scope is the server's, and it is the same scope as everywhere else
 *
 * Human work is scoped by who it is assigned to, and agent work by the objective's accountable
 * owner — the rules the Tasks and Objectives tiles already use. Reusing them rather than inventing
 * a third is the point: a person who sees eleven tasks on one screen and nine on another will
 * trust neither, and would be right not to.
 *
 * Approvals and exceptions are returned only to somebody who may see those modules, and as `null`
 * rather than zero when they may not — zero is a fact about the company, and "not yours to see" is
 * a fact about the reader. Saying the second with the first is a lie that reads as good news.
 */
@Injectable()
export class OrchestrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: ReportScopeService,
  ) {}

  async overview(input: {
    scope: TenantScope;
    reportScope: ReportScope;
    context: AuthorizationContext;
    now: Date;
  }): Promise<OrchestrationView> {
    const tenantId = input.scope.tenantId;
    const maySee = (module: string): boolean =>
      input.context.visibleModules.includes(module as ModuleKey);

    /*
     * An empty scope means nobody, not everybody.
     *
     * The same rule the reports and the tiles apply. It is restated at the top of every entry
     * point because the failure it prevents — a resolved-to-nobody scope silently widening to the
     * whole company — is the one that would be hardest to notice and worst to have.
     */
    const noOne = input.reportScope.userIds !== null && input.reportScope.userIds.length === 0;
    if (noOne) {
      return {
        activeObjectives: 0,
        stages: EXECUTION_STAGE_ORDER.map((stage) => ({
          stage,
          human: emptyOrchestrationCounts(),
          agent: emptyOrchestrationCounts(),
        })),
        waitingOnDependency: 0,
        approvalsPending: maySee('approvals') ? 0 : null,
        exceptionsOpen: maySee('executor') ? 0 : null,
        overdue: 0,
        departments: [],
        covers: input.reportScope.description,
      };
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const humanWhere = ReportScopeService.userFilter(input.reportScope, 'assignedToUserId');
      // Agent work carries no assignee — an agent is not a person — so it is scoped by the
      // objective's accountable owner, which is the rule the Objectives tile already uses.
      const agentWhere =
        input.reportScope.userIds === null
          ? {}
          : { objective: { objectiveOwnerUserId: { in: [...input.reportScope.userIds] } } };

      const [tasks, aiWork, activeObjectives] = await Promise.all([
        this.prisma.client.humanTask.findMany({
          where: { tenantId, ...humanWhere },
          select: {
            nodeId: true,
            status: true,
            dueAt: true,
            objectiveVersionId: true,
            objective: { select: { departmentId: true } },
          },
        }),
        this.prisma.client.aiWorkAssignment.findMany({
          where: { tenantId, ...agentWhere },
          select: {
            nodeId: true,
            status: true,
            objectiveVersionId: true,
            objective: { select: { departmentId: true } },
            id: true,
          },
        }),
        this.prisma.client.objective.count({
          where: {
            tenantId,
            versions: { some: { status: { not: 'Archived' } } },
            ...(input.reportScope.userIds === null
              ? {}
              : { objectiveOwnerUserId: { in: [...input.reportScope.userIds] } }),
          },
        }),
      ]);

      /*
       * How far each piece of agent work actually got.
       *
       * The assignment does not say. `MappedToEngineAgent` means an agent exists to do this, not
       * that it has done it — the same distinction the work-release rule turns on, where an AI
       * step counts as finished only when a run completed rather than when one was mapped.
       * Reading the assignment alone would report every mapped step as finished the moment an
       * admin pressed Publish.
       *
       * Fetched as a separate query because `AgentRun` carries the assignment id as a column
       * without a declared relation, so there is nothing to include. Ordered oldest first and
       * overwritten, which leaves the newest run per assignment in the map.
       */
      const latestRun = new Map<string, string>();
      if (aiWork.length > 0) {
        const runs = await this.prisma.client.agentRun.findMany({
          where: { tenantId, aiWorkAssignmentId: { in: aiWork.map((row) => row.id) } },
          orderBy: { createdAt: 'asc' },
          select: { aiWorkAssignmentId: true, state: true },
        });
        for (const run of runs) {
          if (run.aiWorkAssignmentId !== null) latestRun.set(run.aiWorkAssignmentId, run.state);
        }
      }

      const stageOf = await this.stagesByVersion(tenantId, [
        ...new Set([
          ...tasks.map((row) => row.objectiveVersionId),
          ...aiWork.map((row) => row.objectiveVersionId),
        ]),
      ]);

      const rows: OrchestrationStageRow[] = EXECUTION_STAGE_ORDER.map((stage) => ({
        stage,
        human: emptyOrchestrationCounts(),
        agent: emptyOrchestrationCounts(),
      }));
      const rowFor = new Map(rows.map((row) => [row.stage, row]));

      let waitingOnDependency = 0;
      let overdue = 0;

      const byDepartment = new Map<string, { waiting: number; overdue: number; completed: number }>();
      const bump = (
        departmentId: string,
        field: 'waiting' | 'overdue' | 'completed',
      ): void => {
        const entry = byDepartment.get(departmentId) ?? { waiting: 0, overdue: 0, completed: 0 };
        entry[field] += 1;
        byDepartment.set(departmentId, entry);
      };

      for (const task of tasks) {
        const state = humanState(task.status);
        if (state === null) continue;

        const stage = stageOf.get(task.objectiveVersionId)?.get(task.nodeId);
        if (stage !== undefined) rowFor.get(stage)!.human[state] += 1;

        if (state === 'waiting') {
          waitingOnDependency += 1;
          bump(task.objective.departmentId, 'waiting');
        }
        if (state === 'completed') bump(task.objective.departmentId, 'completed');
        // Overdue is a due date in the past on work that is not finished. A completed task that
        // was late is a fact about the past; this number is about what needs attention now.
        if (
          state !== 'completed' &&
          task.dueAt !== null &&
          task.dueAt.getTime() < input.now.getTime()
        ) {
          overdue += 1;
          bump(task.objective.departmentId, 'overdue');
        }
      }

      for (const work of aiWork) {
        const state = agentState(work.status, latestRun.get(work.id) ?? null);
        if (state === null) continue;

        const stage = stageOf.get(work.objectiveVersionId)?.get(work.nodeId);
        if (stage !== undefined) rowFor.get(stage)!.agent[state] += 1;

        if (state === 'completed') bump(work.objective.departmentId, 'completed');
      }

      const departments = await this.departmentRows(tenantId, byDepartment, input.reportScope);

      return {
        activeObjectives,
        stages: rows,
        waitingOnDependency,
        approvalsPending: maySee('approvals')
          ? await this.prisma.client.approvalRequest.count({
              where: {
                tenantId,
                status: 'Pending',
                ...ReportScopeService.userFilter(input.reportScope, 'namedApproverUserId'),
              },
            })
          : null,
        exceptionsOpen: maySee('executor')
          ? await this.prisma.client.executorException.count({
              where: {
                tenantId,
                state: { notIn: [...TERMINAL_EXCEPTION_STATES] },
                ...ReportScopeService.userFilter(input.reportScope, 'ownerUserId'),
              },
            })
          : null,
        overdue,
        departments,
        covers: input.reportScope.description,
      };
    });
  }

  /**
   * Which stage each node of each plan belongs to.
   *
   * Derived from the dependency graph by `executionStages` rather than read from a label. A stored
   * label would be a second source of truth that could disagree with the dependencies, and then
   * the dashboard would report an Executor that three other steps are waiting on.
   *
   * A version whose draft is missing contributes nothing rather than defaulting to Engine: a step
   * counted at the wrong stage is worse than a step not counted, because the first is wrong and
   * looks right.
   */
  private async stagesByVersion(
    tenantId: string,
    versionIds: string[],
  ): Promise<Map<string, Map<string, OrchestrationStage>>> {
    if (versionIds.length === 0) return new Map();

    const drafts = await this.prisma.client.objectiveWorkflowDraft.findMany({
      where: { tenantId, objectiveVersionId: { in: versionIds } },
      select: { objectiveVersionId: true, graph: true },
    });

    const byVersion = new Map<string, Map<string, OrchestrationStage>>();
    for (const draft of drafts) {
      const graph = draft.graph as
        | { nodes?: { id: string; kind: string; dod?: { dependencies?: string[] } }[] }
        | null;
      const nodes = (graph?.nodes ?? []).map((node) => ({
        id: node.id,
        kind: node.kind,
        dod: { dependencies: node.dod?.dependencies ?? [] },
      }));
      byVersion.set(draft.objectiveVersionId, executionStages(nodes));
    }
    return byVersion;
  }

  /**
   * The departments, named, with the counts already gathered.
   *
   * Only departments that have work in this reader's scope appear. An empty row for every
   * department in the company would bury the three that need attention among forty that do not,
   * and would also quietly tell a manager how many departments exist.
   */
  private async departmentRows(
    tenantId: string,
    counts: Map<string, { waiting: number; overdue: number; completed: number }>,
    reportScope: ReportScope,
  ): Promise<OrchestrationDepartmentRow[]> {
    if (counts.size === 0) return [];

    const ids = [...counts.keys()];
    const [departments, objectives] = await Promise.all([
      this.prisma.client.department.findMany({
        where: { tenantId, id: { in: ids } },
        select: { id: true, name: true },
      }),
      this.prisma.client.objective.groupBy({
        by: ['departmentId'],
        where: {
          tenantId,
          departmentId: { in: ids },
          versions: { some: { status: { not: 'Archived' } } },
          ...(reportScope.userIds === null
            ? {}
            : { objectiveOwnerUserId: { in: [...reportScope.userIds] } }),
        },
        _count: { _all: true },
      }),
    ]);

    const activeByDepartment = new Map(
      objectives.map((row) => [row.departmentId, row._count._all]),
    );

    return departments
      .map((department) => {
        const entry = counts.get(department.id) ?? { waiting: 0, overdue: 0, completed: 0 };
        return {
          departmentId: department.id,
          name: department.name,
          activeObjectives: activeByDepartment.get(department.id) ?? 0,
          waiting: entry.waiting,
          overdue: entry.overdue,
          completed: entry.completed,
        };
      })
      // Whatever needs attention first: overdue, then queued, then the rest by name.
      .sort(
        (a, b) =>
          b.overdue - a.overdue || b.waiting - a.waiting || a.name.localeCompare(b.name),
      );
  }
}

/**
 * A human task's status, reduced to the four states the overview shows.
 *
 * `Cancelled` maps to nothing at all. It is neither outstanding nor achieved, and counting it as
 * completed would let somebody clear a backlog by cancelling it.
 */
function humanState(status: string): keyof OrchestrationCounts | null {
  switch (status) {
    // The only status that means "something before this is unfinished". The others below are all
    // about the person, and this one is about the plan.
    case 'Waiting':
      return 'waiting';
    case 'Assigned':
      return 'ready';
    /*
     * Started and not finished, whatever is holding it.
     *
     * `Blocked` deliberately does not count as `ready`. Ready is the column an admin reads as
     * "somebody could pick this up now", and a blocked task is one somebody already picked up and
     * could not finish. `NeedsInput` and `WaitingApproval` are the same shape: the work has
     * moved, and it is waiting on an answer rather than on a predecessor.
     */
    case 'InProgress':
    case 'Blocked':
    case 'NeedsInput':
    case 'WaitingApproval':
    case 'Submitted':
      return 'inProgress';
    case 'Completed':
      return 'completed';
    default:
      return null;
  }
}

/**
 * The same reduction for agent work.
 *
 * `AwaitingAgentSetup` is `waiting` because it is: the work exists and cannot run until somebody
 * finishes building the agent. Calling it "ready" would put it in the column an admin reads as
 * "somebody could start this now", and nobody could.
 */
function agentState(
  status: string,
  latestRun: string | null,
): keyof OrchestrationCounts | null {
  // Cancelled work is neither outstanding nor achieved. Counting it as completed would let
  // somebody clear a backlog by cancelling it.
  if (status === 'Cancelled') return null;

  /*
   * No agent yet, so nobody can start.
   *
   * `waiting` rather than `ready` because that is the truth: the step exists, it has a place in
   * the sequence, and the thing that would do it has not been built. Putting it in `ready` would
   * tell an admin that somebody could run it today.
   */
  if (status === 'AwaitingAgentSetup') return 'waiting';

  if (latestRun === null) return 'ready';
  switch (latestRun) {
    case 'Completed':
      return 'completed';
    // A failed or cancelled run leaves the step needing to be run again, which is exactly what
    // `ready` means here.
    case 'Failed':
    case 'Cancelled':
      return 'ready';
    default:
      return 'inProgress';
  }
}
