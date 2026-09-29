import { Injectable, Logger } from '@nestjs/common';

import {
  dependenciesSatisfied,
  mayReleaseHumanTask,
  notificationDedupeKey,
  type HumanTaskStatus,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/** A task that has just stopped waiting, and enough about it to tell its owner. */
export interface ReleasedTask {
  id: string;
  title: string;
  assignedToUserId: string;
  objectiveId: string;
  objectiveCode: string;
  nodeId: string;
}

/**
 * The thing that makes a dependency mean something.
 *
 * ## The problem this exists for
 *
 * A published workflow records `dependsOnNodeIds` on every step, and until this existed nothing
 * ever read it back. Every task in a chain was created `Assigned`, so all three people in an
 * Engine -> Sub-Engine -> Executor sequence saw their work appear at the same moment and the order
 * the workflow described was a suggestion. The order is now enforced: a step whose dependencies
 * are unfinished is created `Waiting`, and only finishing what it waits on moves it.
 *
 * ## Why it recomputes the whole version
 *
 * The obvious implementation releases the steps that depend on the node that just finished. This
 * one re-examines every waiting step in the objective version instead, which costs one more query
 * and buys something worth more: any single completion repairs the whole graph. A release that
 * was missed — a completion path added later that forgets to call this, a run that finished while
 * the process was restarting — is corrected by the next completion rather than leaving a task
 * parked for ever with nothing left in the world that could release it.
 *
 * ## What counts as finished
 *
 * Deliberately not "a row exists". Three kinds of step produce three different kinds of evidence:
 *
 * - a **human** step is finished when its task is `Completed`;
 * - an **AI** step is finished when its assignment has an `AgentRun` in state `Completed` — not
 *   when the assignment was created and not when an agent was mapped to it, because neither of
 *   those produced any output for the next step to work from;
 * - an **approval gate** is finished when its request is `Approved`.
 *
 * `Cancelled` counts as finished in all three cases, and that is a decision rather than an
 * oversight: a cancelled step is never going to produce anything, so waiting on it is waiting for
 * ever. A `Rejected` approval is *not* finished — the work goes back for rework, and unlocking the
 * next step on the strength of a refusal is exactly the early unlock this class prevents.
 */
@Injectable()
export class WorkReleaseService {
  private readonly logger = new Logger(WorkReleaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly auditEvents: AuditEventService,
  ) {}

  /**
   * Release whatever the plan now permits.
   *
   * **Call this inside the caller's transaction**, having already written the completion that
   * prompted it. Sharing the transaction is the point: a step that is complete while its successor
   * is still `Waiting` is the state this exists to prevent, and two transactions would leave a
   * window where it is true. It reads the completion back from the database rather than being told
   * about it, so it cannot disagree with what was actually stored.
   *
   * Returns what it released so the caller can announce it **after** committing. Nothing here
   * raises a notification: a notification failure must never roll back somebody's finished work.
   */
  async releaseWithinTransaction(input: {
    tenantId: string;
    objectiveVersionId: string;
    /**
     * Who caused it, when anybody did.
     *
     * Absent for a release caused by an agent run finishing: nobody clicked anything, and naming
     * the person who once started the run as the actor would put a human's name on a decision the
     * scheduler made. The audit entry says what finished instead.
     */
    actorUserId?: string | undefined;
    /** What just finished. Recorded on the audit entry so a release can be traced to its cause. */
    finishedNodeId: string;
  }): Promise<ReleasedTask[]> {
    const tasks = await this.prisma.client.humanTask.findMany({
      where: { tenantId: input.tenantId, objectiveVersionId: input.objectiveVersionId },
      select: {
        id: true,
        nodeId: true,
        title: true,
        status: true,
        dependsOnNodeIds: true,
        assignedToUserId: true,
        objectiveId: true,
        objective: { select: { code: true } },
      },
    });

    const aiAssignments = await this.prisma.client.aiWorkAssignment.findMany({
      where: { tenantId: input.tenantId, objectiveVersionId: input.objectiveVersionId },
      select: { id: true, nodeId: true, status: true },
    });

    const approvals = await this.prisma.client.approvalRequest.findMany({
      where: {
        tenantId: input.tenantId,
        objectiveVersionId: input.objectiveVersionId,
        workflowNodeId: { not: null },
      },
      select: { workflowNodeId: true, status: true },
    });

    /*
     * Which AI steps have actually run.
     *
     * Asked of the runs rather than of the assignment, because the assignment's own statuses —
     * `AwaitingAgentSetup`, `MappedToEngineAgent` — describe how the step is *set up*, never
     * whether it has produced anything. Only `Completed` counts: a failed run leaves the next step
     * with nothing to work from, so it keeps waiting until somebody re-runs it.
     */
    const ranAssignmentIds =
      aiAssignments.length === 0
        ? []
        : await this.prisma.client.agentRun.findMany({
            where: {
              tenantId: input.tenantId,
              aiWorkAssignmentId: { in: aiAssignments.map((row) => row.id) },
              state: 'Completed',
            },
            select: { aiWorkAssignmentId: true },
            distinct: ['aiWorkAssignmentId'],
          });
    const completedAssignmentIds = new Set(
      ranAssignmentIds
        .map((row) => row.aiWorkAssignmentId)
        .filter((id): id is string => id !== null),
    );

    const planned = new Set<string>();
    const finished = new Set<string>();

    for (const task of tasks) {
      planned.add(task.nodeId);
      if (task.status === 'Completed' || task.status === 'Cancelled') finished.add(task.nodeId);
    }
    for (const assignment of aiAssignments) {
      planned.add(assignment.nodeId);
      if (assignment.status === 'Cancelled' || completedAssignmentIds.has(assignment.id)) {
        finished.add(assignment.nodeId);
      }
    }
    for (const approval of approvals) {
      const nodeId = approval.workflowNodeId;
      if (nodeId === null) continue;
      planned.add(nodeId);
      if (approval.status === 'Approved' || approval.status === 'Cancelled') finished.add(nodeId);
    }

    const released: ReleasedTask[] = [];

    for (const task of tasks) {
      if (!mayReleaseHumanTask(task.status as HumanTaskStatus)) continue;
      if (!dependenciesSatisfied(task.dependsOnNodeIds, finished, planned)) continue;

      await this.prisma.client.humanTask.update({
        where: { id: task.id },
        data: { status: 'Assigned', version: { increment: 1 } },
      });

      await this.auditEvents.appendWithinCurrentScope(input.tenantId, {
        action: 'todo.task_released',
        resourceType: 'human_task',
        resourceId: task.id,
        ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
        resourceRef: task.title,
        summary: `"${task.title}" is no longer waiting: every step it depends on has finished.`,
        metadata: {
          taskId: task.id,
          nodeId: task.nodeId,
          releasedBy: input.finishedNodeId,
          dependsOnNodeIds: task.dependsOnNodeIds.join(','),
        },
      });

      released.push({
        id: task.id,
        title: task.title,
        assignedToUserId: task.assignedToUserId,
        objectiveId: task.objectiveId,
        objectiveCode: task.objective.code,
        nodeId: task.nodeId,
      });
    }

    return released;
  }

  /**
   * Tell the people whose work just became startable.
   *
   * **Call this after the transaction has committed.** Raising a notification inside one would
   * take the notification service's writes hostage to a rollback, and — the reason that matters
   * more — a failure here would undo a completion somebody legitimately recorded. So this is best
   * effort and says so in the log when it fails: the release itself is already durable, and the
   * task is sitting in the person's list whether or not the bell rang.
   */
  async announce(scope: TenantScope, released: readonly ReleasedTask[]): Promise<void> {
    await this.tell(scope, released, (task) => ({
      title: `Ready to start: ${task.title}`,
      body:
        `Everything "${task.title}" was waiting on in ${task.objectiveCode} has finished, ` +
        'so it is now yours to start.',
    }));
  }

  /**
   * Tell the people whose work is startable the moment a plan is assigned.
   *
   * The client's rule is that **only the first eligible person** is told: the rest of the chain is
   * announced as it unlocks, which is what `announce` does. So the caller passes only the tasks
   * that were created startable, and the ones created `Waiting` are deliberately silent.
   *
   * It shares `announce`'s dedupe key on purpose. A task announced here was never `Waiting` and so
   * can never be released later, but keying both the same way means that if that ever stopped being
   * true, the person would be told once rather than twice.
   */
  async announceAssigned(scope: TenantScope, assigned: readonly ReleasedTask[]): Promise<void> {
    await this.tell(scope, assigned, (task) => ({
      title: `New work assigned: ${task.title}`,
      body: `${task.objectiveCode} was assigned and this step is yours to start now.`,
    }));
  }

  /** The shared raise. Best effort, and it says so in the log when it fails. */
  private async tell(
    scope: TenantScope,
    tasks: readonly ReleasedTask[],
    words: (task: ReleasedTask) => { title: string; body: string },
  ): Promise<void> {
    for (const task of tasks) {
      try {
        const { title, body } = words(task);
        await this.notifications.raise({
          tenantId: scope.tenantId,
          recipientUserId: task.assignedToUserId,
          kind: 'WorkReady',
          severity: 'Info',
          title,
          body,
          deepLink: `/todo/${task.id}`,
          resourceType: 'human_task',
          resourceId: task.id,
          isAssignedToRecipient: true,
          dedupeKey: notificationDedupeKey.workReady(task.id),
        });
      } catch (caught: unknown) {
        this.logger.error(
          `Task ${task.id} is startable but its notification could not be raised: ` +
            (caught instanceof Error ? caught.message : String(caught)),
        );
      }
    }
  }
}
