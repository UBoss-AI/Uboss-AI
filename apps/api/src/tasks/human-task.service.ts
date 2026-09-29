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
import { WorkReleaseService, type ReleasedTask } from './work-release.service.js';

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
  /**
   * The readable titles of the steps this task is still waiting on.
   *
   * Empty for anything that is not `Waiting` — once it has been released there is nothing left to
   * wait for. Titles rather than the node ids already on `dependsOnNodeIds`, because "waiting on
   * step-1" tells a person nothing, and a queue that will not say what it is waiting for is the
   * black box the Operations screen exists to replace.
   */
  waitingOn: string[];
  /**
   * The readable titles of every step this one comes after, finished or not.
   *
   * Separate from `waitingOn` because the two answer different questions. "What am I waiting for?"
   * is empty once the work is yours; "what happened before this?" is context somebody reads while
   * doing it, and it stays true for the whole life of the task.
   *
   * Both are populated on the list and detail reads, which are the ones a screen shows somebody.
   */
  dependsOnLabels: string[];
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
    private readonly workRelease: WorkReleaseService,
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
        // Separate from blocked on purpose: one is a person stuck, the other is the plan's order.
        waiting: visible.filter((row) => row.status === 'Waiting').length,
        mine: visible.filter((row) => row.assignedToUserId === input.actorUserId).length,
      };

      return {
        tasks: await this.describeDependencies(
          input.scope.tenantId,
          visible.map((row) => this.viewOf(row)),
        ),
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
      const [view] = await this.describeDependencies(input.scope.tenantId, [this.viewOf(row)]);
      return view as HumanTaskView;
    });
  }

  /**
   * The client's **Start** — and, from `WaitingApproval`, its **Resume**.
   *
   * ## Reopening withdraws the approval the submission raised
   *
   * The lifecycle lets a person pull work back out of `WaitingApproval` ("submitted too early"),
   * and the approval that submission raised used to stay `Pending` in the approver's queue with
   * nothing on it to say the work had been withdrawn. Proven against the running product: an
   * approver signed off a submission that no longer stood, three minutes after it was pulled
   * back, and the queue showed two identical requests for one piece of work once it was
   * resubmitted. Each reopen added another approval the task could never finish without.
   *
   * So a reopen withdraws them. `Cancelled`, not deleted — the request, its reason and who caused
   * it stay readable, which is the whole point of an approval trail. A request that has already
   * been decided is never touched: the `status: 'Pending'` in the write's own `where` is what
   * guarantees it, including against a decision that lands between the read and the write.
   */
  async start(input: {
    scope: TenantScope;
    actorUserId: string;
    taskId: string;
  }): Promise<HumanTaskView> {
    return this.mutate(
      input,
      (row) => {
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
      },
      async (row) => {
        // Only a reopen withdraws anything. Starting a task that was merely Assigned or Blocked
        // has no submission behind it and nothing to withdraw.
        if (row.status !== 'WaitingApproval') return;
        await this.withdrawPendingApprovals({
          tenantId: input.scope.tenantId,
          task: row,
          actorUserId: input.actorUserId,
        });
      },
    );
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

    /*
     * Collected inside the transaction, announced after it.
     *
     * The successors are moved in the same transaction as the completion, because a step that is
     * finished while its successor still says Waiting is precisely the inconsistency the whole
     * mechanism exists to prevent. Telling the people is a separate concern and a fallible one —
     * see `announce` — so it happens once the work is safely stored.
     */
    let released: ReleasedTask[] = [];

    const view = await this.prisma.runInTenantTransaction(input.scope, async () => {
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
            /*
             * Stamped with the submission's own instant rather than left to the database default.
             *
             * `reconcileApprovalOutcome` decides which requests belong to the *current*
             * submission by comparing this against the task's `submittedAt`, and both are set to
             * the same `now` here. Letting the default `now()` stand would compare an application
             * clock against a database clock, and a few milliseconds of skew either way would
             * silently drop a request out of its own submission.
             */
            createdAt: now,
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

      /*
       * Only an outright completion releases anything.
       *
       * A submission that still needs an approval has not finished the step — the next person's
       * work becomes startable when the approver says so, which is the other call site below.
       */
      if (!needsApproval) {
        released = await this.workRelease.releaseWithinTransaction({
          tenantId: input.scope.tenantId,
          objectiveVersionId: row.objectiveVersionId,
          actorUserId: input.actorUserId,
          finishedNodeId: row.nodeId,
        });
      }

      return this.viewOf(await this.load(input.taskId));
    });

    await this.workRelease.announce(input.scope, released);
    return view;
  }

  /**
   * Close the loop between an approval decision and the task waiting on it.
   *
   * `submit` parks a task at `WaitingApproval` and raises an `OutputApproval` carrying
   * `subjectType: 'HumanTask'` and this task's id. Nothing used to read that back, so an approved
   * task stayed `WaitingApproval` for ever and the work could never finish (ADR-294).
   *
   * ## Why this asks about every request, not the one that was just decided
   *
   * A task may be governed by more than one approval, and "one row turned Approved" is not the
   * same statement as "the approval requirement is satisfied". This reads *all* requests against
   * this task and only finishes it when none is still `Pending` and every settled one is
   * `Approved`. One outstanding approver, and the task stays where it is.
   *
   * The separation-of-duties rules are not re-implemented here and must not be: a request cannot
   * reach `Approved` at all unless `ApprovalService.decide` got past `assertCan` with the
   * `NoSelfApproval` control and any `FourEyes` policy already applied. A four-eyes gate whose
   * first decision was refused leaves the row `Pending`, so this sees an unsatisfied requirement
   * and does nothing — which is the behaviour, arrived at by not duplicating the rule.
   *
   * ## Idempotent, and safe to run again
   *
   * The first thing it does is check the task is still `WaitingApproval`. A second call — a retry,
   * a redelivered decision, a reconciliation sweep — finds `Completed` and changes nothing, so the
   * audit event is written once and the completion timestamp is never moved.
   *
   * ## Transaction and scope
   *
   * No transaction is opened here. `runInTenantTransaction` is re-entrant for the same tenant, so
   * called from inside `decide`'s write transaction this joins it: the decision and the task's
   * state commit together or not at all. It also refuses to nest under a *different* tenant, which
   * is what makes a cross-tenant reconciliation impossible rather than merely unlikely.
   *
   * ## What it deliberately does not do
   *
   * Nothing for `Rejected` or `SentBack`. The product defines no task transition for either, and
   * inventing one during an integration is how a lifecycle acquires semantics nobody approved —
   * see ADR-295. Those decisions are recorded on the approval and the task is left alone.
   */
  async reconcileApprovalOutcome(input: {
    scope: TenantScope;
    taskId: string;
    /** Whoever's decision prompted this. Recorded as the actor on the completion event. */
    actorUserId: string;
  }): Promise<{ changed: boolean; status: HumanTaskStatus; released: ReleasedTask[] }> {
    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.prisma.client.humanTask.findFirst({
        where: { id: input.taskId },
        select: {
          id: true,
          title: true,
          status: true,
          startedAt: true,
          submittedAt: true,
          // Read so a completion can release whatever the plan had waiting behind this step.
          nodeId: true,
          objectiveVersionId: true,
        },
      });

      // Not ours to see, or already past the gate. Either way there is nothing to do.
      if (row === null || row.status !== 'WaitingApproval') {
        return {
          changed: false,
          status: (row?.status ?? 'Cancelled') as HumanTaskStatus,
          released: [],
        };
      }

      /*
       * Only the current submission's approvals govern the task.
       *
       * A reopen withdraws the pending ones (see `withdrawPendingApprovals`), but a request that
       * was already *settled* before the reopen cannot be touched — its decision record is
       * immutable. A rejection from a submission that was withdrawn two revisions ago would
       * otherwise block the task for ever, because this requires every governing request to be
       * `Approved`. So the set is narrowed to the requests raised for the submission now on the
       * table: `submit` stamps both the task's `submittedAt` and the request's `createdAt` with
       * the same instant, which is what makes this comparison exact rather than a race.
       */
      const all = await this.prisma.client.approvalRequest.findMany({
        where: {
          tenantId: input.scope.tenantId,
          subjectType: 'HumanTask',
          subjectId: input.taskId,
          // A withdrawn request governs nothing, whenever it was raised.
          status: { not: 'Cancelled' },
        },
        select: { id: true, status: true, createdAt: true },
      });

      const submittedAt = row.submittedAt;
      const thisSubmission =
        submittedAt === null
          ? []
          : all.filter((request) => request.createdAt.getTime() >= submittedAt.getTime());

      /*
       * The fallback is deliberate and narrow: rows written before this stamping existed carry a
       * database `createdAt` a hair either side of the task's `submittedAt`, and excluding them
       * would leave those tasks unable to finish. It applies only when *nothing* belongs to the
       * current submission, so it can never widen a set that was correctly narrowed.
       */
      const governing = thisSubmission.length > 0 ? thisSubmission : all;

      // A task parked at WaitingApproval with no approval governing it is a data problem, not a
      // task to finish. Left alone rather than completed on the strength of an absence.
      if (governing.length === 0) {
        return { changed: false, status: row.status as HumanTaskStatus, released: [] };
      }

      const outstanding = governing.filter((request) => request.status === 'Pending');
      const approved = governing.filter((request) => request.status === 'Approved');
      if (outstanding.length > 0 || approved.length !== governing.length) {
        return { changed: false, status: row.status as HumanTaskStatus, released: [] };
      }

      // The declared route, walked rather than jumped: WaitingApproval -> Submitted -> Completed.
      // Both legs are checked against ALLOWED_HUMAN_TASK_TRANSITIONS, so this cannot become a
      // private shortcut if the lifecycle changes underneath it.
      this.assertMove('WaitingApproval', 'Submitted');
      this.assertMove('Submitted', 'Completed');

      const now = new Date();
      await this.prisma.client.humanTask.update({
        where: { id: row.id },
        data: {
          status: 'Completed',
          completedAt: now,
          // Preserved, not rewritten: the submission and its evidence are the record of the work.
          ...(row.submittedAt === null ? { submittedAt: now } : {}),
          ...(row.startedAt === null ? { startedAt: now } : {}),
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'todo.task_completed',
        resourceType: 'human_task',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        resourceRef: row.title,
        summary: `Completed "${row.title}": every approval it was waiting on is approved.`,
        metadata: {
          taskId: row.id,
          completedBy: 'approval',
          approvalRequestIds: governing.map((request) => request.id).join(','),
          approvalsRequired: governing.length,
        },
      });

      /*
       * The step is finished, so whatever waited on it can start.
       *
       * Returned rather than announced, because this runs inside `decide`'s transaction and the
       * bell must not ring for something a rollback is about to undo. The caller announces once
       * the decision is committed.
       */
      const released = await this.workRelease.releaseWithinTransaction({
        tenantId: input.scope.tenantId,
        objectiveVersionId: row.objectiveVersionId,
        actorUserId: input.actorUserId,
        finishedNodeId: row.nodeId,
      });

      return { changed: true, status: 'Completed' as HumanTaskStatus, released };
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
    /**
     * Work that must commit with the transition, given the row **as it was before** it.
     *
     * Only `start` uses it, and only to withdraw the approvals a reopened submission left behind.
     * It runs inside the same transaction as the status change on purpose: a task that is back in
     * progress while its old approval is still decidable is exactly the state this exists to
     * prevent, and two transactions would leave a window where it is true.
     */
    alsoInTransaction?: (row: TaskRowWithChildren) => Promise<void>,
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

      if (alsoInTransaction !== undefined) {
        await alsoInTransaction(row);
      }

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

  /**
   * Withdraw every approval still waiting on a submission that has been pulled back.
   *
   * ## Why this is written here rather than in `ApprovalService`
   *
   * `ApprovalService` depends on this service — `decide` calls `reconcileApprovalOutcome` to
   * finish the task a decision unblocks — so a dependency the other way would be a cycle. The
   * to-do side already owns the creation of an `OutputApproval` in `submit`, and withdrawing one
   * is the same seam: both belong to the submission lifecycle rather than to the approval queue.
   *
   * ## Why a cancellation names an actor
   *
   * `a_settled_approval_names_who_decided_it` requires every non-`Pending` row to carry
   * `decidedByUserId` and `decidedAt`. That is the right constraint — an approval that changed
   * state with nobody attached is unauditable — so a withdrawal is attributed to the person who
   * pulled the work back, which is who caused it. The note and the audit event both say it was
   * withdrawn rather than decided, so nothing reads this as an approval or a rejection. No
   * decision record is appended, because a withdrawal is not one of the four decisions.
   *
   * Nothing here re-implements separation of duties, and nothing needs to: withdrawing is not
   * deciding, so `NoSelfApproval` and `FourEyes` are untouched. The person who reopens their own
   * work withdraws their own request, which is the same act as not having submitted it.
   */
  private async withdrawPendingApprovals(input: {
    tenantId: string;
    task: { id: string; title: string };
    actorUserId: string;
  }): Promise<void> {
    const pending = await this.prisma.client.approvalRequest.findMany({
      where: {
        tenantId: input.tenantId,
        subjectType: 'HumanTask',
        subjectId: input.task.id,
        status: 'Pending',
      },
      select: { id: true, title: true, approverRoleKind: true, namedApproverUserId: true },
    });

    if (pending.length === 0) return;

    const now = new Date();
    const withdrawn = await this.prisma.client.approvalRequest.updateMany({
      where: {
        id: { in: pending.map((request) => request.id) },
        // Re-checked in the write, not only in the read above. A decision landing in between
        // must win: a settled approval record is never modified.
        status: 'Pending',
      },
      data: {
        status: 'Cancelled',
        decidedByUserId: input.actorUserId,
        decidedAt: now,
        decisionNote:
          'Withdrawn, not decided: the work was pulled back to In progress, so the submission ' +
          'this was raised for no longer stands. Submitting the revised work raises a fresh ' +
          'request.',
        version: { increment: 1 },
      },
    });

    await this.auditEvents.appendWithinCurrentScope(input.tenantId, {
      action: 'todo.approvals_withdrawn',
      resourceType: 'human_task',
      resourceId: input.task.id,
      actorUserId: input.actorUserId,
      resourceRef: input.task.title,
      summary:
        `Withdrew ${withdrawn.count} approval request(s) waiting on "${input.task.title}": ` +
        'the work was reopened, so the submission they were raised for no longer stands.',
      metadata: {
        taskId: input.task.id,
        withdrawnCount: withdrawn.count,
        // Named, so the trail answers "which request vanished from my queue, and why".
        approvalRequestIds: pending.map((request) => request.id).join(','),
      },
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
      // Both filled by `describeDependencies` on the paths that show them to somebody.
      waitingOn: [],
      dependsOnLabels: [],
    };
  }

  /**
   * Put names to the steps each task depends on.
   *
   * Three queries at most, and none at all when nothing depends on anything. It reads the same
   * three tables `WorkReleaseService` does and applies the same rule for what counts as finished,
   * so the screen cannot claim a task is waiting on something the server would already have
   * released it from.
   *
   * A dependency whose node produced no work item is not listed: there is nothing to name, and it
   * is not something the task is really waiting for.
   */
  private async describeDependencies(
    tenantId: string,
    views: HumanTaskView[],
  ): Promise<HumanTaskView[]> {
    const dependent = views.filter((view) => view.dependsOnNodeIds.length > 0);
    if (dependent.length === 0) return views;

    const versionIds = [...new Set(dependent.map((view) => view.objectiveVersionId))];

    const [tasks, assignments, approvals] = [
      await this.prisma.client.humanTask.findMany({
        where: { tenantId, objectiveVersionId: { in: versionIds } },
        select: { nodeId: true, title: true, status: true },
      }),
      await this.prisma.client.aiWorkAssignment.findMany({
        where: { tenantId, objectiveVersionId: { in: versionIds } },
        select: { nodeId: true, title: true, status: true },
      }),
      await this.prisma.client.approvalRequest.findMany({
        where: {
          tenantId,
          objectiveVersionId: { in: versionIds },
          workflowNodeId: { not: null },
        },
        select: { workflowNodeId: true, title: true, status: true },
      }),
    ];

    /** Every step that produced work, by node. What a dependency can be given a name from. */
    const named = new Map<string, string>();
    /** The subset that has not finished. What a `Waiting` task is actually held up by. */
    const unfinished = new Map<string, string>();

    for (const row of tasks) {
      named.set(row.nodeId, row.title);
      if (row.status !== 'Completed' && row.status !== 'Cancelled') {
        unfinished.set(row.nodeId, row.title);
      }
    }
    for (const row of assignments) {
      named.set(row.nodeId, row.title);
      // An assignment that has not run is unfinished. Whether it *has* run is a question about
      // runs, and this is a label rather than a gate — the gate is in WorkReleaseService.
      if (row.status !== 'Cancelled') unfinished.set(row.nodeId, row.title);
    }
    for (const row of approvals) {
      if (row.workflowNodeId === null) continue;
      named.set(row.workflowNodeId, row.title);
      if (row.status !== 'Approved' && row.status !== 'Cancelled') {
        unfinished.set(row.workflowNodeId, row.title);
      }
    }

    const titles = (nodeIds: string[], from: Map<string, string>): string[] =>
      nodeIds
        .map((nodeId) => from.get(nodeId))
        .filter((title): title is string => title !== undefined);

    for (const view of dependent) {
      view.dependsOnLabels = titles(view.dependsOnNodeIds, named);
      view.waitingOn = view.status === 'Waiting' ? titles(view.dependsOnNodeIds, unfinished) : [];
    }

    return views;
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
