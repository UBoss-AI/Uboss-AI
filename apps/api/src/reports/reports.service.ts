import { Injectable } from '@nestjs/common';

import {
  isHumanTaskFinished,
  isRunFinished,
  OBJECTIVE_STATUS_LABELS,
  REPORT_ROW_LIMIT,
  type HumanTaskStatus,
  type ReportScope,
  type ReportWindow,
  type RunState,
} from '@uboss/types';

import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { BADGE_LEVEL_LABELS } from '../performance/performance.service.js';
import { ReportScopeService } from './report-scope.service.js';

/** The one currency a set of ledger entries is in, or nothing at all. See its use below. */
function currencyOf(entries: { currency: string }[]): { currency?: string } {
  const seen = new Set(entries.map((entry) => entry.currency));
  const only = [...seen][0];
  return seen.size === 1 && only !== undefined ? { currency: only } : {};
}

export interface ReportResult {
  /** The columns, in order. An export emits these and nothing else. */
  columns: string[];
  rows: Record<string, unknown>[];
  /** Figures shown above the table. Never the whole report. */
  summary: Record<string, number | string>;
  /** True when the row limit cut the answer short, so the screen can say so. */
  truncated: boolean;
}

/**
 * The ten reports — Prompt 37.
 *
 * ## Every method takes the scope; none of them resolves it
 *
 * `ReportScopeService` resolves it once, and each query applies it. That is deliberate: a service
 * where each method resolved its own scope is a service where nine methods do it right. Taking it
 * as a parameter means a report that forgot to filter would not compile.
 *
 * ## `scopeIsEmpty` is checked first, every time
 *
 * A manager with nobody reporting to them resolves to an empty user list, and every report must
 * then be **empty rather than unfiltered**. Prisma's `{ in: [] }` happens to do the right thing,
 * but relying on that is relying on a library's treatment of an edge case — so the check is
 * explicit and early.
 *
 * ## Why these are raw counts rather than a metrics layer
 *
 * There is no warehouse, no materialised view and no rollup table. Each report is a query against
 * the live tables, bounded by a window and a row limit. That is correct at this scale and honest
 * about what it is: `REPORT_ROW_LIMIT` and the range ceiling are what stop a report from scanning
 * everything a company has ever done, and both are stated to the reader rather than hidden.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // 1. Objective Progress / Outcome / SLA
  // -------------------------------------------------------------------------

  async objectiveProgress(input: {
    scope: TenantScope;
    reportScope: ReportScope;
    window: ReportWindow;
  }): Promise<ReportResult> {
    const columns = ['objective', 'status', 'owner', 'verdict', 'slaOutcome', 'closedAt'];
    if (ReportsService.empty(input.reportScope)) return ReportsService.none(columns);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const versions = await this.prisma.client.objectiveVersion.findMany({
        where: {
          tenantId: input.scope.tenantId,
          createdAt: { gte: input.window.from, lte: input.window.to },
          ...ReportScopeService.userFilter(input.reportScope, 'objectiveOwnerUserId'),
        },
        orderBy: [{ createdAt: 'desc' }],
        take: REPORT_ROW_LIMIT + 1,
        select: {
          id: true,
          // `objectiveName`, not `title`. Prisma's select types did not reject the wrong name and
          // tsc passed; the query threw the first time it ran.
          objectiveName: true,
          status: true,
          objectiveOwnerUserId: true,
          createdAt: true,
        },
      });

      const reviews = await this.prisma.client.objectiveOutcomeReview.findMany({
        where: {
          tenantId: input.scope.tenantId,
          objectiveVersionId: { in: versions.map((version) => version.id) },
        },
        select: {
          objectiveVersionId: true,
          verdict: true,
          slaOutcome: true,
          closedAt: true,
        },
      });
      const byVersion = new Map(reviews.map((review) => [review.objectiveVersionId, review]));

      /*
       * The owners, by name.
       *
       * This column printed a raw user id — `01a0a903-683d-7229-…` — in every row, which is not
       * an owner in any sense a reader can use: you cannot recognise a colleague by it, you
       * cannot sort a list by it, and an exported CSV of them is a spreadsheet nobody can act on.
       * The dependency report already resolves names this way; this one had been left behind.
       */
      const ownerName = await this.names(
        versions
          .map((version) => version.objectiveOwnerUserId)
          .filter((id): id is string => id !== null),
      );

      const rows = versions.slice(0, REPORT_ROW_LIMIT).map((version) => {
        const review = byVersion.get(version.id);
        return {
          objective: version.objectiveName,
          /*
           * The name the rest of the product uses for this status.
           *
           * The stored value is `AiAnalysis`, `WorkflowDraft`, `ReadyForApproval` — identifiers,
           * and they were going straight onto the chart legend and into the exported CSV. A
           * manager reading their own report saw "AiAnalysis", which is not a word, while the
           * Objectives screen beside it called the same state "AI Analysis".
           *
           * Mapped here rather than on the screen so the export says it too: a spreadsheet handed
           * to somebody outside the product has no label map to consult.
           */
          status: OBJECTIVE_STATUS_LABELS[version.status] ?? version.status,
          // An em dash for somebody who has left, rather than an id nobody can look up.
          owner:
            version.objectiveOwnerUserId === null
              ? '—'
              : (ownerName.get(version.objectiveOwnerUserId) ?? '—'),
          verdict: review?.verdict ?? '—',
          slaOutcome: review?.slaOutcome ?? '—',
          closedAt: review?.closedAt?.toISOString() ?? '—',
        };
      });

      return {
        columns,
        rows,
        summary: {
          objectives: rows.length,
          reviewed: rows.filter((row) => row.verdict !== '—').length,
          met: rows.filter((row) => row.verdict === 'Met').length,
          onTime: rows.filter((row) => row.slaOutcome === 'OnTime').length,
        },
        truncated: versions.length > REPORT_ROW_LIMIT,
      };
    });
  }

  // -------------------------------------------------------------------------
  // 2. Human vs AI Work Mix
  // -------------------------------------------------------------------------

  /**
   * How much work people did and how much agents did.
   *
   * **Counts of pieces of work, not hours or cost.** Prompt 34 established that "human effort"
   * cannot be measured — only elapsed time — so a mix expressed in hours would be comparing a
   * measured number with an unmeasurable one. Two counts is the honest comparison.
   */
  /**
   * What cannot start yet, and what it is waiting for.
   *
   * ## Why this report exists
   *
   * Since the sequence became real, a step whose dependencies are unfinished is `Waiting` and its
   * owner cannot start it. That is correct and it is also invisible: from the outside, an objective
   * with four waiting steps looks exactly like an objective nobody has got round to. This says
   * which it is.
   *
   * ## No window
   *
   * Every other report here is bounded by a reporting window, because it is about what happened.
   * This one is about what is true now — a step that has been waiting since last month is the most
   * interesting row in it, and a window would hide it.
   */
  async dependencyWaiting(input: {
    scope: TenantScope;
    reportScope: ReportScope;
  }): Promise<ReportResult> {
    const columns = ['objective', 'step', 'owner', 'waitingOn', 'waitingSince'];
    if (ReportsService.empty(input.reportScope)) return ReportsService.none(columns);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const waiting = await this.prisma.client.humanTask.findMany({
        where: {
          tenantId: input.scope.tenantId,
          status: 'Waiting',
          ...ReportScopeService.userFilter(input.reportScope, 'assignedToUserId'),
        },
        select: {
          id: true,
          title: true,
          createdAt: true,
          dependsOnNodeIds: true,
          objectiveVersionId: true,
          assignedToUserId: true,
          objective: { select: { code: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: REPORT_ROW_LIMIT,
      });

      if (waiting.length === 0) return ReportsService.none(columns);

      /*
       * The steps they are waiting on, by name.
       *
       * Node ids are what the plan stores and they name nothing a person has seen, so they are
       * resolved against the work items in the same versions. A dependency whose node produced no
       * work item is left out rather than printed as an id: it is not what the step is really
       * waiting for.
       */
      const versionIds = [...new Set(waiting.map((row) => row.objectiveVersionId))];
      const [siblingTasks, siblingAi] = [
        await this.prisma.client.humanTask.findMany({
          where: { tenantId: input.scope.tenantId, objectiveVersionId: { in: versionIds } },
          select: { nodeId: true, title: true, status: true, assignedToUserId: true },
        }),
        await this.prisma.client.aiWorkAssignment.findMany({
          where: { tenantId: input.scope.tenantId, objectiveVersionId: { in: versionIds } },
          select: { nodeId: true, title: true, status: true },
        }),
      ];

      const unfinished = new Map<string, string>();
      for (const row of siblingTasks) {
        if (row.status !== 'Completed' && row.status !== 'Cancelled') {
          unfinished.set(row.nodeId, row.title);
        }
      }
      for (const row of siblingAi) {
        // Work with no node is in no workflow, so nothing is waiting on it.
        if (row.status !== 'Cancelled' && row.nodeId !== null) {
          unfinished.set(row.nodeId, row.title);
        }
      }

      const people = await this.prisma.client.user.findMany({
        where: { id: { in: [...new Set(waiting.map((row) => row.assignedToUserId))] } },
        select: { id: true, displayName: true },
      });
      const nameOf = new Map(people.map((row) => [row.id, row.displayName]));

      const rows = waiting.map((row) => ({
        objective: row.objective.code,
        step: row.title,
        owner: nameOf.get(row.assignedToUserId) ?? '—',
        waitingOn:
          row.dependsOnNodeIds
            .map((nodeId) => unfinished.get(nodeId))
            .filter((title): title is string => title !== undefined)
            .join(', ') || '—',
        waitingSince: row.createdAt.toISOString(),
      }));

      const oldest = rows.reduce<string | null>(
        (earliest, row) =>
          earliest === null || row.waitingSince < earliest ? row.waitingSince : earliest,
        null,
      );

      return {
        columns,
        rows,
        summary: {
          waiting: rows.length,
          objectives: new Set(rows.map((row) => row.objective)).size,
          // The one number worth leading with: a step waiting since last month is a stalled
          // objective, and a count alone would not say so.
          oldestWaitingSince: oldest ?? '—',
        },
        truncated: waiting.length >= REPORT_ROW_LIMIT,
        note:
          'Steps the product is holding because the plan says something else comes first. ' +
          'Nobody can start these, and that is the product working rather than a person delaying.',
      };
    });
  }

  async humanVsAiWorkMix(input: {
    scope: TenantScope;
    reportScope: ReportScope;
    window: ReportWindow;
  }): Promise<ReportResult> {
    const columns = ['kind', 'completed', 'failed', 'inFlight'];
    if (ReportsService.empty(input.reportScope)) return ReportsService.none(columns);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const tasks = await this.prisma.client.humanTask.groupBy({
        by: ['status'],
        where: {
          tenantId: input.scope.tenantId,
          createdAt: { gte: input.window.from, lte: input.window.to },
          ...ReportScopeService.userFilter(input.reportScope, 'assignedToUserId'),
        },
        _count: { _all: true },
      });

      // Agent runs carry no assignee, so a scoped mix counts the runs for objectives this person
      // may see rather than pretending a run belongs to somebody. When the scope is unrestricted
      // the objective filter is dropped entirely.
      const objectiveIds =
        input.reportScope.userIds === null
          ? null
          : (
              await this.prisma.client.objectiveVersion.findMany({
                where: {
                  tenantId: input.scope.tenantId,
                  objectiveOwnerUserId: { in: [...input.reportScope.userIds] },
                },
                select: { objectiveId: true },
              })
            ).map((version) => version.objectiveId);

      const runs = await this.prisma.client.agentRun.groupBy({
        by: ['state'],
        where: {
          tenantId: input.scope.tenantId,
          createdAt: { gte: input.window.from, lte: input.window.to },
          ...(objectiveIds === null ? {} : { objectiveId: { in: objectiveIds } }),
        },
        _count: { _all: true },
      });

      const countOf = (
        groups: { _count: { _all: number } }[],
        predicate: (group: never) => boolean,
      ): number =>
        groups
          .filter(predicate as (group: unknown) => boolean)
          .reduce((total, group) => total + group._count._all, 0);

      /*
       * Counted against the real vocabularies, not against words that were never in them.
       *
       * `Succeeded` and `DeadLettered` are not run states — `Succeeded` is a *security event*
       * outcome and `DeadLettered` exists nowhere — so this row reported every AI run as in flight
       * and its completed count as zero, always. The states are now asked of `RUN_STATES`' own
       * terminal set, and `isHumanTaskFinished` answers the same question on the other row, so
       * neither can drift from the vocabulary again.
       *
       * A cancelled item is in none of the three columns on purpose: it was not completed, it did
       * not fail, and it is certainly not still running. The columns are the client's; inventing a
       * fourth here would be a reporting decision, and quietly filing cancellations under
       * "failed" would be a false one.
       */
      const humanCompleted = countOf(
        tasks,
        ((group: { status: string }) => group.status === 'Completed') as never,
      );
      const humanFailed = countOf(
        tasks,
        ((group: { status: string }) => group.status === 'Blocked') as never,
      );
      const humanInFlight = countOf(
        tasks,
        ((group: { status: string }) =>
          !isHumanTaskFinished(group.status as HumanTaskStatus) &&
          group.status !== 'Blocked') as never,
      );

      const aiCompleted = countOf(
        runs,
        ((group: { state: string }) => group.state === 'Completed') as never,
      );
      const aiFailed = countOf(
        runs,
        ((group: { state: string }) => group.state === 'Failed') as never,
      );
      const aiInFlight = countOf(
        runs,
        ((group: { state: string }) => !isRunFinished(group.state as RunState)) as never,
      );

      const rows = [
        { kind: 'Human', completed: humanCompleted, failed: humanFailed, inFlight: humanInFlight },
        { kind: 'AI', completed: aiCompleted, failed: aiFailed, inFlight: aiInFlight },
      ];

      const totalCompleted = humanCompleted + aiCompleted;

      return {
        columns,
        rows,
        summary: {
          humanCompleted,
          aiCompleted,
          // Guarded: a company with no completed work in the window is not 0% or NaN, it is "no
          // work yet", and a percentage there would be a made-up number.
          aiSharePercent:
            totalCompleted === 0 ? '—' : `${Math.round((aiCompleted / totalCompleted) * 100)}%`,
        },
        truncated: false,
      };
    });
  }

  // -------------------------------------------------------------------------
  // 3. Employee Workload
  // -------------------------------------------------------------------------

  async employeeWorkload(input: {
    scope: TenantScope;
    reportScope: ReportScope;
    window: ReportWindow;
    now: Date;
  }): Promise<ReportResult> {
    const columns = ['person', 'open', 'overdue', 'completed'];
    if (ReportsService.empty(input.reportScope)) return ReportsService.none(columns);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const tasks = await this.prisma.client.humanTask.findMany({
        where: {
          tenantId: input.scope.tenantId,
          createdAt: { gte: input.window.from, lte: input.window.to },
          ...ReportScopeService.userFilter(input.reportScope, 'assignedToUserId'),
        },
        select: {
          assignedToUserId: true,
          status: true,
          dueAt: true,
        },
        take: 5000,
      });

      const byUser = new Map<string, { open: number; overdue: number; completed: number }>();
      for (const task of tasks) {
        const entry = byUser.get(task.assignedToUserId) ?? { open: 0, overdue: 0, completed: 0 };
        if (task.status === 'Completed') {
          entry.completed += 1;
        } else {
          entry.open += 1;
          if (task.dueAt !== null && task.dueAt.getTime() < input.now.getTime()) {
            entry.overdue += 1;
          }
        }
        byUser.set(task.assignedToUserId, entry);
      }

      /*
       * Who, by name.
       *
       * A workload report exists to be looked at and acted on — this person has fourteen open
       * items, go and help them. A column of identifiers cannot be acted on, and it cannot be
       * charted either: the bar labels would be forty hex characters apiece.
       */
      const names = await this.names([...byUser.keys()]);

      const rows = [...byUser.entries()]
        .map(([userId, counts]) => ({ person: names.get(userId) ?? '—', ...counts }))
        .sort((left, right) => right.open - left.open)
        .slice(0, REPORT_ROW_LIMIT);

      return {
        columns,
        rows,
        summary: {
          people: rows.length,
          open: rows.reduce((total, row) => total + row.open, 0),
          overdue: rows.reduce((total, row) => total + row.overdue, 0),
        },
        truncated: byUser.size > REPORT_ROW_LIMIT,
      };
    });
  }

  // -------------------------------------------------------------------------
  // 4. Engine Agent Health
  // -------------------------------------------------------------------------

  async engineAgentHealth(input: {
    scope: TenantScope;
    reportScope: ReportScope;
    window: ReportWindow;
  }): Promise<ReportResult> {
    const columns = ['agent', 'status', 'runs', 'succeeded', 'failed', 'lastRunAt'];
    if (ReportsService.empty(input.reportScope)) return ReportsService.none(columns);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const agents = await this.prisma.client.engineAgent.findMany({
        where: {
          tenantId: input.scope.tenantId,
          ...ReportScopeService.userFilter(input.reportScope, 'ownerUserId'),
        },
        select: { id: true, name: true, status: true },
        take: REPORT_ROW_LIMIT + 1,
      });

      const runs = await this.prisma.client.agentRun.findMany({
        where: {
          tenantId: input.scope.tenantId,
          engineAgentId: { in: agents.map((agent) => agent.id) },
          createdAt: { gte: input.window.from, lte: input.window.to },
        },
        select: { engineAgentId: true, state: true, finishedAt: true },
      });

      const rows = agents.slice(0, REPORT_ROW_LIMIT).map((agent) => {
        const mine = runs.filter((run) => run.engineAgentId === agent.id);
        const last = mine
          .map((run) => run.finishedAt)
          .filter((at): at is Date => at !== null)
          .sort((left, right) => right.getTime() - left.getTime())[0];

        return {
          agent: agent.name,
          status: agent.status,
          runs: mine.length,
          succeeded: mine.filter((run) => run.state === 'Succeeded').length,
          failed: mine.filter((run) => run.state === 'Failed' || run.state === 'DeadLettered')
            .length,
          // An agent with no runs in the window is the finding, not a gap — "which agents have
          // stopped being used" is half of what this report is for.
          lastRunAt: last?.toISOString() ?? 'never in this window',
        };
      });

      return {
        columns,
        rows,
        summary: {
          agents: rows.length,
          unused: rows.filter((row) => row.runs === 0).length,
          failing: rows.filter((row) => row.failed > 0).length,
        },
        truncated: agents.length > REPORT_ROW_LIMIT,
      };
    });
  }

  // -------------------------------------------------------------------------
  // 5. Skill Usage & Quality
  // -------------------------------------------------------------------------

  /**
   * Which Skills exist and how their evaluations are going.
   *
   * Unscoped by the reporting tree, and that is in the report definition rather than an oversight:
   * a Skill is a company-wide governed capability, not somebody's work. It is still gated on
   * `agents:View`.
   *
   * ## Why this measures evaluations rather than reviewer feedback
   *
   * `ai_output_feedback` is recorded against a **run**, not a Skill version — which is correct,
   * because a reviewer judges what an agent produced rather than a Skill in the abstract. There is
   * no column to join on, and attributing feedback to a Skill would mean walking run → agent
   * version → `config.skillVersionIds`, a JSON array.
   *
   * So the quality signal here is pass/fail against each Skill version's own evaluation cases,
   * which the schema *can* attribute. That is arguably the better measure and certainly the honest
   * one. Reviewer sentiment per Skill is a real gap and is recorded as one.
   */
  async skillUsageAndQuality(input: {
    scope: TenantScope;
    window: ReportWindow;
  }): Promise<ReportResult> {
    const columns = ['skill', 'version', 'status', 'evaluations', 'passed', 'failed'];

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const versions = await this.prisma.client.skillVersion.findMany({
        where: { tenantId: input.scope.tenantId },
        select: {
          id: true,
          versionNumber: true,
          status: true,
          skill: { select: { name: true } },
        },
        orderBy: [{ createdAt: 'desc' }],
        take: REPORT_ROW_LIMIT + 1,
      });

      // Evaluation runs, which are the only thing in the schema attributable to a Skill version —
      // see the doc comment on why reviewer feedback is not.
      const evaluations = await this.prisma.client.skillEvaluationRun.findMany({
        where: {
          tenantId: input.scope.tenantId,
          // `runAt`, not `createdAt`. An evaluation run's own timestamp column.
          runAt: { gte: input.window.from, lte: input.window.to },
        },
        select: { skillVersionId: true, passed: true },
      });

      const rows = versions.slice(0, REPORT_ROW_LIMIT).map((version) => {
        const mine = evaluations.filter((entry) => entry.skillVersionId === version.id);
        return {
          skill: version.skill.name,
          version: version.versionNumber,
          status: version.status,
          evaluations: mine.length,
          passed: mine.filter((entry) => entry.passed === true).length,
          // `null` is "not judged yet", which is neither a pass nor a failure. Counting it as a
          // failure would make an unevaluated Skill look broken.
          failed: mine.filter((entry) => entry.passed === false).length,
        };
      });

      return {
        columns,
        rows,
        summary: {
          skillVersions: rows.length,
          evaluated: rows.filter((row) => row.evaluations > 0).length,
          failing: rows.filter((row) => row.failed > 0).length,
        },
        truncated: versions.length > REPORT_ROW_LIMIT,
      };
    });
  }

  // -------------------------------------------------------------------------
  // 6. Executor Agent Exceptions
  // -------------------------------------------------------------------------

  async executorExceptions(input: {
    scope: TenantScope;
    reportScope: ReportScope;
    window: ReportWindow;
  }): Promise<ReportResult> {
    const columns = ['kind', 'severity', 'state', 'owner', 'openedAt', 'closedAt'];
    if (ReportsService.empty(input.reportScope)) return ReportsService.none(columns);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const exceptions = await this.prisma.client.executorException.findMany({
        where: {
          tenantId: input.scope.tenantId,
          openedAt: { gte: input.window.from, lte: input.window.to },
          // An unowned exception is visible only to an unrestricted scope: it belongs to nobody,
          // so no scoped reader has a claim on it, and showing it to everybody would leak what
          // the Executor found in work they cannot see.
          ...(input.reportScope.userIds === null
            ? {}
            : { ownerUserId: { in: [...input.reportScope.userIds] } }),
        },
        orderBy: [{ openedAt: 'desc' }],
        take: REPORT_ROW_LIMIT + 1,
        select: {
          kind: true,
          severity: true,
          state: true,
          ownerUserId: true,
          openedAt: true,
          closedAt: true,
        },
      });

      /*
       * The owner, by name — and "unassigned" when there is nobody.
       *
       * The two are different answers and both matter: an exception nobody owns is the one that
       * sits open, and an exception owned by `0199f3c2-…` is one nobody can chase. The identifier
       * was what this column printed.
       */
      const owners = await this.names(
        exceptions
          .map((exception) => exception.ownerUserId)
          .filter((id): id is string => id !== null),
      );

      const rows = exceptions.slice(0, REPORT_ROW_LIMIT).map((exception) => ({
        kind: exception.kind,
        severity: exception.severity,
        state: exception.state,
        owner:
          exception.ownerUserId === null
            ? 'unassigned'
            : (owners.get(exception.ownerUserId) ?? '—'),
        openedAt: exception.openedAt.toISOString(),
        closedAt: exception.closedAt?.toISOString() ?? '—',
      }));

      return {
        columns,
        rows,
        summary: {
          exceptions: rows.length,
          stillOpen: rows.filter((row) => row.closedAt === '—').length,
        },
        truncated: exceptions.length > REPORT_ROW_LIMIT,
      };
    });
  }

  // -------------------------------------------------------------------------
  // 7. Approval Aging
  // -------------------------------------------------------------------------

  async approvalAging(input: {
    scope: TenantScope;
    reportScope: ReportScope;
    window: ReportWindow;
    now: Date;
  }): Promise<ReportResult> {
    const columns = ['title', 'type', 'status', 'requestedBy', 'waitingDays', 'dueAt'];
    if (ReportsService.empty(input.reportScope)) return ReportsService.none(columns);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const requests = await this.prisma.client.approvalRequest.findMany({
        where: {
          tenantId: input.scope.tenantId,
          createdAt: { gte: input.window.from, lte: input.window.to },
          ...ReportScopeService.userFilter(input.reportScope, 'requestedByUserId'),
        },
        orderBy: [{ createdAt: 'asc' }],
        take: REPORT_ROW_LIMIT + 1,
        select: {
          title: true,
          type: true,
          status: true,
          requestedByUserId: true,
          createdAt: true,
          decidedAt: true,
          dueAt: true,
        },
      });

      /*
       * Who asked, by name.
       *
       * This column printed a raw identifier — `0199f3c2-4a8e-7...` — in the "Requested by" column
       * of a report an approver reads to decide whose sign-off to chase. Two other reports already
       * resolved their people and this one was missed, so the same helper does it here: one query
       * for the whole page, inside the transaction the report already opened.
       */
      const askedBy = await this.names(requests.map((requestRow) => requestRow.requestedByUserId));

      const rows = requests.slice(0, REPORT_ROW_LIMIT).map((requestRow) => {
        // Aging stops at the decision. A decided request that keeps ageing would make the oldest
        // rows the ones somebody already dealt with.
        const until = requestRow.decidedAt ?? input.now;
        return {
          title: requestRow.title,
          type: requestRow.type,
          status: requestRow.status,
          requestedBy: askedBy.get(requestRow.requestedByUserId) ?? '—',
          waitingDays: Math.floor((until.getTime() - requestRow.createdAt.getTime()) / 86_400_000),
          dueAt: requestRow.dueAt?.toISOString() ?? '—',
        };
      });

      const pending = rows.filter((row) => row.status === 'Pending');

      return {
        columns,
        rows,
        summary: {
          requests: rows.length,
          pending: pending.length,
          oldestPendingDays: pending.reduce((worst, row) => Math.max(worst, row.waitingDays), 0),
        },
        truncated: requests.length > REPORT_ROW_LIMIT,
      };
    });
  }

  // -------------------------------------------------------------------------
  // 8. AI Usage & Cost
  // -------------------------------------------------------------------------

  /**
   * What AI work cost.
   *
   * **Settled entries only.** A reservation is money set aside, not money spent, and a cost report
   * that counted reservations would overstate every figure and then quietly correct itself when
   * the unused part was released. The same rule the Prompt 34 objective comparison applies.
   */
  async aiUsageAndCost(input: { scope: TenantScope; window: ReportWindow }): Promise<ReportResult> {
    const columns = ['day', 'entries', 'amountMinor', 'inputTokens', 'outputTokens'];

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const entries = await this.prisma.client.costLedgerEntry.findMany({
        where: {
          tenantId: input.scope.tenantId,
          // `Settle` is the ledger's own kind for money actually spent. `Reserve` is money set
          // aside, and counting it would overstate every figure and then quietly correct itself.
          kind: 'Settle',
          occurredAt: { gte: input.window.from, lte: input.window.to },
        },
        select: {
          occurredAt: true,
          amountMinor: true,
          inputTokens: true,
          outputTokens: true,
          // Carried so the figures can be rendered as money rather than as a bare integer of
          // minor units. A chart of cost with no currency on it is a chart of nothing.
          currency: true,
        },
        take: 20_000,
      });

      const byDay = new Map<
        string,
        { entries: number; amountMinor: number; inputTokens: number; outputTokens: number }
      >();

      for (const entry of entries) {
        const day = entry.occurredAt.toISOString().slice(0, 10);
        const bucket = byDay.get(day) ?? {
          entries: 0,
          amountMinor: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
        bucket.entries += 1;
        bucket.amountMinor += entry.amountMinor;
        bucket.inputTokens += entry.inputTokens ?? 0;
        bucket.outputTokens += entry.outputTokens ?? 0;
        byDay.set(day, bucket);
      }

      const rows = [...byDay.entries()]
        .map(([day, bucket]) => ({ day, ...bucket }))
        .sort((left, right) => left.day.localeCompare(right.day));

      return {
        columns,
        rows,
        summary: {
          days: rows.length,
          // Minor units throughout, as everywhere else in this product. A report that divided by
          // 100 here would be the one place money is a float.
          totalMinor: rows.reduce((total, row) => total + row.amountMinor, 0),
          totalTokens: rows.reduce((total, row) => total + row.inputTokens + row.outputTokens, 0),
          /*
           * The currency these amounts are in, when there is exactly one.
           *
           * A company is denominated in a single currency, so in practice there always is. On the
           * chance a period ever held two, the key is left out altogether and the screen prints
           * the numbers bare — where labelling a mixed total with one of its currencies would be
           * a figure that is simply wrong.
           */
          ...currencyOf(entries),
        },
        truncated: entries.length >= 20_000,
      };
    });
  }

  // -------------------------------------------------------------------------
  // 9. Audit Activity
  // -------------------------------------------------------------------------

  async auditActivity(input: { scope: TenantScope; window: ReportWindow }): Promise<ReportResult> {
    const columns = ['action', 'resourceType', 'events', 'lastAt'];

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const events = await this.prisma.client.auditEvent.findMany({
        where: {
          tenantId: input.scope.tenantId,
          occurredAt: { gte: input.window.from, lte: input.window.to },
        },
        select: { action: true, resourceType: true, occurredAt: true },
        take: 20_000,
      });

      const byAction = new Map<string, { events: number; lastAt: Date; resourceType: string }>();
      for (const event of events) {
        const key = `${event.action}|${event.resourceType}`;
        const bucket = byAction.get(key);
        if (bucket === undefined) {
          byAction.set(key, {
            events: 1,
            lastAt: event.occurredAt,
            resourceType: event.resourceType,
          });
        } else {
          bucket.events += 1;
          if (event.occurredAt > bucket.lastAt) bucket.lastAt = event.occurredAt;
        }
      }

      const rows = [...byAction.entries()]
        .map(([key, bucket]) => ({
          action: key.split('|')[0] ?? key,
          resourceType: bucket.resourceType,
          events: bucket.events,
          lastAt: bucket.lastAt.toISOString(),
        }))
        .sort((left, right) => right.events - left.events)
        .slice(0, REPORT_ROW_LIMIT);

      return {
        columns,
        rows,
        summary: { distinctActions: rows.length, events: events.length },
        truncated: events.length >= 20_000,
      };
    });
  }

  // -------------------------------------------------------------------------
  // 10. Performance / Badge History
  // -------------------------------------------------------------------------

  /**
   * How many agent runs happened each day.
   *
   * ## The question this answers
   *
   * Not *what is running now* — the dashboard answers that — and not *how has this one agent
   * done*, which Engine Agent Health answers. This is the shape of the company's AI work over
   * time: is the product doing more for us this month than last. It is the first figure asked for
   * after a demo and the last one looked at before a renewal.
   *
   * ## Why the total is every run, whatever it ended as
   *
   * A day with forty runs of which ten failed is a busy day with a problem, not a quiet day. The
   * line is the volume; the columns beside it carry the split, so the number is never a total
   * with nothing behind it. Splitting the line itself would answer the health question badly when
   * another report answers it properly.
   *
   * ## Why days with nothing are not filled in
   *
   * Because a zero this report invented is indistinguishable from a zero it measured, and a line
   * that drops to the axis on a day the company was closed reads as a collapse. Days with no runs
   * are absent, and the chart joins the days that exist — which is the honest picture of a period
   * with weekends in it.
   */
  async agentRunsPerDay(input: {
    scope: TenantScope;
    reportScope: ReportScope;
    window: ReportWindow;
  }): Promise<ReportResult> {
    const columns = ['day', 'runs', 'succeeded', 'failed', 'scheduled', 'agents'];
    if (ReportsService.empty(input.reportScope)) return ReportsService.none(columns);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const runs = await this.prisma.client.agentRun.findMany({
        where: {
          tenantId: input.scope.tenantId,
          createdAt: { gte: input.window.from, lte: input.window.to },
          /*
           * Narrowed by the agent's owner, which is how every other agent report scopes.
           *
           * A run row names who *started* it, and scoping by that would hide a manager's own
           * agents the moment somebody else ran one — the opposite of what their scope means.
           */
          ...(ReportScopeService.userFilter(input.reportScope, 'ownerUserId').ownerUserId ===
          undefined
            ? {}
            : {
                agent: ReportScopeService.userFilter(input.reportScope, 'ownerUserId') as {
                  ownerUserId: { in: string[] };
                },
              }),
        },
        select: { createdAt: true, state: true, trigger: true, engineAgentId: true },
        take: 50_000,
      });

      const byDay = new Map<
        string,
        { runs: number; succeeded: number; failed: number; scheduled: number; agents: Set<string> }
      >();

      for (const run of runs) {
        const day = run.createdAt.toISOString().slice(0, 10);
        const bucket = byDay.get(day) ?? {
          runs: 0,
          succeeded: 0,
          failed: 0,
          scheduled: 0,
          agents: new Set<string>(),
        };
        bucket.runs += 1;
        if (run.state === 'Completed') bucket.succeeded += 1;
        if (run.state === 'Failed' || run.state === 'Cancelled') bucket.failed += 1;
        if (run.trigger === 'Scheduled') bucket.scheduled += 1;
        bucket.agents.add(run.engineAgentId);
        byDay.set(day, bucket);
      }

      const rows = [...byDay.entries()]
        .map(([day, bucket]) => ({
          day,
          runs: bucket.runs,
          succeeded: bucket.succeeded,
          failed: bucket.failed,
          scheduled: bucket.scheduled,
          // How many different agents were involved that day, which is what says whether the
          // volume is one agent working hard or the company's AI work spreading out.
          agents: bucket.agents.size,
        }))
        .sort((left, right) => left.day.localeCompare(right.day));

      const total = rows.reduce((sum, row) => sum + row.runs, 0);

      return {
        columns,
        rows,
        summary: {
          days: rows.length,
          totalRuns: total,
          // Over days that had runs, not over the calendar: an average that divided by a period
          // including weekends would understate a weekday operation by two sevenths.
          averagePerActiveDay: rows.length === 0 ? 0 : Math.round((total / rows.length) * 10) / 10,
          scheduledRuns: rows.reduce((sum, row) => sum + row.scheduled, 0),
          /*
           * Left out entirely when there were no runs, rather than reported as an empty string.
           *
           * A summary key whose value is "" renders as a labelled blank on the screen, which
           * reads as a figure that failed to load. An absent key renders as nothing at all, which
           * is what "no runs in this period" should look like.
           */
          ...(rows.length === 0
            ? {}
            : {
                busiestDay: rows.reduce((best, row) => (row.runs > best.runs ? row : best)).day,
              }),
        },
        truncated: runs.length >= 50_000,
      };
    });
  }

  async performanceAndBadges(input: {
    scope: TenantScope;
    reportScope: ReportScope;
    window: ReportWindow;
  }): Promise<ReportResult> {
    const columns = ['person', 'points', 'events', 'currentBadge', 'badgeChanges'];
    if (ReportsService.empty(input.reportScope)) return ReportsService.none(columns);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const events = await this.prisma.client.performanceEvent.findMany({
        where: {
          tenantId: input.scope.tenantId,
          occurredAt: { gte: input.window.from, lte: input.window.to },
          ...ReportScopeService.userFilter(input.reportScope, 'subjectUserId'),
        },
        select: { subjectUserId: true, points: true },
        take: 20_000,
      });

      const badges = await this.prisma.client.badgeHistory.findMany({
        where: {
          tenantId: input.scope.tenantId,
          ...ReportScopeService.userFilter(input.reportScope, 'subjectUserId'),
        },
        select: { subjectUserId: true, level: true, endedAt: true, startedAt: true },
      });

      const byUser = new Map<string, { points: number; events: number }>();
      for (const event of events) {
        const bucket = byUser.get(event.subjectUserId) ?? { points: 0, events: 0 };
        bucket.points += event.points;
        bucket.events += 1;
        byUser.set(event.subjectUserId, bucket);
      }

      // Anybody with a badge but no events in the window still belongs in the report — "nothing
      // happened this month" is an answer.
      for (const badge of badges) {
        if (!byUser.has(badge.subjectUserId)) {
          byUser.set(badge.subjectUserId, { points: 0, events: 0 });
        }
      }

      const names = await this.names([...byUser.keys()]);

      const rows = [...byUser.entries()]
        .map(([userId, bucket]) => {
          const mine = badges.filter((badge) => badge.subjectUserId === userId);
          const current = mine.find((badge) => badge.endedAt === null);
          return {
            person: names.get(userId) ?? '—',
            points: bucket.points,
            events: bucket.events,
            /*
             * The name the person sees on their own page, not the rung it is stored as.
             *
             * The ladder is stored `Bronze` … `Diamond` and shown `Starter` … `Legend` — the
             * client's vocabulary — and this report printed the stored value. So a manager read
             * "Bronze" in a report about somebody whose own screen, and whose badge email, both
             * say "Starter": the same person described two ways by one product. The stored value
             * is untouched, here as everywhere; only what is printed changes.
             */
            currentBadge: current === undefined ? '—' : BADGE_LEVEL_LABELS[current.level],
            badgeChanges: mine.length,
          };
        })
        .sort((left, right) => right.points - left.points)
        .slice(0, REPORT_ROW_LIMIT);

      return {
        columns,
        rows,
        summary: { people: rows.length, events: events.length },
        truncated: byUser.size > REPORT_ROW_LIMIT,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * An empty scope produces an empty report, checked explicitly.
   *
   * Prisma's `{ in: [] }` happens to match nothing, which is the right answer — but relying on a
   * library's treatment of an edge case for a security boundary is how a boundary disappears in a
   * version bump.
   */
  private static empty(scope: ReportScope): boolean {
    return scope.userIds !== null && scope.userIds.length === 0;
  }

  private static none(columns: string[]): ReportResult {
    return { columns, rows: [], summary: {}, truncated: false };
  }

  /**
   * Identifiers in, display names out.
   *
   * Three reports name a person in a column, and each of them used to print the raw id. That is
   * unreadable on screen, useless in an exported spreadsheet, and — now that the rows are also
   * charted — it would make every bar label forty hex characters wide.
   *
   * Called inside the tenant transaction the report already opened, so it reads under the same
   * row-level security as everything else. `User` is global and carries no tenant column, but
   * the ids handed to it came out of tenant-scoped rows, so nothing outside the company can be
   * named by asking.
   *
   * Somebody who has left leaves their id unresolved rather than absent, and the caller decides
   * what to print — an em dash, everywhere it does.
   */
  private async names(ids: string[]): Promise<Map<string, string>> {
    const distinct = [...new Set(ids)];
    if (distinct.length === 0) return new Map();

    const people = await this.prisma.client.user.findMany({
      where: { id: { in: distinct } },
      select: { id: true, displayName: true },
    });
    return new Map(people.map((person) => [person.id, person.displayName]));
  }
}
