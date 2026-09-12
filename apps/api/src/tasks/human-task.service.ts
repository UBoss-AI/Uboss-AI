import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import {
  ALLOWED_HUMAN_TASK_TRANSITIONS,
  HUMAN_TASK_STATUS_LABELS,
  humanTaskDisplayStatus,
  isHumanTaskOverdue,
  mayMoveHumanTask,
  validateTaskSubmission,
  type HumanTaskStatus,
  type TaskNoteKind,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

export interface HumanTaskView {
  id: string;
  title: string;
  objectiveId: string;
  objectiveCode: string;
  objectiveName: string;
  objectiveVersionId: string;
  nodeId: string;
  assignedToUserId: string;
  assignedByUserId: string;
  inputDescription: string;
  dueAt: string | null;
  triggerDescription: string;
  expectedOutput: string;
  evidenceRequirement: string;
  dependsOnNodeIds: string[];
  approvalKind: string | null;
  status: HumanTaskStatus;
  /** What the list shows: `Overdue` when late, otherwise the stored status. */
  displayStatus: string;
  displayTone: string;
  overdue: boolean;
  startedAt: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  blockedReason: string | null;
  evidence: {
    id: string;
    description: string;
    reference: string;
    addedByUserId: string;
    addedAt: string;
  }[];
  notes: { id: string; kind: string; body: string; authorUserId: string; createdAt: string }[];
  /** Which moves this task can make now, so a screen does not offer one that will be refused. */
  nextStatuses: HumanTaskStatus[];
}

type TaskRow = Awaited<ReturnType<PrismaService['client']['humanTask']['findFirstOrThrow']>>;

/**
 * The Human To-do list.
 *
 * Everything a person needs to do the work is on the task row, put there by Approve & Assign. That
 * is deliberate: a task must still read correctly after the objective moves to a new version, and
 * a screen that joined live to the current plan would silently rewrite somebody's instructions
 * underneath them.
 *
 * ## Scope
 *
 * The `todo` module, not `objective`. An Employee has `todo: View, Comment, EditDraft` at
 * `OwnWork` scope, which is exactly right: they work their own tasks and cannot touch anybody
 * else's. A Manager's `TeamSubtree` scope lets them see their team's. The resource check does the
 * work — this service never filters by "is it mine?" in application code, because that is the
 * check that gets forgotten on the one endpoint nobody thought about.
 */
@Injectable()
export class HumanTaskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
  ) {}

  /** The To-do list. `mine` is the default because that is what the screen opens on. */
  async list(input: {
    scope: TenantScope;
    actorUserId: string;
    filter?: 'mine' | 'team' | 'blocked' | undefined;
    status?: HumanTaskStatus | undefined;
    search?: string | undefined;
  }): Promise<{ tasks: HumanTaskView[]; counts: Record<string, number>; note: string }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'todo', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const filter = input.filter ?? 'mine';

      const rows = await this.prisma.client.humanTask.findMany({
        where: {
          ...(filter === 'mine' ? { assignedToUserId: input.actorUserId } : {}),
          ...(filter === 'blocked' ? { status: 'Blocked' } : {}),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.search === undefined || input.search.trim() === ''
            ? {}
            : { title: { contains: input.search.trim(), mode: 'insensitive' as const } }),
        },
        orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
        include: { evidence: true, notes: true, objective: true, objectiveVersion: true },
      });

      // The `team` filter is row-level authorization, not a query predicate: whether a task is
      // "mine to see" is the same question the resource check answers, and asking it twice in two
      // ways is how the two answers drift apart.
      const visible: typeof rows = [];
      for (const row of rows) {
        const allowed = await this.authorization.authorize(context, {
          module: 'todo',
          action: 'View',
          resource: {
            id: row.id,
            ownerUserId: row.assignedToUserId,
            departmentId: row.objective.departmentId,
          },
        });
        if (allowed.allowed) visible.push(row);
      }

      const counts = {
        total: visible.length,
        overdue: visible.filter((row) =>
          isHumanTaskOverdue({ status: row.status as HumanTaskStatus, dueAt: row.dueAt }),
        ).length,
        blocked: visible.filter((row) => row.status === 'Blocked').length,
        mine: visible.filter((row) => row.assignedToUserId === input.actorUserId).length,
      };

      return {
        tasks: visible.map((row) => this.viewOf(row)),
        counts,
        note: 'Work assigned from published workflows. Nothing here was created by hand.',
      };
    });
  }

  async view(input: {
    scope: TenantScope;
    actorUserId: string;
    taskId: string;
  }): Promise<HumanTaskView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'todo', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.load(input.taskId);
      await this.assertOnTask(context, row, 'View');
      return this.viewOf(row);
    });
  }

  /** The client's **Start**. */
  async start(input: {
    scope: TenantScope;
    actorUserId: string;
    taskId: string;
  }): Promise<HumanTaskView> {
    return this.mutate(input, (row) => {
      this.assertMove(row.status as HumanTaskStatus, 'InProgress');
      return {
        data: {
          status: 'InProgress',
          ...(row.startedAt === null ? { startedAt: new Date() } : {}),
          // Resuming clears the blocker: a task cannot be in progress and blocked at once, and
          // leaving a stale reason on it would misreport why work stopped.
          blockedReason: null,
        },
        action: 'todo.task_started',
        summary: `Started "${row.title}".`,
      };
    });
  }

  /** The client's **Blocked reason**. */
  async block(input: {
    scope: TenantScope;
    actorUserId: string;
    taskId: string;
    reason: string;
  }): Promise<HumanTaskView> {
    if (input.reason.trim() === '') {
      throw new BadRequestException(
        'A blocked task has to say why. Without a reason nobody can unblock it.',
      );
    }

    return this.mutate(input, (row) => {
      this.assertMove(row.status as HumanTaskStatus, 'Blocked');
      return {
        data: { status: 'Blocked', blockedReason: input.reason.trim() },
        action: 'todo.task_blocked',
        summary: `Blocked "${row.title}": ${input.reason.trim()}`,
      };
    });
  }

  /** The client's **Add Evidence**. */
  async addEvidence(input: {
    scope: TenantScope;
    actorUserId: string;
    taskId: string;
    description: string;
    reference?: string | undefined;
  }): Promise<HumanTaskView> {
    if (input.description.trim() === '') {
      throw new BadRequestException(
        'Evidence needs a description. A row that proves nothing would still satisfy the ' +
          'submission gate, which is worse than no row at all.',
      );
    }

    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'todo', action: 'EditDraft' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.load(input.taskId);
      await this.assertOnTask(context, row, 'EditDraft');

      await this.prisma.client.humanTaskEvidence.create({
        data: {
          tenantId: input.scope.tenantId,
          taskId: row.id,
          description: input.description.trim(),
          reference: input.reference?.trim() ?? '',
          addedByUserId: input.actorUserId,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'todo.evidence_added',
        resourceType: 'human_task',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        resourceRef: row.title,
        summary: `Attached evidence to "${row.title}".`,
        metadata: { taskId: row.id, reference: input.reference?.trim() ?? '' },
      });

      return this.viewOf(await this.load(input.taskId));
    });
  }

  /**
   * The client's **Comment/Clarify**.
   *
   * A clarification is a question somebody is waiting on an answer to, so it moves the task to
   * `NeedsInput` — that is what makes it visible as stalled rather than merely quiet.
   */
  async addNote(input: {
    scope: TenantScope;
    actorUserId: string;
    taskId: string;
    kind: TaskNoteKind;
    body: string;
  }): Promise<HumanTaskView> {
    if (input.body.trim() === '') {
      throw new BadRequestException('A comment needs something in it.');
    }

    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'todo', action: 'Comment' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.load(input.taskId);
      await this.assertOnTask(context, row, 'Comment');

      await this.prisma.client.humanTaskNote.create({
        data: {
          tenantId: input.scope.tenantId,
          taskId: row.id,
          kind: input.kind,
          body: input.body.trim(),
          authorUserId: input.actorUserId,
        },
      });

      if (
        input.kind === 'Clarification' &&
        mayMoveHumanTask(row.status as HumanTaskStatus, 'NeedsInput')
      ) {
        await this.prisma.client.humanTask.update({
          where: { id: row.id },
          data: { status: 'NeedsInput', version: { increment: 1 } },
        });
      }

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: input.kind === 'Clarification' ? 'todo.clarification_asked' : 'todo.task_commented',
        resourceType: 'human_task',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        resourceRef: row.title,
        summary:
          input.kind === 'Clarification'
            ? `Asked for clarification on "${row.title}".`
            : `Commented on "${row.title}".`,
        metadata: { taskId: row.id, kind: input.kind },
      });

      return this.viewOf(await this.load(input.taskId));
    });
  }

  /**
   * The client's **Submit/Complete**, which is one button and two outcomes.
   *
   * A step whose Definition of Done requires an approval cannot complete itself — it goes to
   * `WaitingApproval` and an approval request is raised in the same queue every other approval
   * uses. A step requiring none completes outright: making somebody click twice for a decision
   * nobody has to make is friction that teaches people to ignore the button.
   */
  async submit(input: {
    scope: TenantScope;
    actorUserId: string;
    taskId: string;
  }): Promise<HumanTaskView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'todo', action: 'EditDraft' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.load(input.taskId);
      await this.assertOnTask(context, row, 'EditDraft');

      const problems = validateTaskSubmission({
        status: row.status as HumanTaskStatus,
        evidenceRequirement: row.evidenceRequirement,
        evidenceCount: row.evidence.length,
        blockedReason: row.blockedReason,
      });
      if (problems.length > 0) {
        throw new BadRequestException(problems.join(' '));
      }

      const needsApproval = row.approvalKind !== null && row.approvalKind !== 'NotRequired';
      const now = new Date();

      await this.prisma.client.humanTask.update({
        where: { id: row.id },
        data: {
          status: needsApproval ? 'WaitingApproval' : 'Completed',
          submittedAt: now,
          ...(row.startedAt === null ? { startedAt: now } : {}),
          ...(needsApproval ? {} : { completedAt: now }),
          version: { increment: 1 },
        },
      });

      if (needsApproval) {
        // The same approvals table every other domain uses. One queue, not one per module.
        await this.prisma.client.approvalRequest.create({
          data: {
            tenantId: input.scope.tenantId,
            type: 'OutputApproval',
            status: 'Pending',
            title: `Output approval: ${row.title}`,
            detail:
              `${row.objective.code}: "${row.title}" was submitted and needs a ` +
              `${row.approvalKind} decision. Expected output: ${row.expectedOutput}`,
            subjectType: 'HumanTask',
            subjectId: row.id,
            objectiveId: row.objectiveId,
            objectiveVersionId: row.objectiveVersionId,
            requestedByUserId: input.actorUserId,
            approverRoleKind: row.approvalKind,
          },
        });
      }

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: needsApproval ? 'todo.task_submitted' : 'todo.task_completed',
        resourceType: 'human_task',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        resourceRef: row.title,
        summary: needsApproval
          ? `Submitted "${row.title}" for ${row.approvalKind} approval.`
          : `Completed "${row.title}".`,
        metadata: {
          taskId: row.id,
          evidenceCount: row.evidence.length,
          approvalKind: row.approvalKind,
          lateAgainstDueDate: isHumanTaskOverdue({
            status: row.status as HumanTaskStatus,
            dueAt: row.dueAt,
          }),
        },
      });

      return this.viewOf(await this.load(input.taskId));
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async mutate(
    input: { scope: TenantScope; actorUserId: string; taskId: string },
    change: (row: TaskRowWithChildren) => {
      data: Record<string, unknown>;
      action: string;
      summary: string;
    },
  ): Promise<HumanTaskView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'todo', action: 'EditDraft' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.load(input.taskId);
      await this.assertOnTask(context, row, 'EditDraft');

      const outcome = change(row);
      await this.prisma.client.humanTask.update({
        where: { id: row.id },
        data: { ...outcome.data, version: { increment: 1 } },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: outcome.action,
        resourceType: 'human_task',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        resourceRef: row.title,
        summary: outcome.summary,
        metadata: {
          taskId: row.id,
          from: row.status,
          to: (outcome.data['status'] as string | undefined) ?? row.status,
        },
      });

      return this.viewOf(await this.load(input.taskId));
    });
  }

  private assertMove(from: HumanTaskStatus, to: HumanTaskStatus): void {
    if (mayMoveHumanTask(from, to)) return;

    const permitted = ALLOWED_HUMAN_TASK_TRANSITIONS[from];
    throw new BadRequestException(
      `A task that is ${HUMAN_TASK_STATUS_LABELS[from]} cannot become ` +
        `${HUMAN_TASK_STATUS_LABELS[to]}. ` +
        (permitted.length === 0
          ? 'It has finished; a task that turns out to be wrong is re-assigned, not re-opened.'
          : `Permitted from here: ${permitted.map((status) => HUMAN_TASK_STATUS_LABELS[status]).join(', ')}.`),
    );
  }

  /** Always inside a tenant transaction: an unscoped read under RLS returns nothing. */
  private async load(taskId: string): Promise<TaskRowWithChildren> {
    const row = await this.prisma.client.humanTask.findFirst({
      where: { id: taskId },
      include: {
        evidence: { orderBy: { addedAt: 'asc' } },
        notes: { orderBy: { createdAt: 'asc' } },
        objective: true,
        objectiveVersion: true,
      },
    });
    if (row === null) {
      throw new NotFoundException('There is no such task you can see.');
    }
    return row;
  }

  private async assertOnTask(
    context: Awaited<ReturnType<AuthorizationService['contextFor']>>,
    row: TaskRowWithChildren,
    action: 'View' | 'Comment' | 'EditDraft',
  ): Promise<void> {
    await this.authorization.assertCan(context, {
      module: 'todo',
      action,
      resource: {
        id: row.id,
        // The assignee is the owner. That is what makes `OwnWork` scope mean "my tasks".
        ownerUserId: row.assignedToUserId,
        departmentId: row.objective.departmentId,
      },
    });
  }

  private viewOf(row: TaskRowWithChildren): HumanTaskView {
    const status = row.status as HumanTaskStatus;
    const display = humanTaskDisplayStatus({ status, dueAt: row.dueAt });

    return {
      id: row.id,
      title: row.title,
      objectiveId: row.objectiveId,
      objectiveCode: row.objective.code,
      objectiveName: row.objectiveVersion.objectiveName,
      objectiveVersionId: row.objectiveVersionId,
      nodeId: row.nodeId,
      assignedToUserId: row.assignedToUserId,
      assignedByUserId: row.assignedByUserId,
      inputDescription: row.inputDescription,
      dueAt: row.dueAt?.toISOString() ?? null,
      triggerDescription: row.triggerDescription,
      expectedOutput: row.expectedOutput,
      evidenceRequirement: row.evidenceRequirement,
      dependsOnNodeIds: row.dependsOnNodeIds,
      approvalKind: row.approvalKind,
      status,
      displayStatus: display.status,
      displayTone: display.tone,
      overdue: isHumanTaskOverdue({ status, dueAt: row.dueAt }),
      startedAt: row.startedAt?.toISOString() ?? null,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      blockedReason: row.blockedReason,
      evidence: row.evidence.map((entry) => ({
        id: entry.id,
        description: entry.description,
        reference: entry.reference,
        addedByUserId: entry.addedByUserId,
        addedAt: entry.addedAt.toISOString(),
      })),
      notes: row.notes.map((note) => ({
        id: note.id,
        kind: note.kind,
        body: note.body,
        authorUserId: note.authorUserId,
        createdAt: note.createdAt.toISOString(),
      })),
      nextStatuses: [...ALLOWED_HUMAN_TASK_TRANSITIONS[status]],
    };
  }
}

type TaskRowWithChildren = TaskRow & {
  evidence: {
    id: string;
    description: string;
    reference: string;
    addedByUserId: string;
    addedAt: Date;
  }[];
  notes: { id: string; kind: string; body: string; authorUserId: string; createdAt: Date }[];
  objective: { code: string; departmentId: string };
  objectiveVersion: { objectiveName: string };
};
